#!/usr/bin/env node
// browse.mjs -- drive your locally installed Chrome so an agent (or you) can actually
// open pages, read them, click, type and screenshot. Zero npm dependencies.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { CDP, sleep } from './lib/cdp.mjs';
import { extractorExpression } from './lib/extract.mjs';
import {
  ROOT,
  STATE_DIR,
  applyStealth,
  closeTarget,
  ensureChrome,
  ensureTarget,
  fetchSource,
  getTarget,
  listTargets,
  loadState,
  navigate,
  newTarget,
  saveState,
  stopChrome,
  version,
  isRunning,
} from './lib/chrome.mjs';

const USAGE = `browse.mjs -- local Chrome driver for agents

Usage: node browse.mjs <command> [args] [flags]

Commands
  open <url>            Open a URL and print the readable content as Markdown
  read                  Re-extract the current tab
  links [--limit N]     List links on the current page
  source [url]          RAW server HTML (view-source equivalent, pre-JavaScript)
  html [--sel CSS]      Rendered DOM of the current tab (post-JavaScript)
  dom <css>             Inspect matching elements: attrs, box, visibility, text
  outline [css]         Indented DOM tree (tags/#id/.class) for eyeballing structure
  net [url]             Record network requests; save XHR/JSON response bodies
  click <sel|text>      Click an element by CSS selector or by its visible text
  type <sel> <text>     Focus a field and type text
  press <key>           Dispatch a key (Enter, Tab, Escape, PageDown, ...)
  scroll [--by N|--to bottom|--sel CSS]
  shot [file.png]       Screenshot the current tab (full page by default; --print = print CSS)
  pdf [file.pdf]        Render the current tab to PDF (follows the page's @page rules)
  eval <js>             Evaluate JavaScript in the page
  back | forward        History navigation
  tabs                  List open tabs
  cookies [domain]      List cookie names for a domain (login check)
  status                Show Chrome/session status
  stop                  Shut the browser down
  login <url>           Open a HEADED browser so you can log in manually; profile is reused

Flags
  --wait <ms>       Extra settle time after load (default 1500)
  --for <css>       Wait until this selector exists
  --out <file>      Write the extracted Markdown to a file
  --json            Machine-readable JSON output
  --text            Plain text instead of Markdown
  --html            Raw page HTML instead of extracted content
  --new             Force a fresh tab
  --headed          Run Chrome with a visible window
  --no-links        Skip link collection (faster on huge pages)
  --limit <n>       Max links to return (default 500)
  --full            Screenshot the entire page (default for full page)
  --viewport        Screenshot only the visible viewport
  --timeout <ms>    Navigation timeout (default 30000)
`;

function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) flags[key] = true;
        else {
          flags[key] = next;
          i++;
        }
      }
    } else if (a.startsWith('-') && a.length === 2) {
      flags[a.slice(1)] = true;
    } else {
      pos.push(a);
    }
  }
  return { flags, pos };
}

const num = (v, d) => (v === undefined || v === true ? d : Number(v));

function outPath(p) {
  return isAbsolute(p) ? p : resolve(ROOT, p);
}

function writeOut(p, data) {
  const abs = outPath(p);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, data);
  return abs;
}

async function attachCurrent({ force = false, newTabUrl = 'about:blank' } = {}) {
  // Reuse whatever Chrome is already running (e.g. a headed window the user just logged
  // into) instead of restarting it in headless mode.
  await ensureChrome({ headed: false });
  let target;
  if (force) {
    target = await newTarget(newTabUrl);
    saveState({ currentTargetId: target.id });
  } else {
    const r = await ensureTarget({ url: newTabUrl });
    target = r.target;
  }
  const cdp = await CDP.attach(target.webSocketDebuggerUrl);
  return { cdp, target };
}

// Small helper so each command gets a connected page session.
CDP.attach = async function (wsUrl) {
  const c = new CDP(wsUrl);
  await c.connect();
  return c;
};

async function prepare(cdp, flags = {}) {
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await applyStealth(cdp, { userAgent: typeof flags.ua === 'string' ? flags.ua : undefined });
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: num(flags.width, 1440),
    height: num(flags.height, 900),
    deviceScaleFactor: 1,
    mobile: false,
  }).catch(() => {});
}

function header(info) {
  const bits = [];
  if (info.url) bits.push(`URL: ${info.url}`);
  if (info.title) bits.push(`TITLE: ${info.title}`);
  if (info.wordCount) bits.push(`CHARS: ${info.wordCount}`);
  if (info.container) bits.push(`CONTAINER: ${info.container}`);
  if (info.hints?.length) bits.push(`HINTS: ${info.hints.join(',')}`);
  return bits.map((b) => `=== ${b}`).join('\n') + '\n---';
}

