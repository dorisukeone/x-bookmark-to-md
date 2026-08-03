document.addEventListener('DOMContentLoaded', function() {
    const MAX_STORED_URLS = 8000;
    /** Slider index → maxBookmarks for content script (0 = unlimited) */
    const CAP_BY_INDEX = [0, 50, 100, 200, 500, 1000];
    /** generateAsync onUpdate calls after this many ms mark the run as a "large zip" for analytics */
    const ZIP_GENERATION_SLOW_MS = 15000;
    /** Exponential backoff delays (ms) between retries of a transient chrome.downloads.download failure */
    const DOWNLOAD_RETRY_DELAYS_MS = [500, 1500, 4000];
    /** chrome.downloads InterruptReason values considered transient and safe to retry */
    const TRANSIENT_DOWNLOAD_ERROR_PATTERNS = [
        'NETWORK_FAILED',
        'NETWORK_TIMEOUT',
        'NETWORK_DISCONNECTED',
        'NETWORK_SERVER_DOWN',
        'SERVER_FAILED',
        'SERVER_UNREACHABLE',
        'SERVER_TIMEOUT'
    ];

    const exportBtn = document.getElementById('exportBtn');
    const cancelExportBtn = document.getElementById('cancelExportBtn');
    const retryExportBtn = document.getElementById('retryExportBtn');
    const openBookmarksBtn = document.getElementById('openBookmarksBtn');
    const status = document.getElementById('status');
    const statusIcon = document.getElementById('statusIcon');
    const statusText = document.getElementById('statusText');
    const priorErrorBanner = document.getElementById('priorErrorBanner');
    const priorErrorText = document.getElementById('priorErrorText');
    const dismissPriorErrorBtn = document.getElementById('dismissPriorErrorBtn');
    const keepOpenNotice = document.getElementById('keepOpenNotice');
    const capSlider = document.getElementById('capSlider');
    const capDisplay = document.getElementById('capDisplay');
    const modeFull = document.getElementById('modeFull');
    const modeIncremental = document.getElementById('modeIncremental');
    const historyCard = document.getElementById('historyCard');
    const statLastDisplay = document.getElementById('statLastDisplay');
    const statUrlsDisplay = document.getElementById('statUrlsDisplay');
    const clearHistoryBtn = document.getElementById('clearHistoryBtn');
    const extVersionEl = document.getElementById('extVersion');

    var isExporting = false;
    var cancelRequested = false;

    try {
        var ver = chrome.runtime.getManifest().version;
        extVersionEl.textContent = 'v' + ver;
    } catch (e) {
        extVersionEl.textContent = '';
    }

    window.addEventListener('pagehide', function() {
        if (isExporting && self.xbmAnalytics) {
            self.xbmAnalytics.sendEvent('export_error', {
                reason: 'popup_closed',
                stage: 'popup_closed'
            });
        }
    });

    function maxToSliderIndex(max) {
        var raw = max == null || max === 0 ? 0 : max;
        if (raw === 0) {
            return 0;
        }
        var best = 1;
        var bestDiff = Infinity;
        for (var i = 1; i < CAP_BY_INDEX.length; i++) {
            var d = Math.abs(CAP_BY_INDEX[i] - raw);
            if (d < bestDiff) {
                bestDiff = d;
                best = i;
            }
        }
        return best;
    }

    function indexToMax(idx) {
        var i = Math.max(0, Math.min(5, parseInt(idx, 10) || 0));
        return CAP_BY_INDEX[i];
    }

    function updateCapLabel(idx) {
        var i = parseInt(idx, 10);
        if (i === 0) {
            capDisplay.textContent = '\u221e';
        } else if (i === 5) {
            capDisplay.textContent = '1000+';
        } else {
            capDisplay.textContent = String(CAP_BY_INDEX[i]);
        }
        var pct = (i / 5) * 100;
        capDisplay.style.left = pct + '%';
        var m = indexToMax(i);
        capSlider.setAttribute('aria-valuetext', m === 0 ? 'Unlimited' : 'Max ' + m + ' bookmarks');
    }

    function syncModeUi(incremental) {
        if (incremental) {
            modeFull.classList.remove('is-active');
            modeIncremental.classList.add('is-active');
            modeFull.setAttribute('aria-checked', 'false');
            modeIncremental.setAttribute('aria-checked', 'true');
        } else {
            modeFull.classList.add('is-active');
            modeIncremental.classList.remove('is-active');
            modeFull.setAttribute('aria-checked', 'true');
            modeIncremental.setAttribute('aria-checked', 'false');
        }
    }

    function isIncrementalMode() {
        return modeIncremental.classList.contains('is-active');
    }

    function refreshExportHistoryMeta() {
        chrome.storage.local.get(['lastExportAt', 'exportedTweetUrls'], function(data) {
            var n = (data.exportedTweetUrls || []).length;
            var last = data.lastExportAt;
            if (!last && n === 0) {
                statLastDisplay.textContent = '\u2014';
                statUrlsDisplay.textContent = '\u2014';
                historyCard.classList.add('is-empty');
            } else {
                historyCard.classList.remove('is-empty');
                statLastDisplay.textContent = last
                    ? new Date(last).toLocaleString(undefined, {
                        year: 'numeric',
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit'
                    })
                    : '\u2014';
                statUrlsDisplay.textContent = n > 0 ? (n + ' tweet URLs') : '\u2014';
            }
        });
    }

    function clearPriorExportError() {
        chrome.storage.local.remove(['lastExportError']);
        if (priorErrorBanner) {
            priorErrorBanner.hidden = true;
        }
    }

    function showPriorExportErrorIfAny() {
        chrome.storage.local.get(['lastExportError'], function(data) {
            var info = data.lastExportError;
            if (info && info.stage && priorErrorBanner && priorErrorText) {
                priorErrorText.textContent = 'Previous export failed (' + info.stage + '): ' + (info.message || 'Unknown error');
                priorErrorBanner.hidden = false;
            }
        });
    }

    if (dismissPriorErrorBtn) {
        dismissPriorErrorBtn.addEventListener('click', clearPriorExportError);
    }

    showPriorExportErrorIfAny();

    chrome.storage.local.get(['prefMaxBookmarks', 'prefIncrementalOnly'], function(prefs) {
        var idx = maxToSliderIndex(prefs.prefMaxBookmarks);
        capSlider.value = String(idx);
        updateCapLabel(idx);
        syncModeUi(!!prefs.prefIncrementalOnly);
    });

    capSlider.addEventListener('input', function() {
        updateCapLabel(capSlider.value);
    });

    capSlider.addEventListener('change', function() {
        chrome.storage.local.set({prefMaxBookmarks: indexToMax(capSlider.value)});
    });

    modeFull.addEventListener('click', function() {
        syncModeUi(false);
        chrome.storage.local.set({prefIncrementalOnly: false});
    });

    modeIncremental.addEventListener('click', function() {
        syncModeUi(true);
        chrome.storage.local.set({prefIncrementalOnly: true});
    });

    clearHistoryBtn.addEventListener('click', function() {
        chrome.storage.local.remove(['lastExportAt', 'exportedTweetUrls'], function() {
            refreshExportHistoryMeta();
        });
    });

    refreshExportHistoryMeta();

    chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
        var currentTab = tabs[0];
        var isBookmarkPage = currentTab.url.includes('x.com/i/bookmarks') ||
            currentTab.url.includes('twitter.com/i/bookmarks');

        if (isBookmarkPage) {
            updateStatus('success', 'Ready to export.');
            exportBtn.disabled = false;
            openBookmarksBtn.hidden = true;
        } else {
            updateStatus('warning', 'Open x.com/i/bookmarks');
            exportBtn.disabled = true;
            openBookmarksBtn.hidden = false;
        }
    });

    openBookmarksBtn.addEventListener('click', function() {
        chrome.tabs.create({url: 'https://x.com/i/bookmarks'});
    });

    function startExport() {
        isExporting = true;
        cancelRequested = false;
        exportBtn.disabled = true;
        if (cancelExportBtn) {
            cancelExportBtn.disabled = false;
        }
        updateStatus('processing', 'Connecting…');

        var maxVal = indexToMax(capSlider.value);
        var incrementalOnly = isIncrementalMode();

        chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
            var tabId = tabs[0].id;
            chrome.tabs.sendMessage(tabId, {action: 'ping'}, function(response) {
                if (chrome.runtime.lastError || !response || response.status !== 'ok') {
                    if (isReceivingEndMissingError(chrome.runtime.lastError)) {
                        showError('Could not connect to the page. Please keep the X/Twitter bookmarks page open, reload it, and try again.', 'receiving_end_missing', 'connection');
                    } else {
                        showError('Failed to connect. Reload the page and try again.', 'connection_failed', 'connect');
                    }
                    return;
                }

                if (cancelRequested) {
                    finishCanceled();
                    return;
                }

                updateStatus('processing', 'Working…');

                chrome.storage.local.get(['exportedTweetUrls'], function(data) {
                    var knownTweetUrls = (data.exportedTweetUrls || [])
                        .map(normalizeTweetUrl)
                        .filter(Boolean);

                    chrome.tabs.sendMessage(tabId, {
                        action: 'exportBookmarks',
                        maxBookmarks: maxVal,
                        incrementalOnly: incrementalOnly,
                        knownTweetUrls: incrementalOnly ? knownTweetUrls : []
                    }, function(response) {
                        if (chrome.runtime.lastError) {
                            if (isReceivingEndMissingError(chrome.runtime.lastError)) {
                                showError('Could not connect to the page. Please keep the X/Twitter bookmarks page open, reload it, and try again.', 'receiving_end_missing', 'connection');
                            } else {
                                showError('An error occurred: ' + chrome.runtime.lastError.message, 'runtime_error', 'extract');
                            }
                            return;
                        }

                        if (cancelRequested) {
                            finishCanceled();
                            return;
                        }

                        if (response && response.success) {
                            handleExportSuccess(response.data, {incrementalOnly: incrementalOnly, cap: maxVal}).catch(function(err) {
                                showError(err && err.message ? err.message : 'Export failed.', 'unexpected_failed', (err && err.stage) || 'unknown');
                            });
                        } else {
                            showError(response ? response.error : 'An unknown error occurred', 'scrape_failed', 'extract');
                        }
                    });
                });
            });
        });
    }

    exportBtn.addEventListener('click', startExport);
    if (retryExportBtn) {
        retryExportBtn.addEventListener('click', startExport);
    }
    if (cancelExportBtn) {
        cancelExportBtn.addEventListener('click', function() {
            if (!isExporting || cancelRequested) {
                return;
            }
            cancelRequested = true;
            cancelExportBtn.disabled = true;
            updateStatus('processing', 'Canceling…');
        });
    }

    function finishCanceled() {
        isExporting = false;
        cancelRequested = false;
        exportBtn.disabled = false;
        updateStatus('warning', 'Export canceled.');
        if (self.xbmAnalytics) {
            self.xbmAnalytics.sendEvent('export_canceled', {});
        }
    }

    function updateStatus(type, text) {
        statusText.textContent = text;
        status.className = 'status-strip status-' + type;
        statusIcon.className = 'status-glyph glyph-' + type;
        if (retryExportBtn && type !== 'error') {
            retryExportBtn.hidden = true;
        }
        if (keepOpenNotice) {
            keepOpenNotice.hidden = type !== 'processing';
        }
        if (cancelExportBtn) {
            cancelExportBtn.hidden = type !== 'processing';
        }
    }

    function persistExportHistory(bookmarks, incrementalOnly) {
        var newUrls = bookmarks.map(function(b) {
            return normalizeTweetUrl(b.url);
        }).filter(Boolean);

        chrome.storage.local.get(['exportedTweetUrls'], function(data) {
            var prev = (data.exportedTweetUrls || [])
                .map(normalizeTweetUrl)
                .filter(Boolean);
            var merged;
            if (incrementalOnly) {
                merged = Array.from(new Set(prev.concat(newUrls)));
            } else {
                merged = Array.from(new Set(newUrls));
            }
            if (merged.length > MAX_STORED_URLS) {
                merged = merged.slice(merged.length - MAX_STORED_URLS);
            }
            chrome.storage.local.set({
                lastExportAt: new Date().toISOString(),
                exportedTweetUrls: merged
            }, function() {
                refreshExportHistoryMeta();
            });
        });
    }

    async function handleExportSuccess(bookmarks, meta) {
        var incrementalOnly = meta && meta.incrementalOnly;

        if (cancelRequested) {
            finishCanceled();
            return;
        }

        if (!bookmarks || bookmarks.length === 0) {
            isExporting = false;
            exportBtn.disabled = false;
            if (incrementalOnly) {
                updateStatus('warning', 'Nothing new to export.');
                if (self.xbmAnalytics) {
                    self.xbmAnalytics.sendEvent('export_completed', {
                        mode: 'incremental',
                        count: 0,
                        cap: meta && meta.cap ? String(meta.cap) : 'unlimited'
                    });
                }
            } else {
                updateStatus('warning', 'No bookmarks found. Please reload the page and try again.');
                if (self.xbmAnalytics) {
                    self.xbmAnalytics.sendEvent('export_empty', {
                        mode: 'full',
                        cap: meta && meta.cap ? String(meta.cap) : 'unlimited'
                    });
                }
            }
            return;
        }

        persistExportHistory(bookmarks, !!incrementalOnly);

        updateStatus('processing', 'Saving…');

        var markdownFiles;
        try {
            markdownFiles = generateIndividualMarkdownFiles(bookmarks);
        } catch (err) {
            showError(err && err.message ? err.message : 'Failed to convert bookmarks to Markdown.', 'convert_failed', 'convert');
            return;
        }

        if (cancelRequested) {
            finishCanceled();
            return;
        }

        try {
            await createAndDownloadZip(markdownFiles, !!incrementalOnly);
        } catch (err) {
            if (err && err.exportCanceled) {
                finishCanceled();
                return;
            }
            if (err && err.userCanceled) {
                isExporting = false;
                exportBtn.disabled = false;
                updateStatus('warning', 'Save canceled.');
                return;
            }
            var stage = (err && err.stage) || 'zip';
            var reasonCode = (err && err.reasonCode) || 'zip_download_failed';
            showError(err && err.message ? err.message : 'Failed to create or download ZIP.', reasonCode, stage);
            return;
        }

        isExporting = false;
        updateStatus('success', 'Exported ' + bookmarks.length + ' bookmarks.');
        exportBtn.disabled = false;
        clearPriorExportError();

        if (self.xbmAnalytics) {
            self.xbmAnalytics.sendEvent('export_completed', {
                mode: incrementalOnly ? 'incremental' : 'full',
                count: bookmarks.length,
                cap: meta && meta.cap ? String(meta.cap) : 'unlimited'
            });
        }
    }

    function generateIndividualMarkdownFiles(bookmarks) {
        var files = [];

        bookmarks.forEach(function(m, index) {
            var bookmark = m;
            var username = bookmark.username || 'unknown';
            var safeUsername = username.replace(/[^a-zA-Z0-9_-]/g, '_');
            var filename = 'Bookmark @' + safeUsername + '_' + String(index + 1).padStart(3, '0') + '.md';

            var markdown = '# ' + (bookmark.author || 'Unknown') + '\n\n';
            markdown += '**Author:** @' + (bookmark.username || 'unknown') + '\n';
            markdown += '**Date:** ' + (bookmark.date || 'Unknown') + '\n';
            markdown += '**URL:** ' + (bookmark.url || 'N/A') + '\n\n';
            markdown += '---\n\n';
            markdown += '## Content\n\n';
            markdown += (bookmark.text || 'No text') + '\n\n';

            if (bookmark.images && bookmark.images.length > 0) {
                markdown += '## Images (' + bookmark.images.length + ')\n\n';
                bookmark.images.forEach(function(img, i) {
                    markdown += '![' + 'Image ' + (i + 1) + '](' + img + ')\n\n';
                });
            }

            if (bookmark.links && bookmark.links.length > 0) {
                markdown += '## Links\n\n';
                bookmark.links.forEach(function(link) {
                    markdown += '- [' + (link.text || link.url) + '](' + link.url + ')\n';
                });
                markdown += '\n';
            }

            markdown += '---\n\n';
            markdown += '*Exported at: ' + new Date().toLocaleString('en-US') + '*\n';

            files.push({
                filename: filename,
                content: markdown
            });
        });

        return files;
    }

    function makeExportCanceledError() {
        var err = new Error('Export canceled.');
        err.exportCanceled = true;
        return err;
    }

    async function createAndDownloadZip(files, isIncremental) {
        if (cancelRequested) {
            throw makeExportCanceledError();
        }

        if (typeof JSZip === 'undefined') {
            try {
                await loadJSZip();
            } catch (err) {
                var loadErr = new Error(err && err.message ? err.message : 'Failed to load ZIP library.');
                loadErr.stage = 'zip';
                throw loadErr;
            }
        }

        var zip = new JSZip();

        files.forEach(function(file) {
            zip.file(file.filename, file.content);
        });

        var indexContent = generateIndexFile(files, isIncremental);
        zip.file('index.md', indexContent);

        var zipStartedAt = Date.now();
        var isSlowZip = false;

        var blob;
        try {
            blob = await zip.generateAsync({type: 'blob'}, function onUpdate() {
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

        if (cancelRequested) {
            throw makeExportCanceledError();
        }

        var objectUrl = URL.createObjectURL(blob);
        var datePart = new Date().toISOString().split('T')[0];
        var suffix = isIncremental ? '-incremental' : '';
        var filename = 'x-bookmarks-' + datePart + suffix + '.zip';

        return downloadWithRetry(objectUrl, filename).finally(function() {
            window.setTimeout(function() {
                URL.revokeObjectURL(objectUrl);
            }, 30000);
        });
    }

    function attemptDownload(objectUrl, filename) {
        return new Promise(function(resolve, reject) {
            chrome.downloads.download({
                url: objectUrl,
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

    function delay(ms) {
        return new Promise(function(resolve) {
            window.setTimeout(resolve, ms);
        });
    }

    function downloadWithRetry(objectUrl, filename) {
        var attempt = 0;
        function tryOnce() {
            return attemptDownload(objectUrl, filename).catch(function(err) {
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

    function loadJSZip() {
        return new Promise(function(resolve, reject) {
            var script = document.createElement('script');
            script.src = 'jszip.min.js';
            script.onload = resolve;
            script.onerror = reject;
            document.head.appendChild(script);
        });
    }

    function isReceivingEndMissingError(lastError) {
        return !!(lastError && lastError.message && lastError.message.indexOf('Receiving end does not exist') !== -1);
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

    function showError(message, reasonCode, stage) {
        isExporting = false;
        exportBtn.disabled = false;
        updateStatus('error', message);
        if (retryExportBtn) {
            retryExportBtn.hidden = false;
        }
        console.error('[X Bookmark to MD] Export failed at stage "' + (stage || 'unknown') + '":', message);
        chrome.storage.local.set({
            lastExportError: {
                stage: stage || 'unknown',
                reason: reasonCode || 'unknown',
                message: message,
                ts: Date.now()
            }
        });
        if (self.xbmAnalytics) {
            self.xbmAnalytics.sendEvent('export_error', {
                reason: reasonCode || 'unknown',
                stage: stage || 'unknown'
            });
        }
    }
});
