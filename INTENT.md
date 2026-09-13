# GITHUB INSIGHT first-click login stability

## Facts

- The target is the static GitHub Pages application at `C:\Users\nasca\AppData\Local\Temp\gh-trending-page`.
- The source baseline for this worktree is `d6c65b3af8cf1ffb60325e81661c9540c143eaa9` on `main`.
- A clean public-browser reproduction showed that a first anonymous click waits for dynamic Firebase bootstrap before calling `signInWithPopup`, so no Google popup opens and the controls become visually inconsistent.
- The same public flow opened the popup after pointer prefetch, and closing that popup restored an actionable cancellation state.
- Existing Firebase Auth persistence, App Check, Firestore rules, guest storage, and popup login remain the selected architecture.

## Decision

This is a bounded bug fix. The anonymous first click prepares the Firebase client only. Once preparation finishes, the button is re-enabled with a localized retry message. A later user click invokes the Firebase module's own popup handler while user activation is fresh. Pointer and focus prefetch retain the current fast path.

## Scope

In scope:

- The deferred anonymous login boundary in `index.html`.
- Five-locale copy for the ready-to-retry state in `site-i18n.js`.
- Deterministic regression coverage in `tests/page-runtime.test.mjs` and `tests/site-i18n.test.mjs`.
- Local verification and source-level browser-flow validation.

Out of scope:

- Switching from popup authentication to redirect authentication.
- Changing Firebase project configuration, App Check policy, Firestore rules, or favorite data semantics.
- GitHub remote writes, deployment, or claiming the public site is fixed before a later release.
- Unrelated changes already present in the original checkout.

## Acceptance criteria

1. An anonymous first click never calls the popup entry point after an awaited client bootstrap.
2. Successful preparation re-enables the login button and exposes a non-empty localized retry message in English, Korean, Chinese, Spanish, and Japanese.
3. A subsequent click reaches the published Firebase login handler exactly once.
4. Existing auth, favorite-sync, page-runtime, locale, full Node, Python, JavaScript syntax, diff, and credential checks pass within their measured scope; this package defines no lint script.
5. The original public first-click reproduction is re-run against a released build before production-fix claims are made; this worktree alone does not satisfy that final release check.

## Unknowns

- A real Google account callback was not completed during diagnosis; popup opening and cancellation were tested without submitting credentials.
- App Check reCAPTCHA warnings and Google popup COOP warnings remain external-browser signals; they were not the cause of the first-click no-popup reproduction and are not changed by this patch.
