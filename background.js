importScripts('analytics-config.js', 'analytics.js', 'jszip.min.js');

var ZIP_GENERATION_SLOW_MS = 15000;

var exportCancelRequested = false;
var keepAliveTimer = null;
var exportRunning = false;
/** @type {{ buffer: ArrayBuffer, filename: string, resolve: Function, reject: Function, windowId?: number } | null} */
var pendingDownload = null;

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

chrome.windows.onRemoved.addListener(function(windowId) {
    if (!pendingDownload || pendingDownload.windowId !== windowId) {
        return;
    }
    var pending = pendingDownload;
    pendingDownload = null;
    var err = new Error('Save canceled.');
    err.stage = 'download';
    err.userCanceled = true;
    pending.reject(err);
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

    // download.html claims the in-memory ZIP produced by the service worker.
    // MV3 workers cannot reliably use URL.createObjectURL / large data: URLs with
    // chrome.downloads + saveAs, so a tiny extension page performs the download.
    if (request.action === 'claimPendingDownload') {
        if (!pendingDownload) {
            sendResponse({ok: false});
            return;
        }
        sendResponse({
            ok: true,
            buffer: pendingDownload.buffer,
            filename: pendingDownload.filename
        });
        return;
    }

    if (request.action === 'pendingDownloadResult') {
        if (!pendingDownload) {
            sendResponse({ok: true});
            return;
        }
        var pending = pendingDownload;
        pendingDownload = null;
        if (request.ok) {
            pending.resolve(request.downloadId);
        } else {
            var err = new Error(request.message || 'Download failed.');
            err.stage = 'download';
            err.userCanceled = !!request.userCanceled;
            if (request.reason && request.reason !== 'USER_CANCELED' && self.xbmAnalytics) {
                self.xbmAnalytics.sendEvent('export_error', {
                    reason: 'download_interrupted',
                    stage: 'download_' + request.reason
                });
            }
            pending.reject(err);
        }
        sendResponse({ok: true});
        return;
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

/**
 * Open a small extension page that can use URL.createObjectURL and show saveAs.
 * Service-worker chrome.downloads with data: URLs is unreliable (size limits /
 * missing user-gesture for save dialogs).
 */
function openDownloadPage(arrayBuffer, filename) {
    return new Promise(function(resolve, reject) {
        if (pendingDownload) {
            reject(Object.assign(new Error('Another download is already pending.'), {
                stage: 'download',
                reasonCode: 'zip_download_failed'
            }));
            return;
        }

        pendingDownload = {
            buffer: arrayBuffer,
            filename: filename,
            resolve: resolve,
            reject: reject
        };

        chrome.windows.create({
            url: chrome.runtime.getURL('download.html'),
            type: 'popup',
            width: 380,
            height: 160,
            focused: true
        }, function(win) {
            if (chrome.runtime.lastError || !win) {
                pendingDownload = null;
                var openErr = new Error(
                    chrome.runtime.lastError
                        ? chrome.runtime.lastError.message
                        : 'Failed to open download window.'
                );
                openErr.stage = 'download';
                openErr.reasonCode = 'zip_download_failed';
                reject(openErr);
                return;
            }
            pendingDownload.windowId = win.id;
        });
    });
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

        var buffer = await blob.arrayBuffer();
        var datePart = new Date().toISOString().split('T')[0];
        var suffix = isIncremental ? '-incremental' : '';
        var filename = 'x-bookmarks-' + datePart + suffix + '.zip';

        await openDownloadPage(buffer, filename);

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
