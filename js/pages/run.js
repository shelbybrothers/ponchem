// js/pages/run.js: one docking test (/run?id=N, SPEC 9.3): header, the chain's score re-checked in the browser,
// the pose in 3D, provenance links, the method, the AI analysis, the reviews, and Post on X / Copy link / Download report.
// Chain text, RCSB text, method JSON, review notes and model output reach the page through el() text nodes only.
import {
  boot, qs, catalog, catalogMod, engineMod, methodMod, chain, lab, el, F, STR, EMPTY, milliOf, lookup, empty, ladder, outLink, txLink,
  setTitle, dgCell, bandBadge, BAND_LONG, band, derived, kdText, pkdText, walletCell, mountStructure, fetchLigandSdf, targetHref, ligandHref,
  rcsbStructureLink, rcsbLigandLink, ligandSourceLink, runById, reviewsOf, reviewSummary, analysisOf, methodOf, stars, starsPicker,
  testPostLink, testMarkdown, analysisProviders, analyzeTest, textBlock, base64url, copyText, download, toast, W, EXPLORER,
  openWalletMenu, isLive, chainNote, runTime, runUrl, onRefresh, targetName, isMe, icon,
} from './common.js';

boot({ onWallet: () => { paintReviewForm(); paintAnalysis(); } });
const $ = (s) => document.querySelector(s);

const state = { id: null, cat: null, run: null, t: null, l: null, reviews: [], reviewsOk: false, analysis: null, method: '', browser: null, providers: null, generated: null, viewer: null };

function notFound(note) {
  $('[data-page]').hidden = true;
  const nf = $('[data-notfound]');
  nf.hidden = false;
  const n = $('[data-notfound-note]');
  if (note) { n.textContent = note; n.hidden = false; }
  setTitle('Docking test not found', STR.runNotFoundLine);
}

const TERMS = [['g1', 'gauss 1', -0.0356], ['g2', 'gauss 2', -0.00516], ['rep', 'repulsion', 0.84], ['hyd', 'hydrophobic', -0.0351], ['hb', 'hydrogen bond', -0.587]];
const GEO = [['BOND', 'Bond lengths within tolerance'], ['PAIR13', '1-3 distances within tolerance'], ['CLASH', 'No internal clashes'], ['BOX', 'All atoms inside the box']];
const CODES = ['OK', 'ATOM_COUNT', 'BOX', 'BOND', 'PAIR13', 'CLASH'];
const ORDER = ['ATOM_COUNT', 'BOX', 'BOND', 'PAIR13', 'CLASH'];

function geoRows(ok, reason) {
  let r = typeof reason === 'number' ? CODES[reason] : reason;
  r = r ? String(r).toUpperCase().replace(/[^A-Z0-9_]/g, '').replace('PAIR_13', 'PAIR13') : null;
  const failIdx = ok || !r ? -1 : ORDER.indexOf(r);
  return GEO.map(([key, label]) => {
    let s;
    if (ok) s = true;
    else if (failIdx < 0) s = false;
    else { const i = ORDER.indexOf(key); s = i < failIdx ? true : i === failIdx ? false : null; }
    return { key, label, ok: s };
  });
}

async function fetchBin(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return new Uint8Array(await r.arrayBuffer());
}

