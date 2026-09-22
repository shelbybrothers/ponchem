// js/pages/dashboard.js: the dashboard (/dashboard, SPEC 9.5): profile with level, XP and badges, my docking tests,
// best scores, reviews received and written, prizes and withdraw, sponsorships, payment. /wallet forwards here.
import {
  boot, catalog, chain, el, F, STR, EMPTY, milliOf, lookup, empty, table, runsTable, dgCell, bandBadge, targetHref, ligandHref, W, openWalletMenu,
  copyText, toast, withdraw, onRefresh, runTime, isLive, chainNote, gamify, gamifyData, reviewStatsByRun, reviewsCell, stars, walletCell,
  runLink, testPostLink, textBlock, outLink, EXPLORER, badgeTile, TOKEN,
} from './common.js';

boot({ onWallet: () => paint() });
const $ = (s) => document.querySelector(s);
let cat = null;
let painting = false;

$('[data-connect]').addEventListener('click', () => openWalletMenu());
$('[data-copy]').addEventListener('click', async () => {
  const a = W.account();
  if (!a) return;
  toast((await copyText(a)) ? 'Address copied' : 'Could not copy. Try again.', { kind: 'success' });
});

const setStat = (k, node) => {
  const n = document.querySelector(`[data-stat="${k}"]`);
  if (n) n.replaceChildren(...[].concat(node).filter(Boolean));
};
const num = (v, unit) => [document.createTextNode(String(v)), unit ? el('span', { class: 'pc-stat-unit' }, unit) : null];

function setProfile(profile, G) {
  const lvl = profile.level || G.levelOf(profile.xp);
  $('[data-level-name]').textContent = lvl.name;
  $('[data-xp]').textContent = F.num(profile.xp);
  const bar = $('[data-xp-bar]');
  const pct = Math.round((lvl.progress || 0) * 100);
  bar.setAttribute('aria-valuenow', String(pct));
  bar.querySelector('span').style.width = `${pct}%`;
  $('[data-xp-next]').textContent = lvl.next ? `${F.num(lvl.toNext)} XP to ${lvl.next.name} (${F.num(lvl.next.min)} XP)` : 'Top level reached.';
  const earned = new Set(profile.badges || []);
  $('[data-badges]').replaceChildren(...G.BADGES.map((b) => badgeTile(b, earned.has(b.key))));
}

function blankProfile(G) {
  setProfile({ xp: 0, level: G.levelOf(0), badges: [] }, G);
}

function reviewRow(r, { showRun = true, showReviewer = true } = {}) {
  const run = r.run || null;
  const t = run ? lookup(cat.targetById, Number(run.targetId)) : null;
  const l = run ? lookup(cat.ligandById, Number(run.ligandId)) : null;
  const when = r.time ? (Number(r.time) < 1e12 ? Number(r.time) * 1000 : Number(r.time)) : null;
  return el('article', { class: 'pc-review' }, [
    el('div', { class: 'pc-review-head' }, [
      showReviewer ? walletCell(r.reviewer) : null,
      stars(r.stars, { size: 14 }),
      showRun ? el('span', { class: 'pc-small' }, ['on ', runLink(r.runId, `test #${r.runId}`), run && t && l ? el('span', { class: 'pc-muted' }, ` · ${l.name} into ${t.gene || t.key}`) : null]) : null,
      when ? el('span', { class: 'pc-caption' }, F.ago(when)) : null,
      r.tx ? outLink(EXPLORER.tx(r.tx), 'tx', 'pc-link pc-small') : null,
    ]),
    r.note ? textBlock(r.note, 'pc-review-note') : el('p', { class: 'pc-caption' }, 'No note.'),
  ]);
}

