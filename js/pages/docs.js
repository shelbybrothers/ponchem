// js/pages/docs.js: the docs page (contents highlighting, the five weights, network parameters, live fees and prices,
// the badge icons, the XP and level tables from the gamification module, the method schema and presets from the
// engine when it ships them). Also boots 404 and the /wallet forwarder (it only boots the shell there).
import { boot, weights, chain, el, F, CHAIN, PROTOCOL, TOKEN, isLive, gamify, methodMod, badgeTile } from './common.js';

boot();
const root = document.querySelector('[data-docs]');
if (root) {
  for (const n of document.querySelectorAll('[data-rpc-url]')) n.textContent = CHAIN.rpc;
  for (const n of document.querySelectorAll('[data-explorer-url]')) n.textContent = CHAIN.explorer;

  weights().then((w) => {
    w.forEach(([, value], i) => {
      const cell = document.querySelector(`[data-weight="${i}"]`);
      if (cell) cell.textContent = String(value);
    });
  });

  chain('labStatus').then((s) => {
    const p = document.querySelector('[data-fees]');
    const prices = document.querySelector('[data-prices]');
    if (!isLive(s)) return;
    const v = s.value;
    const days = Math.round(Number(v.epochLength || PROTOCOL.epochSeconds) / 86400);
    const fee = v.runFee !== undefined && v.runFee !== null ? F.eth(v.runFee, 6) : null;
    const price = v.runPrice !== undefined && v.runPrice !== null && BigInt(v.runPrice) > 0n ? `${F.units(v.runPrice, 18, 2)} $${TOKEN.symbol}` : null;
    if (p) p.textContent = `A docking test costs ${[price, fee].filter(Boolean).join(' or ') || 'the price shown in the lab'} plus gas, the lab fee is ${F.num(Number(v.feeBps ?? PROTOCOL.feeBps) / 100, { digits: 2 })} percent of a settled prize, and an epoch lasts ${days} days.`;
    if (prices) prices.textContent = `On chain now: ${price ? `${price} ` : `$${TOKEN.symbol} after the launch `}or ${fee || F.EMPTY}${v.tokenAllowed === false ? '; the token option is switched off' : ''}${v.ethAllowed === false ? '; the ETH option is switched off' : ''}.`;
  });

  // levels, XP rules and badges from the gamification module (the shared one when it ships, else the local rules)
  gamify().then((G) => {
    const rules = document.querySelector('[data-xp-rules] tbody');
    if (rules && G.XP_RULES.length) rules.replaceChildren(...G.XP_RULES.map((r) => el('tr', {}, [el('td', { class: 'pc-td-num' }, String(r.points)), el('td', {}, r.text)])));
    const levels = document.querySelector('[data-levels] tbody');
    if (levels && G.LEVELS.length) levels.replaceChildren(...G.LEVELS.map((l) => el('tr', {}, [el('td', {}, l.name), el('td', { class: 'pc-td-num' }, F.num(l.min))])));
    const host = document.querySelector('[data-badges-docs]');
    if (host) host.replaceChildren(...G.BADGES.map((b) => badgeTile(b, true)));
    const dl = document.querySelector('[data-badge-rules]');
    if (dl && G.BADGES.length) dl.replaceChildren(...G.BADGES.map((b) => el('div', {}, [el('dt', {}, b.name), el('dd', {}, b.rule || '')])));
  });

  // the method schema and presets from js/engine/method.js when it exists (SPEC 9.7); the static table stays otherwise
  methodMod().then((M) => {
    if (!M) return;
    const schema = M.METHOD_SCHEMA;
    const rows = flattenSchema(schema);
    const body = document.querySelector('[data-method-schema] tbody');
    if (body && rows.length) body.replaceChildren(...rows.map((r) => el('tr', {}, [el('td', { class: 'pc-td-mono' }, r.field), el('td', { class: 'pc-td-mono' }, r.values), el('td', { class: r.mono ? 'pc-td-mono' : null }, r.def), el('td', {}, r.doc)])));
    const presets = M.METHOD_PRESETS;
    const list = Array.isArray(presets) ? presets : presets && typeof presets === 'object' ? Object.entries(presets).map(([k, v]) => ({ name: (v && v.name) || k, ...(v || {}) })) : [];
    const pb = document.querySelector('[data-method-presets] tbody');
    if (pb && list.length) pb.replaceChildren(...list.map((p) => el('tr', {}, [el('td', {}, String(p.name || '')), el('td', { class: 'pc-td-mono pc-wrap-any' }, presetSummary(p))])));
  });

  const jump = document.querySelector('[data-jump]');
  if (jump) jump.addEventListener('change', (e) => { const t = document.querySelector(e.target.value); if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' }); });

  const links = [...document.querySelectorAll('[data-toc] a')];
  const heads = links.map((a) => document.querySelector(a.getAttribute('href'))).filter(Boolean);
  const mark = () => {
    const y = window.scrollY + 120;
    let current = heads[0];
    for (const h of heads) if (h.offsetTop <= y) current = h;
    for (const a of links) a.toggleAttribute('aria-current', current && a.getAttribute('href') === `#${current.id}`);
    for (const a of links) if (a.hasAttribute('aria-current')) a.setAttribute('aria-current', 'true');
  };
  window.addEventListener('scroll', mark, { passive: true });
  mark();
}

/** Rows from METHOD_SCHEMA: the engine's { fields: [{ key, type, min, max, default, defaultText, unit, meaning, values, oneOf, fields }] }, or a { key: spec } object. */
function flattenSchema(schema, prefix = '') {
  const out = [];
  if (!schema || typeof schema !== 'object') return out;
  const list = Array.isArray(schema.fields) ? schema.fields : Array.isArray(schema) ? schema : Object.entries(schema.properties || schema).filter(([, v]) => v && typeof v === 'object').map(([key, v]) => ({ key, ...v }));
  for (const f of list) {
    if (!f || typeof f.key !== 'string') continue;
    const field = prefix ? `${prefix}.${f.key}` : f.key;
    const nested = Array.isArray(f.fields) ? f.fields : f.properties && typeof f.properties === 'object' ? Object.entries(f.properties).map(([key, v]) => ({ key, ...v })) : null;
    if (nested && (Array.isArray(f.oneOf) || Array.isArray(f.anyOf))) {
      out.push({ field, values: nested.map((n) => `{ ${n.key}: ${rangeOf(n)} }`).join(' or '), def: fmtDefault(f), mono: true, doc: docOf(f) });
      continue;
    }
    if (nested) { out.push(...flattenSchema({ fields: nested }, field)); continue; }
    out.push({ field, values: rangeOf(f), def: fmtDefault(f), mono: f.default !== undefined && f.default !== null && typeof f.default !== 'string', doc: docOf(f) });
  }
  return out;
}
const docOf = (f) => String(f.meaning || f.doc || f.description || f.help || '');
function rangeOf(v) {
  if (!v || typeof v !== 'object') return String(v ?? '');
  const en = v.values || v.enum;
  if (Array.isArray(en)) return en.map(String).join(' or ');
  const lo = v.min ?? v.minimum ?? (Array.isArray(v.range) ? v.range[0] : undefined);
  const hi = v.max ?? v.maximum ?? (Array.isArray(v.range) ? v.range[1] : undefined);
  const unit = v.unit ? ` ${v.unit}` : '';
  if (v.type === 'string') return lo !== undefined && hi !== undefined ? `text, ${lo} to ${hi} characters` : 'text';
  if (lo !== undefined && hi !== undefined) return `${lo} to ${hi}${unit}`;
  if (v.type === 'boolean') return 'true or false';
  return String(v.type || '');
}
function fmtDefault(f) {
  if (f.defaultText) return String(f.defaultText);
  const d = f.default;
  if (d === undefined) return 'none';
  if (d === null) return f.optional ? 'none' : 'filled by the lab';
  if (typeof d === 'object') return JSON.stringify(d).replace(/"/g, '').replace(/,/g, ', ').replace(/:/g, ': ');
  return String(d);
}
function presetSummary(p) {
  const parts = [];
  if (p.budget && typeof p.budget === 'object') parts.push(p.budget.steps !== undefined ? `steps ${p.budget.steps}` : `${Math.round(Number(p.budget.ms) / 1000)} s`);
  for (const k of ['chains', 'temperature', 'placement', 'flexible', 'candidates', 'lattice']) if (p[k] !== undefined) parts.push(`${k} ${p[k]}`);
  if (p.moves && typeof p.moves === 'object') parts.push(`moves ${Object.entries(p.moves).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  if (p.local && typeof p.local === 'object' && p.local.steps !== undefined) parts.push(`local ${p.local.steps}`);
  return parts.join(' · ') || (p.doc || p.description || '');
}
