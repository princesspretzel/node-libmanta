/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

//
// This API contains all logic for CRUD on object metadata, which is
// stored in Moray.
//

var EventEmitter = require('events').EventEmitter;
var fs = require('fs');
var jsprim = require('jsprim');
var path = require('path');
var util = require('util');

var assert = require('assert-plus');
var backoff = require('backoff');
var moray = require('moray');
var once = require('once');
var vasync = require('vasync');
var VError = require('verror');

var utils = require('./utils');



///--- Globals

var sprintf = util.format;

var BUCKET = process.env.MANTA_RING_BUCKET || 'manta';
/*
 * NOTE: Care must be taken when deploying a incremented version of the manta
 * bucket for large databases. Currently `no_reindex = true` is being
 * passed into createBucket below. If new columns are added to the manta
 * bucket, this reindex option should be removed or at least revisited.
 * Do not change BUCKET_VERSION without discussing a deployment strategy.
 */
var BUCKET_VERSION = 2;

/* JSSTYLED */
var ROOT_RE = /^\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/stor$/;
var SCHEMA = {
    dirname: {
        type: 'string'
    },
    name: {
        type: 'string'
    },
    owner: {
        type: 'string'
    },
    objectId: {
        type: 'string'
    },
    type: {
        type: 'string'
    }
};
var POST = [
    recordDeleteLog
];


var DELETE_LOG_BUCKET = process.env.MANTA_DELETE_LOG_BUCKET ||
    'manta_delete_log';
var DELETE_LOG_SCHEMA = {
    objectId: {
        type: 'string'
    }
};
var DELETE_LOG_VERSION = 1;

var FASTDELETE_QUEUE_BUCKET = process.env.MANTA_FASTDELETE_QUEUE_BUCKET ||
    'manta_fastdelete_queue';
var FASTDELETE_QUEUE_VERSION = 1;

var DIR_COUNT_BUCKET = 'manta_directory_counts';
var DIR_COUNT_SCHEMA = {
    entries: {
        type: 'number'
    }
};
var DIR_COUNT_VERSION = 1;


var MANTA_UPLOADS_BUCKET = process.env.MANTA_UPLOADS_BUCKET ||
    'manta_uploads';
var MANTA_UPLOADS_SCHEMA = {
    finalizingType: {
        type: 'string'
    },
    uploadId: {
        type: 'string'
    }
};
var MANTA_UPLOADS_VERSION = 1;


///--- Internal Functions

/*
 * Create the Moray buckets used by Manta.
 */
