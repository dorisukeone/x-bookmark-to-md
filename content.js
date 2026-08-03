// Content script for X Bookmark Exporter
console.log('X Bookmark Exporter content script loaded');

// スクロール中の抽出をポップアップからのキャンセル要求で中断するためのフラグ
let exportCancelRequested = false;

// bookmark-network-hook.js (MAIN world) が観測したBookmarks GraphQLレスポンスの蓄積。
// DOMスクレイピングより確実にツイートIDと本当のページ終端(Bottomカーソル)が分かるため、
// 主データ源として使う。フックが一切発火しない場合(X側の実装変更等)でも、
// 既存のDOMスクロール抽出がそのままフォールバックとして機能する。
let networkTweetsByUrl = new Map();
let networkCaptureSeen = false;
let lastBottomCursor = null;
let bottomCursorRepeatCount = 0;

window.addEventListener('message', (event) => {
    if (event.source !== window) {
        return;
    }
    const data = event.data;
    if (!data || data.source !== 'xbm-network-hook' || data.type !== 'bookmarksPage') {
        return;
    }

    networkCaptureSeen = true;
    const payload = data.payload || {};
    const tweets = Array.isArray(payload.tweets) ? payload.tweets : [];

    tweets.forEach(tweet => {
        if (!tweet || !tweet.url) {
            return;
        }
        const key = normalizeTweetUrl(tweet.url);
        if (!key || networkTweetsByUrl.has(key)) {
            return;
        }
        networkTweetsByUrl.set(key, { ...tweet, url: key });
    });

    if (payload.bottomCursor) {
        bottomCursorRepeatCount = payload.bottomCursor === lastBottomCursor ? bottomCursorRepeatCount + 1 : 0;
        lastBottomCursor = payload.bottomCursor;
    }
});

