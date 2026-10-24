// Chrome lifecycle + DevTools HTTP endpoints + persistent session state.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep } from './cdp.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PORT = Number(process.env.BROWSE_PORT || 9222);
export const BASE = `http://127.0.0.1:${PORT}`;
export const STATE_DIR = join(ROOT, '.browse');
export const STATE_FILE = join(STATE_DIR, 'state.json');
export const PROFILE_DIR = join(STATE_DIR, 'profile');
export const LOG_FILE = join(STATE_DIR, 'chrome.log');

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

export function findChrome() {
  if (process.env.BROWSE_CHROME && existsSync(process.env.BROWSE_CHROME)) return process.env.BROWSE_CHROME;
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return p;
  throw new Error('No Chrome/Chromium binary found. Set BROWSE_CHROME=/path/to/chrome');
}

async function httpJson(path, init = {}, timeoutMs = 4000) {
  const ctl = AbortSignal.timeout(timeoutMs);
  const res = await fetch(BASE + path, { ...init, signal: ctl });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function version() {
  try {
    return await httpJson('/json/version');
  } catch {
    return null;
  }
}

export async function isRunning() {
  return (await version()) !== null;
}

export function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

export function saveState(patch) {
  mkdirSync(STATE_DIR, { recursive: true });
  const next = { ...loadState(), ...patch };
  writeFileSync(STATE_FILE, JSON.stringify(next, null, 2));
  return next;
}

let launching = null;

/**
 * Start Chrome with remote debugging if it is not already up.
 *
 * By default an already-running browser is REUSED regardless of headless/headed mode --
 * restarting it would destroy an interactive login session the user just performed.
 * Pass enforceMode:true when the caller genuinely requires a specific mode (e.g. `login`,
 * or `open --headed`).
 */
export async function ensureChrome({ headed = false, enforceMode = false, width = 1440, height = 900 } = {}) {
  const state = loadState();
  const running = await version();

  if (running) {
    const runningHeaded = state.headed === true;
    if (!enforceMode || runningHeaded === headed) {
      return { started: false, version: running, headed: runningHeaded, reused: true };
    }
    // Mode explicitly requested and different -> restart.
    await stopChrome();
  }

  if (launching) return launching;
  launching = (async () => {
    const bin = findChrome();
    mkdirSync(PROFILE_DIR, { recursive: true });
    const args = [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-crash-reporter',
      '--disable-breakpad',
      '--disable-features=Translate,MediaRouter,OptimizationHints',
      // Fewer automation tells; navigator.webdriver is also patched in applyStealth().
      '--disable-blink-features=AutomationControlled',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      `--window-size=${width},${height}`,
      '--lang=zh-CN',
      '--remote-allow-origins=*',
    ];
    // The agent itself runs inside a filesystem sandbox, where Chrome's own sandbox cannot
    // initialize ("sandbox initialization failed: Operation not permitted"). That kills the GPU
    // process and Chrome aborts with "GPU process isn't usable. Goodbye." -- in HEADED mode too.
    // Both modes therefore need --no-sandbox/--disable-gpu. Acceptable here: the browser uses an
    // isolated profile and is driven by an automated tool, not used as a daily browser.
    args.push('--no-sandbox', '--disable-gpu');
    if (!headed) {
      args.push('--headless=new', '--hide-scrollbars');
    } else {
      args.push('--new-window', 'about:blank');
    }
    const fd = openSync(LOG_FILE, 'a');
    const child = spawn(bin, args, { detached: true, stdio: ['ignore', fd, fd] });
    child.unref();

    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      const v = await version();
      if (v) {
        saveState({ headed, chromePid: child.pid, startedAt: new Date().toISOString() });
        return { started: true, version: v, headed };
      }
      await sleep(300);
    }
    throw new Error(`Chrome did not expose CDP on port ${PORT}. See ${LOG_FILE}`);
  })();

  try {
    return await launching;
  } finally {
    launching = null;
  }
}

export async function stopChrome() {
  const state = loadState();
  const pid = state.chromePid;
  if (pid) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (!(await isRunning())) break;
    await sleep(250);
  }
  saveState({ chromePid: null, currentTargetId: null });
}