function setupMantaBuckets(log, client, cb) {
    return (vasync.forEachParallel({
        func: createBucket,
        inputs: [ {
            client: client,
            bucket: BUCKET,
            opts: {
                index: SCHEMA,
                post: POST,
                options: {
                    version: BUCKET_VERSION
                }
            },
            reqopts: {
                no_reindex: true // See comment above BUCKET_VERSION definition
            },
            log: log
        }, {
            client: client,
            bucket: MANTA_UPLOADS_BUCKET,
            opts: {
                index: MANTA_UPLOADS_SCHEMA,
                options: {
                    version: MANTA_UPLOADS_VERSION
                }
            },
            reqopts: {},
            log: log
        }, {
            client: client,
            bucket: DELETE_LOG_BUCKET,
            opts: {
                index: DELETE_LOG_SCHEMA,
                options: {
                    version: DELETE_LOG_VERSION
                }
            },
            reqopts: {},
            log: log
        }, {
            client: client,
            bucket: FASTDELETE_QUEUE_BUCKET,
            opts: {
                options: {
                    version: FASTDELETE_QUEUE_VERSION
                }
            },
            reqopts: {},
            log: log
        }, {
            client: client,
            bucket: DIR_COUNT_BUCKET,
            opts: {
                index: DIR_COUNT_SCHEMA,
                options: {
                    version: DIR_COUNT_VERSION
                }
            },
            reqopts: {},
            log: log
        } ]
    }, function onPipelineDone(err) {
        /*
         * It's possible for these operations to fail if they overlap with
         * concurrent invocations of the same operation.  Among the errors that
         * have been observed from PostgreSQL here are:
         *
         *     - "tuple concurrently updated" (typically translated as a
         *       BucketConflictError by Moray)
         *
         *     - "deadlock detected" (which can happen if multiple callers
         *       attempt to add an index to the same bucket concurrently)
         *
         *     - "duplicate key value violates unique constraint"
         *
         *     - "column ... of relation ... already exists"
         *
         * From Moray, we can also see:
         *
         *     - "$bucket has a newer version than $version" (which can happen
         *       when a bucket is being upgraded).
         *
         * When these errors are reported, it's likely that at least one of the
         * concurrent operations will have succeeded, and historically we just
         * ignored these errors (i.e., we did not retry the operation).
         * However, it's difficult to keep this list up to date, and it's even
         * harder to actually verify correctness for these cases.  Instead, we
         * treat these like any other error, by failing this operation. The
         * caller will retry.
         *
         * There are two potential problems with retrying so liberally:
         *
         *    (1) If the errors are induced by concurrent requests and each of
         *        the callers retries with the same delay, convergence may take
         *        a very long time.  The caller avoids this using randomized
         *        exponential backoff.
         *
         *    (2) If the errors are common, then even a quick convergence might
         *        take several seconds, during which consumers like Muskie may
         *        be responding with 503 errors.  These errors should not be
         *        that common, however: most of the time when we start up, the
         *        buckets already exist with the expected version, so we will
         *        not try to make any changes, and we won't run into these
         *        errors.  We should only see these when multiple components
         *        start up concurrently that both decide they need to create or
         *        upgrade the buckets.
         */
        if (err) {
            err = new VError(err, 'setupMantaBuckets');
        }

        cb(err);
    }));
}

/*
 * We use a PostgreSQL trigger to maintain a separate table of sizes for each
 * directory.  We install that trigger immediately after creating the Manta
 * buckets in Moray.  This step is idempotent.
 */
function setupMantaTrigger(log, client, cb) {
    var readoptions, updatesql, funcsql;

    readoptions = { 'encoding': 'utf8' };

    return (vasync.waterfall([
        function readUpdateFunction(callback) {
            var filepath = path.join(__dirname, 'trigger_update.plpgsql');
            log.trace('setupMantaTrigger: read "%s"', filepath);
            fs.readFile(filepath, readoptions, function (err, c) {
                if (!err)
                    updatesql = c;
                callback(err);
            });
        },

        function readTriggerFunction(callback) {
            var filepath = path.join(__dirname, 'trigger_dircount.plpgsql');
            log.trace('setupMantaTrigger: read "%s"', filepath);
            fs.readFile(filepath, readoptions, function (err, c) {
                if (!err)
                    funcsql = c;
                callback(err);
            });
        },

        function updateTrigger(callback) {
            var sql, req;
            var opts = {
                readOnlyOverride: true
            };

            sql = updatesql + '\n' + funcsql;
            log.info({ 'sql': sql }, 'setupMantaTrigger: apply update');
            callback = once(callback);
            req = client.sql(sql, opts);
            req.on('record', function (row) {
                log.info(row, 'setupMantaTrigger: row');
            });
            req.once('error', callback);
            req.once('end', callback);
        }
    ], function (err) {
        if (err) {
            err = new VError(err, 'setupMantaTrigger');
        }

        cb(err);
    }));
}


function clone(obj) {
    if (!obj)
        return (obj);

    var copy = {};
    Object.keys(obj).forEach(function (k) {
        copy[k] = obj[k];
    });
    return (copy);
}


