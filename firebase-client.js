import { initializeApp } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js";
import {
  initializeAppCheck,
  ReCaptchaEnterpriseProvider,
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-app-check.js";
import {
  browserLocalPersistence,
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  setPersistence,
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
    "auth/internal-error": "Google 로그인 설정을 확인하지 못했어요. 잠시 후 다시 시도해 주세요.",
  };
  return messages[error?.code] || "Google 로그인에 실패했어요. 잠시 후 다시 시도해 주세요.";
}

function syncModeLabel(user) {
  return user ? "구글 계정 동기화" : "브라우저 동기화";
}

function setSyncStatus(element, user, detail = "", tone = "normal") {
  const label = syncModeLabel(user);
  element.textContent = detail && tone !== "normal" ? detail : label;
  element.title = detail || label;
  element.setAttribute?.("aria-label", detail ? `${label}. ${detail}` : label);
  if (element.dataset) element.dataset.tone = tone;
}

function validateFirebaseConfig(config) {
  if (config?.projectId !== "github-trending-nowwcastle") throw new Error("unexpected Firebase project");
  if (config?.authDomain !== "github-trending-nowwcastle.firebaseapp.com") throw new Error("unexpected Firebase auth domain");
  if (typeof config.appCheckSiteKey !== "string" || !config.appCheckSiteKey.trim()) {
    throw new Error("missing App Check site key");
  }
  return config;
}

let bootstrapGeneration = 0;

function setAccountPending(status, login, logout) {
  login.hidden = false;
  login.disabled = true;
  logout.hidden = true;
  logout.disabled = true;
  setSyncStatus(status, null, "로그인 준비 중이에요.", "notice");
}

function retainGuestMode(status, login, logout, message) {
  login.hidden = true;
  login.disabled = true;
  logout.hidden = true;
  logout.disabled = true;
  setSyncStatus(status, null, message, "error");
  globalThis.applyFavoriteState({ favorites: globalThis.favoriteController.favorites(), busy: false });
}

