importScripts('analytics-config.js', 'analytics.js', 'jszip.min.js');

var ZIP_GENERATION_SLOW_MS = 15000;
var DOWNLOAD_RETRY_DELAYS_MS = [500, 1500, 4000];
var TRANSIENT_DOWNLOAD_ERROR_PATTERNS = [
    'NETWORK_FAILED',
    'NETWORK_TIMEOUT',
    'NETWORK_DISCONNECTED',
    'NETWORK_SERVER_DOWN',
    'SERVER_FAILED',
    'SERVER_UNREACHABLE',
    'SERVER_TIMEOUT'
];

var exportCancelRequested = false;
var keepAliveTimer = null;
var exportRunning = false;

chrome.runtime.onInstalled.addListener((details) => {
    console.log('X Bookmark Exporter installed');
    if (details.reason === 'install') {
        self.xbmAnalytics.sendEvent('extension_installed', {
            version: chrome.runtime.getManifest().version
        });
    } else if (details.reason === 'update') {
        self.xbmAnalytics.sendEvent('extension_updated', {
            version: chrome.runtime.getManifest().version
        });
    }
});

chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
    if (request.action === 'createAndDownloadZip') {
        if (exportRunning) {
            sendResponse({accepted: false, error: 'An export is already running in the background.'});
            return;
        }
        exportCancelRequested = false;
        exportRunning = true;
        setExportJob({
            status: 'running',
            message: 'Creating ZIP…',
            stage: 'zip',
            ts: Date.now(),
            count: Array.isArray(request.files) ? request.files.length : 0
        });
        startKeepAlive();
        runZipAndDownload(request.files || [], !!request.isIncremental)
            .then(function() {
                // success path handled inside
            })
            .catch(function() {
                // error path handled inside
            })
            .finally(function() {
                exportRunning = false;
                stopKeepAlive();
            });
        sendResponse({accepted: true});
        return;
    }

    if (request.action === 'cancelExportJob') {
        exportCancelRequested = true;
        sendResponse({ok: true});
        return;
    }

    if (request.action === 'getExportJob') {
        chrome.storage.local.get(['exportJob'], function(data) {
            sendResponse({job: data.exportJob || null});
        });
        return true;
    }
});

function startKeepAlive() {
    stopKeepAlive();
    keepAliveTimer = setInterval(function() {
        try {
            chrome.runtime.getPlatformInfo(function() {});
        } catch (e) {
            // ignore
        }
    }, 15000);
}

function stopKeepAlive() {
    if (keepAliveTimer !== null) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = null;
    }
}

function setExportJob(job) {
    return new Promise(function(resolve) {
        chrome.storage.local.set({exportJob: job}, resolve);
    });
}

function delay(ms) {
    return new Promise(function(resolve) {
        setTimeout(resolve, ms);
    });
}

function generateIndexFile(files, isIncremental) {
    var index = '# X Bookmark Export\n\n';
    if (isIncremental) {
        index += '*Incremental export (new items vs. local history)*\n\n';
    }
    index += 'Exported at: ' + new Date().toLocaleString('en-US') + '\n';
    index += 'Total: ' + files.length + ' bookmarks\n\n';
    index += '## File List\n\n';

    files.forEach(function(file, i) {
        var m = file.filename.match(/@([^_]+)/);
        var username = m ? m[1] : 'unknown';
        index += (i + 1) + '. [' + file.filename + '](./' + file.filename + ') - @' + username + '\n';
    });

    return index;
}

function blobToDataUrl(blob) {
    return new Promise(function(resolve, reject) {
        var reader = new FileReader();
        reader.onloadend = function() {
            if (typeof reader.result === 'string') {
                resolve(reader.result);
            } else {
                reject(new Error('Failed to encode ZIP for download.'));
            }
        };
        reader.onerror = function() {
            reject(new Error('Failed to encode ZIP for download.'));
        };
        reader.readAsDataURL(blob);
    });
}

function isUserCanceledError(lastError) {
    return !!(lastError && lastError.message && lastError.message.indexOf('USER_CANCELED') !== -1);
}

function isTransientDownloadError(lastError) {
    if (!lastError || !lastError.message) {
        return false;
    }
    return TRANSIENT_DOWNLOAD_ERROR_PATTERNS.some(function(pattern) {
        return lastError.message.indexOf(pattern) !== -1;
    });
}

function watchDownloadInterruption(downloadId) {
    if (!chrome.downloads.onChanged) {
        return;
    }
    function onChanged(delta) {
        if (delta.id !== downloadId || !delta.state || delta.state.current !== 'interrupted') {
            return;
        }
        chrome.downloads.onChanged.removeListener(onChanged);
        var reason = delta.error && delta.error.current ? delta.error.current : 'unknown';
        if (reason === 'USER_CANCELED') {
            return;
        }
        if (self.xbmAnalytics) {
            self.xbmAnalytics.sendEvent('export_error', {
                reason: 'download_interrupted',
                stage: 'download_' + reason
            });
        }
    }
    chrome.downloads.onChanged.addListener(onChanged);
}