function recordDeleteLog(req, cb) {
    var microtime = require('microtime');
    var crc = require('crc');

    var log = req.log;
    log.debug({
        id: req.id,
        bucket: req.bucket,
        key: req.key,
        value: req.value,
        headers: req.headers
    }, 'recordDeleteLog entered.');
    var prevmd = req.headers['x-muskie-prev-metadata'];
    if (!prevmd || !prevmd.objectId) {
        log.debug('not logging without previous metadata');
        cb();
        return;
    }
    var prevObjectId = prevmd.objectId;

    if (req.value && req.value.objectId &&
        prevObjectId === req.value.objectId) {
        log.debug('not logging since object === prev object');
        cb();
        return;
    }
    log.debug('object ' + prevObjectId + ' is candidate for deletion.');

    // now log to the manta_delete_log table or the manta_fastdelete_queue...
    var now = Math.round((microtime.now() / 1000));
    var _key = '/' + prevObjectId + '/' + now;
    var _value = JSON.stringify(prevmd);
    var _etag = crc.hex32(crc.crc32(_value));
    var _mtime = now;
    var sql = '';
    var values = [];

    // If snaplinks are disabled use the fastdelete_queue rather than delete_log
    if (req.headers['x-muskie-snaplinks-disabled']) {
        log.debug('object ' + prevObjectId + ' being added to fastdelete.');
        sql = 'INSERT INTO manta_fastdelete_queue (_key, _value, _etag, ' +
            '_mtime) VALUES ($1, $2, $3, $4)';
        values = [prevObjectId, _value, _etag, _mtime];
    } else {
        sql = 'INSERT INTO manta_delete_log (_key, _value, _etag, ' +
            '_mtime, objectId) VALUES ($1, $2, $3, $4, $5)';
        values = [_key, _value, _etag, _mtime, prevObjectId];
    }

    // execute
    var q = req.pg.query(sql, values);
    q.once('error', function (err) {
        log.debug(err, 'manta delete log insert: failed');
        cb(err);
    });
    q.once('end', function () {
        log.debug('manta delete log insert: done');
        cb();
    });
}


function createMetadata(options) {
    assert.string(options.owner, 'options.owner');
    assert.string(options.type, 'options.type');
    assert.optionalObject(options.headers, 'options.headers');

    var key = options.key;
    var md = {
        dirname: ROOT_RE.test(key) ? key : path.dirname(key),
        key: key,
        headers: (options.type !== 'link' ?
                  clone(options.headers || {}) : undefined),
        mtime: Date.now(),
        name: path.basename(key),
        creator: options.creator || options.owner,
        owner: options.owner,
        roles: options.roles,
        type: options.type
    };

    switch (options.type) {
    case 'object':
        assert.number(options.contentLength, 'options.contentLength');
        assert.string(options.contentMD5, 'options.contentMD5');
        assert.string(options.contentType, 'options.contentType');
        assert.string(options.objectId, 'options.objectId');
        assert.arrayOfObject(options.sharks, 'options.sharks');

        if (!process.env.NODE_NDEBUG) {
            options.sharks.forEach(function validateShark(s) {
                assert.string(s.manta_storage_id,
                              'shark.manta_storage_id');
            });
        }

        md.contentLength = options.contentLength;
        md.contentMD5 = options.contentMD5;
        md.contentType = options.contentType;
        md.etag = options.etag || options.objectId;
        md.objectId = options.objectId;
        md.sharks = options.sharks.slice();
        break;
    case 'link':
        assert.object(options.link, 'options.link');
        var src = options.link;
        md.contentLength = src.contentLength;
        md.contentMD5 = src.contentMD5;
        md.contentType = src.contentType;
        md.createdFrom = src.key;
        md.etag = src.etag;
        md.headers = clone(src.headers);
        md.objectId = src.objectId;
        md.sharks = src.sharks;
        md.type = 'object'; // overwrite;
        break;

    case 'directory':
        if (options.upload) {
            md.upload = options.upload;
        }
        break;

    default:
        break;
    }

    return (md);
}