export async function newTarget(url = 'about:blank') {
  const t = await httpJson(`/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!t || !t.webSocketDebuggerUrl) throw new Error('Failed to create tab');
  return t;
}

export async function listTargets() {
  const list = await httpJson('/json/list');
  return (Array.isArray(list) ? list : []).filter((t) => t.type === 'page');
}

export async function getTarget(id) {
  const targets = await listTargets();
  return targets.find((t) => t.id === id) || null;
}

export async function closeTarget(id) {
  try {
    await httpJson(`/json/close/${id}`, { method: 'PUT' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Record + reuse the "current tab" so separate CLI invocations share one page.
 * Returns { target, reused }.
 */
export async function ensureTarget({ force = false, url = 'about:blank' } = {}) {
  const state = loadState();
  if (!force && state.currentTargetId) {
    const existing = await getTarget(state.currentTargetId);
    if (existing) return { target: existing, reused: true };
  }
  const target = await newTarget(url);
  saveState({ currentTargetId: target.id });
  return { target, reused: false };
}

/** Real-browser UA: some sites hard-block the "HeadlessChrome" token. */
export async function applyStealth(cdp, { userAgent, locale = 'zh-CN' } = {}) {
  const versionStr = (await version())?.Browser?.split('/')[1] || '154.0.0.0';
  const ua =
    userAgent ||
    `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${versionStr} Safari/537.36`;
  await cdp.send('Network.enable');
  await cdp.send('Network.setUserAgentOverride', {
    userAgent: ua,
    acceptLanguage: locale,
    platform: 'MacIntel',
  });
  // Hide the most obvious automation tell.
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `Object.defineProperty(navigator,'webdriver',{get:()=>undefined});`,
  });
  return ua;
}

/** Navigate and wait for the page to settle. Throws on a hard network error. */
export async function navigate(cdp, url, { waitMs = 1500, timeoutMs = 30000, waitForSelector = null } = {}) {
  const loadPromise = cdp.waitFor('Page.loadEventFired', timeoutMs);
  // Bound the command itself: on unreachable hosts (e.g. DNS-blackholed domains) the
  // browser can leave Page.navigate pending forever instead of returning errorText.
  const res = await cdp.send('Page.navigate', { url }, Math.min(timeoutMs, 20000));
  if (res && res.errorText) {
    throw new Error(`Navigation failed for ${url}: ${res.errorText}`);
  }
  const loaded = await loadPromise;

  // readyState poll as a backstop (some SPA navigations skip the event).
  const deadline = Date.now() + Math.min(timeoutMs, 12000);
  while (Date.now() < deadline) {
    try {
      const rs = await cdp.evaluate('document.readyState');
      if (rs === 'complete') break;
    } catch {
      /* frame may be swapping */
    }
    await sleep(200);
  }
  if (waitForSelector) {
    const sel = JSON.stringify(waitForSelector);
    const selDeadline = Date.now() + timeoutMs;
    while (Date.now() < selDeadline) {
      const found = await cdp.evaluate(`!!document.querySelector(${sel})`).catch(() => false);
      if (found) break;
      await sleep(250);
    }
  }
  if (waitMs > 0) await sleep(waitMs);

  // Chrome renders network errors as an internal error page; report them as failures.
  const errPage = await cdp
    .evaluate(`(() => {
      const t = document.body ? (document.body.innerText || '') : '';
      const m = /(ERR_[A-Z_]+)/.exec(t);
      return m ? m[1] : null;
    })()`)
    .catch(() => null);
  if (errPage) throw new Error(`Navigation failed for ${url}: ${errPage}`);

  return { loaded: !!loaded, errorText: res?.errorText || null };
}

/**
 * Navigate and return the RAW server HTML -- the view-source equivalent, captured from the
 * network layer before any JavaScript rewrites the DOM. Essential for SPAs where the rendered
 * DOM is useless for finding the real markup or the XHR endpoints.
 */
export async function fetchSource(cdp, url, { waitMs = 1200, timeoutMs = 30000 } = {}) {
  await cdp.send('Network.enable');
  const docs = [];
  const off = cdp.on('Network.responseReceived', (p) => {
    if (p.type === 'Document' && p.response && !/^(data|blob):/.test(p.response.url)) {
      docs.push({
        requestId: p.requestId,
        url: p.response.url,
        status: p.response.status,
        mimeType: p.response.mimeType,
        headers: p.response.headers || {},
      });
    }
  });
  try {
    await navigate(cdp, url, { waitMs, timeoutMs });
    await sleep(400); // let late redirects register
  } finally {
    off();
  }
  if (!docs.length) return { ok: false, reason: 'no document response captured' };

  // Newest first: after redirects the final document is the one we want.
  for (const cand of docs.slice().reverse()) {
    try {
      const body = await cdp.send('Network.getResponseBody', { requestId: cand.requestId }, 15000);
      const html = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
      if (html && html.length) return { ok: true, ...cand, html, chain: docs.map((d) => d.url) };
    } catch {
      /* body evicted from memory; try the next candidate */
    }
  }
  return { ok: false, reason: 'response body unavailable (evicted from memory)', chain: docs.map((d) => d.url) };
}
