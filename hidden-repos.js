(function (root, factory) {
  const Favorites = root.Favorites || (typeof require !== "undefined" ? require("./favorites.js") : null);
  if (!Favorites) throw new Error("Favorites helper is required");
  const api = factory(Favorites);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HiddenRepos = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (Favorites) {
  "use strict";

  const STORAGE_KEY = "gh-hidden-repos-v1";

  function read(storage) {
    try { return Favorites.normalizeFavs(JSON.parse(storage.getItem(STORAGE_KEY) || "[]")); }
    catch { return []; }
  }

  function write(storage, values) {
    const normalized = Favorites.normalizeFavs(values);
    storage.setItem(STORAGE_KEY, JSON.stringify(normalized));
    return normalized;
  }

  function hide(storage, slug) {
    if (!Favorites.isValidSlug(slug)) throw new Error("invalid hidden repository slug");
    const hidden = read(storage);
    if (hidden.includes(slug)) return hidden;
    if (hidden.length >= 500) throw new Error("hidden repositories cannot exceed 500");
    return write(storage, [...hidden, slug]);
  }

  function restore(storage, slug) {
    if (!Favorites.isValidSlug(slug)) throw new Error("invalid hidden repository slug");
    return write(storage, read(storage).filter(value => value !== slug));
  }

  function restoreAll(storage) {
    return write(storage, []);
  }

  function filterRepos(repos, hiddenSet) {
    return repos.filter(repo => !hiddenSet.has(repo.slug));
  }

  return { read, hide, restore, restoreAll, filterRepos };
});