async function extract(cdp, flags = {}) {
  const expr = extractorExpression({
    includeLinks: !flags['no-links'],
    maxLinks: num(flags.limit, 500),
  });
  const res = await cdp.evaluate(expr, { timeoutMs: 45000 });
  return res;
}

async function cmdOpen(args, flags) {
  const url = args[0];
  if (!url) throw new Error('open requires a URL');
  // Only force a mode switch when the user explicitly asked for headed; otherwise reuse
  // the running browser so an interactive login session survives.
  await ensureChrome({ headed: !!flags.headed, enforceMode: !!flags.headed });
  const { target } = await ensureTarget({ force: !!flags.new, url: 'about:blank' });
  const cdp = await CDP.attach(target.webSocketDebuggerUrl);
  try {
    await prepare(cdp, flags);
    await navigate(cdp, url, {
      waitMs: num(flags.wait, 1500),
      timeoutMs: num(flags.timeout, 30000),
      waitForSelector: typeof flags.for === 'string' ? flags.for : null,
    });

    if (flags.html) {
      const html = await cdp.evaluate('document.documentElement.outerHTML');
      if (flags.out) {
        const p = writeOut(flags.out, html);
        console.log(`saved: ${p} (${html.length} bytes)`);
      } else {
        console.log(html);
      }
      return;
    }

    const res = await extract(cdp, flags);
    res.requestedUrl = url;
    const stripHash = (u) => String(u || '').split('#')[0].replace(/\/$/, '');
    res.redirected = stripHash(res.url) !== stripHash(url);
    if (flags.json) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log(header(res));
      const body = flags.text ? res.text : res.markdown;
      if (flags.out) {
        const p = writeOut(flags.out, body);
        console.log(`\n${body.slice(0, 400)}${body.length > 400 ? '\n...[truncated]' : ''}`);
        console.log(`\n=== SAVED: ${p} (${body.length} chars)`);
      } else {
        console.log(body);
      }
      if (res.hints?.some((h) => /login-wall|bot-challenge|captcha|blocked/.test(h))) {
        console.log(
          [
            '',
            '!!! WALL DETECTED: the site returned a login / anti-bot page, not the article.',
            `!!! final URL: ${res.url}`,
            '!!! Fix: log in once with a visible window, then retry (cookies persist in the profile):',
            `!!!   node browse.mjs login "${url}"`,
            `!!!   node browse.mjs open "${url}" --headed`,
          ].join('\n'),
        );
      }
    }
  } finally {
    cdp.close();
  }
}

async function withCurrent(flags, fn) {
  const { cdp, target } = await attachCurrent();
  try {
    await prepare(cdp, flags);
    return await fn(cdp, target);
  } finally {
    cdp.close();
  }
}

async function cmdRead(args, flags) {
  await withCurrent(flags, async (cdp) => {
    const res = await extract(cdp, flags);
    if (flags.json) console.log(JSON.stringify(res, null, 2));
    else {
      console.log(header(res));
      console.log(flags.text ? res.text : res.markdown);
    }
  });
}

async function cmdLinks(args, flags) {
  await withCurrent(flags, async (cdp) => {
    const res = await extract(cdp, { ...flags, 'no-links': false });
    const limit = num(flags.limit, 500);
    const links = res.links.slice(0, limit);
    if (flags.json) console.log(JSON.stringify({ url: res.url, title: res.title, links }, null, 2));
    else {
      console.log(`=== URL: ${res.url}`);
      console.log(`=== TITLE: ${res.title}`);
      console.log(`=== LINKS: ${links.length}`);
      console.log('---');
      for (const l of links) console.log(`${l.text || '(no text)'}\t${l.href}`);
    }
  });
}

// ---- source / DOM inspection -------------------------------------------------

