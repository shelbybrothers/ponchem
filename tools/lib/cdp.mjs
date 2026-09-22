// tools/lib/cdp.mjs: headless Chrome over the DevTools protocol, no dependencies (node >= 22: global WebSocket).
//
//   const chrome = await launchChrome({ port: 9391 })      // attaches when something already listens on the port
//   const page = await openPage({ port: 9391, width: 390, height: 844, touch: true, reducedMotion: false })
//   await page.goto('http://127.0.0.1:6059/pricing')      // -> { status, url }
//   await page.eval(() => document.title)                  // function (serialised) or expression string
//   await page.emulate({ width: 1440, height: 900 })
//   await page.screenshot('/tmp/x.png', { fullPage: true })
//   page.errors   // console errors, uncaught exceptions, failed loads: [{ kind, text, url }]
//   page.warnings // console warnings
//   page.requests // Map<requestId, { url, type, status, bytes, failed, errorText, method }>
//   await page.close(); await chrome.close()             // close() only kills a Chrome this process started
//
// The Claude Browser pane runs pages hidden (no rAF, scroll or IntersectionObserver). Headless Chrome
// targets are visible, so scroll-driven UI really runs here.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CHROME_BIN = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function json(url, init) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

export async function chromeVersion(port) {
  try { return await json(`http://127.0.0.1:${port}/json/version`); } catch { return null; }
}

// Start headless Chrome on `port`, or attach when the port already answers.
export async function launchChrome({ port = 9391, profile, headless = true, userAgent, extraArgs = [] } = {}) {
  const existing = await chromeVersion(port);
  if (existing) return { port, launched: false, version: existing.Browser, async close() {} };
  const dir = profile || path.join(os.tmpdir(), `ponchem-qa-chrome-${port}`);
  fs.mkdirSync(dir, { recursive: true });
  const args = [
    ...(headless ? ['--headless=new'] : []),
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-extensions',
    '--mute-audio',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    `--user-data-dir=${dir}`,
    ...(userAgent ? [`--user-agent=${userAgent}`] : []),
    ...extraArgs,
    'about:blank',
  ];
  const proc = spawn(CHROME_BIN, args, { stdio: ['ignore', 'ignore', 'ignore'], detached: false });
  let exited = false;
  proc.on('exit', () => { exited = true; });
  for (let i = 0; i < 100; i++) {
    const v = await chromeVersion(port);
    if (v) {
      const close = async () => {
        if (exited) return;
        proc.kill('SIGTERM');
        for (let j = 0; j < 30 && !exited; j++) await sleep(100);
        if (!exited) proc.kill('SIGKILL');
      };
      process.once('exit', () => { if (!exited) try { proc.kill('SIGKILL'); } catch { /* gone */ } });
      return { port, launched: true, version: v.Browser, proc, close };
    }
    if (exited) break;
    await sleep(150);
  }
  try { proc.kill('SIGKILL'); } catch { /* gone */ }
  throw new Error(`Chrome did not start on port ${port} (${CHROME_BIN})`);
}

// Serialise a function call for Runtime.evaluate: fn(...args) with JSON arguments.
export function expr(fnOrString, ...args) {
  if (typeof fnOrString === 'string') return fnOrString;
  return `(${fnOrString.toString()})(${args.map((a) => JSON.stringify(a === undefined ? null : a)).join(',')})`;
}

