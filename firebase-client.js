import { initializeApp } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js";
import {
  arrayRemove,
  arrayUnion,
  doc,
  getDoc,
  getFirestore,
  onSnapshot,
  runTransaction,
  serverTimestamp,
  setDoc,
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js";

function checkedFavorites(values) {
  if (!Array.isArray(values)) return [];
  const normalized = [...new Set(values.filter(Favorites.isValidSlug))];
  if (normalized.length > 500) throw new Error("favorites cannot exceed 500");
  return normalized;
}

function createCloudAdapter(db, sdk) {
  const reference = uid => sdk.doc(db, "users", uid);
  return {
    async read(uid) {
      const snapshot = await sdk.getDoc(reference(uid));
      return snapshot.exists() ? checkedFavorites(snapshot.data().favorites) : [];
    },
    async importUnion(uid, guestFavorites) {
      const guest = checkedFavorites(guestFavorites);
      return sdk.runTransaction(db, async transaction => {
        const userReference = reference(uid);
        const snapshot = await transaction.get(userReference);
        const remote = snapshot.exists() ? checkedFavorites(snapshot.data().favorites) : [];
        const merged = checkedFavorites([...guest, ...remote]);
        transaction.set(userReference, { favorites: merged, updatedAt: sdk.serverTimestamp() });
        return merged;
      });
    },
    async add(uid, slug) {
      await sdk.setDoc(reference(uid), {
        favorites: sdk.arrayUnion(slug),
        updatedAt: sdk.serverTimestamp(),
      }, { merge: true });
    },
    async remove(uid, slug) {
      await sdk.setDoc(reference(uid), {
        favorites: sdk.arrayRemove(slug),
        updatedAt: sdk.serverTimestamp(),
      }, { merge: true });
    },
    watch(uid, next, error) {
      return sdk.onSnapshot(reference(uid), { includeMetadataChanges: true }, snapshot => {
        next(snapshot.exists() ? snapshot.data().favorites : [], snapshot.metadata.hasPendingWrites);
      }, error);
    },
  };
}

function authErrorMessage(error) {
  const messages = {
    "auth/popup-blocked": "팝업이 차단됐어요. 팝업을 허용한 뒤 다시 시도해 주세요.",
    "auth/popup-closed-by-user": "Google 로그인이 취소됐어요.",
    "auth/cancelled-popup-request": "이미 Google 로그인 창을 여는 중이에요.",
    "auth/network-request-failed": "네트워크 문제로 Google 로그인에 실패했어요.",
    "auth/unauthorized-domain": "이 사이트 주소에서는 Google 로그인을 사용할 수 없어요.",
  };
  return messages[error?.code] || "Google 로그인에 실패했어요. 잠시 후 다시 시도해 주세요.";
}

async function bootstrap() {
  if (!globalThis.Favorites || !globalThis.FavoriteSync || !globalThis.favoriteController || !globalThis.applyFavoriteState) {
    throw new Error("favorite synchronization is unavailable");
  }

  const response = await fetch(new URL("firebase-config.json", import.meta.url), { cache: "no-store" });
  if (!response.ok) throw new Error("Firebase configuration is unavailable");
  const config = await response.json();
  if (config?.projectId !== "github-trending-nowwcastle") throw new Error("unexpected Firebase project");

  const app = initializeApp(config);
  const auth = getAuth(app);
  const db = getFirestore(app);
  const provider = new GoogleAuthProvider();
  const cloud = createCloudAdapter(db, {
    arrayRemove,
    arrayUnion,
    doc,
    getDoc,
    onSnapshot,
    runTransaction,
    serverTimestamp,
    setDoc,
  });
  const status = document.getElementById("syncStatus");
  const login = document.getElementById("loginBtn");
  const logout = document.getElementById("logoutBtn");
  let busy = false;
  let authGeneration = 0;
  let controller;

  controller = FavoriteSync.createController({
    storage: localStorage,
    cloud,
    onState: favorites => globalThis.applyFavoriteState({ favorites, busy }),
    onBusy: value => {
      busy = value;
      globalThis.applyFavoriteState({ favorites: controller.favorites(), busy });
    },
    onMessage: message => { status.textContent = message; },
  });

  const previous = globalThis.favoriteController;
  previous.dispose();
  globalThis.favoriteController = controller;

  const stopAuth = onAuthStateChanged(auth, async user => {
    const capturedGeneration = ++authGeneration;
    login.hidden = Boolean(user);
    logout.hidden = !user;
    login.disabled = true;
    logout.disabled = true;
    try {
      await controller.setUser(user ? { uid: user.uid } : null);
      if (capturedGeneration !== authGeneration) return;
      status.textContent = user
        ? `즐겨찾기: ${user.displayName || "Google 계정"}과 동기화`
        : "즐겨찾기: 이 브라우저";
    } catch {
      if (capturedGeneration === authGeneration) {
        status.textContent = "즐겨찾기 동기화를 시작하지 못했어요. 다시 로그인해 주세요.";
      }
    } finally {
      if (capturedGeneration === authGeneration) {
        login.disabled = Boolean(user);
        logout.disabled = !user;
      }
    }
  });

  login.addEventListener("click", async () => {
    login.disabled = true;
    status.textContent = "Google 로그인 창을 여는 중이에요.";
    try {
      await signInWithPopup(auth, provider);
    } catch (error) {
      status.textContent = authErrorMessage(error);
    } finally {
      if (!auth.currentUser) login.disabled = false;
    }
  });

  logout.addEventListener("click", async () => {
    logout.disabled = true;
    try {
      await signOut(auth);
    } catch {
      status.textContent = "로그아웃하지 못했어요. 잠시 후 다시 시도해 주세요.";
      logout.disabled = false;
    }
  });

  addEventListener("pagehide", () => {
    authGeneration += 1;
    stopAuth();
    controller.dispose();
  }, { once: true });
}

function keepGuestMode() {
  const status = document.getElementById("syncStatus");
  const login = document.getElementById("loginBtn");
  const logout = document.getElementById("logoutBtn");
  status.textContent = "Google 동기화를 사용할 수 없어 이 브라우저에 저장합니다.";
  login.hidden = true;
  logout.hidden = true;
  globalThis.applyFavoriteState({ favorites: globalThis.favoriteController.favorites(), busy: false });
}

bootstrap().catch(keepGuestMode);