// メッセージリスナー
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'ping') {
        console.log('Ping received');
        sendResponse({status: 'ok'});
        return;
    }

    if (request.action === 'cancelExportBookmarks') {
        console.log('Cancel export requested');
        exportCancelRequested = true;
        sendResponse({ok: true});
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

        exportCancelRequested = false;
        // 同一タブで複数回エクスポートした場合に前回実行の「終端到達」判定が
        // 残らないよう、カーソル追跡状態だけ都度リセットする
        // (networkTweetsByUrl自体は使い回して良い — extractBookmarks側で毎回
        // 先頭から再評価するため、蓄積済みデータの再利用に問題はない)。
        lastBottomCursor = null;
        bottomCursorRepeatCount = 0;
        extractBookmarks(options)
            .then(result => {
                console.log(`Found ${result.bookmarks.length} bookmarks (canceled: ${result.canceled})`);
                sendResponse({
                    success: !result.canceled,
                    canceled: result.canceled,
                    data: result.bookmarks
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
    // Bookmarks are listed newest-first, so once we've scrolled past a run of
    // already-exported tweets with nothing new mixed in, everything further
    // down is older history we've already exported — stop instead of
    // continuing to scroll to the very bottom of the whole bookmark list.
    let knownStreak = 0;
    const KNOWN_STREAK_LIMIT = 3;
    let canceled = false;
    // networkTweetsByUrl accumulates in insertion order; this pointer lets us pull
    // only the entries that arrived since the last iteration (mirrors "this batch"
    // semantics of the DOM scrape below) instead of re-scanning everything each time.
    let networkProcessedCount = 0;

    const considerBookmark = (bookmark, counters) => {
        if (!bookmark || !bookmark.url) {
            return;
        }
        const key = normalizeTweetUrl(bookmark.url);
        if (!key) {
            return;
        }
        if (knownSet && knownSet.has(key)) {
            counters.known++;
            return;
        }
        if (!bookmarks.has(key)) {
            bookmarks.set(key, { ...bookmark, url: key });
            counters.new++;
        }
    };

    console.log('Starting bookmark extraction...', {
        maxBookmarks,
        incrementalRequested: options.incrementalOnly,
        urlFilterActive: !!knownSet,
        knownUrlCount: knownSet ? knownSet.size : 0
    });

    await waitForPageLoad();
    await waitForBookmarksToAppear();

    while (scrollAttempts < maxScrollAttempts) {
        if (exportCancelRequested) {
            console.log('Export canceled, stopping extraction...');
            canceled = true;
            break;
        }

        const counters = { new: 0, known: 0 };

        // 一次データ源: bookmark-network-hook.js が捕捉したGraphQLレスポンス（確実なツイートID）
        const allNetworkTweets = Array.from(networkTweetsByUrl.values());
        const freshNetworkTweets = allNetworkTweets.slice(networkProcessedCount);
        networkProcessedCount = allNetworkTweets.length;
        freshNetworkTweets.forEach(bookmark => considerBookmark(bookmark, counters));

        // フォールバック/補完: フックが取りこぼした場合に備えたDOMスクレイピング
        const currentBookmarks = await extractVisibleBookmarks();
        currentBookmarks.forEach(bookmark => considerBookmark(bookmark, counters));

        console.log(`Scroll attempt ${scrollAttempts + 1}: Found ${bookmarks.size} total bookmarks`, {
            networkCaptureSeen,
            newInThisBatch: counters.new,
            knownInThisBatch: counters.known
        });

        if (maxBookmarks && bookmarks.size >= maxBookmarks) {
            console.log('Reached max bookmarks limit, stopping...');
            break;
        }

        if (knownSet) {
            if (counters.known > 0 && counters.new === 0) {
                knownStreak++;
                if (knownStreak >= KNOWN_STREAK_LIMIT) {
                    console.log('Reached previously exported bookmarks, stopping incremental scan...');
                    break;
                }
            } else if (counters.new > 0) {
                knownStreak = 0;
            }
        }

        // Bottomカーソルが2回連続で同じ値 = Xがこれ以上新しいページを返していない
        // = 本当にリストの終端に到達したという確定的なシグナル。DOM側の高さ/件数の
        // 変化待ち(stableCount)より速く正確に判定できる。
        if (networkCaptureSeen && bottomCursorRepeatCount >= 1) {
            console.log('Bottom cursor repeated (network-confirmed end of bookmarks), stopping...');
            break;
        }

        if (exportCancelRequested) {
            console.log('Export canceled, stopping extraction...');
            canceled = true;
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
    return { bookmarks: result, canceled };
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
    const articleText = tweetElement.textContent || '';
    // Require explicit warning copy — "Show more" / generic reveal buttons alone are too broad.
    if (!SENSITIVE_WARNING_PATTERN.test(articleText)) {
        return false;
    }

    const buttons = tweetElement.querySelectorAll('button, [role="button"]');
    for (const btn of buttons) {
        const label = (btn.textContent || btn.getAttribute('aria-label') || '').trim();
        if (SENSITIVE_REVEAL_BUTTON_PATTERN.test(label)) {
            return true;
        }
    }

    // Warning text present with no tweet body is enough (media may still be blurred).
    return true;
}

/**
 * 引用ツイート内のネスト article[data-testid="tweet"] 配下を除外し、
 * 外側ツイート自身に属する要素だけを返す。
 */
function queryAllInOwnTweet(root, selector) {
    return Array.from(root.querySelectorAll(selector)).filter(el => {
        const article = el.closest('article[data-testid="tweet"]');
        return article === root;
    });
}

function queryInOwnTweet(root, selector) {
    const matches = queryAllInOwnTweet(root, selector);
    return matches.length > 0 ? matches[0] : null;
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
        const textElements = queryAllInOwnTweet(tweetElement, '[data-testid="tweetText"]');
        if (textElements.length > 0) {
            bookmark.text = textElements[0].textContent.trim();
        } else {
            // フォールバック: data-testidが変わった場合に備え、本文特有のlang属性から推定
            const fallbackTextElement = queryInOwnTweet(tweetElement, '[lang]');
            if (fallbackTextElement) {
                bookmark.text = fallbackTextElement.textContent.trim();
            }
        }

        if (!bookmark.text && detectSensitiveContentPlaceholder(tweetElement)) {
            bookmark.text = SENSITIVE_PLACEHOLDER_TEXT;
        }

        // 作者情報を取得
        const authorElements = queryAllInOwnTweet(tweetElement, '[data-testid="User-Name"]');
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
        const timeElements = queryAllInOwnTweet(tweetElement, 'time');
        if (timeElements.length > 0) {
            bookmark.date = timeElements[0].getAttribute('datetime') || timeElements[0].textContent;
        }
        
        // ツイートURLを取得
        const linkElements = queryAllInOwnTweet(tweetElement, 'a[href*="/status/"]');
        if (linkElements.length > 0) {
            const href = linkElements[0].getAttribute('href');
            const raw = href.startsWith('http') ? href : `https://x.com${href}`;
            bookmark.url = normalizeTweetUrl(raw);
        }
        
        // 画像を取得
        const imageElements = queryAllInOwnTweet(tweetElement, 'img[src*="pbs.twimg.com"]');
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
        const cardLinks = queryAllInOwnTweet(tweetElement, 'a[href*="t.co"]');
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
    const profileLinks = queryAllInOwnTweet(tweetElement, 'a[href^="/"]');

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