async function cmdSource(args, flags) {
  const url = args[0];
  await withCurrent(flags, async (cdp) => {
    let html;
    let meta = {};
    if (url) {
      const res = await fetchSource(cdp, url, {
        waitMs: num(flags.wait, 1000),
        timeoutMs: num(flags.timeout, 30000),
      });
      if (!res.ok) throw new Error(`could not capture raw source: ${res.reason}`);
      html = res.html;
      meta = { url: res.url, status: res.status, mimeType: res.mimeType, redirects: res.chain?.length || 1 };
    } else {
      // No URL: refetch the current document the way a new tab would receive it.
      const res = await cdp.evaluate(
        `(async () => {
           const r = await fetch(location.href, { credentials: 'include', cache: 'no-store' });
           return { status: r.status, url: r.url, html: await r.text() };
         })()`,
        { timeoutMs: 30000 },
      );
      html = res.html;
      meta = { url: res.url, status: res.status, note: 'refetched via in-page fetch (current tab)' };
    }
    if (flags.json) {
      console.log(JSON.stringify({ ...meta, bytes: html.length, html: flags.out ? undefined : html }, null, 2));
      if (flags.out) console.log(`saved: ${writeOut(flags.out, html)}`);
      return;
    }
    console.log(`=== SOURCE: ${meta.url || url}`);
    console.log(`=== STATUS: ${meta.status ?? '?'}`);
    console.log(`=== BYTES: ${html.length}`);
    if (meta.redirects > 1) console.log(`=== REDIRECT CHAIN: ${meta.redirects} documents`);
    console.log('---');
    if (flags.out) {
      const p = writeOut(flags.out, html);
      console.log(html.slice(0, 600));
      console.log(`\n=== SAVED: ${p} (${html.length} bytes)`);
    } else {
      console.log(html);
    }
  });
}

async function cmdHtml(args, flags) {
  await withCurrent(flags, async (cdp) => {
    const sel = typeof flags.sel === 'string' ? flags.sel : null;
    const html = await cdp.evaluate(
      sel
        ? `(() => { const el = document.querySelector(${JSON.stringify(sel)}); return el ? el.outerHTML : null; })()`
        : 'document.documentElement.outerHTML',
    );
    if (html === null) throw new Error(`no element matched: ${sel}`);
    const note = sel ? `element ${sel}` : 'whole document';
    if (flags.out) {
      console.log(JSON.stringify({ saved: writeOut(flags.out, html), bytes: html.length, scope: note }, null, 2));
    } else {
      console.log(`=== RENDERED DOM (${note}, ${html.length} bytes)`);
      console.log('---');
      console.log(html);
    }
  });
}

const DOM_JS = (sel, limit, wantStyles, wantHtml) => `(() => {
  const sel = ${JSON.stringify(sel)};
  const limit = ${Number(limit)};
  const wantStyles = ${wantStyles ? 'true' : 'false'};
  const wantHtml = ${wantHtml ? 'true' : 'false'};

  function cssPath(el) {
    if (!el || el.nodeType !== 1) return '';
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      let part = node.tagName.toLowerCase();
      if (node.id) { parts.unshift(part + '#' + node.id); break; }
      const cls = (typeof node.className === 'string' ? node.className : '').trim().split(/\\s+/).filter(Boolean).slice(0, 2);
      if (cls.length) part += '.' + cls.join('.');
      const parent = node.parentElement;
      if (parent) {
        const sibs = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (sibs.length > 1) part += ':nth-of-type(' + (sibs.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  let nodes;
  try { nodes = Array.from(document.querySelectorAll(sel)); }
  catch (e) { return { error: 'invalid selector: ' + e.message }; }

  const keep = ['id','class','href','src','name','type','value','placeholder','title','role','alt','datetime','content','colspan','rowspan','style'];
  const elements = nodes.slice(0, limit).map((el, i) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const attrs = {};
    for (const a of el.attributes) {
      if (keep.includes(a.name) || /^(data-|aria-)/.test(a.name)) attrs[a.name] = String(a.value).slice(0, 300);
    }
    const rec = {
      index: i,
      tag: el.tagName.toLowerCase(),
      path: cssPath(el),
      text: (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 300),
      attrs: attrs,
      box: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      visible: r.width > 1 && r.height > 1 && cs.display !== 'none' && cs.visibility !== 'hidden',
      children: el.children.length,
    };
    if (wantStyles) rec.style = { display: cs.display, position: cs.position, color: cs.color, background: cs.backgroundColor, fontSize: cs.fontSize, overflow: cs.overflow };
    if (wantHtml) rec.html = el.outerHTML.slice(0, 4000);
    return rec;
  });

  return { selector: sel, count: nodes.length, returned: elements.length, elements: elements };
})()`;

