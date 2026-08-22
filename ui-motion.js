(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.UiMotion = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function tooltipPosition({ card, viewport, tooltip }) {
    const rightRailX = card.right + 18;
    if (viewport.width >= 900 && rightRailX + tooltip.width <= viewport.width - 8) {
      return {
        x: rightRailX,
        y: clamp(card.top + card.height / 2 - tooltip.height / 2, 12, viewport.height - tooltip.height - 12),
      };
    }

    let y;
    if (card.top > tooltip.height + 24 || card.top > viewport.height - card.bottom) {
      y = Math.max(8, card.top - tooltip.height - 10);
    } else {
      y = card.bottom + 10;
      if (y + tooltip.height > viewport.height - 8) y = Math.max(8, card.top - tooltip.height - 10);
    }
    return {
      x: clamp(card.left, 8, viewport.width - tooltip.width - 8),
      y,
    };
  }

  return { tooltipPosition };
});
