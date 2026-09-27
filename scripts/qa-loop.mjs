#!/usr/bin/env node
// Candela QA loop — repeatable, numeric, headless.
//
// Why this exists: a fix reported as "done" from source reading is not a fix.
// Every check here measures the RUNNING app through CDP (DOM values, canvas
// pixels, IndexedDB rows, the actual PDF bytes a printer would receive) and
// prints the number it observed. Nothing is allowed to pass on "no exception".
//
// Usage:
//   node scripts/qa-loop.mjs            # full run (needs ~2 min: decodes a 58MB Fuji RAF)
//   node scripts/qa-loop.mjs --fast     # skip the heavy RAW checks
//   node scripts/qa-loop.mjs --only print,thumbs
//   node scripts/qa-loop.mjs --keep     # leave Chrome running for inspection
//
// Exits 0 only when every check passed. Dev server: uses localhost:5173 and
// starts `npm run dev` itself when nothing is listening (killing it on exit).

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';

const APP_URL = 'http://localhost:5173/';
const DEBUG_PORT = 9333;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const FIXTURE_RAF = '/src/raw/__fixtures__/sample.raf'; // Fuji X100V, camera JPEG is B&W
const FIXTURE_DNG = '/src/raw/__fixtures__/bayer.dng';

// ---- tiny CDP client -------------------------------------------------------
// Node 26 ships a global WebSocket, so the loop needs no dependency. One
// connection to the browser target; Runtime.evaluate does the rest (the app's
// own DOM/GPU is the thing under test, never a reimplementation of it).
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }
  static async connect(sessionId) {
    const url = `ws://127.0.0.1:${DEBUG_PORT}/devtools/page/${sessionId}`;
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('CDP connect failed')), { once: true });
    });
    return new Cdp(ws);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result.value;
  }
  close() {
    try { this.ws.close(); } catch { /* already gone */ }
  }
}

async function listTargets() {
  const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
  return res.json();
}
async function newTarget(url) {
  const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  return res.json();
}

// ---- in-page helpers (strings evaluated in the app origin) -----------------
// The permission shim is the only way to test the post-reload path: real Chrome
// revokes File System Access grants on reload and refuses requestPermission
// outside a user gesture, but OPFS-backed handles report 'granted' forever.
// The shim reproduces BOTH halves faithfully — including that a directory
// queryPermission must also read 'prompt' once revoked, or ensureReadPermission
// short-circuits on the query and never reaches the gesture-gated request.
const SHIM = `
window.__qa = { errs: [], warns: [], grants: new Set(), reqLog: [] };
addEventListener('error', e => window.__qa.errs.push(String(e.message)));
addEventListener('unhandledrejection', e => window.__qa.errs.push('REJ:' + String(e.reason?.message || e.reason)));
const ow = console.warn; console.warn = (...a) => { window.__qa.warns.push(a.map(String).join(' ').slice(0,160)); ow(...a); };
const oe = console.error; console.error = (...a) => { window.__qa.errs.push(a.map(String).join(' ').slice(0,200)); oe(...a); };
window.__qa.lastGesture = -1e9;
document.addEventListener('pointerdown', () => { window.__qa.lastGesture = performance.now(); }, true);
document.addEventListener('keydown', () => { window.__qa.lastGesture = performance.now(); }, true);
const inGesture = () => performance.now() - window.__qa.lastGesture < 5000;
const TRUE_GET = FileSystemFileHandle.prototype.getFile;
FileSystemFileHandle.prototype.queryPermission = async function () { return window.__qa.grants.has('fx') ? 'granted' : 'prompt'; };
FileSystemFileHandle.prototype.requestPermission = async function () {
  if (inGesture()) { window.__qa.grants.add('fx'); window.__qa.reqLog.push('grant'); return 'granted'; }
  window.__qa.reqLog.push('deny:' + this.name);
  throw new DOMException('gesture required', 'NotAllowedError');
};
FileSystemFileHandle.prototype.getFile = async function () {
  if (!window.__qa.grants.has('fx') && !window.__qa.seedBypass) throw new DOMException('denied:' + this.name, 'NotAllowedError');
  return TRUE_GET.call(this);
};
FileSystemDirectoryHandle.prototype.queryPermission = async function () { return window.__qa.grants.has('fx') ? 'granted' : 'prompt'; };
FileSystemDirectoryHandle.prototype.requestPermission = async function () {
  if (inGesture()) { window.__qa.grants.add('fx'); window.__qa.reqLog.push('grant-dir'); return 'granted'; }
  throw new DOMException('gesture required', 'NotAllowedError');
};
'installed'`;

// Seed the catalog fixtures into OPFS. `source` is a same-origin URL the dev
// server can serve; big files must never cross the CDP wire (payload size kills
// the transport), so the page fetches them itself.
const seed = (files) => `(() => {
  window.__qa.seedBypass = true;
  window.__qa.seedState = 'pending';
  (async () => {
    try {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('fx', { create: true });
      for await (const [n] of dir.entries()) await dir.removeEntry(n, { recursive: true });
      const out = [];
      for (const f of ${JSON.stringify(files)}) {
        // "gen" entries are drawn in-page: a real JPEG (asymmetric, so a flip
        // or a colour/B&W swap is measurable) without shipping bytes over CDP.
        const bytes = f.gen ? await (async () => {
          const c = new OffscreenCanvas(600, 400), g = c.getContext('2d');
          g.fillStyle = f.gen.bg; g.fillRect(0, 0, 600, 400);
          g.fillStyle = f.gen.fg; g.fillRect(300, 200, 300, 200);
          return (await c.convertToBlob({ type: 'image/jpeg', quality: 0.9 })).arrayBuffer();
        })() : await (await fetch(f.url)).arrayBuffer();
        const fh = await dir.getFileHandle(f.name, { create: true });
        const w = await fh.createWritable(); await w.write(bytes); await w.close();
        out.push(f.name + ':' + (await fh.getFile()).size);
      }
      window.showDirectoryPicker = async () => { window.__qa.grants.add('fx'); return dir; };
      window.__qa.seedState = 'ok ' + out.join(' ');
    } catch (e) { window.__qa.seedState = 'err:' + e.message; }
    window.__qa.seedBypass = false;
  })();
  return 'started';
})()`;

// Filmstrip/grid thumbnail probe: the max channel spread distinguishes a
// camera B&W preview (spread ~0-12) from a colour pipeline render (~30+).
// Luminance alone would pass on a recoloured image, so this is the statistic
// the "footer shows camera B&W" complaint actually needs.
const probeThumbs = `JSON.stringify((() => {
  const out = [];
  for (const cell of document.querySelectorAll('.filmstrip-cell, .catalog-cell')) {
    const img = cell.querySelector('img');
    const id = cell.dataset.fileId;
    if (!img || !img.complete || !img.naturalWidth) { out.push({ id, state: 'no-img' }); continue; }
    const c = new OffscreenCanvas(24, 24);
    const x = c.getContext('2d'); x.drawImage(img, 0, 0, 24, 24);
    const d = x.getImageData(0, 0, 24, 24).data;
    let sp = 0, lum = 0;
    for (let i = 0; i < d.length; i += 4) {
      const s = Math.abs(d[i]-d[i+1]) + Math.abs(d[i+1]-d[i+2]);
      if (s > sp) sp = s;
      lum += (d[i]+d[i+1]+d[i+2]) / 3;
    }
    out.push({ id, spread: sp, lum: Math.round(lum/(d.length/4)), w: img.naturalWidth, h: img.naturalHeight });
  }
  return out;
})())`;

// ---- check harness ---------------------------------------------------------
const results = [];
async function check(name, group, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ name, group, ok: true, detail, ms: Date.now() - t0 });
  } catch (err) {
    results.push({ name, group, ok: false, detail: String(err.message || err), ms: Date.now() - t0 });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cdp, expr, { timeout = 30000, step = 500 } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await cdp.evaluate(expr);
    if (last && last !== false && last !== 0 && last !== 'false') return last;
    await sleep(step);
  }
  throw new Error(`timeout waiting for ${expr.slice(0, 60)} (last: ${JSON.stringify(last)})`);
}

async function clickEl(cdp, selector) {
  const pt = await cdp.evaluate(`(() => {
    const e = document.querySelector(${JSON.stringify(selector)});
    if (!e) return null;
    // Open any collapsed <details> ancestor first. Chrome gives collapsed
    // details content a painted rect but makes it NOT hit-testable
    // (content-visibility:hidden), so a click on a button inside a closed
    // panel silently lands on whatever is painted on top — this harness
    // measured a phantom "Export button covered by Reset" that way. A real
    // user opens the panel to reach its buttons; do the same.
    for (let d = e.closest('details'); d; d = d.parentElement?.closest('details')) d.open = true;
    e.scrollIntoView({ block: 'center' });
    const b = e.getBoundingClientRect();
    const x = Math.round(b.left + b.width/2), y = Math.round(b.top + b.height/2);
    const hit = document.elementFromPoint(x, y);
    return { x, y, w: Math.round(b.width), h: Math.round(b.height),
             onTarget: !!hit && (hit === e || e.contains(hit)),
             hit: hit ? (hit.id || hit.className || hit.tagName) : null };
  })()`);
  if (!pt) throw new Error(`no element for ${selector}`);
  if (pt.w < 20 || pt.h < 16) throw new Error(`${selector} target too small: ${pt.w}x${pt.h}`);
  // ASSERT the hit test: dispatching at coordinates an overlay owns is a
  // silent click on the wrong thing — two checks (export cell open, iptc
  // apply) failed mystery deaths this way. Fail loudly at the source.
  if (!pt.onTarget) throw new Error(`${selector} center is covered by "${pt.hit}" — click would miss`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
  }
  return pt;
}

async function printPdf(cdp, { paperWidth = 8.27, paperHeight = 11.69 } = {}) {
  const r = await cdp.send('Page.printToPDF', {
    paperWidth, paperHeight, printBackground: true, preferCSSPageSize: true,
    marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0, displayHeaderFooter: false,
  });
  return Buffer.from(r.data, 'base64');
}

// Parse a PDF content stream for the ink the printer will actually lay down:
// every fill colour (rg operator) and every image placement (cm + Do). This is
// how the print regression was found — the sheet was being drawn at x=220 y=33
// on a full-page #121213 background, which no DOM measurement revealed.
//
// Skia writes page content as a FlateDecode stream, so the raw bytes contain
// NO drawing operators at all: reading the file as text finds /Type and
// /Subtype (uncompressed dictionary entries) but zero fills or placements, and
// a "no dark fills" assertion then passes vacuously. Inflate every stream
// first — that is what makes these numbers real.
function inspectPdf(buf) {
  const raw = buf.toString('latin1');
  const pages = (raw.match(/\/Type\s*\/Page[^s]/g) || []).length;
  const images = (raw.match(/\/Subtype\s*\/Image/g) || []).length;
  const content = [];
  // Only page-content streams. Two kinds of binary stream must be skipped or
  // they poison the operator scan: a JPEG image stream, and the ICC colour
  // profile stream (dict carries `/N <channels>`). Inflating either yields
  // bytes that routinely CONTAIN text like "0 0 0 rg", which read as a phantom
  // full-page dark fill on a page that is in fact white.
  for (const m of raw.matchAll(/<<([^>]{0,400})>>\s*stream\r?\n([\s\S]*?)endstream/g)) {
    if (/\/Subtype\s*\/Image/.test(m[1])) continue;
    if (/\/N\s+\d/.test(m[1])) continue; // ICC profile
    const chunk = Buffer.from(m[2], 'latin1');
    try { content.push(zlib.inflateSync(chunk).toString('latin1')); } catch { content.push(m[2]); }
  }
  const stream = content.join('\n');
  if (!stream.trim()) throw new Error('PDF has no readable content stream (inflated nothing)');
  // A dark fill only counts if it is actually PAINTED: an `rg` colour operator
  // followed by a rect + fill (`... re\nf`). Skia also emits a bare `0 0 0 rg`
  // as graphics state right before drawing the photo XObject with no rect fill
  // after it — counting every `rg` flags that as a phantom black page. The
  // real regression this guards was a dark `re f` covering 0 0 794 1123.
  const paintedFills = [...stream.matchAll(/([\d.]+) ([\d.]+) ([\d.]+) rg[\s\S]{0,120}?([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) re\s*\n\s*f\b/g)]
    .map((m) => ({ rgb: [+m[1], +m[2], +m[3]], rect: [+m[4], +m[5], +m[6], +m[7]] }));
  const fills = paintedFills.map((f) => f.rgb);
  const darkFills = paintedFills.filter((f) => f.rgb[0] < 0.5 && f.rgb[1] < 0.5 && f.rgb[2] < 0.5);
  // Image placements: pair every XObject draw (`/Xn Do`) with the nearest
  // preceding `a 0 0 d e f cm`. Scanning cm..Do with one regex silently misses
  // the real placement whenever an outer page-scale cm sits before it — the
  // lazy window matches the OUTER cm, consumes through `Do`, and matchAll then
  // resumes past the inner one (this harness reported "no image" on a correct
  // page because the 0.24 page-scale cm got filtered as too small).
  const cmOps = [...stream.matchAll(/([-\d.]+) 0 0 ([-\d.]+) ([-\d.]+) ([-\d.]+) cm/g)]
    .map((m) => ({ at: m.index, w: +m[1], h: +m[2], x: +m[3], y: +m[4] }));
  const placements = [];
  for (const draw of stream.matchAll(/\/\w+ Do\b/g)) {
    const prior = cmOps.filter((c) => c.at < draw.index).pop();
    if (prior && prior.w > 1 && Math.abs(prior.h) > 1) {
      placements.push({ w: prior.w, h: prior.h, x: prior.x, y: prior.y });
    }
  }
  // Placements are expressed in Skia's nested device space (CSS px * 3.125
  // here), already inside the page transform, so they are directly comparable
  // with sheet CSS px times that same ratio. Converting them through the outer
  // page scale instead yields nonsense ("overflows vertically 4000 > 3506").
  // What DOES need care is the y axis: PDF y grows upward and the image height
  // arrives negative, so the rect spans [y+h, y] and both edges must be tested
  // against the sheet, not their sum.
  const darkByArea = darkFills
    .map((f) => ({ ...f, area: Math.abs(f.rect[2] * f.rect[3]) }))
    .sort((a, b) => b.area - a.area);
  // The real page box, so a caller never has to assume the paper size it asked
  // for: preferCSSPageSize means @page decides it. Skia writes /MediaBox as an
  // UNCOMPRESSED dictionary entry (measured here: "/MediaBox [0 0 594.95996
  // 841.91998]" for 210mm), so it comes off the raw latin1 string the same way
  // the /Type and /Subtype counts above do. Note the space: MediaBox is
  // PostScript points (72/inch), NOT the placement space — the page content
  // opens with a `0.24 0 0 -0.24 0 H cm` (0.24 = 72/300), so placements are
  // 1/300-inch and must be compared against MediaBox only after that scale.
  const mb = raw.match(/\/MediaBox\s*\[([^\]]*)\]/);
  const mediaBox = mb ? (mb[1].match(/[-\d.]+/g) || []).map(Number) : null;
  return { pages, images, fills, darkFills: darkByArea, placements, bytes: buf.length, streamBytes: stream.length, mediaBox };
}

// ---- dev server management -------------------------------------------------
async function portOpen(url) {
  try {
    const r = await fetch(url, { method: 'GET' });
    return r.ok;
  } catch { return false; }
}

async function ensureDevServer() {
  if (await portOpen(APP_URL)) return { started: false };
  const child = spawn('npm', ['run', 'dev'], { cwd: process.cwd(), stdio: 'ignore', detached: true });
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    if (await portOpen(APP_URL)) return { started: true, child };
  }
  throw new Error('dev server did not come up on 5173');
}

// ---- gates (static, before any browser work) -------------------------------
function runShell(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: process.cwd() });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
  });
}

async function gates() {
  const tsc = await runShell('npx', ['tsc', '-p', 'tsconfig.json', '--noEmit']);
  // `--reporter=dot`: vitest 4 dropped `basic`, and the default reporter's
  // per-file lines make the pass count hard to read back reliably.
  const test = await runShell('npx', ['vitest', 'run', '--reporter=dot']);
  const tests = (test.out.match(/(\d+)\s+passed/) || [])[1];
  const failed = (test.out.match(/(\d+)\s+failed/) || [])[1];
  const build = await runShell('npm', ['run', 'build']);
  results.push({
    name: 'gates: tsc / vitest / build', group: 'static',
    ok: tsc.code === 0 && test.code === 0 && build.code === 0,
    detail: `tsc exit ${tsc.code}; tests ${tests ?? '?'} passed${failed ? `, ${failed} FAILED` : ''}; build exit ${build.code}`,
    ms: 0,
    log: tsc.code === 0 && test.code === 0 && build.code === 0 ? '' : [tsc.out, test.out, build.out].join('\n---\n').slice(-4000),
  });
  return tsc.code === 0 && test.code === 0 && build.code === 0;
}

