/*
 * api/_llm.mjs: the model providers behind POST /api/analyze (SPEC.md 9.8). Private (underscore): never routed.
 * Raw HTTP with the global fetch, no SDK, because this deployment carries no dependencies. Keys are read from the
 * environment at call time, sent only in the request header to the provider, and never logged, echoed or listed.
 *
 * ENV (a provider is "connected" when its key, and for Jev its URL, exist)
 *   ANTHROPIC_API_KEY   Claude Fable 5.1 through the Anthropic Messages API      model PONCHEM_MODEL_CLAUDE_FABLE (default claude-fable-5-1)
 *   OPENAI_API_KEY      GPT through OpenAI chat completions                       model PONCHEM_MODEL_GPT (default gpt-5)
 *   MOONSHOT_API_KEY    Kimi through the Moonshot OpenAI-compatible endpoint      model PONCHEM_MODEL_KIMI (default kimi-k2)
 *   JEV_API_KEY + JEV_API_URL   Jev AI, an OpenAI-compatible base URL             model PONCHEM_MODEL_JEV (default jev)
 *   ANTHROPIC_BASE_URL / OPENAI_BASE_URL / MOONSHOT_BASE_URL   optional base overrides (tests point them at a fake)
 *
 * SHIPPED API
 *   PROVIDERS                       [{ id, label, kind: 'anthropic' | 'openai', keyEnv, baseEnv, base, modelEnv, model }]
 *   providerOf(id) -> entry | null      isConnected(entry) -> bool      listProviders() -> [{ id, label, model, connected }]
 *   complete(id, { system, user, maxTokens = 700, timeoutMs = 25000 }) -> { text, model, provider }    throws LlmError { status }
 *   buildAnalysisPrompt(facts) -> { system, user }    facts from api/_lab.mjs analysisFacts()
 *   postProcess(text) -> string     em and en dashes become commas or periods, emoji removed, markdown headers and
 *                                   bullet markers dropped, whitespace settled
 *   limiter                         { take(now) -> bool, reset() }   10 analyses per minute per instance (sliding window)
 *   cache                           { key(runId, provider), get(key), set(key, value), clear() }   10 minutes per (runId, provider)
 *   LlmError                        Error with a plain sentence and an HTTP status for the route
 */

export const PROVIDERS = Object.freeze([
  { id: 'claude-fable', label: 'Claude Fable 5.1', kind: 'anthropic', keyEnv: 'ANTHROPIC_API_KEY', baseEnv: 'ANTHROPIC_BASE_URL', base: 'https://api.anthropic.com', modelEnv: 'PONCHEM_MODEL_CLAUDE_FABLE', model: 'claude-fable-5-1' },
  { id: 'gpt', label: 'GPT', kind: 'openai', keyEnv: 'OPENAI_API_KEY', baseEnv: 'OPENAI_BASE_URL', base: 'https://api.openai.com/v1', modelEnv: 'PONCHEM_MODEL_GPT', model: 'gpt-5', maxTokensField: 'max_completion_tokens' },
  { id: 'kimi', label: 'Kimi', kind: 'openai', keyEnv: 'MOONSHOT_API_KEY', baseEnv: 'MOONSHOT_BASE_URL', base: 'https://api.moonshot.ai/v1', modelEnv: 'PONCHEM_MODEL_KIMI', model: 'kimi-k2' },
  { id: 'jev', label: 'Jev AI', kind: 'openai', keyEnv: 'JEV_API_KEY', baseEnv: 'JEV_API_URL', base: null, modelEnv: 'PONCHEM_MODEL_JEV', model: 'jev' },
].map(Object.freeze));

export const RATE_LIMIT = 10;
export const RATE_WINDOW_MS = 60_000;
export const CACHE_TTL_MS = 10 * 60_000;
export const DEFAULT_TIMEOUT_MS = 25_000;
export const DEFAULT_MAX_TOKENS = 700;
export const ANTHROPIC_VERSION = '2023-06-01';

export class LlmError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
  }
}

const env = (name) => (name ? String(process.env[name] || '').trim() : '');

export function providerOf(id) {
  const key = String(id || '').trim().toLowerCase();
  return PROVIDERS.find((p) => p.id === key) || null;
}

/** The provider's settings, read now. The key never leaves this module except as a request header. */
function settingsOf(p) {
  const key = env(p.keyEnv);
  const base = (env(p.baseEnv) || p.base || '').replace(/\/+$/, '');
  const model = env(p.modelEnv) || (p.id === 'claude-fable' ? env('PONCHEM_MODEL_CLAUDE') : '') || p.model;
  return { key, base, model };
}