/** The pose re-scored with the engine's integer scorer (SPEC 9.3): the chain's number must come back. */
async function browserCheck() {
  const { run, t, l } = state;
  const E = await engineMod();
  if (!E || typeof E.scoreInt !== 'function' || typeof E.loadPocket !== 'function') return { state: 'engine-missing' };
  if (!run.pose || !run.pose.length) return { state: 'pose-missing' };
  const C = await catalogMod();
  let pocketBytes;
  let topoBytes;
  try {
    pocketBytes = C && typeof C.fetchPocket === 'function' ? await C.fetchPocket(t.pdbId) : await fetchBin(`/${(t.pocket || `data/pockets/${t.pdbId}.bin`).replace(/^\//, '')}`);
    topoBytes = C && typeof C.fetchTopology === 'function' ? await C.fetchTopology(l.key) : await fetchBin(`/${(l.topology || `data/topologies/${l.key}.bin`).replace(/^\//, '')}`);
  } catch { return { state: 'data-missing' }; }
  try {
    if (typeof E.ensureTables === 'function') await E.ensureTables();
    const pocket = E.loadPocket(pocketBytes);
    const topology = E.loadTopology(topoBytes);
    const r = E.scoreInt(pocket, topology, run.pose);
    const nrot = Number(topology.nrot) || 0;
    const terms = {};
    let sum = 0;
    if (r.terms) for (const [k, , w] of TERMS) { const v = (w * Number(r.terms[k])) / 1e6; terms[k] = v; sum += v; }
    const divisor = 1 + 0.0585 * nrot;
    const poseAbs = new Float64Array(run.pose.length);
    for (let i = 0; i < run.pose.length; i++) poseAbs[i] = pocket.center[i % 3] + run.pose[i] / 100;
    const agree = !!r.ok && Number(r.scoreMilli) === Number(run.scoreMilli);
    return { state: 'ok', ok: !!r.ok, reason: r.reason, scoreMilli: r.ok ? Number(r.scoreMilli) : null, terms: r.terms ? terms : null, sum, divisor, total: sum / divisor, nrot, heavy: topology.n, agree, pocket, topology, poseAbs };
  } catch { return { state: 'engine-error' }; }
}

function paintHeader() {
  const { run, t, l } = state;
  const m = milliOf(run);
  $('[data-h1]').textContent = `Docking test #${run.id}`;
  const pair = $('[data-pair]');
  pair.replaceChildren(
    l ? el('a', { class: 'pc-link', href: ligandHref(l) }, l.name) : `ligand ${run.ligandId}`,
    ' into ',
    t ? el('a', { class: 'pc-link', href: targetHref(t) }, [t.gene || t.key, ' (', t.pdbId, ')']) : `target ${run.targetId}`,
  );
  const when = runTime(run);
  $('[data-meta]').replaceChildren(
    el('span', { class: 'pc-run-meta-item' }, [icon('wallet', 16), walletCell(run.wallet)]),
    when ? el('span', { class: 'pc-run-meta-item', title: new Date(when).toISOString() }, `${F.date(new Date(when))} · ${F.ago(when)}`) : null,
    run.epoch !== undefined && run.epoch !== null ? el('span', { class: 'pc-run-meta-item' }, `epoch ${F.num(run.epoch)}`) : null,
    run.tx ? el('span', { class: 'pc-run-meta-item' }, outLink(EXPLORER.tx(run.tx), 'View transaction')) : null,
  );
  const title = `Docking test #${run.id}`;
  const desc = `${l ? l.name : `Ligand ${run.ligandId}`} into ${t ? `${t.gene || t.key} (${t.pdbId})` : `target ${run.targetId}`}: dG ${F.kcal(BigInt(Math.trunc(m)), 3)}, pKd ${pkdText(m)}, scored on Robinhood Chain.`;
  setTitle(title, desc);
  for (const sel of ['link[rel="canonical"]', 'meta[property="og:url"]']) { const n = document.querySelector(sel); if (n) n.setAttribute(sel.startsWith('link') ? 'href' : 'content', runUrl(run.id)); }
  paintActions();
}

function paintActions() {
  const { run, t, l, analysis } = state;
  $('[data-x]').href = testPostLink(run, t, l, analysis);
  $('[data-viewer-title]').textContent = t ? `${t.pdbId} · ${targetName(t)}` : '';
  $('[data-viewer-link]').replaceChildren(t ? rcsbStructureLink(t.pdbId, 'pc-link pc-link--out pc-small') : '');
}

function scoreRows(rows) {
  return el('div', { class: 'pc-rows' }, rows.filter(Boolean).map(([k, v, mono = true]) => el('div', { class: 'pc-rows-row' }, [el('span', { class: 'pc-rows-label' }, k), el('span', { class: mono ? 'pc-rows-value pc-mono' : 'pc-rows-value' }, v)])));
}

