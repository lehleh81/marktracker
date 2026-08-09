const STORAGE_KEY = 'markTrackerRecords';
const ROSTER_KEY = 'markTrackerRoster';
let records = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
let roster = JSON.parse(localStorage.getItem(ROSTER_KEY) || '[]'); // [{name, id}]
let fuse = null;

// Excel import / write-back state (session-only — the source workbook
// itself isn't persisted across page reloads, only the derived roster is).
let importedWorkbook = null;
let importedSheetName = null;
let importedFileName = 'marks.xlsx';
let importedHeaders = [];
let importedRows = [];
let colMap = { name: -1, id: -1, mark: -1 };
let markColHeader = '';

const el = id => document.getElementById(id);
const video = el('video');
const frameCanvas = el('frameCanvas');
let stream = null;
let capturedCanvas = null; // pristine full-res photo, used for both auto-detect and manual crop

// ==========================================================================
// Roster: import, fuzzy matching, autocomplete, auto-advance
// ==========================================================================

function rebuildFuse() {
  fuse = roster.length
    ? new Fuse(roster, { keys: ['name', 'id'], threshold: 0.4, includeScore: true })
    : null;
}

function refreshRosterUI() {
  // Datalist and dropdown are rebuilt with createElement/textContent (not
  // innerHTML) so a roster name from an imported file can never be
  // interpreted as HTML/script (prevents stored XSS).

  // datalist for typed autocomplete
  const dl = el('rosterNamesList');
  dl.innerHTML = '';
  roster.forEach(r => {
    const opt = document.createElement('option');
    opt.value = r.name;
    dl.appendChild(opt);
  });

  // dropdown picker, marking students already recorded for the current assessment
  const assessment = el('assessment').value.trim() || 'Assessment';
  const recordedIds = new Set(
    records.filter(r => r.assessment === assessment).map(r => r.id)
  );
  const picker = el('rosterPicker');
  const prev = picker.value;
  picker.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '— select student —';
  picker.appendChild(placeholder);
  roster.forEach((r, i) => {
    const done = recordedIds.has(r.id);
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = `${done ? '✓ ' : ''}${r.name} (${r.id})`;
    picker.appendChild(opt);
  });
  picker.value = prev;
}

el('saveRosterBtn').addEventListener('click', () => {
  const lines = el('rosterInput').value.split('\n').map(l => l.trim()).filter(Boolean);
  const parsed = lines.map(line => {
    const [name, id] = line.split(',').map(s => (s || '').trim());
    return { name, id: id || '' };
  }).filter(r => r.name);
  if (!parsed.length) {
    el('rosterStatus').textContent = 'No valid rows found. Use one "Name, ID" per line.';
    el('rosterStatus').className = 'status err';
    return;
  }
  roster = parsed;
  localStorage.setItem(ROSTER_KEY, JSON.stringify(roster));
  rebuildFuse();
  refreshRosterUI();
  el('rosterStatus').textContent = `Saved ${roster.length} student(s).`;
  el('rosterStatus').className = 'status ok';
});

el('clearRosterBtn').addEventListener('click', () => {
  roster = [];
  fuse = null;
  localStorage.removeItem(ROSTER_KEY);
  el('rosterInput').value = '';
  importedWorkbook = null;
  importedSheetName = null;
  importedHeaders = [];
  importedRows = [];
  colMap = { name: -1, id: -1, mark: -1 };
  markColHeader = '';
  el('excelFileInput').value = '';
  el('excelMapWrap').classList.add('hidden');
  el('excelStatus').textContent = '';
  el('exportBtn').textContent = '⬇️ Export Excel';
  refreshRosterUI();
  el('rosterStatus').textContent = 'Roster cleared.';
  el('rosterStatus').className = 'status';
});

// ==========================================================================
// Import roster / marking list from an existing Excel (or CSV) file, and
// write marks straight back into a copy of that same file.
// ==========================================================================