async function paint() {
  const account = W.account();
  $('[data-disconnected]').hidden = !!account;
  $('[data-connected]').hidden = !account;
  if (!account || !cat || painting) return;
  painting = true;
  try {
    $('[data-address]').textContent = account;
    const G = await gamify();
    const note = $('[data-chain-note]');
    note.hidden = true;
    const status = await chain('labStatus');
    const live = isLive(status);
    if (!live) {
      note.textContent = chainNote(status);
      note.hidden = false;
      blankProfile(G);
      setStat('tests', num('·'));
      setStat('best', num('·'));
      setStat('reviews', num('·'));
      setStat('prizes', num('·', 'ETH'));
      $('[data-panel="tests"]').replaceChildren(empty(EMPTY.dashTests));
      $('[data-panel="best"]').replaceChildren(empty(EMPTY.dashBest));
      $('[data-panel="reviews-received"]').replaceChildren(empty(EMPTY.reviewsReceived));
      $('[data-panel="reviews-written"]').replaceChildren(empty(EMPTY.reviewsWritten));
      $('[data-panel="prizes"]').replaceChildren(empty(EMPTY.walletPrizes));
      $('[data-panel="sponsorships"]').replaceChildren(empty(EMPTY.walletSponsorships));
      paintPayment(null);
      return;
    }
    const [st, data] = await Promise.all([chain('walletStats', account), gamifyData()]);
    const s = st.ok ? st.value : { runs: 0, best: null, prizes: 0n, owed: 0n, sponsored: [] };
    const profile = G.profileOf(account, data);
    setProfile(profile, G);
    const mine = data.runs.filter((r) => String(r.wallet).toLowerCase() === account.toLowerCase()).sort((a, b) => Number(b.id) - Number(a.id));
    const statsByRun = reviewStatsByRun(data.reviews);
    const runById = new Map(data.runs.map((r) => [Number(r.id), r]));
    const received = data.reviews.filter((r) => { const run = runById.get(r.runId); return run && String(run.wallet).toLowerCase() === account.toLowerCase(); }).map((r) => ({ ...r, run: runById.get(r.runId) }));
    const written = data.reviews.filter((r) => String(r.reviewer).toLowerCase() === account.toLowerCase()).map((r) => ({ ...r, run: runById.get(r.runId) || null }));
    setStat('tests', num(F.num(s.runs ?? mine.length)));
    const best = s.best !== null && s.best !== undefined ? Number(s.best) : (mine.length ? Math.min(...mine.map(milliOf)) : null);
    setStat('best', best === null ? num('·') : [dgCell(best, { plain: true })]);
    const receivedCount = s.reviewsReceived !== undefined && s.reviewsReceived !== null ? Number(s.reviewsReceived) : received.length;
    setStat('reviews', num(F.num(receivedCount)));
    const owed = s.owed !== undefined && s.owed !== null ? BigInt(s.owed) : 0n;
    setStat('prizes', num(F.units(owed, 18, 5), 'ETH'));

    // my docking tests
    const tp = $('[data-panel="tests"]');
    if (mine.length) {
      tp.replaceChildren(table({
        caption: 'My docking tests',
        columns: [
          { label: 'Test', mono: true, render: (r) => runLink(r.id) },
          { label: 'Target', name: true, render: (r) => { const t = lookup(cat.targetById, Number(r.targetId)); return t ? el('a', { href: targetHref(t) }, [el('span', { class: 'pc-td-id' }, t.pdbId), ' ', t.gene || t.key]) : String(r.targetId); } },
          { label: 'Ligand', name: true, render: (r) => { const l = lookup(cat.ligandById, Number(r.ligandId)); return l ? el('a', { href: ligandHref(l) }, l.name) : String(r.ligandId); } },
          { label: 'dG (kcal/mol)', num: true, render: (r) => dgCell(milliOf(r)) },
          { label: 'Band', render: (r) => bandBadge(milliOf(r)) || F.EMPTY },
          { label: 'Reviews', render: (r) => reviewsCell(statsByRun.get(Number(r.id))) },
          { label: 'Actions', wide: true, render: (r) => { const t = lookup(cat.targetById, Number(r.targetId)); const l = lookup(cat.ligandById, Number(r.ligandId)); return el('span', { class: 'pc-row pc-row--tight' }, [outLink(testPostLink(r, t, l), 'Post on X', 'pc-btn pc-btn--ghost pc-btn--sm'), el('a', { class: 'pc-btn pc-btn--outline pc-btn--sm', href: `/run?id=${encodeURIComponent(r.id)}` }, 'Report')]); } },
        ],
        rows: mine.slice(0, 100),
      }));
    } else tp.replaceChildren(empty(EMPTY.dashTests));

    // best scores: best per target
    const bp = $('[data-panel="best"]');
    const bestPer = new Map();
    for (const r of mine) { const k = Number(r.targetId); const cur = bestPer.get(k); if (!cur || milliOf(r) < milliOf(cur)) bestPer.set(k, r); }
    const ranked = [...bestPer.values()].sort((a, b) => milliOf(a) - milliOf(b));
    bp.replaceChildren(ranked.length ? runsTable(ranked.slice(0, 25), cat, { wallet: false, bars: true, reviews: statsByRun, caption: 'Best scores' }) : empty(EMPTY.dashBest));

    // reviews
    const rr = $('[data-panel="reviews-received"]');
    rr.replaceChildren(received.length ? el('div', { class: 'pc-review-list' }, received.slice(0, 50).map((r) => reviewRow(r))) : data.have.reviews ? empty(EMPTY.reviewsReceived) : el('p', { class: 'pc-caption' }, 'Reviews are read from chain events; the list appears once the data layer indexes them.'));
    const rw = $('[data-panel="reviews-written"]');
    rw.replaceChildren(written.length ? el('div', { class: 'pc-review-list' }, written.slice(0, 50).map((r) => reviewRow(r, { showReviewer: false }))) : data.have.reviews ? empty(EMPTY.reviewsWritten) : el('p', { class: 'pc-caption' }, 'Reviews are read from chain events; the list appears once the data layer indexes them.'));

    // prizes
    const pp = $('[data-panel="prizes"]');
    const prizesWon = s.prizes !== undefined && s.prizes !== null ? BigInt(s.prizes) : 0n;
    const wins = data.settled.filter((x) => String(x.winner).toLowerCase() === account.toLowerCase());
    const winRows = wins.length ? el('div', { class: 'pc-card' }, wins.slice(0, 20).map((x) => { const t = lookup(cat.targetById, Number(x.targetId)); return el('div', { class: 'pc-prize-row' }, [el('span', { class: 'pc-mono' }, `${t ? t.gene || t.key : `target ${x.targetId}`} · epoch ${F.num(x.epoch)} · ${F.units(x.amount ?? 0n, 18, 6)} ETH`), el('span', { class: 'pc-badge pc-badge--settled' }, 'settled')]); })) : null;
    if (owed > 0n) {
      const btn = el('button', { type: 'button', class: 'pc-btn pc-btn--primary pc-btn--sm', onclick: async () => { btn.setAttribute('aria-busy', 'true'); btn.disabled = true; const r = await withdraw(); btn.removeAttribute('aria-busy'); btn.disabled = false; if (r && r.status === 'success') paint(); } }, 'Claim');
      pp.replaceChildren(el('div', { class: 'pc-card' }, [
        el('div', { class: 'pc-prize-row' }, [el('span', { class: 'pc-mono' }, `Prizes to claim · ${F.units(owed, 18, 6)} ETH`), btn]),
        prizesWon > 0n ? el('div', { class: 'pc-prize-row' }, [el('span', { class: 'pc-mono' }, `Prizes won so far · ${F.units(prizesWon, 18, 6)} ETH`), el('span', { class: 'pc-badge pc-badge--settled' }, 'settled')]) : null,
      ]), winRows);
    } else if (prizesWon > 0n || wins.length) {
      pp.replaceChildren(el('div', { class: 'pc-card' }, el('div', { class: 'pc-prize-row' }, [el('span', { class: 'pc-mono' }, `Prizes won so far · ${F.units(prizesWon, 18, 6)} ETH`), el('span', { class: 'pc-badge pc-badge--settled' }, 'Claimed')])), winRows);
    } else pp.replaceChildren(empty(EMPTY.walletPrizes));

    // sponsorships
    const sp = $('[data-panel="sponsorships"]');
    const sponsored = Array.isArray(s.sponsored) ? s.sponsored : [];
    if (sponsored.length) {
      sp.replaceChildren(table({
        caption: 'My sponsorships',
        columns: [
          { label: 'Target', name: true, render: (r) => { const t = lookup(cat.targetById, Number(r.targetId)); return t ? el('a', { href: targetHref(t) }, [el('span', { class: 'pc-td-id' }, t.pdbId), ' ', t.gene || t.key]) : String(r.targetId); } },
          { label: 'Amount (ETH)', num: true, render: (r) => F.units(r.amount ?? 0n, 18, 6) },
          { label: 'Sponsorships', num: true, render: (r) => (r.count !== undefined ? F.num(r.count) : r.epoch !== undefined ? String(r.epoch) : F.EMPTY) },
        ],
        rows: sponsored,
      }));
    } else sp.replaceChildren(empty(EMPTY.walletSponsorships));

    paintPayment(status.value);
  } finally {
    painting = false;
  }
}

