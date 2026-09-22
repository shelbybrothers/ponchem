// GET  /api/analyze            the model providers: { ok, providers: [{ id, label, model, connected }] }  (SPEC.md 9.8)
// POST /api/analyze            { runId, provider } -> { ok, provider, model, text, generatedAt, cached }
//
// The analysis of one docking test written by a real model. The route reads the test from the chain through
// api/_lab.mjs (the run, the target and ligand catalog rows, the target's other tests and its best, the epoch best,
// the recorded method, the review summary, the five terms recomputed from the pose), builds one prompt with the
// facts first and the ask second, and calls the chosen provider with the key from the environment (api/_llm.mjs).
// The text is post-processed (em and en dashes become commas or periods, emoji removed) and cached per (runId,
// provider) for ten minutes on this instance. Ten analyses per minute per instance.
//
// Answers: 400 bad input; 404 when the run does not exist (or the lab is not live); 409 { error: 'provider not
// connected' } when the provider's key is not configured; 429 when the desk is busy; 502 when the provider fails.
// Keys never reach the browser: the GET only says connected true or false. Every answer is no-store.
import { handle, analysisFacts, InputError } from './_lab.mjs';
import { PROVIDERS, providerOf, isConnected, listProviders, complete, buildAnalysisPrompt, postProcess, limiter, cache, LlmError, DEFAULT_MAX_TOKENS, DEFAULT_TIMEOUT_MS } from './_llm.mjs';

export default handle(async ({ method, body, signal }) => {
  if (method !== 'POST') return { status: 200, body: { ok: true, providers: listProviders() }, cache: false };
  const b = body && typeof body === 'object' ? body : {};
  const runId = Number(b.runId);
  if (!Number.isInteger(runId) || runId < 1) throw new InputError('runId must be a whole number of at least 1.', 'runId');
  const p = providerOf(b.provider);
  if (!p) throw new InputError(`provider must be one of ${PROVIDERS.map((x) => x.id).join(', ')}.`, 'provider');
  if (!isConnected(p)) return { status: 409, body: { ok: false, error: 'provider not connected', message: `${p.label} is not connected on this server.`, provider: p.id }, cache: false };
  const key = cache.key(runId, p.id);
  const hit = cache.get(key);
  if (hit) return { status: 200, body: { ok: true, ...hit, cached: true }, cache: false };
  const facts = await analysisFacts(runId, { signal });
  if (!facts) return { status: 404, body: { ok: false, error: 'no-run', message: 'Unknown run id.' }, cache: false };
  if (!limiter.take()) return { status: 429, body: { ok: false, error: 'rate-limited', message: 'The analysis desk is busy. Try again in a minute.' }, cache: false };
  const { system, user } = buildAnalysisPrompt(facts);
  let out;
  try {
    out = await complete(p.id, { system, user, maxTokens: DEFAULT_MAX_TOKENS, timeoutMs: DEFAULT_TIMEOUT_MS });
  } catch (e) {
    if (e instanceof LlmError) return { status: e.status || 502, body: { ok: false, error: 'provider-failed', message: e.message, provider: p.id }, cache: false };
    throw e;
  }
  const text = postProcess(out.text);
  if (!text) return { status: 502, body: { ok: false, error: 'provider-failed', message: 'The model answered with nothing usable.', provider: p.id }, cache: false };
  const value = cache.set(key, { provider: p.id, model: out.model, text, generatedAt: new Date().toISOString() });
  return { status: 200, body: { ok: true, ...value, cached: false }, cache: false };
}, { methods: ['GET', 'POST'] });