function populateColumnSelects() {
  // Header text comes straight from the uploaded spreadsheet, so this is
  // built with createElement/textContent (not innerHTML) to prevent a
  // crafted column header from being interpreted as HTML/script.
  function buildOptions(extra) {
    const frag = document.createDocumentFragment();
    if (extra) {
      const opt = document.createElement('option');
      opt.value = extra.value;
      opt.textContent = extra.label;
      frag.appendChild(opt);
    }
    importedHeaders.forEach((h, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = h || ('Column ' + String.fromCharCode(65 + i));
      frag.appendChild(opt);
    });
    return frag;
  }

  const nameSel = el('nameColSelect');
  nameSel.innerHTML = '';
  nameSel.appendChild(buildOptions());

  const idSel = el('idColSelect');
  idSel.innerHTML = '';
  idSel.appendChild(buildOptions({ value: '', label: '— none —' }));

  const markSel = el('markColSelect');
  markSel.innerHTML = '';
  markSel.appendChild(buildOptions());
  const newOpt = document.createElement('option');
  newOpt.value = 'new';
  newOpt.textContent = '+ Add new column';
  markSel.appendChild(newOpt);
}

const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024; // 5 MB — generous for a class list, guards against a huge/adversarial file hanging the tab

el('excelFileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  if (file.size > MAX_IMPORT_FILE_BYTES) {
    el('excelStatus').textContent = `That file is ${(file.size / 1e6).toFixed(1)} MB — please use a file under ${(MAX_IMPORT_FILE_BYTES / 1e6).toFixed(0)} MB (a class list shouldn't need to be larger).`;
    el('excelStatus').className = 'status err';
    e.target.value = '';
    return;
  }

  try {
    const buf = await file.arrayBuffer();
    let wb;
    if (/\.csv$/i.test(file.name)) {
      wb = XLSX.read(new TextDecoder().decode(buf), { type: 'string' });
    } else {
      wb = XLSX.read(buf, { type: 'array', cellStyles: true });
    }
    importedWorkbook = wb;
    importedFileName = file.name.replace(/\.(xlsx|xls|csv)$/i, '') + '_graded.xlsx';
    importedSheetName = wb.SheetNames[0];
    const ws = wb.Sheets[importedSheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    importedHeaders = (rows[0] || []).map(h => String(h));
    importedRows = rows.slice(1).filter(r => r.some(c => String(c).trim() !== ''));

    populateColumnSelects();
    const guessCol = (re) => importedHeaders.findIndex(h => re.test(h));
    const nameGuess = guessCol(/name/i);
    const idGuess = guessCol(/\bid\b|student.?id|roll/i);
    const markGuess = guessCol(/mark|score|grade|result/i);
    if (nameGuess >= 0) el('nameColSelect').value = nameGuess;
    if (idGuess >= 0) el('idColSelect').value = idGuess;
    el('markColSelect').value = markGuess >= 0 ? String(markGuess) : 'new';

    el('excelMapWrap').classList.remove('hidden');
    el('excelStatus').textContent = `Loaded "${file.name}" — ${importedRows.length} row(s) on sheet "${importedSheetName}". Confirm the columns below.`;
    el('excelStatus').className = 'status ok';
  } catch (err) {
    // Log the real error for debugging, but only show the user a generic
    // message — library internals shouldn't be surfaced verbatim.
    console.error('Excel/CSV import failed:', err);
    el('excelStatus').textContent = 'Could not read that file — check it is a valid Excel (.xlsx/.xls) or CSV file.';
    el('excelStatus').className = 'status err';
  }
});

