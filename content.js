// Content script for X Bookmark Exporter
console.log('X Bookmark Exporter content script loaded');

// メッセージリスナー
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'ping') {
        console.log('Ping received');
        sendResponse({status: 'ok'});
        return;
    }

    if (request.action === 'exportBookmarks') {
        console.log('Export bookmarks request received');
        
        // 現在のページがブックマークページかチェック
        if (!window.location.href.includes('/i/bookmarks')) {
            sendResponse({
                success: false,
                error: 'This is not a bookmark page. Please open https://x.com/i/bookmarks.'
            });
            return;
        }
        
        const options = {
            maxBookmarks: request.maxBookmarks > 0 ? request.maxBookmarks : null,
            incrementalOnly: !!request.incrementalOnly,
            knownTweetUrls: Array.isArray(request.knownTweetUrls) ? request.knownTweetUrls : []
        };
        
        extractBookmarks(options)
            .then(bookmarks => {
                console.log(`Found ${bookmarks.length} bookmarks`);
                sendResponse({
                    success: true,
                    data: bookmarks
                });
            })
            .catch(error => {
                console.error('Error extracting bookmarks:', error);
                sendResponse({
                    success: false,
                    error: error.message
                });
            });
        
        return true; // 非同期レスポンスを示す
    }
});

const TWEET_SELECTOR = 'article[data-testid="tweet"]';

async function extractBookmarks(options = {}) {
    const maxBookmarks = options.maxBookmarks > 0 ? options.maxBookmarks : null;
    const knownSet = options.incrementalOnly && options.knownTweetUrls && options.knownTweetUrls.length > 0
        ? new Set(options.knownTweetUrls.map(normalizeTweetUrl).filter(Boolean))
        : null;

    const bookmarks = new Map();
    let scrollAttempts = 0;
    const maxScrollAttempts = 1000;
    let stableCount = 0;

    console.log('Starting bookmark extraction...', {
        maxBookmarks,
        incrementalRequested: options.incrementalOnly,
        urlFilterActive: !!knownSet,
        knownUrlCount: knownSet ? knownSet.size : 0
    });

    await waitForPageLoad();
    await waitForBookmarksToAppear();

    while (scrollAttempts < maxScrollAttempts) {
        const currentBookmarks = await extractVisibleBookmarks();

        currentBookmarks.forEach(bookmark => {
            if (!bookmark.url) {
                return;
            }
            const key = normalizeTweetUrl(bookmark.url);
            if (!key) {
                return;
            }
            if (knownSet && knownSet.has(key)) {
                return;
            }
            if (!bookmarks.has(key)) {
                bookmarks.set(key, { ...bookmark, url: key });
            }
        });

        console.log(`Scroll attempt ${scrollAttempts + 1}: Found ${bookmarks.size} total bookmarks`);

        if (maxBookmarks && bookmarks.size >= maxBookmarks) {
            console.log('Reached max bookmarks limit, stopping...');
            break;
        }

        const previousBookmarkCount = bookmarks.size;
        const previousHeight = document.body.scrollHeight;

        window.scrollTo(0, document.body.scrollHeight);

        await sleep(3000);

        const newHeight = document.body.scrollHeight;

        if (bookmarks.size === previousBookmarkCount && newHeight === previousHeight) {
            stableCount++;
            if (stableCount >= 10) {
                console.log('No new bookmarks found and page height did not change after 10 attempts, stopping...');
                break;
            }
        } else {
            stableCount = 0;
        }

        scrollAttempts++;
    }

    let result = Array.from(bookmarks.values());
    if (maxBookmarks && result.length > maxBookmarks) {
        result = result.slice(0, maxBookmarks);
    }

    console.log(`Extraction completed. Total bookmarks: ${result.length}`);
    return result;
}

const EXTRACTION_BATCH_SIZE = 50;

