import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function loadUiMotion() {
  try {
    const source = await readFile(new URL("../ui-motion.js", import.meta.url), "utf8");
    const context = { globalThis: null };
    context.globalThis = context;
    vm.runInNewContext(source, context);
    return context.UiMotion || {};
  } catch {
    return {};
  }
}

test("tooltip stays beside the card without shifting when the natural rail fits", async () => {
  const UiMotion = await loadUiMotion();
  assert.equal(typeof UiMotion.tooltipLayout, "function");

  assert.deepEqual(
    JSON.parse(JSON.stringify(UiMotion.tooltipLayout({
      card: { left: 594, right: 1326, top: 291, bottom: 612, width: 732, height: 321 },
      viewport: { width: 1920, height: 1000 },
      tooltip: { width: 560, height: 738 },
    }))),
    { mode: "rail", shift: 0, x: 1344, y: 83 },
  );
});

test("tooltip shifts the list by only the missing rail width", async () => {
  const UiMotion = await loadUiMotion();
  assert.equal(typeof UiMotion.tooltipLayout, "function");

  assert.deepEqual(
    JSON.parse(JSON.stringify(UiMotion.tooltipLayout({
      card: { left: 354, right: 1086, top: 291, bottom: 612, width: 732, height: 321 },
      viewport: { width: 1440, height: 1000 },
      tooltip: { width: 560, height: 738 },
    }))),
    { mode: "rail", shift: -240, x: 864, y: 291 },
  );
});

test("compact desktop shifts the fixed-width list only enough to open a tooltip rail", async () => {
  const UiMotion = await loadUiMotion();
  const layout = UiMotion.tooltipLayout({
    card: { left: 234, right: 866, top: 291, bottom: 612, width: 632, height: 321 },
    viewport: { width: 1100, height: 800 },
    tooltip: { width: 400, height: 500 },
  });

  assert.deepEqual(
    JSON.parse(JSON.stringify(layout)),
    { mode: "rail", shift: -200, x: 684, y: 291 },
  );
});

test("overlay layout stays near the active card when a rail cannot fit", async () => {
  const UiMotion = await loadUiMotion();
  const layout = UiMotion.tooltipLayout({
    card: { left: 134, right: 866, top: 291, bottom: 612, width: 732, height: 321 },
    viewport: { width: 1000, height: 800 },
    tooltip: { width: 420, height: 500 },
  });

  assert.deepEqual(
    JSON.parse(JSON.stringify(layout)),
    { mode: "overlay", shift: 0, x: 446, y: 288 },
  );
});

test("badge signals use one non-overlapping gain window", async () => {
  const UiMotion = await loadUiMotion();
  const repo = { stars_daily: 350, stars_weekly: 1400, stars_monthly: 4200 };

  assert.equal(UiMotion.periodGain(repo, "all"), 350);
  assert.equal(UiMotion.periodGain(repo, "weekly"), 1400);
  assert.deepEqual(
    JSON.parse(JSON.stringify(UiMotion.badgeModel(repo, { streakDays: 3, starsChange: 250 }, "weekly"))),
    { streakDays: 3, starsChange: 250, hot: true },
  );
});

test("a touch card opens its summary before the same card is allowed to navigate", async () => {
  const UiMotion = await loadUiMotion();
  assert.equal(typeof UiMotion.touchCardAction, "function");

  assert.equal(UiMotion.touchCardAction({
    activeIndex: null,
    cardIndex: 3,
    tooltipOpen: false,
  }), "show");
  assert.equal(UiMotion.touchCardAction({
    activeIndex: 3,
    cardIndex: 3,
    tooltipOpen: true,
  }), "navigate");
  assert.equal(UiMotion.touchCardAction({
    activeIndex: 3,
    cardIndex: 4,
    tooltipOpen: true,
  }), "show");
});

test("mobile summary offers Korean source fields and a concise English version", async () => {
  const UiMotion = await loadUiMotion();
  assert.equal(typeof UiMotion.mobileSummary, "function");
  const repo = {
    name: "owner / project",
    desc: "A useful developer tool.",
    lang: "TypeScript",
    stars_daily: 42,
    summary: {
      goal: "한국어 목표",
      usage: "한국어 사용법",
      pros: "한국어 장점",
      cons: "한국어 주의점",
      fit: "한국어 추천 대상",
    },
  };

  assert.deepEqual(
    JSON.parse(JSON.stringify(UiMotion.mobileSummary(repo, "ko"))),
    repo.summary,
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(UiMotion.mobileSummary(repo, "en"))),
    {
      goal: "A useful developer tool.",
      usage: "Check the repository README for setup and usage instructions.",
      pros: "It gained 42 stars in today's public GitHub Trending data.",
      cons: "This summary uses the public description and GitHub metadata; check the README for full details and limitations.",
      fit: "Useful for people exploring TypeScript repositories.",
    },
  );
});

test("English mobile summary does not relabel a non-English description as English", async () => {
  const UiMotion = await loadUiMotion();
  const summary = UiMotion.mobileSummary({
    name: "owner / project",
    desc: "개발자를 위한 유용한 도구",
    lang: "TypeScript",
    stars_daily: 7,
    summary: { goal: "한국어 목표" },
  }, "en");

  assert.equal(summary.goal, "owner / project is a public TypeScript repository on GitHub.");
});

test("mobile tooltip renders Korean summary and keeps README and repository actions", async () => {
  const UiMotion = await loadUiMotion();
  assert.equal(typeof UiMotion.mobileTooltipHtml, "function");
  const html = UiMotion.mobileTooltipHtml({
    slug: "owner/project",
    name: "owner / project",
    desc: "A useful developer tool.",
    lang: "TypeScript",
    stars: 1234,
    stars_daily: 42,
    summary: {
      goal: "한국어 목표",
      usage: "한국어 사용법",
      pros: "한국어 장점",
      cons: "한국어 주의점",
      fit: "한국어 추천 대상",
    },
  });

  // ko/en tabs were moved to the README side panel (2026-08 approved spec)
  assert.doesNotMatch(html, /data-tip-lang/);
  assert.doesNotMatch(html, /data-tip-panel/);
  assert.match(html, /한국어 목표/);
  assert.match(html, /class="rdbtn js-readme"[^>]*data-slug="owner\/project"/);
  assert.match(html, /href="https:\/\/github\.com\/owner\/project"/);
  assert.match(html, /class="rdbtn js-hide-repo"[^>]*data-slug="owner\/project"[^>]*>관심 없음<\/button>/);
});

test("a pending Korean tab updates when its translation resolves without forcing a tab switch", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const translationHandler = html.match(/fetch\(`translations\/[\s\S]*?\.catch\(\(\)=>\{/m)?.[0] || "";

  assert.match(translationHandler, /koHTML=_ko;koState="ok";\s*if\(document\.querySelector\("\.rp-tabs \[aria-pressed=true\]"\)\.id==="tabKo"\)\s*setReadmeBody\(koHTML\)/);
  assert.doesNotMatch(translationHandler, /setTab\("ko"\)/);
});
