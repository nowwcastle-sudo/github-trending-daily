import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  validateStarHistoryPayload,
  writeDerivedStarHistory,
} from "../scripts/update-star-history.mjs";

function payload(count = 2) {
  return {
    version: 1,
    generatedAt: "2026-08-28",
    repositories: Array.from({ length: count }, (_, index) => ({
      slug: `Owner/Repo-${index}`,
      estimated: [{ date: "2026-08-01", stars: index + 1 }],
      observed: [{ date: "2026-08-27", stars: index + 10 }],
    })),
  };
}

test("strict validator preserves public v1 casing and display order", () => {
  const value = payload();
  assert.deepEqual(validateStarHistoryPayload(value), value);
});

test("strict validator rejects shape, dates, unsafe integers, order, duplicates, and pre-cap overflow", () => {
  const cases = [];
  cases.push({ ...payload(), extra: true });
  cases.push({ ...payload(), generatedAt: "2026-02-30" });
  const unsafe = payload(); unsafe.repositories[0].observed[0].stars = Number.MAX_SAFE_INTEGER + 1; cases.push(unsafe);
  const unordered = payload(); unordered.repositories[0].observed = [{ date: "2026-08-27", stars: 1 }, { date: "2026-08-26", stars: 2 }]; cases.push(unordered);
  const duplicate = payload(); duplicate.repositories[1].slug = duplicate.repositories[0].slug.toLowerCase(); cases.push(duplicate);
  const estimated = payload(1); estimated.repositories[0].estimated = Array.from({ length: 501 }, (_, index) => ({ date: new Date(Date.UTC(2020, 0, index + 1)).toISOString().slice(0, 10), stars: index })); cases.push(estimated);
  const observed = payload(1); observed.repositories[0].observed = Array.from({ length: 731 }, (_, index) => ({ date: new Date(Date.UTC(2020, 0, index + 1)).toISOString().slice(0, 10), stars: index })); cases.push(observed);
  for (const value of cases) assert.throws(() => validateStarHistoryPayload(value), /star history/i);
});

test("candidate writer atomically writes only the supplied pre-derived payload", async t => {
  const root = await mkdtemp(join(tmpdir(), "derived-star-history-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outputPath = join(root, "star-history.json");
  const value = payload();
  const result = await writeDerivedStarHistory(value, outputPath);
  assert.equal(result.byteSize, Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`));
  assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), value);
  assert.deepEqual(await readdir(root), ["star-history.json"]);
});

test("writer never reads HTML, prior cache, or network and refuses the tracked output", async t => {
  const root = await mkdtemp(join(tmpdir(), "derived-star-history-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "index.html"), "SECRET_OLD_HTML", "utf8");
  await writeFile(join(root, "star-history.json"), "SECRET_STALE_CACHE", "utf8");
  const value = payload(1);
  await writeDerivedStarHistory(value, join(root, "star-history.json"));
  assert.deepEqual(JSON.parse(await readFile(join(root, "star-history.json"), "utf8")), value);
  await assert.rejects(writeDerivedStarHistory(value, resolve("star-history.json")), /candidate/i);
});

test("writer failures do not expose hostile values or absolute candidate paths", async t => {
  const root = await mkdtemp(join(tmpdir(), "derived-star-history-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sentinel = "HOSTILE_OUTPUT_VALUE_97d3";
  const outputPath = join(root, sentinel, "missing", "star-history.json");
  const error = await writeDerivedStarHistory(payload(1), outputPath).catch(value => value);
  assert.equal(error.message, "star history candidate write failed");
  for (const value of [sentinel, root]) {
    assert.equal(error.message.includes(value), false);
    assert.equal(error.stack.includes(value), false);
  }
});