async function extractVisibleBookmarks() {
    const visibleBookmarks = [];
    const tweets = document.querySelectorAll(TWEET_SELECTOR);

    if (tweets.length === 0) {
        console.log('No tweets found with selector:', TWEET_SELECTOR);
        return visibleBookmarks;
    }

    for (let start = 0; start < tweets.length; start += EXTRACTION_BATCH_SIZE) {
        const end = Math.min(start + EXTRACTION_BATCH_SIZE, tweets.length);

        for (let index = start; index < end; index++) {
            try {
                const bookmark = extractTweetData(tweets[index]);
                if (bookmark && bookmark.url) {
                    visibleBookmarks.push(bookmark);
                }
            } catch (error) {
                console.error(`Error extracting tweet ${index}:`, error);
            }
        }

        if (end < tweets.length) {
            await yieldToMainThread();
        }
    }

    return visibleBookmarks;
}

function yieldToMainThread() {
    return new Promise(resolve => {
        if (typeof requestIdleCallback === 'function') {
            requestIdleCallback(() => resolve(), {timeout: 200});
        } else {
            setTimeout(resolve, 0);
        }
    });
}

const SENSITIVE_PLACEHOLDER_TEXT = '（閲覧注意のため本文非表示）';

const SENSITIVE_WARNING_PATTERN = /sensitive|content warning|閲覧注意|センシティブな内容|センシティブ|caution/i;

const SENSITIVE_REVEAL_BUTTON_PATTERN = /^(show|view|display|表示する|表示)$/i;

/**
 * 本文が空のとき、センシティブ/閲覧注意プレースホルダーUIの存在を保守的に検出する。
 * 既存セレクタは変更せず、可視プレースホルダーのみを対象とする。
 */
function detectSensitiveContentPlaceholder(tweetElement) {
    const sensitiveTestIds = [
        'tweet-text-show-more-link',
        'app-text-transition-container',
        'mask',
        'placementTracking'
    ];
    for (const testId of sensitiveTestIds) {
        if (tweetElement.querySelector(`[data-testid="${testId}"]`)) {
            return true;
        }
    }

    const buttons = tweetElement.querySelectorAll('button, [role="button"]');
    for (const btn of buttons) {
        const label = (btn.textContent || btn.getAttribute('aria-label') || '').trim();
        if (SENSITIVE_REVEAL_BUTTON_PATTERN.test(label)) {
            return true;
        }
    }

    const articleText = tweetElement.textContent || '';
    if (SENSITIVE_WARNING_PATTERN.test(articleText)) {
        return true;
    }

    if (/表示する/i.test(articleText)) {
        const hasMedia = tweetElement.querySelector(
            '[data-testid="videoPlayer"], [data-testid="tweetPhoto"], img[src*="pbs.twimg.com/media"]'
        );
        if (hasMedia) {
            return true;
        }
    }

    return false;
}