function paidRow(run) {
  const p = run.payment || run.paid || null;
  let method = null;
  if (p && p.code !== undefined && p.code !== null) method = Number(p.code);
  else if (p && typeof p.method === 'string') method = p.method === 'token' ? 1 : 0;
  else if (p && p.method !== undefined) method = Number(p.method);
  if (method === null || !Number.isFinite(method)) return null;
  const amount = p && p.amount !== undefined && p.amount !== null ? p.amount : null;
  if (method === 1) return ['Paid with', amount !== null ? `${F.units(amount, 18, 2)} $PONCHEM` : '$PONCHEM'];
  return ['Paid with', amount !== null ? `${F.units(amount, 18, 6)} ETH` : 'ETH'];
}

function paintScore() {
  const { run, l } = state;
  const m = milliOf(run);
  const d = derived(m, l && l.heavyAtoms);
  const b = band(m);
  const host = $('[data-score]');
  host.replaceChildren(
    el('div', { class: 'pc-row pc-row--between' }, [el('div', { class: 'pc-eyebrow' }, 'Chain score'), el('span', { class: 'pc-chip pc-chip--good pc-chip--mono' }, [icon('check', 14), 'chain score'])]),
    el('div', { class: 'pc-score-num' }, [dgCell(m, { plain: true }), el('span', { class: 'pc-unit' }, 'kcal/mol')]),
    el('div', { class: 'pc-score-band' }, [bandBadge(m), el('span', { class: 'pc-small pc-muted' }, BAND_LONG[b] || '')]),
    scoreRows([
      ['Estimated pKd', pkdText(m)],
      ['Estimated Kd', kdText(d.kd)],
      ['Ligand efficiency', d.le === null ? F.EMPTY : `${F.fixed(d.le, 2)} kcal/mol per heavy atom`],
      ['Heavy atoms', l && l.heavyAtoms ? String(l.heavyAtoms) : F.EMPTY],
      ['Rotatable bonds', l && l.nrot !== undefined ? String(l.nrot) : l && l.rotatableBonds !== undefined ? String(l.rotatableBonds) : F.EMPTY],
      paidRow(run),
      ['Score in milli kcal/mol', F.num(m)],
    ]),
  );
}

function paintCheck() {
  const host = $('[data-check]');
  const br = state.browser;
  if (!br) { host.replaceChildren(el('span', { class: 'pc-skel', style: { width: '50%' } })); return; }
  if (br.state === 'engine-missing' || br.state === 'engine-error') { host.replaceChildren(el('p', { class: 'pc-alert pc-alert--warn' }, STR.engineMissing)); return; }
  if (br.state === 'pose-missing') { host.replaceChildren(el('p', { class: 'pc-alert pc-alert--warn' }, STR.poseMissing)); return; }
  if (br.state === 'data-missing') { host.replaceChildren(el('p', { class: 'pc-alert pc-alert--warn' }, 'The pocket or topology bytes could not be loaded, so the browser cannot re-score this test.')); return; }
  const m = milliOf(state.run);
  const status = br.agree
    ? el('p', { class: 'pc-agree pc-agree--ok', dataset: { agree: 'yes' } }, [icon('check', 20), STR.agree])
    : el('p', { class: 'pc-agree pc-agree--bad', dataset: { agree: 'no' } }, [icon('alert', 20), br.ok ? STR.disagree(F.kcal(BigInt(Math.trunc(m)), 3, false), F.kcal(BigInt(Math.trunc(br.scoreMilli)), 3, false)) : 'The browser rejects this pose on a geometry check, the chain accepted it. Reload the page; if it stays, the pocket files differ from the chain.']);
  const geo = el('div', { class: 'pc-geo' }, geoRows(br.ok, br.reason).map((g) => el('div', { class: 'pc-geo-row', dataset: { ok: g.ok === true ? 'yes' : g.ok === false ? 'no' : 'skip' } }, [icon(g.ok === false ? 'cross' : 'check', 20), g.label])));
  const terms = br.terms ? el('table', { class: 'pc-terms' }, el('tbody', {}, [
    ...TERMS.map(([k, name]) => el('tr', {}, [el('td', {}, name), el('td', {}, F.fixed(br.terms[k], 3))])),
    el('tr', { class: 'pc-terms-sum' }, [el('td', {}, 'sum'), el('td', {}, F.fixed(br.sum, 3))]),
    el('tr', {}, [el('td', {}, `divided by 1 + 0.0585 x ${br.nrot}`), el('td', {}, F.fixed(br.divisor, 4))]),
    el('tr', { class: 'pc-terms-sum' }, [el('td', {}, 'browser score'), el('td', {}, br.scoreMilli === null ? F.EMPTY : F.kcal(BigInt(br.scoreMilli), 3, false))]),
  ])) : null;
  host.replaceChildren(status, el('div', { class: 'pc-two pc-two--check' }, [el('div', {}, [el('div', { class: 'pc-eyebrow' }, 'Geometry proof'), geo]), terms ? el('div', {}, [el('div', { class: 'pc-eyebrow' }, 'Five terms'), terms]) : null]));
}

