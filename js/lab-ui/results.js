/*
 * js/lab-ui/results.js: the results panel (SPEC-DESIGN.md 5.7): the empty state before a run, the single-run
 * view (dG with its band, pKd, Kd, ligand efficiency, the five terms, the geometry rows, the method, steps and
 * elapsed) and the screening table (ranked rows, sortable by dG, a Run test button per row, Test best on top).
 * The docking test action (SPEC.md 9.1) lives in a slot the recorder (record.js) fills.
 *
 *   createResults({ host, onRun, onShare, onShowRow, onRecordRow, onRecordBest })
 *   -> { el, actionSlot, showEmpty(), showRun(view), setChain(chain), showScreen(rows), updateRow(id, patch),
 *        rows(), mode() }
 *
 *   view: { target: { pdbId, protein }, ligand: { name, code }, scoreMilli, heavyAtoms, nrot, depthLabel, methodName,
 *           seed, steps, evaluations, elapsedMs, terms, checks: { ok, reason }, chain: null | { scoreMilli, tx, runId } }
 *   screening row: { id, name, code, scoreMilli, state: 'queued' | 'running' | 'done' | 'failed', checksOk,
 *                    chain: null | { scoreMilli, tx }, recording: 'idle' | 'pending' | 'done' | 'error' }
 */
import { el } from '../shell.js';
import { EXPLORER } from '../config.js';
import { icon } from './icons.js';
import { S, fill } from './strings.js';
import { derivedOf, bandOf, fmtDg, fmtPkd, fmtKd, fmtLe, fmtElapsed, termEnergies, fmtTerm, checkRows } from './derive.js';

const runIdText = (runId) => (runId === null || runId === undefined ? null : String(runId).replace(/n$/, ''));