el('confirmMapBtn').addEventListener('click', () => {
  const nameIdx = Number(el('nameColSelect').value);
  const idVal = el('idColSelect').value;
  const idIdx = idVal === '' ? -1 : Number(idVal);

  roster = importedRows
    .map(r => ({ name: String(r[nameIdx] ?? '').trim(), id: idIdx >= 0 ? String(r[idIdx] ?? '').trim() : '' }))
    .filter(r => r.name);

  if (!roster.length) {
    el('excelStatus').textContent = 'No student names found in that column — check the mapping.';
    el('excelStatus').className = 'status err';
    return;
  }

  localStorage.setItem(ROSTER_KEY, JSON.stringify(roster));
  rebuildFuse();
  el('rosterInput').value = roster.map(r => `${r.name}, ${r.id}`).join('\n');
  refreshRosterUI();

  colMap = { name: nameIdx, id: idIdx };
  const markVal = el('markColSelect').value;
  if (markVal === 'new') {
    colMap.mark = -1;
    markColHeader = el('assessment').value.trim() || 'Mark';
  } else {
    colMap.mark = Number(markVal);
    markColHeader = importedHeaders[colMap.mark];
  }

  el('excelStatus').textContent = `Roster imported (${roster.length} students). Marks will be written into the "${markColHeader}" column of ${importedFileName}.`;
  el('excelStatus').className = 'status ok';
  el('exportBtn').textContent = '⬇️ Save marks into Excel file';
});

el('rosterPicker').addEventListener('change', () => {
  const i = el('rosterPicker').value;
  if (i === '') return;
  const r = roster[Number(i)];
  el('studentName').value = r.name;
  el('studentId').value = r.id;
  el('matchSuggestion').classList.add('hidden');
});

el('assessment').addEventListener('input', refreshRosterUI);

function pickNextUnrecordedStudent() {
  const assessment = el('assessment').value.trim() || 'Assessment';
  const recordedIds = new Set(
    records.filter(r => r.assessment === assessment).map(r => r.id)
  );
  const idx = roster.findIndex(r => !recordedIds.has(r.id));
  if (idx === -1) return false;
  el('rosterPicker').value = String(idx);
  el('studentName').value = roster[idx].name;
  el('studentId').value = roster[idx].id;
  return true;
}

// ==========================================================================
// Colour ranges (HSV, H in degrees 0-360, S/V 0-1) + region detection
// ==========================================================================

const COLOR_RANGES = {
  red:    [{h:[0,18], s:[0.35,1], v:[0.25,1]}, {h:[335,360], s:[0.35,1], v:[0.25,1]}],
  blue:   [{h:[195,255], s:[0.30,1], v:[0.25,1]}],
  green:  [{h:[80,170], s:[0.25,1], v:[0.20,1]}],
  purple: [{h:[260,320], s:[0.25,1], v:[0.20,1]}],
  orange: [{h:[18,45], s:[0.35,1], v:[0.35,1]}],
  black:  [{h:[0,360], s:[0,1], v:[0,0.28]}],
};

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r,g,b), min = Math.min(r,g,b);
  let h, s, v = max;
  const d = max - min;
  s = max === 0 ? 0 : d / max;
  if (d === 0) h = 0;
  else if (max === r) h = 60 * (((g-b)/d) % 6);
  else if (max === g) h = 60 * ((b-r)/d + 2);
  else h = 60 * ((r-g)/d + 4);
  if (h < 0) h += 360;
  return [h, s, v];
}

function matchesColor(h, s, v, ranges) {
  for (const r of ranges) {
    if (h >= r.h[0] && h <= r.h[1] && s >= r.s[0] && s <= r.s[1] && v >= r.v[0] && v <= r.v[1]) return true;
  }
  return false;
}

/**
 * Find coloured blobs and score them so ring/circle outlines (the typical
 * way a mark is circled) rank above solid coloured fills or stray marks.
 * Returns up to `limit` candidate boxes, best first, in full-res coordinates.
 */