async function cmdDom(args, flags) {
  const sel = args.join(' ') || 'body';
  await withCurrent(flags, async (cdp) => {
    const res = await cdp.evaluate(
      DOM_JS(sel, num(flags.limit, 20), !!flags.styles, !!flags.html),
      { timeoutMs: 30000 },
    );
    if (res.error) throw new Error(res.error);
    if (flags.json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    console.log(`=== SELECTOR: ${res.selector}`);
    console.log(`=== MATCHES: ${res.count} (showing ${res.returned})`);
    console.log('---');
    for (const el of res.elements) {
      console.log(`[${el.index}] <${el.tag}>${el.visible ? '' : ' (hidden)'} ${el.box.w}x${el.box.h} @ ${el.box.x},${el.box.y}`);
      console.log(`    path: ${el.path}`);
      const a = Object.entries(el.attrs).map(([k, v]) => `${k}="${String(v).slice(0, 120)}"`).join(' ');
      if (a) console.log(`    attrs: ${a}`);
      if (el.text) console.log(`    text: ${el.text.slice(0, 200)}`);
      if (el.style) console.log(`    style: ${JSON.stringify(el.style)}`);
      if (el.html) console.log(`    html: ${el.html.slice(0, 500)}`);
    }
  });
}

const OUTLINE_JS = (sel, depth, limit) => `(() => {
  const root = document.querySelector(${JSON.stringify(sel)}) || document.body;
  const maxDepth = ${Number(depth)};
  const maxLines = ${Number(limit)};
  const lines = [];
  let hidden = 0;
  function label(el) {
    const id = el.id ? '#' + el.id : '';
    let cls = '';
    if (typeof el.className === 'string' && el.className.trim()) {
      cls = '.' + el.className.trim().split(/\\s+/).slice(0, 3).join('.');
    }
    return el.tagName.toLowerCase() + id + cls;
  }
  function walk(el, d) {
    if (lines.length >= maxLines) return;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const isHidden = cs.display === 'none' || cs.visibility === 'hidden' || r.width < 1 || r.height < 1;
    if (isHidden) hidden++;
    const inline = el.children.length === 0 ? (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 50) : '';
    lines.push('  '.repeat(d) + label(el) + (isHidden ? ' [hidden]' : '') + (inline ? ' — ' + inline : ''));
    if (d >= maxDepth) return;
    for (const c of el.children) walk(c, d + 1);
  }
  walk(root, 0);
  return { lines: lines.join('\\n'), count: lines.length, hidden: hidden, root: label(root) };
})()`;

async function cmdOutline(args, flags) {
  const sel = args.join(' ') || 'body';
  await withCurrent(flags, async (cdp) => {
    const res = await cdp.evaluate(OUTLINE_JS(sel, num(flags.depth, 4), num(flags.limit, 400)));
    if (flags.json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    console.log(`=== OUTLINE root=${res.root} lines=${res.count} hidden=${res.hidden}`);
    console.log('---');
    console.log(res.lines);
  });
}

async function cmdNet(args, flags) {
  const url = args[0];
  await withCurrent(flags, async (cdp) => {
    await cdp.send('Network.enable');
    const records = new Map();
    const bodies = [];
    const offReq = cdp.on('Network.requestWillBeSent', (p) => {
      records.set(p.requestId, { requestId: p.requestId, method: p.request.method, url: p.request.url, type: p.type });
    });
    const offRes = cdp.on('Network.responseReceived', (p) => {
      const rec = records.get(p.requestId) || { requestId: p.requestId, method: '?', url: p.response.url };
      rec.status = p.response.status;
      rec.mimeType = p.response.mimeType;
      rec.type = p.type;
      rec.encodedLength = p.response.encodedDataLength;
      records.set(p.requestId, rec);
    });
    const offFail = cdp.on('Network.loadingFailed', (p) => {
      const rec = records.get(p.requestId) || { requestId: p.requestId, url: '(unknown)' };
      rec.failed = p.errorText;
      records.set(p.requestId, rec);
    });
    // Bodies must be collected while the response is still in memory. Scripts and stylesheets
    // are skipped by default: on a modern page they would eat the whole body budget before the
    // interesting XHR/JSON payloads arrive. Use --all to keep everything.
    const keepAll = !!flags.all;
    const maxKeep = num(flags['max-collect'], 60);
    const maxBodyBytes = num(flags['max-bytes'], 4_000_000);
    const offFin = cdp.on('Network.loadingFinished', async (p) => {
      const rec = records.get(p.requestId);
      if (!rec) return;
      const type = String(rec.type || '');
      const mime = String(rec.mimeType || '');
      const isXhr = /xhr|fetch/i.test(type) || /json/i.test(mime);
      const isDoc = type === 'Document';
      const isText = /text\/plain|text\/html/i.test(mime);
      const wanted = keepAll ? true : isXhr || isDoc || isText;
      if (!wanted) return;
      if (bodies.length >= maxKeep) return;
      if (rec.encodedLength > maxBodyBytes) {
        rec.skipped = `body too large (${Math.round(rec.encodedLength)}B)`;
        return;
      }
      try {
        const body = await cdp.send('Network.getResponseBody', { requestId: p.requestId }, 10000);
        const text = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
        if (text && text.length) bodies.push({ requestId: p.requestId, text, priority: isXhr ? 0 : isDoc ? 1 : 2 });
      } catch {
        /* evicted or not retrievable */
      }
    });

    try {
      if (url) await navigate(cdp, url, { waitMs: num(flags.settle, 2500), timeoutMs: num(flags.timeout, 30000) });
      else {
        const loadP = cdp.waitFor('Page.loadEventFired', 15000);
        await cdp.send('Page.reload', { ignoreCache: false });
        await loadP;
        await sleep(num(flags.settle, 2500));
      }
    } finally {
      offReq(); offRes(); offFail(); offFin();
    }
    await sleep(300);

    const filter = typeof flags.filter === 'string' ? flags.filter : null;
    const typeFilter = typeof flags.type === 'string' ? flags.type.toLowerCase() : null;
    let list = Array.from(records.values()).filter((r) => r.url);
    if (filter) list = list.filter((r) => r.url.includes(filter));
    if (typeFilter) list = list.filter((r) => String(r.type || '').toLowerCase() === typeFilter);

    const bodyMap = new Map(bodies.map((b) => [b.requestId, b]));
    const maxBodies = num(flags.bodies, 10);

    // Save the most interesting payloads first (XHR/JSON, then documents), regardless of
    // the order they happened to finish loading in.
    const saveOrder = list
      .filter((r) => bodyMap.has(r.requestId))
      .sort((a, b) => (bodyMap.get(a.requestId).priority ?? 9) - (bodyMap.get(b.requestId).priority ?? 9));

    const saved = [];
    let savedCount = 0;
    for (const rec of saveOrder) {
      const text = bodyMap.get(rec.requestId).text;
      rec.bodyBytes = text.length;
      if (savedCount >= maxBodies) continue;
      const looksJson = /json/i.test(rec.mimeType || '') || /^[[{]/.test(text.trim());
      const ext = looksJson ? 'json' : rec.type === 'Document' ? 'html' : 'txt';
      const tail = (rec.url.split('/').pop() || 'body').split('?')[0].replace(/[^\w.-]/g, '_').slice(0, 40) || 'body';
      const abs = writeOut(`net/${String(savedCount + 1).padStart(2, '0')}-${tail}.${ext}`, text);
      rec.bodyFile = abs;
      saved.push(abs);
      savedCount++;
    }

    if (flags.json) {
      console.log(JSON.stringify({ url: await cdp.evaluate('location.href'), total: list.length, saved, requests: list }, null, 2));
      return;
    }
    console.log(`=== URL: ${await cdp.evaluate('location.href')}`);
    console.log(`=== REQUESTS: ${list.length}   BODIES SAVED: ${saved.length}`);
    console.log('---');
    for (const r of list) {
      const size = r.bodyBytes ? `${r.bodyBytes}B` : r.encodedLength ? `${Math.round(r.encodedLength)}B` : '-';
      const flagStr = r.failed ? ` FAILED(${r.failed})` : '';
      console.log(`${String(r.status ?? '---')} ${String(r.method).padEnd(5)} ${String(r.type || '').padEnd(9)} ${size.padStart(8)}  ${r.url.slice(0, 130)}${flagStr}`);
      if (r.bodyFile) console.log(`        body -> ${r.bodyFile}`);
    }
  });
}

const FIND_JS = (needle) => `(() => {
  const needle = ${JSON.stringify(needle)};
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
  };
  let el = null;
  try { el = document.querySelector(needle); } catch (e) { el = null; }
  if (el && visible(el)) return { how: 'selector', el };
  const cands = Array.from(document.querySelectorAll('a,button,[role="button"],input[type="submit"],summary,label,li,span,div'));
  const scored = [];
  for (const c of cands) {
    const t = norm(c.innerText || c.textContent);
    if (!t) continue;
    let score = -1;
    if (t === needle) score = 100;
    else if (t.startsWith(needle)) score = 80;
    else if (t.includes(needle)) score = 50;
    if (score < 0) continue;
    if (!visible(c)) continue;
    // prefer the smallest element containing the text
    score -= Math.min(t.length / 10, 20);
    scored.push([score, c]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  if (scored.length) return { how: 'text', el: scored[0][1] };
  return null;
})()`;

async function clickElement(cdp, arg, flags) {
  const found = await cdp.evaluate(
    `(() => {
      const f = ${FIND_JS(arg)};
      if (!f) return null;
      const el = f.el;
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const r = el.getBoundingClientRect();
      return {
        how: f.how,
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
        href: el.href || el.getAttribute('href') || '',
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
        box: { x: r.left, y: r.top, w: r.width, h: r.height },
      };
    })()`,
  );
  if (!found) return null;
  if (!found.box || found.box.w < 2 || found.box.h < 2) {
    // Zero-size (e.g. hidden anchor): fall back to a scripted click.
    await cdp.evaluate(`(() => { const f = ${FIND_JS(arg)}; if (f) f.el.click(); return true; })()`);
    return { ...found, mode: 'js-click' };
  }
  const x = Math.round(found.x);
  const y = Math.round(found.y);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await sleep(40);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  return { ...found, mode: 'mouse' };
}

async function cmdClick(args, flags) {
  const arg = args.join(' ');
  if (!arg) throw new Error('click requires a selector or text');
  await withCurrent(flags, async (cdp) => {
    const info = await clickElement(cdp, arg, flags);
    if (!info) throw new Error(`nothing clickable matched: ${arg}`);
    const before = await cdp.evaluate('location.href');
    const loadP = cdp.waitFor('Page.loadEventFired', 8000);
    await loadP;
    await sleep(num(flags.wait, 1200));
    const after = await cdp.evaluate('location.href');
    const title = await cdp.evaluate('document.title');
    console.log(
      JSON.stringify(
        { clicked: info, navigated: before !== after, url: after, title, ...(flags.json ? {} : {}) },
        null,
        2,
      ),
    );
  });
}

async function cmdType(args, flags) {
  const sel = args[0];
  const text = args.slice(1).join(' ');
  if (!sel || text === undefined) throw new Error('type requires <selector> <text>');
  await withCurrent(flags, async (cdp) => {
    const ok = await cdp.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return false;
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      el.focus();
      return document.activeElement === el || el.contains(document.activeElement);
    })()`);
    if (!ok) throw new Error(`field not found or not focusable: ${sel}`);
    await cdp.send('Input.insertText', { text });
    let value = await cdp.evaluate(`document.querySelector(${JSON.stringify(sel)}).value`);
    if (value !== text) {
      // React/Vue controlled inputs ignore raw insertText sometimes.
      value = await cdp.evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(sel)});
        const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value');
        if (setter && setter.set) setter.set.call(el, ${JSON.stringify(text)});
        else el.value = ${JSON.stringify(text)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return el.value;
      })()`);
    }
    if (flags.enter) {
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await cdp.send('Input.dispatchKeyEvent', { type: 'char', text: '\r' });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    }
    console.log(JSON.stringify({ typed: text, value }, null, 2));
  });
}