// ---- the checks ------------------------------------------------------------
async function runChecks(cdp, { fast }) {
  // Switch modules through the real topbar button and VERIFY the switch:
  // checks that clicked a topbar button and walked away left the app in the
  // wrong module more than once (a hidden Library aside made #add-folder a
  // 0x0 target and silently starved every later check). One owner, verified.
  const gotoModule = async (name) => {
    await cdp.evaluate(`(() => { const t=[...document.querySelectorAll('#topbar button')].find(b=>/${name}/i.test(b.textContent)); t?.click(); return 1; })()`);
    await waitFor(cdp, `document.querySelector('#module-${name}') && !document.querySelector('#module-${name}').hidden ? true : false`, { timeout: 10000 });
    await sleep(300);
  };
  // Deterministic catalog for one check: reload (pristine DOM — details
  // panels closed, every module reset, SHIM re-installed by the document-
  // start script), wipe the catalog stores AND the OPFS fixture dirs, seed
  // fresh files, then import unless asked not to.
  //
  // WHY every destructive check owns its reset: sharing one catalog made
  // correct app behaviour read as failures — a missing-file check's OPFS
  // deletion made the next check's "file kept on disk" assertion fail (a
  // phantom data-loss report), byte-recreated fixtures changed file sizes so
  // a duplicate gate legitimately treated them as new copies, and a details
  // panel one check opened pushed another check's button under a summary.
  // Each check below now starts from a measured-clean state instead of
  // inheriting its predecessor's mutations.
  const resetCatalog = async (files, { skipImport = false } = {}) => {
    // Wipe FIRST (while the old page is still up), then reload: the app's
    // boot recreates the Quick Collection tray (ensureQuickCollection), so a
    // reset catalog always has exactly one flagged tray row — the target
    // check depends on that invariant.
    await cdp.evaluate(`new Promise(res => {
      (async () => {
        try { const root = await navigator.storage.getDirectory();
          for (const d of ['fx', 'fx_copy']) {
            try { await root.removeEntry(d, { recursive: true }); } catch { /* absent */ }
          } } catch { /* no OPFS */ }
        const q = indexedDB.open('candela-catalog');
        q.onsuccess = () => { const db = q.result;
          const tx = db.transaction([...db.objectStoreNames], 'readwrite');
          for (const s of db.objectStoreNames) tx.objectStore(s).clear();
          tx.oncomplete = () => { db.close(); res('wiped'); };
          tx.onerror = () => { db.close(); res('ERR'); }; };
        q.onerror = () => res('ERR-OPEN');
      })();
    })`);
    await cdp.send('Page.reload', { ignoreCache: false });
    await sleep(3000);
    await waitFor(cdp, `document.querySelector('#add-folder') ? true : false`, { timeout: 20000 });
    await cdp.evaluate(seed(files));
    await waitFor(cdp, `window.__qa.seedState !== 'pending' ? window.__qa.seedState : false`, { timeout: 120000 });
    const st = await cdp.evaluate('window.__qa.seedState');
    if (!String(st).startsWith('ok')) throw new Error(`seed failed: ${st}`);
    if (skipImport) return st;
    await clickEl(cdp, '#add-folder');
    await waitFor(cdp, `document.querySelectorAll('.catalog-cell').length >= 1 ? true : false`, { timeout: 60000 });
    return st;
  };
  // C1: app boots, WebGPU available, no console errors on a cold start.
  await check('boot: app loads clean with WebGPU', 'boot', async () => {
    const v = await cdp.evaluate(`(async () => {
      const adapter = navigator.gpu ? !!(await navigator.gpu.requestAdapter().catch(() => null)) : false;
      return JSON.stringify({
        href: location.href, gpu: !!navigator.gpu, secure: isSecureContext,
        adapter,
        gateHidden: document.querySelector('#gpu-gate')?.hidden ?? true,
        gateDetail: document.querySelector('#gpu-gate-detail')?.textContent ?? '',
        cells: document.querySelectorAll('.catalog-cell').length,
        errs: window.__qa.errs,
      });
    })()`);
    const s = JSON.parse(v);
    if (!s.gpu) throw new Error('navigator.gpu missing — WebGPU unavailable in this Chrome');
    if (!s.adapter || !s.gateHidden) {
      // Fail LOUDLY: without an adapter the app shows its gate and every later
      // check would measure an empty shell and "pass" vacuously.
      throw new Error(`no WebGPU adapter (gate detail: "${s.gateDetail}") — check the Chrome flags; see scripts/probe-gpu-flags.mjs`);
    }
    if (!s.secure) throw new Error('not a secure context');
    if (s.errs.length) throw new Error(`console errors on boot: ${s.errs.slice(0, 3).join(' | ')}`);
    return `gpu=true adapter=true gateHidden=true secure=true cells=${s.cells} errors=0`;
  });

  // C2: import path — the picker stub is hit, rows land in IndexedDB, grid renders.
  await check('import: folder picker -> IDB rows -> grid cells', 'import', async () => {
    await cdp.evaluate(seed([{ name: 'A.dng', url: FIXTURE_DNG }, { name: 'B.jpg', gen: { bg: '#c0392b', fg: '#2980b9' } }]));
    await waitFor(cdp, `window.__qa.seedState !== 'pending' ? window.__qa.seedState : false`, { timeout: 60000 });
    const st = await cdp.evaluate('window.__qa.seedState');
    if (!st.startsWith('ok')) throw new Error(`seed failed: ${st}`);
    await clickEl(cdp, '#add-folder');
    await waitFor(cdp, `document.querySelectorAll('.catalog-cell').length >= 2 ? document.querySelectorAll('.catalog-cell').length : false`);
    const rows = await cdp.evaluate(`new Promise(res => {
      const q = indexedDB.open('candela-catalog');
      q.onsuccess = () => { const db = q.result;
        const g = db.transaction('files','readonly').objectStore('files').getAll();
        g.onsuccess = () => { db.close(); res(JSON.stringify(g.result.map(r => ({ n: r.name, s: r.size })))); };
        g.onerror = () => { db.close(); res('ERR'); }; };
      q.onerror = () => res('ERR-OPEN');
    })`);
    const parsed = JSON.parse(rows);
    if (parsed.length < 2) throw new Error(`IDB files rows = ${parsed.length}, expected >= 2 (${rows})`);
    return `seeded=${st.slice(3)} idbRows=${parsed.length} cells>=2`;
  });

  // C3: rating persistence — the culling contract. Rate, reload, assert it stuck.
  await check('cull: rating survives a reload', 'catalog', async () => {
    await cdp.evaluate(`(() => {
      const cell = document.querySelector('.catalog-cell');
      const star = cell.querySelectorAll('.cell-star')[3]; // 4th star = rating 4
      star.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return 'clicked';
    })()`);
    await sleep(1200);
    const before = await cdp.evaluate(`JSON.stringify((() => {
      const on = [...document.querySelectorAll('.catalog-cell .cell-star.on')].length;
      return { litStars: on, footer: document.querySelector('#footer-counts').textContent };
    })())`);
    await cdp.send('Page.reload', { ignoreCache: false });
    await sleep(3000);
    await waitFor(cdp, `document.querySelectorAll('.catalog-cell').length >= 2 ? true : false`, { timeout: 20000 });
    const after = await cdp.evaluate(`JSON.stringify((() => {
      const lit = [...document.querySelectorAll('.catalog-cell')].map(c => c.querySelectorAll('.cell-star.on').length);
      return { perCellLit: lit, footer: document.querySelector('#footer-counts').textContent };
    })())`);
    const b = JSON.parse(before), a = JSON.parse(after);
    if (!a.perCellLit.some((n) => n === 4)) {
      throw new Error(`rating lost across reload: before=${JSON.stringify(b)} after=${JSON.stringify(a)}`);
    }
    return `litStars ${b.litStars} -> perCell ${JSON.stringify(a.perCellLit)} (4-star survived)`;
  });

  // C4: the post-reload degradation + restore banner (the user-reported bug).
  // Grants are empty after reload, so developed renders must fail, the banner
  // must appear, and one gesture must converge the strip back to colour.
  //
  // Self-contained on purpose: it clears the thumbnail caches and reloads
  // itself instead of riding C3's reload. WHY the clear matters: C2's import
  // renders the DNG's developed thumb SUCCESSFULLY and caches it in
  // editedThumbnails; after a reload getThumbnailBlob serves that cached blob
  // without ever touching the file, so no read is denied and the banner
  // legitimately never appears (this check timed out for exactly that reason).
  // A real user hits the banner when the cache is cold or stale.
  await check('restore: banner appears after reload, click re-renders', 'catalog', async () => {
    // The banner only appears when a *developed RAW* render is denied after a
    // reload; a JPEG-only seed never fails to read (JPEG thumbs come from the
    // camera-embedded path), so --fast has nothing to restore.
    if (fast) return 'SKIPPED (--fast: needs a RAW whose developed render fails on denial)';
    await cdp.evaluate(`new Promise(res => { const q = indexedDB.open('candela-catalog');
      q.onsuccess = () => { const db = q.result;
        const tx = db.transaction(['thumbnails','editedThumbnails'], 'readwrite');
        tx.objectStore('thumbnails').clear(); tx.objectStore('editedThumbnails').clear();
        tx.oncomplete = () => { db.close(); res('cleared'); }; };
      q.onerror = () => res('ERR'); })`);
    await cdp.send('Page.reload', { ignoreCache: false });
    await sleep(2500);
    await waitFor(cdp, `document.querySelectorAll('.catalog-cell').length >= 1 ? true : false`, { timeout: 20000 });
    const grants = await cdp.evaluate('[...window.__qa.grants].join(",")');
    if (grants) throw new Error(`expected empty grants after reload, got: ${grants}`);
    await waitFor(cdp, `!document.querySelector('#restore-banner').hidden ? document.querySelector('#restore-banner-text').textContent : false`, { timeout: 60000 });
    const text = await cdp.evaluate(`document.querySelector('#restore-banner-text').textContent`);
    const footer = await cdp.evaluate(`document.querySelector('#footer-counts').textContent`);
    const denied = await cdp.evaluate(`window.__qa.reqLog.filter(x => x.startsWith('deny')).length`);
    // Banner must be reachable from Develop too (it sits above the shared strip).
    await gotoModule('develop');
    const inDevelop = await cdp.evaluate(`document.querySelector('#restore-banner').offsetParent !== null`);
    if (!inDevelop) throw new Error('banner not visible in Develop module');
    await gotoModule('library');
    await clickEl(cdp, '#restore-banner-btn');
    await waitFor(cdp, `document.querySelector('#restore-banner').hidden ? true : false`, { timeout: 20000 });
    const reqLog = await cdp.evaluate('JSON.stringify(window.__qa.reqLog)');
    if (!/grant/.test(reqLog)) throw new Error(`restore click did not re-grant: ${reqLog}`);
    return `banner="${text}" footer="${footer}" denials=${denied} visibleInDevelop=${inDevelop} -> hidden after click, reqLog=${reqLog}`;
  });

  // C5: print geometry, measured on the PDF the printer would receive.
  await check('print: PDF has 1 page, white canvas, sheet at paper origin', 'print', async () => {
    await cdp.evaluate(`(() => {
      const t=[...document.querySelectorAll('#topbar button')].find(b=>/print/i.test(b.textContent)); t?.click();
      const c = new OffscreenCanvas(3000, 2000); const g = c.getContext('2d');
      g.fillStyle = '#8899aa'; g.fillRect(0,0,3000,2000);
      g.fillStyle = '#cc3344'; g.fillRect(0,0,600,600);
      c.convertToBlob({ type: 'image/jpeg', quality: 0.9 }).then(b => {
        const img = document.querySelector('#print-image');
        img.src = URL.createObjectURL(b); img.hidden = false;
        document.querySelector('#print-empty').hidden = true;
      });
      return 1;
    })()`);
    await waitFor(cdp, `document.querySelector('#print-image').naturalWidth > 0 ? true : false`);
    const buf = await printPdf(cdp);
    const info = inspectPdf(buf);
    if (info.pages !== 1) throw new Error(`PDF pages = ${info.pages}, expected 1 (sheet overflows the page)`);
    if (info.images < 1) throw new Error('PDF contains no image — the photo never reached paper');
    // The sheet is 794x1122 CSS px at this paper size; a dark painted rect
    // over 25% of that area means the app's dark UI is reaching the paper.
    const SHEET_AREA = 794 * 1122;
    const bigDark = info.darkFills.filter((f) => f.area > SHEET_AREA * 0.25);
    if (bigDark.length) {
      throw new Error(`PDF paints ${bigDark.length} dark rect(s) over 25% of the sheet: ${JSON.stringify(bigDark.map((f) => ({ rgb: f.rgb, area: Math.round(f.area) })))} — the dark UI is printing`);
    }
    const p = info.placements[0];
    if (!p) throw new Error('no image placement found in the PDF content stream');
    // Device space here = CSS px * 3.125 (Skia's 72dpi->225dpi raster scale).
    // A4 portrait sheet = 794x1122 CSS px. With the 10mm default margin the
    // photo's left edge lands at 38 CSS px = 118.75 device units.
    const R = 3.125;
    const SHEET_W = 794 * R, SHEET_H = 1122 * R;
    const yTop = Math.max(p.y, p.y + p.h);   // PDF y grows up; h may be negative
    const yBottom = Math.min(p.y, p.y + p.h);
    if (p.x < 100 || p.x > 160) throw new Error(`image x=${p.x} device units, expected ~118 (a 10mm margin)`);
    if (p.x + p.w > SHEET_W + 1) throw new Error(`image overflows the sheet: x+w=${p.x + p.w} > ${SHEET_W}`);
    if (yTop > SHEET_H + 1 || yBottom < -1) throw new Error(`image overflows vertically: spans [${yBottom}, ${yTop}], sheet [0, ${SHEET_H}]`);
    const worstDark = info.darkFills[0] ? `largestDark=${Math.round(info.darkFills[0].area)}px²@${JSON.stringify(info.darkFills[0].rgb)}` : 'noDarkFills';
    return `pages=1 images=${info.images} ${worstDark} placement x=${p.x} yspan=[${yBottom},${yTop}] w=${p.w} (sheet ${SHEET_W}x${SHEET_H}), bytes=${info.bytes}`;
  });

  // C6: paper/orientation/margin options each change the geometry they name.
  await check('print: paper + orientation + margin change @page and image rect', 'print', async () => {
    // offsetWidth/offsetHeight, NOT getBoundingClientRect: the preview sheet
    // carries a `zoom` from fitPrintPreview() (0.42-0.67 depending on window
    // height), and getBoundingClientRect folds that zoom in — reading it gave
    // 529x749 for what is a 794x1122 CSS-px A4 sheet. offset* is layout size.
    const readState = () => cdp.evaluate(`JSON.stringify((() => {
      const p = document.querySelector('#print-page'), i = document.querySelector('#print-image');
      const rule = [...document.querySelectorAll('style')].map(s=>s.textContent).find(t=>/@page/.test(t)) || '';
      return { page: [p.offsetWidth, p.offsetHeight],
               img: [Math.round(i.getBoundingClientRect().width / (parseFloat(getComputedStyle(p).zoom) || 1)),
                     Math.round(i.getBoundingClientRect().height / (parseFloat(getComputedStyle(p).zoom) || 1))],
               zoom: getComputedStyle(p).zoom,
               atPage: (rule.match(/size: ([^;]+);/) || [])[1] || 'none' };
    })())`);
    const setOpt = (sel, val) => cdp.evaluate(`(() => { const s=document.querySelector('${sel}'); s.value='${val}';
      s.dispatchEvent(new Event('input',{bubbles:true})); s.dispatchEvent(new Event('change',{bubbles:true})); return s.value; })()`);
    const out = [];
    const a4 = JSON.parse(await readState()); out.push(`A4 portrait @page=${a4.atPage} sheet=${a4.page} zoom=${Number(a4.zoom).toFixed(3)}`);
    if (a4.page[0] !== 794 || a4.page[1] !== 1123) throw new Error(`A4 sheet should be 794x1123 CSS px (210x297mm), got ${a4.page}`);
    if (a4.atPage !== '210mm 297mm') throw new Error(`@page size should be '210mm 297mm', got '${a4.atPage}'`);
    await setOpt('#print-orientation', 'landscape'); await sleep(400);
    const land = JSON.parse(await readState()); out.push(`landscape @page=${land.atPage} sheet=${land.page}`);
    if (land.page[0] !== 1123 || land.page[1] !== 794) throw new Error(`landscape must swap axes, got ${land.page}`);
    if (land.atPage !== '297mm 210mm') throw new Error(`landscape @page should be '297mm 210mm', got '${land.atPage}'`);
    await setOpt('#print-orientation', 'portrait'); await sleep(300);
    await setOpt('#print-paper', 'letter'); await sleep(400);
    const letter = JSON.parse(await readState()); out.push(`Letter @page=${letter.atPage} sheet=${letter.page}`);
    if (letter.page[0] !== 816 || letter.page[1] !== 1056) throw new Error(`Letter must be 816x1056 CSS px (215.9x279.4mm), got ${letter.page}`);
    await setOpt('#print-paper', 'a4'); await sleep(300);
    await setOpt('#print-margin', '0'); await sleep(400);
    const noMargin = JSON.parse(await readState()); out.push(`margin0 img=${noMargin.img}`);
    await setOpt('#print-margin', '20'); await sleep(400);
    const wide = JSON.parse(await readState()); out.push(`margin20 img=${wide.img}`);
    if (wide.img[0] >= noMargin.img[0]) throw new Error(`a wider margin must shrink the image: ${noMargin.img[0]} -> ${wide.img[0]}`);
    await setOpt('#print-margin', '10'); await sleep(300);
    // Return home: later checks click Library-aside controls (#add-folder),
    // which are 0x0 while the Print module owns the layout — leaving the app
    // in Print silently starved the whole export/exif/keyword chain once.
    await gotoModule('library');
    return out.join(' | ');
  });

  // C6.5: the print calibration matrix. INSTRUMENTATION, not a behaviour
  // change: it measures the PDF a printer would receive for every
  // paper x orientation x margin and converts each number into millimetres, so
  // "off-centre / wrong physical scale / distorted / preview != paper" becomes a
  // reading instead of an opinion. Nothing here asserts how the app should
  // behave beyond the geometry the owner reported.
  //
  // UNITS, measured off this harness's own PDF output (see inspectPdf's note):
  //   - /MediaBox is PostScript points (210mm -> 594.96, i.e. ~72 pt/inch);
  //   - placements are 1/300 inch (the page opens with 0.24 = 72/300), which is
  //     the same space C5's `794 * 3.125` sheet lives in;
  //   - the `re` rects behind darkFills.area are CSS px (a further 3.125 inside).
  // Every gap below is therefore computed in the 1/300-inch placement space, with
  // the MediaBox scaled into it, and the dark-fill test uses the CSS-px sheet
  // area -- the space darkFills.area is actually measured in. A device-unit
  // threshold applied to a CSS-px area would be ~9.8x too loose and would let a
  // full-page black sheet pass, which is exactly the regression C5 exists to
  // catch.
  const PRINT_PAPERS_MM = { a4: [210, 297], letter: [215.9, 279.4], '5x7': [127, 177.8] };
  await check('print: calibration matrix — every paper/orient/margin is centered, true-scale, undistorted', 'print', async () => {
    const DEV_IN = 300;                              // placement units per inch
    const PT_IN = 72;                                // PDF default user space
    const CSS_PX_IN = 96;                            // 3.125 = DEV_IN / CSS_PX_IN
    const mm2dev = (mm) => mm / 25.4 * DEV_IN;       // the task's conversion
    const dev2mm = (u) => u / DEV_IN * 25.4;
    // Chrome's print raster: 300 device units per inch over 96 CSS px per
    // inch. C5 hardcodes the same value as R.
    const DEV_PER_CSS_PX = 3.125;
    const f = (v) => (Number.isFinite(v) ? v.toFixed(2) : String(v));
    const f3 = (v) => (Number.isFinite(v) ? v.toFixed(3) : String(v));

    await cdp.evaluate(`(() => { const t=[...document.querySelectorAll('#topbar button')].find(b=>/print/i.test(b.textContent)); t?.click(); return 1; })()`);
    // Enter the print module and let its OWN developed render land before
    // swapping in the synthetic photo. renderPrintView() is async (GPU export),
    // so injecting immediately races it: the app's blob would resolve later and
    // replace ours mid-matrix, and the aspect assertion would then be measuring
    // some catalogue RAW instead of the 3:2 we know.
    await waitFor(cdp, `document.querySelector('#print-image').hidden === true || (document.querySelector('#print-image').naturalWidth > 0 && document.querySelector('#print-image').naturalWidth !== 3000) ? true : false`, { timeout: 30000 });
    // 3:2 landscape source, exactly C5's injection, so the expected aspect is a
    // known constant rather than whatever the catalog happens to hold.
    await cdp.evaluate(`(() => {
      const c = new OffscreenCanvas(3000, 2000); const g = c.getContext('2d');
      g.fillStyle = '#8899aa'; g.fillRect(0,0,3000,2000);
      g.fillStyle = '#cc3344'; g.fillRect(0,0,600,600);
      c.convertToBlob({ type: 'image/jpeg', quality: 0.9 }).then(b => {
        const img = document.querySelector('#print-image');
        img.src = URL.createObjectURL(b); img.hidden = false;
        document.querySelector('#print-empty').hidden = true;
      });
      return 1;
    })()`);
    await waitFor(cdp, `document.querySelector('#print-image').naturalWidth === 3000 ? true : false`);

    const readState = () => cdp.evaluate(`JSON.stringify((() => {
      const p = document.querySelector('#print-page'), i = document.querySelector('#print-image');
      const rule = [...document.querySelectorAll('style')].map(s=>s.textContent).find(t=>/@page/.test(t)) || '';
      const z = parseFloat(getComputedStyle(p).zoom) || 1;
      const r = i.getBoundingClientRect();
      return { page: [p.offsetWidth, p.offsetHeight],
               img: [Math.round(r.width / z), Math.round(r.height / z)],
               imgPrec: [r.width / z, r.height / z],
               nat: [i.naturalWidth, i.naturalHeight],
               zoom: getComputedStyle(p).zoom,
               atPage: (rule.match(/size: ([^;]+);/) || [])[1] || 'none' };
    })())`);
    const setOpt = (sel, val) => cdp.evaluate(`(() => { const s=document.querySelector('${sel}'); s.value='${val}';
      s.dispatchEvent(new Event('input',{bubbles:true})); s.dispatchEvent(new Event('change',{bubbles:true})); return s.value; })()`);

    const rows = [];
    const failures = [];
    const densities = [];
    let ptPerIn = null;      // measured MediaBox units per inch, from combination 1
    let devPerPt = null;     // placement units per MediaBox unit
    let boxFallback = false; // MediaBox absent -> C5's sheet-px * 3.125 expectation
    let worstCenterMm = 0;

    for (const paper of ['a4', 'letter', '5x7']) {
      for (const orient of ['portrait', 'landscape']) {
        for (const margin of ['0', '10', '20']) {
          const combo = `${paper}/${orient}/m${margin}`;
          await setOpt('#print-paper', paper);
          await setOpt('#print-orientation', orient);
          await setOpt('#print-margin', margin);
          await sleep(350); // applyPrintLayout() runs on change; 350ms is C6's settled geometry
          const buf = await printPdf(cdp); // no args: @page alone must decide the box
          let info;
          try { info = inspectPdf(buf); }
          catch (err) {
            failures.push(`print calibration ${combo}: inspectPdf failed: ${err.message}`);
            continue;
          }
          const st = JSON.parse(await readState());
          const [expW, expH] = PRINT_PAPERS_MM[paper];
          const pageMm = orient === 'landscape' ? [expH, expW] : [expW, expH];
          // Every failure names its combination and carries the raw numbers for
          // it, so the arithmetic can be re-done by hand. Seeded with what is
          // known before the placement is read, so a missing placement still
          // reports the page box and the DOM state.
          let raw = { combo, mediaBox: info.mediaBox, pages: info.pages, images: info.images,
                      sheetPx: st.page, imgPx: st.img, nat: st.nat, zoom: st.zoom, atPage: st.atPage };
          // Violations are collected, not thrown in place: the matrix table is
          // the deliverable, and a throw at combination 13 would silently cost
          // the remaining five. The check still fails, and each entry carries
          // its own combination name and raw numbers.
          const fail = (msg) => { failures.push(`print calibration ${combo}: ${msg}\n  raw=${JSON.stringify(raw)}`); };

          if (info.mediaBox && info.mediaBox.length >= 4) {
            const d = (info.mediaBox[2] - info.mediaBox[0]) / (pageMm[0] / 25.4);
            densities.push({ combo, d });
            if (ptPerIn === null) { ptPerIn = d; devPerPt = DEV_IN / ptPerIn; }
          }
          let pageBoxW, pageBoxH;
          if (info.mediaBox && devPerPt) {
            pageBoxW = (info.mediaBox[2] - info.mediaBox[0]) * devPerPt;
            pageBoxH = (info.mediaBox[3] - info.mediaBox[1]) * devPerPt;
          } else {
            // No MediaBox to read: fall back to C5's `794 * 3.125` style
            // expectation, i.e. the preview sheet in CSS px times the same
            // raster ratio, and flag it in the row.
            boxFallback = true;
            pageBoxW = st.page[0] * (DEV_IN / CSS_PX_IN);
            pageBoxH = st.page[1] * (DEV_IN / CSS_PX_IN);
          }

          const p = info.placements[0];
          if (!p) { fail('no image placement found in the PDF content stream'); continue; }
          const yTop = Math.max(p.y, p.y + p.h);    // PDF y grows up; h may be negative
          const yBottom = Math.min(p.y, p.y + p.h);
          const L = p.x, R = pageBoxW - (p.x + p.w);
          const B = yBottom, T = pageBoxH - yTop;
          const aspect = p.w / Math.abs(p.h);
          const prevAspect = st.imgPrec[0] / st.imgPrec[1];
          const pdfW = p.w / DEV_PER_CSS_PX, pdfH = Math.abs(p.h) / DEV_PER_CSS_PX;
          const snapW = Math.abs(pdfW - st.imgPrec[0]), snapH = Math.abs(pdfH - st.imgPrec[1]);
          const mDev = mm2dev(Number(margin));
          // Which axis did object-fit: contain bind? The fitted axis spans the
          // whole padding box, so its margin gap IS the selected margin; the
          // other axis only gets >= margin.
          const spanErrW = Math.abs(p.w - (pageBoxW - 2 * mDev));
          const spanErrH = Math.abs(Math.abs(p.h) - (pageBoxH - 2 * mDev));
          const axis = spanErrW <= spanErrH ? 'width' : 'height';
          const cGap = axis === 'width' ? [L, R] : [T, B];
          const oGap = axis === 'width' ? [T, B] : [L, R];
          const centerErrMm = Math.max(dev2mm(Math.abs(L - R)), dev2mm(Math.abs(T - B)));
          worstCenterMm = Math.max(worstCenterMm, centerErrMm);

          raw = {
            combo, mediaBox: info.mediaBox, pages: info.pages, images: info.images,
            place: [p.x, p.y, p.w, p.h], pageBox: [+f(pageBoxW), +f(pageBoxH)],
            gapsDev: [L, T, R, B].map((v) => +f(v)), gapsMm: [L, T, R, B].map((v) => +dev2mm(v).toFixed(3)),
            aspect: +aspect.toFixed(5), prevAspect: +prevAspect.toFixed(5), axis,
            pdfPx: [+f3(pdfW), +f3(pdfH)], snapPx: [+f3(snapW), +f3(snapH)],
            sheetPx: st.page, imgPx: st.img, nat: st.nat, zoom: st.zoom, atPage: st.atPage,
          };
          // Logged per row as measured: if a later combination throws, the
          // numbers for the ones that did not are still on stdout.
          console.log(`  row ${combo} ${JSON.stringify(raw)}`);
          rows.push(raw);

          if (st.nat[0] !== 3000 || st.nat[1] !== 2000) {
            fail(`the injected 3:2 photo is no longer the live image (natural=${JSON.stringify(st.nat)}), so the aspect/scale readings below are not ours`);
          }
          if (info.pages !== 1) fail(`PDF pages=${info.pages}, expected 1 (the sheet overflows the page box)`);
          if (info.images < 1) fail('PDF contains no image — the photo never reached paper');
          const bigDark = info.darkFills.filter((x) => x.area > 0.25 * st.page[0] * st.page[1]);
          if (bigDark.length) {
            fail(`${bigDark.length} dark fill(s) over 25% of the ${st.page[0]}x${st.page[1]}px sheet: ${JSON.stringify(bigDark.map((x) => ({ rgb: x.rgb, area: Math.round(x.area) })))} — the dark UI is printing`);
          }
          // Distortion: the placed rect must keep the source's 3:2. The
          // tolerance is size-aware because Chrome snaps the painted rect to
          // whole CSS px and 1px costs the most percentage on the narrowest
          // sheet -- 5x7 portrait at a 20mm margin lays out 328.82x219.21 and
          // paints 328x220, which is 0.61% off 1.5 while being 0.21mm from
          // ideal on paper.
          const aspectTol = 0.005 + 2 / Math.min(st.imgPrec[0], st.imgPrec[1]);
          if (Math.abs(aspect / 1.5 - 1) > aspectTol) {
            fail(`placed aspect ${f3(aspect)} is more than ${(aspectTol * 100).toFixed(2)}% off the injected 1.5 (w=${f(p.w)} h=${f(Math.abs(p.h))}, rect ${f3(st.imgPrec[0])}x${f3(st.imgPrec[1])} CSS px)`);
          }
          // The painted rect must match the laid-out rect within Chrome's 1px
          // snap. This is the direct shrink-to-fit detector: when #topbar's
          // 552px nowrap row overflowed the 480px 5x7 page, Chrome scaled the
          // whole document by 0.870 and painted 351.5px where the DOM had laid
          // out 404.4px -- 53px off, against a 1px allowance.
          if (snapW > 1 || snapH > 1) {
            fail(`PDF image rect ${f3(pdfW)}x${f3(pdfH)} CSS px disagrees with the laid-out ${f3(st.imgPrec[0])}x${f3(st.imgPrec[1])} by ${f3(snapW)}/${f3(snapH)}px (>1 CSS px) -- the document was scaled, or the print layout is not what the preview lays out`);
          }
          // Centering on both axes.
          if (Math.abs(L - R) > mm2dev(0.5)) {
            fail(`not horizontally centered: L=${f(L)} R=${f(R)} dev (${f3(dev2mm(L))}mm / ${f3(dev2mm(R))}mm), |L-R|=${f3(dev2mm(Math.abs(L - R)))}mm > 0.5mm`);
          }
          if (Math.abs(T - B) > mm2dev(0.5)) {
            fail(`not vertically centered: T=${f(T)} B=${f(B)} dev (${f3(dev2mm(T))}mm / ${f3(dev2mm(B))}mm), |T-B|=${f3(dev2mm(Math.abs(T - B)))}mm > 0.5mm`);
          }
          // True scale against the selected margin on the axis the image was fitted to.
          const cErr = Math.max(Math.abs(cGap[0] - mDev), Math.abs(cGap[1] - mDev));
          if (cErr > mm2dev(0.5)) {
            fail(`constrained axis=${axis}: gaps ${f(cGap[0])}/${f(cGap[1])} dev (${f3(dev2mm(cGap[0]))}/${f3(dev2mm(cGap[1]))}mm) vs margin ${margin}mm = ${f(mDev)} dev, error ${f3(dev2mm(cErr))}mm > 0.5mm`);
          }
          if (Math.min(oGap[0], oGap[1]) < mDev - mm2dev(0.5)) {
            fail(`free axis gaps ${f(oGap[0])}/${f(oGap[1])} dev (${f3(dev2mm(oGap[0]))}/${f3(dev2mm(oGap[1]))}mm) fall below margin ${margin}mm - 0.5mm`);
          }
          // Physical page size: the MediaBox itself, in mm (points are 72/inch
          // by definition of the PDF user space, so this is a real check on what
          // @page produced, not a restatement of the input).
          if (info.mediaBox) {
            const mbW = (info.mediaBox[2] - info.mediaBox[0]) * 25.4 / PT_IN;
            const mbH = (info.mediaBox[3] - info.mediaBox[1]) * 25.4 / PT_IN;
            if (Math.abs(mbW - pageMm[0]) > 0.6 || Math.abs(mbH - pageMm[1]) > 0.6) {
              fail(`page box is ${f3(mbW)}x${f3(mbH)}mm, expected ${pageMm[0]}x${pageMm[1]}mm +/-0.6mm (@page="${st.atPage}")`);
            }
          } else {
            fail(`no /MediaBox in the raw PDF, page size could not be verified (boxSource=sheet-px fallback, devPerPt=${devPerPt ? f3(devPerPt) : 'null'})`);
          }
        }
      }
    }

    const dSpread = densities.length
      ? Math.max(...densities.map((x) => x.d)) - Math.min(...densities.map((x) => x.d))
      : 0;
    const cols = [
      ['combo', (r) => r.combo],
      ['mediaBox', (r) => (r.mediaBox ? r.mediaBox.join(' ') : 'NULL')],
      ['pageBoxDev', (r) => `${r.pageBox[0]}x${r.pageBox[1]}`],
      ['place x', (r) => f(r.place[0])], ['place y', (r) => f(r.place[1])],
      ['place w', (r) => f(r.place[2])], ['place h', (r) => f(r.place[3])],
      ['Ldev', (r) => f(r.gapsDev[0])], ['Tdev', (r) => f(r.gapsDev[1])],
      ['Rdev', (r) => f(r.gapsDev[2])], ['Bdev', (r) => f(r.gapsDev[3])],
      ['Lmm', (r) => f3(r.gapsMm[0])], ['Tmm', (r) => f3(r.gapsMm[1])],
      ['Rmm', (r) => f3(r.gapsMm[2])], ['Bmm', (r) => f3(r.gapsMm[3])],
      ['aspect', (r) => f3(r.aspect)], ['prevAspect', (r) => f3(r.prevAspect)],
      ['pdfW', (r) => f3(r.pdfPx[0])], ['pdfH', (r) => f3(r.pdfPx[1])],
      ['snapW', (r) => f3(r.snapPx[0])], ['snapH', (r) => f3(r.snapPx[1])],
      ['axis', (r) => r.axis], ['sheetPx', (r) => r.sheetPx.join('x')],
      ['imgPx', (r) => r.imgPx.join('x')], ['nat', (r) => r.nat.join('x')],
      ['zoom', (r) => String(r.zoom)], ['@page', (r) => String(r.atPage)],
      ['pages', (r) => String(r.pages)], ['imgs', (r) => String(r.images)],
    ];
    console.log('\nprint calibration matrix (device units = 1/300 inch, MediaBox = PostScript points):');
    const cells = rows.map((r) => cols.map((c) => String(c[1](r))));
    const widths = cols.map((c, i) => Math.max(c[0].length, ...cells.map((row) => row[i].length)));
    const line = (arr) => arr.map((v, i) => v.padStart(widths[i])).join(' ');
    console.log(line(cols.map((c) => c[0])));
    for (const row of cells) console.log(line(row));
    console.log(`derived MediaBox units per inch = ${ptPerIn ? f3(ptPerIn) : 'null'} (used as ${ptPerIn ? f3(ptPerIn) : '-'} pt/in -> ${devPerPt ? f3(devPerPt) : 'null'} placement units per MediaBox unit; placement space density ${DEV_IN}/inch); spread across ${densities.length} boxes = ${f3(dSpread)} (${f3(dSpread / (ptPerIn || 1) * 100)}%)${boxFallback ? ' — MediaBox WAS NULL for some combination, sheet-px fallback used' : ''}`);

    // Same teardown as C6: the app must not be left in Print or the checks
    // after this one click Library-aside controls that are 0x0 and starve.
    await setOpt('#print-paper', 'a4');
    await setOpt('#print-orientation', 'portrait');
    await setOpt('#print-margin', '10');
    await sleep(300);
    await gotoModule('library');
    // Thrown AFTER the table is logged and the app is restored home, so a red
    // matrix neither costs the remaining combinations nor starves later checks.
    if (failures.length) throw new Error(failures.join('\n'));
    return `${rows.length}/18 combos passed | MediaBox ${f3(ptPerIn)} units/in -> ${f3(devPerPt)} dev/unit (placement space ${DEV_IN}/in) | worst centering error ${f3(worstCenterMm)}mm`;
  });

  // C7: crop overlay — the rule-of-thirds grid must survive a re-render.
  // User report: lines visible while dragging, some gone after a re-render.
  await check('crop: 4 thirds lines + outline present before and after re-render', 'crop', async () => {
    await gotoModule('develop');
    const cell = await cdp.evaluate(`(() => { const c = document.querySelector('.filmstrip-cell, .catalog-cell'); return c ? c.dataset.fileId : null; })()`);
    if (!cell) throw new Error('no photo to open');
    await clickEl(cdp, '.filmstrip-cell');
    await sleep(2500);
    await cdp.evaluate(`(() => { document.querySelector('#crop-toggle')?.click(); return 1; })()`);
    await sleep(1500);
    const scan = `JSON.stringify((() => {
      const ov = document.querySelector('#crop-overlay');
      if (!ov || ov.hidden) return { hidden: true };
      const W = ov.width, H = ov.height;
      if (!W || !H) return { hidden: true, W, H };
      const d = ov.getContext('2d').getImageData(0, 0, W, H).data;
      const A = (x, y) => x>=0&&y>=0&&x<W&&y<H ? d[(y*W+x)*4+3] : -1;
      const N = 300;
      const col = (tx) => { let h=0; for(let k=0;k<N;k++){ const y=Math.round(H*k/(N-1)); if(A(Math.round(tx),y)>60) h++; } return h; };
      const row = (ty) => { let h=0; for(let k=0;k<N;k++){ const x=Math.round(W*k/(N-1)); if(A(x,Math.round(ty))>60) h++; } return h; };
      // frame = the outline run on the middle row/col
      let x0=-1,x1=-1,y0=-1,y1=-1;
      for(let x=0;x<W;x++) if(A(x, Math.round(H/2))>150){ if(x0<0)x0=x; x1=x; }
      for(let y=0;y<H;y++) if(A(Math.round(W/2), y)>150){ if(y0<0)y0=y; y1=y; }
      if(x0<0||y0<0) return { outline: 'not-found', W, H };
      const rw=x1-x0, rh=y1-y0;
      const near = (f, probe, span) => { let best=0; for(let o=-3;o<=3;o++){ const v=f(probe+o); if(v>best)best=v; } return best; };
      return { W, H, frame:[x0,y0,rw,rh],
        v1: near(col, x0+rw/3), v2: near(col, x0+2*rw/3),
        h1: near(row, y0+rh/3), h2: near(row, y0+2*rh/3),
        outlineTop: near(row, y0), outlineLeft: near(col, x0) };
    })())`;
    const first = JSON.parse(await cdp.evaluate(scan));
    if (first.hidden) throw new Error('crop overlay never became visible');
    if (first.outline === 'not-found') throw new Error(`crop frame outline not found in ${first.W}x${first.H} overlay`);
    // Force a re-render while the crop workbench is open (the reported trigger).
    await cdp.evaluate(`(() => { const s = document.querySelector('#exposure');
      s.value = '0.7'; s.dispatchEvent(new Event('input',{bubbles:true})); return 1; })()`);
    await sleep(1500);
    await cdp.evaluate(`(() => { const s = document.querySelector('#exposure');
      s.dispatchEvent(new Event('change',{bubbles:true})); return 1; })()`);
    await sleep(2500);
    const second = JSON.parse(await cdp.evaluate(scan));
    const need = (v, label, span) => {
      const min = Math.max(8, span * 0.5);
      if (!(v >= min)) throw new Error(`${label} line has only ${v}/${span} visible samples (min ${min})`);
    };
    const spanV = first.frame[3], spanH = first.frame[2];
    need(first.v1, 'before v1', spanV); need(first.v2, 'before v2', spanV);
    need(first.h1, 'before h1', spanH); need(first.h2, 'before h2', spanH);
    need(second.v1, 'after v1', spanV); need(second.v2, 'after v2', spanV);
    need(second.h1, 'after h1', spanH); need(second.h2, 'after h2', spanH);
    // CLEANUP: exit crop mode. Leaving it on kept #canvas at the 64x48 crop
    // workbench size for every later check — export then waited forever for a
    // >1000px canvas and stability "passed" on a 64x48 canvas vacuously.
    await cdp.evaluate(`(() => { document.querySelector('#crop-toggle')?.click(); return 1; })()`);
    await waitFor(cdp, `document.querySelector('#crop-overlay')?.hidden !== false ? true : false`, { timeout: 10000 });
    return `overlay ${first.W}x${first.H} frame=${JSON.stringify(first.frame)}; thirds before v1/v2/h1/h2=${first.v1}/${first.v2}/${first.h1}/${first.h2} after=${second.v1}/${second.v2}/${second.h1}/${second.h2} (spans ${spanV}v ${spanH}h)`;
  });

  // C8: export source toggle — Edited renders through the pipeline, Camera JPEG
  // hands over the embedded bytes verbatim (user report: both gave the edit).
  await check('export: toggle switches Edited render vs Camera JPEG bytes', 'export', async () => {
    if (fast) return 'SKIPPED (--fast: needs the 58MB Fuji RAF)';
    // The crop check leaves the app in Develop, where #add-folder (a Library
    // aside control) is 0x0 — the re-import below silently clicked nothing.
    await gotoModule('library');
    await cdp.evaluate(seed([{ name: 'FUJI_BW.raf', url: FIXTURE_RAF }]));
    await waitFor(cdp, `window.__qa.seedState !== 'pending' ? window.__qa.seedState : false`, { timeout: 120000 });
    await cdp.evaluate(`new Promise(res => { const q = indexedDB.open('candela-catalog');
      q.onsuccess = () => { const db = q.result;
        const tx = db.transaction(['files','edits','thumbnails','editedThumbnails'], 'readwrite');
        for (const s of ['files','edits','thumbnails','editedThumbnails']) tx.objectStore(s).clear();
        tx.oncomplete = () => { db.close(); res('cleared'); }; };
      q.onerror = () => res('ERR'); })`);
    await clickEl(cdp, '#add-folder');
    // Wait for the SETTLED post-import grid, not "cells >= 1": the old cells
    // (A.dng/B.jpg from the cull check) are still on screen while the import
    // walks, and their rows were just cleared — clicking one opens a record
    // whose OPFS file the seed deleted, the decode dies on NotFoundError and
    // the canvas never opens (this check's 180s timeout). rows==1 && cells==1
    // can only be true after renderCatalog repainted from the new import.
    await waitFor(cdp, `new Promise(res => { const q = indexedDB.open('candela-catalog');
      q.onsuccess = () => { const db = q.result;
        const r = db.transaction('files').objectStore('files').getAll();
        r.onsuccess = () => { db.close();
          res(r.result.length === 1 && document.querySelectorAll('.catalog-cell').length === 1); };
        r.onerror = () => { db.close(); res(false); }; };
      q.onerror = () => res(false); })`, { timeout: 60000 });
    // Open in Develop so the edited path has pixels. One real click selects +
    // openFile; the module switch is a SYNTHETIC dblclick on the same cell
    // (the grid's own dblclick listener) instead of a second CDP click — a
    // second real click can land while the 58MB decode blocks the renderer
    // and never synthesizes into a dblclick (this check timed out that way).
    await clickEl(cdp, '.catalog-cell');
    await sleep(300);
    await cdp.evaluate(`(() => { const c = document.querySelector('.catalog-cell');
      c.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return 1; })()`);
    await gotoModule('develop'); // verified no-op if the dblclick already switched
    // Poll with diagnostics on timeout: a bare waitFor said only "canvas
    // small" — which of click-miss / permission-denial / decode-crash it was
    // stayed a mystery. The state dump makes the next failure self-describing.
    let cw = 0;
    const tOpen = Date.now();
    while (Date.now() - tOpen < 180000) {
      cw = await cdp.evaluate(`document.querySelector('#canvas').width`);
      if (cw > 1000) break;
      await sleep(2000);
    }
    if (!(cw > 1000)) {
      const diag = await cdp.evaluate(`JSON.stringify({
        errs: window.__qa.errs.slice(-5), warns: window.__qa.warns.slice(-5),
        canvas: [document.querySelector('#canvas').width, document.querySelector('#canvas').height],
        inDevelop: !document.querySelector('#module-develop').hidden,
        selected: document.querySelectorAll('.catalog-cell.selected').length,
        grants: [...window.__qa.grants], reqLog: window.__qa.reqLog.slice(-5) })`);
      throw new Error(`canvas never opened (w=${cw} after 180s); diag=${diag}`);
    }
    const dims = await cdp.evaluate(`JSON.stringify([document.querySelector('#canvas').width, document.querySelector('#canvas').height])`);
    // Capture whatever Export would download, per mode.
    const hook = `(() => { window.__qa.dl = []; const oc = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = async function () {
        if (this.download) { try { const b = await (await fetch(this.href)).blob();
          window.__qa.dl.push({ name: this.download, size: b.size, type: b.type }); } catch (e) { window.__qa.dl.push({ name: this.download, err: String(e) }); }
          return; }
        return oc.apply(this); }; return 'hooked'; })()`;
    await cdp.evaluate(hook);
    await gotoModule('develop');
    const setMode = (mode) => cdp.evaluate(`(() => {
      const opt = document.querySelector('#sidecar-row .sidecar-option[data-option="${mode}"]');
      // cancelable:true — the app's option handler preventDefault()s the
      // wrapping label's checkbox-flip activation. A synthetic event is
      // non-cancelable by default, so preventDefault is a no-op and the
      // label flips the toggle BACK after the handler sets it — the harness
      // then measured checked=true/active=camera after clicking 'edited'
      // and blamed the app for its own untrusted-event artifact.
      opt.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return { checked: document.querySelector('#sidecar-mode-toggle').checked,
               active: [...document.querySelectorAll('#sidecar-row .sidecar-option')].filter(o=>o.classList.contains('active')).map(o=>o.dataset.option) }; })()`);
    const edited = await setMode('edited');
    if (edited.checked !== false || edited.active.join() !== 'edited') throw new Error(`toggle desync on edited: ${JSON.stringify(edited)}`);
    await clickEl(cdp, '#export-btn');
    await waitFor(cdp, `window.__qa.dl.length >= 1 ? true : false`, { timeout: 90000 });
    const camera = await setMode('camera');
    if (camera.checked !== true || camera.active.join() !== 'camera') throw new Error(`toggle desync on camera: ${JSON.stringify(camera)}`);
    await clickEl(cdp, '#export-btn');
    await waitFor(cdp, `window.__qa.dl.length >= 2 ? true : false`, { timeout: 90000 });
    const dl = JSON.parse(await cdp.evaluate('JSON.stringify(window.__qa.dl)'));
    const [e, c] = dl;
    if (!/-camera\.jpg$/.test(c.name)) throw new Error(`camera export name = ${c.name}, expected *-camera.jpg`);
    if (c.size === e.size) throw new Error(`camera and edited exports are byte-identical (${c.size}) — the toggle did not change the source`);
    return `canvas=${dims} edited="${e.name}" ${e.size}B; camera="${c.name}" ${c.size}B (differ by ${Math.abs(c.size - e.size)}B)`;
  });

  // C9: developed thumbnail must be colour for a B&W-film-sim RAW.
  await check('thumbs: RAW strip thumb is the developed render, not camera B&W', 'thumbs', async () => {
    if (fast) return 'SKIPPED (--fast: needs the 58MB Fuji RAF)';
    await waitFor(cdp, `document.querySelectorAll('.filmstrip-cell').length >= 1 ? true : false`, { timeout: 20000 });
    // Give the offscreen render queue time to drain (it decodes a 58MB RAF).
    let probe = [];
    for (let i = 0; i < 40; i++) {
      probe = JSON.parse(await cdp.evaluate(probeThumbs));
      const raf = probe.find((p) => p.spread !== undefined);
      if (probe.length && probe.every((p) => p.spread !== undefined && p.spread > 12)) break;
      await sleep(3000);
    }
    const summary = probe.map((p) => `${p.id}:sp${p.spread}:${p.w}x${p.h}`).join(' ');
    const bw = probe.filter((p) => p.spread !== undefined && p.spread <= 12);
    if (bw.length) throw new Error(`${bw.length} thumbnail(s) still camera B&W (spread<=12): ${summary}`);
    return `all thumbs colour: ${summary}`;
  });

  // C10: memory discipline — opening several files in a row must not crash and
  // must leave the canvas at the current file's size (spike pass/fail criterion).
  await check('stability: 4 sequential opens leave a live pipeline', 'stability', async () => {
    const errsBefore = await cdp.evaluate('window.__qa.errs.length');
    for (let i = 0; i < 4; i++) {
      await cdp.evaluate(`(() => { const cells=[...document.querySelectorAll('.filmstrip-cell')];
        const c = cells[${i} % Math.max(1, cells.length)]; if (c) c.dispatchEvent(new MouseEvent('click',{bubbles:true})); return 1; })()`);
      await sleep(1500);
    }
    const after = await cdp.evaluate(`JSON.stringify({ errs: window.__qa.errs.length,
      canvas: [document.querySelector('#canvas').width, document.querySelector('#canvas').height],
      gpuGate: !!document.querySelector('#gpu-gate, [id*=gpu-error]') })`);
    const s = JSON.parse(after);
    if (s.errs > errsBefore) throw new Error(`${s.errs - errsBefore} new console errors during sequential opens`);
    // Non-zero in --fast (its JPEG seed is 600x400, so >1000 is impossible);
    // >1000 in the full run, where the last opened file is the 4170px RAF and
    // a 64x48 canvas is the crop-workbench leak this assertion once caught.
    const minW = fast ? 1 : 1000;
    if (!(s.canvas[0] > minW)) throw new Error(`canvas is ${s.canvas} after sequential opens — expected width > ${minW}`);
    return `errors ${errsBefore} -> ${s.errs}, canvas=${JSON.stringify(s.canvas)}`;
  });

  // C11: EXIF reaches the catalog and the search box. The historical bug:
  // main.ts's search reads file.cameraModel, but NOTHING ever wrote it, so
  // 'X100V' matched zero photos forever. identify() at import now fills it
  // (proven values on the Fuji fixture: cameraModel 'Fujifilm X100V',
  // iso 320, focalLength 23, dateTaken = the EXIF wall-clock, NOT lastModified).
  // Runs after the RAF import so no second 58MB decode is needed.
  await check('exif: camera search finds the RAF + row carries real EXIF', 'exif', async () => {
    if (fast) return 'SKIPPED (--fast: needs the 58MB Fuji RAF import)';
    // Go home first: the export check leaves the app in Develop, and the
    // search box lives in the Library grid.
    await gotoModule('library');
    const row = JSON.parse(await cdp.evaluate(`new Promise(res => { const q = indexedDB.open('candela-catalog');
      q.onsuccess = () => { const db = q.result;
        const r = db.transaction('files').objectStore('files').getAll();
        r.onsuccess = () => { db.close(); res(JSON.stringify(r.result)); };
        r.onerror = () => { db.close(); res('[]'); }; };
      q.onerror = () => res('[]'); })`));
    const raf = row.find((f) => /\.raf$/i.test(f.name));
    if (!raf) throw new Error(`no RAF row in the catalog (rows: ${row.map((f) => f.name).join(',')})`);
    const missing = [];
    if (!/x100v/i.test(raf.cameraModel || '')) missing.push(`cameraModel=${JSON.stringify(raf.cameraModel)}`);
    if (!raf.dateTaken) missing.push('dateTaken absent');
    if (!raf.iso) missing.push(`iso=${raf.iso}`);
    if (!raf.focalLength) missing.push(`focalLength=${raf.focalLength}`);
    if (missing.length) throw new Error(`EXIF not on the row: ${missing.join(', ')} (row: ${JSON.stringify(raf).slice(0, 300)})`);
    // Live search proof: camera name matches, nonsense does not.
    const type = (q) => cdp.evaluate(`(() => { const s=document.querySelector('#search-input'); s.value='${q}';
      s.dispatchEvent(new Event('input',{bubbles:true})); return 1; })()`);
    const cellCount = () => cdp.evaluate('document.querySelectorAll(".catalog-cell").length');
    await type('X100V'); await sleep(700);
    const hit = await cellCount();
    if (hit < 1) throw new Error(`search 'X100V' matched ${hit} cells — cameraModel search is dead again`);
    await type('zzz-no-such-camera-9x7'); await sleep(700);
    const miss = await cellCount();
    if (miss !== 0) throw new Error(`nonsense query still shows ${miss} cells — search is not filtering`);
    await type(''); await sleep(500);
    const restored = await cellCount();
    if (restored < hit) throw new Error(`clearing the search left ${restored} cells, expected >= ${hit}`);
    return `row cameraModel='${raf.cameraModel}' iso=${raf.iso} focal=${raf.focalLength} dateTaken=${new Date(raf.dateTaken).toISOString()} | search X100V=${hit} cells, nonsense=0, cleared=${restored}`;
  });

  // C12: keyword panel end-to-end (wave-1 wiring). Add tags to the selection
  // via the real button, the derived list must tally them, clicking a row must
  // filter the grid, and the write must land on the DB row (merge, not
  // clobber: the RAF row already carries EXIF fields the write must keep).
  await check('keywords: add -> list tally -> click filters -> DB row merged', 'keywords', async () => {
    if (fast) return 'SKIPPED (--fast: runs on the RAF-imported catalog)';
    const dbRow = () => cdp.evaluate(`new Promise(res => { const q = indexedDB.open('candela-catalog');
      q.onsuccess = () => { const db = q.result;
        const r = db.transaction('files').objectStore('files').getAll();
        r.onsuccess = () => { db.close(); res(JSON.stringify(r.result)); };
        r.onerror = () => { db.close(); res('[]'); }; };
      q.onerror = () => res('[]'); })`);
    // Select the single catalog cell (grid click = select, not open).
    await clickEl(cdp, '.catalog-cell');
    await sleep(400);
    await cdp.evaluate(`(() => { const i=document.querySelector('#keyword-input'); i.value='wedding, keep'; return 1; })()`);
    await clickEl(cdp, '#keyword-add');
    await waitFor(cdp, `document.querySelectorAll('#keyword-list .keyword-row').length >= 2 ? true : false`, { timeout: 10000 });
    const list = JSON.parse(await cdp.evaluate(`JSON.stringify([...document.querySelectorAll('#keyword-list .keyword-row')].map(r => [r.dataset.keyword, r.querySelector('.keyword-count')?.textContent]))`));
    const tally = Object.fromEntries(list);
    if (tally.wedding !== '1' || tally.keep !== '1') throw new Error(`keyword list tally wrong: ${JSON.stringify(list)}`);
    // DB row: keywords merged WITHOUT clobbering the EXIF fields.
    const rows1 = JSON.parse(await dbRow());
    const f1 = rows1[0];
    if (!f1.keywords?.includes('wedding')) throw new Error(`DB row keywords = ${JSON.stringify(f1.keywords)}`);
    if (!/x100v/i.test(f1.cameraModel || '')) throw new Error('keyword write clobbered cameraModel — merge discipline broken');
    // Click the row: grid filters; re-click: clears.
    await cdp.evaluate(`(() => { document.querySelector('#keyword-list .keyword-row[data-keyword="wedding"]').click(); return 1; })()`);
    await sleep(600);
    const filtered = await cdp.evaluate('document.querySelectorAll(".catalog-cell").length');
    const active = await cdp.evaluate(`!!document.querySelector('#keyword-list .keyword-row.active')`);
    await cdp.evaluate(`(() => { document.querySelector('#keyword-list .keyword-row[data-keyword="wedding"]').click(); return 1; })()`);
    await sleep(600);
    const cleared = await cdp.evaluate('document.querySelectorAll(".catalog-cell").length');
    if (filtered < 1 || !active) throw new Error(`keyword filter dead: cells=${filtered} activeRow=${active}`);
    if (cleared < filtered) throw new Error(`clearing the keyword filter LOST cells: ${filtered} -> ${cleared}`);
    return `list=${JSON.stringify(tally)} dbKeywords=${JSON.stringify(f1.keywords)} cameraModel kept filter=${filtered}->cleared=${cleared} activeRow=${active}`;
  });

  // C13: IPTC panel + backup status (wave-1 wiring). Apply a caption to the
  // selection through the real button; the row must carry iptc.caption and
  // keep everything else. #backup-status must show the persistence verdict.
  await check('iptc: apply-to-selection writes one iptc bag; backup status painted', 'iptc', async () => {
    if (fast) return 'SKIPPED (--fast: runs on the RAF-imported catalog)';
    await gotoModule('library');
    await clickEl(cdp, '.catalog-cell');
    // Wait for the click's openFile DECODE to finish, not a fixed sleep: the
    // selection subscribe repaints the IPTC inputs from the record when the
    // decode lands, and a caption typed before that repaint gets wiped — the
    // apply then saw an empty form and no-op'd (this check's original failure).
    // #canvas.width > 1000 is the decode-done signal (module-independent).
    await waitFor(cdp, `document.querySelector('#canvas').width > 1000 ? true : false`, { timeout: 120000 });
    await waitFor(cdp, `document.querySelector('.catalog-cell.selected') ? true : false`, { timeout: 20000 });
    await cdp.evaluate(`(() => { const c=document.querySelector('#iptc-caption'); c.value='QA loop caption';
      c.dispatchEvent(new Event('input',{bubbles:true})); return 1; })()`);
    // The typed value must still be there at apply time (no late repaint race).
    const typed = await cdp.evaluate(`document.querySelector('#iptc-caption').value`);
    if (typed !== 'QA loop caption') throw new Error(`caption input was wiped before apply (value="${typed}") — repaint race`);
    await clickEl(cdp, '#iptc-apply-selection');
    // Poll the DB, don't sleep: the write queues behind the decode on the
    // main thread and can take seconds. On timeout, dump what the UI says
    // (the flash message distinguishes 'select photos first' from a write
    // that never fired from one that threw).
    let wrote = false;
    const tApply = Date.now();
    while (Date.now() - tApply < 30000) {
      wrote = await cdp.evaluate(`new Promise(res => { const q = indexedDB.open('candela-catalog');
        q.onsuccess = () => { const db = q.result;
          const r = db.transaction('files').objectStore('files').getAll();
          r.onsuccess = () => { db.close(); res(r.result.some(f => f.iptc?.caption === 'QA loop caption')); };
          r.onerror = () => { db.close(); res(false); }; };
        q.onerror = () => res(false); })`);
      if (wrote === true || wrote === 'true') break;
      await sleep(1000);
    }
    if (wrote !== true && wrote !== 'true') {
      const diag = await cdp.evaluate(`JSON.stringify({
        flash: document.querySelector('#selection-info')?.textContent,
        selected: document.querySelectorAll('.catalog-cell.selected').length,
        caption: document.querySelector('#iptc-caption').value,
        errs: window.__qa.errs.slice(-4) })`);
      throw new Error(`iptc.caption never reached the DB; diag=${diag}`);
    }
    const row = JSON.parse(await cdp.evaluate(`new Promise(res => { const q = indexedDB.open('candela-catalog');
      q.onsuccess = () => { const db = q.result;
        const r = db.transaction('files').objectStore('files').getAll();
        r.onsuccess = () => { db.close(); res(JSON.stringify(r.result[0] || null)); };
        r.onerror = () => { db.close(); res('null'); }; };
      q.onerror = () => res('null'); })`));
    if (row?.iptc?.caption !== 'QA loop caption') throw new Error(`iptc.caption = ${JSON.stringify(row?.iptc)} — apply-to-selection did not write`);
    if (!row.keywords?.includes('wedding')) throw new Error('IPTC write clobbered keywords — merge discipline broken');
    const status = (await cdp.evaluate(`document.querySelector('#backup-status')?.textContent || ''`)).trim();
    if (!/protected|NOT protected|evict/i.test(status)) throw new Error(`#backup-status has no persistence verdict: "${status}"`);
    return `iptc=${JSON.stringify(row.iptc)} keywords kept status="${status.slice(0, 80)}"`;
  });

  // C14: filter bar (wave 2, P0-5). The engine is unit-tested 38x; what only
  // the running app can prove: chips derive from the CATALOG (no hardcoded
  // camera names), a toggle narrows the grid through the real rebuildGrid
  // chain, the summary/clear-button track state, and a preset round-trips.
  await check('filters: derived chips narrow grid; preset + clear round-trip', 'filters', async () => {
    if (fast) return 'SKIPPED (--fast: needs rated rows from the full chain)';
    await gotoModule('library');
    // Rate the first cell 4 stars so 'unrated' has something to exclude.
    await cdp.evaluate(`(() => { const c = document.querySelector('.catalog-cell');
      c.querySelectorAll('.cell-star')[3].dispatchEvent(new MouseEvent('click',{bubbles:true})); return 1; })()`);
    await sleep(1000);
    const total = await cdp.evaluate('document.querySelectorAll(".catalog-cell").length');
    // The fileType column is enum-derived; its 'raw' chip must exist (a RAF is
    // imported) and clicking it must drop the JPEG-only rows... the catalog
    // here is 1 RAF, so assert the inverse: filtering to 'image' hides it.
    const chipInfo = await cdp.evaluate(`JSON.stringify((() => {
      const groups = [...document.querySelectorAll('#filter-columns [data-column]')].map(g => g.dataset.column);
      const raw = document.querySelector('#filter-columns [data-column="fileType"] button[data-value="image"], #filter-columns [data-column="fileType"] [data-value="image"]');
      return { groups, hasImageChip: !!raw };
    })())`);
    const ci = JSON.parse(chipInfo);
    if (!ci.groups.length) throw new Error('filter bar rendered no columns');
    // Preset round-trip: unrated must hide the rated photo.
    await clickEl(cdp, '#filter-preset-unrated');
    await sleep(800);
    const afterPreset = await cdp.evaluate('document.querySelectorAll(".catalog-cell").length');
    const summary = await cdp.evaluate(`document.querySelector('#filter-summary')?.textContent || ''`);
    const clearVisible = await cdp.evaluate(`!document.querySelector('#filter-clear').hidden && !document.querySelector('#filter-clear').disabled`);
    if (afterPreset >= total) throw new Error(`unrated preset did not narrow: ${total} -> ${afterPreset} (rated photo still shown)`);
    if (!/unrated/i.test(summary)) throw new Error(`summary does not describe the preset: "${summary}"`);
    if (!clearVisible) throw new Error('Clear button not enabled while a filter is active');
    await clickEl(cdp, '#filter-clear');
    await sleep(800);
    const restored = await cdp.evaluate('document.querySelectorAll(".catalog-cell").length');
    if (restored !== total) throw new Error(`Clear did not restore: ${restored} != ${total}`);
    // A derived chip: fileType 'image' on a RAF-only catalog must empty the grid
    // (proves the chip actually filters, not just renders).
    if (ci.hasImageChip) {
      await cdp.evaluate(`(() => { document.querySelector('#filter-columns [data-column="fileType"] [data-value="image"]').click(); return 1; })()`);
      await sleep(700);
      const imgOnly = await cdp.evaluate('document.querySelectorAll(".catalog-cell").length');
      if (imgOnly !== 0) throw new Error(`fileType=image on a RAW-only catalog still shows ${imgOnly} cells`);
      await clickEl(cdp, '#filter-clear');
      await sleep(500);
    }
    return `columns=${ci.groups.join(',')} | total=${total} unratedPreset->${afterPreset} summary="${summary}" clear->${restored}${ci.hasImageChip ? ' imageChip->0 (derived filter live)' : ''}`;
  });

  // C15: Survey (wave 2, P1-5). Engine layout math is unit-tested 36x; prove
  // the wiring: tiles render for the selection, the x is NON-DESTRUCTIVE
  // (the removed photo keeps its rating — the whole point of Survey), arrows
  // move the active tile, and 1-selection shows the hint instead of tiles.
  await check('survey: tiles from selection, x keeps rating, arrows move active', 'survey', async () => {
    if (fast) return 'SKIPPED (--fast: needs the RAF-imported catalog)';
    await gotoModule('library');
    // Survey needs 3+ photos for a meaningful x-removal: removing one from a
    // 2-tile set drops the review set below the 2-photo floor and Survey
    // correctly re-renders as the HINT (0 tiles) — the first draft of this
    // check asserted "1 tile left" and failed on correct behaviour.
    await cdp.evaluate(seed([
      { name: 'FUJI_BW.raf', url: FIXTURE_RAF },
      { name: 'S2.jpg', gen: { bg: '#1188cc', fg: '#ffcc00' } },
      { name: 'S3.jpg', gen: { bg: '#886611', fg: '#2244aa' } },
    ]));
    await waitFor(cdp, `window.__qa.seedState !== 'pending' ? window.__qa.seedState : false`, { timeout: 60000 });
    await clickEl(cdp, '#add-folder');
    await waitFor(cdp, `document.querySelectorAll('.catalog-cell').length >= 3 ? true : false`, { timeout: 30000 });
    // Rate cell 2 (a JPEG) 3 stars — it is the one we will x out of Survey.
    await cdp.evaluate(`(() => { const c = document.querySelectorAll('.catalog-cell')[1];
      c.querySelectorAll('.cell-star')[2].dispatchEvent(new MouseEvent('click',{bubbles:true})); return 1; })()`);
    await sleep(900);
    const ratedId = await cdp.evaluate(`document.querySelectorAll('.catalog-cell')[1].dataset.fileId`);
    // Select all three cells (plain click then meta-clicks).
    await cdp.evaluate(`(() => { const cs = document.querySelectorAll('.catalog-cell');
      cs[0].dispatchEvent(new MouseEvent('click',{bubbles:true}));
      cs[1].dispatchEvent(new MouseEvent('click',{bubbles:true,metaKey:true}));
      cs[2].dispatchEvent(new MouseEvent('click',{bubbles:true,metaKey:true})); return 1; })()`);
    await sleep(500);
    const sel = await cdp.evaluate('document.querySelectorAll(".catalog-cell.selected").length');
    if (sel < 3) throw new Error(`multi-select failed (${sel} selected) — Survey would show the hint`);
    await gotoModule('survey');
    await waitFor(cdp, `document.querySelectorAll('#survey-grid .survey-tile').length >= 3 ? true : false`, { timeout: 15000 });
    const tiles = await cdp.evaluate('document.querySelectorAll("#survey-grid .survey-tile").length');
    const active0 = await cdp.evaluate(`document.querySelector('#survey-grid .survey-tile.active')?.dataset.fileId || null`);
    if (tiles !== 3 || !active0) throw new Error(`survey layout broken: ${tiles} tiles, active=${active0}`);
    // Arrow moves active (wrapping engine; with 3 tiles it must change).
    await cdp.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))`);
    await sleep(400);
    const active1 = await cdp.evaluate(`document.querySelector('#survey-grid .survey-tile.active')?.dataset.fileId || null`);
    if (active1 === active0) throw new Error(`ArrowRight did not move the active tile (${active0} -> ${active1})`);
    // x the RATED tile: make it active first, then remove.
    await cdp.evaluate(`(() => { const t = [...document.querySelectorAll('#survey-grid .survey-tile')].find(t => t.dataset.fileId === '${ratedId}');
      t.dispatchEvent(new MouseEvent('click',{bubbles:true})); return 1; })()`);
    await sleep(300);
    await cdp.evaluate(`document.querySelector('#survey-grid .survey-tile.active .survey-remove').click()`);
    await sleep(900);
    const tilesAfter = await cdp.evaluate('document.querySelectorAll("#survey-grid .survey-tile").length');
    if (tilesAfter !== 2) throw new Error(`x did not remove exactly one tile: ${tiles} -> ${tilesAfter}`);
    // NON-DESTRUCTIVE: back in Library the removed photo still shows its 3 stars.
    await gotoModule('library');
    await sleep(600);
    const kept = await cdp.evaluate(`(() => { const c = [...document.querySelectorAll('.catalog-cell')].find(c => c.dataset.fileId === '${ratedId}');
      return c ? c.querySelectorAll('.cell-star.on').length : -1; })()`);
    if (kept !== 3) throw new Error(`Survey x was DESTRUCTIVE: removed photo rating = ${kept}, expected 3`);
    // 1-selection hint: select a single cell and re-enter Survey.
    await cdp.evaluate(`document.querySelector('.catalog-cell').dispatchEvent(new MouseEvent('click',{bubbles:true}))`);
    await sleep(400);
    await gotoModule('survey');
    await sleep(700);
    const hintState = await cdp.evaluate(`JSON.stringify({ tiles: document.querySelectorAll('#survey-grid .survey-tile').length,
      hintShown: (() => { const h = document.querySelector('#survey-hint'); return !!h && !h.hidden && getComputedStyle(h).display !== 'none'; })() })`);
    const hs = JSON.parse(hintState);
    if (hs.tiles !== 0) throw new Error(`1-selection Survey rendered ${hs.tiles} tiles instead of the hint`);
    await gotoModule('library');
    return `tiles=3 active ${active0}->${active1} (arrow) x->2 tiles, removed photo keeps ${kept}★ (non-destructive), 1-sel: tiles=${hs.tiles} hint=${hs.hintShown}`;
  });

  // C16: stacks (wave 2, P1-2). Stamp capture times in IDB (3 photos 2s apart,
  // one hours away), auto-stack with a 3s gap -> the burst collapses to its
  // top photo with a count badge; badge click expands; Ungroup dissolves.
  await check('stacks: auto-stack collapses burst to badge; expand + ungroup', 'stacks', async () => {
    if (fast) return 'SKIPPED (--fast: needs the 2-photo catalog from survey)';
    // Own reset: a previous check can leave the survey module showing or a
    // details panel open (which once pushed #stack-auto under a summary and
    // the hit-test assertion refused the click — correctly).
    await resetCatalog([
      { name: 'FUJI_BW.raf', url: FIXTURE_RAF },
      { name: 'S2.jpg', gen: { bg: '#1188cc', fg: '#ffcc00' } },
      { name: 'S3.jpg', gen: { bg: '#886611', fg: '#2244aa' } },
    ]);
    const before = Number(await cdp.evaluate('document.querySelectorAll(".catalog-cell").length'));
    if (before < 2) throw new Error(`needs 2+ photos, catalog has ${before}`);
    // Stamp dateTaken: all photos 2s apart (one burst within the 3s gap).
    const base = Date.now() - 86400000;
    await cdp.evaluate(`new Promise(res => { const q = indexedDB.open('candela-catalog');
      q.onsuccess = () => { const db = q.result;
        const tx = db.transaction('files','readwrite'); const st = tx.objectStore('files');
        const g = st.getAll();
        g.onsuccess = () => { const rows = g.result.slice().sort((a,b)=>a.name.localeCompare(b.name));
          rows.forEach((r,i) => { r.dateTaken = ${base} + i*2000; st.put(r); }); };
        tx.oncomplete = () => { db.close(); res('stamped'); }; };
      q.onerror = () => res('ERR'); })`);
    // allFiles must re-read the stamps: reload the page (cold, deterministic).
    await cdp.send('Page.reload', { ignoreCache: false });
    await sleep(2500);
    await waitFor(cdp, `document.querySelectorAll('.catalog-cell').length >= 2 ? true : false`, { timeout: 20000 });
    await cdp.evaluate(`(() => { const g=document.querySelector('#stack-gap'); g.value='3';
      g.dispatchEvent(new Event('input',{bubbles:true})); g.dispatchEvent(new Event('change',{bubbles:true})); return 1; })()`);
    await clickEl(cdp, '#stack-auto');
    await sleep(900);
    const stacked = JSON.parse(await cdp.evaluate(`JSON.stringify({
      cells: document.querySelectorAll('.catalog-cell').length,
      badges: [...document.querySelectorAll('.stack-badge')].map(b=>b.textContent),
      clearEnabled: !document.querySelector('#stack-clear').disabled })`));
    if (stacked.cells >= before || stacked.badges.length !== 1 || stacked.badges[0] !== String(before)) {
      throw new Error(`auto-stack wrong: ${JSON.stringify(stacked)} (expected ${before} -> 1 cell, badge '${before}')`);
    }
    // Badge click expands in place.
    await clickEl(cdp, '.stack-badge');
    await sleep(700);
    const expanded = await cdp.evaluate('document.querySelectorAll(".catalog-cell").length');
    if (expanded !== before) throw new Error(`badge expand: ${expanded} cells, expected ${before}`);
    // Collapse, then Ungroup-all dissolves every stack.
    await clickEl(cdp, '.stack-badge');
    await sleep(500);
    await clickEl(cdp, '#stack-clear');
    await sleep(700);
    const after = JSON.parse(await cdp.evaluate(`JSON.stringify({
      cells: document.querySelectorAll('.catalog-cell').length,
      badges: document.querySelectorAll('.stack-badge').length,
      clearDisabled: document.querySelector('#stack-clear').disabled })`));
    if (after.cells !== before || after.badges !== 0 || !after.clearDisabled) {
      throw new Error(`ungroup wrong: ${JSON.stringify(after)}`);
    }
    return `auto-stack ${before}->${stacked.cells} badge='${stacked.badges[0]}' expand->${expanded} ungroup->${after.cells} badges=${after.badges} clearDisabled=${after.clearDisabled}`;
  });

  // C17: missing-file detection + relink (wave 3, P0-3). Delete a file from
  // OPFS under the app, reload: the row's handle now NotFoundErrors. Click it
  // -> '!' badge + missing copy (NOT the restore banner — 'denied' vs
  // 'notfound' is the whole classifier contract); locate-missing with a
  // directory holding a same-named file -> badge clears, row repaired.
  await check('missing: NotFound badges on click+boot; directory relink repairs', 'missing', async () => {
    if (fast) return 'SKIPPED (--fast: needs the 2-photo catalog from survey)';
    // Own reset with plain JPEGs (fast, no RAF decode): this check deletes
    // OPFS bytes, so it must not share a catalog with anything downstream.
    await resetCatalog([
      { name: 'M1.jpg', gen: { bg: '#c0392b', fg: '#2980b9' } },
      { name: 'M2.jpg', gen: { bg: '#27ae60', fg: '#8e44ad' } },
    ]);
    // Kill M2's bytes under the app.
    const victim = await cdp.evaluate(`(async () => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('fx');
      await dir.removeEntry('M2.jpg');
      return 'removed';
    })()`);
    if (victim !== 'removed') throw new Error('could not remove M2.jpg from OPFS');
    await cdp.send('Page.reload', { ignoreCache: false });
    await sleep(2500);
    await waitFor(cdp, `document.querySelectorAll('.catalog-cell').length >= 2 ? true : false`, { timeout: 20000 });
    // Re-grant 'fx' in the SHIM: the reload wiped window.__qa.grants, and
    // with an empty set the shim throws NotAllowedError from getFile BEFORE
    // the real NotFoundError can surface — the app then (correctly) routes
    // to 'denied'/restore-banner instead of 'notfound'/badge, and this
    // check timed out measuring correct behaviour through a wrong fixture.
    await cdp.evaluate(`window.__qa.grants.add('fx')`);
    // Badges at boot: flag not yet persisted for a file nobody clicked — 0 is
    // correct here (detection is click-scoped by design; persisted flags show
    // at boot, proven by the post-click reload below).
    const bootBadges = await cdp.evaluate('document.querySelectorAll(".cell-missing").length');
    // Click the victim cell -> detection path.
    const ids = JSON.parse(await cdp.evaluate(`new Promise(res => { const q = indexedDB.open('candela-catalog');
      q.onsuccess = () => { const db = q.result; const r = db.transaction('files').objectStore('files').getAll();
        r.onsuccess = () => { db.close(); res(JSON.stringify(r.result.map(f=>({id:f.id,name:f.name})))); }; }; })`));
    const m2 = ids.find((f) => /M2/i.test(f.name));
    if (!m2) throw new Error(`no M2 row: ${JSON.stringify(ids)}`);
    await cdp.evaluate(`document.querySelector('.catalog-cell[data-file-id="${m2.id}"]').dispatchEvent(new MouseEvent('click',{bubbles:true}))`);
    await waitFor(cdp, `document.querySelectorAll('.cell-missing').length >= 1 ? true : false`, { timeout: 15000 });
    const badged = JSON.parse(await cdp.evaluate(`JSON.stringify({
      badges: document.querySelectorAll('.cell-missing').length,
      onVictim: !!document.querySelector('.catalog-cell[data-file-id="${m2.id}"] .cell-missing') })`));
    const dbRow = await cdp.evaluate(`new Promise(res => { const q = indexedDB.open('candela-catalog');
      q.onsuccess = () => { const db = q.result; const r = db.transaction('files').objectStore('files').get(${m2.id});
        r.onsuccess = () => { db.close(); res(JSON.stringify({ missing: r.result.missing === true })); }; }; })`);
    if (!badged.onVictim) throw new Error(`badge not on the victim cell: ${JSON.stringify(badged)}`);
    if (!JSON.parse(dbRow).missing) throw new Error('missing flag not persisted to the row');
    // The banner must NOT fire for notfound (that path is 'denied'-only).
    const banner = await cdp.evaluate(`!document.querySelector('#restore-banner').hidden`);
    if (banner) throw new Error('restore banner fired for a notfound file — classifier contract broken');
    // Reload: persisted flag badges at boot with zero clicks.
    await cdp.send('Page.reload', { ignoreCache: false });
    await sleep(2500);
    await waitFor(cdp, `document.querySelectorAll('.cell-missing').length >= 1 ? true : false`, { timeout: 20000 });
    const bootBadges2 = await cdp.evaluate('document.querySelectorAll(".cell-missing").length');
    // Same shim re-grant as above: relink's probeFileHandle reads through
    // getFile, which the shim gates on the grants set the reload wiped.
    await cdp.evaluate(`window.__qa.grants.add('fx')`);
    // Relink: restore the bytes, point locate-missing at the dir. NOTE the
    // recreated file has a DIFFERENT size than the original (fresh canvas
    // encode) — that is fine, relink matches by exact basename, and it keeps
    // the duplicate gate downstream from seeing this as the same file.
    await cdp.evaluate(`(async () => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('fx', { create: true });
      const c = new OffscreenCanvas(600,400), g = c.getContext('2d');
      g.fillStyle='#27ae60'; g.fillRect(0,0,600,400); g.fillStyle='#8e44ad'; g.fillRect(300,200,300,200);
      const b = await (await c.convertToBlob({type:'image/jpeg',quality:0.9})).arrayBuffer();
      const fh = await dir.getFileHandle('M2.jpg', {create:true});
      const w = await fh.createWritable(); await w.write(b); await w.close();
      window.showDirectoryPicker = async () => dir;
      return 1;
    })()`);
    await clickEl(cdp, '#locate-missing');
    await waitFor(cdp, `document.querySelectorAll('.cell-missing').length === 0 ? true : false`, { timeout: 20000 });
    const after = JSON.parse(await cdp.evaluate(`new Promise(res => { const q = indexedDB.open('candela-catalog');
      q.onsuccess = () => { const db = q.result; const r = db.transaction('files').objectStore('files').get(${m2.id});
        r.onsuccess = () => { db.close(); res(JSON.stringify({ missing: r.result.missing ?? false, hasHandle: !!r.result.handle })); }; }; })`));
    if (after.missing) throw new Error(`relink did not clear the flag: ${JSON.stringify(after)}`);
    return `boot badges=${bootBadges} (cold) click->badge on ${m2.name} db.missing=true bannerHidden=true reload boot badges=${bootBadges2} relink->badges=0 missing=${after.missing} handle=${after.hasHandle}`;
  });

  // C18: Remove vs Delete (wave 3, P0-4) — the destructive-verb boundary.
  // Delete key opens the dialog on the SAFE verb; confirming removes the row
  // AND its dependents (edits/thumbnails); the file stays on disk (Remove).
  // Then Delete inside a collection view = membership-only, NO dialog.
  await check('remove: Delete key -> safe-verb dialog -> row+dependents gone, file kept', 'remove', async () => {
    if (fast) return 'SKIPPED (--fast: needs the multi-photo catalog)';
    // Own reset: this check DELETES catalog rows, and the missing check
    // above deletes OPFS bytes — sharing a catalog made "file kept on disk"
    // read the predecessor's deletion and reported phantom data loss.
    await resetCatalog([
      { name: 'D1.jpg', gen: { bg: '#c0392b', fg: '#2980b9' } },
      { name: 'D2.jpg', gen: { bg: '#27ae60', fg: '#8e44ad' } },
    ]);
    const rowsBefore = JSON.parse(await cdp.evaluate(`new Promise(res => { const q = indexedDB.open('candela-catalog');
      q.onsuccess = () => { const db = q.result; const r = db.transaction('files').objectStore('files').getAll();
        r.onsuccess = () => { db.close(); res(JSON.stringify(r.result.map(f=>({id:f.id,name:f.name})))); }; }; })`));
    if (rowsBefore.length < 2) throw new Error(`need 2+ rows, have ${rowsBefore.length}`);
    const victim = rowsBefore.find((f) => /D2/i.test(f.name)) ?? rowsBefore[rowsBefore.length - 1];
    // Select the victim and press Delete (real key event through the page).
    await cdp.evaluate(`document.querySelector('.catalog-cell[data-file-id="${victim.id}"]').dispatchEvent(new MouseEvent('click',{bubbles:true}))`);
    await sleep(400);
    await cdp.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Delete',bubbles:true}))`);
    await waitFor(cdp, `document.querySelector('#remove-dialog')?.open ? true : false`, { timeout: 8000 });
    const dlg = JSON.parse(await cdp.evaluate(`JSON.stringify({
      title: document.querySelector('#remove-dialog-title').textContent,
      body: document.querySelector('#remove-dialog-body').textContent.slice(0,120),
      confirm: document.querySelector('#remove-dialog-confirm').textContent,
      destructive: document.querySelector('#remove-dialog-confirm').classList.contains('destructive') })`));
    // Safe verb by default: the copy must NOT say trash/delete-from-disk.
    if (/trash|from disk/i.test(dlg.title)) throw new Error(`dialog opened on the DESTRUCTIVE verb: ${dlg.title}`);
    if (dlg.destructive) throw new Error('default confirm button styled destructive — LrC defaults to the safe verb');
    await clickEl(cdp, '#remove-dialog-confirm');
    await waitFor(cdp, `document.querySelector('#remove-dialog')?.open === false ? true : false`, { timeout: 10000 });
    await sleep(600);
    const after = JSON.parse(await cdp.evaluate(`new Promise(res => { const q = indexedDB.open('candela-catalog');
      q.onsuccess = () => { const db = q.result;
        const tx = db.transaction(['files','edits','thumbnails'],'readonly');
        const out = {};
        let done = 0; const fin = () => { if (++done === 3) { db.close(); res(JSON.stringify(out)); } };
        for (const s of ['files','edits','thumbnails']) {
          const r = tx.objectStore(s).getAllKeys();
          r.onsuccess = () => { out[s] = r.result.map(Number); fin(); };
        }; }; })`));
    if (after.files.includes(victim.id)) throw new Error(`files row ${victim.id} survived Remove`);
    if (after.edits.includes(victim.id) || after.thumbnails.includes(victim.id)) {
      throw new Error(`dependents orphaned: edits=${JSON.stringify(after.edits)} thumbs=${JSON.stringify(after.thumbnails)}`);
    }
    // The FILE stays on disk (Remove, not Delete): OPFS still has it.
    const stillOnDisk = await cdp.evaluate(`(async () => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('fx');
      try { await dir.getFileHandle(${JSON.stringify(victim.name)}); return true; } catch { return false; }
    })()`);
    if (!stillOnDisk) throw new Error('Remove deleted the file from OPFS — verb semantics inverted (data loss!)');
    const cells = await cdp.evaluate('document.querySelectorAll(".catalog-cell").length');
    return `dialog "${dlg.title}" (safe verb, destructive=${dlg.destructive}) -> row ${victim.id} gone, edits/thumbs clean, file kept on disk=${stillOnDisk}, cells=${cells}`;
  });

  // C19: Target Collection B-family (wave 3, P1-4). B toggles tray membership
  // (row count in the store, flash text), the tray is never duplicated across
  // boots (the engine bug this loop guards), and Cmd+B opens the target view.
  await check('target: B toggles Quick Collection; tray never duplicates; Cmd+B opens', 'target', async () => {
    if (fast) return 'SKIPPED (--fast: needs the catalog)';
    // Own reset: tray-row counting is the whole assertion, so the catalog
    // must start with exactly the one boot-created tray (resetCatalog wipes
    // collections, then the app's boot re-ensures the tray).
    await resetCatalog([
      { name: 'T1.jpg', gen: { bg: '#1188cc', fg: '#ffcc00' } },
      { name: 'T2.jpg', gen: { bg: '#cc4488', fg: '#33cc66' } },
    ]);
    const trayRows = () => cdp.evaluate(`new Promise(res => { const q = indexedDB.open('candela-catalog');
      q.onsuccess = () => { const db = q.result; const r = db.transaction('collections').objectStore('collections').getAll();
        r.onsuccess = () => { db.close();
          const rows = r.result.filter(x => x.id !== '__target__');
          res(JSON.stringify({ trays: rows.filter(c => c.quick === true).length,
            quickByName: rows.filter(c => c.name === 'Quick Collection').length,
            members: (rows.find(c => c.quick === true)?.fileIds || []).length })); }; }; })`);
    const t0 = JSON.parse(await trayRows());
    if (t0.trays !== 1 || t0.quickByName !== 1) throw new Error(`tray identity broken at rest: ${JSON.stringify(t0)}`);
    // Select one photo, press B.
    const cellId = await cdp.evaluate(`document.querySelector('.catalog-cell').dataset.fileId`);
    await cdp.evaluate(`document.querySelector('.catalog-cell').dispatchEvent(new MouseEvent('click',{bubbles:true}))`);
    await sleep(300);
    await cdp.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'b',bubbles:true}))`);
    await waitFor(cdp, `new Promise(res => { const q = indexedDB.open('candela-catalog');
      q.onsuccess = () => { const db = q.result; const r = db.transaction('collections').objectStore('collections').getAll();
        r.onsuccess = () => { db.close();
          const tray = r.result.filter(x => x.id !== '__target__').find(c => c.quick === true);
          res(tray && tray.fileIds.includes(${cellId})); }; };
      q.onerror = () => res(false); })`, { timeout: 8000 });
    const t1 = JSON.parse(await trayRows());
    if (t1.members !== 1) throw new Error(`B did not add to the tray: ${JSON.stringify(t1)}`);
    // B again removes (toggle, not add).
    await cdp.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'b',bubbles:true}))`);
    await sleep(900);
    const t2 = JSON.parse(await trayRows());
    if (t2.members !== 0) throw new Error(`second B did not remove: ${JSON.stringify(t2)}`);
    if (t2.trays !== 1) throw new Error(`B duplicated the tray: ${JSON.stringify(t2)}`);
    // Boot again: the tray must survive reload as EXACTLY one flagged row.
    await cdp.send('Page.reload', { ignoreCache: false });
    await sleep(2500);
    await waitFor(cdp, `document.querySelectorAll('.catalog-cell').length >= 1 ? true : false`, { timeout: 20000 });
    const t3 = JSON.parse(await trayRows());
    if (t3.trays !== 1 || t3.quickByName !== 1) throw new Error(`boot duplicated the tray: ${JSON.stringify(t3)}`);
    // Cmd+B opens the target view (Quick Collection row becomes the active one).
    await cdp.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'b',metaKey:true,bubbles:true}))`);
    await sleep(1200);
    const view = await cdp.evaluate(`!!document.querySelector('.collection-row.active')`);
    const label = await cdp.evaluate(`document.querySelector('#target-label')?.textContent || ''`);
    if (!view) throw new Error('Cmd+B did not open the target collection view');
    // Reset: B the photo back out so later runs start clean.
    await cdp.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'b',bubbles:true}))`);
    await sleep(600);
    return `trays=1 across boot, B add->${t1.members} B remove->${t2.members}, Cmd+B opened target view=${view} label="${label.trim()}"`;
  });

  // C20: duplicate-skip at import (wave 3, P1-8). Re-importing the SAME files
  // through a DIFFERENT folder handle (identical names+sizes) must add zero
  // rows; re-adding the original folder still path-merges (no skips, no dupes).
  // The RAF matters: its row carries dateTaken after import, and the gate keys
  // NAME+SIZE only — a dated existing side once made every RAW duplicate a
  // miss (the bug this check was written from).
  await check('duplicates: second-copy import skips all; same-folder re-add merges', 'duplicates', async () => {
    if (fast) return 'SKIPPED (--fast: needs the RAF catalog)';
    // Own reset: a predecessor's OPFS deletions/recreations change file
    // sizes, and the gate keys on size — a shared catalog made this check
    // measure a different fixture set than it seeded.
    await resetCatalog([
      { name: 'FUJI_BW.raf', url: FIXTURE_RAF },
      { name: 'DUP.jpg', gen: { bg: '#c0392b', fg: '#2980b9' } },
    ]);
    const rowCount = () => cdp.evaluate(`new Promise(res => { const q = indexedDB.open('candela-catalog');
      q.onsuccess = () => { const db = q.result; const r = db.transaction('files').objectStore('files').getAll();
        r.onsuccess = () => { db.close(); res(r.result.length); }; }; })`);
    const n0 = Number(await rowCount());
    if (n0 !== 2) throw new Error(`expected a fresh 2-file catalog, got ${n0} rows`);
    // The imported RAF row is dated (EXIF ran) — assert that, so this check
    // actually covers the dated-existing-row case the fix was for.
    const dated = await cdp.evaluate(`new Promise(res => { const q = indexedDB.open('candela-catalog');
      q.onsuccess = () => { const db = q.result; const r = db.transaction('files').objectStore('files').getAll();
        r.onsuccess = () => { db.close();
          const raf = r.result.find(f => /\\.raf$/i.test(f.name));
          res(JSON.stringify({ hasRaf: !!raf, dated: !!(raf && raf.dateTaken) })); }; }; })`);
    const dj = JSON.parse(dated);
    if (!dj.hasRaf || !dj.dated) throw new Error(`fixture precondition failed (RAF must carry dateTaken): ${dated}`);
    // A second directory handle ('fx_copy') holding byte-identical copies.
    await cdp.evaluate(`(async () => {
      const root = await navigator.storage.getDirectory();
      const src = await root.getDirectoryHandle('fx');
      const copy = await root.getDirectoryHandle('fx_copy', { create: true });
      for await (const [name, h] of src.entries()) {
        if (h.kind !== 'file') continue;
        const b = await h.getFile();
        const fh = await copy.getFileHandle(name, { create: true });
        const w = await fh.createWritable(); await w.write(await b.arrayBuffer()); await w.close();
      }
      window.showDirectoryPicker = async () => copy;
      return 1;
    })()`);
    await clickEl(cdp, '#add-folder');
    // Wait for the import flash OR the row count to settle (it must NOT grow).
    await sleep(6000);
    const n1 = Number(await rowCount());
    const flash = await cdp.evaluate(`document.querySelector('#selection-info')?.textContent || ''`);
    if (n1 !== n0) throw new Error(`duplicate import added rows: ${n0} -> ${n1} (flash: "${flash}")`);
    // Re-add the ORIGINAL folder: path-merge, still no new rows and no
    // 'duplicates skipped' claim (same-path rows merge, they are not dupes).
    await cdp.evaluate(`(async () => {
      const root = await navigator.storage.getDirectory();
      const src = await root.getDirectoryHandle('fx');
      window.showDirectoryPicker = async () => src;
      return 1;
    })()`);
    await clickEl(cdp, '#add-folder');
    await sleep(6000);
    const n2 = Number(await rowCount());
    if (n2 !== n0) throw new Error(`same-folder re-add changed rows: ${n0} -> ${n2}`);
    return `rows ${n0} -> second-copy import ${n1} (skipped all) -> same-folder re-add ${n2} (path merge)`;
  });

  // C21: 'edited' filter column (Plan A). The engine semantics (ctx set,
  // 'edited'/'unedited') are unit-tested 9x; the wiring proof: chips render,
  // 'not edited' matches everything before any edit, and after committing a
  // Develop edit exactly one photo moves between the two chips.
  await check('edited filter: Develop commit moves a photo edited/unedited', 'planA', async () => {
    if (fast) return 'SKIPPED (--fast: needs the Develop edit round-trip)';
    await resetCatalog([
      { name: 'E1.jpg', gen: { bg: '#c0392b', fg: '#2980b9' } },
      { name: 'E2.jpg', gen: { bg: '#27ae60', fg: '#8e44ad' } },
    ]);
    const chip = (v) => `#filter-columns [data-column="edited"] [data-val="${v}"]`;
    const hasChips = await cdp.evaluate(`JSON.stringify({
      group: !!document.querySelector('#filter-columns [data-column="edited"]'),
      edited: !!document.querySelector('${chip('edited')}'),
      unedited: !!document.querySelector('${chip('unedited')}') })`);
    const hc = JSON.parse(hasChips);
    if (!hc.group || !hc.edited || !hc.unedited) throw new Error(`Edited chips missing: ${hasChips}`);
    const chipText = await cdp.evaluate(`document.querySelector('${chip('unedited')}').textContent`);
    if (!/not edited/i.test(chipText)) throw new Error(`unedited chip label = "${chipText}", expected "not edited"`);
    // 'not edited' before any edit: both photos.
    await cdp.evaluate(`document.querySelector('${chip('unedited')}').click()`);
    await sleep(700);
    const unedited0 = await cdp.evaluate('document.querySelectorAll(".catalog-cell").length');
    if (unedited0 !== 2) throw new Error(`unedited chip before any edit = ${unedited0} cells, expected 2`);
    const summary0 = await cdp.evaluate(`document.querySelector('#filter-summary').textContent`);
    if (!/not edited/i.test(summary0)) throw new Error(`summary missing 'not edited': "${summary0}"`);
    // Edit E1 in Develop: open it (click cell + synthetic dblclick), move
    // exposure, commit with the change event the app listens for.
    await cdp.evaluate(`document.querySelector('#filter-clear').click()`);
    await sleep(400);
    const e1id = await cdp.evaluate(`(() => {
      const c = [...document.querySelectorAll('.catalog-cell')].find(c => /E1/i.test(c.title || c.getAttribute('aria-label') || c.textContent));
      return c ? c.dataset.fileId : document.querySelector('.catalog-cell').dataset.fileId; })()`);
    await cdp.evaluate(`document.querySelector('.catalog-cell[data-file-id="${e1id}"]').dispatchEvent(new MouseEvent('click',{bubbles:true}))`);
    await sleep(400);
    await cdp.evaluate(`document.querySelector('.catalog-cell[data-file-id="${e1id}"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);
    await waitFor(cdp, `document.querySelector('#canvas').width > 300 ? true : false`, { timeout: 30000 });
    await cdp.evaluate(`(() => { const s = document.querySelector('#exposure');
      s.value = '0.8'; s.dispatchEvent(new Event('input',{bubbles:true}));
      s.dispatchEvent(new Event('change',{bubbles:true})); return 1; })()`);
    await sleep(1500);
    // The edits store must hold a non-empty currentOps row now.
    const editRows = await cdp.evaluate(`new Promise(res => { const q = indexedDB.open('candela-catalog');
      q.onsuccess = () => { const db = q.result;
        const r = db.transaction('edits').objectStore('edits').getAll();
        r.onsuccess = () => { db.close();
          res(JSON.stringify(r.result.map(e => ({ id: e.fileId, ops: (e.history[e.cursor]||[]).length })))); }; }; })`);
    const er = JSON.parse(editRows).filter((e) => e.ops > 0);
    if (er.length !== 1 || er[0].id !== Number(e1id)) throw new Error(`edits store wrong after commit: ${editRows} (expected one row for ${e1id})`);
    // Back to Library: 'edited' -> exactly E1; 'not edited' -> exactly E2.
    await gotoModule('library');
    await sleep(600);
    await cdp.evaluate(`document.querySelector('${chip('edited')}').click()`);
    await sleep(800);
    const editedCells = JSON.parse(await cdp.evaluate(`JSON.stringify([...document.querySelectorAll('.catalog-cell')].map(c=>c.dataset.fileId))`));
    if (editedCells.length !== 1 || editedCells[0] !== String(e1id)) {
      throw new Error(`edited chip = [${editedCells}], expected exactly [${e1id}]`);
    }
    await cdp.evaluate(`document.querySelector('#filter-clear').click()`);
    await sleep(400);
    await cdp.evaluate(`document.querySelector('${chip('unedited')}').click()`);
    await sleep(800);
    const uneditedCells = await cdp.evaluate('document.querySelectorAll(".catalog-cell").length');
    if (uneditedCells !== 1) throw new Error(`unedited after edit = ${uneditedCells} cells, expected 1`);
    await cdp.evaluate(`document.querySelector('#filter-clear').click()`);
    await sleep(300);
    return `chips ok ("${chipText}") unedited0=2 -> Develop commit (edits row ${JSON.stringify(er)}) -> edited=[${e1id}] unedited=1`;
  });

  // C21b: Sync Settings carries USER INTENT only (the colour-skew regression).
  // syncableOps is unit-tested; what only the running app proves: a source that
  // moved exposure alone writes Tone and NOTHING else -- the first absolute-sync
  // build also copied its As-Shot whiteBalance and default profile onto every
  // target and skewed colour on all of them -- and a first-open dialog ticks
  // only the modules the source actually edited instead of all twelve.
  await check('sync: exposure-only source ticks Tone and writes no WB/profile', 'sync', async () => {
    if (fast) return 'SKIPPED (--fast: needs the Develop edit + sync round-trip)';
    await resetCatalog([
      { name: 'S1.jpg', gen: { bg: '#c0392b', fg: '#2980b9' } },
      { name: 'S2.jpg', gen: { bg: '#27ae60', fg: '#8e44ad' } },
      { name: 'S3.jpg', gen: { bg: '#f39c12', fg: '#16a085' } },
    ]);
    const cellId = (stem) => cdp.evaluate(`(() => {
      const re = new RegExp(${JSON.stringify(stem)}, 'i');
      const c = [...document.querySelectorAll('.catalog-cell')]
        .find((x) => re.test(x.title || x.textContent || ''));
      return c ? c.dataset.fileId : null; })()`);
    const readEdits = () => cdp.evaluate(`new Promise(res => { const q = indexedDB.open('candela-catalog');
      q.onsuccess = () => { const db = q.result;
        const r = db.transaction('edits').objectStore('edits').getAll();
        r.onsuccess = () => { db.close();
          res(JSON.stringify(r.result.map(e => ({ id: e.fileId, ops: e.history[e.cursor] || [] })))); };
        r.onerror = () => { db.close(); res('[]'); }; };
      q.onerror = () => res('[]'); })`);
    // Keyed by string: dataset.fileId is a string, the store's fileId is a number.
    const rowsOf = async () => new Map(JSON.parse(await readEdits()).map((e) => [String(e.id), e.ops]));

    // Edit S1 in Develop: open it (click cell + synthetic dblclick), move
    // exposure ONLY -- White Balance and Profile are never touched.
    const s1 = await cellId('S1');
    const s2 = await cellId('S2');
    const s3 = await cellId('S3');
    if (!s1 || !s2 || !s3) throw new Error(`grid cells missing for S1/S2/S3: ${s1}/${s2}/${s3}`);
    await cdp.evaluate(`document.querySelector('.catalog-cell[data-file-id="${s1}"]').dispatchEvent(new MouseEvent('click',{bubbles:true}))`);
    await sleep(400);
    await cdp.evaluate(`document.querySelector('.catalog-cell[data-file-id="${s1}"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);
    await waitFor(cdp, `document.querySelector('#canvas').width > 300 ? true : false`, { timeout: 30000 });
    await cdp.evaluate(`(() => { const s = document.querySelector('#exposure');
      s.value = '0.8'; s.dispatchEvent(new Event('input',{bubbles:true}));
      s.dispatchEvent(new Event('change',{bubbles:true})); return 1; })()`);
    // Poll the commit into the DB rather than sleeping a fixed amount: the sync
    // below reads the SOURCE row out of IndexedDB, so a commit still in flight
    // would sync an empty op set and read as a sync bug, not a timing one.
    let s1ops = [];
    const tCommit = Date.now();
    while (Date.now() - tCommit < 15000) {
      s1ops = (await rowsOf()).get(s1) || [];
      if (s1ops.some((o) => o.kind === 'exposure' && o.ev === 0.8)) break;
      await sleep(500);
    }
    if (!s1ops.some((o) => o.kind === 'exposure' && o.ev === 0.8)) {
      throw new Error(`exposure 0.8 never committed to S1: ${JSON.stringify(s1ops)}`);
    }
    const s1Before = JSON.stringify(s1ops);

    // Back to Library. S1 is still the selection and still currentFileId, so it
    // is the sync source; extend the selection with the grid's ctrl+click.
    await gotoModule('library');
    await sleep(600);
    // The remembered-module set survives the reload and would send the dialog
    // down its remembered branch -- this step proves the FIRST-open branch.
    await cdp.evaluate(`localStorage.removeItem('candela.syncModules')`);
    for (const id of [s2, s3]) {
      await cdp.evaluate(`document.querySelector('.catalog-cell[data-file-id="${id}"]').dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true}))`);
      await sleep(300);
    }
    const sel = JSON.parse(await cdp.evaluate(`JSON.stringify({
      n: document.querySelectorAll('.catalog-cell.selected').length,
      ref: document.querySelector('.catalog-cell.sync-ref')?.dataset.fileId ?? null,
      disabled: document.querySelector('#sync-btn').disabled })`));
    if (sel.n !== 3) throw new Error(`ctrl+click did not build a 3-photo selection: ${JSON.stringify(sel)}`);
    if (sel.ref !== s1) throw new Error(`sync source is not S1 (sync-ref on ${sel.ref}, expected ${s1}): ${JSON.stringify(sel)}`);
    if (sel.disabled) throw new Error(`#sync-btn still disabled with 3 selected: ${JSON.stringify(sel)}`);

    // First-open dialog: Tone only. Profile and White Balance must be unticked
    // because S1 carries no intent for them (this is the tick-default fix).
    await clickEl(cdp, '#sync-btn');
    await waitFor(cdp, `document.querySelector('#sync-dialog').open ? true : false`, { timeout: 15000 });
    const ticked = JSON.parse(await cdp.evaluate(`JSON.stringify(
      [...document.querySelectorAll('#sync-modules input:checked')].map(cb => cb.value))`));
    if (ticked.join(',') !== 'Tone') {
      throw new Error(`first-open dialog ticked [${ticked}], expected exactly [Tone] -- progress="${
        (await cdp.evaluate(`document.querySelector('#sync-progress')?.textContent`)) || ''}"`);
    }
    await clickEl(cdp, '#sync-go');
    // Poll for the close (the loop awaits an IndexedDB save per target); a
    // fixed sleep here reads a slow sync as a failed sync.
    await waitFor(cdp, `document.querySelector('#sync-dialog').open === false ? true : false`, { timeout: 30000 });
    const rows = await rowsOf();
    const diag = async () => `rows=${await readEdits()} progress="${
      (await cdp.evaluate(`document.querySelector('#sync-progress')?.textContent`)) || ''}" errs=${
      await cdp.evaluate(`JSON.stringify(window.__qa.errs.slice(-4))`)}"`;
    for (const [id, name] of [[s2, 'S2'], [s3, 'S3']]) {
      const ops = rows.get(id) || [];
      const ev = ops.find((o) => o.kind === 'exposure')?.ev;
      if (ev !== 0.8) throw new Error(`${name} got no exposure 0.8 (ev=${JSON.stringify(ev)}); ${await diag()}`);
      // The regression that skewed colour: these two must stay absent.
      if (ops.some((o) => o.kind === 'whiteBalance')) throw new Error(`${name} gained a whiteBalance op; ${await diag()}`);
      if (ops.some((o) => o.kind === 'profile')) throw new Error(`${name} gained a profile op; ${await diag()}`);
    }
    if (JSON.stringify(rows.get(s1) || []) !== s1Before) {
      throw new Error(`sync rewrote its own source S1; ${await diag()}`);
    }
    return `S1 exposure 0.8 only -> dialog ticked [${ticked}] -> S2/S3 ev=0.8, no WB/profile ops; S1 ops unchanged (${
      JSON.parse(s1Before).length} ops)`;
  });

  // C22: Previous Import source row (Plan A). LrC semantics: the photos ADDED
  // by the most recent import — a re-import of the same folder MERGES (no new
  // rows), so Previous Import must then be empty/stale-free; adding ONE new
  // file makes it the whole batch.
  await check('previous import: batch row scopes to newest additions only', 'planA', async () => {
    if (fast) return 'SKIPPED (--fast: needs two import rounds)';
    await resetCatalog([
      { name: 'P1.jpg', gen: { bg: '#c0392b', fg: '#2980b9' } },
      { name: 'P2.jpg', gen: { bg: '#27ae60', fg: '#8e44ad' } },
    ]);
    const piRow = `[...document.querySelectorAll('#folder-list .folder-row')].find(r => /previous import/i.test(r.textContent))`;
    const hasRow = await cdp.evaluate(`!!(${piRow})`);
    if (!hasRow) throw new Error('no Previous Import row in #folder-list after an import');
    const clickPI = () => cdp.evaluate(`(${piRow}).click()`);
    await clickPI();
    await sleep(800);
    const first = await cdp.evaluate(`JSON.stringify({ cells: document.querySelectorAll('.catalog-cell').length,
      active: !!(${piRow})?.classList.contains('active') })`);
    const f = JSON.parse(first);
    if (f.cells !== 2 || !f.active) throw new Error(`Previous Import scope wrong on first import: ${first}`);
    // Add ONE new file and re-import: Previous Import = just the new one.
    await cdp.evaluate(`(async () => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('fx');
      const c = new OffscreenCanvas(600,400), g = c.getContext('2d');
      g.fillStyle='#886611'; g.fillRect(0,0,600,400); g.fillStyle='#2244aa'; g.fillRect(300,200,300,200);
      const b = await (await c.convertToBlob({type:'image/jpeg',quality:0.9})).arrayBuffer();
      const fh = await dir.getFileHandle('P3.jpg',{create:true});
      const w = await fh.createWritable(); await w.write(b); await w.close();
      window.showDirectoryPicker = async () => dir;
      return 1;
    })()`);
    await clickEl(cdp, '#add-folder');
    await waitFor(cdp, `document.querySelectorAll('.catalog-cell').length >= 3 ? true : false`, { timeout: 30000 });
    await clickPI();
    await sleep(800);
    const second = JSON.parse(await cdp.evaluate(`JSON.stringify({ cells: document.querySelectorAll('.catalog-cell').length,
      names: [...document.querySelectorAll('.catalog-cell')].map(c => c.title || c.querySelector('img')?.alt || '') })`));
    if (second.cells !== 1) throw new Error(`Previous Import after adding 1 file = ${second.cells} cells, expected 1 (${JSON.stringify(second.names)})`);
    // Mutual exclusion: clicking a folder row clears the PI scope and vice versa.
    const folderRow = `[...document.querySelectorAll('#folder-list .folder-row')].find(r => !/all folders|previous import/i.test(r.textContent))`;
    await cdp.evaluate(`(${folderRow}).click()`);
    await sleep(800);
    const excl = JSON.parse(await cdp.evaluate(`JSON.stringify({
      folderActive: !!(${folderRow})?.classList.contains('active'),
      piActive: !!(${piRow})?.classList.contains('active'),
      cells: document.querySelectorAll('.catalog-cell').length })`));
    if (excl.piActive || !excl.folderActive) throw new Error(`folder click did not clear Previous Import scope: ${JSON.stringify(excl)}`);
    await clickPI();
    await sleep(700);
    const excl2 = JSON.parse(await cdp.evaluate(`JSON.stringify({
      folderActive: !!(${folderRow})?.classList.contains('active'),
      piActive: !!(${piRow})?.classList.contains('active'),
      cells: document.querySelectorAll('.catalog-cell').length })`));
    if (excl2.folderActive || !excl2.piActive || excl2.cells !== 1) throw new Error(`PI click did not clear folder scope: ${JSON.stringify(excl2)}`);
    return `first import PI=2 cells; +P3 re-import PI=1 (newest batch only); folder/PI mutual exclusion both ways`;
  });

  // C23: B-key nudge (Plan A). Teaching, never gating: 20 picks with an empty
  // tray flashes the B hint EXACTLY once per session, and never when the tray
  // already holds photos.
  await check('nudge: 20 picks + empty tray flashes press-B once, never twice', 'planA', async () => {
    if (fast) return 'SKIPPED (--fast: needs 20 seeded photos)';
    const files = [];
    for (let i = 1; i <= 20; i++) {
      files.push({ name: `N${String(i).padStart(2, '0')}.jpg`, gen: { bg: `hsl(${i * 17},60%,45%)`, fg: `hsl(${i * 17 + 120},70%,60%)` } });
    }
    await resetCatalog(files);
    // Select all 20: plain click on the first, meta-click the rest.
    await cdp.evaluate(`(() => { const cs = [...document.querySelectorAll('.catalog-cell')];
      cs[0].dispatchEvent(new MouseEvent('click',{bubbles:true}));
      for (let i = 1; i < cs.length; i++) cs[i].dispatchEvent(new MouseEvent('click',{bubbles:true,metaKey:true}));
      return cs.length; })()`);
    await sleep(600);
    const sel = await cdp.evaluate('document.querySelectorAll(".catalog-cell.selected").length');
    if (sel !== 20) throw new Error(`selected ${sel} cells, expected 20 (grid virtualization may hide some — seed count matters)`);
    // P picks the whole selection; the nudge should flash immediately after.
    await cdp.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'p',bubbles:true}))`);
    await waitFor(cdp, `/press B/i.test(document.querySelector('#selection-info')?.textContent || '') ? document.querySelector('#selection-info').textContent : false`, { timeout: 8000 });
    const msg = await cdp.evaluate(`document.querySelector('#selection-info').textContent`);
    if (!/Quick Collection/i.test(msg)) throw new Error(`nudge text missing 'Quick Collection': "${msg}"`);
    // Second pick burst must NOT re-nudge (session latch). Wait out the flash
    // first so the assertion reads a genuinely empty box, not a stale one.
    await sleep(2500);
    await cdp.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'p',bubbles:true}))`); // unpick all
    await sleep(400);
    await cdp.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'p',bubbles:true}))`); // pick all again
    await sleep(900);
    const after = await cdp.evaluate(`document.querySelector('#selection-info').textContent || ''`);
    if (/press B/i.test(after)) throw new Error(`nudge fired TWICE in one session: "${after}"`);
    // Tray non-empty suppresses: B one photo into the tray, reload for a fresh
    // session (latch resets), pick all -> no nudge.
    await cdp.evaluate(`(() => { const cs=[...document.querySelectorAll('.catalog-cell')];
      cs[0].dispatchEvent(new MouseEvent('click',{bubbles:true})); return 1; })()`);
    await sleep(300);
    await cdp.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'b',bubbles:true}))`);
    await sleep(800);
    await cdp.send('Page.reload', { ignoreCache: false });
    await sleep(2500);
    await waitFor(cdp, `document.querySelectorAll('.catalog-cell').length >= 20 ? true : false`, { timeout: 20000 });
    await cdp.evaluate(`(() => { const cs = [...document.querySelectorAll('.catalog-cell')];
      cs[0].dispatchEvent(new MouseEvent('click',{bubbles:true}));
      for (let i = 1; i < cs.length; i++) cs[i].dispatchEvent(new MouseEvent('click',{bubbles:true,metaKey:true}));
      return 1; })()`);
    await sleep(500);
    await cdp.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'p',bubbles:true}))`);
    await sleep(1200);
    const suppressed = await cdp.evaluate(`document.querySelector('#selection-info').textContent || ''`);
    if (/press B/i.test(suppressed)) throw new Error(`nudge fired with a non-empty tray: "${suppressed}"`);
    return `nudge once ("${msg.slice(0, 60)}…"), second burst silent, tray-non-empty suppressed`;
  });

  // C24: smart collection from the grid selection (Plan A — the engine's
  // fileIds scope already existed; this proves the dialog defaults to the
  // selection and the saved rule bounds to exactly those photos).
  await check('smart-from-selection: scope defaults to selection; rule stays bounded', 'planA', async () => {
    if (fast) return 'SKIPPED (--fast: needs the 20-photo catalog)';
    await gotoModule('library');
    // Select exactly 3 cells.
    await cdp.evaluate(`(() => { const cs = [...document.querySelectorAll('.catalog-cell')];
      cs[0].dispatchEvent(new MouseEvent('click',{bubbles:true}));
      cs[1].dispatchEvent(new MouseEvent('click',{bubbles:true,metaKey:true}));
      cs[2].dispatchEvent(new MouseEvent('click',{bubbles:true,metaKey:true})); return 1; })()`);
    await sleep(400);
    const sel = await cdp.evaluate('document.querySelectorAll(".catalog-cell.selected").length');
    if (sel !== 3) throw new Error(`selected ${sel}, expected 3`);
    // Open the smart dialog: scope must default to 'selected' and its label
    // must name the count; preview must match 3 (no conditions set).
    await clickEl(cdp, '#add-smart-collection');
    await waitFor(cdp, `document.querySelector('#smart-dialog').open ? true : false`, { timeout: 5000 });
    const pre = JSON.parse(await cdp.evaluate(`JSON.stringify({
      scope: document.querySelector('#smart-scope').value,
      scopeLabel: document.querySelector('#smart-scope option[value="selected"]').textContent,
      preview: document.querySelector('#smart-preview').textContent })`));
    if (pre.scope !== 'selected') throw new Error(`scope defaulted to '${pre.scope}', expected 'selected' with a 3-photo selection`);
    if (!/3/.test(pre.scopeLabel)) throw new Error(`scope label does not name the selection count: "${pre.scopeLabel}"`);
    if (!/Matches 3/i.test(pre.preview)) throw new Error(`preview count wrong: "${pre.preview}"`);
    // Name + save; the new collection must show count 3 and scope to exactly
    // those photos.
    await cdp.evaluate(`(() => { const n = document.querySelector('#smart-name');
      n.value = 'QA picks'; n.dispatchEvent(new Event('input',{bubbles:true})); return 1; })()`);
    await cdp.evaluate(`document.querySelector('#smart-save').click()`);
    await waitFor(cdp, `document.querySelector('#smart-dialog').open === false ? true : false`, { timeout: 8000 });
    await sleep(600);
    const row = await cdp.evaluate(`(() => { const r = [...document.querySelectorAll('.smart-row, .collection-row')].find(e => /QA picks/.test(e.textContent));
      return r ? r.textContent.replace(/\\s+/g,' ').trim() : null; })()`);
    if (!row || !/3/.test(row)) throw new Error(`saved smart collection row missing or wrong count: ${JSON.stringify(row)}`);
    // Click it: grid scopes to the 3 rule photos (the other 17 disappear).
    await cdp.evaluate(`[...document.querySelectorAll('.smart-row, .collection-row')].find(e => /QA picks/.test(e.textContent)).click()`);
    await sleep(900);
    const scoped = await cdp.evaluate('document.querySelectorAll(".catalog-cell").length');
    if (scoped !== 3) throw new Error(`smart-from-selection scoped to ${scoped} cells, expected exactly 3 (rule must stay bounded to its fileIds)`);
    return `dialog scope='${pre.scope}' label="${pre.scopeLabel.trim()}" preview="${pre.preview.slice(0,40)}" saved row="${row.slice(0,40)}" grid scoped 20->${scoped}`;
  });

  // C25 (R1-3): strings the user did not type into this session's DOM must reach
  // the page as TEXT. Both innerHTML assignment sites in src/main.ts interpolated
  // attacker-influenced data: renderSmartCollections took smart.name (free text
  // from #smart-name, stored verbatim and restored verbatim from a catalog
  // backup), and the loupe info overlay took file.name plus the EXIF make/model.
  // Script running in this origin reaches the IndexedDB catalog and the
  // FileSystemFileHandles holding mode:'readwrite' directory grants, so "no
  // exception thrown" is not the assertion -- these read the executed global.
  // Every sub-assertion is collected rather than thrown eagerly so one red run
  // names every open hole, not just the first.
  await check('security: untrusted strings render as text, never as HTML', 'security', async () => {
    const PAYLOAD = '<img src=x onerror="window.__pwned=1">';
    // The importer keeps only names ending in a raw/image extension
    // (catalog/import.ts:isSupportedFile), so the payload has to wear a .jpg.
    const HOSTILE_FILE = '<img src=x onerror="window.__pwned=2">.jpg';
    const fails = [];
    const readSmartRow = async () => JSON.parse(await cdp.evaluate(`(() => {
      const cell = document.querySelector('#smart-collection-list .collection-name');
      return JSON.stringify({
        pwned: window.__pwned === undefined ? null : String(window.__pwned),
        text: cell ? cell.textContent : null,
        imgs: document.querySelectorAll('.collection-name img').length,
      });
    })()`));
    // The row lives in #smart-collection-list because the Quick Collection tray
    // puts its own .collection-name in the sibling list at boot.
    const expectSmartRow = (where, r) => {
      if (r.pwned !== null) fails.push(`${where}: the name executed as script (window.__pwned=${r.pwned})`);
      if (r.text !== PAYLOAD) fails.push(`${where}: .collection-name textContent=${JSON.stringify(r.text)}, expected the payload verbatim as text (0 chars rendered would fail too)`);
      if (r.imgs !== 0) fails.push(`${where}: ${r.imgs} <img> built inside .collection-name from the name string`);
    };
    await resetCatalog([
      { name: HOSTILE_FILE, gen: { bg: '#c0392b', fg: '#2980b9' } },
      { name: 'SEC2.jpg', gen: { bg: '#27ae60', fg: '#8e44ad' } },
    ]);
    await gotoModule('library');

    // -- vector 1: a smart-collection name, typed through the real dialog.
    // A rule with no conditions is refused on save (main.ts:6219), so select one
    // photo first -- the same route C24 uses.
    await cdp.evaluate(`(() => { const c = document.querySelector('.catalog-cell');
      c.dispatchEvent(new MouseEvent('click', { bubbles: true })); return 1; })()`);
    await sleep(400);
    await clickEl(cdp, '#add-smart-collection');
    await waitFor(cdp, `document.querySelector('#smart-dialog').open ? true : false`, { timeout: 8000 });
    await cdp.evaluate(`(() => { const n = document.querySelector('#smart-name');
      n.value = ${JSON.stringify(PAYLOAD)};
      n.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
    await cdp.evaluate('window.__pwned = undefined');
    await cdp.evaluate(`document.querySelector('#smart-save').click()`);
    await waitFor(cdp, `document.querySelector('#smart-dialog').open === false ? true : false`, { timeout: 10000 });
    await sleep(700);
    expectSmartRow('smart name (live render)', await readSmartRow());

    // -- vector 2: the loupe info overlay. Open the hostile-named photo in
    // Develop, then hover inside the top-left 150x150px the handler watches
    // (main.ts:4495). The overlay is #info-overlay (main.ts:4474 sets that id on
    // the div appended to canvas.parentElement); opacity '1' is the proof that
    // this run really painted it, so a selector that found some other node, or a
    // hover that landed outside the hot zone, fails loudly instead of passing.
    const hostile = await cdp.evaluate(`(() => { const c = [...document.querySelectorAll('.catalog-cell')]
      .find(x => (x.title || '').includes('onerror'));
      return c ? c.dataset.fileId : null; })()`);
    if (!hostile) throw new Error('no catalog cell carries the hostile filename — vector 2 is unexercised');
    await cdp.evaluate(`document.querySelector('.catalog-cell[data-file-id="${hostile}"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    await sleep(400);
    await cdp.evaluate(`document.querySelector('.catalog-cell[data-file-id="${hostile}"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    await waitFor(cdp, `document.querySelector('#canvas').width > 300 ? true : false`, { timeout: 60000 });
    const hot = JSON.parse(await cdp.evaluate(`(() => { const r = document.querySelector('#canvas').getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.left + 10), y: Math.round(r.top + 10) }); })()`));
    await cdp.evaluate('window.__pwned = undefined');
    // The handler arms a 3s fade-out, so read back right after the moves.
    for (const dy of [0, 3, 6]) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hot.x, y: hot.y + dy });
      await sleep(120);
    }
    const ov = JSON.parse(await cdp.evaluate(`(() => { const o = document.querySelector('#info-overlay');
      return JSON.stringify({
        present: !!o, opacity: o ? o.style.opacity : null,
        pwned: window.__pwned === undefined ? null : String(window.__pwned),
        text: o ? o.textContent : null,
      });
    })()`));
    if (!ov.present || ov.opacity !== '1') {
      throw new Error(`info overlay did not paint on hover (present=${ov.present} opacity=${ov.opacity}) — vector 2 is unexercised`);
    }
    if (ov.pwned !== null) fails.push(`info overlay: the filename executed as script (window.__pwned=${ov.pwned})`);
    if (!String(ov.text).includes(HOSTILE_FILE)) {
      fails.push(`info overlay: textContent=${JSON.stringify(ov.text)}, expected the filename verbatim as text`);
    }

    // -- vector 1 again after a reload: renderSmartCollections() runs at boot
    // (main.ts:6598) over the restored row, which is what makes a hostile catalog
    // backup re-execute on every load. This is the one that matters most.
    await cdp.send('Page.reload', { ignoreCache: false });
    await sleep(3000);
    await waitFor(cdp, `document.querySelector('#smart-collection-list .collection-name') ? true : false`, { timeout: 20000 });
    await sleep(500);
    expectSmartRow('smart name (after reload, from the restored row)', await readSmartRow());

    // -- static pin: the overlay needs a decoded photo plus a hover, so the
    // sweep that no HTML sink assignment survives at all is what keeps vector 2
    // from regressing quietly if the hover ever stops being drivable.
    const mainPath = join(process.cwd(), 'src', 'main.ts');
    const mainSrc = readFileSync(mainPath, 'utf8');
    const sinks = [...mainSrc.matchAll(/\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML\(|document\.write\(/g)]
      .map((m) => ({ line: mainSrc.slice(0, m.index).split('\n').length, text: mainSrc.split('\n')[mainSrc.slice(0, m.index).split('\n').length - 1].trim() }));
    if (sinks.length) {
      fails.push(`${sinks.length} HTML-sink assignment(s) remain in src/main.ts: ` + sinks.map((s) => `:${s.line} ${s.text}`).join(' · '));
    }
    if (fails.length) throw new Error(fails.join('; '));
    return `smart name "${PAYLOAD.slice(0, 24)}…" rendered as text both live and after reload (imgs=0, __pwned undefined); overlay "${String(ov.text).slice(0, 28)}…" painted on hover (opacity=${ov.opacity}, __pwned undefined); 0 HTML-sink assignments in src/main.ts`;
  });

  // C26: R1-14 — dismissing the error banner must never destroy it. The
  // device-loss recovery auto-dismissed its "Recovered" message with
  // errorEl.remove(), and #error-message / #error-detail are CHILDREN of #error
  // (index.html:2748-2754) that are also the module-level bindings showError
  // writes (main.ts:242-244). The references kept pointing at the detached
  // subtree and nothing recreates the node, so after a single GPU recovery all
  // 51 showError call sites rendered nothing for the rest of the session — the
  // app's only error channel died silently, and it is the channel that would
  // have reported every other failure. clearError() (hidden = true) is the
  // codebase's dismissal idiom, same as the Escape handler at main.ts:400.
  await check('stability: the error banner survives dismissal and keeps reporting', 'stability', async () => {
    const fails = [];

    // -- (a) static pin. THE regression assertion: it is the only part that goes
    // red when remove() comes back. Driving a real GPUDevice loss is not
    // possible here (see the comment on part (b)), so the defect is pinned where
    // it lives — in src/main.ts — the same way C25 pins the HTML sinks.
    const mainPath = join(process.cwd(), 'src', 'main.ts');
    const mainSrc = readFileSync(mainPath, 'utf8');
    const srcLines = mainSrc.split('\n');
    const located = (matches) => matches.map((m) => {
      const line = mainSrc.slice(0, m.index).split('\n').length;
      return `:${line} ${srcLines[line - 1].trim()}`;
    });
    // A bare document.querySelector('#error') is what shadowed the module-level
    // errorEl binding and made the removal invisible to showError. The typed
    // binding at :242 (document.querySelector<HTMLDivElement>('#error')) does
    // not match: the <HTMLDivElement> sits between the paren and the string.
    const removed = located([...mainSrc.matchAll(/errorEl\.remove\(\)/g)]);
    const requered = located([...mainSrc.matchAll(/document\.querySelector\(\s*['"]#error['"]\s*\)/g)]);
    if (removed.length) {
      fails.push(`${removed.length} errorEl.remove() in src/main.ts — it deletes #error and with it the bound #error-message/#error-detail, permanently killing every showError call site: ${removed.join(' · ')}`);
    }
    if (requered.length) {
      fails.push(`${requered.length} local re-query of #error in src/main.ts — the module already holds the errorEl binding, and a shadowing local is how the remove() went unnoticed: ${requered.join(' · ')}`);
    }

    // -- (b) behavioural guard. This half PASSES even with R1-14 present (only
    // the device-loss timer called remove(), and no device loss is drivable from
    // this harness: window.__qa and the permission/FSAA stubs are injected by
    // qa-loop.mjs itself, there is no test seam in src/, and pipeline is a
    // closure variable inside init() that no global exposes). So (b) proves only
    // that the fix did not break dismissal or reuse — it is not the pin.
    // The real showError comes from the Sync dialog: two selected photos with no
    // edits + one checked module makes runSync hit `if (!refPicked.length)` and
    // call showError(main.ts:5915). No module checked is a different branch
    // ("Pick at least one module.", :5871) that never reaches showError.
    const MSG = 'Nothing to sync -- the source photo has no edits in the selected modules.';
    const readBanner = async () => JSON.parse(await cdp.evaluate(`JSON.stringify({
      error: !!document.querySelector('#error'),
      message: !!document.querySelector('#error-message'),
      hidden: document.querySelector('#error') ? document.querySelector('#error').hidden : null,
      text: document.querySelector('#error-message') ? document.querySelector('#error-message').textContent : null,
    })`));
    const trigger = async () => {
      await clickEl(cdp, '#sync-btn');
      await waitFor(cdp, `document.querySelector('#sync-dialog').open ? true : false`, { timeout: 15000 });
      // A real click on the checkbox — the first open of an untouched source
      // pre-ticks nothing (openSyncDialog ticks only the modules it has intent
      // for), and a remembered dialog re-opens with it already ticked.
      await cdp.evaluate(`(() => { const cb = document.querySelector('#sync-modules input[value="Tone"]');
        if (cb && !cb.checked) cb.click(); return !!cb; })()`);
      const ticked = await cdp.evaluate(`!!document.querySelector('#sync-modules input[value="Tone"]').checked`);
      if (!ticked) throw new Error('#sync-modules has no enabled "Tone" checkbox — the trigger is unexercised');
      await clickEl(cdp, '#sync-go');
      // runSync returns right after showError and the submit handler closes it.
      await waitFor(cdp, `document.querySelector('#sync-dialog').open === false ? true : false`, { timeout: 30000 });
    };
    await resetCatalog([
      { name: 'EB1.jpg', gen: { bg: '#c0392b', fg: '#2980b9' } },
      { name: 'EB2.jpg', gen: { bg: '#27ae60', fg: '#8e44ad' } },
    ]);
    await gotoModule('library');
    const ids = JSON.parse(await cdp.evaluate(`JSON.stringify([...document.querySelectorAll('.catalog-cell')].map((c) => c.dataset.fileId))`));
    if (ids.length < 2) throw new Error(`need two unedited photos in the grid, got ${ids.length}`);
    await cdp.evaluate(`document.querySelector('.catalog-cell[data-file-id="${ids[0]}"]').dispatchEvent(new MouseEvent('click',{bubbles:true}))`);
    await sleep(300);
    await cdp.evaluate(`document.querySelector('.catalog-cell[data-file-id="${ids[1]}"]').dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true}))`);
    await sleep(600);
    const sel = JSON.parse(await cdp.evaluate(`JSON.stringify({
      n: document.querySelectorAll('.catalog-cell.selected').length,
      disabled: document.querySelector('#sync-btn').disabled })`));
    if (sel.n !== 2 || sel.disabled) throw new Error(`two-photo selection not built: ${JSON.stringify(sel)}`);

    // 1. the channel renders a real error.
    await trigger();
    const first = await readBanner();
    if (!first.error || !first.message || first.hidden !== false || first.text !== MSG) {
      throw new Error(`showError did not render: ${JSON.stringify(first)}, expected #error + #error-message present, hidden=false, text=${JSON.stringify(MSG)}`);
    }
    // 2. Escape hides it. Asserting the nodes still EXIST is the point: hidden
    // and removed both blank the screen, only one of them is fatal.
    await cdp.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    await sleep(300);
    const afterEsc = await readBanner();
    if (afterEsc.hidden !== true) fails.push(`Escape did not hide the banner (hidden=${afterEsc.hidden})`);
    if (!afterEsc.error || !afterEsc.message) {
      fails.push(`dismissal DESTROYED the banner instead of hiding it (#error=${afterEsc.error}, #error-message=${afterEsc.message}) — showError can never render again`);
    }
    if (afterEsc.text !== '') fails.push(`dismissal left stale text in #error-message: ${JSON.stringify(afterEsc.text)}`);
    // 3. and the app can still report afterwards — the property R1-14 killed.
    await trigger();
    const second = await readBanner();
    if (second.hidden !== false || second.text !== MSG) {
      fails.push(`the second showError rendered nothing (hidden=${second.hidden}, text=${JSON.stringify(second.text)}) — the error channel is dead after one dismissal`);
    }
    if (fails.length) throw new Error(fails.join('; '));
    return `src/main.ts: 0 errorEl.remove() + 0 local #error re-query; showError "${MSG.slice(0, 24)}…" rendered (hidden=false), Escape hid it with #error + #error-message both still in the document, second showError rendered again`;
  });
}

// ---- main ------------------------------------------------------------------
const argv = process.argv.slice(2);
const fast = argv.includes('--fast');
const keep = argv.includes('--keep');
// --skip-gates: for verifying one subsystem while other work is mid-flight in
// the tree. The gate result is still reported, just not fatal.
const skipGates = argv.includes('--skip-gates');
const onlyArg = argv.find((a) => a.startsWith('--only'));
const only = onlyArg ? onlyArg.split('=')[1].split(',').map((s) => s.trim()) : null;

const t0 = Date.now();
console.log('Candela QA loop');
console.log('===============');

const gatesOk = await gates();
const g = results[0];
console.log(`${g.ok ? 'PASS' : 'FAIL'} [static] ${g.name}\n     ${g.detail}`);
if (!gatesOk) {
  console.log('\nGates red. Tail of the gate log:');
  console.log((g.log || '').split('\n').slice(-25).join('\n'));
  if (!skipGates) {
    console.log('\nRefusing to run browser checks on a red tree (a fix cannot be');
    console.log('verified against code that does not compile/pass). Use --skip-gates');
    console.log('only when you are checking one subsystem while others are mid-flight.');
    process.exit(1);
  }
  console.log('\n--skip-gates: continuing to browser checks anyway.');
}

const srv = await ensureDevServer();
if (srv.started) console.log(`(started dev server on 5173, pid ${srv.child.pid})`);

const profile = mkdtempSync(join(tmpdir(), 'candela-qa-'));
const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check',
  // WebGPU needs the SwiftShader fallback in headless. Do NOT add
  // --use-gl=angle / --use-angle=swiftshader here: measured with
  // scripts/probe-gpu-flags.mjs, that pair makes navigator.gpu.requestAdapter()
  // return null, so the app shows its GPU gate and every check is vacuous.
  // This flag set alone yields ADAPTER OK.
  '--enable-unsafe-swiftshader',
  '--window-size=1600,1000',
  'about:blank',
], { stdio: 'ignore' });

let exitCode = 0;
try {
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    try { await listTargets(); break; } catch { /* not up yet */ }
  }
  const target = await newTarget(APP_URL);
  await sleep(2500);
  const cdp = await Cdp.connect(target.id);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  // The shim must exist before the app boots, so it goes in as a document-start
  // script and the page is reloaded once — after-boot injection misses the
  // first render wave and reads as a healthy page.
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: SHIM });
  await cdp.send('Page.navigate', { url: APP_URL });
  await sleep(3500);
  await cdp.evaluate(`(() => { const t=[...document.querySelectorAll('#topbar button')].find(b=>/library/i.test(b.textContent)); t?.click(); return 1; })()`);
  await sleep(500);

  await runChecks(cdp, { fast });
  cdp.close();
} catch (err) {
  results.push({ name: 'harness', group: 'infra', ok: false, detail: String(err.stack || err), ms: 0 });
}