function findColoredRegions(canvas, colorName, limit = 2) {
  const scale = 400 / canvas.width; // downscale for speed
  const w = Math.max(1, Math.round(canvas.width * scale));
  const h = Math.max(1, Math.round(canvas.height * scale));
  const small = document.createElement('canvas');
  small.width = w; small.height = h;
  const sctx = small.getContext('2d');
  sctx.drawImage(canvas, 0, 0, w, h);
  const data = sctx.getImageData(0, 0, w, h).data;

  const ranges = COLOR_RANGES[colorName];
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const px = i * 4;
    const [hh, ss, vv] = rgbToHsv(data[px], data[px+1], data[px+2]);
    if (matchesColor(hh, ss, vv, ranges)) mask[i] = 1;
  }

  const visited = new Uint8Array(w * h);
  const found = [];
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || visited[i]) continue;
    let minX = w, minY = h, maxX = 0, maxY = 0, count = 0;
    const stack = [i];
    visited[i] = 1;
    while (stack.length) {
      const idx = stack.pop();
      const x = idx % w, y = (idx / w) | 0;
      count++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      const neighbors = [idx-1, idx+1, idx-w, idx+w];
      for (const n of neighbors) {
        if (n < 0 || n >= w*h) continue;
        if (Math.abs((n % w) - x) > 1) continue; // avoid wrap on row edges
        if (!visited[n] && mask[n]) { visited[n] = 1; stack.push(n); }
      }
    }
    const bw = maxX - minX, bh = maxY - minY;
    if (count < 25) continue; // noise
    const aspect = bh ? bw / bh : 0;
    if (aspect < 0.25 || aspect > 4.5) continue;
    if (bw > 0.8 * w || bh > 0.8 * h) continue;

    const boxArea = Math.max(1, bw * bh);
    const fillRatio = count / boxArea;      // low = hollow ring, high = solid fill
    const roundness = Math.min(bw,bh) / Math.max(bw,bh); // closer to 1 = more circular
    // Ring-shaped outlines (fill ratio ~0.05-0.5) score highest — that's how
    // a circled mark looks. Very high fill ratios (solid highlighter blocks)
    // still count, just lower priority.
    const ringBonus = (fillRatio >= 0.04 && fillRatio <= 0.5) ? 1.4 : 1.0;
    const score = boxArea * ringBonus * (0.6 + 0.4 * roundness);

    found.push({ score, minX, minY, maxX, maxY });
  }

  found.sort((a, b) => b.score - a.score);
  const fx = 1 / scale;
  return found.slice(0, limit).map(b => {
    let x1 = b.minX * fx, y1 = b.minY * fx, x2 = b.maxX * fx, y2 = b.maxY * fx;
    const padX = (x2 - x1) * 0.12, padY = (y2 - y1) * 0.12;
    x1 += padX; y1 += padY; x2 -= padX; y2 -= padY;
    return { x: Math.max(0,x1), y: Math.max(0,y1), w: Math.max(1,x2-x1), h: Math.max(1,y2-y1) };
  });
}

function cropToCanvas(sourceCanvas, box) {
  const c = document.createElement('canvas');
  const scaleUp = 3;
  c.width = Math.max(1, box.w * scaleUp); c.height = Math.max(1, box.h * scaleUp);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(sourceCanvas, box.x, box.y, box.w, box.h, 0, 0, c.width, c.height);
  return c;
}

// ==========================================================================
// OCR preprocessing (Otsu binarisation) + multi-variant recognition
// ==========================================================================

function otsuThreshold(hist, total) {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, varMax = 0, threshold = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const varBetween = wB * wF * (mB - mF) * (mB - mF);
    if (varBetween > varMax) { varMax = varBetween; threshold = t; }
  }
  return threshold;
}

function preprocessForOcr(canvas, invert) {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d');
  const imgData = ctx.getImageData(0, 0, w, h);
  const d = imgData.data;
  const gray = new Uint8ClampedArray(w * h);
  const hist = new Array(256).fill(0);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const g = Math.round(0.299 * d[i] + 0.587 * d[i+1] + 0.114 * d[i+2]);
    gray[p] = g;
    hist[g]++;
  }
  const th = otsuThreshold(hist, w * h);
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const octx = out.getContext('2d');
  const outData = octx.createImageData(w, h);
  for (let p = 0, i = 0; p < gray.length; p++, i += 4) {
    let v = gray[p] > th ? 255 : 0;
    if (invert) v = 255 - v;
    outData.data[i] = outData.data[i+1] = outData.data[i+2] = v;
    outData.data[i+3] = 255;
  }
  octx.putImageData(outData, 0, 0);
  return out;
}

function cleanOcrText(raw) {
  return (raw || '').trim().replace(/\s+/g, '').replace(/\.+$/, '');
}

