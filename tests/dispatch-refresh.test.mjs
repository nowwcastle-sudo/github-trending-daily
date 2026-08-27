import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readCandidateManifestFromDownload, selectNewDispatchRun, validateDispatchReceipt } from "../scripts/dispatch-refresh.mjs";

const sha = "a".repeat(40);
const prior = [{ databaseId: 10, headSha: sha, event: "workflow_dispatch" }];

test("dispatch selects exactly one new workflow-dispatch run for the expected head", () => {
  const match = { databaseId: 11, headSha: sha, event: "workflow_dispatch", url: "https://example.test/runs/11" };
  assert.deepEqual(selectNewDispatchRun(prior, [...prior, match], sha), match);
});

test("dispatch rejects zero or two same-head new runs", () => {
  assert.throws(() => selectNewDispatchRun(prior, prior, sha), /zero matching/i);
  assert.throws(() => selectNewDispatchRun(prior, [
    ...prior,
    { databaseId: 11, headSha: sha, event: "workflow_dispatch" },
    { databaseId: 12, headSha: sha, event: "workflow_dispatch" },
  ], sha), /multiple matching/i);
});

test("dispatch receipt is one exact provenance envelope", () => {
  const receipt = {
    runId: 11,
    headSha: sha,
    sourceSha: "b".repeat(40),
    snapshotId: "20260826100700-0123456789abcdef",
    manifestSha256: "c".repeat(64),
    url: "https://example.test/runs/11",
  };
  assert.deepEqual(validateDispatchReceipt(receipt), receipt);
  assert.throws(() => validateDispatchReceipt({ ...receipt, extra: true }), /receipt/i);
  assert.throws(() => validateDispatchReceipt({ ...receipt, sourceSha: "main" }), /receipt/i);
});

test("download reader extracts only one manifest from the immutable Pages tar", async t => {
  const directory = await mkdtemp(join(tmpdir(), "dispatch-artifact-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "source");
  const download = join(directory, "download");
  await mkdir(source); await mkdir(download);
  const bytes = Buffer.from('{"version":1}\n');
  await writeFile(join(source, "deployment-manifest.json"), bytes);
  await writeFile(join(source, "index.html"), "<html></html>\n");
  const tar = spawnSync("tar", ["-c", "-f", join(download, "artifact.tar"), "-C", source, "."], { encoding: "utf8" });
  assert.equal(tar.status, 0, tar.stderr);
  assert.deepEqual(await readCandidateManifestFromDownload(download), bytes);
  await writeFile(join(download, "deployment-manifest.json"), bytes);
  await assert.rejects(readCandidateManifestFromDownload(download), /exactly one/i);
});
