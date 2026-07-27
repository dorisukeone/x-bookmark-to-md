// Anonymous, aggregate usage analytics via the GA4 Measurement Protocol.
// This file NEVER sends bookmark text, tweet URLs, usernames, or any
// page content — only fixed event names and small enum/number params.
// No-ops entirely when analytics-config.js has no measurementId/apiSecret.
(function (root) {
    var ENDPOINT = 'https://www.google-analytics.com/mp/collect';
    var config = root.__ANALYTICS_CONFIG__ || {};

    function isConfigured() {
        return !!(config.measurementId && config.apiSecret);
    }

    function getClientId(callback) {
        chrome.storage.local.get(['gaClientId'], function (data) {
            if (data.gaClientId) {
                callback(data.gaClientId);
                return;
            }
            var id = 'xbm-' + crypto.randomUUID();
            chrome.storage.local.set({ gaClientId: id }, function () {
                callback(id);
            });
        });
    }

    function sendEvent(name, params) {
        if (!isConfigured()) return;
        getClientId(function (clientId) {
            var url = ENDPOINT +
                '?measurement_id=' + encodeURIComponent(config.measurementId) +
                '&api_secret=' + encodeURIComponent(config.apiSecret);
            var body = JSON.stringify({
                client_id: clientId,
                events: [{ name: name, params: params || {} }]
            });
            fetch(url, { method: 'POST', body: body }).catch(function () {
                // Analytics must never surface failures to the user.
            });
        });
    }

    root.xbmAnalytics = { sendEvent: sendEvent, isConfigured: isConfigured };
})(typeof self !== 'undefined' ? self : window);