/**
 * Try a thresholded version first (best for ink/highlighter circles), then
 * the raw upsampled crop, then an inverted threshold — stopping early once
 * a high-confidence read is found, so the common case stays fast.
 */
async function runOcrOnCrop(cropCanvas) {
  const variants = [preprocessForOcr(cropCanvas, false), cropCanvas, preprocessForOcr(cropCanvas, true)];
  let best = { text: '', confidence: -1 };
  for (const v of variants) {
    try {
      const { data } = await Tesseract.recognize(v.toDataURL('image/png'), 'eng', {
        tessedit_char_whitelist: '0123456789/.%',
      });
      const text = cleanOcrText(data.text);
      const conf = data.confidence || 0;
      if (text && conf > best.confidence) best = { text, confidence: conf };
    } catch (e) { /* try next variant */ }
    if (best.confidence >= 70) break; // good enough, skip remaining variants
  }
  return best;
}

async function detectAndReadMark(sourceCanvas, colorName) {
  const candidates = findColoredRegions(sourceCanvas, colorName, 2);
  for (const box of candidates) {
    const cropCanvas = cropToCanvas(sourceCanvas, box);
    const result = await runOcrOnCrop(cropCanvas);
    if (result.text) return { ...result, box };
  }
  return null;
}

// ==========================================================================
// Camera
// ==========================================================================

async function startCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    video.srcObject = stream;
    el('camWrap').classList.remove('hidden');
    el('startCamBtn').classList.add('hidden');
    el('detectedBox').classList.add('hidden');
    el('frameCanvas').classList.add('hidden');
    el('manualSelectBtn').classList.add('hidden');
    el('camStatus').textContent = '';
    el('manualStatus').textContent = '';
  } catch (err) {
    el('camStatus').textContent = 'Camera error: ' + err.message + ' (camera requires HTTPS or localhost, and permission).';
    el('camStatus').className = 'status err';
  }
}
el('startCamBtn').addEventListener('click', startCamera);

el('captureBtn').addEventListener('click', async () => {
  const raw = document.createElement('canvas');
  raw.width = video.videoWidth; raw.height = video.videoHeight;
  raw.getContext('2d').drawImage(video, 0, 0);
  capturedCanvas = raw;

  frameCanvas.width = raw.width; frameCanvas.height = raw.height;
  frameCanvas.getContext('2d').drawImage(raw, 0, 0);
  frameCanvas.classList.remove('hidden');
  el('manualSelectBtn').classList.remove('hidden');

  if (stream) { stream.getTracks().forEach(t => t.stop()); }
  el('camWrap').classList.add('hidden');
  el('startCamBtn').classList.remove('hidden');
  el('startCamBtn').textContent = '📷 Retake photo';

  el('camStatus').textContent = 'Detecting mark…';
  el('camStatus').className = 'status';
  el('confidenceNote').textContent = '';

  const colorName = el('colorSelect').value;
  const result = await detectAndReadMark(raw, colorName);
  if (!result) {
    el('camStatus').textContent = `No ${colorName} circled mark found automatically. Drag to select it below, or type the mark manually.`;
    el('camStatus').className = 'status err';
    el('detectedText').textContent = '—';
    el('detectedBox').classList.remove('hidden');
    el('markInput').value = '';
    return;
  }
  el('detectedText').textContent = result.text;
  el('confidenceNote').textContent = `(${Math.round(result.confidence)}% confidence)`;
  el('markInput').value = result.text;
  el('detectedBox').classList.remove('hidden');

  if (await maybeAutoApprove(result)) return; // saved automatically, fields already reset

  el('camStatus').textContent = result.confidence >= AUTO_APPROVE_MIN_CONFIDENCE
    ? 'Mark detected. Confirm or edit below.'
    : 'Mark detected with low confidence — please double-check it.';
  el('camStatus').className = result.confidence >= AUTO_APPROVE_MIN_CONFIDENCE ? 'status ok' : 'status err';
});

// ---------- Manual drag-to-select fallback ----------
let manualMode = false, dragStart = null, manualBox = null;

function canvasCoordsFromEvent(e, canvas) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
}

