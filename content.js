/*
 * AntiLikinator — isolated-world relay.
 *
 * The actual filtering happens in inject.js, which runs in the page's JS
 * context and therefore can't read chrome.storage. This script reads the on/off
 * setting and hands it to inject.js two ways:
 *   - localStorage (read synchronously by inject.js at startup, so the very
 *     first server-rendered hydration respects the setting), and
 *   - a window message (for live updates when the popup toggle changes).
 */

(function () {
  "use strict";

  function relay(enabled) {
    try {
      localStorage.setItem("alik_enabled", enabled ? "1" : "0");
    } catch (_) {}
    window.postMessage({ __alik: true, enabled: enabled }, "*");
  }

  chrome.storage.sync.get({ enabled: true }, (res) => {
    relay(res.enabled !== false);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.enabled) {
      relay(changes.enabled.newValue !== false);
    }
  });
})();
