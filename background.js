importScripts('analytics-config.js', 'analytics.js');

chrome.runtime.onInstalled.addListener((details) => {
    console.log('X Bookmark Exporter installed');
    if (details.reason === 'install') {
        self.xbmAnalytics.sendEvent('extension_installed', {
            version: chrome.runtime.getManifest().version
        });
    } else if (details.reason === 'update') {
        self.xbmAnalytics.sendEvent('extension_updated', {
            version: chrome.runtime.getManifest().version
        });
    }
});
