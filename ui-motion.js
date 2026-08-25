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
    if (viewport.width >= 900) {
      // 항상 우측 배치. 공간 부족 시 문서가 .wrap을 좌측으로 밀어 공간 확보(CSS transition으로 부드럽게).
      const x = Math.max(8, viewport.width - tooltip.width - 16);
      const y = clamp(card.top + card.height / 2 - tooltip.height / 2, 12, viewport.height - tooltip.height - 12);
      return { x, y };
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
    <h3>${escapeHtml(repo.name)}</h3><p class="tsub">${shortNumber(repo.stars)} ★ · ${escapeHtml(repo.lang)}</p>
    ${rows(ko, ["🎯 목표", "🛠 실행 방법", "👍 장점", "👎 단점·주의점", "💡 어울리는 상황"])}
    <p class="thint tip-actions">
      <button type="button" class="rdbtn js-readme" data-slug="${escapeHtml(repo.slug)}" data-name="${escapeHtml(repo.name)}">📖 README 전체 보기</button>
      <a class="rdbtn" href="https://github.com/${escapeHtml(repo.slug)}" target="_blank" rel="noopener">저장소 열기 ↗</a>
    </p>`;
  }

  return { tooltipPosition, touchCardAction, mobileSummary, mobileTooltipHtml };
});
