document.addEventListener('DOMContentLoaded', function() {
    const MAX_STORED_URLS = 8000;
    /** Slider index → maxBookmarks for content script (0 = unlimited) */
    const CAP_BY_INDEX = [0, 50, 100, 200, 500, 1000];

    const exportBtn = document.getElementById('exportBtn');
    const openBookmarksBtn = document.getElementById('openBookmarksBtn');
    const status = document.getElementById('status');
    const statusIcon = document.getElementById('statusIcon');
    const statusText = document.getElementById('statusText');
    const capSlider = document.getElementById('capSlider');
    const capDisplay = document.getElementById('capDisplay');
    const modeFull = document.getElementById('modeFull');
    const modeIncremental = document.getElementById('modeIncremental');
    const historyCard = document.getElementById('historyCard');
    const statLastDisplay = document.getElementById('statLastDisplay');
    const statUrlsDisplay = document.getElementById('statUrlsDisplay');
    const clearHistoryBtn = document.getElementById('clearHistoryBtn');
    const extVersionEl = document.getElementById('extVersion');

    try {
        var ver = chrome.runtime.getManifest().version;
        extVersionEl.textContent = 'v' + ver;
    } catch (e) {
        extVersionEl.textContent = '';
    }

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

    exportBtn.addEventListener('click', function() {
        exportBtn.disabled = true;
        updateStatus('processing', 'Connecting…');

        var maxVal = indexToMax(capSlider.value);
        var incrementalOnly = isIncrementalMode();

        chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
            var tabId = tabs[0].id;
            chrome.tabs.sendMessage(tabId, {action: 'ping'}, function(response) {
                if (chrome.runtime.lastError || !response || response.status !== 'ok') {
                    showError('Failed to connect. Reload the page and try again.', 'connection_failed');
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
                            showError('An error occurred: ' + chrome.runtime.lastError.message, 'runtime_error');
                            return;
                        }

                        if (response && response.success) {
                            handleExportSuccess(response.data, {incrementalOnly: incrementalOnly, cap: maxVal}).catch(function(err) {
                                showError(err && err.message ? err.message : 'Export failed.', 'zip_failed');
                            });
                        } else {
                            showError(response ? response.error : 'An unknown error occurred', 'scrape_failed');
                        }
                    });
                });
            });
        });
    });

    function updateStatus(type, text) {
        statusText.textContent = text;
        status.className = 'status-strip status-' + type;
        statusIcon.className = 'status-glyph glyph-' + type;
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

        if (!bookmarks || bookmarks.length === 0) {
            exportBtn.disabled = false;
            if (incrementalOnly) {
                updateStatus('warning', 'Nothing new to export.');
            } else {
                updateStatus('warning', 'No bookmarks found.');
            }
            if (self.xbmAnalytics) {
                self.xbmAnalytics.sendEvent('export_completed', {
                    mode: incrementalOnly ? 'incremental' : 'full',
                    count: 0,
                    cap: meta && meta.cap ? String(meta.cap) : 'unlimited'
                });
            }
            return;
        }

        persistExportHistory(bookmarks, !!incrementalOnly);

        updateStatus('processing', 'Saving…');

        var markdownFiles = generateIndividualMarkdownFiles(bookmarks);

        try {
            await createAndDownloadZip(markdownFiles, !!incrementalOnly);
        } catch (err) {
            showError(err && err.message ? err.message : 'Failed to create or download ZIP.', 'zip_download_failed');
            return;
        }

        updateStatus('success', 'Exported ' + bookmarks.length + ' bookmarks.');
        exportBtn.disabled = false;

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

    async function createAndDownloadZip(files, isIncremental) {
        if (typeof JSZip === 'undefined') {
            await loadJSZip();
        }

        var zip = new JSZip();

        files.forEach(function(file) {
            zip.file(file.filename, file.content);
        });

        var indexContent = generateIndexFile(files, isIncremental);
        zip.file('index.md', indexContent);

        var blob;
        try {
            blob = await zip.generateAsync({type: 'blob'});
        } catch (err) {
            throw new Error(err && err.message ? err.message : 'ZIP generation failed.');
        }

        var objectUrl = URL.createObjectURL(blob);
        var datePart = new Date().toISOString().split('T')[0];
        var suffix = isIncremental ? '-incremental' : '';
        var filename = 'x-bookmarks-' + datePart + suffix + '.zip';

        return new Promise(function(resolve, reject) {
            chrome.downloads.download({
                url: objectUrl,
                filename: filename,
                saveAs: true
            }, function(downloadId) {
                window.setTimeout(function() {
                    URL.revokeObjectURL(objectUrl);
                }, 30000);

                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                    return;
                }
                if (downloadId === undefined) {
                    reject(new Error('Download did not start (no download id).'));
                    return;
                }
                resolve(downloadId);
            });
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

    function loadJSZip() {
        return new Promise(function(resolve, reject) {
            var script = document.createElement('script');
            script.src = 'jszip.min.js';
            script.onload = resolve;
            script.onerror = reject;
            document.head.appendChild(script);
        });
    }

    function showError(message, reasonCode) {
        exportBtn.disabled = false;
        updateStatus('error', message);
        if (self.xbmAnalytics) {
            self.xbmAnalytics.sendEvent('export_error', {
                reason: reasonCode || 'unknown'
            });
        }
    }
});
