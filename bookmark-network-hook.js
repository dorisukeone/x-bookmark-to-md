// MAIN world script: passively observes the page's own network calls to X's
// internal Bookmarks GraphQL endpoint and republishes parsed tweet/cursor data
// to the isolated content script via postMessage. Never alters request/response
// behavior — every original fetch/XHR call and return value passes through
// unchanged even if parsing fails.
(function () {
    const BOOKMARKS_URL_PATTERN = /\/graphql\/[^/]+\/Bookmarks(?:\?|$)/;

    function buildDisplayText(legacy, noteTweetText) {
        if (noteTweetText) {
            return noteTweetText.trim();
        }

        let text = legacy.full_text || '';
        const range = legacy.display_text_range;
        if (Array.isArray(range) && range.length === 2) {
            text = text.slice(range[0], range[1]);
        }

        const urls = (legacy.entities && legacy.entities.urls) || [];
        urls.forEach(u => {
            if (u.url && u.display_url) {
                text = text.split(u.url).join(u.display_url);
            }
        });

        return text.trim();
    }

    function extractTweetFromResult(tweetResult) {
        if (!tweetResult) {
            return null;
        }
        // TweetWithVisibilityResults wraps the real tweet under `.tweet`.
        const tweet = tweetResult.tweet || tweetResult;
        const legacy = tweet.legacy;
        const restId = tweet.rest_id;
        if (!legacy || !restId) {
            return null;
        }

        const userResult = tweet.core && tweet.core.user_results && tweet.core.user_results.result;
        const userCore = userResult && (userResult.core || {});
        const userLegacy = userResult && (userResult.legacy || {});
        const screenName = userCore.screen_name || userLegacy.screen_name || '';
        const name = userCore.name || userLegacy.name || '';
        if (!screenName) {
            return null;
        }

        const noteTweetText = tweet.note_tweet
            && tweet.note_tweet.note_tweet_results
            && tweet.note_tweet.note_tweet_results.result
            && tweet.note_tweet.note_tweet_results.result.text;

        const images = [];
        const media = (legacy.extended_entities && legacy.extended_entities.media)
            || (legacy.entities && legacy.entities.media)
            || [];
        media.forEach(m => {
            if (m.media_url_https && images.indexOf(m.media_url_https) === -1) {
                images.push(m.media_url_https);
            }
        });

        const links = [];
        const urlEntities = (legacy.entities && legacy.entities.urls) || [];
        urlEntities.forEach(u => {
            if (u.url) {
                links.push({ url: u.expanded_url || u.url, text: u.display_url || u.url });
            }
        });

        let date = '';
        if (legacy.created_at) {
            const parsed = new Date(legacy.created_at);
            date = isNaN(parsed.getTime()) ? legacy.created_at : parsed.toISOString();
        }

        return {
            text: buildDisplayText(legacy, noteTweetText),
            author: name,
            username: screenName,
            date,
            url: `https://x.com/${screenName}/status/${restId}`,
            images,
            links,
            tweetId: restId
        };
    }

    function parseBookmarksPayload(json) {
        const instructions = (json && json.data && json.data.bookmark_timeline_v2
            && json.data.bookmark_timeline_v2.timeline
            && json.data.bookmark_timeline_v2.timeline.instructions) || [];

        const tweets = [];
        let bottomCursor = null;
        let topCursor = null;

        instructions.forEach(instruction => {
            (instruction.entries || []).forEach(entry => {
                const content = entry.content;
                if (!content) {
                    return;
                }

                if (content.entryType === 'TimelineTimelineItem'
                    && content.itemContent
                    && content.itemContent.__typename === 'TimelineTweet') {
                    const bookmark = extractTweetFromResult(content.itemContent.tweet_results && content.itemContent.tweet_results.result);
                    if (bookmark) {
                        tweets.push(bookmark);
                    }
                } else if (content.entryType === 'TimelineTimelineCursor') {
                    if (content.cursorType === 'Bottom') {
                        bottomCursor = content.value;
                    } else if (content.cursorType === 'Top') {
                        topCursor = content.value;
                    }
                }
            });
        });

        return { tweets, bottomCursor, topCursor };
    }

    function publish(payload) {
        try {
            window.postMessage({
                source: 'xbm-network-hook',
                type: 'bookmarksPage',
                payload
            }, window.location.origin);
        } catch (error) {
            // Never let a broadcast failure surface to the page.
        }
    }

    function handleResponseText(text) {
        try {
            const json = JSON.parse(text);
            publish(parseBookmarksPayload(json));
        } catch (error) {
            // Response wasn't the shape we expected (X changed something) — swallow
            // and let content.js's DOM-scroll fallback carry the extraction instead.
        }
    }

    const originalFetch = window.fetch;
    if (typeof originalFetch === 'function') {
        window.fetch = function (...args) {
            const input = args[0];
            const url = typeof input === 'string' ? input : (input && input.url) || '';
            const isBookmarksCall = BOOKMARKS_URL_PATTERN.test(url);
            const responsePromise = originalFetch.apply(this, args);

            if (isBookmarksCall) {
                responsePromise.then(response => {
                    response.clone().text().then(handleResponseText).catch(() => {});
                }).catch(() => {});
            }

            return responsePromise;
        };
    }

    const OriginalXHR = window.XMLHttpRequest;
    function PatchedXHR() {
        const xhr = new OriginalXHR();
        let isBookmarksCall = false;

        const originalOpen = xhr.open;
        xhr.open = function (method, url, ...rest) {
            try {
                isBookmarksCall = BOOKMARKS_URL_PATTERN.test(url);
            } catch (error) {
                isBookmarksCall = false;
            }
            return originalOpen.call(xhr, method, url, ...rest);
        };

        xhr.addEventListener('load', function () {
            if (isBookmarksCall) {
                handleResponseText(xhr.responseText);
            }
        });

        return xhr;
    }
    PatchedXHR.prototype = OriginalXHR.prototype;
    window.XMLHttpRequest = PatchedXHR;
})();