function paintProvenance() {
  const { run, t, l } = state;
  const box = t && t.box;
  const half = box && box.half ? box.half : null;
  const pocket = [half ? `box ${half.map((h) => F.num(Number(h) * 2, { digits: 1 })).join(' x ')} A` : null, t && t.atoms ? `${F.num(t.atoms)} pocket atoms` : null, t && t.hash ? `hash ${String(t.hash).slice(0, 10)}` : null].filter(Boolean).join(' · ');
  $('[data-provenance]').replaceChildren(ladder([
    ['Target', t ? el('span', { class: 'pc-td-links' }, [el('a', { class: 'pc-link', href: targetHref(t) }, targetName(t)), rcsbStructureLink(t.pdbId)]) : String(run.targetId)],
    t ? ['Structure', `${t.pdbId}${t.resolution ? ` · ${F.num(t.resolution, { digits: 2 })} A` : ''}${t.method ? ` · ${String(t.method).charAt(0) + String(t.method).slice(1).toLowerCase()}` : ''}`, true] : null,
    t && t.ligand && t.ligand.ccd ? ['Reference ligand', el('span', { class: 'pc-td-links' }, [t.ligand.name || t.ligand.ccd, rcsbLigandLink(t.ligand.ccd)])] : null,
    ['Ligand', l ? el('span', { class: 'pc-td-links' }, [el('a', { class: 'pc-link', href: ligandHref(l) }, l.name), ligandSourceLink(l)]) : String(run.ligandId)],
    l && l.formula ? ['Formula', l.formula, true] : null,
    l && l.plant ? ['Source', [l.plant, l.latin ? `(${l.latin})` : null].filter(Boolean).join(' ')] : null,
    pocket ? ['Pocket', pocket, true] : null,
    l && l.hash ? ['Topology hash', String(l.hash).slice(0, 18), true] : null,
    run.poseHash ? ['Pose hash', String(run.poseHash).slice(0, 18), true] : null,
    run.tx ? ['Transaction', outLink(EXPLORER.tx(run.tx), F.shortHash(run.tx)), true] : null,
    run.block ? ['Block', F.num(run.block), true] : null,
  ]));
}