// Report BEFORE teardown: a cleanup failure (Chrome still flushing its profile
// dir, ENOTEMPTY on rm) must never swallow the results it was guarding.
console.log('');
const groups = [...new Set(results.map((r) => r.group))];
for (const grp of groups) {
  for (const r of results.filter((x) => x.group === grp)) {
    if (only && !only.some((o) => r.name.toLowerCase().includes(o.toLowerCase()) || grp.includes(o))) continue;
    console.log(`${r.ok ? 'PASS' : 'FAIL'} [${grp}] ${r.name}  (${r.ms}ms)`);
    console.log(`     ${r.detail}`);
  }
}
const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok);
console.log('');
console.log(`--- ${passed}/${results.length} checks passed in ${((Date.now() - t0) / 1000).toFixed(1)}s ---`);
if (failed.length) {
  console.log(`FAILED: ${failed.map((f) => f.name).join(', ')}`);
  exitCode = 1;
}
writeFileSync('qa-report.json', JSON.stringify({ at: new Date().toISOString(), results }, null, 2));

if (!keep) {
  chrome.kill('SIGKILL');
  await sleep(400); // let Chrome release the profile dir before rm
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5 }); } catch { /* temp dir leaks; harmless */ }
  if (srv.started && srv.child) srv.child.kill('SIGKILL');
} else {
  console.log(`(--keep: Chrome alive on debug port ${DEBUG_PORT}, profile ${profile})`);
}
process.exit(exitCode);
