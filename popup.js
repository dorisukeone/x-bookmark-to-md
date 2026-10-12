document.addEventListener('DOMContentLoaded', function() {
    /** Slider index → maxBookmarks for content script (0 = unlimited) */
    const CAP_BY_INDEX = [0, 50, 100, 200, 500, 1000];
    const MAX_STORED_URLS = 8000;
    /** Max wait for chrome.tabs.sendMessage callback before treating the export as timed out */
    const SEND_MESSAGE_TIMEOUT_MS = 10000;

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
    var awaitingBackgroundExport = false;
    var pendingExportMeta = null;
    var currentTabId = null;

    try {
        var ver = chrome.runtime.getManifest().version;
        extVersionEl.textContent = 'v' + ver;
    } catch (e) {
        extVersionEl.textContent = '';
    }

    window.addEventListener('pagehide', function() {
        // Only count popup_closed while the popup itself still owns the in-progress work
        // (extract/convert). After ZIP handoff, background continues independently.
        if (isExporting && !awaitingBackgroundExport && self.xbmAnalytics) {
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
    restoreBackgroundExportJobIfAny();

    chrome.storage.onChanged.addListener(function(changes, area) {
        if (area !== 'local' || !changes.exportJob) {
            return;
        }
        applyExportJobState(changes.exportJob.newValue);
    });

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

        runExportFlow(maxVal, incrementalOnly).catch(function(err) {
            showError(err && err.message ? err.message : 'Export failed.', 'unexpected_failed', (err && err.stage) || 'unknown');
        });
    }

    async function runExportFlow(maxVal, incrementalOnly) {
        var tabs = await queryTabs({active: true, currentWindow: true});
        var tabId = tabs[0].id;
        currentTabId = tabId;

        var pingResponse;
        try {
            pingResponse = await sendTabMessage(tabId, {action: 'ping'});
        } catch (err) {
            handleSendMessageError(err, 'connect');
            return;
        }

        if (!pingResponse || pingResponse.status !== 'ok') {
            showError('Failed to connect. Reload the page and try again.', 'connection_failed', 'connect');
            return;
        }

        if (cancelRequested) {
            finishCanceled();
            return;
        }

        updateStatus('processing', 'Working…');

        var data = await storageGet(['exportedTweetUrls']);
        var knownTweetUrls = (data.exportedTweetUrls || [])
            .map(normalizeTweetUrl)
            .filter(Boolean);

        var response;
        try {
            // Extraction can take many minutes while scrolling; do not use the short ping timeout.
            // Still classify 'message port closed' via lastError when the channel drops.
            response = await sendTabMessage(tabId, {
                action: 'exportBookmarks',
                maxBookmarks: maxVal,
                incrementalOnly: incrementalOnly,
                knownTweetUrls: incrementalOnly ? knownTweetUrls : []
            }, 0);
        } catch (err) {
            handleSendMessageError(err, 'extract');
            return;
        }

        if (cancelRequested || (response && response.canceled)) {
            finishCanceled();
            return;
        }

        if (response && response.success) {
            await handleExportSuccess(response.data, {incrementalOnly: incrementalOnly, cap: maxVal});
        } else {
            showError(response ? response.error : 'An unknown error occurred', 'scrape_failed', 'extract');
        }
    }

    function queryTabs(queryInfo) {
        return new Promise(function(resolve) {
            chrome.tabs.query(queryInfo, resolve);
        });
    }

    function storageGet(keys) {
        return new Promise(function(resolve) {
            chrome.storage.local.get(keys, resolve);
        });
    }

    function sendTabMessage(tabId, message, timeoutMs) {
        var waitMs = timeoutMs == null ? SEND_MESSAGE_TIMEOUT_MS : timeoutMs;
        return new Promise(function(resolve, reject) {
            var settled = false;
            var timer = null;
            if (waitMs > 0) {
                timer = window.setTimeout(function() {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    var err = new Error('The page did not respond in time. Reload the page and try again.');
                    err.stage = 'message_timeout';
                    err.reasonCode = 'message_timeout';
                    reject(err);
                }, waitMs);
            }

            chrome.tabs.sendMessage(tabId, message, function(response) {
                if (settled) {
                    return;
                }
                settled = true;
                if (timer !== null) {
                    window.clearTimeout(timer);
                }

                if (chrome.runtime.lastError) {
                    var sendErr = new Error(chrome.runtime.lastError.message);
                    if (isReceivingEndMissingError(chrome.runtime.lastError)) {
                        sendErr.stage = 'connection';
                        sendErr.reasonCode = 'receiving_end_missing';
                    } else if (isMessagePortClosedError(chrome.runtime.lastError)) {
                        sendErr.stage = 'message_timeout';
                        sendErr.reasonCode = 'message_port_closed';
                        sendErr.message = 'Connection to the page was lost. Reload the page and try again.';
                    } else {
                        sendErr.reasonCode = 'runtime_error';
                    }
                    reject(sendErr);
                    return;
                }

                resolve(response);
            });
        });
    }

    function handleSendMessageError(err, defaultStage) {
        if (err && err.stage === 'message_timeout') {
            showError(err.message, err.reasonCode || 'message_timeout', 'message_timeout');
            return;
        }
        if (err && (err.stage === 'connection' || err.reasonCode === 'receiving_end_missing')) {
            showError('Could not connect to the page. Please keep the X/Twitter bookmarks page open, reload it, and try again.', 'receiving_end_missing', 'connection');
            return;
        }
        if (defaultStage === 'connect') {
            showError('Failed to connect. Reload the page and try again.', 'connection_failed', 'connect');
        } else {
            showError('An error occurred: ' + (err && err.message ? err.message : 'Unknown error'), 'runtime_error', 'extract');
        }
    }

    exportBtn.addEventListener('click', startExport);
    if (retryExportBtn) {
        retryExportBtn.addEventListener('click', startExport);
    }
    if (cancelExportBtn) {
        cancelExportBtn.addEventListener('click', function() {
            if ((!isExporting && !awaitingBackgroundExport) || cancelRequested) {
                return;
            }
            cancelRequested = true;
            cancelExportBtn.disabled = true;
            updateStatus('processing', 'Canceling…');
            if (awaitingBackgroundExport) {
                chrome.runtime.sendMessage({action: 'cancelExportJob'}, function() {
                    void chrome.runtime.lastError;
                });
            } else if (currentTabId != null) {
                chrome.tabs.sendMessage(currentTabId, {action: 'cancelExportBookmarks'}, function() {
                    void chrome.runtime.lastError;
                });
            }
        });
    }

    function finishCanceled() {
        isExporting = false;
        awaitingBackgroundExport = false;
        pendingExportMeta = null;
        cancelRequested = false;
        currentTabId = null;
        exportBtn.disabled = false;
        updateStatus('warning', 'Export canceled.');
        if (self.xbmAnalytics) {
            self.xbmAnalytics.sendEvent('export_canceled', {});
        }
    }

    function restoreBackgroundExportJobIfAny() {
        chrome.storage.local.get(['exportJob'], function(data) {
            applyExportJobState(data.exportJob);
        });
    }

    function applyExportJobState(job) {
        if (!job || !job.status) {
            return;
        }

        if (job.status === 'running') {
            awaitingBackgroundExport = true;
            isExporting = false;
            exportBtn.disabled = true;
            if (cancelExportBtn) {
                cancelExportBtn.disabled = false;
            }
            updateStatus('processing', job.message || 'Saving in background…');
            return;
        }

        if (!awaitingBackgroundExport && job.ts && Date.now() - job.ts > 60000) {
            // Stale terminal job from a previous session — ignore for UI.
            return;
        }

        var shouldReportCompletion = awaitingBackgroundExport && !!pendingExportMeta;
        awaitingBackgroundExport = false;
        isExporting = false;
        exportBtn.disabled = false;
        cancelRequested = false;

        if (job.status === 'success') {
            updateStatus('success', job.message || 'Export complete.');
            clearPriorExportError();
            if (shouldReportCompletion && self.xbmAnalytics) {
                self.xbmAnalytics.sendEvent('export_completed', {
                    mode: pendingExportMeta.incrementalOnly ? 'incremental' : 'full',
                    count: job.count || 0,
                    cap: pendingExportMeta.cap ? String(pendingExportMeta.cap) : 'unlimited'
                });
            }
            pendingExportMeta = null;
            return;
        }

        if (job.status === 'canceled') {
            updateStatus('warning', job.message || 'Export canceled.');
            pendingExportMeta = null;
            return;
        }

        if (job.status === 'error') {
            updateStatus('error', job.message || 'Export failed.');
            if (retryExportBtn) {
                retryExportBtn.hidden = false;
            }
            pendingExportMeta = null;
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
            keepOpenNotice.hidden = type !== 'processing' || awaitingBackgroundExport;
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
            currentTabId = null;
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

        updateStatus('processing', 'Preparing files…');

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

        pendingExportMeta = {
            incrementalOnly: !!incrementalOnly,
            cap: meta && meta.cap
        };

        try {
            await handoffZipToBackground(markdownFiles, !!incrementalOnly);
        } catch (err) {
            pendingExportMeta = null;
            awaitingBackgroundExport = false;
            showError(err && err.message ? err.message : 'Failed to start background ZIP export.', 'zip_handoff_failed', 'zip');
            return;
        }
    }

    function handoffZipToBackground(files, isIncremental) {
        return new Promise(function(resolve, reject) {
            chrome.runtime.sendMessage({
                action: 'createAndDownloadZip',
                files: files,
                isIncremental: isIncremental
            }, function(response) {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                    return;
                }
                if (!response || !response.accepted) {
                    reject(new Error((response && response.error) || 'Background worker rejected the export.'));
                    return;
                }
                // Popup no longer owns the long-running work; background continues if popup closes.
                isExporting = false;
                currentTabId = null;
                awaitingBackgroundExport = true;
                cancelRequested = false;
                updateStatus('processing', 'Saving in background…');
                resolve();
            });
        });
    }

    function generateIndividualMarkdownFiles(bookmarks) {
        var files = [];

        bookmarks.forEach(function(m, index) {
            var bookmark = m;
            var username = bookmark.username || 'unknown';
            var safeUsername = username.replace(/[^a-zA-Z0-9_-]/g, '_');
            var filename = 'Bookmark @' + safeUsername + '_' + String(index + 1).padStart(3, '0') + '.md';

            var author = sanitizeExportText(bookmark.author || 'Unknown');
            var displayUsername = sanitizeExportText(bookmark.username || 'unknown');
            var date = sanitizeExportText(bookmark.date || 'Unknown');
            var url = sanitizeExportText(bookmark.url || 'N/A');
            var text = sanitizeExportText(bookmark.text || 'No text');

            var markdown = '# ' + author + '\n\n';
            markdown += '**Author:** @' + displayUsername + '\n';
            markdown += '**Date:** ' + date + '\n';
            markdown += '**URL:** ' + url + '\n\n';
            markdown += '---\n\n';
            markdown += '## Content\n\n';
            markdown += text + '\n\n';

            if (bookmark.images && bookmark.images.length > 0) {
                markdown += '## Images (' + bookmark.images.length + ')\n\n';
                bookmark.images.forEach(function(img, i) {
                    markdown += '![' + 'Image ' + (i + 1) + '](' + sanitizeExportText(img) + ')\n\n';
                });
            }

            if (bookmark.links && bookmark.links.length > 0) {
                markdown += '## Links\n\n';
                bookmark.links.forEach(function(link) {
                    markdown += '- [' + sanitizeExportText(link.text || link.url) + '](' + sanitizeExportText(link.url) + ')\n';
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

    function isReceivingEndMissingError(lastError) {
        return !!(lastError && lastError.message && lastError.message.indexOf('Receiving end does not exist') !== -1);
    }

    function isMessagePortClosedError(lastError) {
        return !!(lastError && lastError.message && lastError.message.toLowerCase().indexOf('message port closed') !== -1);
    }

    function showError(message, reasonCode, stage) {
        isExporting = false;
        awaitingBackgroundExport = false;
        pendingExportMeta = null;
        currentTabId = null;
        exportBtn.disabled = false;
        updateStatus('error', message);
        if (retryExportBtn) {
            retryExportBtn.hidden = false;
        }
        console.error('[X Bookmark to MD] Export failed at stage "' + (stage || 'unknown') + '":', message);
        var LAST_EXPORT_ERROR_MESSAGE_MAX_LENGTH = 500;
        var storedMessage = typeof message === 'string' && message.length > LAST_EXPORT_ERROR_MESSAGE_MAX_LENGTH
            ? message.slice(0, LAST_EXPORT_ERROR_MESSAGE_MAX_LENGTH)
            : message;
        try {
            chrome.storage.local.set({
                lastExportError: {
                    stage: stage || 'unknown',
                    reason: reasonCode || 'unknown',
                    message: storedMessage,
                    ts: Date.now()
                }
            }, function() {
                if (chrome.runtime.lastError) {
                    console.warn('[X Bookmark to MD] Failed to save lastExportError:', chrome.runtime.lastError);
                }
            });
        } catch (storageError) {
            console.warn('[X Bookmark to MD] Failed to save lastExportError:', storageError);
        }
        if (self.xbmAnalytics) {
            self.xbmAnalytics.sendEvent('export_error', {
                reason: reasonCode || 'unknown',
                stage: stage || 'unknown'
            });
        }
    }
});