async function paintMethod() {
  const host = $('[data-method]');
  const json = state.method;
  if (!json) { host.replaceChildren(el('p', { class: 'pc-muted' }, STR.methodNone)); return; }
  let parsed = null;
  try { parsed = JSON.parse(json); } catch { parsed = null; }
  if (!parsed || typeof parsed !== 'object') { host.replaceChildren(el('p', { class: 'pc-alert pc-alert--warn' }, STR.methodInvalid), el('pre', { class: 'pc-code pc-method' }, String(json).slice(0, 1024))); return; }
  let valid = true;
  let errors = [];
  const M = await methodMod();
  if (M && typeof M.validateMethod === 'function') {
    try { const v = M.validateMethod(parsed); valid = !!(v && v.ok); errors = Array.isArray(v && v.errors) ? v.errors.map(String) : []; } catch { valid = true; }
  }
  const pre = el('pre', { class: 'pc-code pc-method' }, JSON.stringify(parsed, null, 2));
  const name = typeof parsed.name === 'string' ? parsed.name : null;
  host.replaceChildren(
    name ? el('p', {}, [el('span', { class: 'pc-muted' }, 'Method '), el('strong', {}, name)]) : null,
    pre,
    valid
      ? el('a', { class: 'pc-btn pc-btn--outline', href: `/lab?method=${base64url(JSON.stringify(parsed))}` }, STR.useMethod)
      : el('div', { class: 'pc-stack' }, [el('p', { class: 'pc-alert pc-alert--warn' }, STR.methodInvalid), errors.length ? el('ul', { class: 'pc-error-list' }, errors.map((e) => el('li', {}, e))) : null]),
  );
}

// ---------------------------------------------------------------------------------------------------------
// reviews (SPEC 9.2)

function reviewItem(r) {
  const when = r.time ? (Number(r.time) < 1e12 ? Number(r.time) * 1000 : Number(r.time)) : null;
  return el('article', { class: 'pc-review' }, [
    el('div', { class: 'pc-review-head' }, [walletCell(r.reviewer), stars(r.stars, { size: 14 }), when ? el('span', { class: 'pc-caption' }, F.ago(when)) : null, r.tx ? outLink(EXPLORER.tx(r.tx), 'tx', 'pc-link pc-small') : null]),
    r.note ? textBlock(r.note, 'pc-review-note') : el('p', { class: 'pc-caption' }, 'No note.'),
  ]);
}

function paintReviews() {
  const sum = $('[data-review-summary]');
  const list = $('[data-reviews]');
  const s = reviewSummary(state.reviews);
  sum.replaceChildren(s.count
    ? el('div', { class: 'pc-review-summary' }, [stars(s.avg, { size: 20 }), el('span', { class: 'pc-h3' }, `${F.fixed(s.avg, 1)} of 5`), el('span', { class: 'pc-muted' }, `from ${F.num(s.count)} ${s.count === 1 ? 'review' : 'reviews'}`)])
    : el('div', { class: 'pc-review-summary' }, [stars(0, { size: 20, label: 'No stars yet' }), el('span', { class: 'pc-muted' }, 'No reviews yet')]));
  if (!state.reviews.length) {
    list.replaceChildren(state.reviewsOk ? empty(EMPTY.reviews) : el('p', { class: 'pc-caption' }, 'Reviews are read from chain events; the list appears once the data layer indexes them.'));
    return;
  }
  list.replaceChildren(el('div', { class: 'pc-review-list' }, state.reviews.map(reviewItem)));
}