export async function openPage({
  port = 9391, width = 1440, height = 900, mobile, touch, reducedMotion = false, dpr = 1, cacheDisabled = false,
  timeout = 45000,
} = {}) {
  const target = await json(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let nextId = 0;
  const pending = new Map();
  const listeners = new Map();
  let closed = false;

  ws.onmessage = (event) => {
    const m = JSON.parse(typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString());
    if (m.id && pending.has(m.id)) {
      const { resolve, reject, timer, method } = pending.get(m.id);
      pending.delete(m.id);
      clearTimeout(timer);
      if (m.error) reject(new Error(`${method}: ${m.error.message}`));
      else resolve(m.result);
    } else if (m.method) {
      for (const fn of listeners.get(m.method) || []) fn(m.params);
      for (const fn of listeners.get('*') || []) fn(m.method, m.params);
    }
  };
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error(`cannot connect to target on port ${port}`));
  });
  ws.onclose = () => {
    closed = true;
    for (const { reject, timer, method } of pending.values()) { clearTimeout(timer); reject(new Error(`${method}: socket closed`)); }
    pending.clear();
  };

  const send = (method, params = {}, ms = timeout) => new Promise((resolve, reject) => {
    if (closed) { reject(new Error(`${method}: socket closed`)); return; }
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method}: timed out after ${ms} ms`)); }, ms);
    pending.set(id, { resolve, reject, timer, method });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const on = (method, fn) => {
    if (!listeners.has(method)) listeners.set(method, []);
    listeners.get(method).push(fn);
    return () => listeners.set(method, (listeners.get(method) || []).filter((f) => f !== fn));
  };

  const errors = [];
  const warnings = [];
  const requests = new Map();
  let documentStatus = null;
  const argText = (a) => (a.value !== undefined ? (typeof a.value === 'string' ? a.value : JSON.stringify(a.value)) : a.description || a.type || '');

  on('Runtime.exceptionThrown', (p) => {
    const d = p.exceptionDetails || {};
    errors.push({ kind: 'exception', text: (d.exception?.description || d.text || '').split('\n').slice(0, 3).join(' | '), url: d.url || '' });
  });
  on('Runtime.consoleAPICalled', (p) => {
    const text = (p.args || []).map(argText).join(' ');
    const url = p.stackTrace?.callFrames?.[0]?.url || '';
    if (p.type === 'error' || p.type === 'assert') errors.push({ kind: `console.${p.type}`, text, url });
    else if (p.type === 'warning') warnings.push({ kind: 'console.warn', text, url });
  });
  on('Log.entryAdded', (p) => {
    const e = p.entry || {};
    if (e.level === 'error') errors.push({ kind: `log.${e.source}`, text: e.text, url: e.url || '' });
    else if (e.level === 'warning') warnings.push({ kind: `log.${e.source}`, text: e.text, url: e.url || '' });
  });
  on('Network.requestWillBeSent', (p) => {
    requests.set(p.requestId, { url: p.request.url, method: p.request.method, type: p.type, status: null, bytes: 0, failed: false, errorText: '', t: p.timestamp });
  });
  on('Network.responseReceived', (p) => {
    const r = requests.get(p.requestId);
    if (r) { r.status = p.response.status; r.mime = p.response.mimeType; r.type = p.type || r.type; r.fromCache = p.response.fromDiskCache || p.response.fromServiceWorker; }
    if (p.type === 'Document' && documentStatus === null) documentStatus = p.response.status;
  });
  on('Network.loadingFinished', (p) => {
    const r = requests.get(p.requestId);
    if (r) { r.bytes = p.encodedDataLength; r.done = true; }
  });
  on('Network.loadingFailed', (p) => {
    const r = requests.get(p.requestId);
    if (r) { r.failed = true; r.errorText = p.errorText; r.canceled = !!p.canceled; r.blocked = p.blockedReason || ''; }
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Network.enable');
  if (cacheDisabled) await send('Network.setCacheDisabled', { cacheDisabled: true });
  // keep timers and rAF running even when several targets are open
  await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});

  const evaluate = async (fnOrString, ...args) => {
    const r = await send('Runtime.evaluate', { expression: expr(fnOrString, ...args), awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(`evaluate: ${(d.exception?.description || d.text || 'error').split('\n').slice(0, 4).join(' | ')}`);
    }
    return r.result?.value;
  };

  const page = {
    target, send, on, errors, warnings, requests,
    get status() { return documentStatus; },
    eval: evaluate,

    async emulate({ width: w, height: h, mobile: mob, touch: tch, reducedMotion: rm, dpr: scale } = {}) {
      const W = w ?? page.width;
      const H = h ?? page.height;
      const M = mob ?? W < 768;
      const T = tch ?? W <= 768;
      page.width = W; page.height = H; page.mobile = M; page.touch = T;
      await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: scale ?? dpr, mobile: M });
      await send('Emulation.setTouchEmulationEnabled', T ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
      const features = [{ name: 'prefers-reduced-motion', value: (rm ?? page.reducedMotion) ? 'reduce' : 'no-preference' }];
      if (rm !== undefined) page.reducedMotion = rm;
      await send('Emulation.setEmulatedMedia', { features }).catch(() => {});
      // pointer and hover follow touch (older Chrome builds ignore these names)
      await send('Emulation.setEmulatedMedia', {
        features: [...features,
          { name: 'pointer', value: T ? 'coarse' : 'fine' }, { name: 'hover', value: T ? 'none' : 'hover' },
          { name: 'any-pointer', value: T ? 'coarse' : 'fine' }, { name: 'any-hover', value: T ? 'none' : 'hover' }],
      }).catch(() => {});
    },

    // Navigate and wait for load, fonts and a short settle. Returns { status, url }.
    async goto(url, { settle = 300, waitMs = timeout } = {}) {
      documentStatus = null;
      const loaded = new Promise((resolve) => {
        const off = on('Page.loadEventFired', () => { off(); resolve(); });
        setTimeout(resolve, waitMs);
      });
      const nav = await send('Page.navigate', { url });
      if (nav.errorText) throw new Error(`navigate ${url}: ${nav.errorText}`);
      await loaded;
      await evaluate('document.fonts ? document.fonts.ready.then(() => true) : true').catch(() => {});
      await sleep(settle);
      return { status: documentStatus, url };
    },

    // Walk the page top to bottom (lazy images, reveal observers, first-scroll motion), then back to the top.
    async scrollThrough({ stepRatio = 0.75, pause = 70, end = 400 } = {}) {
      await evaluate(async (ratio, wait, endWait) => {
        const pauseFor = (ms) => new Promise((r) => setTimeout(r, ms));
        const to = (y) => window.scrollTo({ top: y, left: 0, behavior: 'instant' });
        let y = 0;
        for (let i = 0; i < 400; i++) {
          const max = document.documentElement.scrollHeight - innerHeight;
          if (y >= max) break;
          y = Math.min(max, y + Math.max(200, Math.round(innerHeight * ratio)));
          to(y);
          await pauseFor(wait);
        }
        await pauseFor(endWait);
        to(0);
        return true;
      }, stepRatio, pause, end);
    },

    async waitForImages(ms = 8000) {
      return evaluate(async (limit) => {
        const pending = [...document.images].filter((i) => !i.complete && i.loading !== 'lazy');
        const lazy = [...document.images].filter((i) => !i.complete && i.loading === 'lazy');
        await Promise.race([
          Promise.all([...pending, ...lazy].map((i) => new Promise((r) => { i.addEventListener('load', r, { once: true }); i.addEventListener('error', r, { once: true }); }))),
          new Promise((r) => setTimeout(r, limit)),
        ]);
        return [...document.images].filter((i) => !i.complete).length;
      }, ms);
    },

    async screenshot(file, { fullPage = false, clip, format, quality = 80 } = {}) {
      const fmt = format || (file.endsWith('.png') ? 'png' : 'jpeg');
      const params = { format: fmt, ...(fmt === 'png' ? {} : { quality }) };
      if (clip) params.clip = { scale: 1, ...clip };
      if (fullPage) {
        const size = await evaluate(() => ({ w: document.documentElement.clientWidth, h: document.documentElement.scrollHeight }));
        params.clip = { x: 0, y: 0, width: size.w, height: size.h, scale: 1 };
        params.captureBeyondViewport = true;
      }
      const r = await send('Page.captureScreenshot', params, 120000);
      if (file) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
      }
      return r.data;
    },

    async close() {
      if (!closed) try { ws.close(); } catch { /* closed */ }
      await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => {});
    },
  };

  page.width = width; page.height = height; page.reducedMotion = reducedMotion;
  await page.emulate({ width, height, mobile, touch, reducedMotion });
  return page;
}

// Run `fn(item, index)` over items with at most `jobs` at a time; results keep the input order.
export async function pool(items, jobs, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(jobs, items.length)) }, worker));
  return out;
}
