/*
 * js/pages/xp.js: the gamification rules of SPEC.md 9.5, computed client-side from chain data, deterministic.
 * js/pages/common.js prefers js/gamify.js (the data layer's module) when it exports the same names and shapes;
 * this file is the reference implementation the pages fall back to, and what /docs documents.
 *
 *   LEVELS                       [{ key, name, min }] Observer 0 .. Lab Head 2000
 *   XP_RULES                     [{ key, points, text }] the seven ways to earn XP
 *   BADGES                       [{ key, name, rule, icon }] the ten badges (icon: a name in common.js ICONS)
 *   levelOf(xp)                  { index, key, name, min, next: { name, min } | null, progress 0..1, toNext }
 *   buildProfiles(data)          Map<wallet lower, Profile> from { runs (ascending id), reviews, settled, funded, bests }
 *   profileOf(address, data)     Profile for one wallet (an empty one when it has nothing on chain)
 *   rankWallets(data | Map)      Profile[] by XP, then tests, then best dG
 *
 * Profile { wallet, xp, level, tests, targets (count), best (scoreMilli | null), strong (count), currentBest (count),
 *           bestAtRecord (count), reviewsWritten, reviewsReceived, goodReviewsReceived, epochsWon, sponsoredTargets,
 *           wellReviewed (count), badges: [key], breakdown: { [rule key]: points } }
 */

export const LEVELS = Object.freeze([
  { key: 'observer', name: 'Observer', min: 0 },
  { key: 'assistant', name: 'Assistant', min: 50 },
  { key: 'researcher', name: 'Researcher', min: 150 },
  { key: 'senior', name: 'Senior Researcher', min: 400 },
  { key: 'pi', name: 'Principal Investigator', min: 900 },
  { key: 'head', name: 'Lab Head', min: 2000 },
].map(Object.freeze));

export const XP_RULES = Object.freeze([
  { key: 'test', points: 10, text: 'per docking test' },
  { key: 'target', points: 5, text: 'per distinct target tested (the first time)' },
  { key: 'best', points: 15, text: 'per test that becomes the best on its target when it is recorded' },
  { key: 'review', points: 3, text: 'per review written' },
  { key: 'received', points: 5, text: 'per review received with 4 or 5 stars' },
  { key: 'epoch', points: 25, text: 'per epoch won' },
  { key: 'sponsor', points: 5, text: 'per target sponsored (the first time)' },
].map(Object.freeze));

export const BADGES = Object.freeze([
  { key: 'first-test', name: 'First test', rule: 'One docking test recorded.', icon: 'first-test' },
  { key: 'ten-tests', name: 'Ten tests', rule: 'Ten docking tests recorded.', icon: 'ten-tests' },
  { key: 'fifty-tests', name: 'Fifty tests', rule: 'Fifty docking tests recorded.', icon: 'fifty-tests' },
  { key: 'ten-targets', name: 'Ten targets', rule: 'Tests on ten distinct targets.', icon: 'ten-targets' },
  { key: 'strong-binder', name: 'Strong binder', rule: 'A test at or below -9 kcal/mol.', icon: 'strong-binder' },
  { key: 'best-on-target', name: 'Best on a target', rule: 'A test that holds the best score on its target.', icon: 'best-on-target' },
  { key: 'epoch-winner', name: 'Epoch winner', rule: 'An epoch settled in your favour.', icon: 'epoch-winner' },
  { key: 'sponsor', name: 'Sponsor', rule: 'A prize pool funded.', icon: 'sponsor' },
  { key: 'reviewer', name: 'Reviewer', rule: 'Five reviews written.', icon: 'reviewer' },
  { key: 'well-reviewed', name: 'Well reviewed', rule: 'An own test with three or more reviews averaging 4 or better.', icon: 'well-reviewed' },
].map(Object.freeze));

const low = (a) => String(a || '').toLowerCase();
const num = (v) => (typeof v === 'bigint' ? Number(v) : Number(v));

export function levelOf(xp) {
  const x = Math.max(0, Number(xp) || 0);
  let index = 0;
  for (let i = 0; i < LEVELS.length; i++) if (x >= LEVELS[i].min) index = i;
  const here = LEVELS[index];
  const next = LEVELS[index + 1] || null;
  const span = next ? next.min - here.min : 1;
  return { index, key: here.key, name: here.name, min: here.min, next, progress: next ? Math.min(1, (x - here.min) / span) : 1, toNext: next ? Math.max(0, next.min - x) : 0 };
}

const blank = (wallet) => ({
  wallet, xp: 0, level: levelOf(0), tests: 0, targets: 0, best: null, strong: 0, currentBest: 0, bestAtRecord: 0,
  reviewsWritten: 0, reviewsReceived: 0, goodReviewsReceived: 0, epochsWon: 0, sponsoredTargets: 0, wellReviewed: 0,
  badges: [], breakdown: { test: 0, target: 0, best: 0, review: 0, received: 0, epoch: 0, sponsor: 0 },
});

