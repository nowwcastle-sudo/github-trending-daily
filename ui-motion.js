(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.UiMotion = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function tooltipLayout({ card, viewport, tooltip }) {
    const edge = 16;
    const gap = 18;
    if (viewport.width >= 1100) {
      const missingRail = Math.max(0, card.right + gap + tooltip.width + edge - viewport.width);
      const safeShift = Math.max(0, card.left - edge);
      if (missingRail <= safeShift) {
        const shift = -Math.ceil(missingRail);
        const x = Math.round(card.right + shift + gap);
        const y = shift < 0
          ? Math.round(clamp(card.top, 12, viewport.height - Math.min(tooltip.height, 240) - 12))
          : Math.round(clamp(
            card.top + card.height / 2 - tooltip.height / 2,
            12,
            viewport.height - tooltip.height - 12,
          ));
        return { mode: "rail", shift, x, y };
      }
    }

    const below = card.bottom + 10;
    const above = card.top - tooltip.height - 10;
    const maxY = Math.max(8, viewport.height - tooltip.height - 12);
    const y = below + tooltip.height <= viewport.height - 8
      ? below
      : above >= 8
        ? above
        : clamp(card.top, 12, maxY);
    return {
      mode: "overlay",
      shift: 0,
      x: clamp(card.right - tooltip.width, 8, viewport.width - tooltip.width - 8),
      y,
    };
  }

  function periodGain(repo, period) {
    if (period === "all") {
      for (const key of ["stars_daily", "stars_weekly", "stars_monthly"]) {
        if (Number.isFinite(repo?.[key])) return repo[key];
      }
      return 0;
    }
    const key = period === "daily" ? "stars_daily"
      : period === "weekly" ? "stars_weekly"
        : "stars_monthly";
    return Number.isFinite(repo?.[key]) ? repo[key] : 0;
  }

  function badgeModel(repo, signal, period) {
    const streakDays = Number.isSafeInteger(signal?.streakDays) && signal.streakDays >= 2
      ? signal.streakDays
      : null;
    const starsChange = Number.isSafeInteger(signal?.starsChange) && Math.abs(signal.starsChange) >= 100
      ? signal.starsChange
      : null;
    return { streakDays, starsChange, hot: periodGain(repo, period) >= 1000 };
  }

  function touchCardAction({ activeIndex, cardIndex, tooltipOpen }) {
    return tooltipOpen && activeIndex === cardIndex ? "navigate" : "show";
  }

  return { tooltipLayout, periodGain, badgeModel, touchCardAction };
});