const KEYS = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9, text: '\t' },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  End: { code: 'End', keyCode: 35 },
  Home: { code: 'Home', keyCode: 36 },
  Space: { code: 'Space', keyCode: 32, text: ' ' },
};

async function cmdPress(args, flags) {
  const key = args[0] || 'Enter';
  const def = KEYS[key] || { code: key, keyCode: 0 };
  await withCurrent(flags, async (cdp) => {
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key,
      code: def.code,
      windowsVirtualKeyCode: def.keyCode,
      nativeVirtualKeyCode: def.keyCode,
    });
    if (def.text) await cdp.send('Input.dispatchKeyEvent', { type: 'char', text: def.text, key });
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key,
      code: def.code,
      windowsVirtualKeyCode: def.keyCode,
      nativeVirtualKeyCode: def.keyCode,
    });
    await sleep(num(flags.wait, 800));
    console.log(JSON.stringify({ pressed: key, url: await cdp.evaluate('location.href') }, null, 2));
  });
}

async function cmdScroll(args, flags) {
  await withCurrent(flags, async (cdp) => {
    const sel = typeof flags.sel === 'string' ? flags.sel : null;
    const to = typeof flags.to === 'string' ? flags.to : null;
    const by = flags.by !== undefined ? num(flags.by, 800) : null;
    const res = await cdp.evaluate(`(() => {
      ${sel ? `const el = document.querySelector(${JSON.stringify(sel)}); if (el) el.scrollIntoView({block:'center',behavior:'instant'});` : ''}
      ${to === 'bottom' ? 'window.scrollTo(0, document.body.scrollHeight);' : ''}
      ${to === 'top' ? 'window.scrollTo(0, 0);' : ''}
      ${by !== null && !to && !sel ? `window.scrollBy(0, ${by});` : ''}
      return {
        y: Math.round(window.scrollY),
        maxY: Math.round(document.body.scrollHeight - window.innerHeight),
        height: document.body.scrollHeight,
        text: document.body.innerText.length,
      };
    })()`);
    await sleep(num(flags.wait, 600));
    console.log(JSON.stringify(res, null, 2));
  });
}