function createBucket(opts, cb) {
    assert.string(opts.bucket, 'opts.bucket');
    assert.object(opts.client, 'opts.client');
    assert.object(opts.opts, 'opts.opts');
    assert.object(opts.reqopts, 'opts.reqopts');
    assert.object(opts.log, 'opts.log');
    assert.func(cb, 'callback');
    var bucket = opts.bucket;
    var client = opts.client;

    client.putBucket(bucket, opts.opts, opts.reqopts, function (err) {
        var realErrors = [];

        /*
         * Filters out errors we want to ignore that would otherwise
         * cause startup to fail. This will still push real errors
         * up to the callback.
         */
        function pushErrIfValid(tryError) {
            function checkAndPushError(sErr) {
                if (VError.findCauseByName(sErr, 'BucketVersionError')
                    !== null) {
                    opts.log.warn(sErr, 'ignoring bucket schema out of date');
                } else {
                    realErrors.push(sErr);
                }
            }

            if (VError.hasCauseWithName(tryError, 'MultiError')) {
                /*
                 * A MultiError structure is as follows
                 *
                 *    "name": "MultiError",
                 *    "jse_shortmsg": "first of N errors...",
                 *    "jse_info": { },
                 *    "message": "first of N errors...",
                 *    "context": { },
                 *    "ase_errors": [
                 *        {
                 *            "name": "BucketVersionError",
                 *            "jse_shortmsg": "manta has a newer version...",
                 *            "jse_info": { },
                 *            "message": "manta has a newer version than 1 (3)",
                 *            "context": { }
                 *        },
                 *        {
                 *            "name": "SomeOtherErrror",
                 *            "jse_shortmsg": "...",
                 *            "jse_info": { },
                 *            "message": "...",
                 *            "context": { }
                 *        }
                 *    ]
                 *
                 * We just filter errors in the ase_errors list
                 */
                var errs = tryError.ase_errors;
                errs.forEach(checkAndPushError);
            } else {
                checkAndPushError(tryError);
            }
        }

        /*
         * Entry point to the above filtering
         * errorForEach() will handle both cases of a MultiError or a
         * single error.
         */
        if (err) {
            VError.errorForEach(err, pushErrIfValid);
        }

        /*
         * Collect any important errors we found and rebuild them into
         * a MultiError
         */
        if (realErrors.length > 0) {
            var err2 = new VError.errorFromList(realErrors);
            err2.bucket = bucket;
            err2.opts = opts.opts;
            cb(err2);
        } else {
            opts.log.debug(opts.opts, 'Moray.createBucket done');
            cb();
        }
    });
}


// Helper that calls Moray's `putObject`.
function put(options, cb) {
    assert.object(options, 'options');
    assert.number(options.attempts, 'options.number');
    assert.ok(options.attempts >= 0);
    assert.object(options.client, 'options.client');
    assert.object(options.log, 'options.log');
    assert.string(options.op, 'options.op');
    assert.ok(options.op === 'putMetadata' ||
        options.op === 'putFinalizingMetadata');
    assert.string(options.bucket, 'options.bucket');
    assert.string(options.key, 'options.key');
    assert.object(options.md, 'options.md');
    assert.object(options.putOptions, 'options.putOptions');
    assert.func(cb, 'callback');

    var attempts = options.attempts;
    var client = options.client;
    var log = options.log;
    var op = options.op;
    var bucket = options.bucket;
    var key = options.key;
    var md = options.md;
    var opts = options.putOptions;

    log.debug({
        attempts: attempts,
        key: key,
        metadata: md,
        etag: opts.etag,
        requestId: opts.requestId,
        headers: opts.headers
    }, 'Moray.' + op + ': entered');

    client.putObject(bucket, key, md, opts, function (err, data) {
        if (err) {
            log.debug({
                err: err,
                key: key,
                requestId: opts.requestId
            }, 'Moray.' + op + ': error writing metadata');

            if ((err.name === 'EtagConflictError' ||
                err.name === 'UniqueAttributeError') &&
                opts.etag === undefined && ++attempts < 3) {
                options.attempts++;
                setImmediate(put, options, cb);
            } else {
                cb(err);
            }
        } else {
            log.debug({
                key: key,
                requestId: opts.requestId
            }, 'Moray.' + op + ': done');
            cb(null, md, data);
        }
    });
}

///--- API