let picker = null;
async function paintReviewForm() {
  const host = $('[data-review-form]');
  if (!state.run) return;
  const acct = W.account();
  if (!acct) {
    host.replaceChildren(el('div', { class: 'pc-review-gate' }, [el('span', { class: 'pc-muted' }, STR.reviewConnect), el('button', { type: 'button', class: 'pc-btn pc-btn--receptor pc-btn--sm', onclick: () => openWalletMenu() }, 'Connect wallet')]));
    return;
  }
  if (isMe(state.run.wallet)) { host.replaceChildren(el('p', { class: 'pc-muted' }, STR.reviewOwn)); return; }
  const L = await lab();
  const build = L && (L.buildReview || L.buildReviewRun);
  if (!build) { host.replaceChildren(el('p', { class: 'pc-alert pc-alert--warn' }, STR.notLive)); return; }
  const mine = state.reviews.find((r) => String(r.reviewer).toLowerCase() === acct.toLowerCase());
  picker = starsPicker({ value: mine ? mine.stars : 0 });
  const note = el('textarea', { class: 'pc-textarea', maxlength: 280, rows: 3, placeholder: 'What stands out in this test? Plain text, 280 characters at most.', 'aria-label': 'Review note' });
  if (mine && mine.note) note.value = mine.note;
  const counter = el('span', { class: 'pc-counter pc-mono', 'aria-live': 'polite' }, `${note.value.length}/280`);
  note.addEventListener('input', () => { counter.textContent = `${note.value.length}/280`; });
  const btn = el('button', { type: 'submit', class: 'pc-btn pc-btn--primary' }, mine ? 'Replace my review' : 'Send review');
  const form = el('form', { class: 'pc-review-form', onsubmit: async (e) => {
    e.preventDefault();
    const n = picker.value;
    if (!n) { toast(STR.reviewStars, { kind: 'error' }); return; }
    if (new TextEncoder().encode(note.value).length > 280) { toast(STR.reviewNoteLong, { kind: 'error' }); return; }
    btn.setAttribute('aria-busy', 'true');
    btn.disabled = true;
    try {
      const built = build.call(L, Number(state.run.id), n, note.value);
      const { hash, wait } = await W.sendTx(built);
      toast(STR.txSent);
      const r = await wait();
      if (r.status === 'success') { toast([`${STR.reviewSent} `, txLink(hash)], { kind: 'success', ms: 8000 }); const m = await import('../chain.js').catch(() => null); if (m && typeof m.invalidate === 'function') m.invalidate(); await refreshReviews(); }
      else toast(r.error || STR.txFailed, { kind: 'error', ms: 10000 });
    } catch (err) {
      toast(err && err.code === 'rejected' ? STR.rejected : (err && err.message) || STR.txFailed, { kind: 'error', ms: 8000 });
    }
    btn.removeAttribute('aria-busy');
    btn.disabled = false;
  } }, [
    el('h3', { class: 'pc-h4' }, mine ? 'Your review' : 'Write a review'),
    el('label', { class: 'pc-field' }, [el('span', { class: 'pc-label' }, 'Stars'), picker]),
    el('label', { class: 'pc-field' }, [el('span', { class: 'pc-label' }, 'Note'), note, el('span', { class: 'pc-help pc-row pc-row--between' }, [el('span', {}, 'Plain text. Stored on chain with your address.'), counter])]),
    el('div', { class: 'pc-row' }, [btn, el('span', { class: 'pc-caption' }, 'Gas only. A second review replaces the first.')]),
  ]);
  host.replaceChildren(form);
}

async function refreshReviews() {
  const fresh = await runById(state.run.id);
  if (fresh.ok && fresh.run) { state.run = { ...state.run, ...fresh.run }; const an = await analysisOf(state.run.id, state.run); if (an.ok && an.analysis && (!state.analysis || an.analysis.text !== state.analysis.text)) { state.analysis = an.analysis; paintActions(); paintAnalysis(); } }
  const r = await reviewsOf(state.run.id, fresh.ok && fresh.run ? fresh.run : null);
  state.reviews = r.list;
  state.reviewsOk = r.ok;
  paintReviews();
  paintReviewForm();
}

// ---------------------------------------------------------------------------------------------------------
// AI analysis (SPEC 9.8)

