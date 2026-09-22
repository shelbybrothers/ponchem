/*
 * js/engine/method.js: the docking method (SPEC.md 9.7). A method is a plain JSON object that steers the float
 * pose search; the chain's scoring function is not part of it. Everything here is data plus pure functions.
 *
 *   METHOD_SCHEMA                      the published schema: fields, types, bounds, defaults, one sentence each (for /docs)
 *   METHOD_PRESETS                     Quick, Standard, Deep, Rigid ligand, Wide search, Fine local, Reproducible (full method objects)
 *   METHOD_DEFAULTS                    the resolved default method (equals the Standard preset)
 *   validateMethod(json)               -> { ok, method, errors }   json: object or JSON text; method resolved with every default;
 *                                         errors: plain sentences that name the key or the bound (empty when ok)
 *   resolveMethod(partial)             -> the resolved method (throws on the first error)
 *   methodToCompact(method)            -> canonical compact JSON (sorted keys, no whitespace): the on-chain string and its keccak
 *   methodToQuery(method)              -> base64url of the compact JSON (the ?method= share link)
 *   methodFromQuery(text)              -> validateMethod result (errors when the text does not decode)
 *   methodEquals(a, b)                 -> true when the two resolve to the same compact JSON
 *   presetByName(name)                 -> the preset or null
 *
 * Absent keys take their defaults. `chains` and `seed` are the two keys that may stay absent after resolution:
 * chains absent means "from the budget" (the engine picks the count from the step estimate and Nrot), seed absent
 * means the caller (the lab) chooses one. Unknown keys are rejected with the key named; out-of-range values are
 * rejected with the bound named. Every error sentence obeys the copy rules (no dashes, no emoji).
 */

export const METHOD_VERSION = 1;
export const METHOD_MAX_BYTES = 1024;
export const METHOD_NAME_MAX = 40;

const BUDGET_MS = { min: 1000, max: 600000 };
const BUDGET_STEPS = { min: 60, max: 5000000 };
const CHAINS = { min: 1, max: 32 };
const TEMPERATURE = { min: 0.1, max: 5 };
const TRANSLATE = { min: 0.05, max: 5 };
const ROTATE = { min: 1, max: 180 };
const TORSION = { min: 1, max: 180 };
const LOCAL_STEPS = { min: 0, max: 300 };
const CANDIDATES = { min: 1, max: 16 };
const SEED = { min: 0, max: 4294967295 };
const PLACEMENTS = ['box', 'center'];