function attemptDownload(dataUrl, filename) {
    return new Promise(function(resolve, reject) {
        chrome.downloads.download({
            url: dataUrl,
            filename: filename,
            conflictAction: 'uniquify',
            saveAs: true
        }, function(downloadId) {
            if (chrome.runtime.lastError) {
                var dlErr = new Error(chrome.runtime.lastError.message);
                dlErr.stage = 'download';
                dlErr.userCanceled = isUserCanceledError(chrome.runtime.lastError);
                dlErr.transient = isTransientDownloadError(chrome.runtime.lastError);
                reject(dlErr);
                return;
            }
            if (downloadId === undefined) {
                var noIdErr = new Error('Download did not start (no download id).');
                noIdErr.stage = 'download';
                reject(noIdErr);
                return;
            }
            watchDownloadInterruption(downloadId);
            resolve(downloadId);
        });
    });
}

function downloadWithRetry(dataUrl, filename) {
    var attempt = 0;
    function tryOnce() {
        return attemptDownload(dataUrl, filename).catch(function(err) {
            if (err.transient && attempt < DOWNLOAD_RETRY_DELAYS_MS.length) {
                var wait = DOWNLOAD_RETRY_DELAYS_MS[attempt];
                attempt++;
                return delay(wait).then(tryOnce);
            }
            throw err;
        });
    }
    return tryOnce();
}

async function runZipAndDownload(files, isIncremental) {
    try {
        if (exportCancelRequested) {
            await setExportJob({
                status: 'canceled',
                message: 'Export canceled.',
                ts: Date.now()
            });
            return;
        }

        if (typeof JSZip === 'undefined') {
            throw Object.assign(new Error('ZIP library is not available in the background worker.'), {
                stage: 'zip',
                reasonCode: 'zip_failed'
            });
        }

        var zip = new JSZip();
        files.forEach(function(file) {
            zip.file(file.filename, file.content);
        });
        zip.file('index.md', generateIndexFile(files, isIncremental));

        await setExportJob({
            status: 'running',
            message: 'Creating ZIP…',
            stage: 'zip',
            ts: Date.now(),
            count: files.length
        });

        var zipStartedAt = Date.now();
        var isSlowZip = false;
        var blob;
        try {
            blob = await zip.generateAsync({
                type: 'blob',
                compression: 'DEFLATE',
                compressionOptions: {level: 1}
            }, function onUpdate() {
                if (!isSlowZip && Date.now() - zipStartedAt > ZIP_GENERATION_SLOW_MS) {
                    isSlowZip = true;
                }
            });
        } catch (err) {
            var zipError = new Error(err && err.message ? err.message : 'ZIP generation failed.');
            zipError.stage = 'zip';
            zipError.reasonCode = isSlowZip ? 'zip_generation_large' : 'zip_failed';
            throw zipError;
        }

        if (exportCancelRequested) {
            await setExportJob({
                status: 'canceled',
                message: 'Export canceled.',
                ts: Date.now()
            });
            return;
        }

        await setExportJob({
            status: 'running',
            message: 'Downloading ZIP…',
            stage: 'download',
            ts: Date.now(),
            count: files.length
        });

        var dataUrl = await blobToDataUrl(blob);
        var datePart = new Date().toISOString().split('T')[0];
        var suffix = isIncremental ? '-incremental' : '';
        var filename = 'x-bookmarks-' + datePart + suffix + '.zip';

        await downloadWithRetry(dataUrl, filename);

        await setExportJob({
            status: 'success',
            message: 'Exported ' + files.length + ' bookmarks.',
            ts: Date.now(),
            count: files.length,
            isIncremental: !!isIncremental
        });
    } catch (err) {
        if (exportCancelRequested || (err && err.exportCanceled)) {
            await setExportJob({
                status: 'canceled',
                message: 'Export canceled.',
                ts: Date.now()
            });
            return;
        }
        if (err && err.userCanceled) {
            await setExportJob({
                status: 'canceled',
                message: 'Save canceled.',
                ts: Date.now()
            });
            return;
        }

        var stage = (err && err.stage) || 'zip';
        var reasonCode = (err && err.reasonCode) || 'zip_download_failed';
        var message = err && err.message ? err.message : 'Failed to create or download ZIP.';

        await setExportJob({
            status: 'error',
            message: message,
            stage: stage,
            reason: reasonCode,
            ts: Date.now()
        });

        chrome.storage.local.set({
            lastExportError: {
                stage: stage,
                reason: reasonCode,
                message: message,
                ts: Date.now()
            }
        });

        if (self.xbmAnalytics) {
            self.xbmAnalytics.sendEvent('export_error', {
                reason: reasonCode,
                stage: stage
            });
        }
    }
}