function redrawFrameWithBox(box) {
  if (!capturedCanvas) return;
  const ctx = frameCanvas.getContext('2d');
  ctx.drawImage(capturedCanvas, 0, 0);
  if (box) {
    ctx.strokeStyle = '#2563eb';
    ctx.lineWidth = Math.max(2, frameCanvas.width * 0.004);
    ctx.strokeRect(box.x, box.y, box.w, box.h);
  }
}

el('manualSelectBtn').addEventListener('click', () => {
  manualMode = true;
  el('manualStatus').textContent = 'Drag a box around the mark on the photo, then release.';
  el('manualStatus').className = 'status';
});

frameCanvas.addEventListener('pointerdown', (e) => {
  if (!manualMode) return;
  dragStart = canvasCoordsFromEvent(e, frameCanvas);
});
frameCanvas.addEventListener('pointermove', (e) => {
  if (!manualMode || !dragStart) return;
  const p = canvasCoordsFromEvent(e, frameCanvas);
  manualBox = {
    x: Math.min(dragStart.x, p.x), y: Math.min(dragStart.y, p.y),
    w: Math.abs(p.x - dragStart.x), h: Math.abs(p.y - dragStart.y),
  };
  redrawFrameWithBox(manualBox);
});
window.addEventListener('pointerup', async () => {
  if (!manualMode || !dragStart) { dragStart = null; return; }
  dragStart = null;
  manualMode = false;
  if (!manualBox || manualBox.w < 10 || manualBox.h < 10) {
    el('manualStatus').textContent = 'Selection too small — try dragging a bigger box.';
    el('manualStatus').className = 'status err';
    return;
  }
  el('manualStatus').textContent = 'Reading selection…';
  const cropCanvas = cropToCanvas(capturedCanvas, manualBox);
  const result = await runOcrOnCrop(cropCanvas);
  el('detectedText').textContent = result.text || '(nothing read — enter manually)';
  el('confidenceNote').textContent = result.text ? `(${Math.round(result.confidence)}% confidence)` : '';
  el('markInput').value = result.text;
  el('detectedBox').classList.remove('hidden');

  if (await maybeAutoApprove(result)) {
    el('manualStatus').textContent = '';
    return; // saved automatically, fields already reset
  }

  el('manualStatus').textContent = result.text ? 'Selection read. Confirm or edit below.' : 'Could not read selection — enter the mark manually.';
  el('manualStatus').className = result.text ? 'status ok' : 'status err';
});

// ==========================================================================
// Mic (Web Speech API) with roster grammar bias + fuzzy correction
// ==========================================================================

const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
const SpeechGrammar = window.SpeechGrammarList || window.webkitSpeechGrammarList;