function Moray(options) {
    var self = this;

    assert.optionalBool(options.readOnly, 'options.readOnly');

    EventEmitter.call(this);

    this.client = null;

    if (options.hasOwnProperty('morayOptions')) {
        this.morayOptions = jsprim.deepCopy(options.morayOptions);
    } else {
        this.morayOptions = {
            'host': options.host,
            'port': parseInt(options.port || 2020, 10),
            'retry': options.retry,
            'connectTimeout': options.connectTimeout || 1000
        };
    }

    this.log = options.log.child({ component: 'MorayIndexClient' }, true);
    this.morayOptions.log = this.log;
    this.morayOptions.unwrapErrors = true;
    this.readOnly = false;

    if (options.readOnly) {
        this.readOnly = true;
    }

    /*
     * Configure the exponential backoff object we use to manage backoff during
     * initialization.
     */
    this.initBackoff = new backoff.exponential({
        'randomisationFactor': 0.5,
        'initialDelay': 1000,
        'maxDelay': 300000
    });

    this.initBackoff.on('backoff', function (which, delay, error) {
        assert.equal(which + 1, self.initAttempts);
        self.log.warn({
            'nfailures': which + 1,
            'willRetryAfterMilliseconds': delay,
            'error': error
        }, 'libmanta.Moray.initAttempt failed (will retry)');
    });

    this.initBackoff.on('ready', function () {
        self.initAttempt();
    });

    /*
     * Define event handlers for the Moray client used at various parts during
     * initialization.
     *
     * The Moray client should generally not emit errors, but it's known to do
     * so under some conditions.  Our response depends on what phases of
     * initialization we've already completed:
     *
     * (1) Before we've established a connection to the client: if an error is
     *     emitted at this phase, we assume that we failed to establish a
     *     connection and we abort the current initialization attempt.  We will
     *     end up retrying with exponential backoff.
     *
     * (2) After we've established a connection, but before initialization has
     *     completed: if an error is emitted at this phase, we'll log it but
     *     otherwise ignore it because we assume that whatever operations we
     *     have outstanding will also fail.
     *
     * (3) After we've initialized, errors are passed through to our consumer.
     */
    this.onErrorDuringInit = function onErrorDuringInit(err) {
        self.log.warn(err, 'ignoring client-level error during init');
    };
    this.onErrorPostInit = function onErrorPostInit(err) {
        self.log.warn(err, 'moray client error');
        self.emit('error', err);
    };

    /* These fields exist only for debugging. */
    this.initAttempts = 0;
    this.initPipeline = null;
    this.initBuckets = null;
    this.initTrigger = null;

    this.initAttempt();
}

util.inherits(Moray, EventEmitter);

Moray.prototype.initAttempt = function initAttempt() {
    var self = this;
    var log = this.log;

    assert.ok(this.client === null, 'previous initAttempt did not complete');
    assert.ok(this.initPipeline === null);
    assert.ok(this.initBuckets === null);
    assert.ok(this.initTrigger === null);

    this.initAttempts++;
    log.debug({
        'attempt': this.initAttempts
    }, 'libmanta.Moray.initAttempt: entered');

    var initFuncs = [];

    /*
     * Define vasync waterfall steps such that we can
     * decide which ones to add to the waterfall depending
     * on whether or not this is a read-only client.
     */
    function initClient(callback) {
        self.client = moray.createClient(self.morayOptions);

        var onErrorDuringConnect = function onErrDuringConnect(err) {
            callback(new VError(err, 'moray client error'));
        };

        self.client.on('error', onErrorDuringConnect);
        self.client.once('connect', function onConnect() {
            self.client.removeListener('error', onErrorDuringConnect);
            self.client.on('error', self.onErrorDuringInit);
            callback();
        });
    }

    function setupBuckets(callback) {
        self.initBuckets = setupMantaBuckets(log, self.client, callback);
    }

    function setupTrigger(callback) {
        self.initTrigger = setupMantaTrigger(log, self.client, callback);
    }

    initFuncs.push(initClient);
    // If this is a readOnly client, do not do database setup tasks
    if (!this.readOnly) {
        initFuncs.push(setupBuckets);
        initFuncs.push(setupTrigger);
    }

    this.initPipeline = vasync.waterfall(initFuncs, function (err) {
        self.initPipeline = null;
        self.initBuckets = null;
        self.initTrigger = null;

        if (err) {
            if (self.initBuckets !== null) {
                self.client.removeListener('error', self.onErrorDuringInit);
            }
            self.client.close();
            self.client = null;
            err = new VError(err, 'libmanta.Moray.initAttempt');
            self.initBackoff.backoff(err);
        } else {
            /*
             * We could reset the "backoff" object in the success case, or
             * even null it out since we're never going to use it again.
             * But it's not that large, and it may be useful for debugging,
             * so we just leave it alone.
             */
            self.client.removeListener('error', self.onErrorDuringInit);
            self.client.on('error', self.onErrorPostInit);
            self.client.on('close', self.emit.bind(self, 'close'));
            self.client.on('connect', self.emit.bind(self, 'connect'));
            log.info({ 'attempt': self.initAttempts },
                'libmanta.Moray.initAttempt: done');
            self.emit('connect');
        }
    });
};