async function bootstrap() {
  const status = document.getElementById("syncStatus");
  const login = document.getElementById("loginBtn");
  const logout = document.getElementById("logoutBtn");
  const authLifecycle = globalThis.AuthLifecycle;
  const generation = ++bootstrapGeneration;
  if (typeof authLifecycle?.create !== "function") {
    retainGuestMode(status, login, logout, "로그인 기능을 초기화하지 못해 브라우저 저장으로 사용합니다.");
    return;
  }
  setAccountPending(status, login, logout);

  if (!globalThis.Favorites || !globalThis.FavoriteSync || !globalThis.favoriteController || !globalThis.applyFavoriteState) {
    retainGuestMode(status, login, logout, "로그인 기능을 초기화하지 못해 브라우저 저장으로 사용합니다.");
    return;
  }

  let app;
  let auth;
  let db;
  try {
    const response = await fetch(new URL("firebase-config.json", import.meta.url), { cache: "no-store" });
    if (!response.ok) throw new Error("Firebase configuration is unavailable");
    const config = validateFirebaseConfig(await response.json());
    app = initializeApp(config);
    await initializeAppCheck(app, {
      provider: new ReCaptchaEnterpriseProvider(config.appCheckSiteKey),
      isTokenAutoRefreshEnabled: true,
    });
  } catch {
    if (generation === bootstrapGeneration) {
      retainGuestMode(status, login, logout, "로그인 보안 기능을 초기화하지 못해 브라우저 저장으로 사용합니다.");
    }
    return;
  }

  try {
    db = getFirestore(app);
  } catch {
    if (generation === bootstrapGeneration) {
      retainGuestMode(status, login, logout, "로그인 기능을 초기화하지 못해 브라우저 저장으로 사용합니다.");
    }
    return;
  }

  try {
    auth = getAuth(app);
  } catch {
    if (generation === bootstrapGeneration) {
      retainGuestMode(status, login, logout, "로그인 기능을 초기화하지 못해 브라우저 저장으로 사용합니다.");
    }
    return;
  }

  try {
    await setPersistence(auth, browserLocalPersistence);
  } catch {
    if (generation === bootstrapGeneration) {
      retainGuestMode(status, login, logout, "이 브라우저에서 로그인 상태를 저장할 수 없어 브라우저 저장으로 사용합니다.");
    }
    return;
  }

  let busy = false;
  let authGeneration = 0;
  let controller;
  let stopAuth = () => {};
  let bundle;
  let lifecycle;
  let pendingUser;
  let hasPendingUser = false;

  const applyAuthState = async user => {
    if (!bundle.published || bundle.disposed) {
      pendingUser = user;
      hasPendingUser = true;
      return;
    }
    const capturedGeneration = ++authGeneration;
    login.hidden = Boolean(user);
    logout.hidden = !user;
    login.disabled = true;
    logout.disabled = true;
    try {
      await controller.setUser(user ? { uid: user.uid } : null);
      if (capturedGeneration !== authGeneration || bundle.disposed) return;
      setSyncStatus(status, user);
    } catch {
      if (capturedGeneration === authGeneration && !bundle.disposed) {
        setSyncStatus(status, user, "즐겨찾기 동기화를 시작하지 못했어요. 다시 로그인해 주세요.", "error");
      }
    } finally {
      if (capturedGeneration === authGeneration && !bundle.disposed) {
        login.disabled = Boolean(user);
        logout.disabled = !user;
      }
    }
  };

  const onLogin = async () => {
    login.disabled = true;
    login.textContent = "로그인 중…";
    setSyncStatus(status, null, "Google 로그인 창을 여는 중이에요.", "notice");
    try {
      await signInWithPopup(auth, bundle.provider);
    } catch (error) {
      setSyncStatus(status, null, authErrorMessage(error), "error");
    } finally {
      login.textContent = "Google로 로그인";
      if (!auth.currentUser && !bundle.disposed) login.disabled = false;
    }
  };

  const onLogout = async () => {
    logout.disabled = true;
    try {
      await signOut(auth);
    } catch {
      setSyncStatus(status, auth.currentUser, "로그아웃하지 못했어요. 잠시 후 다시 시도해 주세요.", "error");
      if (!bundle.disposed) logout.disabled = false;
    }
  };

  const restorePublishedState = () => {
    if (!bundle.published || bundle.disposed) return;
    const user = auth.currentUser;
    login.hidden = Boolean(user);
    logout.hidden = !user;
    login.disabled = Boolean(user);
    logout.disabled = !user;
    setSyncStatus(status, user);
    globalThis.applyFavoriteState({ favorites: controller.favorites(), busy });
  };

  bundle = {
    disposed: false,
    published: false,
    provider: null,
    dispose() {
      if (this.disposed) return;
      authGeneration += 1;
      this.disposed = true;
      stopAuth();
      controller?.dispose();
      login.removeEventListener("click", onLogin);
      logout.removeEventListener("click", onLogout);
      lifecycle?.stop();
    },
  };

  try {
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
    bundle.provider = new GoogleAuthProvider();
    controller = FavoriteSync.createController({
      storage: localStorage,
      cloud,
      onState: favorites => globalThis.applyFavoriteState({ favorites, busy }),
      onBusy: value => {
        busy = value;
        globalThis.applyFavoriteState({ favorites: controller.favorites(), busy });
      },
      onMessage: message => { setSyncStatus(status, auth.currentUser, message, "notice"); },
    });
    stopAuth = onAuthStateChanged(auth, user => { void applyAuthState(user); });
    login.addEventListener("click", onLogin);
    logout.addEventListener("click", onLogout);
    lifecycle = authLifecycle.create({
      target: globalThis,
      onDiscard: () => { bundle.dispose(); },
      onRestore: restorePublishedState,
    });
    lifecycle.start();
  } catch {
    bundle.dispose();
    if (generation === bootstrapGeneration) {
      retainGuestMode(status, login, logout, "로그인 기능을 초기화하지 못해 브라우저 저장으로 사용합니다.");
    }
    return;
  }

  if (generation !== bootstrapGeneration) {
    bundle.dispose();
    return;
  }

  const previous = globalThis.favoriteController;
  previous.dispose();
  globalThis.favoriteController = controller;
  bundle.published = true;
  restorePublishedState();
  if (hasPendingUser) void applyAuthState(pendingUser);
}

bootstrap();