async function cmdShot(args, flags) {
  const file = args[0] || `shots/shot-${Date.now()}.png`;
  await withCurrent(flags, async (cdp) => {
    // --print emulates the print stylesheet, so you can verify @media print / @page rules
    // without opening the print dialog.
    if (flags.print) {
      await cdp.send('Emulation.setEmulatedMedia', { media: 'print' });
      await sleep(300);
    }
    try {
      const params = { format: 'png', captureBeyondViewport: !flags.viewport };
      const res = await cdp.send('Page.captureScreenshot', params, 45000);
      const buf = Buffer.from(res.data, 'base64');
      const abs = writeOut(file, buf);
      console.log(JSON.stringify({ saved: abs, bytes: buf.length, media: flags.print ? 'print' : 'screen' }, null, 2));
    } finally {
      if (flags.print) await cdp.send('Emulation.setEmulatedMedia', { media: '' }).catch(() => {});
    }
  });
}

/** Render the current page to PDF. With no flags it follows the page's own @page rules. */
async function cmdPdf(args, flags) {
  const file = args[0] || `out/page-${Date.now()}.pdf`;
  await withCurrent(flags, async (cdp) => {
    const params = {
      printBackground: !flags['no-background'],
      preferCSSPageSize: !flags.a4,      // respect @page when the page defines it
      marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0,
    };
    if (flags.a4) {
      params.paperWidth = 8.27;
      params.paperHeight = 11.69;
      params.landscape = !!flags.landscape;
    }
    const res = await cdp.send('Page.printToPDF', params, 90000);
    const buf = Buffer.from(res.data, 'base64');
    const abs = writeOut(file, buf);
    // Count pages by scanning the page tree objects (good enough for a sanity check).
    const text = buf.toString('latin1');
    const pages = (text.match(/\/Type\s*\/Page[^s]/g) || []).length;
    console.log(JSON.stringify({ saved: abs, bytes: buf.length, pages, cssPageSize: !flags.a4 }, null, 2));
  });
}

