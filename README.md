# Mark Tracker (Web App)

Runs in any modern browser — iPhone/iPad (Safari), Android (Chrome), macOS,
and Windows — from the same three files. No app store, no install step
required, though it can be "installed" as an app icon (PWA).

Files: `index.html`, `app.js`, `manifest.json`, `sw.js`, `_headers` — keep them
together in one folder. (`SECURITY_AUDIT.md` and `generate-sri.sh` are for you,
not needed at runtime — see "Before you deploy" below.)

## Why it needs to be hosted (can't just double-click the file)

Browsers only allow camera/microphone access on pages loaded over **HTTPS**,
or on **http://localhost**. Opening `index.html` directly from disk
(`file://...`) will block the camera. Three easy ways to serve it:

### Option A — quick local test (same computer)
```bash
cd webapp
python3 -m http.server 8000
```
Open `http://localhost:8000` in your browser. Camera/mic will work here.
To test on your **phone**, it needs HTTPS (see Option B or C) — phones can't
reach your computer's `localhost`.

### Option B — free permanent hosting (recommended)
Drag the `webapp` folder onto **[Netlify Drop](https://app.netlify.com/drop)**
(no account needed for a quick link), or push it to a GitHub repo and enable
**GitHub Pages**. You'll get an `https://...` URL that works identically on
phone and desktop, and can be bookmarked / added to your home screen.

### Option C — host on your own network
Any static file host / web server (nginx, Vercel, Cloudflare Pages, an
existing school web server) works — just needs HTTPS.

## Before you deploy (one step)

This app has been through a security audit (`SECURITY_AUDIT.md`) and every
finding is fixed except one manual step that needs real internet access this
build environment didn't have:

```bash
chmod +x generate-sri.sh
./generate-sri.sh
```

This prints three `integrity="sha384-..."` values — paste each one onto the
matching `<script src="https://cdn...">` tag near the bottom of `index.html`
(they already have `crossorigin="anonymous"` set, just add `integrity`
alongside it). This "pins" the exact third-party code the app loads, so a
compromised or swapped CDN file would be rejected by the browser instead of
running silently.

`_headers` (security headers) is already included and will be picked up
automatically if you deploy to Netlify or Cloudflare Pages. On another host,
translate it to that platform's headers config (see `SECURITY_AUDIT.md` →
"M5" for the exact values).

## Installing as an app icon

- **iOS (Safari):** open the URL → Share button → "Add to Home Screen".
- **Android (Chrome):** open the URL → ⋮ menu → "Add to Home screen" / "Install app".
- **macOS/Windows (Chrome/Edge):** open the URL → install icon in the address bar → "Install".

Once installed it opens full-screen like a native app and keeps working
offline for the interface itself (camera, OCR, and Excel export all run
locally in the browser — no server, no data leaves the device).

## Using it

1. Pick the ink colour marks are circled in, and type the assessment name.
2. **Optional but recommended — import your existing name list / marking
   list:** tap **Import name list / marking list from Excel** and choose your
   `.xlsx`/`.xls`/`.csv` file. The app reads the header row, guesses which
   columns are Name / ID / Mark, and shows dropdowns so you can confirm or
   correct them (pick "+ Add new column" for Mark if the file doesn't have
   one yet). Tap **Use these columns** — your roster now powers the picker,
   autocomplete, and voice matching below, and marks will be written straight
   back into that same file when you export.
   - No Excel file? Paste a plain `Name, ID` list instead, one per line.
3. Pick the student from the **roster dropdown** (fastest), or type/speak
   their name/ID — say "Jane Doe, S1023" into **🎤 Speak name & ID**; if it
   mishears you, a "Did you mean…" suggestion appears when close to a roster
   name.
4. Tap **Open camera** and frame the circled mark. As soon as the guide
   spots a matching coloured region, a small live badge shows a quick,
   provisional reading of the mark right on the video feed — so you can see
   what it's picking up before anything is captured or saved. With
   **Auto-capture** on (default), the guide turns solid green once that
   match holds steady, and the photo fires itself about two-thirds of a
   second later; the app then re-reads the captured photo carefully (more
   accurately than the live preview) and shows that as the final result.
   Prefer to control the timing yourself? Turn Auto-capture off and tap the
   shutter button manually — the live reading badge still helps you aim.
   Can't find it automatically? Drag to select the mark by hand instead.
5. Confirm or correct the mark, then **Save record**. With auto-advance on
   (default), it jumps straight to the next un-recorded student and reopens
   the camera — no extra taps between students.
   - **Skip review toggle:** turn on "Skip review — auto-save the mark once
     confidently detected" and the app briefly flashes the detected mark
     (so you can still see what it read) then saves it automatically,
     without waiting for a tap — as long as a student is already selected
     and the OCR confidence is reasonably high. Low-confidence reads always
     fall back to manual confirm, so nothing gets silently mis-recorded.
   - **Grading mode:** tap "▶ Start grading mode" for a full-screen version
     of this loop — student name/ID, camera, and mark confirmation all in
     one screen with a progress counter ("12 of 28"), a dashed guide to help
     you frame the circled mark, and auto-advance/auto-save switched on
     automatically for the session. Tap ✕ to exit back to the normal view;
     your previous auto-advance/skip-review settings are restored.
6. Tap **Export Excel** any time:
   - If you imported a file, this **writes each mark into a copy of that
     same file** (into the column you chose), leaving every other column and
     row untouched, and downloads it as `<original name>_graded.xlsx`.
   - If you didn't import a file, it downloads a fresh spreadsheet with
     Name, ID, Assessment, Mark, and Timestamp for every record.

Note: the imported Excel file itself is only kept in memory for the current
browser session (not saved to local storage, since files can be large) — if
you reload the page, re-import the file before your final export. The roster
names/IDs do persist across reloads.

## Compatibility notes

- **Camera:** works on all major mobile and desktop browsers, given HTTPS/
  localhost and camera permission.
- **OCR:** runs fully on-device via Tesseract.js (WebAssembly) — first run
  downloads the OCR model (~2–5 MB, then cached).
- **Voice input:** uses the Web Speech API. Supported on Chrome (Android/
  desktop) and Edge. **Not supported on iOS Safari** — on iPhone/iPad, tap
  the microphone key on the on-screen keyboard instead when the Name/ID
  fields are focused (this uses Apple's own dictation and works fine).
- **Data storage:** records are kept in the browser's local storage, per
  device/browser. If you need one shared tracker across multiple devices,
  export to Excel regularly and merge, or ask me to add a shared backend.
- **Writing into an existing Excel file:** cell values, column layout, and
  other sheets/data are preserved. Complex original formatting (custom
  colours, borders, merged cells, conditional formatting) may not be
  perfectly preserved on write-back, since that uses the free/open-source
  SheetJS engine — double check the downloaded file looks right.

## Tips for reliable detection

- Circle marks clearly in a colour that doesn't otherwise appear on the page.
- Good lighting and a flat, well-framed page improve OCR accuracy.
- If detection misses, you can always type the mark manually — nothing is lost.