export function isConnected(p) {
  if (!p) return false;
  const s = settingsOf(p);
  return !!(s.key && s.base && /^https?:\/\//i.test(s.base));
}

export function listProviders() {
  return PROVIDERS.map((p) => ({ id: p.id, label: p.label, model: settingsOf(p).model, connected: isConnected(p) }));
}

// ---------------------------------------------------------------------------------------------------------
// the calls

function statusSentence(status) {
  if (status === 400 || status === 422) return 'The provider refused the request.';
  if (status === 401 || status === 403) return 'The provider refused the key configured on this server.';
  if (status === 404) return 'The provider does not know the model configured on this server.';
  if (status === 429) return 'The provider is rate limited. Try again in a minute.';
  if (status === 408 || status === 504) return 'The provider took too long to answer.';
  return 'The provider did not answer.';
}

async function post(url, headers, body, timeoutMs) {
  let r;
  try {
    r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    throw new LlmError(timeout ? `The provider did not answer within ${Math.round(timeoutMs / 1000)} seconds.` : 'The provider could not be reached.', 502);
  }
  let json = null;
  try { json = await r.json(); } catch { json = null; }
  if (!r.ok) {
    console.error(`analysis provider answered HTTP ${r.status}`);
    throw new LlmError(statusSentence(r.status), r.status === 429 ? 429 : 502);
  }
  if (!json || typeof json !== 'object') throw new LlmError('The provider answered with something that is not JSON.', 502);
  return json;
}

const textOfParts = (content) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (b && typeof b === 'object' && (b.type === 'text' || b.type === 'output_text') && typeof b.text === 'string' ? b.text : '')).filter(Boolean).join('\n');
};

async function anthropic(p, s, { system, user, maxTokens, timeoutMs }) {
  const json = await post(`${s.base}/v1/messages`, { 'x-api-key': s.key, 'anthropic-version': ANTHROPIC_VERSION }, {
    model: s.model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
  }, timeoutMs);
  if (json.type === 'error') throw new LlmError(statusSentence(400), 502);
  if (json.stop_reason === 'refusal') throw new LlmError('The model declined to write this analysis.', 502);
  const text = textOfParts(json.content).trim();
  if (!text) throw new LlmError('The model answered with nothing usable.', 502);
  return { text, model: typeof json.model === 'string' && json.model ? json.model : s.model };
}

async function openai(p, s, { system, user, maxTokens, timeoutMs }) {
  const body = {
    model: s.model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  };
  body[p.maxTokensField || 'max_tokens'] = maxTokens;
  const json = await post(`${s.base}/chat/completions`, { authorization: `Bearer ${s.key}` }, body, timeoutMs);
  const choice = Array.isArray(json.choices) ? json.choices[0] : null;
  const msg = choice && choice.message ? choice.message : null;
  if (msg && typeof msg.refusal === 'string' && msg.refusal.trim() && !msg.content) throw new LlmError('The model declined to write this analysis.', 502);
  const text = msg ? textOfParts(msg.content).trim() : '';
  if (!text) throw new LlmError('The model answered with nothing usable.', 502);
  return { text, model: typeof json.model === 'string' && json.model ? json.model : s.model };
}