Moray.prototype.putMetadata = function putMetadata(options, callback) {
    assert.object(options, 'options');
    assert.string(options.key, 'options.key');
    assert.string(options.requestId, 'options.requestId');
    assert.optionalBool(this.readOnly, 'this.readOnly');
    assert.func(callback, 'callback');

    if (this.readOnly) {
        throw new assert.AssertionError({
            message: 'Operation putMetadata ' +
                'not supported in a read-only client'
        });
    }

    if (!options.upload) {
        assert.object(options, 'options.previousMetadata');
    } else {
        assert.ok(!options.previousMetadata);
    }

    callback = once(callback);

    if (!this.client) {
        setImmediate(function () {
            callback(new Error('not connected'));
        });
        return;
    }

    var putOptions = {
        req_id: options.requestId,
        etag: options._etag
    };

    if (!options.upload) {
        putOptions.headers = {
            'x-muskie-prev-metadata': options.previousMetadata
        };
    }

    var opts = {
        attempts: 0,
        client: this.client,
        log: this.log,
        key: options.key,
        op: 'putMetadata',
        bucket: BUCKET,
        md: createMetadata(options),
        putOptions: putOptions
    };

    put(opts, callback);
};


/*
 * Used by the multipart upload API, this method will store a
 * finalizing record in the special multipart upload bucket. We only
 * use this method for aborting uploads, as commits require the insertion
 * of an object record as well. We use the `commitMPU` method for commits.
 */
Moray.prototype.putFinalizingMetadata =
function putFinalizingMetadata(options, callback) {
    assert.object(options, 'options');
    assert.string(options.key, 'options.key');
    assert.object(options.md, 'options.md');
    assert.string(options.md.uploadId, 'options.md.uploadId');
    assert.string(options.md.finalizingType, 'options.md.finalizingType');
    assert.string(options.md.owner, 'options.md.owner');
    assert.string(options.md.requestId, 'options.md.requestId');
    assert.string(options.md.objectPath, 'options.md.objectPath');
    assert.string(options.md.objectId, 'options.md.objectId');
    assert.optionalBool(this.readOnly, 'this.readOnly');
    assert.func(callback, 'callback');

    callback = once(callback);

    if (this.readOnly) {
        throw new assert.AssertionError({
            message: 'Operation putFinalizingMetadata ' +
                'not supported in a read-only client'
        });
    }

    if (!this.client) {
        setImmediate(function () {
            callback(new Error('not connected'));
        });
        return;
    }

    var putOptions = {
        req_id: options.requestId,
        etag: options._etag
    };

    var opts = {
        attempts: 0,
        client: this.client,
        log: this.log,
        key: options.key,
        op: 'putFinalizingMetadata',
        bucket: MANTA_UPLOADS_BUCKET,
        md: options.md,
        putOptions: putOptions
    };

    put(opts, callback);
};