let chosen = null;
async function paintAnalysis() {
  const host = $('[data-analysis]');
  if (!state.run) return;
  if (!state.providers) state.providers = await analysisProviders();
  const { providers, ok } = state.providers;
  const connected = providers.filter((p) => p.connected);
  if (!chosen || !connected.some((p) => p.id === chosen)) chosen = connected.length ? connected[0].id : null;
  const author = isMe(state.run.wallet);
  const attached = state.analysis;
  const attachedBlock = attached ? el('div', { class: 'pc-analysis pc-analysis--attached' }, [
    el('div', { class: 'pc-row pc-row--between' }, [el('span', { class: 'pc-chip pc-chip--good pc-chip--mono' }, [icon('chain', 14), 'attached on chain']), el('span', { class: 'pc-caption' }, [attached.provider || 'model', attached.model ? ` · ${attached.model}` : '', attached.tx ? ' · ' : '', attached.tx ? outLink(EXPLORER.tx(attached.tx), 'tx', 'pc-link pc-small') : null])]),
    textBlock(attached.text),
    el('p', { class: 'pc-caption' }, STR.analysisUnverified),
  ]) : null;
  const radios = el('div', { class: 'pc-providers', role: 'radiogroup', 'aria-label': 'Model' }, providers.map((p) => {
    const id = `prov-${p.id.replace(/[^a-z0-9]/gi, '-')}`;
    const input = el('input', { type: 'radio', name: 'provider', id, value: p.id, disabled: !p.connected ? true : null, checked: p.connected && chosen === p.id ? true : null });
    input.addEventListener('change', () => { chosen = p.id; analyzeBtn.disabled = false; });
    return el('label', { class: 'pc-provider', for: id, dataset: { connected: p.connected ? '1' : '0' } }, [input, el('span', { class: 'pc-provider-name' }, p.name), p.model ? el('span', { class: 'pc-caption pc-mono' }, p.model) : null, !p.connected ? el('span', { class: 'pc-chip pc-chip--mono' }, STR.analysisNotConnected) : null]);
  }));
  const analyzeBtn = el('button', { type: 'button', class: 'pc-btn pc-btn--primary', disabled: !chosen ? true : null }, 'Analyze');
  const out = el('div', { class: 'pc-analysis-out' });
  const generated = state.generated;
  const paintOut = () => {
    if (!generated || !generated.text) { out.replaceChildren(); return; }
    const attachBtn = author ? el('button', { type: 'button', class: 'pc-btn pc-btn--outline pc-btn--sm', onclick: () => attach(generated, attachBtn) }, 'Attach analysis on chain') : null;
    out.replaceChildren(el('div', { class: 'pc-analysis' }, [
      el('div', { class: 'pc-row pc-row--between' }, [el('span', { class: 'pc-chip pc-chip--mono' }, [generated.provider, generated.model ? ` · ${generated.model}` : '']), attachBtn]),
      textBlock(generated.text),
      el('p', { class: 'pc-caption' }, STR.analysisUnverified),
    ]));
  };
  analyzeBtn.addEventListener('click', async () => {
    if (!chosen) return;
    analyzeBtn.setAttribute('aria-busy', 'true');
    analyzeBtn.disabled = true;
    const r = await analyzeTest(state.run.id, chosen);
    analyzeBtn.removeAttribute('aria-busy');
    analyzeBtn.disabled = false;
    if (!r.ok) { toast(r.error, { kind: 'error', ms: 8000 }); return; }
    state.generated = { provider: providers.find((p) => p.id === chosen)?.name || r.provider, model: r.model, text: r.text, providerId: chosen };
    paintAnalysis();
  });
  host.replaceChildren(
    attachedBlock,
    el('div', { class: 'pc-stack' }, [
      el('div', { class: 'pc-eyebrow' }, 'Model'),
      radios,
      !ok || !connected.length ? el('p', { class: 'pc-caption' }, STR.analysisNone) : null,
      el('div', { class: 'pc-row' }, [analyzeBtn, el('span', { class: 'pc-caption' }, 'Ten analyses per minute across this server.')]),
    ]),
    out,
  );
  paintOut();
}

async function attach(gen, btn) {
  const L = await lab();
  const build = L && (L.buildAttachAnalysis || L.buildAttach);
  if (!build) { toast(STR.notLive, { kind: 'error' }); return; }
  if (new TextEncoder().encode(gen.text).length > 2048) { toast('The analysis is longer than 2048 bytes, the limit the contract stores. Generate a shorter one.', { kind: 'error', ms: 8000 }); return; }
  btn.setAttribute('aria-busy', 'true');
  btn.disabled = true;
  try {
    const built = build.call(L, Number(state.run.id), gen.providerId || gen.provider, gen.text);
    const { hash, wait } = await W.sendTx(built);
    toast(STR.txSent);
    const r = await wait();
    if (r.status === 'success') {
      toast([`${STR.analysisAttached} `, txLink(hash)], { kind: 'success', ms: 8000 });
      state.analysis = { provider: gen.provider, model: gen.model, text: gen.text, tx: hash };
      state.generated = null;
      paintActions();
      paintAnalysis();
    } else toast(r.error || STR.txFailed, { kind: 'error', ms: 10000 });
  } catch (err) {
    toast(err && err.code === 'rejected' ? STR.rejected : (err && err.message) || STR.txFailed, { kind: 'error', ms: 8000 });
  }
  btn.removeAttribute('aria-busy');
  btn.disabled = false;
}

