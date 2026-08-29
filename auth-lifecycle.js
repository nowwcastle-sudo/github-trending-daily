(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AuthLifecycle = api;
}(typeof globalThis === "undefined" ? this : globalThis, function () {
  "use strict";

  function create({ target, onDiscard = () => {}, onRestore = () => {} }) {
    let started = false;
    let discarded = false;

    const onPageHide = event => {
      if (event?.persisted !== false || discarded) return;
      discarded = true;
      onDiscard();
    };
    const onPageShow = event => {
      if (event?.persisted === true) onRestore();
    };

    return {
      start() {
        if (started) return;
        started = true;
        target.addEventListener("pagehide", onPageHide);
        target.addEventListener("pageshow", onPageShow);
      },
      stop() {
        if (!started) return;
        started = false;
        target.removeEventListener("pagehide", onPageHide);
        target.removeEventListener("pageshow", onPageShow);
      },
    };
  }

  return { create };
}));
