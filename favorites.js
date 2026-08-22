// Favorites logic — DOM-free for testability. Storage injected.
function parseFavs(storage) {
  try { const v = JSON.parse(storage.getItem('gh-favs') || '[]'); return Array.isArray(v) ? v : []; }
  catch { return []; }
}
function isFav(storage, slug) {
  return parseFavs(storage).includes(slug);
}
function toggleFav(storage, slug) {
  const favs = parseFavs(storage);
  const i = favs.indexOf(slug);
  if (i >= 0) favs.splice(i, 1); else favs.push(slug);
  storage.setItem('gh-favs', JSON.stringify(favs));
  return i < 0; // true = now favorited
}
function filterRepos(repos, favSet, favOnly) {
  return favOnly ? repos.filter(r => favSet.has(r.slug)) : repos;
}
if (typeof module !== 'undefined') module.exports = { parseFavs, isFav, toggleFav, filterRepos };
