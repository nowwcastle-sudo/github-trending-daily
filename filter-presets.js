(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FilterPresets = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const PRESETS_KEY = "gi.presets";
  const PRESET_LIMIT = 20;
  const NAME_LIMIT = 40;
  const QUERY_LIMIT = 512;

  function normalizeName(value) {
    return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, NAME_LIMIT) : "";
  }

  // A preset is exactly what RepoFilters.serializeState returns: "" for the default view, or a
  // query string beginning with "?". Nothing else is storable, so nothing else is applied.
  function isValidQuery(value) {
    return typeof value === "string" && value.length <= QUERY_LIMIT && (value === "" || value.startsWith("?"));
  }

  function normalizeList(value) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    const presets = [];
    for (const entry of value) {
      const name = normalizeName(entry?.name);
      if (!name || seen.has(name) || !isValidQuery(entry?.query)) return [];
      seen.add(name);
      presets.push({ name, query: entry.query });
    }
    return presets.slice(0, PRESET_LIMIT);
  }

  function read(storage) {
    try { return normalizeList(JSON.parse(storage.getItem(PRESETS_KEY) || "[]")); }
    catch { return []; }
  }

  function write(storage, presets) {
    storage.setItem(PRESETS_KEY, JSON.stringify(presets));
    return presets;
  }

  function save(storage, { name, query }) {
    const cleanName = normalizeName(name);
    if (!cleanName) throw new Error("preset name is required");
    if (!isValidQuery(query)) throw new Error("invalid preset query");
    const presets = read(storage);
    const index = presets.findIndex(preset => preset.name === cleanName);
    if (index >= 0) return write(storage, presets.map((preset, position) => position === index ? { name: cleanName, query } : preset));
    if (presets.length >= PRESET_LIMIT) throw new Error("presets cannot exceed 20");
    return write(storage, [...presets, { name: cleanName, query }]);
  }

  function remove(storage, name) {
    const cleanName = normalizeName(name);
    return write(storage, read(storage).filter(preset => preset.name !== cleanName));
  }

  return { PRESETS_KEY, PRESET_LIMIT, NAME_LIMIT, QUERY_LIMIT, normalizeName, isValidQuery, read, save, remove };
});