/** The published schema (plain data, JSON-serialisable; the docs page renders it). */
export const METHOD_SCHEMA = Object.freeze({
  version: METHOD_VERSION,
  maxBytes: METHOD_MAX_BYTES,
  fields: [
    { key: 'name', type: 'string', min: 1, max: METHOD_NAME_MAX, default: 'Custom',
      meaning: 'The label the lab and the test page show for this method.' },
    { key: 'version', type: 'integer', min: METHOD_VERSION, max: METHOD_VERSION, default: METHOD_VERSION,
      meaning: 'The schema version; only 1 exists.' },
    { key: 'budget', type: 'object', oneOf: ['ms', 'steps'], default: { ms: 30000 },
      meaning: 'How long the pose search runs: a wall clock budget in milliseconds, or an exact step count, which is the reproducible form.',
      fields: [
        { key: 'ms', type: 'integer', min: BUDGET_MS.min, max: BUDGET_MS.max, unit: 'ms',
          meaning: 'Wall clock time for the search; the step count then depends on the machine and is recorded in the result.' },
        { key: 'steps', type: 'integer', min: BUDGET_STEPS.min, max: BUDGET_STEPS.max, unit: 'steps',
          meaning: 'An exact number of Monte Carlo steps; the same seed and steps give the same pose on any machine.' },
      ] },
    { key: 'chains', type: 'integer', min: CHAINS.min, max: CHAINS.max, default: null, defaultText: 'from the budget',
      meaning: 'Independent restarts that take turns step by step; absent, the engine picks 4 to 16 from the step count and the rotor count.' },
    { key: 'temperature', type: 'number', min: TEMPERATURE.min, max: TEMPERATURE.max, unit: 'kcal/mol', default: 1.2,
      meaning: 'Metropolis kT: how readily a move to a worse pose is accepted; higher explores more, lower settles faster.' },
    { key: 'moves', type: 'object', default: { translate: 1, rotate: 20, torsion: 60 },
      meaning: 'The size of one random move before the local optimisation.',
      fields: [
        { key: 'translate', type: 'number', min: TRANSLATE.min, max: TRANSLATE.max, unit: 'A',
          meaning: 'Shift of the whole ligand along a random direction, in angstrom.' },
        { key: 'rotate', type: 'number', min: ROTATE.min, max: ROTATE.max, unit: 'degrees',
          meaning: 'Rotation of the whole ligand about a random axis, in degrees.' },
        { key: 'torsion', type: 'number', min: TORSION.min, max: TORSION.max, unit: 'degrees',
          meaning: 'Largest turn of one rotatable bond, in degrees; ignored when the ligand is rigid.' },
      ] },
    { key: 'local', type: 'object', default: { steps: 30 },
      meaning: 'The local optimisation that follows every move.',
      fields: [
        { key: 'steps', type: 'integer', min: LOCAL_STEPS.min, max: LOCAL_STEPS.max, unit: 'iterations',
          meaning: 'BFGS iterations after each move; 0 keeps the raw move.' },
      ] },
    { key: 'placement', type: 'enum', values: PLACEMENTS, default: 'box',
      meaning: 'Where each chain starts: box places the ligand centre anywhere in the box, center keeps it within 35 percent of the box around its middle.' },
    { key: 'flexible', type: 'boolean', default: true,
      meaning: 'true turns the rotatable bonds during the search; false keeps the ideal conformer rigid.' },
    { key: 'candidates', type: 'integer', min: CANDIDATES.min, max: CANDIDATES.max, default: 4,
      meaning: 'Distinct low energy poses kept for the final refinement and integer polish; the best integer score wins.' },
    { key: 'lattice', type: 'boolean', default: true,
      meaning: 'true runs the integer lattice descent on the final pose (small moves accepted only when the chain score improves).' },
    { key: 'seed', type: 'integer', min: SEED.min, max: SEED.max, default: null, defaultText: 'chosen by the lab', optional: true,
      meaning: 'The random seed; absent, the lab picks one and records it with the run.' },
  ],
});

const KNOWN = new Set(METHOD_SCHEMA.fields.map((f) => f.key));

/** The resolved default method: what an empty object resolves to (the Standard preset with the name Custom). */
export const METHOD_DEFAULTS = Object.freeze({
  name: 'Custom',
  version: METHOD_VERSION,
  budget: Object.freeze({ ms: 30000 }),
  temperature: 1.2,
  moves: Object.freeze({ translate: 1, rotate: 20, torsion: 60 }),
  local: Object.freeze({ steps: 30 }),
  placement: 'box',
  flexible: true,
  candidates: 4,
  lattice: true,
});

function preset(over) {
  return Object.freeze({
    ...METHOD_DEFAULTS,
    ...over,
    budget: Object.freeze({ ...(over.budget || METHOD_DEFAULTS.budget) }),
    moves: Object.freeze({ ...METHOD_DEFAULTS.moves, ...(over.moves || {}) }),
    local: Object.freeze({ ...METHOD_DEFAULTS.local, ...(over.local || {}) }),
  });
}

/** The engine's presets, in the order the lab shows them. Each is a full method object. */
export const METHOD_PRESETS = Object.freeze([
  preset({ name: 'Quick', budget: { ms: 10000 } }),
  preset({ name: 'Standard', budget: { ms: 30000 } }),
  preset({ name: 'Deep', budget: { ms: 90000 }, candidates: 6 }),
  preset({ name: 'Rigid ligand', budget: { ms: 30000 }, flexible: false }),
  preset({ name: 'Wide search', budget: { ms: 30000 }, chains: 16, temperature: 1.6, moves: { translate: 2, rotate: 45, torsion: 90 }, local: { steps: 15 }, placement: 'box' }),
  preset({ name: 'Fine local', budget: { ms: 30000 }, chains: 4, temperature: 0.8, moves: { translate: 0.5, rotate: 10, torsion: 30 }, local: { steps: 80 }, placement: 'center' }),
  preset({ name: 'Reproducible', budget: { steps: 8000 }, chains: 8 }),
]);

