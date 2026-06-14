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
  const EVALUATED_ATTR = "alikEvaluated"; // dataset key -> data-alik-evaluated

  let enabled = true;

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

  // Read a post's like-state once and hide it if it was already liked.
  function evaluatePost(article) {
    if (article.dataset[EVALUATED_ATTR]) return;
    if (!enabled || !isFollowingFeedActive()) return;

    const likeIcon = article.querySelector(
      'svg[aria-label="Unlike"], svg[aria-label="Like"]'
    );
    // Interaction bar not rendered yet — leave unevaluated so a later mutation
    // re-triggers us once the like button appears.
    if (!likeIcon) return;

    const liked = likeIcon.getAttribute("aria-label") === "Unlike";
    if (liked) {
      article.classList.add(HIDDEN_CLASS);
    }
    article.dataset[EVALUATED_ATTR] = "1";
  }

  function scanAll() {
    document.querySelectorAll("article").forEach(evaluatePost);
  }

  // Restore everything to its un-evaluated, visible state (toggle off / re-eval).
  function unhideAll() {
    document.querySelectorAll("." + HIDDEN_CLASS).forEach((el) => {
      el.classList.remove(HIDDEN_CLASS);
    });
    document.querySelectorAll("article").forEach((el) => {
      delete el.dataset[EVALUATED_ATTR];
    });
  }

  /* ---------- observers ---------- */

  function collectArticles(node, out) {
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (node.tagName === "ARTICLE") out.add(node);
    if (node.querySelectorAll) {
      node.querySelectorAll("article").forEach((a) => out.add(a));
    }
  }

  const observer = new MutationObserver((mutations) => {
    if (!enabled) return;
    const articles = new Set();
    for (const m of mutations) {
      m.addedNodes.forEach((n) => collectArticles(n, articles));
      // Re-evaluation targets: a not-yet-evaluated article whose like button
      // just rendered shows up as a subtree change on the article itself.
      if (m.target && m.target.closest) {
        const art = m.target.closest("article");
        if (art) articles.add(art);
      }
    }
    articles.forEach(evaluatePost);
  });

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