export async function complete(id, { system, user, maxTokens = DEFAULT_MAX_TOKENS, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const p = providerOf(id);
  if (!p) throw new LlmError('Unknown provider.', 400);
  const s = settingsOf(p);
  if (!isConnected(p)) throw new LlmError(`${p.label} is not connected on this server.`, 409);
  const out = p.kind === 'anthropic' ? await anthropic(p, s, { system, user, maxTokens, timeoutMs }) : await openai(p, s, { system, user, maxTokens, timeoutMs });
  return { ...out, provider: p.id };
}

// ---------------------------------------------------------------------------------------------------------
// the prompt: facts first, then the ask

const SYSTEM = 'You are writing a short research note for a public lab page on Ponchem, an on-chain computer-aided drug design lab. Write plain sentences in short paragraphs. Use no emoji, no dashes of any kind, no markdown headers and no bullet symbols. When you recall literature about the compound or the target, say so and label it as unverified recall. Never claim clinical efficacy, and never say that a compound treats or cures a disease. The score you are given is a computational estimate from a rigid-receptor Vina-style scoring function; treat it as a lead for further study, nothing more.';

const fix = (n, d) => (Number.isFinite(Number(n)) ? Number(n).toFixed(d) : 'unknown');
const kdText = (kd) => {
  if (!Number.isFinite(kd) || kd <= 0) return 'unknown';
  const units = [['pM', 1e-12], ['nM', 1e-9], ['uM', 1e-6], ['mM', 1e-3], ['M', 1]];
  let pick = units[units.length - 1];
  for (const u of units) { if (kd < u[1] * 1000) { pick = u; break; } }
  if (kd >= 1) pick = units[units.length - 1];
  return `${Number((kd / pick[1]).toPrecision(3))} ${pick[0]}`;
};
const bandOf = (dG) => (dG <= -9 ? 'strong binder' : dG <= -6 ? 'moderate binder' : dG < 0 ? 'weak binder' : 'no binding');
const plain = (s, max = 240) => String(s === null || s === undefined ? '' : s).replace(/[‒-―]/g, '-').replace(/\s+/g, ' ').trim().slice(0, max);
const when = (t) => (t ? new Date(Number(t) * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC') : 'time unknown');

export function buildAnalysisPrompt(f) {
  const run = f.run;
  const t = f.target || {};
  const l = f.ligand || {};
  const d = f.derived || {};
  const lines = [];
  lines.push(`Facts about docking test #${run.id} on Ponchem, recorded on Robinhood Chain${run.block ? ` at block ${run.block}` : ''} (${when(run.time)}).`);
  const groups = Array.isArray(t.cancers) && t.cancers.length ? t.cancers.map((c) => plain(c, 40)).join(', ') : 'not listed';
  const ref = t.ligand && (t.ligand.ccd || t.ligand.name) ? `${plain(t.ligand.ccd || '', 8)}${t.ligand.name ? ` (${plain(t.ligand.name, 80)})` : ''}` : 'none listed';
  lines.push(`Target: ${plain(t.gene || t.key || `target ${run.targetId}`, 40)}${t.protein ? ` (${plain(t.protein, 120)})` : ''}, PDB ${plain(t.pdbId || 'unknown', 8)}${t.method ? `, ${plain(t.method, 40).toLowerCase()}` : ''}${t.resolution ? ` at ${fix(t.resolution, 2)} A` : ''}${t.organism ? `, organism ${plain(t.organism, 60)}` : ''}. Cancer groups: ${groups}. Reference ligand in the crystal: ${ref}.${t.why ? ` Why it matters: ${plain(t.why, 200)}` : ''}`);
  lines.push(`Ligand: ${plain(l.name || l.key || `ligand ${run.ligandId}`, 80)}${l.plant ? `, from ${plain(l.plant, 80)}${l.latin ? ` (${plain(l.latin, 80)})` : ''}` : ''}${l.formula ? `, formula ${plain(l.formula, 40)}` : ''}, ${f.heavyAtoms || 'unknown'} heavy atoms${l.nrot !== undefined || l.rotatableBonds !== undefined ? `, ${Number(l.nrot !== undefined ? l.nrot : l.rotatableBonds)} rotatable bonds` : ''}${l.class ? `, class ${plain(l.class, 40)}` : ''}${l.pubchemCid ? `, PubChem CID ${Number(l.pubchemCid)}` : ''}${l.ccd ? `, RCSB component ${plain(l.ccd, 8)}` : ''}.${l.mechanism ? ` Reported mechanism in the catalog: ${plain(l.mechanism, 200)}.` : ''}`);
  lines.push(`Result: estimated binding free energy dG ${fix(d.dG, 3)} kcal/mol (${bandOf(d.dG)}), estimated pKd ${fix(d.pKd, 2)}, estimated Kd ${kdText(d.kd)}, ligand efficiency ${d.le === null || d.le === undefined ? 'unknown' : fix(d.le, 2)} kcal/mol per heavy atom. The score is the chain's number.`);
  if (f.score && f.score.ok && f.score.terms) {
    const s = f.score;
    lines.push(`Five terms recomputed from the recorded pose, weighted, in kcal/mol: gauss 1 ${fix(s.terms.g1, 3)}, gauss 2 ${fix(s.terms.g2, 3)}, repulsion ${fix(s.terms.rep, 3)}, hydrophobic ${fix(s.terms.hyd, 3)}, hydrogen bond ${fix(s.terms.hb, 3)}, over ${s.pairs} atom pairs within 8 A, divided by 1 + 0.0585 x ${s.nrot} rotatable bonds. Geometry proof: passed. ${s.agrees ? 'The server recomputation equals the chain score.' : `The server recomputation gives ${fix(s.scoreMilli / 1000, 3)} kcal/mol, which differs from the chain score.`}`);
  } else if (f.score && !f.score.ok) {
    lines.push(`The recorded pose does not pass the geometry proof on the server (${plain(f.score.reason, 40)}), which should not happen for a chain-scored test.`);
  } else {
    lines.push('The five terms were not recomputed on the server for this request.');
  }
  const o = f.others || {};
  const p = f.pair || {};
  const best = o.best ? `best on this target dG ${fix(o.best.scoreMilli / 1000, 3)} kcal/mol (test #${o.best.id}${o.best.id === run.id ? ', this test' : ''})` : 'no other test on this target';
  const epochBest = o.epochBest ? `best this epoch dG ${fix(o.epochBest.scoreMilli / 1000, 3)} kcal/mol (test #${o.epochBest.id})` : 'no test this epoch';
  lines.push(`Context on this target: ${o.count || 0} other tests by ${o.wallets || 0} other wallets, ${best}, ${epochBest}. This target and ligand pair: ${p.count || 0} tests${p.best ? `, best dG ${fix(p.best.scoreMilli / 1000, 3)} kcal/mol (test #${p.best.id})` : ''}.`);
  lines.push(f.method ? `Search method recorded with the test (JSON): ${plain(f.method, 1024)}` : 'The search method was not recorded with the test.');
  const rv = f.reviews || {};
  lines.push(rv.count ? `Reviews on chain: ${rv.count}, average ${fix(rv.average, 1)} stars. Review notes are not included here.` : 'No reviews on chain yet.');
  lines.push('');
  lines.push('Write the research note. First, interpret this score for this target and this ligand in plain words, including what the terms and the ligand efficiency suggest. Second, name the limits of a rigid-receptor Vina-style estimate: one crystal conformation, no receptor flexibility, no explicit water, entropy only through the rotor term, an empirical function fitted on other complexes, and the mirror image ambiguity of the geometry checks. Third, suggest the next computational steps and the next wet-lab steps. Fourth, if you recall published work on this compound or this target, mention it briefly and label it as unverified recall. Under 350 words.');
  return { system: SYSTEM, user: lines.join('\n') };
}

// ---------------------------------------------------------------------------------------------------------
// post-processing: the copy rules on model output (the pages render the result as text via el())

const EMOJI = /\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}])*/gu;
const FLAGS = /[\u{1F1E6}-\u{1F1FF}]{2}/gu;

export function postProcess(text) {
  let t = String(text === null || text === undefined ? '' : text).replace(/\r\n?/g, '\n');
  t = t.replace(FLAGS, '').replace(EMOJI, '').replace(/[️‍⃣]/g, '');
  t = t.replace(/[ \t]+([.,;:!?])/g, '$1'); // a stripped emoji leaves no gap before punctuation
  // dashes: a dashed range of numbers reads "to", a dash that ends a line becomes a period, the rest become commas
  t = t.replace(/(\d)\s*[‒–—―]\s*(\d)/g, '$1 to $2');
  t = t.replace(/\s*[‒–—―]+\s*(?=\n|$)/g, '.');
  t = t.replace(/(^|\n)\s*[‒–—―]+\s*/g, '$1');
  t = t.replace(/\s*[‒–—―]+\s*/g, ', ');
  // markdown headers, bullet markers and bold markers
  t = t.replace(/^[ \t]{0,3}#{1,6}[ \t]*/gm, '').replace(/^[ \t]*(?:[-*+•]|\d+[.)])[ \t]+/gm, '').replace(/\*\*/g, '');
  // punctuation that the replacements may have doubled
  t = t.replace(/,\s*,/g, ',').replace(/,\s*\./g, '.').replace(/\.\s*,/g, '.').replace(/,\s*:/g, ':');
  t = t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
  return t;
}

// ---------------------------------------------------------------------------------------------------------
// the limiter and the cache, per instance

function makeLimiter(limit = RATE_LIMIT, windowMs = RATE_WINDOW_MS) {
  let stamps = [];
  return {
    take(now = Date.now()) {
      stamps = stamps.filter((t) => now - t < windowMs);
      if (stamps.length >= limit) return false;
      stamps.push(now);
      return true;
    },
    reset() { stamps = []; },
    size() { return stamps.length; },
  };
}
export const limiter = makeLimiter();

const cacheStore = new Map(); // key -> { at, value }
export const cache = {
  key: (runId, provider) => `${Number(runId)}:${String(provider).toLowerCase()}`,
  get(key, now = Date.now()) {
    const hit = cacheStore.get(key);
    if (!hit) return null;
    if (now - hit.at >= CACHE_TTL_MS) { cacheStore.delete(key); return null; }
    return hit.value;
  },
  set(key, value, now = Date.now()) {
    if (cacheStore.size > 500) cacheStore.delete(cacheStore.keys().next().value);
    cacheStore.set(key, { at: now, value });
    return value;
  },
  clear() { cacheStore.clear(); },
};
