# Site polish round (2026-09-06)

Goal: raise the shipped site's quality on measurable axes without a redesign, adding no shipped file, keeping the page self-contained, and shipping through the normal W1 refresh.

Method (skills and agents used): Impeccable `critique` (Assessment A design review and Assessment B detector/browser evidence as isolated opus agents) and `audit` dimensions; ecc `a11y-architect`, `performance-optimizer`, `seo-specialist` read-only audits; Lighthouse baselines (desktop and mobile) from chrome-devtools; opus implementers in batches; fable adversarial review of the whole branch before the PR; karpathy-guidelines (assumptions explicit, surgical diffs, verified success criteria).

Baseline (production 98592ce, 2026-09-06 22:50 KST): Lighthouse accessibility 100 / SEO 100 / best-practices 77 on both devices; failed audits: CLS (measured 0.48 at a 412 px viewport, cause: `#badgeGuide` closed by JS after first paint), third-party cookies (reCAPTCHA/gapi loaded by the unconditional Firebase bootstrap), `label-content-name-mismatch` on `#mobileNavToggle`. `index.html` 841 KB of which the `REPOS` literal is 84 %.

## Batches (sequential, one implementer each, same checkout)

A. Head, first paint, quick a11y: canonical, descriptive title, og:site_name/locale, Twitter card, data-URI favicon, preconnect gstatic, JSON-LD WebSite+SearchAction, no-flash theme script with a single synced `theme-color`, badge-guide collapse moved before first paint (CLS), mobile toggle accessible name, `scroll-margin-top` on cards, hover text contrast, `aria-pressed` on the theme toggle, `aria-describedby` on the preset field, reduced-motion `scroll-behavior`.

B. Render cost and language of parts: drop `backdrop-filter` from list cards; fold the sparkline second pass into the single render pass; let `data/latest.json` use the server's `max-age=600` instead of `no-store`; `lang="en"` on repository names and the README tooltip heading; `lang` on `#readmeBody` per variant; raise the idle control border token to 3:1 in both themes (verified visually).

C. Lazy Firebase for anonymous visitors: bootstrap immediately only when a prior sign-in marker exists; otherwise the Sign-in button is enabled at once and the first click imports the client, awaits its `ready` promise, and continues into the popup. Removes reCAPTCHA/gapi and their cookies from anonymous loads. Guest favourites keep working. Failure path keeps today's "unavailable" message.

D. Crawlability: the generator writes a static `<noscript>` list of the day's repositories (name + GitHub link) and a JSON-LD `ItemList` inside new marked regions of `index.html`, from the same repos array it already renders into `REPOS`.

E. Design review findings (from Assessment A and B): only items that preserve the incumbent visual world; each with a before/after screenshot.

## Verification
- Per batch: the touched test files only (never the whole suite inside an implementer); controller runs the full node + python suites in PowerShell before the PR.
- Whole branch: fable review; Lighthouse desktop + mobile on a local static server before merge, then on production after W1 publishes; CLS measured with a layout-shift observer at 412 px and desktop; console clean.
- Deployment: PR (merge commit), W1 dispatch, production checks.

## Deferred with reasons
- Card `role="link"` (a11y M1): a link role on a container with nested interactive controls (star, hide, README) flattens them for screen readers; the nested `<a>` stays the real link.
- Splitting locale summaries out of `REPOS` (perf 6): needs a data-pipeline and shipped-file change; separate design.
- `og:image`, `robots.txt`, `sitemap.xml`, `404.html`: each needs a shipped file.
