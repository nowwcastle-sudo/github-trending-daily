import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";


async function loadCurrentViewExport() {
  const source = await readFile(new URL("../current-view-export.js", import.meta.url), "utf8");
  const context = { globalThis: null, Map, URL };
  context.globalThis = context;
  vm.runInNewContext(source, context);
  return context.CurrentViewExport;
}

const CurrentViewExport = await loadCurrentViewExport();


function repository(slug, overrides = {}) {
  return {
    slug,
    name: slug,
    desc: `Description for ${slug}`,
    lang: "JavaScript",
    topics: ["export", "testing"],
    stars: 100,
    forks: 10,
    issues: 2,
    contributors: 3,
    pushed_at: "2026-08-26",
    latest_release: null,
    ...overrides,
  };
}

function modelOptions(repositories) {
  const membershipStatus = new Map(repositories.map(repo => [repo.slug.toLowerCase(), "stayed"]));
  if (membershipStatus.has("owner/second")) membershipStatus.set("owner/second", "reentered");
  return {
    repositories,
    state: {
      favOnly: true,
      period: "weekly",
      lang: "JavaScript",
      fields: ["dev-tools"],
      forms: ["cli"],
      excludeAi: true,
      newOnly: false,
      q: "export",
      sort: "stars",
    },
    sourceUrl: "https://example.test/trending/?period=weekly&sort=stars&view=favorites&lang=JavaScript&field=dev-tools&tag=cli&exclude=ai&q=export",
    exportedAt: "2026-08-26T12:34:56.789Z",
    membershipStatus,
    gainOf: repo => repo.slug === "owner/second" ? 22 : 11,
  };
}

test("membership output uses only the canonical public statuses", () => {
  const repositories = [
    repository("owner/legacy-baseline"),
    repository("owner/current-baseline"),
    repository("owner/new"),
    repository("owner/reentered"),
    repository("owner/stayed"),
  ];
  const options = modelOptions(repositories);
  options.membershipStatus = new Map([
    ["owner/legacy-baseline", "baseline"],
    ["owner/current-baseline", "baseline_present"],
    ["owner/new", "new"],
    ["owner/reentered", "reentered"],
    ["owner/stayed", "stayed"],
  ]);

  const model = CurrentViewExport.buildModel(options);
  assert.deepEqual(
    model.repositories.map(repo => repo.membershipStatus),
    ["baseline_present", "baseline_present", "new", "reentered", "stayed"],
  );
  const json = CurrentViewExport.toJson(model);
  const csv = CurrentViewExport.toCsv(model);
  assert.equal((json.match(/"membershipStatus": "baseline_present"/g) ?? []).length, 2);
  assert.doesNotMatch(json, /"membershipStatus": "baseline"/);
  assert.equal((csv.match(/,baseline_present\r\n/g) ?? []).length, 2);
  assert.doesNotMatch(csv, /,baseline\r\n/);
});

test("membership export fails closed for missing or unknown status", () => {
  for (const status of [undefined, "unknown"]) {
    const repositories = [repository("owner/repo")];
    const options = modelOptions(repositories);
    options.membershipStatus = status === undefined
      ? new Map()
      : new Map([["owner/repo", status]]);
    assert.throws(
      () => CurrentViewExport.buildModel(options),
      /membership status is invalid/,
    );
  }
});

test("new-only export state allows only the exact membership=new URL value", () => {
  const repositories = [repository("owner/repo")];
  const options = modelOptions(repositories);
  options.state = { ...options.state, newOnly: true };
  options.sourceUrl = "https://example.test/trending/?membership=new";

  const model = CurrentViewExport.buildModel(options);
  assert.equal(model.filters.newOnly, true);
  assert.equal(model.sourceUrl, "https://example.test/trending/?membership=new");

  const location = { origin: "https://example.test", pathname: "/trending/" };
  assert.equal(
    CurrentViewExport.buildSourceUrl(location, options.state, () => "?membership=new"),
    "https://example.test/trending/?membership=new",
  );
  for (const query of ["?membership=stayed", "?membership=", "?membership=NEW", "?membership=new&membership=new"]) {
    assert.throws(
      () => CurrentViewExport.buildSourceUrl(location, options.state, () => query),
      /whitelisted/,
    );
  }
});

