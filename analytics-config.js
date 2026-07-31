// GA4 Measurement Protocol credentials for anonymous usage analytics.
// Empty values keep analytics disabled (safe default for every git clone).
//
// To enable in your own local checkout before packaging for the Chrome
// Web Store, fill in real values and run:
//   git update-index --skip-worktree analytics-config.js
// so your secret never gets committed. See docs/ga4-setup.md.
self.__ANALYTICS_CONFIG__ = {
    measurementId: '',
    apiSecret: ''
};