function extractTweetData(tweetElement) {
    const bookmark = {
        text: '',
        author: '',
        username: '',
        date: '',
        url: '',
        images: [],
        links: []
    };
    
    try {
        // ツイートテキストを取得
        const textElements = tweetElement.querySelectorAll('[data-testid="tweetText"]');
        if (textElements.length > 0) {
            bookmark.text = textElements[0].textContent.trim();
        } else {
            // フォールバック: data-testidが変わった場合に備え、本文特有のlang属性から推定
            const fallbackTextElement = tweetElement.querySelector('[lang]');
            if (fallbackTextElement) {
                bookmark.text = fallbackTextElement.textContent.trim();
            }
        }

        if (!bookmark.text && detectSensitiveContentPlaceholder(tweetElement)) {
            bookmark.text = SENSITIVE_PLACEHOLDER_TEXT;
        }

        // 作者情報を取得
        const authorElements = tweetElement.querySelectorAll('[data-testid="User-Name"]');
        if (authorElements.length > 0) {
            const authorElement = authorElements[0];
            const nameElement = authorElement.querySelector('span');
            if (nameElement) {
                bookmark.author = nameElement.textContent.trim();
            }

            // ユーザー名を取得
            const usernameElement = authorElement.querySelector('a[href*="/"]');
            if (usernameElement) {
                const href = usernameElement.getAttribute('href');
                bookmark.username = href.replace('/', '');
            }
        } else {
            // フォールバック: User-Nameコンテナが見つからない場合、プロフィールへのリンクから推定
            extractAuthorFallback(tweetElement, bookmark);
        }

        // 日時を取得
        const timeElements = tweetElement.querySelectorAll('time');
        if (timeElements.length > 0) {
            bookmark.date = timeElements[0].getAttribute('datetime') || timeElements[0].textContent;
        }
        
        // ツイートURLを取得
        const linkElements = tweetElement.querySelectorAll('a[href*="/status/"]');
        if (linkElements.length > 0) {
            const href = linkElements[0].getAttribute('href');
            const raw = href.startsWith('http') ? href : `https://x.com${href}`;
            bookmark.url = normalizeTweetUrl(raw);
        }
        
        // 画像を取得
        const imageElements = tweetElement.querySelectorAll('img[src*="pbs.twimg.com"]');
        imageElements.forEach(img => {
            // アイコン画像を除外する（親要素にdata-testid="Tweet-User-Avatar"がないことを確認）
            if (!img.closest('[data-testid="Tweet-User-Avatar"]')) {
                const src = img.getAttribute('src');
                if (src && !bookmark.images.includes(src)) {
                    bookmark.images.push(src);
                }
            }
        });
        
        // リンクを取得
        const cardLinks = tweetElement.querySelectorAll('a[href*="t.co"]');
        cardLinks.forEach(link => {
            const href = link.getAttribute('href');
            const text = link.textContent.trim();
            if (href && text) {
                bookmark.links.push({url: href, text: text});
            }
        });
        
        // 最低限の情報があるかチェック
        if (bookmark.text || bookmark.url) {
            return bookmark;
        }
        
    } catch (error) {
        console.error('Error extracting tweet data:', error);
    }

    return null;
}

/**
 * [data-testid="User-Name"] コンテナが見つからない場合のフォールバック。
 * ツイート本文中の /status/ リンクではないプロフィールリンク（例: <a href="/username">）
 * から author/username を推定する。既存の主経路には一切影響しない。
 */
function extractAuthorFallback(tweetElement, bookmark) {
    const profileLinks = tweetElement.querySelectorAll('a[href^="/"]');

    for (const link of profileLinks) {
        const href = link.getAttribute('href') || '';
        if (!href || href.indexOf('/status/') !== -1 || href.indexOf('/photo/') !== -1) {
            continue;
        }

        const candidateUsername = href.replace(/^\//, '').split('/')[0].split('?')[0];
        if (!candidateUsername) {
            continue;
        }

        bookmark.username = candidateUsername;
        const text = link.textContent.trim();
        if (text) {
            bookmark.author = text;
        }
        break;
    }
}

function waitForPageLoad() {
    return new Promise((resolve) => {
        if (document.readyState === 'complete') {
            setTimeout(resolve, 1000); // 追加の待機時間
        } else {
            window.addEventListener('load', () => {
                setTimeout(resolve, 1000);
            });
        }
    });
}

/**
 * ブックマークの仮想化レンダリングが完了する前の抽出（0件/失敗）を避けるため、
 * 最初のツイートカードがDOMに現れるまでMutationObserverで待つ。既存セレクタ・
 * 抽出ロジックは変更せず、タイムアウト時は現行どおりそのまま抽出処理に進む。
 */
function waitForBookmarksToAppear(timeoutMs = 5000) {
    return new Promise((resolve) => {
        if (document.querySelector(TWEET_SELECTOR)) {
            resolve();
            return;
        }

        let settled = false;
        const finish = () => {
            if (settled) {
                return;
            }
            settled = true;
            observer.disconnect();
            clearTimeout(timer);
            resolve();
        };

        const observer = new MutationObserver(() => {
            if (document.querySelector(TWEET_SELECTOR)) {
                finish();
            }
        });
        observer.observe(document.body, {childList: true, subtree: true});

        const timer = setTimeout(finish, timeoutMs);
    });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ページ読み込み完了時の初期化
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize);
} else {
    initialize();
}

function initialize() {
    console.log('X Bookmark Exporter initialized on:', window.location.href);
}

