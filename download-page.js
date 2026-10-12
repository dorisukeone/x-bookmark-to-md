(function() {
    var statusEl = document.getElementById('status');
    var DOWNLOAD_WAIT_MS = 60000;
    var ZIP_GENERATION_SLOW_MS = 15000;

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
                reason: result.reason || '',
                reasonCode: result.reasonCode || ''
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

    var ZIP_FILE_ADD_CHUNK_SIZE = 50;

    function addFilesInChunks(zip, files) {
        var index = 0;

        function addNextChunk() {
            var end = Math.min(index + ZIP_FILE_ADD_CHUNK_SIZE, files.length);
            for (; index < end; index++) {
                var file = files[index];
                zip.file(file.filename, file.content);
            }
            if (index >= files.length) {
                return Promise.resolve(zip);
            }
            return new Promise(function(resolve) {
                window.setTimeout(resolve, 0);
            }).then(addNextChunk);
        }

        return addNextChunk();
    }

    function buildZipBlob(files) {
        if (typeof JSZip === 'undefined') {
            return Promise.reject(Object.assign(new Error('ZIP library failed to load.'), {
                reasonCode: 'zip_failed'
            }));
        }

        var zip = new JSZip();

        return addFilesInChunks(zip, files).then(function() {
            var zipStartedAt = Date.now();
            var isSlowZip = false;

            return zip.generateAsync({
                type: 'blob',
                compression: 'DEFLATE',
                compressionOptions: {level: 1}
            }, function onUpdate() {
                if (!isSlowZip && Date.now() - zipStartedAt > ZIP_GENERATION_SLOW_MS) {
                    isSlowZip = true;
                }
            }).catch(function(err) {
                throw Object.assign(new Error(err && err.message ? err.message : 'ZIP generation failed.'), {
                    reasonCode: isSlowZip ? 'zip_generation_large' : 'zip_failed'
                });
            });
        });
    }

    function startDownload(blob, filename) {
        var objectUrl = URL.createObjectURL(blob);

        return new Promise(function(resolve) {
            // No user gesture here, so saveAs:true hangs. Save to Downloads directly.
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

        var files = response.files || [];
        var filename = response.filename;
        if (!files.length || !filename) {
            setStatus('Export data missing.');
            reportResult({ok: false, message: 'Export data missing.'}).then(function() {
                window.setTimeout(function() {
                    window.close();
                }, 1500);
            });
            return;
        }

        setStatus('Creating ZIP…');
        buildZipBlob(files).then(function(blob) {
            // Guard against the previous bug where a non-binary payload became "[object Object]".
            if (!blob || blob.size < 4) {
                throw Object.assign(new Error('Generated ZIP is empty or invalid.'), {
                    reasonCode: 'zip_failed'
                });
            }
            setStatus('Starting download…');
            return startDownload(blob, filename);
        }).then(function(result) {
            if (result.ok) {
                setStatus('Saved to Downloads folder.');
                try {
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
        }).catch(function(err) {
            var message = err && err.message ? err.message : 'ZIP generation failed.';
            setStatus(message);
            return reportResult({
                ok: false,
                message: message,
                reasonCode: (err && err.reasonCode) || 'zip_failed'
            }).then(function() {
                window.setTimeout(function() {
                    window.close();
                }, 1800);
            });
        });
    });
})();