// ---------------------------------------------------------------------------------------------------------
// actions

$('[data-copy]').addEventListener('click', async () => {
  const ok = await copyText(`${location.origin}/run?id=${state.id}`);
  toast(ok ? STR.linkCopied : 'Could not copy. Try again.', { kind: ok ? 'success' : 'error' });
});
$('[data-download]').addEventListener('click', () => {
  if (!state.run) return;
  const br = state.browser && state.browser.state === 'ok' ? { ...state.browser, note: state.browser.agree ? '' : STR.disagree(F.kcal(BigInt(Math.trunc(milliOf(state.run))), 3, false), state.browser.scoreMilli === null ? F.EMPTY : F.kcal(BigInt(state.browser.scoreMilli), 3, false)) } : null;
  download(`ponchem-docking-test-${state.id}.md`, testMarkdown({ run: state.run, t: state.t, l: state.l, browser: br, reviews: state.reviews, method: state.method, analysis: state.analysis }), 'text/markdown');
  toast(STR.reportDownloaded, { kind: 'success' });
});

// ---------------------------------------------------------------------------------------------------------
// boot

async function main() {
  const raw = qs('id');
  const id = Number(raw);
  if (!raw || !Number.isInteger(id) || id < 1) return notFound(STR.unknownRun);
  state.id = id;
  try { state.cat = await catalog(); } catch { return notFound(STR.catalogFailed); }
  const status = await chain('labStatus');
  if (!isLive(status)) return notFound(chainNote(status));
  const found = await runById(id);
  if (!found.ok) return notFound(found.reason === 'error' ? STR.unreachable : STR.runNotFoundLine);
  if (!found.run) return notFound(null);
  const run = found.run;
  state.run = run;
  state.t = lookup(state.cat.targetById, Number(run.targetId)) || null;
  state.l = lookup(state.cat.ligandById, Number(run.ligandId)) || null;
  paintHeader();
  paintScore();
  paintProvenance();
  const [rv, an, me] = await Promise.all([reviewsOf(run.id, run), analysisOf(run.id, run), methodOf(run)]);
  state.reviews = rv.list;
  state.reviewsOk = rv.ok;
  state.analysis = an.analysis;
  state.method = me.json || '';
  paintActions();
  paintReviews();
  paintReviewForm();
  paintMethod();
  paintAnalysis();
  state.browser = await browserCheck();
  paintCheck();
  if (state.t) {
    let pose = null;
    if (state.l && run.pose && run.pose.length) {
      let poseAbs = state.browser && state.browser.poseAbs ? state.browser.poseAbs : null;
      if (!poseAbs && state.t.box && Array.isArray(state.t.box.center)) { poseAbs = new Float64Array(run.pose.length); for (let i = 0; i < run.pose.length; i++) poseAbs[i] = Number(state.t.box.center[i % 3]) + run.pose[i] / 100; }
      if (poseAbs) { try { pose = { sdfText: await fetchLigandSdf(state.l), poseAbs }; } catch { pose = null; } }
    }
    const box = state.browser && state.browser.pocket ? { center: state.browser.pocket.center, half: state.browser.pocket.half } : state.t.box && state.t.box.center && state.t.box.half ? { center: state.t.box.center, half: state.t.box.half } : null;
    state.viewer = await mountStructure($('[data-viewer]'), { pdbId: state.t.pdbId, refCcd: state.t.ligand && state.t.ligand.ccd, chain: state.t.chain, image: state.t.image, spin: true, pose, box });
  }
  onRefresh(refreshReviews);
}

main().catch(() => notFound(STR.unreachable));