function paintPayment(status) {
  const line = $('[data-payment-line]');
  const tok = $('[data-payment-token]');
  const fee = status && status.runFee !== undefined && status.runFee !== null && BigInt(status.runFee) > 0n ? F.units(status.runFee, 18, 6) : '0.0001';
  const price = status && status.runPrice !== undefined && status.runPrice !== null && BigInt(status.runPrice) > 0n ? F.units(status.runPrice, 18, 2) : '100';
  line.textContent = `Every docking test costs ${price} $${TOKEN.symbol} or ${fee} ETH, paid to the lab treasury. The payer chooses in the lab.`;
  const tokenLive = !!status && (status.tokenOpen === true || (status.tokenAllowed !== false && !!status.token && !/^0x0{40}$/i.test(String(status.token))));
  tok.replaceChildren(...(tokenLive
    ? [`Both options are open: ${price} $${TOKEN.symbol} from the connected wallet, or ${fee} ETH with the transaction.`]
    : ['While $PONCHEM is not launched only the ETH option works, and the token option reads ', el('span', { class: 'pc-mono' }, STR.tokenSoon), '.']));
}

catalog().then(async (c) => {
  cat = c;
  await paint();
  onRefresh(paint);
}).catch(() => { const n = $('[data-chain-note]'); n.textContent = STR.catalogFailed; n.hidden = false; });
