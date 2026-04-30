/**
 * Normalizes X/Twitter status URLs for stable deduplication (shared by popup + content script).
 * @param {string} url
 * @returns {string}
 */
function normalizeTweetUrl(url) {
    if (!url || typeof url !== 'string') {
        return '';
    }
    try {
        const u = new URL(url, 'https://x.com');
        u.search = '';
        u.hash = '';
        let host = (u.hostname || '').replace(/^www\./, '');
        if (host === 'twitter.com' || host === 'mobile.twitter.com' || host === 'x.com') {
            u.hostname = 'x.com';
        }
        u.protocol = 'https:';
        let out = u.href;
        if (out.endsWith('/')) {
            out = out.slice(0, -1);
        }
        return out;
    } catch {
        return url.split('?')[0].split('#')[0];
    }
}