test("model preserves the exact visible order and exposes only the public contract", () => {
  const visible = [repository("owner/second"), repository("owner/first")];
  const model = CurrentViewExport.buildModel(modelOptions(visible));
  const serialized = CurrentViewExport.toJson(model);
  const plainModel = JSON.parse(serialized);

  assert.equal(plainModel.schemaVersion, 1);
  assert.equal(plainModel.exportedAt, "2026-08-26T12:34:56.789Z");
  assert.equal(plainModel.resultCount, 2);
  assert.deepEqual(plainModel.filters, {
    view: "favorites",
    period: "weekly",
    lang: "JavaScript",
    field: ["dev-tools"],
    tag: ["cli"],
    excludeAi: true,
    newOnly: false,
    q: "export",
    sort: "stars",
  });
  assert.deepEqual(plainModel.repositories.map(repo => repo.slug), ["owner/second", "owner/first"]);
  assert.deepEqual(plainModel.repositories.map(repo => repo.periodGain), [22, 11]);
  assert.deepEqual(plainModel.repositories.map(repo => repo.membershipStatus), ["reentered", "stayed"]);
  assert.deepEqual(Object.keys(plainModel.repositories[0]), [
    "slug", "name", "description", "language", "topics", "stars", "forks", "issues",
    "contributors", "periodGain", "pushedAt", "latestRelease", "membershipStatus",
  ]);
  const parsed = plainModel;
  for (const privateName of ["uid", "favorites", "hidden", "localStorage"]) {
    assert.equal(Object.hasOwn(parsed, privateName), false);
    assert.equal(Object.hasOwn(parsed.filters, privateName), false);
  }
  for (const privateValue of ["owner/private", "gh-favs", "gh-hidden"]) {
    assert.doesNotMatch(serialized, new RegExp(privateValue, "i"));
  }
});

test("empty and 75-item exports keep count and order without coercing public values", () => {
  const empty = CurrentViewExport.buildModel(modelOptions([]));
  assert.equal(empty.resultCount, 0);
  assert.deepEqual(empty.repositories, []);

  const repositories = Array.from({ length: 75 }, (_, index) => repository(`owner/repo-${index}`, {
    desc: `${"긴 한글 필드 ".repeat(40)}${index}`,
    stars: index === 0 ? "100" : index,
  }));
  const large = CurrentViewExport.buildModel(modelOptions(repositories));
  assert.equal(large.resultCount, 75);
  assert.equal(large.repositories[0].stars, null);
  assert.equal(large.repositories[74].slug, "owner/repo-74");
  assert.throws(
    () => CurrentViewExport.buildModel(modelOptions([...repositories, repository("owner/repo-75")])) ,
    /0-75/,
  );
});

test("CSV uses documented columns, UTF-8 BOM, RFC-style quoting, and formula defense", () => {
  const dangerous = repository("owner/danger", {
    name: "  +SUM(A1:A2)",
    desc: "=1+1, \"quoted\"\r\n다음 줄",
    lang: "\t@command",
    topics: ["comma,value", "quote\"value", "줄\n바꿈"],
    stars: 123,
  });
  const model = CurrentViewExport.buildModel(modelOptions([dangerous]));
  const csv = CurrentViewExport.toCsv(model);

  assert.ok(csv.startsWith("\uFEFFslug,name,description,language,topics,stars,forks,issues,contributors,period_gain,pushed_at,latest_release,membership_status\r\n"));
  assert.match(csv, /"'  \+SUM\(A1:A2\)"/);
  assert.match(csv, /"'=1\+1, ""quoted""\r\n다음 줄"/);
  assert.match(csv, /"'\t@command"/);
  assert.match(csv, /"comma,value \| quote""value \| 줄\n바꿈"/);
  assert.match(csv, /,123,10,2,3,11,/);
  assert.ok(csv.endsWith("\r\n"));

  for (const value of ["-2+3", " @SUM(A1)", "\rcommand", "\ncommand", "+1", "@cmd"]) {
    assert.ok(CurrentViewExport.csvCell(value).startsWith("'" ) || CurrentViewExport.csvCell(value).startsWith("\"'"));
  }
  assert.equal(CurrentViewExport.csvCell(42), "42");
});

