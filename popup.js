document.addEventListener('DOMContentLoaded', function() {
    const MAX_STORED_URLS = 8000;

    const exportBtn = document.getElementById('exportBtn');
    const openBookmarksBtn = document.getElementById('openBookmarksBtn');
    const status = document.getElementById('status');
    const statusIcon = document.getElementById('statusIcon');
    const statusText = document.getElementById('statusText');
    const progress = document.getElementById('progress');
    const progressFill = document.getElementById('progressFill');
    const progressText = document.getElementById('progressText');
    const maxBookmarksInput = document.getElementById('maxBookmarksInput');
    const incrementalOnlyEl = document.getElementById('incrementalOnly');
    const historyVisual = document.getElementById('historyVisual');
    const statUrlNum = document.getElementById('statUrlNum');
    const statLastNum = document.getElementById('statLastNum');
    const statLastWrap = document.getElementById('statLastWrap');
    const clearHistoryBtn = document.getElementById('clearHistoryBtn');

    function refreshExportHistoryMeta() {
        chrome.storage.local.get(['lastExportAt', 'exportedTweetUrls'], function(data) {
            const n = (data.exportedTweetUrls || []).length;
            const last = data.lastExportAt;
            statUrlNum.textContent = n > 0 ? String(n) : '—';
            if (!last && n === 0) {
                statLastNum.textContent = '—';
                statLastWrap.title = '';
                historyVisual.classList.add('history-empty');
            } else {
                historyVisual.classList.remove('history-empty');
                statLastNum.textContent = last
                    ? new Date(last).toLocaleDateString(undefined, {month: 'short', day: 'numeric'})
                    : '—';
                statLastWrap.title = last
                    ? new Date(last).toLocaleString(undefined, {dateStyle: 'medium', timeStyle: 'short'})
                    : '';
            }
        });
    }

    chrome.storage.local.get(['prefMaxBookmarks', 'prefIncrementalOnly'], function(prefs) {
        if (prefs.prefMaxBookmarks != null) {
            maxBookmarksInput.value = String(Math.max(0, prefs.prefMaxBookmarks));
        }
        if (typeof prefs.prefIncrementalOnly === 'boolean') {
            incrementalOnlyEl.checked = prefs.prefIncrementalOnly;
        }
    });

    maxBookmarksInput.addEventListener('change', function() {
        const v = Math.max(0, parseInt(maxBookmarksInput.value, 10) || 0);
        maxBookmarksInput.value = String(v);
        chrome.storage.local.set({ prefMaxBookmarks: v });
    });

    incrementalOnlyEl.addEventListener('change', function() {
        chrome.storage.local.set({ prefIncrementalOnly: incrementalOnlyEl.checked });
    });

    clearHistoryBtn.addEventListener('click', function() {
        chrome.storage.local.remove(['lastExportAt', 'exportedTweetUrls'], function() {
            refreshExportHistoryMeta();
        });
    });

    refreshExportHistoryMeta();

    chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
        const currentTab = tabs[0];
        const isBookmarkPage = currentTab.url.includes('x.com/i/bookmarks') ||
            currentTab.url.includes('twitter.com/i/bookmarks');

        if (isBookmarkPage) {
            updateStatus('success', 'Ready');
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
        progress.hidden = false;
        updateStatus('processing', 'Connecting…');
        progressText.textContent = '…';

        const maxVal = Math.max(0, parseInt(maxBookmarksInput.value, 10) || 0);
        const incrementalOnly = incrementalOnlyEl.checked;

        chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
            const tabId = tabs[0].id;
            chrome.tabs.sendMessage(tabId, {action: 'ping'}, function(response) {
                if (chrome.runtime.lastError || !response || response.status !== 'ok') {
                    showError('Failed to connect. Please reload the page and try again.');
                    return;
                }

                progressText.textContent = 'Fetching…';
                updateStatus('processing', 'Working…');

                chrome.storage.local.get(['exportedTweetUrls'], function(data) {
                    const knownTweetUrls = (data.exportedTweetUrls || [])
                        .map(normalizeTweetUrl)
                        .filter(Boolean);

                    chrome.tabs.sendMessage(tabId, {
                        action: 'exportBookmarks',
                        maxBookmarks: maxVal,
                        incrementalOnly: incrementalOnly,
                        knownTweetUrls: incrementalOnly ? knownTweetUrls : []
                    }, function(response) {
                        if (chrome.runtime.lastError) {
                            showError('An error occurred: ' + chrome.runtime.lastError.message);
                            return;
                        }

                        if (response && response.success) {
                            handleExportSuccess(response.data, {incrementalOnly: incrementalOnly}).catch(function(err) {
                                showError(err && err.message ? err.message : 'Export failed.');
                            });
                        } else {
                            showError(response ? response.error : 'An unknown error occurred');
                        }
                    });
                });
            });
        });
    });

    function updateStatus(type, text) {
        statusText.textContent = text;
        status.className = 'status-card status-' + type;
        statusIcon.className = 'status-glyph glyph-' + type;
    }

    function persistExportHistory(bookmarks, incrementalOnly) {
        const newUrls = bookmarks.map(function(b) {
            return normalizeTweetUrl(b.url);
        }).filter(Boolean);

        chrome.storage.local.get(['exportedTweetUrls'], function(data) {
            const prev = (data.exportedTweetUrls || [])
                .map(normalizeTweetUrl)
                .filter(Boolean);
            let merged;
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
        const incrementalOnly = meta && meta.incrementalOnly;

        if (!bookmarks || bookmarks.length === 0) {
            progress.hidden = true;
            exportBtn.disabled = false;
            if (incrementalOnly) {
                updateStatus('warning', 'Nothing new');
            } else {
                updateStatus('warning', 'No bookmarks found');
            }
            return;
        }

        persistExportHistory(bookmarks, !!incrementalOnly);

        progressText.textContent = 'Building files…';
        updateProgress(50);

        const markdownFiles = generateIndividualMarkdownFiles(bookmarks);

        progressText.textContent = 'ZIP…';
        updateProgress(80);

        try {
            await createAndDownloadZip(markdownFiles, !!incrementalOnly);
        } catch (err) {
            showError(err && err.message ? err.message : 'Failed to create or download ZIP.');
            return;
        }

        progressText.textContent = 'Done';
        updateProgress(100);
        updateStatus('success', 'Saved · ' + bookmarks.length + ' items');

        setTimeout(function() {
            progress.hidden = true;
            exportBtn.disabled = false;
        }, 2000);
    }

    function generateIndividualMarkdownFiles(bookmarks) {
        const files = [];

        bookmarks.forEach(function(bookmark, index) {
            const username = bookmark.username || 'unknown';
            const safeUsername = username.replace(/[^a-zA-Z0-9_-]/g, '_');
            const filename = 'Bookmark @' + safeUsername + '_' + String(index + 1).padStart(3, '0') + '.md';

            let markdown = '# ' + (bookmark.author || 'Unknown') + '\n\n';
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

        const zip = new JSZip();

        files.forEach(function(file) {
            zip.file(file.filename, file.content);
        });

        const indexContent = generateIndexFile(files, isIncremental);
        zip.file('index.md', indexContent);

        let blob;
        try {
            blob = await zip.generateAsync({type: 'blob'});
        } catch (err) {
            throw new Error(err && err.message ? err.message : 'ZIP generation failed.');
        }

        const objectUrl = URL.createObjectURL(blob);
        const datePart = new Date().toISOString().split('T')[0];
        const suffix = isIncremental ? '-incremental' : '';
        const filename = 'x-bookmarks-' + datePart + suffix + '.zip';

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
        let index = '# X Bookmark Export\n\n';
        if (isIncremental) {
            index += '*Incremental export (new items vs. local history)*\n\n';
        }
        index += 'Exported at: ' + new Date().toLocaleString('en-US') + '\n';
        index += 'Total: ' + files.length + ' bookmarks\n\n';
        index += '## File List\n\n';

        files.forEach(function(file, i) {
            const m = file.filename.match(/@([^_]+)/);
            const username = m ? m[1] : 'unknown';
            index += (i + 1) + '. [' + file.filename + '](./' + file.filename + ') - @' + username + '\n';
        });

        return index;
    }

    function loadJSZip() {
        return new Promise(function(resolve, reject) {
            const script = document.createElement('script');
            script.src = 'jszip.min.js';
            script.onload = resolve;
            script.onerror = reject;
            document.head.appendChild(script);
        });
    }

    function updateProgress(percent) {
        progressFill.style.width = percent + '%';
    }

    function showError(message) {
        progress.hidden = true;
        exportBtn.disabled = false;
        updateStatus('error', message);
    }
});