async function cmdEval(args, flags) {
  const code = args.join(' ');
  if (!code) throw new Error('eval requires JavaScript');
  await withCurrent(flags, async (cdp) => {
    const v = await cdp.evaluate(`(() => { return (${code}); })()`);
    console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
  });
}

async function cmdHistory(args, flags) {
  const dir = args[0];
  await withCurrent(flags, async (cdp) => {
    const loadP = cdp.waitFor('Page.loadEventFired', 8000);
    await cdp.evaluate(dir === 'forward' ? 'history.forward()' : 'history.back()');
    await loadP;
    await sleep(num(flags.wait, 1200));
    console.log(JSON.stringify({ url: await cdp.evaluate('location.href'), title: await cdp.evaluate('document.title') }, null, 2));
  });
}

async function cmdUse(args) {
  const key = args[0];
  if (key === undefined) throw new Error('use requires a tab index or id prefix (see: browse.mjs tabs)');
  const targets = await listTargets();
  const target = /^\d+$/.test(key)
    ? targets[Number(key)]
    : targets.find((t) => t.id === key || t.id.startsWith(key));
  if (!target) throw new Error(`no such tab: ${key} (run: node browse.mjs tabs)`);
  saveState({ currentTargetId: target.id });
  console.log(JSON.stringify({ current: target.id, url: target.url, title: target.title }, null, 2));
}

async function cmdTabs() {
  const targets = await listTargets();
  const { currentTargetId } = loadState();
  console.log(
    JSON.stringify(
      targets.map((t) => ({ current: t.id === currentTargetId, id: t.id, title: t.title, url: t.url })),
      null,
      2,
    ),
  );
}

async function cmdCookies(args) {
  const domain = args[0] || '';
  await ensureChrome({ headed: false });
  const { cdp } = await attachCurrent();
  try {
    await cdp.send('Network.enable');
    const res = await cdp.send('Network.getCookies', domain ? { urls: [`https://${domain.replace(/^https?:\/\//, '')}`] } : {});
    const list = (res.cookies || []).map((c) => ({ name: c.name, domain: c.domain, path: c.path, secure: c.secure, expires: c.expires }));
    console.log(JSON.stringify({ count: list.length, cookies: list }, null, 2));
  } finally {
    cdp.close();
  }
}

