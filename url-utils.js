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

/**
 * Sanitizes extracted text for ZIP/Markdown export: lone UTF-16 surrogates become U+FFFD;
 * control characters except tab, LF, and CR are removed.
 * @param {string} str
 * @returns {string}
 */
function sanitizeExportText(str) {
    if (str == null || typeof str !== 'string') {
        return '';
    }
    var out = '';
    for (var i = 0; i < str.length; i++) {
        var code = str.charCodeAt(i);
        if (code >= 0xD800 && code <= 0xDBFF) {
            var low = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
            if (low >= 0xDC00 && low <= 0xDFFF) {
                out += str.charAt(i) + str.charAt(i + 1);
                i++;
            } else {
                out += '\uFFFD';
            }
        } else if (code >= 0xDC00 && code <= 0xDFFF) {
            out += '\uFFFD';
        } else if (
            (code >= 0x0000 && code <= 0x0008) ||
            code === 0x000B ||
            code === 0x000C ||
            (code >= 0x000E && code <= 0x001F) ||
            code === 0x007F ||
            (code >= 0x0080 && code <= 0x009F)
        ) {
            continue;
        } else {
            out += str.charAt(i);
        }
    }
    return out;
}