Moray.prototype.getMetadata = function getMetadata(options, callback) {
    assert.object(options, 'options');
    assert.string(options.key, 'options.key');
    assert.string(options.requestId, 'options.requestId');
    assert.func(callback, 'callback');

    if (!this.client) {
        setImmediate(function () {
            callback(new Error('not connected'));
        });
        return;
    }

    var client = this.client;
    var key = options.key;
    var log = this.log;
    var opts = {
        req_id: options.requestId,
        noCache: true
    };

    log.debug({
        key: key,
        requestId: opts.requestId,
        headers: opts.headers
    }, 'Moray.getMetadata: entered');

    client.getObject(BUCKET, key, opts, function (err, md) {
        if (err) {
            log.debug({
                err: err,
                key: key,
                requestId: opts.requestId
            }, 'Moray.getMetadata: error reading metadata');
            callback(err);
        } else {
            log.debug({
                key: key,
                metadata: md.value,
                requestId: opts.requestId
            }, 'Moray.getMetadata: done');
            callback(null, md.value, md);
        }
    });
};


/*
 * Used by the multipart upload API, this function will fetch a
 * finalizing record from the special multipart upload bucket.
 */
Moray.prototype.getFinalizingMetadata =
function getFinalizingMetadata(options, callback) {
    assert.object(options, 'options');
    assert.string(options.key, 'options.key');
    assert.string(options.requestId, 'options.requestId');
    assert.func(callback, 'callback');

    if (!this.client) {
        setImmediate(function () {
            callback(new Error('not connected'));
        });
        return;
    }

    var client = this.client;
    var key = options.key;
    var log = this.log;
    var opts = {
        req_id: options.requestId,
        noCache: true
    };

    log.debug({
        key: key,
        requestId: opts.requestId
    }, 'Moray.getFinalizingMetadata: entered');

    client.getObject(MANTA_UPLOADS_BUCKET, key, opts, function (err, md) {
        if (err) {
            log.debug({
                err: err,
                key: key,
                requestId: opts.requestId
            }, 'Moray.getFinalizingMetadata: error reading metadata');
            callback(err);
        } else {
            log.debug({
                key: key,
                metadata: md.value,
                requestId: opts.requestId
            }, 'Moray.getFinalizingMetadata: done');
            callback(null, md.value, md);
        }
    });
};


Moray.prototype.delMetadata = function delMetadata(options, callback) {
    assert.object(options, 'options');
    assert.string(options.key, 'options.key');
    assert.string(options.requestId, 'options.requestId');
    assert.object(options, 'options.previousMetadata');
    assert.optionalBool(options.snapLinksDisabled,
        'options.snapLinksDisabled');
    assert.func(callback, 'callback');

    if (!this.client) {
        setImmediate(function () {
            callback(new Error('not connected'));
        });
        return;
    }

    var attempts = 0;
    var client = this.client;
    var key = options.key;
    var log = this.log;
    var opts = {
        req_id: options.requestId,
        etag: options._etag
    };

    if (options.snapLinksDisabled) {
        opts.headers = {
            'x-muskie-prev-metadata': options.previousMetadata,
            'x-muskie-snaplinks-disabled': true
        };
    } else {
        opts.headers = {
            'x-muskie-prev-metadata':  options.previousMetadata
        };
    }

    log.debug({
        key: key,
        etag: opts.etag,
        requestId: opts.requestId,
        headers: opts.headers
    }, 'Moray.delMetadata: entered');
    (function del() {
        client.delObject(BUCKET, key, opts, function (err) {
            if (err) {
                log.debug({
                    err: err,
                    key: key,
                    requestId: opts.requestId
                }, 'Moray.delMetadata: error');
                if ((err.name === 'EtagConflictError' ||
                     err.name === 'UniqueAttributeError') &&
                    opts.etag === undefined && ++attempts < 3) {
                    process.nextTick(del);
                } else {
                    callback(err);
                }
            } else {
                log.debug({
                    key: key,
                    requestId: opts.requestId
                }, 'Moray.delMetadata: done');
                callback(null);
            }
        });
    })();
};