async function cmdStatus() {
  const v = await version();
  const state = loadState();
  const targets = v ? await listTargets() : [];
  const current = state.currentTargetId ? targets.find((t) => t.id === state.currentTargetId) : null;
  console.log(
    JSON.stringify(
      {
        chromeRunning: !!v,
        browser: v?.Browser || null,
        port: 9222,
        headed: !!state.headed,
        tabs: targets.length,
        current: current ? { id: current.id, url: current.url, title: current.title } : null,
        stateDir: STATE_DIR,
      },
      null,
      2,
    ),
  );
}

async function cmdStop() {
  await stopChrome();
  console.log(JSON.stringify({ stopped: !(await isRunning()) }, null, 2));
}

async function cmdLogin(args, flags) {
  const url = args[0] || 'https://www.zhihu.com/signin';
  // Login genuinely needs a visible window, so this is the one place that forces a mode switch.
  await ensureChrome({ headed: true, enforceMode: true });
  const { target } = await ensureTarget({ force: true, url: 'about:blank' });
  const cdp = await CDP.attach(target.webSocketDebuggerUrl);
  try {
    await prepare(cdp, flags);
    await navigate(cdp, url, { waitMs: 800, timeoutMs: 30000 });
    console.log(
      [
        'A visible Chrome window is open (profile: ' + STATE_DIR + '/profile).',
        'Log in there by hand. Cookies stay in that profile and will be reused by',
        'headless `open` calls (use --headed there too if a site requires an interactive check).',
        'When done, run: node browse.mjs stop',
      ].join('\n'),
    );
  } finally {
    cdp.close();
  }
}

async function main() {
  const { flags, pos } = parseArgs(process.argv.slice(2));
  const [cmd, ...args] = pos;
  if (!cmd || flags.help || cmd === 'help') {
    console.log(USAGE);
    return;
  }
  switch (cmd) {
    case 'open':
      return cmdOpen(args, flags);
    case 'read':
      return cmdRead(args, flags);
    case 'links':
      return cmdLinks(args, flags);
    case 'source':
    case 'view-source':
      return cmdSource(args, flags);
    case 'html':
    case 'dom-html':
      return cmdHtml(args, flags);
    case 'dom':
    case 'elements':
      return cmdDom(args, flags);
    case 'outline':
    case 'tree':
      return cmdOutline(args, flags);
    case 'net':
    case 'network':
      return cmdNet(args, flags);
    case 'click':
      return cmdClick(args, flags);
    case 'type':
      return cmdType(args, flags);
    case 'press':
      return cmdPress(args, flags);
    case 'scroll':
      return cmdScroll(args, flags);
    case 'shot':
    case 'screenshot':
      return cmdShot(args, flags);
    case 'pdf':
    case 'print-pdf':
      return cmdPdf(args, flags);
    case 'eval':
      return cmdEval(args, flags);
    case 'back':
    case 'forward':
      return cmdHistory([cmd], flags);
    case 'tabs':
      return cmdTabs();
    case 'use':
    case 'focus':
      return cmdUse(args, flags);
    case 'cookies':
      return cmdCookies(args, flags);
    case 'status':
      return cmdStatus();
    case 'stop':
      return cmdStop();
    case 'login':
      return cmdLogin(args, flags);
    case 'close': {
      const { currentTargetId } = loadState();
      if (currentTargetId) await closeTarget(currentTargetId);
      // Don't leave the session pointing at a dead target.
      const rest = await listTargets();
      saveState({ currentTargetId: rest[0]?.id || null });
      console.log(
        JSON.stringify(
          {
            closed: currentTargetId || null,
            nowCurrent: rest[0] ? { id: rest[0].id, url: rest[0].url, title: rest[0].title } : null,
          },
          null,
          2,
        ),
      );
      return;
    }
    default:
      console.log(USAGE);
      throw new Error(`unknown command: ${cmd}`);
  }
}

// Chrome's CDP websocket and the per-request timers can keep the event loop alive after the
// work is done, which makes the CLI appear to hang. Flush stdout, then exit deliberately.
async function flushAndExit(code) {
  try {
    await new Promise((resolve) => process.stdout.write('', resolve));
  } catch {
    /* ignore */
  }
  process.exit(code);
}

main()
  .then(() => flushAndExit(0))
  .catch(async (err) => {
    console.error(`ERROR: ${err.message}`);
    await flushAndExit(1);
  });