/** data: { runs (any order; sorted here by id), reviews, settled, funded, bests } */
export function buildProfiles({ runs = [], reviews = [], settled = [], funded = [], bests = null } = {}) {
  const profiles = new Map();
  const get = (wallet) => { const k = low(wallet); let p = profiles.get(k); if (!p) { p = blank(wallet); profiles.set(k, p); } return p; };
  const targetsOf = new Map(); // wallet -> Set(targetId)
  const bestOnTarget = new Map(); // targetId -> scoreMilli
  const runById = new Map();
  const sorted = runs.slice().sort((a, b) => num(a.id) - num(b.id));
  for (const r of sorted) {
    if (!r || !r.wallet) continue;
    runById.set(num(r.id), r);
    const p = get(r.wallet);
    const k = low(r.wallet);
    const score = num(r.scoreMilli);
    p.tests++;
    p.breakdown.test += 10;
    let set = targetsOf.get(k);
    if (!set) { set = new Set(); targetsOf.set(k, set); }
    if (!set.has(num(r.targetId))) { set.add(num(r.targetId)); p.breakdown.target += 5; }
    if (Number.isFinite(score)) {
      if (p.best === null || score < p.best) p.best = score;
      if (score <= -9000) p.strong++;
      const cur = bestOnTarget.get(num(r.targetId));
      if (cur === undefined || score < cur) { bestOnTarget.set(num(r.targetId), score); p.bestAtRecord++; p.breakdown.best += 15; }
    }
  }
  for (const [k, set] of targetsOf) get(profiles.get(k).wallet).targets = set.size;
  // the current best per target: the data layer's bests when given, else the walk above
  if (bests && bests.byTarget) {
    const entries = bests.byTarget instanceof Map ? bests.byTarget.values() : Object.values(bests.byTarget);
    for (const run of entries) if (run && run.wallet) get(run.wallet).currentBest++;
  } else {
    const holder = new Map();
    for (const r of sorted) { const s = num(r.scoreMilli); const t = num(r.targetId); const cur = holder.get(t); if (!cur || s < cur.score) holder.set(t, { score: s, wallet: r.wallet }); }
    for (const h of holder.values()) get(h.wallet).currentBest++;
  }
  const perRun = new Map(); // runId -> [stars]
  for (const rv of reviews) {
    if (!rv || !rv.reviewer) continue;
    const p = get(rv.reviewer);
    p.reviewsWritten++;
    p.breakdown.review += 3;
    const run = runById.get(num(rv.runId));
    if (run && run.wallet) {
      const o = get(run.wallet);
      o.reviewsReceived++;
      if (num(rv.stars) >= 4) { o.goodReviewsReceived++; o.breakdown.received += 5; }
      const list = perRun.get(num(rv.runId)) || [];
      list.push(num(rv.stars));
      perRun.set(num(rv.runId), list);
    }
  }
  for (const [id, list] of perRun) {
    const run = runById.get(id);
    if (run && list.length >= 3 && list.reduce((a, b) => a + b, 0) / list.length >= 4) get(run.wallet).wellReviewed++;
  }
  for (const s of settled) { if (s && s.winner) { const p = get(s.winner); p.epochsWon++; p.breakdown.epoch += 25; } }
  const sponsoredOf = new Map();
  for (const f of funded) {
    if (!f || !f.from) continue;
    const k = low(f.from);
    let set = sponsoredOf.get(k);
    if (!set) { set = new Set(); sponsoredOf.set(k, set); }
    if (!set.has(num(f.targetId))) { set.add(num(f.targetId)); const p = get(f.from); p.sponsoredTargets++; p.breakdown.sponsor += 5; }
  }
  for (const p of profiles.values()) {
    p.xp = Object.values(p.breakdown).reduce((a, b) => a + b, 0);
    p.level = levelOf(p.xp);
    p.badges = badgesOf(p);
  }
  return profiles;
}

export function badgesOf(p) {
  const out = [];
  if (p.tests >= 1) out.push('first-test');
  if (p.tests >= 10) out.push('ten-tests');
  if (p.tests >= 50) out.push('fifty-tests');
  if (p.targets >= 10) out.push('ten-targets');
  if (p.strong >= 1) out.push('strong-binder');
  if (p.currentBest >= 1) out.push('best-on-target');
  if (p.epochsWon >= 1) out.push('epoch-winner');
  if (p.sponsoredTargets >= 1) out.push('sponsor');
  if (p.reviewsWritten >= 5) out.push('reviewer');
  if (p.wellReviewed >= 1) out.push('well-reviewed');
  return out;
}

export function profileOf(address, data) {
  const map = data instanceof Map ? data : buildProfiles(data);
  return map.get(low(address)) || blank(address);
}

export function rankWallets(data) {
  const map = data instanceof Map ? data : buildProfiles(data);
  return [...map.values()].sort((a, b) => b.xp - a.xp || b.tests - a.tests || (a.best ?? Infinity) - (b.best ?? Infinity) || low(a.wallet).localeCompare(low(b.wallet)));
}
