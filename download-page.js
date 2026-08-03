(function() {
    var statusEl = document.getElementById('status');
    var DOWNLOAD_WAIT_MS = 60000;

    function setStatus(text) {
        if (statusEl) {
            statusEl.textContent = text;
        }
    }

    function reportResult(result) {
        return new Promise(function(resolve) {
            chrome.runtime.sendMessage({
                action: 'pendingDownloadResult',
                ok: !!result.ok,
                downloadId: result.downloadId,
                userCanceled: !!result.userCanceled,
                message: result.message || '',
                reason: result.reason || ''
            }, function() {
                void chrome.runtime.lastError;
                resolve();
            });
        });
    }

    function terminalFromItem(item) {
        if (!item) {
            return null;
        }
        if (item.state === 'complete') {
            return {ok: true, downloadId: item.id};
        }
        if (item.state === 'interrupted') {
            var reason = item.error || 'unknown';
            return {
                ok: false,
                downloadId: item.id,
                userCanceled: reason === 'USER_CANCELED',
                reason: reason,
                message: reason === 'USER_CANCELED'
                    ? 'Save canceled.'
                    : ('Download interrupted: ' + reason)
            };
        }
        return null;
    }

    function waitForDownloadTerminal(downloadId) {
        return new Promise(function(resolve) {
            var settled = false;

            function finish(result) {
                if (settled) {
                    return;
                }
                settled = true;
                chrome.downloads.onChanged.removeListener(onChanged);
                window.clearTimeout(timer);
                resolve(result);
            }

            function onChanged(delta) {
                if (delta.id !== downloadId || !delta.state) {
                    return;
                }
                var state = delta.state.current;
                if (state === 'complete') {
                    finish({ok: true, downloadId: downloadId});
                    return;
                }
                if (state === 'interrupted') {
                    var reason = delta.error && delta.error.current ? delta.error.current : 'unknown';
                    finish({
                        ok: false,
                        downloadId: downloadId,
                        userCanceled: reason === 'USER_CANCELED',
                        reason: reason,
                        message: reason === 'USER_CANCELED'
                            ? 'Save canceled.'
                            : ('Download interrupted: ' + reason)
                    });
                }
            }

            chrome.downloads.onChanged.addListener(onChanged);

            // State may already be terminal before the listener was attached.
            chrome.downloads.search({id: downloadId}, function(results) {
                if (chrome.runtime.lastError || settled) {
                    return;
                }
                var terminal = terminalFromItem(results && results[0]);
                if (terminal) {
                    finish(terminal);
                }
            });

            var timer = window.setTimeout(function() {
                finish({
                    ok: false,
                    downloadId: downloadId,
                    message: 'Download timed out. Check the browser Downloads folder.'
                });
            }, DOWNLOAD_WAIT_MS);
        });
    }

    function startDownload(buffer, filename) {
        var blob = new Blob([buffer], {type: 'application/zip'});
        var objectUrl = URL.createObjectURL(blob);

        return new Promise(function(resolve) {
            // saveAs:true needs a user gesture; this page is opened by the extension
            // so the Save As dialog never appears and the download hangs. Save directly
            // into the default Downloads folder instead (uniquify on name clash).
            chrome.downloads.download({
                url: objectUrl,
                filename: filename,
                conflictAction: 'uniquify',
                saveAs: false
            }, function(downloadId) {
                if (chrome.runtime.lastError) {
                    URL.revokeObjectURL(objectUrl);
                    var message = chrome.runtime.lastError.message || 'Download failed.';
                    resolve({
                        ok: false,
                        userCanceled: message.indexOf('USER_CANCELED') !== -1,
                        message: message
                    });
                    return;
                }
                if (downloadId === undefined) {
                    URL.revokeObjectURL(objectUrl);
                    resolve({
                        ok: false,
                        message: 'Download did not start (no download id).'
                    });
                    return;
                }

                setStatus('Saving to Downloads…');
                waitForDownloadTerminal(downloadId).then(function(result) {
                    URL.revokeObjectURL(objectUrl);
                    resolve(result);
                });
            });
        });
    }

    setStatus('Preparing download…');
    chrome.runtime.sendMessage({action: 'claimPendingDownload'}, function(response) {
        if (chrome.runtime.lastError || !response || !response.ok) {
            setStatus('No pending download.');
            window.setTimeout(function() {
                window.close();
            }, 1200);
            return;
        }

        setStatus('Starting download…');
        startDownload(response.buffer, response.filename).then(function(result) {
            if (result.ok) {
                setStatus('Saved to Downloads folder.');
                try {
                    // Reveal the file in the system Downloads UI so success is obvious.
                    chrome.downloads.show(result.downloadId);
                } catch (e) {
                    // ignore
                }
            } else {
                setStatus(result.message || 'Download failed.');
            }
            return reportResult(result).then(function() {
                window.setTimeout(function() {
                    window.close();
                }, result.ok ? 800 : 1800);
            });
        });
    });
})();