export function createResults({ host, onRun, onShare, onShowRow, onRecordRow, onRecordBest, engine = null }) {
  const root = el('div', { class: 'lab-results', dataset: { labResults: '', mode: 'empty' } });
  host.append(root);
  const actionSlot = el('div', { class: 'lab-action', dataset: { labAction: '' } });
  let mode = 'empty';
  let current = null;
  let rowState = [];
  let sortDir = 'asc';
  const rowNodes = new Map();

  const setMode = (m) => { mode = m; root.dataset.mode = m; };

  function showEmpty() {
    setMode('empty');
    const btn = el('button', { type: 'button', class: 'lab-btn lab-btn-primary' }, S.run);
    btn.addEventListener('click', () => onRun && onRun());
    root.replaceChildren(el('div', { class: 'lab-empty' }, [
      el('img', { src: '/img/brand/mark-mono.svg', alt: '', width: 48, height: 48, class: 'lab-empty-mark' }),
      el('h4', {}, S.emptyTitle),
      el('p', {}, S.emptyLine),
      btn,
    ]));
    current = null;
  }

  const infoButton = (text, label) => {
    const b = el('button', { type: 'button', class: 'lab-info', 'aria-label': label, title: text, 'aria-expanded': 'false' }, icon('info', { size: 16 }));
    const tip = el('span', { class: 'lab-tip', role: 'note', hidden: true }, text);
    b.addEventListener('click', () => { tip.hidden = !tip.hidden; b.setAttribute('aria-expanded', tip.hidden ? 'false' : 'true'); });
    return [b, tip];
  };

  const row = (label, value, { mono = true, info = null, key = null } = {}) => {
    const dt = el('dt', {}, [label, ...(info ? infoButton(info.text, info.label) : [])]);
    const dd = el('dd', { class: mono ? 'lab-mono' : '', dataset: key ? { row: key } : {} }, value);
    return [dt, dd];
  };

  function bigNumber(scoreMilli, chain) {
    const milli = chain ? chain.scoreMilli : scoreMilli;
    const d = derivedOf(milli, current.heavyAtoms, engine);
    const band = bandOf(d.dG);
    return { milli, d, band };
  }

  function showRun(view) {
    current = { ...view };
    setMode('run');
    const { milli, d, band } = bigNumber(view.scoreMilli, view.chain);
    const checks = checkRows(view.checks);
    const geoOk = checks.every((c) => c.ok === true);
    const terms = termEnergies(view.terms, view.nrot);
    const chipChain = el('span', { class: 'lab-chip lab-chip-chain', dataset: { source: 'chain' }, hidden: !view.chain }, [icon('check', { size: 14 }), S.chipChain]);
    const chipBrowser = el('span', { class: 'lab-chip', dataset: { source: 'browser' }, hidden: !!view.chain }, S.chipBrowser);
    const head = el('div', { class: 'lab-results-head' }, [el('span', { class: 'lab-eyebrow' }, S.eyebrowResult), chipBrowser, chipChain]);
    const dg = el('div', { class: 'lab-dg-wrap' }, [
      el('span', { class: 'lab-dg', dataset: { band: band.key, dg: '' } }, fmtDg(milli)),
      el('span', { class: 'lab-dg-unit' }, S.kcal),
    ]);
    const bandLabel = el('div', { class: 'lab-band-label', dataset: { band: band.key } }, band.label);
    const browserSaid = el('p', { class: 'lab-browser-said lab-mono', dataset: { browserSaid: '' }, hidden: !view.chain }, view.chain ? fill(S.browserSaid, { dG: fmtDg(view.scoreMilli) }) : '');
    const chainLine = el('p', { class: 'lab-chain-line', dataset: { chainLine: '' }, hidden: !view.chain });
    if (view.chain) fillChainLine(chainLine, view.chain);
    const rowsEl = el('dl', { class: 'lab-rows' }, [
      ...row(S.rowPkd, fmtPkd(d.pKd), { key: 'pkd', info: { text: S.glossPkd, label: 'What pKd means' } }),
      ...row(S.rowKd, fmtKd(d.kd), { key: 'kd', info: { text: S.glossKd, label: 'What Kd means' } }),
      ...row(S.rowLe, [fmtLe(d.le), el('span', { class: 'lab-unit' }, ` ${S.leUnit}`)], { key: 'le', info: { text: S.glossLe, label: 'What ligand efficiency means' } }),
      ...row(S.rowHeavy, String(view.heavyAtoms), { key: 'heavy' }),
      ...row(S.rowRot, String(view.nrot), { key: 'nrot' }),
      ...row(S.rowMethod, view.methodName || view.depthLabel || '', { mono: false, key: 'method' }),
      ...row(S.rowSeed, String(view.seed), { key: 'seed' }),
      ...(view.steps !== null && view.steps !== undefined
        ? row(S.rowSteps, String(view.steps), { key: 'steps' })
        : row(S.rowEvaluations, String(view.evaluations ?? '--'), { key: 'evaluations' })),
      ...row(S.rowElapsed, fmtElapsed(view.elapsedMs), { key: 'elapsed' }),
    ]);
    const geo = el('div', { class: 'lab-geo', dataset: { geometry: geoOk ? 'pass' : 'fail' } }, [
      el('span', { class: 'lab-eyebrow' }, S.eyebrowGeometry),
      el('ul', { class: 'lab-geo-list' }, checks.map((c) => el('li', { dataset: { check: c.key, ok: c.ok === null ? 'skipped' : c.ok ? 'pass' : 'fail' } }, [
        el('span', { class: 'lab-geo-icon', 'aria-hidden': 'true' }, icon(c.ok === false ? 'cross' : 'check', { size: 18 })),
        el('span', { class: 'lab-visually-hidden' }, c.ok === true ? 'pass: ' : c.ok === false ? 'fail: ' : 'not checked: '),
        c.label,
      ]))),
      geoOk ? null : el('p', { class: 'lab-geo-fail', role: 'alert' }, S.geoFail),
    ]);
    const termsEl = terms ? el('div', { class: 'lab-terms' }, [
      el('span', { class: 'lab-eyebrow' }, S.eyebrowTerms),
      el('dl', { class: 'lab-rows lab-rows-compact' }, [
        ...row(S.termG1, fmtTerm(terms.g1)),
        ...row(S.termG2, fmtTerm(terms.g2)),
        ...row(S.termRep, fmtTerm(terms.rep)),
        ...row(S.termHyd, fmtTerm(terms.hyd)),
        ...row(S.termHb, fmtTerm(terms.hb)),
      ]),
      el('p', { class: 'lab-caption' }, S.termsNote),
    ]) : null;
    const share = el('button', { type: 'button', class: 'lab-btn lab-btn-ghost lab-share' }, [icon('share', { size: 18 }), S.share]);
    share.addEventListener('click', () => onShare && onShare());
    root.replaceChildren(head, dg, bandLabel, browserSaid, chainLine, rowsEl, geo, termsEl, actionSlot, share);
  }

  function fillChainLine(node, chain) {
    const id = runIdText(chain.runId);
    node.replaceChildren(
      el('span', { class: 'lab-mono', dataset: { chainScore: '' } }, fill(S.chainScore, { dG: fmtDg(chain.scoreMilli) })),
      id ? el('a', { class: 'lab-link', href: `/run?id=${encodeURIComponent(id)}`, dataset: { testLink: id } }, fill(S.testNumber, { id })) : null,
      chain.tx ? el('a', { class: 'lab-link', href: EXPLORER.tx(chain.tx), target: '_blank', rel: 'noopener noreferrer' }, [S.viewTx, icon('external', { size: 14 })]) : null,
    );
  }

  /** After the chain scored the run: the big number becomes the chain's, the browser number stays below. */
  function setChain(chain) {
    if (!current || mode !== 'run') return;
    current.chain = chain;
    const { milli, d, band } = bigNumber(current.scoreMilli, chain);
    const big = root.querySelector('[data-dg]');
    if (big) { big.textContent = fmtDg(milli); big.dataset.band = band.key; }
    const bandEl = root.querySelector('.lab-band-label');
    if (bandEl) { bandEl.textContent = band.label; bandEl.dataset.band = band.key; }
    const said = root.querySelector('[data-browser-said]');
    if (said) { said.textContent = fill(S.browserSaid, { dG: fmtDg(current.scoreMilli) }); said.hidden = false; }
    const line = root.querySelector('[data-chain-line]');
    if (line) { fillChainLine(line, chain); line.hidden = false; }
    for (const c of root.querySelectorAll('.lab-chip[data-source]')) c.hidden = c.dataset.source !== 'chain';
    const set = (key, v) => { const n = root.querySelector(`[data-row="${key}"]`); if (n) n.textContent = v; };
    set('pkd', fmtPkd(d.pKd));
    set('kd', fmtKd(d.kd));
    const le = root.querySelector('[data-row="le"]');
    if (le) le.replaceChildren(fmtLe(d.le), el('span', { class: 'lab-unit' }, ` ${S.leUnit}`));
  }

  // ---------------------------------------------------------------------------------------------------------
  // screening

  function sortedRows() {
    const withScore = rowState.filter((r) => r.state === 'done' && Number.isFinite(Number(r.scoreMilli)));
    const rest = rowState.filter((r) => !(r.state === 'done' && Number.isFinite(Number(r.scoreMilli))));
    withScore.sort((a, b) => (sortDir === 'asc' ? Number(a.scoreMilli) - Number(b.scoreMilli) : Number(b.scoreMilli) - Number(a.scoreMilli)));
    return [...withScore, ...rest];
  }

  function paintRow(r, rank) {
    const node = rowNodes.get(r.id);
    if (!node) return;
    node.dataset.state = r.state;
    node.dataset.recording = r.recording || 'idle';
    const shown = r.chain ? r.chain.scoreMilli : r.scoreMilli;
    const d = shown !== null && shown !== undefined ? derivedOf(shown, r.heavyAtoms || 1, engine) : null;
    const band = d ? bandOf(d.dG) : null;
    node.querySelector('.lab-td-rank').textContent = r.state === 'done' ? String(rank) : '';
    const dgCell = node.querySelector('.lab-td-dg');
    dgCell.replaceChildren();
    if (r.state === 'done' && d) {
      dgCell.dataset.band = band.key;
      dgCell.append(el('span', { class: 'lab-band-dot', 'aria-hidden': 'true' }), fmtDg(shown));
    } else if (r.state === 'running') {
      dgCell.append(icon('spinner', { size: 16, className: 'lab-spin' }));
    } else if (r.state === 'failed') {
      dgCell.textContent = '--';
    } else {
      dgCell.textContent = '';
    }
    const act = node.querySelector('.lab-td-act');
    act.replaceChildren();
    if (r.state === 'done') {
      if (r.chain) {
        act.append(el('span', { class: 'lab-chip lab-chip-chain' }, [icon('check', { size: 14 }), S.chipChain]));
        const id = runIdText(r.chain.runId);
        if (id) act.append(el('a', { class: 'lab-link lab-link-icon', href: `/run?id=${encodeURIComponent(id)}`, 'aria-label': S.viewTest, title: S.viewTest }, icon('flask', { size: 16 })));
        if (r.chain.tx) act.append(el('a', { class: 'lab-link lab-link-icon', href: EXPLORER.tx(r.chain.tx), target: '_blank', rel: 'noopener noreferrer', 'aria-label': S.viewTx, title: S.viewTx }, icon('external', { size: 16 })));
      } else if (r.recording === 'pending') {
        act.append(el('span', { class: 'lab-chip' }, [icon('spinner', { size: 14, className: 'lab-spin' }), S.recordPending]));
      } else if (r.checksOk === false) {
        act.append(el('span', { class: 'lab-chip lab-chip-bad', title: S.geoFail }, [icon('cross', { size: 14 }), 'geometry']));
      } else {
        const b = el('button', { type: 'button', class: 'lab-btn lab-btn-ghost lab-btn-sm' }, S.recordRow);
        b.addEventListener('click', (e) => { e.stopPropagation(); onRecordRow && onRecordRow(r); });
        act.append(b);
      }
    }
  }

  function renderTable() {
    const sorted = sortedRows();
    const tbody = root.querySelector('tbody');
    if (!tbody) return;
    // rank 1 is always the best (lowest) score, whichever way the table is sorted
    const ranks = new Map();
    rowState.filter((r) => r.state === 'done' && Number.isFinite(Number(r.scoreMilli)))
      .sort((a, b) => Number(a.scoreMilli) - Number(b.scoreMilli))
      .forEach((r, i) => ranks.set(r.id, i + 1));
    for (const r of sorted) {
      const node = rowNodes.get(r.id);
      if (!node) continue;
      tbody.append(node);
      paintRow(r, ranks.get(r.id) || 0);
    }
    const best = root.querySelector('[data-record-best]');
    if (best) {
      const first = sorted.find((r) => r.state === 'done' && r.checksOk !== false && !r.chain);
      best.disabled = !first;
    }
    const sortBtn = root.querySelector('[data-sort]');
    if (sortBtn) sortBtn.dataset.dir = sortDir;
  }

  function showScreen(rows) {
    setMode('screen');
    rowState = rows.map((r) => ({ recording: 'idle', chain: null, ...r }));
    rowNodes.clear();
    const best = el('button', { type: 'button', class: 'lab-btn lab-btn-primary lab-btn-sm', dataset: { recordBest: '' }, disabled: true }, S.recordBest);
    best.addEventListener('click', () => {
      const first = sortedRows().find((r) => r.state === 'done' && r.checksOk !== false && !r.chain);
      if (first && onRecordBest) onRecordBest(first);
    });
    const sortBtn = el('button', { type: 'button', class: 'lab-th-sort', dataset: { sort: 'dg', dir: sortDir }, 'aria-label': S.sortAria }, ['dG', icon('sort', { size: 14 })]);
    sortBtn.addEventListener('click', () => { sortDir = sortDir === 'asc' ? 'desc' : 'asc'; renderTable(); });
    const table = el('table', { class: 'lab-table' }, [
      el('thead', {}, el('tr', {}, [
        el('th', { scope: 'col', class: 'lab-th-rank' }, '#'),
        el('th', { scope: 'col' }, rows[0] && rows[0].kind === 'target' ? 'Target' : 'Ligand'),
        el('th', { scope: 'col', class: 'lab-th-dg' }, sortBtn),
        el('th', { scope: 'col', class: 'lab-th-act' }, el('span', { class: 'lab-visually-hidden' }, S.record)),
      ])),
      el('tbody', {}),
    ]);
    const tbody = table.querySelector('tbody');
    for (const r of rowState) {
      const nameBtn = el('button', { type: 'button', class: 'lab-td-name-btn' }, [el('span', { class: 'lab-td-code lab-mono' }, r.code || ''), el('span', { class: 'lab-td-name' }, r.name)]);
      nameBtn.addEventListener('click', () => onShowRow && onShowRow(r));
      const node = el('tr', { dataset: { id: String(r.id), state: r.state } }, [
        el('td', { class: 'lab-td-rank lab-mono' }),
        el('td', { class: 'lab-td-namecell' }, nameBtn),
        el('td', { class: 'lab-td-dg lab-mono' }),
        el('td', { class: 'lab-td-act' }),
      ]);
      rowNodes.set(r.id, node);
      tbody.append(node);
    }
    root.replaceChildren(
      el('div', { class: 'lab-results-head' }, [el('span', { class: 'lab-eyebrow' }, S.eyebrowResult), best]),
      el('p', { class: 'lab-caption lab-screen-caption' }, S.rankedBy),
      el('div', { class: 'lab-table-frame' }, table),
      actionSlot,
    );
    renderTable();
  }

  function updateRow(id, patch) {
    const r = rowState.find((x) => x.id === id);
    if (!r) return;
    Object.assign(r, patch);
    renderTable();
  }

  showEmpty();
  return {
    el: root,
    actionSlot,
    showEmpty,
    showRun,
    setChain,
    showScreen,
    updateRow,
    rows: () => rowState.slice(),
    sorted: sortedRows,
    mode: () => mode,
    current: () => current,
  };
}
