(function (root, factory) {
  const helper = root.Favorites || (typeof require !== 'undefined' ? require('./favorites.js') : null);
  if (!helper) throw new Error('Favorites helper is required');
  const api = factory(helper);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FavoriteSync = api;
}(typeof globalThis === 'undefined' ? this : globalThis, function (Favorites) {
  'use strict';

  const LIMIT = 500;

  function validUnique(values) {
    if (!Array.isArray(values)) return [];
    // Repository slugs are canonical UI values: identity is exact and case-sensitive.
    return [...new Set(values.filter(Favorites.isValidSlug))];
  }

  function checked(values) {
    const normalized = validUnique(values);
    if (normalized.length > LIMIT) throw new Error('favorites cannot exceed 500');
    return normalized;
  }

  function createController({ storage, cloud, onState = () => {}, onBusy = () => {}, onMessage = () => {} }) {
    let current = Favorites.readFavs(storage, 'gh-favs-guest');
    let uid = null;
    let busy = false;
    let generation = 0;
    let revision = 0;
    let unsubscribe = null;
    let disposed = false;

    function isCurrent(capturedGeneration, capturedUid) {
      return !disposed && generation === capturedGeneration && uid === capturedUid;
    }

    function setCurrent(values) {
      current = checked(values);
      revision += 1;
      onState([...current]);
    }

    function setBusy(value) {
      busy = value;
      onBusy(value);
    }

    function stopWatching() {
      if (!unsubscribe) return;
      const stop = unsubscribe;
      unsubscribe = null;
      try { stop(); }
      catch { onMessage('이전 즐겨찾기 구독을 정리하지 못했어요.', 'error'); }
    }

    function writeCache(accountUid, values) {
      try { Favorites.writeFavs(storage, `gh-favs-cache:${accountUid}`, values); }
      catch { /* The cloud remains canonical when the optional cache is unavailable. */ }
    }

    function watch(capturedGeneration, capturedUid) {
      try {
        const stop = cloud.watch(capturedUid, values => {
          if (!isCurrent(capturedGeneration, capturedUid)) return;
          try {
            const normalized = checked(values);
            setCurrent(normalized);
            writeCache(capturedUid, normalized);
          } catch {
            onMessage('동기화된 즐겨찾기 데이터가 올바르지 않아요.', 'error');
          }
        }, () => {
          if (isCurrent(capturedGeneration, capturedUid)) {
            onMessage('즐겨찾기 실시간 동기화가 중단되었어요.', 'error');
          }
        });
        if (isCurrent(capturedGeneration, capturedUid) && typeof stop === 'function') unsubscribe = stop;
        else if (typeof stop === 'function') stop();
      } catch {
        if (isCurrent(capturedGeneration, capturedUid)) {
          onMessage('즐겨찾기 실시간 동기화를 시작하지 못했어요.', 'error');
        }
      }
    }

    async function setUser(user) {
      if (disposed) throw new Error('favorite synchronization is disposed');
      const nextUid = user === null ? null : user?.uid;
      if (nextUid !== null && (typeof nextUid !== 'string' || !nextUid)) throw new Error('invalid favorite user');

      generation += 1;
      const capturedGeneration = generation;
      stopWatching();
      uid = nextUid;

      if (!uid) {
        setBusy(false);
        setCurrent(Favorites.readFavs(storage, 'gh-favs-guest'));
        return;
      }

      const capturedUid = uid;
      setBusy(true);
      setCurrent([]);
      try {
        const imported = storage.getItem(`gh-favs-imported:${capturedUid}`) === '1';

        let remote;
        try {
          remote = checked(await cloud.read(capturedUid));
        } catch (error) {
          if (!isCurrent(capturedGeneration, capturedUid)) return;
          if (!imported) throw error;
          const cached = Favorites.readFavs(storage, `gh-favs-cache:${capturedUid}`);
          setCurrent(cached);
          watch(capturedGeneration, capturedUid);
          onMessage('클라우드를 읽지 못해 이 계정의 마지막 저장 상태를 표시해요.', 'error');
          return;
        }
        if (!isCurrent(capturedGeneration, capturedUid)) return;

        let accepted = remote;
        if (!imported) {
          accepted = checked([
            ...Favorites.readFavs(storage, 'gh-favs-guest'),
            ...remote,
          ]);
          await cloud.replace(capturedUid, accepted);
          if (!isCurrent(capturedGeneration, capturedUid)) return;
          storage.setItem(`gh-favs-imported:${capturedUid}`, '1');
        }
        if (!isCurrent(capturedGeneration, capturedUid)) return;
        setCurrent(accepted);
        writeCache(capturedUid, accepted);
        watch(capturedGeneration, capturedUid);
      } finally {
        if (isCurrent(capturedGeneration, capturedUid)) setBusy(false);
      }
    }

    async function toggle(slug) {
      if (disposed) throw new Error('favorite synchronization is disposed');
      if (!Favorites.isValidSlug(slug)) throw new Error('invalid favorite slug');
      if (busy) throw new Error('favorites are still synchronizing');
      const before = [...current];
      const adding = !before.includes(slug);
      if (adding && before.length >= LIMIT) throw new Error('favorites cannot exceed 500');
      setCurrent(adding ? [...before, slug] : before.filter(value => value !== slug));
      const optimisticRevision = revision;

      if (!uid) {
        try {
          Favorites.writeFavs(storage, 'gh-favs-guest', current);
          return adding;
        } catch (error) {
          if (revision === optimisticRevision) setCurrent(before);
          onMessage('즐겨찾기를 저장하지 못해 이전 상태로 되돌렸어요.', 'error');
          throw error;
        }
      }

      const capturedGeneration = generation;
      const capturedUid = uid;
      try {
        await (adding ? cloud.add(capturedUid, slug) : cloud.remove(capturedUid, slug));
        if (isCurrent(capturedGeneration, capturedUid)) writeCache(capturedUid, current);
        return adding;
      } catch (error) {
        if (isCurrent(capturedGeneration, capturedUid)) {
          if (revision === optimisticRevision) setCurrent(before);
          onMessage('즐겨찾기를 동기화하지 못해 이전 상태로 되돌렸어요.', 'error');
        }
        throw error;
      }
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      uid = null;
      busy = false;
      stopWatching();
    }

    return {
      setUser,
      toggle,
      favorites: () => [...current],
      mode: () => uid ? 'account' : 'guest',
      dispose,
    };
  }

  return { createController };
}));