test("JSON serialization reports a bounded failure and never leaks the raw exception", () => {
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => CurrentViewExport.toJson(cyclic), error => {
    assert.equal(error.message, "JSON export serialization failed");
    assert.doesNotMatch(error.message, /circular|cyclic/i);
    return true;
  });
});

test("source URL is rebuilt only from the whitelisted state", () => {
  const location = {
    origin: "https://example.test",
    pathname: "/trending/",
    search: "?uid=secret&hidden=owner/private",
    hash: "#favorites=secret",
  };
  const state = modelOptions([]).state;
  const url = CurrentViewExport.buildSourceUrl(location, state, value => {
    assert.equal(value, state);
    return "?period=weekly&sort=stars&view=favorites&field=dev-tools&tag=cli&exclude=ai&q=export";
  });

  assert.equal(url, "https://example.test/trending/?period=weekly&sort=stars&view=favorites&field=dev-tools&tag=cli&exclude=ai&q=export");
  assert.doesNotMatch(url, /uid|hidden|localStorage|#|owner%2Fprivate/i);
  assert.throws(
    () => CurrentViewExport.buildSourceUrl(location, state, () => "?uid=secret"),
    /whitelisted/,
  );
});

test("download helper removes anchors immediately and revokes Blob URLs after the click task", () => {
  const clicked = [];
  const removed = [];
  const appended = [];
  const revoked = [];
  const scheduled = [];
  const blobs = [];
  let sequence = 0;
  const documentRef = {
    body: { appendChild: anchor => appended.push(anchor) },
    createElement: tag => ({
      tag,
      click() { clicked.push(this.download); },
      remove() { removed.push(this.download); },
    }),
  };
  class BlobCtor {
    constructor(parts, options) { this.parts = parts; this.options = options; blobs.push(this); }
  }
  const urlApi = {
    createObjectURL: () => `blob:test-${++sequence}`,
    revokeObjectURL: value => revoked.push(value),
  };

  for (const filename of ["one.csv", "two.json"]) {
    CurrentViewExport.downloadText({
      text: "payload",
      filename,
      mimeType: "text/plain",
      documentRef,
      urlApi,
      BlobCtor,
      schedule: callback => scheduled.push(callback),
    });
  }
  assert.deepEqual(clicked, ["one.csv", "two.json"]);
  assert.deepEqual(removed, ["one.csv", "two.json"]);
  assert.equal(appended.length, 2);
  assert.deepEqual(revoked, []);
  assert.equal(scheduled.length, 2);
  scheduled.splice(0).forEach(callback => callback());
  assert.deepEqual(revoked, ["blob:test-1", "blob:test-2"]);
  assert.equal(blobs.length, 2);

  documentRef.createElement = () => ({
    click() { throw new Error("injected click denial"); },
    remove() { removed.push("failed"); },
  });
  assert.throws(() => CurrentViewExport.downloadText({
    text: "payload",
    filename: "failed.csv",
    mimeType: "text/plain",
    documentRef,
    urlApi,
    BlobCtor,
    schedule: callback => scheduled.push(callback),
  }), /download failed/);
  assert.equal(removed.at(-1), "failed");
  assert.equal(scheduled.length, 1);
  scheduled.shift()();
  assert.equal(revoked.at(-1), "blob:test-3");
});

test("clipboard success and denial use an explicit bounded contract", async () => {
  const writes = [];
  await CurrentViewExport.copyText("https://example.test/view", { writeText: async value => writes.push(value) });
  assert.deepEqual(writes, ["https://example.test/view"]);
  await assert.rejects(
    CurrentViewExport.copyText("https://example.test/view", { writeText: async () => { throw new Error("raw permission detail"); } }),
    error => {
      assert.equal(error.message, "Clipboard copy failed");
      assert.doesNotMatch(error.message, /raw permission detail/);
      return true;
    },
  );
  await assert.rejects(CurrentViewExport.copyText("x", null), /Clipboard copy failed/);
});