Moray.prototype.getDirectoryCount = function getDirectoryCount(options, cb) {
    assert.object(options, 'options');
    assert.string(options.directory, 'options.directory');
    assert.string(options.requestId, 'options.requestId');
    assert.func(cb, 'callback');

    cb = once(cb);

    if (!this.client) {
        setImmediate(function () {
            cb(new Error('not connected'));
        });
        return;
    }

    var client = this.client;
    var dir = options.directory;
    var log = this.log;
    var opts = {
        req_id: options.requestId,
        noCache: true
    };

    log.debug({
        dir: dir,
        requestId: opts.requestId
    }, 'Moray.getDirectoryCount: entered');

    client.getObject(DIR_COUNT_BUCKET, dir, opts, function (err, obj) {
        if (err) {
            cb(err);
        } else {
            var count = parseInt(obj.value.entries, 10);
            log.debug({
                dir: dir,
                count: count,
                requestId: opts.requestId
            }, 'Moray.getDirectoryCount: done');
            cb(null, count, obj);
        }
    });
};


/*
 * Commits a multipart upload by performing a Moray batch insertion of a
 * finalizing record in the Manta multipart uploads bucket and an object record
 * for the target object being committed.
 */
Moray.prototype.commitMPU = function commitMPU(options, cb) {
    assert.object(options, 'options');
    assert.arrayOfObject(options.requests, 'options.requests');
    // Some sanity checks that only MPU is using this interface.
    assert.ok(options.requests.length === 2);
    assert.ok(options.requests[0].operation === 'put');
    assert.ok(options.requests[1].operation === 'put');
    assert.ok(((options.requests[0].bucket === BUCKET) &&
               (options.requests[1].bucket === MANTA_UPLOADS_BUCKET)) ||
              ((options.requests[1].bucket === BUCKET) &&
               (options.requests[0].bucket === MANTA_UPLOADS_BUCKET)));
    assert.string(options.requestId, 'options.requestId');
    assert.func(cb, 'callback');

    cb = once(cb);

    if (!this.client) {
        setImmediate(function () {
            cb(new Error('not connected'));
        });
        return;
    }

    var client = this.client;
    var log = this.log;
    var opts = {
        req_id: options.requestId
    };

    log.debug({
        requests: options.requests,
        requestId: opts.requestId
    }, 'Moray.commitMPU: entered');

    client.batch(options.requests, opts, function (err, meta) {
        if (err) {
            cb(err);
        } else {
            log.debug({
                requestId: opts.requestId
            }, 'Moray.commitMPU: done');
            cb(null, meta);
        }
    });
};


Moray.prototype.ping = function ping(opts, cb) {
    if (typeof (opts) === 'function') {
        cb = opts;
        opts = {};
    }
    assert.object(opts, 'options');
    assert.func(cb, 'callback');

    if (!this.client) {
        process.nextTick(cb.bind(this, new Error('not connected')));
        return;
    }

    this.client.ping(opts, cb);
};


///--- Low level wrappers over the plain jane Moray Client

Moray.prototype.search = function search(options) {
    assert.object(options, 'options');
    assert.string(options.filter, 'options.filter');
    assert.string(options.requestId, 'options.requestId');

    if (!this.client)
        throw new Error('not connected');

    var client = this.client;
    var log = this.log;
    var opts = {
        limit: options.limit,
        no_count: options.no_count,
        offset: options.offset,
        req_id: options.requestId,
        sort: options.sort,
        req_id: options.requestId,
        hashkey: options.hashkey
    };

    log.debug({
        filter: options.filter,
        requestId: opts.requestId,
        opts: opts
    }, 'Moray.search: entered');
    return (client.findObjects(BUCKET, options.filter, opts));
};


Moray.prototype.close = function close(callback) {
    if (!this.client) {
        if (callback) {
            process.nextTick(function () {
                callback(new Error('not connected'));
            });
        }
    } else {
        if (callback)
            this.client.once('close', callback);
        this.client.close();
    }
};


Moray.prototype.toString = function toString() {
    return ('[object MorayRingClient]');
};


///--- Exports

module.exports = {
    createMorayClient: function createMorayClient(opts) {
        return (new Moray(opts));
    }
};
