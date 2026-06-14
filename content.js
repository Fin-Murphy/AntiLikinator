/*
 * AntiLikinator content script.
 *
 * On Instagram's "Following" feed (not "For you"), hides any post that is
 * already in the liked state at the moment it first renders. Liking a post
 * during the current session does NOT remove it — each post's like-state is
 * read exactly once, the first time it appears, so the change only takes
 * effect on the next load when the post renders as already-liked.
 *
 * Instagram obfuscates class names, so every selector here relies on stable
 * semantic signals only: element tags, ARIA roles, and aria-label text.
 */

(function () {
  "use strict";

  const HIDDEN_CLASS = "alik-hidden";

  let enabled = true;

  // Decision per post for this page session, keyed by post shortcode (NOT by
  // DOM node — Instagram virtualizes the feed and recycles <article> nodes for
  // different posts as you scroll). Value: true = was already liked on first
  // sight -> hide. Cleared on reload, which is what makes "hidden only on next
  // load" work, and survives node recycling so we never hide the wrong post.
  const decisions = new Map();

  /* ---------- setting ---------- */

  function loadSetting(cb) {
    chrome.storage.sync.get({ enabled: true }, (res) => {
      enabled = res.enabled !== false;
      if (cb) cb();
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync" || !changes.enabled) return;
    enabled = changes.enabled.newValue !== false;
    if (enabled) {
      scanAll();
    } else {
      unhideAll();
    }
  });

  /* ---------- Following-feed detection ---------- */

  // True only when the home feed is showing the "Following" tab. Instagram
  // marks this with a ?variant=following query param (e.g.
  // /?hl=en&variant=following), which is the reliable signal. Fails closed:
  // any other URL (including the "For you" feed) is never touched.
  function isFollowingFeedActive() {
    if (location.pathname !== "/") return false;
    return new URLSearchParams(location.search).get("variant") === "following";
  }

  /* ---------- post evaluation ---------- */

  // The post's stable identifier, from its /p/<shortcode>/ (or /reel/) permalink.
  function getShortcode(article) {
    const link = article.querySelector('a[href*="/p/"], a[href*="/reel/"]');
    if (!link) return null;
    const m = (link.getAttribute("href") || "").match(/\/(?:p|reel)\/([^/?#]+)/);
    return m ? m[1] : null;
  }

  // The element to hide: the post's wrapper row (direct child of the feed),
  // whose reserved height would otherwise leave blank space. Falls back to the
  // article itself if the feed container can't be located.
  function getFeedRow(article) {
    const feed = document.querySelector('[role="feed"]');
    if (feed && feed.contains(article)) {
      let n = article;
      while (n.parentElement && n.parentElement !== feed) n = n.parentElement;
      if (n.parentElement === feed) return n;
    }
    return article;
  }

  // Decide a post's visibility and (re)apply it. Keyed by shortcode so a recycled
  // node always reflects the post it currently holds, not a previous one.
  function evaluatePost(article) {
    if (!enabled || !isFollowingFeedActive()) return;

    const shortcode = getShortcode(article);
    if (!shortcode) return; // not rendered enough to identify yet

    const row = getFeedRow(article);

    if (decisions.has(shortcode)) {
      row.classList.toggle(HIDDEN_CLASS, decisions.get(shortcode));
      return;
    }

    const likeIcon = article.querySelector(
      'svg[aria-label="Unlike"], svg[aria-label="Like"]'
    );
    // Like button not rendered yet: show the post (clearing any stale class a
    // recycled node carried) and decide once the button appears.
    if (!likeIcon) {
      row.classList.remove(HIDDEN_CLASS);
      return;
    }

    const liked = likeIcon.getAttribute("aria-label") === "Unlike";
    decisions.set(shortcode, liked);
    row.classList.toggle(HIDDEN_CLASS, liked);
  }

  function scanAll() {
    document.querySelectorAll("article").forEach(evaluatePost);
  }

  // Restore everything to visible and forget this session's decisions.
  function unhideAll() {
    document.querySelectorAll("." + HIDDEN_CLASS).forEach((el) => {
      el.classList.remove(HIDDEN_CLASS);
    });
    decisions.clear();
  }

  /* ---------- observers ---------- */

  // Instagram fires a torrent of mutations while scrolling (lazy media, video
  // playback, reflows). Doing per-mutation DOM work freezes the page, so we
  // coalesce every burst into a single debounced scan. evaluatePost skips
  // already-evaluated articles cheaply, so a scan is near-free once the visible
  // posts have been processed.
  let scanScheduled = false;
  function scheduleScan() {
    if (scanScheduled || !enabled) return;
    scanScheduled = true;
    setTimeout(() => {
      scanScheduled = false;
      scanAll();
    }, 200);
  }

  const observer = new MutationObserver(scheduleScan);

  function startObserving() {
    const target = document.querySelector('[role="feed"]') || document.body;
    observer.observe(target, { childList: true, subtree: true });
  }

  /* ---------- boot ---------- */

  loadSetting(() => {
    startObserving();
    scanAll();
  });
})();
