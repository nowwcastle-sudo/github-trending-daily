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

test("period gain preserves source zero and rejects all or missing values", async () => {
  const UiMotion = await loadUiMotion();
  const repo = { stars_daily: 0, stars_monthly: 4200 };

  assert.equal(UiMotion.periodGain(repo, "all"), null);
  assert.equal(UiMotion.periodGain(repo, "daily"), 0);
  assert.equal(UiMotion.periodGain(repo, "weekly"), null);
  assert.equal(UiMotion.periodGain(repo, "monthly"), 4200);
});

test("HOT follows only the selected period gain", async () => {
  const UiMotion = await loadUiMotion();
  const repo = { stars_daily: 1400, stars_weekly: 1400, stars_monthly: 4200 };

  assert.deepEqual(
    JSON.parse(JSON.stringify(UiMotion.badgeModel(repo, { streakDays: 3, starsChange: 250 }, "all"))),
    { streakDays: 3, starsChange: 250, hot: false },
  );
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

test("tooltip content has no viewport-specific formatter API", async () => {
  const UiMotion = await loadUiMotion();
  assert.equal(UiMotion.mobileSummary, undefined);
  assert.equal(UiMotion.mobileTooltipHtml, undefined);
});

test("sidebar mode separates passive hover from modal activation", async () => {
  const UiMotion = await loadUiMotion();
  assert.equal(typeof UiMotion.sidebarMode, "function");
  assert.equal(UiMotion.sidebarMode({ hoverCapable: true, trigger: "pointer" }), "hover");
  assert.equal(UiMotion.sidebarMode({ hoverCapable: true, trigger: "keyboard" }), "modal");
  assert.equal(UiMotion.sidebarMode({ hoverCapable: false, trigger: "pointer" }), "modal");
});

test("sidebar groups are a closed set and unknown values resolve to explore", async () => {
  const UiMotion = await loadUiMotion();
  assert.deepEqual([...UiMotion.SIDEBAR_GROUPS], ["account", "explore", "history", "export"]);
  assert.equal(typeof UiMotion.resolveSidebarGroup, "function");
  for (const group of UiMotion.SIDEBAR_GROUPS) assert.equal(UiMotion.resolveSidebarGroup(group), group);
  for (const bad of [undefined, null, "", "Explore", "filters", 0, {}, ["explore"]]) {
    assert.equal(UiMotion.resolveSidebarGroup(bad), "explore", `${JSON.stringify(bad)} must fall back to explore`);
  }
  // loadUiMotion() runs the module in its own vm context (a separate JS realm), so a thrown
  // TypeError there is not `instanceof` this file's TypeError even though the name matches -
  // match by message instead, mirroring the extensible-object pattern used elsewhere in this suite.
  assert.throws(() => { UiMotion.SIDEBAR_GROUPS.push("extra"); }, /extensible/i);
});

test("hover close grace is a single exported 500 ms constant", async () => {
  const UiMotion = await loadUiMotion();
  assert.equal(UiMotion.SIDEBAR_HOVER_CLOSE_DELAY_MS, 500);
});

test("mobile gesture starts only in 24px edge and commits after 48px horizontal intent", async () => {
  const UiMotion = await loadUiMotion();
  assert.equal(UiMotion.startEdgeGesture({ x: 25, y: 100, sidebarOpen: false, withinSidebar: false }), null);
  assert.equal(UiMotion.startEdgeGesture({ x: 12, y: 100, sidebarOpen: true, withinSidebar: false }), null);
  const gesture = UiMotion.startEdgeGesture({ x: 20, y: 100, sidebarOpen: false, withinSidebar: false, sidebarWidth: 320 });
  assert.equal(UiMotion.updateEdgeGesture(gesture, { x: 69, y: 105 }).state, "horizontal");
  assert.equal(UiMotion.finishEdgeGesture(gesture), "open");
});

test("vertical intent cancels without claiming native scroll", async () => {
  const UiMotion = await loadUiMotion();
  const gesture = UiMotion.startEdgeGesture({ x: 10, y: 100, sidebarOpen: false, withinSidebar: false, sidebarWidth: 320 });
  const update = UiMotion.updateEdgeGesture(gesture, { x: 18, y: 140 });
  assert.equal(update.state, "cancelled");
  assert.equal(update.progress, 0);
});

test("close threshold, short taps, and cancellation restore the exact prior state", async () => {
  const UiMotion = await loadUiMotion();
  const closing = UiMotion.startEdgeGesture({ x: 260, y: 100, sidebarOpen: true, withinSidebar: true, sidebarWidth: 320 });
  UiMotion.updateEdgeGesture(closing, { x: 211, y: 104 });
  assert.equal(UiMotion.finishEdgeGesture(closing), "close");

  const tap = UiMotion.startEdgeGesture({ x: 12, y: 100, sidebarOpen: false, withinSidebar: false, sidebarWidth: 320 });
  UiMotion.updateEdgeGesture(tap, { x: 16, y: 102 });
  assert.equal(UiMotion.finishEdgeGesture(tap), "cancel");
  assert.equal(tap.progress, 0);

  const cancelled = UiMotion.startEdgeGesture({ x: 260, y: 100, sidebarOpen: true, withinSidebar: true, sidebarWidth: 320 });
  UiMotion.updateEdgeGesture(cancelled, { x: 230, y: 102 });
  assert.equal(UiMotion.cancelEdgeGesture(cancelled), "cancel");
  assert.equal(UiMotion.cancelEdgeGesture(cancelled), "cancel");
  assert.equal(cancelled.sidebarOpen, true);
  assert.equal(cancelled.progress, 1);
});

test("gesture progress uses measured sidebar width and the 1.2 direction ratio", async () => {
  const UiMotion = await loadUiMotion();
  const measured = UiMotion.startEdgeGesture({ x: 10, y: 50, sidebarOpen: false, withinSidebar: false, sidebarWidth: 400 });
  assert.equal(UiMotion.updateEdgeGesture(measured, { x: 110, y: 55 }).progress, 0.25);

  const undecided = UiMotion.startEdgeGesture({ x: 10, y: 50, sidebarOpen: false, withinSidebar: false, sidebarWidth: 400 });
  assert.equal(UiMotion.updateEdgeGesture(undecided, { x: 22, y: 60 }).state, "pending");
  assert.equal(UiMotion.finishEdgeGesture(undecided), "cancel");

  const tenByNine = UiMotion.startEdgeGesture({ x: 10, y: 50, sidebarOpen: false, withinSidebar: false, sidebarWidth: 400 });
  assert.equal(UiMotion.updateEdgeGesture(tenByNine, { x: 20, y: 59 }).state, "pending");
  const nineByTwelve = UiMotion.startEdgeGesture({ x: 10, y: 50, sidebarOpen: false, withinSidebar: false, sidebarWidth: 400 });
  assert.equal(UiMotion.updateEdgeGesture(nineByTwelve, { x: 19, y: 62 }).state, "cancelled");
});

test("open commits at 48px while close accepts 48px or the measured midpoint", async () => {
  const UiMotion = await loadUiMotion();
  for (const [sidebarOpen, distance, expected] of [
    [false, 47, "cancel"],
    [false, 48, "open"],
    [true, -47, "cancel"],
    [true, -48, "close"],
  ]) {
    const startX = sidebarOpen ? 260 : 10;
    const gesture = UiMotion.startEdgeGesture({ x: startX, y: 100, sidebarOpen, withinSidebar: sidebarOpen, sidebarWidth: 400 });
    UiMotion.updateEdgeGesture(gesture, { x: startX + distance, y: 102 });
    assert.equal(UiMotion.finishEdgeGesture(gesture), expected);
  }

  const wideMidpoint = UiMotion.startEdgeGesture({ x: 260, y: 100, sidebarOpen: true, withinSidebar: true, sidebarWidth: 400 });
  UiMotion.updateEdgeGesture(wideMidpoint, { x: 60, y: 102 });
  assert.equal(wideMidpoint.progress, 0.5);
  assert.equal(UiMotion.finishEdgeGesture(wideMidpoint), "close");

  const narrowMidpoint = UiMotion.startEdgeGesture({ x: 80, y: 100, sidebarOpen: true, withinSidebar: true, sidebarWidth: 80 });
  UiMotion.updateEdgeGesture(narrowMidpoint, { x: 40, y: 102 });
  assert.equal(narrowMidpoint.progress, 0.5);
  assert.equal(UiMotion.finishEdgeGesture(narrowMidpoint), "close");
});

test("a pending upstream README variant updates only when it remains selected", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const variantHandler = html.match(/async function showReadmeVariant[\s\S]*?async function openReadme/m)?.[0] || "";

  assert.match(variantHandler, /state\.cache\.set\(id,html\);if\(state\.currentId===id\)setReadmeBody\(html\)/);
  assert.doesNotMatch(variantHandler, /currentId=variant\.id/);
});
