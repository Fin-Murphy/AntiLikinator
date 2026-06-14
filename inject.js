/*
 * AntiLikinator — page-context (MAIN world) interceptor.
 *
 * Instagram's Following feed is a virtualized list: hiding already-rendered
 * posts via CSS corrupts its layout math and breaks infinite scroll. So instead
 * we filter liked posts out of the feed DATA before Instagram renders them.
 *
 * The feed payload looks like:
 *   { data: { xdt_api__v1__feed__timeline__connection: {
 *       pagination_source: "following",
 *       edges: [ { node: { media: { has_liked: true, ... } } } ] } } }
 *
 * We drop edges whose media.has_liked === true, but ONLY when
 * pagination_source === "following" — the For You feed is never touched.
 *
 * This runs at document_start in the page's own JS context so it can patch
 * fetch / XMLHttpRequest / JSON.parse before Instagram fetches or hydrates.
 */

(function () {
  "use strict";

  const CONN_KEY = "xdt_api__v1__feed__timeline__connection";

  // Default on; the isolated content script relays the real setting. We read a
  // synchronous mirror so the very first (server-rendered) hydration respects
  // an "off" setting too.
  let enabled = true;
  try {
    enabled = localStorage.getItem("alik_enabled") !== "0";
  } catch (_) {}
  window.addEventListener("message", (e) => {
    if (e.source === window && e.data && e.data.__alik === true) {
      enabled = e.data.enabled !== false;
    }
  });

  // Walk an object tree; wherever a "following" timeline connection is found,
  // strip its already-liked edges. Returns true if anything was removed.
  function filterTree(obj) {
    let changed = false;
    const seen = new Set();
    (function walk(o) {
      if (!o || typeof o !== "object" || seen.has(o)) return;
      seen.add(o);
      const conn = o[CONN_KEY];
      if (
        conn &&
        Array.isArray(conn.edges) &&
        conn.pagination_source === "following"
      ) {
        const before = conn.edges.length;
        conn.edges = conn.edges.filter((edge) => {
          const media = edge && edge.node && edge.node.media;
          return !(media && media.has_liked === true);
        });
        if (conn.edges.length !== before) changed = true;
      }
      if (Array.isArray(o)) {
        for (let i = 0; i < o.length; i++) walk(o[i]);
      } else {
        for (const k in o) walk(o[k]);
      }
    })(obj);
    return changed;
  }

  // Given a response body string, return a filtered version, or null if nothing
  // changed / it isn't a relevant feed payload. Handles both plain JSON and the
  // newline-delimited multi-object form Instagram sometimes streams.
  function processText(text) {
    if (!enabled || typeof text !== "string") return null;
    if (text.indexOf(CONN_KEY) === -1) return null;
    if (text.indexOf('"following"') === -1) return null;

    try {
      const obj = JSON.parse(text);
      return filterTree(obj) ? JSON.stringify(obj) : null;
    } catch (_) {}

    const lines = text.split("\n");
    let any = false;
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (!t) continue;
      try {
        const o = JSON.parse(t);
        if (filterTree(o)) {
          lines[i] = lines[i].replace(t, JSON.stringify(o));
          any = true;
        }
      } catch (_) {}
    }
    return any ? lines.join("\n") : null;
  }

  /* ---- patch JSON.parse (server-rendered hydration + any parse path) ---- */
  const origParse = JSON.parse;
  JSON.parse = function (text, reviver) {
    const result = origParse.call(this, text, reviver);
    try {
      // Cheap string guard first — only deep-walk the rare feed payloads,
      // not every JSON.parse Instagram makes.
      if (
        enabled &&
        result &&
        typeof result === "object" &&
        typeof text === "string" &&
        text.indexOf(CONN_KEY) !== -1 &&
        text.indexOf('"following"') !== -1
      ) {
        filterTree(result);
      }
    } catch (_) {}
    return result;
  };

  /* ---- patch fetch (GraphQL feed pagination) ---- */
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (...args) {
      return origFetch.apply(this, args).then((res) => {
        try {
          const ct = res.headers.get("content-type") || "";
          if (ct.indexOf("json") === -1 && ct.indexOf("javascript") === -1) {
            return res;
          }
          return res
            .clone()
            .text()
            .then((text) => {
              const modified = processText(text);
              if (modified == null) return res;
              const headers = new Headers(res.headers);
              headers.delete("content-length");
              return new Response(modified, {
                status: res.status,
                statusText: res.statusText,
                headers,
              });
            })
            .catch(() => res);
        } catch (_) {
          return res;
        }
      });
    };
  }

  /* ---- patch XMLHttpRequest (best effort) ---- */
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...sendArgs) {
    this.addEventListener("readystatechange", function () {
      if (this.readyState !== 4) return;
      try {
        const modified = processText(this.responseText);
        if (modified == null) return;
        Object.defineProperty(this, "responseText", {
          configurable: true,
          get: () => modified,
        });
        Object.defineProperty(this, "response", {
          configurable: true,
          get: () => modified,
        });
      } catch (_) {}
    });
    return origSend.apply(this, sendArgs);
  };
})();