/** The preset with this name (exact), or null. */
export function presetByName(name) {
  return METHOD_PRESETS.find((p) => p.name === name) || null;
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v) => typeof v === 'number' && Number.isInteger(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const absent = (v) => v === undefined || v === null;

function intIn(errors, path, v, b) {
  if (isInt(v) && v >= b.min && v <= b.max) return true;
  errors.push(`${path} must be a whole number from ${b.min} to ${b.max}.`);
  return false;
}

function numIn(errors, path, v, b) {
  if (isNum(v) && v >= b.min && v <= b.max) return true;
  errors.push(`${path} must be a number from ${b.min} to ${b.max}.`);
  return false;
}

function boolean(errors, path, v) {
  if (typeof v === 'boolean') return true;
  errors.push(`${path} must be true or false.`);
  return false;
}

function unknownKeys(errors, obj, allowed, prefix) {
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) errors.push(`Unknown key: ${prefix}${k}.`);
  }
}

/**
 * Validate and resolve a method. Accepts an object or JSON text. Never throws.
 * Returns { ok, method, errors }: method is the resolved object when ok (a fresh plain object), else null.
 */
export function validateMethod(json) {
  const errors = [];
  let raw = json;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch (e) { return { ok: false, method: null, errors: ['The method is not valid JSON.'] }; }
  }
  if (raw === undefined) raw = {};
  if (!isObject(raw)) return { ok: false, method: null, errors: ['The method must be a JSON object.'] };
  unknownKeys(errors, raw, KNOWN, '');
  const m = {};

  // name
  if (absent(raw.name)) m.name = METHOD_DEFAULTS.name;
  else if (typeof raw.name === 'string' && raw.name.trim().length >= 1 && raw.name.length <= METHOD_NAME_MAX && !/[ -]/.test(raw.name)) m.name = raw.name.trim();
  else errors.push(`name must be text of 1 to ${METHOD_NAME_MAX} characters.`);

  // version
  if (absent(raw.version)) m.version = METHOD_VERSION;
  else if (raw.version === METHOD_VERSION) m.version = METHOD_VERSION;
  else errors.push(`version must be ${METHOD_VERSION}.`);

  // budget: exactly one of ms, steps
  if (absent(raw.budget)) m.budget = { ...METHOD_DEFAULTS.budget };
  else if (!isObject(raw.budget)) errors.push('budget must be an object with ms or steps.');
  else {
    unknownKeys(errors, raw.budget, new Set(['ms', 'steps']), 'budget.');
    const hasMs = !absent(raw.budget.ms), hasSteps = !absent(raw.budget.steps);
    if (hasMs === hasSteps) errors.push('budget must have exactly one of ms or steps.');
    else if (hasMs) { if (intIn(errors, 'budget.ms', raw.budget.ms, BUDGET_MS)) m.budget = { ms: raw.budget.ms }; }
    else if (intIn(errors, 'budget.steps', raw.budget.steps, BUDGET_STEPS)) m.budget = { steps: raw.budget.steps };
  }

  // chains (absent = from the budget)
  if (!absent(raw.chains) && intIn(errors, 'chains', raw.chains, CHAINS)) m.chains = raw.chains;

  // temperature
  if (absent(raw.temperature)) m.temperature = METHOD_DEFAULTS.temperature;
  else if (numIn(errors, 'temperature', raw.temperature, TEMPERATURE)) m.temperature = raw.temperature;

  // moves
  if (absent(raw.moves)) m.moves = { ...METHOD_DEFAULTS.moves };
  else if (!isObject(raw.moves)) errors.push('moves must be an object with translate, rotate and torsion.');
  else {
    unknownKeys(errors, raw.moves, new Set(['translate', 'rotate', 'torsion']), 'moves.');
    const mv = { ...METHOD_DEFAULTS.moves };
    if (!absent(raw.moves.translate) && numIn(errors, 'moves.translate', raw.moves.translate, TRANSLATE)) mv.translate = raw.moves.translate;
    if (!absent(raw.moves.rotate) && numIn(errors, 'moves.rotate', raw.moves.rotate, ROTATE)) mv.rotate = raw.moves.rotate;
    if (!absent(raw.moves.torsion) && numIn(errors, 'moves.torsion', raw.moves.torsion, TORSION)) mv.torsion = raw.moves.torsion;
    m.moves = mv;
  }

  // local
  if (absent(raw.local)) m.local = { ...METHOD_DEFAULTS.local };
  else if (!isObject(raw.local)) errors.push('local must be an object with steps.');
  else {
    unknownKeys(errors, raw.local, new Set(['steps']), 'local.');
    const lc = { ...METHOD_DEFAULTS.local };
    if (!absent(raw.local.steps) && intIn(errors, 'local.steps', raw.local.steps, LOCAL_STEPS)) lc.steps = raw.local.steps;
    m.local = lc;
  }

  // placement
  if (absent(raw.placement)) m.placement = METHOD_DEFAULTS.placement;
  else if (PLACEMENTS.includes(raw.placement)) m.placement = raw.placement;
  else errors.push(`placement must be ${PLACEMENTS.join(' or ')}.`);

  // flexible
  if (absent(raw.flexible)) m.flexible = METHOD_DEFAULTS.flexible;
  else if (boolean(errors, 'flexible', raw.flexible)) m.flexible = raw.flexible;

  // candidates
  if (absent(raw.candidates)) m.candidates = METHOD_DEFAULTS.candidates;
  else if (intIn(errors, 'candidates', raw.candidates, CANDIDATES)) m.candidates = raw.candidates;

  // lattice
  if (absent(raw.lattice)) m.lattice = METHOD_DEFAULTS.lattice;
  else if (boolean(errors, 'lattice', raw.lattice)) m.lattice = raw.lattice;

  // seed (optional)
  if (!absent(raw.seed) && intIn(errors, 'seed', raw.seed, SEED)) m.seed = raw.seed;

  if (errors.length) return { ok: false, method: null, errors };
  const compact = methodToCompact(m);
  if (utf8Length(compact) > METHOD_MAX_BYTES) return { ok: false, method: null, errors: [`The method must be at most ${METHOD_MAX_BYTES} bytes as compact JSON.`] };
  return { ok: true, method: m, errors: [] };
}

