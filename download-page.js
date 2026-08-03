(function() {
    var statusEl = document.getElementById('status');

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

    function waitForDownloadTerminal(downloadId) {
        return new Promise(function(resolve) {
            function finish(result) {
                chrome.downloads.onChanged.removeListener(onChanged);
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
        });
    }

    function startDownload(buffer, filename) {
        var blob = new Blob([buffer], {type: 'application/zip'});
        var objectUrl = URL.createObjectURL(blob);

        return new Promise(function(resolve) {
            chrome.downloads.download({
                url: objectUrl,
                filename: filename,
                conflictAction: 'uniquify',
                saveAs: true
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

                setStatus('Waiting for save dialog…');
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
            setStatus(result.ok ? 'Download complete.' : (result.message || 'Download failed.'));
            return reportResult(result).then(function() {
                window.setTimeout(function() {
                    window.close();
                }, result.ok ? 400 : 1500);
            });
        });
    });
})();
