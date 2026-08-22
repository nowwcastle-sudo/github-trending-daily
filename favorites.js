(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Favorites = api;
  root.parseFavs = api.parseFavs;
  root.isFav = api.isFav;
  root.toggleFav = api.toggleFav;
  root.filterRepos = api.filterRepos;
}(typeof globalThis === 'undefined' ? this : globalThis, function () {
  'use strict';

  const FAV_LIMIT = 500;
  const SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

  function isValidSlug(value) {
    return typeof value === 'string' && value.length <= 201 && SLUG_RE.test(value);
  }

  function normalizeFavs(value) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter(isValidSlug))].slice(0, FAV_LIMIT);
  }

  function readFavs(storage, key) {
    try { return normalizeFavs(JSON.parse(storage.getItem(key) || '[]')); }
    catch { return []; }
  }

  function writeFavs(storage, key, values) {
    const normalized = normalizeFavs(values);
    storage.setItem(key, JSON.stringify(normalized));
    return normalized;
  }

  function migrateLegacyFavs(storage) {
    let hasGuest;
    try { hasGuest = storage.getItem('gh-favs-guest') !== null; }
    catch { return []; }
    if (hasGuest) return readFavs(storage, 'gh-favs-guest');
    return writeFavs(storage, 'gh-favs-guest', readFavs(storage, 'gh-favs'));
  }

  function parseFavs(storage) {
    return readFavs(storage, 'gh-favs');
  }

  function isFav(storage, slug) {
    return parseFavs(storage).includes(slug);
  }

  function toggleFav(storage, slug) {
    if (!isValidSlug(slug)) return false;
    const favs = parseFavs(storage);
    const index = favs.indexOf(slug);
    if (index >= 0) favs.splice(index, 1);
    else favs.push(slug);
    const saved = writeFavs(storage, 'gh-favs', favs);
    return index < 0 && saved.includes(slug);
  }

  function filterRepos(repos, favSet, favOnly) {
    return favOnly ? repos.filter(repo => favSet.has(repo.slug)) : repos;
  }

  function periodFromButton(button) {
    return button?.dataset?.period || null;
  }

  return {
    isValidSlug,
    normalizeFavs,
    readFavs,
    writeFavs,
    migrateLegacyFavs,
    periodFromButton,
    parseFavs,
    isFav,
    toggleFav,
    filterRepos,
  };
}));
