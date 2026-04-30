document.addEventListener('DOMContentLoaded', function() {
    const exportBtn = document.getElementById('exportBtn');
    const openBookmarksBtn = document.getElementById('openBookmarksBtn');
    const status = document.getElementById('status');
    const statusIcon = document.getElementById('statusIcon');
    const statusText = document.getElementById('statusText');
    const progress = document.getElementById('progress');
    const progressFill = document.getElementById('progressFill');
    const progressText = document.getElementById('progressText');

    // 現在のタブがXのブックマークページかチェック
    chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
        const currentTab = tabs[0];
        const isBookmarkPage = currentTab.url.includes('x.com/i/bookmarks') || 
                              currentTab.url.includes('twitter.com/i/bookmarks');
        
        if (isBookmarkPage) {
            updateStatus('success', '✓', 'Ready to export');
            exportBtn.disabled = false;
            openBookmarksBtn.style.display = 'none';
        } else {
            updateStatus('warning', '⚠', 'Please open the X bookmarks page');
            exportBtn.disabled = true;
        }
    });

    // ブックマークページを開く
    openBookmarksBtn.addEventListener('click', function() {
        chrome.tabs.create({url: 'https://x.com/i/bookmarks'});
    });

    // エクスポート実行
    exportBtn.addEventListener('click', function() {
        exportBtn.disabled = true;
        progress.style.display = 'block';
        updateStatus('processing', '⟳', 'Checking connection...');
        progressText.textContent = 'Communicating with content script...';

        // アクティブなタブでコンテンツスクリプトにpingを送信
        chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
            const tabId = tabs[0].id;
            chrome.tabs.sendMessage(tabId, {action: 'ping'}, function(response) {
                if (chrome.runtime.lastError || !response || response.status !== 'ok') {
                    showError('Failed to connect. Please reload the page and try again.');
                    return;
                }

                // 接続成功後、エクスポート処理を開始
                progressText.textContent = 'Fetching bookmarks...';
                updateStatus('processing', '⟳', 'Processing...');
                chrome.tabs.sendMessage(tabId, {action: 'exportBookmarks'}, function(response) {
                    if (chrome.runtime.lastError) {
                        showError('An error occurred: ' + chrome.runtime.lastError.message);
                        return;
                    }
                    
                    if (response && response.success) {
                        handleExportSuccess(response.data);
                    } else {
                        showError(response ? response.error : 'An unknown error occurred');
                    }
                });
            });
        });
    });

    function updateStatus(type, icon, text) {
        statusIcon.textContent = icon;
        statusText.textContent = text;
        
        // アイコンとステータスのクラスをリセット
        statusIcon.className = 'status-icon';
        statusIcon.classList.add(type);
        status.className = 'status'; // status divのクラスをリセット
        status.classList.add(type); // status divにタイプを追加
    }

    function handleExportSuccess(bookmarks) {
        progressText.textContent = 'Generating individual Markdown files...';
        updateProgress(50);
        
        // 個別のMarkdownファイルを生成
        const markdownFiles = generateIndividualMarkdownFiles(bookmarks);
        
        progressText.textContent = 'Creating ZIP file...';
        updateProgress(80);
        
        // ZIPファイルを作成してダウンロード
        createAndDownloadZip(markdownFiles);
        
        progressText.textContent = 'Complete!';
        updateProgress(100);
        updateStatus('success', '✓', `Exported ${bookmarks.length} bookmarks successfully`);
        
        setTimeout(() => {
            progress.style.display = 'none';
            exportBtn.disabled = false;
        }, 2000);
    }

    function generateIndividualMarkdownFiles(bookmarks) {
        const files = [];
        
        bookmarks.forEach((bookmark, index) => {
            // ファイル名を生成（Bookmark @ユーザー名_連番.md）
            const username = bookmark.username || 'unknown';
            const safeUsername = username.replace(/[^a-zA-Z0-9_-]/g, '_');
            const filename = `Bookmark @${safeUsername}_${String(index + 1).padStart(3, '0')}.md`;
            
            // 個別のMarkdownコンテンツを生成
            let markdown = `# ${bookmark.author || 'Unknown'}\n\n`;
            markdown += `**Author:** @${bookmark.username || 'unknown'}\n`;
            markdown += `**Date:** ${bookmark.date || 'Unknown'}\n`;
            markdown += `**URL:** ${bookmark.url || 'N/A'}\n\n`;
            markdown += `---\n\n`;
            markdown += `## Content\n\n`;
            markdown += `${bookmark.text || 'No text'}\n\n`;
            
            if (bookmark.images && bookmark.images.length > 0) {
                markdown += `## Images (${bookmark.images.length})\n\n`;
                bookmark.images.forEach((img, i) => {
                    markdown += `![Image ${i + 1}](${img})\n\n`;
                });
            }
            
            if (bookmark.links && bookmark.links.length > 0) {
                markdown += `## Links\n\n`;
                bookmark.links.forEach(link => {
                    markdown += `- [${link.text || link.url}](${link.url})\n`;
                });
                markdown += '\n';
            }
            
            markdown += `---\n\n`;
            markdown += `*Exported at: ${new Date().toLocaleString('en-US')}*\n`;
            
            files.push({
                filename: filename,
                content: markdown
            });
        });
        
        return files;
    }

    async function createAndDownloadZip(files) {
        // JSZipライブラリを動的に読み込み
        if (typeof JSZip === 'undefined') {
            await loadJSZip();
        }
        
        const zip = new JSZip();
        
        // 各ファイルをZIPに追加
        files.forEach(file => {
            zip.file(file.filename, file.content);
        });
        
        // インデックスファイルを作成
        const indexContent = generateIndexFile(files);
        zip.file('index.md', indexContent);
        
        // ZIPファイルを生成
        const zipContent = await zip.generateAsync({type: 'base64'});
        
        // ダウンロード
        const url = 'data:application/zip;base64,' + zipContent;
        const filename = `x-bookmarks-${new Date().toISOString().split('T')[0]}.zip`;
        
        chrome.downloads.download({
            url: url,
            filename: filename,
            saveAs: true
        });
    }

    function generateIndexFile(files) {
        let index = '# X Bookmark Export\n\n';
        index += `Exported at: ${new Date().toLocaleString('en-US')}\n`;
        index += `Total: ${files.length} bookmarks\n\n`;
        index += '## File List\n\n';
        
        files.forEach((file, i) => {
            const username = file.filename.match(/@([^_]+)/)?.[1] || 'unknown';
            index += `${i + 1}. [${file.filename}](./${file.filename}) - @${username}\n`;
        });
        
        return index;
    }

    function loadJSZip() {
        return new Promise((resolve, reject) => {
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
        progress.style.display = 'none';
        exportBtn.disabled = false;
        updateStatus('error', '✗', message);
    }
});

