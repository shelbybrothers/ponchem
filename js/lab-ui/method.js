/*
 * js/lab-ui/method.js: the docking method panel of the lab (SPEC.md 9.7). A method is the JSON object that
 * configures the pose SEARCH (budget, chains, temperature, moves, local steps, placement, flexibility, candidates,
 * lattice, seed); the chain's scoring function is fixed. The engine owns the schema and the presets
 * (js/engine/method.js: METHOD_PRESETS, validateMethod, methodToCompact, methodToQuery, methodFromQuery); this
 * file only wraps that module behind one small API and paints the panel:
 *
 *   createMethodApi(engineMethodModule | null) -> api | null
 *     api.presets              [{ key, name, method }]          engine presets, in the engine's order
 *     api.presetForDepth(key)  the Quick / Standard / Deep preset behind the depth control (or null)
 *     api.validate(text | object) -> { ok, raw, method (resolved), errors: string[], compact, bytes }
 *     api.compact(method) -> string      api.toQuery(method) -> base64url      api.fromQuery(str) -> validate result
 *   createMethodPanel({ api, onChange(state), onShare() }) -> { el, state(), setPreset(key), setSaved(name),
 *        setJsonText(text), loadObject(obj, { key }), applyQuery(str), refreshSaved() }
 *     state: { key: 'quick' | ... | 'saved:<name>' | 'custom', name, raw, method, compact, bytes, valid, errors }
 *   loadSaved() / saveMethod(name, method) / removeMethod(name)    localStorage 'ponchem.methods'
 *   toBase64Url(text) / fromBase64Url(str)
 *
 * Method JSON, presets and saved methods are untrusted text: everything is painted with el() and textContent,
 * never innerHTML. When the engine module is absent the panel shows the engine-unavailable line and nothing else.
 */
import { el, toast } from '../shell.js';
import { icon } from './icons.js';
import { S, fill } from './strings.js';

export const STORAGE_KEY = 'ponchem.methods';
export const MAX_COMPACT_BYTES = 1024;
const DEPTH_NAMES = { quick: /^quick$/i, standard: /^standard$/i, deep: /^deep$/i };

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => JSON.parse(JSON.stringify(v));
const bytesOf = (s) => new TextEncoder().encode(String(s)).length;
const slug = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'method';
const cleanText = (s) => String(s || '').replace(/[\u2012-\u2015]/g, ',').replace(/\s+/g, ' ').trim();
const pretty = (obj) => JSON.stringify(obj, null, 2);

export function toBase64Url(text) {
  const bytes = new TextEncoder().encode(String(text));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(s) {
  const b64 = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
  const bin = atob(b64 + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// ---------------------------------------------------------------------------------------------------------
// the engine module, normalised

function normalizePresets(raw) {
  const out = [];
  const push = (key, name, method) => {
    if (!isObj(method)) return;
    const m = clone(method);
    delete m.key;
    const n = String(name || m.name || key || '').trim();
    if (!n) return;
    if (!m.name) m.name = n;
    out.push({ key: slug(key || n), name: n, method: m });
  };
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!isObj(item)) continue;
      if (isObj(item.method)) push(item.key || item.id, item.name || item.method.name, item.method);
      else push(item.key || item.id, item.name, item);
    }
  } else if (isObj(raw)) {
    for (const [k, v] of Object.entries(raw)) {
      if (!isObj(v)) continue;
      if (isObj(v.method)) push(k, v.name || v.method.name, v.method); else push(k, v.name || k, v);
    }
  }
  return out;
}

const errorText = (e) => {
  if (typeof e === 'string') return cleanText(e);
  if (e && typeof e === 'object') {
    const msg = e.message || e.error || e.reason || e.text;
    const where = e.path || e.key || e.field;
    if (msg) return cleanText(where && !String(msg).includes(String(where)) ? `${where}: ${msg}` : msg);
  }
  return cleanText(String(e));
};

