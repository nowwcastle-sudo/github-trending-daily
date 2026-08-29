(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.CurrentViewExport = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
  const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  const PERIODS = new Set(["all", "daily", "weekly", "monthly"]);
  const SORTS = new Set(["trending", "gain", "stars", "pushed", "release"]);
  const MEMBERSHIP = new Set(["baseline_present", "new", "reentered", "stayed"]);
  const URL_KEYS = new Set(["period", "sort", "view", "lang", "field", "tag", "exclude", "membership", "q"]);
  const CSV_COLUMNS = [
    "slug", "name", "description", "language", "topics", "stars", "forks", "issues",
    "contributors", "period_gain", "pushed_at", "latest_release", "membership_status",
  ];

  function checkedTime(value) {
    if (typeof value !== "string" || !TIME_RE.test(value) || new Date(value).toISOString() !== value) {
      throw new Error("invalid export timestamp");
    }
    return value;
  }

  function text(value) {
    return typeof value === "string" ? value : "";
  }

  function nullableText(value) {
    return typeof value === "string" && value ? value : null;
  }

  function number(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  function stringList(value) {
    return Array.isArray(value) ? value.filter(item => typeof item === "string") : [];
  }

  function checkedMembershipStatus(value) {
    const status = value === "baseline" ? "baseline_present" : value;
    if (!MEMBERSHIP.has(status)) throw new Error("current export membership status is invalid");
    return status;
  }

  function checkedSourceUrl(value) {
    let url;
    try { url = new URL(value); }
    catch { throw new Error("invalid export source URL"); }
    const membership = url.searchParams.getAll("membership");
    if (
      !["https:", "http:"].includes(url.protocol)
      || url.username || url.password || url.hash
      || [...url.searchParams.keys()].some(key => !URL_KEYS.has(key))
      || membership.length > 1
      || (membership.length === 1 && membership[0] !== "new")
    ) {
      throw new Error("export source URL must use whitelisted state");
    }
    return url.href;
  }

  function normalizedFilters(value = {}) {
    return {
      view: value.favOnly === true ? "favorites" : "all",
      period: PERIODS.has(value.period) ? value.period : "all",
      lang: typeof value.lang === "string" ? value.lang : "",
      field: [...new Set(stringList(value.fields))],
      tag: [...new Set(stringList(value.forms))],
      excludeAi: value.excludeAi === true,
      newOnly: value.newOnly === true,
      q: typeof value.q === "string" && value.q.length <= 120 ? value.q : "",
      sort: SORTS.has(value.sort) ? value.sort : "trending",
    };
  }

  function buildModel({ repositories, state, sourceUrl, exportedAt, membershipStatus, gainOf }) {
    if (!Array.isArray(repositories) || repositories.length > 75) {
      throw new Error("current export must contain 0-75 repositories");
    }
    if (!(membershipStatus instanceof Map) || typeof gainOf !== "function") {
      throw new Error("current export helpers are invalid");
    }
    const seen = new Set();
    const publicRepositories = repositories.map(repository => {
      const slug = repository?.slug;
      if (typeof slug !== "string" || slug.length > 201 || !SLUG_RE.test(slug) || seen.has(slug.toLowerCase())) {
        throw new Error("current export repository identity is invalid");
      }
      seen.add(slug.toLowerCase());
      const status = membershipStatus.get(slug.toLowerCase());
      return {
        slug,
        name: text(repository.name),
        description: text(repository.desc),
        language: text(repository.lang),
        topics: stringList(repository.topics),
        stars: number(repository.stars),
        forks: number(repository.forks),
        issues: number(repository.issues),
        contributors: number(repository.contributors),
        periodGain: number(gainOf(repository)),
        pushedAt: nullableText(repository.pushed_at),
        latestRelease: nullableText(repository.latest_release),
        membershipStatus: checkedMembershipStatus(status),
      };
    });
    return {
      schemaVersion: 1,
      exportedAt: checkedTime(exportedAt),
      sourceUrl: checkedSourceUrl(sourceUrl),
      filters: normalizedFilters(state),
      resultCount: publicRepositories.length,
      repositories: publicRepositories,
    };
  }

  function toJson(model) {
    try { return `${JSON.stringify(model, null, 2)}\n`; }
    catch { throw new Error("JSON export serialization failed"); }
  }

  function formulaRisk(value) {
    return /^[\t\r\n]/.test(value) || /^[ \t\r\n]*[=+\-@]/.test(value);
  }

  function csvCell(value) {
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    if (value === null || value === undefined) return "";
    let output = String(value);
    const defended = formulaRisk(output);
    if (defended) output = `'${output}`;
    if (defended || /[",\r\n]/.test(output)) return `"${output.replace(/"/g, '""')}"`;
    return output;
  }

  function toCsv(model) {
    if (!model || model.schemaVersion !== 1 || !Array.isArray(model.repositories) || model.repositories.length > 75) {
      throw new Error("invalid CSV export model");
    }
    const rows = model.repositories.map(repository => [
      repository.slug,
      repository.name,
      repository.description,
      repository.language,
      Array.isArray(repository.topics) ? repository.topics.join(" | ") : "",
      repository.stars,
      repository.forks,
      repository.issues,
      repository.contributors,
      repository.periodGain,
      repository.pushedAt,
      repository.latestRelease,
      repository.membershipStatus,
    ].map(csvCell).join(","));
    return `\uFEFF${CSV_COLUMNS.join(",")}\r\n${rows.length ? `${rows.join("\r\n")}\r\n` : ""}`;
  }

  function buildSourceUrl(locationLike, state, serializeState) {
    if (
      !locationLike || typeof locationLike.origin !== "string" || typeof locationLike.pathname !== "string"
      || typeof serializeState !== "function"
    ) {
      throw new Error("export source URL must use whitelisted state");
    }
    const query = serializeState(state);
    if (typeof query !== "string" || (query && !query.startsWith("?"))) {
      throw new Error("export source URL must use whitelisted state");
    }
    return checkedSourceUrl(`${locationLike.origin}${locationLike.pathname}${query}`);
  }

  function fileName(extension, exportedAt) {
    const date = checkedTime(exportedAt).slice(0, 10);
    if (!new Set(["csv", "json"]).has(extension)) throw new Error("invalid export file type");
    return `github-trending-current-${date}.${extension}`;
  }

  function downloadText({
    text: payload,
    filename,
    mimeType,
    documentRef = globalThis.document,
    urlApi = globalThis.URL,
    BlobCtor = globalThis.Blob,
    schedule = callback => globalThis.setTimeout(callback, 1000),
  }) {
    let objectUrl = null;
    let anchor = null;
    try {
      if (
        typeof payload !== "string" || typeof filename !== "string" || typeof mimeType !== "string"
        || !documentRef?.body || typeof documentRef.createElement !== "function"
        || typeof urlApi?.createObjectURL !== "function" || typeof urlApi?.revokeObjectURL !== "function"
        || typeof BlobCtor !== "function" || typeof schedule !== "function"
      ) {
        throw new Error("invalid download environment");
      }
      const blob = new BlobCtor([payload], { type: mimeType });
      objectUrl = urlApi.createObjectURL(blob);
      anchor = documentRef.createElement("a");
      anchor.href = objectUrl;
      anchor.download = filename;
      documentRef.body.appendChild(anchor);
      anchor.click();
    } catch {
      throw new Error("download failed");
    } finally {
      try { anchor?.remove(); } catch {}
      if (objectUrl !== null) {
        try {
          schedule(() => {
            try { urlApi.revokeObjectURL(objectUrl); } catch {}
          });
        } catch {
          try { urlApi.revokeObjectURL(objectUrl); } catch {}
        }
      }
    }
  }

  async function copyText(value, clipboard = globalThis.navigator?.clipboard) {
    try {
      if (typeof value !== "string" || typeof clipboard?.writeText !== "function") throw new Error("unavailable");
      await clipboard.writeText(value);
    } catch {
      throw new Error("Clipboard copy failed");
    }
  }

  return {
    CSV_COLUMNS: [...CSV_COLUMNS],
    buildModel,
    toJson,
    csvCell,
    toCsv,
    buildSourceUrl,
    fileName,
    downloadText,
    copyText,
  };
});