if (!SpeechRec) {
  el('micStatus').textContent = 'Voice input not supported in this browser — type name/ID instead (on iPhone/Android you can use the microphone key on the on-screen keyboard).';
} else {
  el('micBtn').addEventListener('click', () => {
    const rec = new SpeechRec();
    rec.lang = 'en-US';
    rec.interimResults = false;

    // Bias recognition toward known roster names where the browser supports
    // grammars (mainly Chrome) — improves accuracy on uncommon names.
    if (SpeechGrammar && roster.length) {
      try {
        const names = roster.map(r => r.name.replace(/[^a-zA-Z' -]/g, '')).filter(Boolean);
        const grammar = '#JSGF V1.0; grammar names; public <name> = ' + names.join(' | ') + ' ;';
        const list = new SpeechGrammar();
        list.addFromString(grammar, 1);
        rec.grammars = list;
      } catch (e) { /* grammar biasing best-effort only */ }
    }

    el('micStatus').textContent = 'Listening… say "Name, ID", e.g. "Jane Doe, S1023"';
    rec.start();
    rec.onresult = (e) => {
      const said = e.results[0][0].transcript;
      const parts = said.split(',');
      if (parts.length >= 2) {
        el('studentName').value = parts[0].trim();
        el('studentId').value = parts.slice(1).join(',').trim();
      } else {
        el('studentName').value = said.trim();
      }
      el('micStatus').textContent = 'Heard: "' + said + '"';

      // Fuzzy-match against the roster and offer a one-tap correction.
      if (fuse) {
        const results = fuse.search(said);
        if (results.length && results[0].score <= 0.45) {
          const match = results[0].item;
          el('suggestName').textContent = `${match.name} (${match.id})`;
          el('matchSuggestion').classList.remove('hidden');
          el('useSuggestionBtn').onclick = () => {
            el('studentName').value = match.name;
            el('studentId').value = match.id;
            el('matchSuggestion').classList.add('hidden');
          };
        } else {
          el('matchSuggestion').classList.add('hidden');
        }
      }
    };
    rec.onerror = (e) => {
      el('micStatus').textContent = 'Mic error: ' + e.error;
    };
  });
}

// ==========================================================================
// Records
// ==========================================================================

function renderRecords() {
  const body = el('recBody');
  body.innerHTML = '';
  records.forEach((r, i) => {
    // Built with createElement/textContent (not innerHTML) so student data —
    // which can come from an imported file or voice transcript — can never
    // be interpreted as HTML/script (prevents stored XSS).
    const tr = document.createElement('tr');
    [r.name, r.id, r.assessment, r.mark].forEach(val => {
      const td = document.createElement('td');
      td.textContent = val;
      tr.appendChild(td);
    });
    const actionTd = document.createElement('td');
    const delBtn = document.createElement('button');
    delBtn.className = 'delBtn btn-danger';
    delBtn.style.padding = '4px 8px';
    delBtn.style.fontSize = '12px';
    delBtn.textContent = '✕';
    delBtn.dataset.i = String(i);
    actionTd.appendChild(delBtn);
    tr.appendChild(actionTd);
    body.appendChild(tr);
  });
  el('recCount').textContent = records.length;
  el('countPill').textContent = records.length + ' records';
  el('emptyMsg').classList.toggle('hidden', records.length > 0);
  document.querySelectorAll('.delBtn').forEach(b => {
    b.addEventListener('click', () => {
      records.splice(Number(b.dataset.i), 1);
      persist();
      renderRecords();
      refreshRosterUI();
    });
  });
}

function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
}

/**
 * Save the current name/ID/mark as a record. Used by both the manual
 * "Save record" button and the auto-approve (skip review) flow, so both
 * paths behave identically (persistence, auto-advance, camera reopen).
 * Returns true if the record was saved.
 */
function commitRecord() {
  const name = el('studentName').value.trim();
  const id = el('studentId').value.trim();
  const assessment = el('assessment').value.trim() || 'Assessment';
  const mark = el('markInput').value.trim();
  if (!name || !mark) {
    el('camStatus').textContent = 'Name and mark are required.';
    el('camStatus').className = 'status err';
    return false;
  }
  records.push({ name, id, assessment, mark, timestamp: new Date().toISOString() });
  persist();
  renderRecords();

  // reset for next student, keep assessment + colour
  el('studentName').value = '';
  el('studentId').value = '';
  el('rosterPicker').value = '';
  el('markInput').value = '';
  el('detectedBox').classList.add('hidden');
  el('frameCanvas').classList.add('hidden');
  el('manualSelectBtn').classList.add('hidden');
  el('matchSuggestion').classList.add('hidden');
  el('startCamBtn').textContent = '📷 Open camera';
  el('camStatus').textContent = `Saved: ${name} → ${mark}. Ready for next student.`;
  el('camStatus').className = 'status ok';

  refreshRosterUI();

  if (el('autoNextToggle').checked) {
    const advanced = pickNextUnrecordedStudent();
    if (advanced) startCamera();
  }
  return true;
}

el('saveRecordBtn').addEventListener('click', commitRecord);

/**
 * If "skip review" is on and the OCR result is confident, briefly show the
 * detected mark (live preview) then auto-save. Otherwise falls back to
 * requiring the usual manual Confirm / Save step. Returns true if it
 * auto-saved.
 */
const AUTO_APPROVE_MIN_CONFIDENCE = 60;

async function maybeAutoApprove(result) {
  const confident = result && result.text && result.confidence >= AUTO_APPROVE_MIN_CONFIDENCE;
  if (!el('autoApproveToggle').checked || !confident) return false;

  if (!el('studentName').value.trim()) {
    el('camStatus').textContent = `Mark detected (${result.text}) — pick or enter a student to auto-save.`;
    el('camStatus').className = 'status err';
    return false;
  }

  el('camStatus').textContent = `Mark detected: ${result.text}. Auto-saving…`;
  el('camStatus').className = 'status ok';
  await new Promise(r => setTimeout(r, 650)); // let the live preview register before committing
  return commitRecord();
}

el('clearBtn').addEventListener('click', () => {
  if (confirm('Clear all records? This cannot be undone.')) {
    records = [];
    persist();
    renderRecords();
    refreshRosterUI();
  }
});

function exportFreshWorkbook() {
  const rows = records.map(r => ({
    Name: r.name, ID: r.id, Assessment: r.assessment, Mark: r.mark, Timestamp: r.timestamp
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Marks');
  const stamp = new Date().toISOString().slice(0,10);
  XLSX.writeFile(wb, `marks_${stamp}.xlsx`);
}

/**
 * Write each recorded mark into the originally-imported workbook, matching
 * rows by ID (preferred) or by name, and download the updated file. Existing
 * rows/columns are left untouched; the mark column is created if it doesn't
 * already exist. Note: the free SheetJS build preserves cell values and
 * layout reliably, but may not perfectly preserve all original formatting
 * (colours, borders, merged cells).
 */
function exportIntoImportedWorkbook() {
  const ws = importedWorkbook.Sheets[importedSheetName];
  let markIdx = colMap.mark;

  if (markIdx === undefined || markIdx === -1 || markIdx === null) {
    markIdx = importedHeaders.length;
    importedHeaders.push(markColHeader);
    ws[XLSX.utils.encode_cell({ r: 0, c: markIdx })] = { t: 's', v: markColHeader };
  }

  const byId = new Map(), byName = new Map();
  records.forEach(r => {
    if (r.id) byId.set(r.id, r.mark);
    byName.set(r.name.trim().toLowerCase(), r.mark);
  });

  let filled = 0;
  importedRows.forEach((row, i) => {
    const rIdx = i + 1; // row 0 is the header
    const name = String(row[colMap.name] ?? '').trim();
    const id = colMap.id >= 0 ? String(row[colMap.id] ?? '').trim() : '';
    const mark = (id && byId.has(id)) ? byId.get(id) : byName.get(name.toLowerCase());
    if (mark === undefined) return;
    ws[XLSX.utils.encode_cell({ r: rIdx, c: markIdx })] = { t: 's', v: String(mark) };
    filled++;
  });

  const range = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };
  range.e.c = Math.max(range.e.c, markIdx);
  range.e.r = Math.max(range.e.r, importedRows.length);
  ws['!ref'] = XLSX.utils.encode_range(range);

  XLSX.writeFile(importedWorkbook, importedFileName);
  el('camStatus').textContent = `Filled ${filled} mark(s) into ${importedFileName}.`;
  el('camStatus').className = 'status ok';
}

el('exportBtn').addEventListener('click', () => {
  if (records.length === 0) { alert('No records to export yet.'); return; }
  if (importedWorkbook) {
    exportIntoImportedWorkbook();
  } else {
    exportFreshWorkbook();
  }
  // Student names/IDs/marks live in this browser's local storage indefinitely.
  // Nudge toward clearing it once it's safely exported, especially important
  // on shared/lab/library computers.
  const reminder = el('exportReminder');
  if (reminder) {
    reminder.textContent = '✅ Exported. On a shared or public computer, tap "Clear all" below once you\'re done — student data otherwise stays saved in this browser.';
    reminder.classList.remove('hidden');
  }
});

// service worker (installable PWA) — best effort, ignore failures on file:// or unsupported browsers
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

if (roster.length) {
  el('rosterInput').value = roster.map(r => `${r.name}, ${r.id}`).join('\n');
  rebuildFuse();
}
refreshRosterUI();
renderRecords();
