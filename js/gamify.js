/*
 * js/gamify.js: XP, levels and badges (SPEC.md 9.5), computed from chain data and nothing else. Pure functions,
 * deterministic, no DOM, no imports: the same ledger gives the same profile in the browser, on the server and in
 * the tests. Browser ES module; Node imports it too.
 *
 * INPUT  a ledger, as js/chain.js ledger() / ledgerOf() shape it:
 *   { runs:    [{ id, wallet, targetId, ligandId, scoreMilli, epoch, block, logIndex? }]   ascending id (block order)
 *     settled: [{ targetId, epoch, winner, runId, amount, block, logIndex }]                 Settled events
 *     funded:  [{ targetId, from, amount, block, logIndex }]                                 Funded events
 *     reviews: [{ runId, reviewer, stars, block, logIndex }]                                 Reviewed events; the latest per
 *                                                                                            (run, reviewer) counts, earlier ones are ignored }
 *
 * SHIPPED API
 *   XP                         { test: 10, target: 5, best: 15, review: 3, goodReview: 5, epoch: 25, sponsor: 5 }
 *   XP_RULES                   [{ id, xp, sentence }]  the rules as /docs prints them
 *   LEVELS                     [{ index, name, min }]  Observer 0, Assistant 50, Researcher 150, Senior Researcher 400,
 *                              Principal Investigator 900, Lab Head 2000
 *   BADGES                     [{ id, name, rule, path }]  path = SVG path data on a 24 px grid, drawn with stroke="currentColor",
 *                              stroke-width 1.75, round caps and joins, no fill (SPEC-DESIGN.md 5.15)
 *   levelFor(xp)               -> the LEVELS entry the XP sits in
 *   computeProfile(address, ledger) -> { address, xp, level (index), title, levelMin, next: { index, title, min, remaining } | null,
 *                                        progress (0..1 inside the current level, 1 at the top), badges: [{ id, name, rule, earned, at }],
 *                                        counts: { tests, targets, bests, strongBinders, reviewsWritten, reviewsReceived, goodReviewsReceived,
 *                                                  epochsWon, sponsoredTargets, best (scoreMilli | null) },
 *                                        breakdown: [{ id, label, count, each, xp }] }
 *                              at: { block, runId } | { block, tx } | null  the event that earned the badge, in block order
 *   rankWallets(ledger)        -> [{ rank, address, xp, level, title, tests, best, targets, reviewsWritten, reviewsReceived, epochsWon, badges }]
 *                              every wallet the ledger names, by xp desc, tests desc, best dG asc, address asc
 *   prepare(ledger)            -> the shared derived structures (memoised per ledger object): bestAt (Set of run ids that became
 *                              the best on their target when recorded), resolved reviews, run owners
 *
 * "Best on a target at the time of recording" follows the contract: in run order, a run that scores strictly lower
 * than the best so far on its target (or the first run on that target) becomes the best; ties keep the earlier run.
 */

export const XP = Object.freeze({ test: 10, target: 5, best: 15, review: 3, goodReview: 5, epoch: 25, sponsor: 5 });

export const XP_RULES = Object.freeze([
  { id: 'test', xp: XP.test, label: 'Docking tests', sentence: '10 XP for every docking test recorded on chain.' },
  { id: 'target', xp: XP.target, label: 'Distinct targets', sentence: '5 XP the first time a wallet tests a target.' },
  { id: 'best', xp: XP.best, label: 'Best on a target', sentence: '15 XP for a test that becomes the best on its target at the time of recording.' },
  { id: 'review', xp: XP.review, label: 'Reviews written', sentence: '3 XP for every review written.' },
  { id: 'goodReview', xp: XP.goodReview, label: 'Reviews received with 4 or 5 stars', sentence: '5 XP for every review received with 4 or 5 stars.' },
  { id: 'epoch', xp: XP.epoch, label: 'Epochs won', sentence: '25 XP for every epoch won.' },
  { id: 'sponsor', xp: XP.sponsor, label: 'Targets sponsored', sentence: '5 XP the first time a wallet sponsors a target.' },
].map(Object.freeze));