/** Resolve a partial method or throw an Error whose message is the first error sentence (all of them in .errors). */
export function resolveMethod(partial) {
  const r = validateMethod(partial === undefined ? {} : partial);
  if (!r.ok) { const e = new Error(r.errors[0]); e.errors = r.errors; throw e; }
  return r.method;
}

function sortedClone(v) {
  if (Array.isArray(v)) return v.map(sortedClone);
  if (isObject(v)) {
    const out = {};
    for (const k of Object.keys(v).sort()) { if (v[k] !== undefined) out[k] = sortedClone(v[k]); }
    return out;
  }
  return v;
}

/** Canonical compact JSON: keys sorted at every level, no whitespace, numbers as JSON.stringify prints them. */
export function methodToCompact(method) {
  return JSON.stringify(sortedClone(method));
}

/** true when both methods resolve to the same compact JSON (either may be partial; invalid input gives false). */
export function methodEquals(a, b) {
  const ra = validateMethod(a), rb = validateMethod(b);
  return ra.ok && rb.ok && methodToCompact(ra.method) === methodToCompact(rb.method);
}

function utf8Length(text) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).length;
  return Buffer.byteLength(text, 'utf8');
}

function utf8Encode(text) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text);
  return new Uint8Array(Buffer.from(text, 'utf8'));
}

function utf8Decode(bytes) {
  if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return Buffer.from(bytes).toString('utf8');
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64_INDEX = new Int16Array(128).fill(-1);
for (let i = 0; i < 64; i++) B64_INDEX[B64.charCodeAt(i)] = i;

/** base64url without padding (RFC 4648 section 5). */
export function base64urlEncode(bytes) {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  if (i + 1 === bytes.length) {
    const n = bytes[i] << 16;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
  } else if (i + 2 === bytes.length) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63];
  }
  return out;
}

/** Decode base64url (padding optional; plain base64 characters + and / are accepted too). Returns null on bad input. */
export function base64urlDecode(text) {
  if (typeof text !== 'string') return null;
  const s = text.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  if (s.length % 4 === 1) return null;
  const out = [];
  let buf = 0, bits = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const v = c < 128 ? B64_INDEX[c] : -1;
    if (v < 0) return null;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) { bits -= 8; out.push((buf >> bits) & 255); buf &= (1 << bits) - 1; }
  }
  return Uint8Array.from(out);
}

/** The share link form: base64url of the compact JSON. */
export function methodToQuery(method) {
  return base64urlEncode(utf8Encode(methodToCompact(method)));
}

/** Parse a share link value. Returns a validateMethod result; a value that does not decode yields one error sentence. */
export function methodFromQuery(text) {
  const bytes = base64urlDecode(typeof text === 'string' ? text.trim() : '');
  if (!bytes || !bytes.length) return { ok: false, method: null, errors: ['The method link could not be decoded.'] };
  let json;
  try { json = utf8Decode(bytes); } catch (e) { return { ok: false, method: null, errors: ['The method link could not be decoded.'] }; }
  return validateMethod(json);
}
