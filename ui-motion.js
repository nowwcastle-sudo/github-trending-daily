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
    const key = period === "daily" ? "stars_daily"
      : period === "weekly" ? "stars_weekly"
        : period === "monthly" ? "stars_monthly"
          : null;
    return key && Number.isFinite(repo?.[key]) ? repo[key] : null;
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

  function sidebarMode({ hoverCapable, trigger }) {
    return hoverCapable && trigger === "pointer" ? "hover" : "modal";
  }

  function startEdgeGesture({ x, y, sidebarOpen, withinSidebar, sidebarWidth = 1 }) {
    if (![x, y, sidebarWidth].every(Number.isFinite) || sidebarWidth <= 0) return null;
    if ((!sidebarOpen && x > 24) || (sidebarOpen && !withinSidebar)) return null;
    return {
      startX: x,
      startY: y,
      lastX: x,
      lastY: y,
      dx: 0,
      dy: 0,
      sidebarOpen: Boolean(sidebarOpen),
      sidebarWidth,
      state: "pending",
      progress: sidebarOpen ? 1 : 0,
      result: null,
    };
  }

  function updateEdgeGesture(gesture, { x, y }) {
    if (!gesture || gesture.result || !Number.isFinite(x) || !Number.isFinite(y)) {
      return { state: "cancelled", progress: gesture?.sidebarOpen ? 1 : 0 };
    }
    gesture.lastX = x;
    gesture.lastY = y;
    gesture.dx = x - gesture.startX;
    gesture.dy = y - gesture.startY;
    const absX = Math.abs(gesture.dx);
    const absY = Math.abs(gesture.dy);
    if (gesture.state === "pending" && absX > 8 && absX > absY * 1.2) {
      const intendedDirection = gesture.sidebarOpen ? gesture.dx < 0 : gesture.dx > 0;
      gesture.state = intendedDirection ? "horizontal" : "cancelled";
    } else if (gesture.state === "pending" && absY > 8 && absY > absX * 1.2) {
      gesture.state = "cancelled";
    }
    if (gesture.state === "horizontal") {
      const rawProgress = gesture.sidebarOpen
        ? 1 + gesture.dx / gesture.sidebarWidth
        : gesture.dx / gesture.sidebarWidth;
      gesture.progress = clamp(rawProgress, 0, 1);
    } else if (gesture.state === "cancelled") {
      gesture.progress = gesture.sidebarOpen ? 1 : 0;
    }
    return { state: gesture.state, progress: gesture.progress };
  }

  function finishEdgeGesture(gesture) {
    if (!gesture) return "cancel";
    if (gesture.result) return gesture.result;
    const opens = !gesture.sidebarOpen && gesture.state === "horizontal" && gesture.dx >= 48;
    const closes = gesture.sidebarOpen && gesture.state === "horizontal" && (gesture.dx <= -48 || gesture.progress <= 0.5);
    gesture.result = opens ? "open" : closes ? "close" : "cancel";
    if (gesture.result === "cancel") gesture.progress = gesture.sidebarOpen ? 1 : 0;
    return gesture.result;
  }

  function cancelEdgeGesture(gesture) {
    if (!gesture) return "cancel";
    gesture.state = "cancelled";
    gesture.progress = gesture.sidebarOpen ? 1 : 0;
    gesture.result = "cancel";
    return gesture.result;
  }

  return {
    tooltipLayout,
    periodGain,
    badgeModel,
    touchCardAction,
    sidebarMode,
    startEdgeGesture,
    updateEdgeGesture,
    finishEdgeGesture,
    cancelEdgeGesture,
  };
});