export const LEVELS = Object.freeze([
  { index: 0, name: 'Observer', min: 0 },
  { index: 1, name: 'Assistant', min: 50 },
  { index: 2, name: 'Researcher', min: 150 },
  { index: 3, name: 'Senior Researcher', min: 400 },
  { index: 4, name: 'Principal Investigator', min: 900 },
  { index: 5, name: 'Lab Head', min: 2000 },
].map(Object.freeze));

export const BADGES = Object.freeze([
  { id: 'first-test', name: 'First test', rule: 'Record one docking test.', path: 'M9 3h6M10 3v6.5L4.6 18.2A2 2 0 0 0 6.3 21h11.4a2 2 0 0 0 1.7-2.8L14 9.5V3' },
  { id: 'ten-tests', name: 'Ten tests', rule: 'Record ten docking tests.', path: 'M3 3h18M5 3v13a2 2 0 0 0 4 0V3M10 3v13a2 2 0 0 0 4 0V3M15 3v13a2 2 0 0 0 4 0V3' },
  { id: 'fifty-tests', name: 'Fifty tests', rule: 'Record fifty docking tests.', path: 'M3 4h18M3 20h18M6 4v16M12 4v16M18 4v16M3 12h18' },
  { id: 'ten-targets', name: 'Ten targets', rule: 'Test ten distinct targets.', path: 'M12 21a9 9 0 1 0 0-18a9 9 0 0 0 0 18zM12 16a4 4 0 1 0 0-8a4 4 0 0 0 0 8zM12 2v3M12 19v3M2 12h3M19 12h3' },
  { id: 'strong-binder', name: 'Strong binder', rule: 'Record a test at or below -9 kcal/mol.', path: 'M13 2L4 14h7l-1 8 9-12h-7l1-8z' },
  { id: 'best-on-target', name: 'Best on a target', rule: 'Record the best test on a target.', path: 'M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4zM7 6H4v2a3 3 0 0 0 3 3M17 6h3v2a3 3 0 0 1-3 3' },
  { id: 'epoch-winner', name: 'Epoch winner', rule: 'Win an epoch on a target.', path: 'M12 15a5 5 0 1 0 0-10a5 5 0 0 0 0 10zM8.5 14L6 22l6-3 6 3-2.5-8' },
  { id: 'sponsor', name: 'Sponsor', rule: 'Fund a prize pool.', path: 'M12 3c-4.4 0-8 1.3-8 3s3.6 3 8 3 8-1.3 8-3-3.6-3-8-3zM4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6' },
  { id: 'reviewer', name: 'Reviewer', rule: 'Write five reviews.', path: 'M4 20l4-1L19 8l-3-3L5 16l-1 4zM14 7l3 3' },
  { id: 'well-reviewed', name: 'Well reviewed', rule: 'Have a test with three or more reviews averaging four stars or more.', path: 'M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9L12 3z' },
].map(Object.freeze));

const STRONG_MILLI = -9000;

