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

test("tooltip placement uses its measured width before choosing the right rail", async () => {
  const UiMotion = await loadUiMotion();
  assert.equal(typeof UiMotion.tooltipPosition, "function");

  assert.deepEqual(
    JSON.parse(JSON.stringify(UiMotion.tooltipPosition({
      card: { left: 347, right: 1079, top: 281, bottom: 556, width: 732, height: 275 },
      viewport: { width: 1440, height: 1000 },
      tooltip: { width: 560, height: 820 },
    }))),
    { x: 347, y: 8 },
  );
});

test("tooltip placement uses the right rail when the measured box fits", async () => {
  const UiMotion = await loadUiMotion();
  assert.equal(typeof UiMotion.tooltipPosition, "function");

  assert.deepEqual(
    JSON.parse(JSON.stringify(UiMotion.tooltipPosition({
      card: { left: 120, right: 900, top: 200, bottom: 400, width: 780, height: 200 },
      viewport: { width: 1600, height: 900 },
      tooltip: { width: 560, height: 500 },
    }))),
    { x: 918, y: 50 },
  );
});

test("a pending Korean tab updates when its translation resolves without forcing a tab switch", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const translationHandler = html.match(/fetch\(`translations\/[\s\S]*?\.catch\(\(\)=>\{/m)?.[0] || "";

  assert.match(translationHandler, /koHTML=_ko;koState="ok";\s*if\(document\.querySelector\("\.rp-tabs \[aria-pressed=true\]"\)\.id==="tabKo"\)\s*setReadmeBody\(koHTML\)/);
  assert.doesNotMatch(translationHandler, /setTab\("ko"\)/);
});