export function createMethodApi(mod) {
  if (!mod || typeof mod.validateMethod !== 'function') return null;
  const presets = normalizePresets(mod.METHOD_PRESETS);
  if (!presets.length) return null;

  const compact = (method) => {
    if (typeof mod.methodToCompact === 'function') {
      try { const s = mod.methodToCompact(method); if (typeof s === 'string' && s) return s; } catch { /* fall through */ }
    }
    return JSON.stringify(method);
  };

  function validate(input) {
    let raw = input;
    if (typeof input === 'string') {
      try { raw = JSON.parse(input); } catch (e) {
        return { ok: false, raw: null, method: null, errors: [fill(S.methodInvalidJson, { detail: cleanText((e && e.message) || 'parse error') })], compact: '', bytes: 0 };
      }
    }
    if (!isObj(raw)) return { ok: false, raw: null, method: null, errors: [S.methodNotObject], compact: '', bytes: 0 };
    let r;
    try { r = mod.validateMethod(clone(raw)); } catch (e) { r = { ok: false, method: null, errors: [errorText(e)] }; }
    const ok = !!(r && r.ok !== false && (r.method || r.ok === true));
    const errors = (r && Array.isArray(r.errors) ? r.errors : r && r.error ? [r.error] : []).map(errorText).filter(Boolean);
    if (!ok) return { ok: false, raw, method: null, errors: errors.length ? errors : ['The engine refused this method.'], compact: '', bytes: 0 };
    const method = isObj(r.method) ? r.method : clone(raw);
    const c = compact(method);
    const bytes = bytesOf(c);
    if (bytes > MAX_COMPACT_BYTES) return { ok: false, raw, method: null, errors: [fill(S.methodTooLong, { bytes })], compact: c, bytes };
    return { ok: true, raw, method, errors: [], compact: c, bytes };
  }

  const toQuery = (method) => {
    if (typeof mod.methodToQuery === 'function') {
      try { const s = mod.methodToQuery(method); if (typeof s === 'string' && s) return s; } catch { /* fall through */ }
    }
    return toBase64Url(JSON.stringify(method));
  };

  function fromQuery(str) {
    // SPEC 9.7: ?method=<base64url of the JSON>. Decode it here so the editor keeps the author's own text; the
    // engine's own decoder is the fallback for any other encoding it may choose.
    try {
      const text = fromBase64Url(str);
      const v = validate(text);
      return { ...v, text };
    } catch { /* not our encoding */ }
    if (typeof mod.methodFromQuery === 'function') {
      try {
        const r = mod.methodFromQuery(str);
        if (r && typeof r === 'object' && 'ok' in r) {
          if (!r.ok) return { ok: false, raw: null, method: null, errors: (r.errors || []).map(errorText), compact: '', bytes: 0, text: '' };
          const v = validate(r.method || r.raw || {});
          return { ...v, text: pretty(v.raw || {}) };
        }
        if (isObj(r)) { const v = validate(r); return { ...v, text: pretty(v.raw || {}) }; }
      } catch { /* fall through */ }
    }
    return { ok: false, raw: null, method: null, errors: [S.methodBadLink], compact: '', bytes: 0, text: '' };
  }

  /** True when two methods (raw or resolved) resolve to the same compact JSON (the engine's methodEquals when it has one). */
  function equals(a, b) {
    if (!isObj(a) || !isObj(b)) return false;
    if (typeof mod.methodEquals === 'function') { try { return !!mod.methodEquals(a, b); } catch { /* compare below */ } }
    const va = validate(a);
    const vb = validate(b);
    return va.ok && vb.ok && va.compact === vb.compact;
  }

  const presetByKey = (key) => presets.find((p) => p.key === key) || null;
  const presetForDepth = (depthKey) => {
    const re = DEPTH_NAMES[depthKey];
    if (!re) return null;
    return presets.find((p) => p.key === depthKey) || presets.find((p) => re.test(p.name)) || null;
  };

  return { presets, presetByKey, presetForDepth, validate, compact, toQuery, fromQuery, equals, schema: mod.METHOD_SCHEMA || null };
}

// ---------------------------------------------------------------------------------------------------------
// my methods (localStorage)

export function loadSaved() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) return [];
    return list.filter((x) => isObj(x) && typeof x.name === 'string' && x.name.trim() && isObj(x.method)).map((x) => ({ name: x.name.trim(), method: x.method, savedAt: x.savedAt || null }));
  } catch { return []; }
}

function writeSaved(list) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); return true; } catch { return false; }
}

export function saveMethod(name, method) {
  const n = String(name || '').trim();
  if (!n || !isObj(method)) return false;
  const list = loadSaved().filter((x) => x.name !== n);
  list.push({ name: n, method: clone(method), savedAt: new Date().toISOString() });
  return writeSaved(list);
}

export function removeMethod(name) {
  const n = String(name || '').trim();
  return writeSaved(loadSaved().filter((x) => x.name !== n));
}

// ---------------------------------------------------------------------------------------------------------
// the panel

