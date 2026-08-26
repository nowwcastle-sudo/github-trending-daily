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

  function mobileSummary(repo, locale) {
    if (locale === "ko") return repo.summary;
    const gain = Number.isFinite(repo.stars_daily)
      ? { count: repo.stars_daily, period: "today's" }
      : Number.isFinite(repo.stars_weekly)
        ? { count: repo.stars_weekly, period: "this week's" }
        : { count: repo.stars_monthly || 0, period: "this month's" };
    const language = repo.lang || "open-source";
    const description = repo.desc?.trim() || "";
    const letters = description.match(/\p{L}/gu) || [];
    const latinLetters = description.match(/[A-Za-z]/g) || [];
    const goal = letters.length > 0 && latinLetters.length / letters.length >= .8
      ? description
      : `${repo.name} is a public ${language} repository on GitHub.`;
    return {
      goal,
      usage: "Check the repository README for setup and usage instructions.",
      pros: `It gained ${gain.count.toLocaleString("en-US")} stars in ${gain.period} public GitHub Trending data.`,
      cons: "This summary uses the public description and GitHub metadata; check the README for full details and limitations.",
      fit: `Useful for people exploring ${language} repositories.`,
    };
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function shortNumber(value) {
    return value >= 10000 ? `${(value / 1000).toFixed(0)}k`
      : value >= 1000 ? `${(value / 1000).toFixed(1)}k`
        : String(value);
  }

  function mobileTooltipHtml(repo) {
    const ko = mobileSummary(repo, "ko");
    const rows = (summary, labels) => ["goal", "usage", "pros", "cons", "fit"]
      .map((key, index) => `<div class="trow"><span class="tlabel">${labels[index]}</span><p>${escapeHtml(summary[key])}</p></div>`)
      .join("");
    return `
    <h2>${escapeHtml(repo.name)}</h2><p class="tsub">${shortNumber(repo.stars)} ★ · ${escapeHtml(repo.lang)}</p>
    ${rows(ko, ["🎯 목표", "🛠 실행 방법", "👍 장점", "👎 단점·주의점", "💡 어울리는 상황"])}
    <p class="thint tip-actions">
      <button type="button" class="rdbtn js-readme" data-slug="${escapeHtml(repo.slug)}" data-name="${escapeHtml(repo.name)}">📖 README 전체 보기</button>
      <a class="rdbtn" href="https://github.com/${escapeHtml(repo.slug)}" target="_blank" rel="noopener">저장소 열기 ↗</a>
      <button type="button" class="rdbtn js-hide-repo" data-slug="${escapeHtml(repo.slug)}">관심 없음</button>
    </p>`;
  }

  return { tooltipLayout, periodGain, badgeModel, touchCardAction, mobileSummary, mobileTooltipHtml };
});