export function levelFor(xp) {
  let out = LEVELS[0];
  for (const l of LEVELS) if (xp >= l.min) out = l;
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// shared derived structures

const norm = (a) => String(a || '').toLowerCase();
const num = (v) => (v === null || v === undefined ? 0 : Number(v));
const order = (a, b) => (num(a.block) - num(b.block)) || (num(a.logIndex) - num(b.logIndex));

const prepared = new WeakMap();

export function prepare(ledger) {
  const l = ledger && typeof ledger === 'object' ? ledger : {};
  if (prepared.has(l)) return prepared.get(l);
  const runs = (Array.isArray(l.runs) ? l.runs.slice() : []).filter((r) => r && Number.isFinite(Number(r.id))).sort((a, b) => Number(a.id) - Number(b.id));
  const runOwner = new Map(); // runId -> wallet (lower case)
  const bestAt = new Set(); // run ids that became the best on their target when recorded
  const bestSoFar = new Map(); // targetId -> scoreMilli
  for (const r of runs) {
    runOwner.set(Number(r.id), norm(r.wallet));
    const t = Number(r.targetId);
    const s = Number(r.scoreMilli);
    if (!bestSoFar.has(t) || s < bestSoFar.get(t)) { bestSoFar.set(t, s); bestAt.add(Number(r.id)); }
  }
  // the latest review per (run, reviewer) wins; a review of a run the ledger does not know still counts for its writer
  const latest = new Map();
  for (const v of Array.isArray(l.reviews) ? l.reviews : []) {
    if (!v || !Number.isFinite(Number(v.runId))) continue;
    const key = `${Number(v.runId)}:${norm(v.reviewer)}`;
    const cur = latest.get(key);
    if (!cur || order(cur, v) <= 0) latest.set(key, v);
  }
  const reviews = [...latest.values()].sort(order);
  const settled = (Array.isArray(l.settled) ? l.settled.slice() : []).sort(order);
  const funded = (Array.isArray(l.funded) ? l.funded.slice() : []).sort(order);
  const out = { runs, runOwner, bestAt, reviews, settled, funded };
  prepared.set(l, out);
  return out;
}

const atRun = (r) => ({ block: r.block === undefined ? null : r.block, runId: Number(r.id), tx: r.tx || null });
const atEvent = (e) => ({ block: e.block === undefined ? null : e.block, runId: e.runId === undefined ? null : Number(e.runId), tx: e.tx || null });

// ---------------------------------------------------------------------------------------------------------
// one wallet

export function computeProfile(address, ledger) {
  const me = norm(address);
  const p = prepare(ledger);
  const myRuns = p.runs.filter((r) => norm(r.wallet) === me);
  const targetsSeen = new Set();
  const targetFirst = []; // the run that introduced each distinct target, in order
  let firstStrong = null;
  let firstBest = null;
  let best = null;
  for (const r of myRuns) {
    const t = Number(r.targetId);
    if (!targetsSeen.has(t)) { targetsSeen.add(t); targetFirst.push(r); }
    const s = Number(r.scoreMilli);
    if (best === null || s < best) best = s;
    if (firstStrong === null && s <= STRONG_MILLI) firstStrong = r;
    if (firstBest === null && p.bestAt.has(Number(r.id))) firstBest = r;
  }
  const bests = myRuns.filter((r) => p.bestAt.has(Number(r.id))).length;
  const strongBinders = myRuns.filter((r) => Number(r.scoreMilli) <= STRONG_MILLI).length;
  const written = p.reviews.filter((v) => norm(v.reviewer) === me);
  const received = p.reviews.filter((v) => p.runOwner.get(Number(v.runId)) === me);
  const good = received.filter((v) => Number(v.stars) >= 4);
  // well reviewed: the review (in block order) at which one of my tests first held 3+ reviews averaging 4+
  let wellAt = null;
  const perRun = new Map(); // runId -> { count, sum }
  for (const v of p.reviews) {
    if (wellAt) break;
    if (p.runOwner.get(Number(v.runId)) !== me) continue;
    // the resolved list holds one entry per reviewer, so counts are exact
    const s = perRun.get(Number(v.runId)) || { count: 0, sum: 0 };
    s.count++;
    s.sum += Number(v.stars);
    perRun.set(Number(v.runId), s);
    if (s.count >= 3 && s.sum / s.count >= 4) wellAt = atEvent(v);
  }
  const won = p.settled.filter((s) => norm(s.winner) === me);
  const mine = p.funded.filter((f) => norm(f.from) === me);
  const sponsoredSeen = new Set();
  const sponsoredFirst = [];
  for (const f of mine) { const t = Number(f.targetId); if (!sponsoredSeen.has(t)) { sponsoredSeen.add(t); sponsoredFirst.push(f); } }

  const counts = {
    tests: myRuns.length,
    targets: targetFirst.length,
    bests,
    strongBinders,
    reviewsWritten: written.length,
    reviewsReceived: received.length,
    goodReviewsReceived: good.length,
    epochsWon: won.length,
    sponsoredTargets: sponsoredFirst.length,
    best,
  };
  const breakdown = [
    { id: 'test', count: counts.tests },
    { id: 'target', count: counts.targets },
    { id: 'best', count: counts.bests },
    { id: 'review', count: counts.reviewsWritten },
    { id: 'goodReview', count: counts.goodReviewsReceived },
    { id: 'epoch', count: counts.epochsWon },
    { id: 'sponsor', count: counts.sponsoredTargets },
  ].map((b) => { const rule = XP_RULES.find((r) => r.id === b.id); return { id: b.id, label: rule.label, count: b.count, each: rule.xp, xp: b.count * rule.xp }; });
  const xp = breakdown.reduce((n, b) => n + b.xp, 0);
  const level = levelFor(xp);
  const nextLevel = LEVELS[level.index + 1] || null;
  const progress = nextLevel ? Math.max(0, Math.min(1, (xp - level.min) / (nextLevel.min - level.min))) : 1;

  const earned = {
    'first-test': myRuns.length >= 1 ? atRun(myRuns[0]) : null,
    'ten-tests': myRuns.length >= 10 ? atRun(myRuns[9]) : null,
    'fifty-tests': myRuns.length >= 50 ? atRun(myRuns[49]) : null,
    'ten-targets': targetFirst.length >= 10 ? atRun(targetFirst[9]) : null,
    'strong-binder': firstStrong ? atRun(firstStrong) : null,
    'best-on-target': firstBest ? atRun(firstBest) : null,
    'epoch-winner': won.length ? atEvent(won[0]) : null,
    'sponsor': sponsoredFirst.length ? atEvent(sponsoredFirst[0]) : null,
    'reviewer': written.length >= 5 ? atEvent(written[4]) : null,
    'well-reviewed': wellAt,
  };
  const badges = BADGES.map((b) => ({ id: b.id, name: b.name, rule: b.rule, earned: !!earned[b.id], at: earned[b.id] || null }));

  return {
    address,
    xp,
    level: level.index,
    title: level.name,
    levelMin: level.min,
    next: nextLevel ? { index: nextLevel.index, title: nextLevel.name, min: nextLevel.min, remaining: nextLevel.min - xp } : null,
    progress,
    badges,
    counts,
    breakdown,
  };
}

// ---------------------------------------------------------------------------------------------------------
// the leaderboard

export function rankWallets(ledger) {
  const p = prepare(ledger);
  const wallets = new Map(); // lower -> as written
  const add = (a) => { if (a && typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a) && !wallets.has(norm(a))) wallets.set(norm(a), a); };
  for (const r of p.runs) add(r.wallet);
  for (const v of p.reviews) add(v.reviewer);
  for (const f of p.funded) add(f.from);
  for (const s of p.settled) add(s.winner);
  const rows = [...wallets.values()].map((address) => {
    const pr = computeProfile(address, ledger);
    return {
      address,
      xp: pr.xp,
      level: pr.level,
      title: pr.title,
      tests: pr.counts.tests,
      best: pr.counts.best,
      targets: pr.counts.targets,
      reviewsWritten: pr.counts.reviewsWritten,
      reviewsReceived: pr.counts.reviewsReceived,
      epochsWon: pr.counts.epochsWon,
      badges: pr.badges.filter((b) => b.earned).length,
    };
  });
  rows.sort((a, b) => (b.xp - a.xp) || (b.tests - a.tests) || ((a.best === null ? Infinity : a.best) - (b.best === null ? Infinity : b.best)) || (norm(a.address) < norm(b.address) ? -1 : 1));
  rows.forEach((r, i) => { r.rank = i + 1; });
  return rows;
}