export function createMethodPanel({ api, onChange, onShare }) {
  const root = el('div', { class: 'lab-method', dataset: { methodPanel: '', state: api ? 'ready' : 'unavailable' } });

  if (!api) {
    root.append(el('p', { class: 'lab-method-unavailable', role: 'status', dataset: { methodUnavailable: '' } }, S.engineMissing));
    const empty = { key: 'none', name: '', raw: null, method: null, compact: '', bytes: 0, valid: true, errors: [], available: false };
    return { el: root, state: () => empty, setPreset: () => false, setSaved: () => false, setJsonText: () => false, loadObject: () => false, applyQuery: () => ({ ok: false, errors: [S.engineMissing] }), refreshSaved: () => {} };
  }

  let origin = null; // { key, name, method } the editor started from (a preset or a saved method)
  let state = { key: 'custom', name: '', raw: null, method: null, compact: '', bytes: 0, valid: false, errors: [], available: true };

  const select = el('select', { id: 'lab-method-preset', class: 'lab-select', dataset: { methodPreset: '' } });
  const presetGroup = el('optgroup', { label: S.methodPresets });
  for (const p of api.presets) presetGroup.append(el('option', { value: p.key }, p.name));
  const mineGroup = el('optgroup', { label: S.methodMine, hidden: true });
  const customOpt = el('option', { value: 'custom', hidden: true }, S.methodCustom);
  select.append(presetGroup, mineGroup, customOpt);

  const editor = el('textarea', { id: 'lab-method-json', class: 'lab-json lab-mono', dataset: { methodJson: '' }, rows: 12, spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', 'aria-describedby': 'lab-method-status' });
  const statusLine = el('p', { id: 'lab-method-status', class: 'lab-caption lab-mono lab-method-status', dataset: { methodStatus: '', valid: '0' }, 'aria-live': 'polite' });
  const errors = el('ul', { class: 'lab-method-errors', dataset: { methodErrors: '' }, hidden: true, role: 'alert' });

  const btn = (label, extra, onClick, cls = 'lab-btn lab-btn-ghost lab-btn-sm') => {
    const b = el('button', { type: 'button', class: cls, dataset: extra }, label);
    b.addEventListener('click', onClick);
    return b;
  };
  const resetBtn = btn(S.methodReset, { methodReset: '' }, () => reset(), 'lab-btn lab-btn-outline lab-btn-sm');
  const saveBtn = btn(S.methodSave, { methodSave: '' }, () => save(), 'lab-btn lab-btn-outline lab-btn-sm');
  const removeBtn = btn(S.methodRemove, { methodRemove: '' }, () => remove());
  removeBtn.hidden = true;
  const exportBtn = btn(S.methodExport, { methodExport: '' }, () => exportJson());
  const fileInput = el('input', { type: 'file', accept: '.json,application/json', hidden: true, dataset: { methodFile: '' }, 'aria-label': S.methodImport });
  const importBtn = btn(S.methodImport, { methodImport: '' }, () => fileInput.click());
  const shareBtn = btn([icon('share', { size: 16 }), S.methodShare], { methodShare: '' }, () => onShare && onShare(state));

  root.append(
    el('p', { class: 'lab-caption lab-method-note' }, [S.methodEditorNote, ' ', el('a', { class: 'lab-link', href: '/docs#methods' }, S.methodDocs)]),
    el('div', { class: 'lab-field' }, [el('label', { class: 'lab-label', for: 'lab-method-preset' }, S.methodPreset), select]),
    el('div', { class: 'lab-field' }, [el('label', { class: 'lab-label', for: 'lab-method-json' }, S.methodEditor), editor, statusLine, errors]),
    el('div', { class: 'lab-method-actions' }, [resetBtn, saveBtn, removeBtn, exportBtn, importBtn, shareBtn, fileInput]),
  );

  function paint() {
    statusLine.textContent = state.valid ? fill(S.methodValid, { bytes: state.bytes }) : '';
    statusLine.dataset.valid = state.valid ? '1' : '0';
    statusLine.hidden = !state.valid;
    errors.replaceChildren(...state.errors.map((e) => el('li', {}, e)));
    errors.hidden = !state.errors.length;
    editor.setAttribute('aria-invalid', state.valid ? 'false' : 'true');
    if (select.value !== state.key) select.value = state.key;
    removeBtn.hidden = !state.key.startsWith('saved:');
    resetBtn.disabled = !origin;
    root.dataset.valid = state.valid ? '1' : '0';
    root.dataset.key = state.key;
  }

  function evaluate(text, key) {
    const v = api.validate(text);
    let k = key;
    if (!k) {
      // an edit of a preset or a saved method becomes "custom" once the JSON no longer equals the origin
      k = origin && v.ok && api.equals(v.raw, origin.method) ? origin.key : 'custom';
    }
    const name = v.raw && typeof v.raw.name === 'string' && v.raw.name.trim() ? v.raw.name.trim() : origin && k === origin.key ? origin.name : S.methodCustom;
    state = { key: k, name, raw: v.raw, method: v.method, compact: v.compact, bytes: v.bytes, valid: v.ok, errors: v.errors, available: true };
    paint();
    if (onChange) onChange(state);
    return state;
  }

  function loadObject(obj, { key = 'custom', name = null } = {}) {
    if (!isObj(obj)) return false;
    origin = key === 'custom' ? null : { key, name: name || obj.name || key, method: clone(obj) };
    editor.value = pretty(obj);
    evaluate(editor.value, key);
    return true;
  }

  function setPreset(key) {
    const p = api.presetByKey(key) || api.presetForDepth(key);
    if (!p) return false;
    return loadObject(p.method, { key: p.key, name: p.name });
  }

  function setSaved(name) {
    const s = loadSaved().find((x) => x.name === name);
    if (!s) return false;
    return loadObject(s.method, { key: `saved:${s.name}`, name: s.name });
  }

  function setJsonText(text) {
    editor.value = String(text);
    evaluate(editor.value, null);
    return state.valid;
  }

  function reset() {
    if (!origin) return;
    editor.value = pretty(origin.method);
    evaluate(editor.value, origin.key);
    editor.focus();
  }

  function refreshSaved() {
    const list = loadSaved();
    mineGroup.replaceChildren(...list.map((s) => el('option', { value: `saved:${s.name}` }, s.name)));
    mineGroup.hidden = !list.length;
    if (select.value !== state.key) select.value = state.key;
  }

  function save() {
    if (!state.valid) { toast(state.errors[0] || S.methodFixFirst, { kind: 'error' }); return; }
    const name = state.raw && typeof state.raw.name === 'string' ? state.raw.name.trim() : '';
    if (!name) { toast(S.methodNameNeeded, { kind: 'error' }); return; }
    if (!saveMethod(name, state.raw)) { toast('Could not save the method in this browser.', { kind: 'error' }); return; }
    refreshSaved();
    loadObject(state.raw, { key: `saved:${name}`, name });
    toast(fill(S.methodSaved, { name }), { kind: 'success' });
  }

  function remove() {
    if (!state.key.startsWith('saved:')) return;
    removeMethod(state.key.slice(6));
    refreshSaved();
    toast(S.methodRemoved, { kind: 'info' });
    setPreset('standard') || setPreset(api.presets[0].key);
  }

  function exportJson() {
    const obj = state.raw || (origin && origin.method);
    if (!obj) { toast(S.methodFixFirst, { kind: 'error' }); return; }
    const text = pretty(obj);
    const name = `ponchem-method-${slug(state.name)}.json`;
    try {
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const a = el('a', { href: url, download: name, hidden: true });
      document.body.append(a);
      a.click();
      setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1000);
      toast(S.methodExported, { kind: 'success' });
    } catch {
      toast('Could not download the file.', { kind: 'error' });
    }
  }

  async function importFile(file) {
    if (!file) return;
    let text = '';
    try { text = await file.text(); } catch { toast(S.methodBadImport, { kind: 'error' }); return; }
    if (text.length > 64 * 1024) { toast(S.methodBadImport, { kind: 'error' }); return; }
    const v = api.validate(text);
    origin = null;
    editor.value = v.raw ? pretty(v.raw) : text;
    evaluate(editor.value, 'custom');
    if (v.ok) toast(fill(S.methodImported, { name: state.name }), { kind: 'success' });
    else toast(S.methodBadImport, { kind: 'error' });
  }

  function applyQuery(str) {
    const v = api.fromQuery(str);
    if (!v.ok) return { ok: false, errors: v.errors };
    // a shared method that equals a preset or a saved method keeps that name
    const preset = api.presets.find((p) => api.equals(p.method, v.raw));
    if (preset) { loadObject(preset.method, { key: preset.key, name: preset.name }); return { ok: true, errors: [] }; }
    const saved = loadSaved().find((s) => api.equals(s.method, v.raw));
    if (saved) { loadObject(saved.method, { key: `saved:${saved.name}`, name: saved.name }); return { ok: true, errors: [] }; }
    origin = null;
    editor.value = pretty(v.raw);
    evaluate(editor.value, 'custom');
    return { ok: true, errors: [] };
  }

  select.addEventListener('change', () => {
    const v = select.value;
    if (v.startsWith('saved:')) setSaved(v.slice(6));
    else if (v !== 'custom') setPreset(v);
  });
  editor.addEventListener('input', () => evaluate(editor.value, null));
  fileInput.addEventListener('change', () => { const f = fileInput.files && fileInput.files[0]; fileInput.value = ''; importFile(f); });

  refreshSaved();
  setPreset('standard') || setPreset(api.presets[0].key);

  return { el: root, state: () => state, setPreset, setSaved, setJsonText, loadObject, applyQuery, refreshSaved };
}
