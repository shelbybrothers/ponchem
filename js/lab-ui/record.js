/*
 * js/lab-ui/record.js: the docking test flow of the lab (SPEC.md 9.1 "paid docking tests", 9.7 the method string,
 * SPEC-DESIGN.md 5.7 action states). A docking test is the on-chain step: the pose found in the browser is
 * submitted, the contract proves the geometry, scores it and records it.
 *
 *   createRecorder({ slots: [Element...], chain, lab, getRun, onChain, onState })
 *     chain: the js/chain.js module (or null), lab: the js/lab.js module (or null); getRun() -> the run that the
 *     button would test: { target, ligand, result: { poseCenti, scoreMilli, checks }, methodJson: '' | compact JSON,
 *     chain: null | {...} }
 *   -> { update(), record(run), status(), refreshStatus(), busy(), live(), payment(), setPayment('eth' | 'token') }
 *
 * Payment (9.1): every docking test costs runPrice $PONCHEM or runFee ETH, paid to the lab treasury; the payer
 * chooses with two radio-style cards. The token card is disabled with `after the $PONCHEM launch` while
 * labStatus().token is null or tokenAllowed is false. The ETH card is disabled while ethAllowed is false.
 * Token path: the ERC-20 balance and allowance are read first (js/lab.js tokenBalanceOf(token, owner) and
 * allowanceOf(token, owner, spender), else the plain ERC-20 calls); when the allowance is short an Approve step
 * (js/lab.js buildApprove(token, spender, amount)) runs before submitRun.
 *
 * Button states, in precedence: lab not live (LAB.address null or labStatus().live false) -> disabled with the
 * not-live line; no run or a geometry failure -> disabled; recorded -> "Recorded" plus the links; approving ->
 * "Approving $PONCHEM"; pending -> "Waiting for the chain"; no wallet -> "Connect wallet to run the test" (opens the
 * wallet menu); wrong network -> "Switch to Robinhood Chain"; else "Run docking test".
 *
 * record(run): quote() first (eth_call through js/lab.js; the chain's dry run number is shown, a refusal is
 * explained in plain words and nothing is sent), then the payment checks, then
 * buildSubmitRun(targetId, ligandId, pose, { payWithToken, methodJson, runFee }) + sendTx(), then wait for the
 * receipt, decode RunScored from the logs (binding signature of SPEC.md 8.2) and hand the chain's score to
 * onChain(run, { scoreMilli, tx, runId }). The page then shows the chain's number as the final one.
 */
import { el, toast, openWalletMenu } from '../shell.js';
import * as W from '../wallet.js';
import { CHAIN, EXPLORER, LAB, TOKEN } from '../config.js';
import { parseFragment, decodeAbi, multicall, isAddress, encodeCall } from '../rpc.js';
import { units } from '../format.js';
import { icon } from './icons.js';
import { S, fill } from './strings.js';
import { fmtDg } from './derive.js';

const RUN_SCORED = parseFragment('event RunScored(uint256 indexed runId, address indexed wallet, uint16 indexed targetId, uint16 ligandId, int32 scoreMilli, uint32 epoch, int16[] pose)');
const ERC20_BALANCE = 'function balanceOf(address owner) view returns (uint256)';
const ERC20_DECIMALS = 'function decimals() view returns (uint8)';
const ERC20_ALLOWANCE = 'function allowance(address owner, address spender) view returns (uint256)';
const ERC20_APPROVE = 'function approve(address spender, uint256 amount) returns (bool)';
// SPEC.md 9.1: runPrice defaults to 100e18. Shown only while labStatus() carries no runPrice (a v1 status).
const DEFAULT_RUN_PRICE = 100n * 10n ** 18n;

const ZERO = /^0x0{40}$/i;

/** The RunScored event of a receipt, decoded, or null. */
export function decodeRunScored(logs, to) {
  for (const log of logs || []) {
    if (!log || !Array.isArray(log.topics) || (log.topics[0] || '').toLowerCase() !== RUN_SCORED.topic.toLowerCase()) continue;
    if (to && log.address && String(log.address).toLowerCase() !== String(to).toLowerCase()) continue;
    try {
      const [ligandId, scoreMilli, epoch, pose] = decodeAbi(['uint16', 'int32', 'uint32', 'int16[]'], log.data);
      return {
        runId: BigInt(log.topics[1]),
        wallet: '0x' + String(log.topics[2]).slice(-40),
        targetId: Number(BigInt(log.topics[3])),
        ligandId: Number(ligandId),
        scoreMilli: Number(scoreMilli),
        epoch: Number(epoch),
        pose: pose.map(Number),
      };
    } catch {
      return null;
    }
  }
  return null;
}

const feeText = (wei) => units(wei ?? 0n, 18, 6);
const asBig = (v, d = 0n) => { try { return v === null || v === undefined ? d : BigInt(v); } catch { return d; } };

export function createRecorder({ slots = [], chain = null, lab = null, getRun, onChain, onState }) {
  let status = null; // labStatus()
  let statusError = null;
  let busy = null; // { run, phase: 'quote' | 'allowance' | 'approve' | 'send' | 'wait', hash, approveHash }
  let quoteLine = null; // { run, text, kind }
  let statusTimer = null;
  let pay = 'eth'; // 'eth' | 'token'
  let tokenMeta = { address: null, decimals: 18 };

  const wallet = () => ({ account: W.account(), chainId: W.chainId() });
  const wrongNetwork = () => !!W.account() && W.chainId() !== null && W.chainId() !== CHAIN.id;
  // the contract address: js/lab.js honours the localhost ?contract= override; without it, js/config.js
  const address = () => (lab && typeof lab.labAddress === 'function' ? lab.labAddress() : LAB.address);
  const live = () => !!(address() && status && status.live);
  const tokenAddress = () => (status && status.token && !ZERO.test(String(status.token)) && isAddress(status.token) ? status.token : null);
  const tokenOn = () => !!tokenAddress() && status.tokenAllowed === true;
  const ethOn = () => !status || status.ethAllowed !== false;
  const runPrice = () => (status && status.runPrice !== undefined && status.runPrice !== null ? asBig(status.runPrice, DEFAULT_RUN_PRICE) : DEFAULT_RUN_PRICE);
  const runFee = () => asBig(status && status.runFee, 0n);
  const priceText = () => units(runPrice(), tokenMeta.decimals, 2);
  const payWithToken = () => pay === 'token' && tokenOn();

  async function refreshStatus() {
    if (!chain || typeof chain.labStatus !== 'function' || !address()) { status = { live: false, reason: lab && lab.NOT_LIVE ? lab.NOT_LIVE : S.labNotLive }; render(); return status; }
    try {
      status = await chain.labStatus();
      statusError = null;
      // live:false with a transient reason: try again in a while
      if (!status.live && !statusTimer) statusTimer = setTimeout(() => { statusTimer = null; refreshStatus(); }, 30000);
    } catch (e) {
      statusError = e;
      if (!status) status = { live: false, unreachable: true, reason: S.errChain };
      if (!statusTimer) statusTimer = setTimeout(() => { statusTimer = null; refreshStatus(); }, 30000);
    }
    render();
    refreshTokenMeta().catch(() => null);
    return status;
  }

  async function refreshTokenMeta() {
    const t = tokenAddress();
    if (!t || tokenMeta.address === t) return;
    tokenMeta = { address: t, decimals: 18 };
    try {
      const [dec] = await multicall([{ target: t, fn: ERC20_DECIMALS, args: [] }]);
      if (dec.ok) { const d = Number(dec.value); if (Number.isInteger(d) && d >= 0 && d <= 36) tokenMeta.decimals = d; }
    } catch { /* 18 */ }
    render();
  }

  /** The $PONCHEM balance of `acct`, or null when it cannot be read (the check is then skipped, the chain decides). */
  async function tokenBalance(acct) {
    const t = tokenAddress();
    if (!t) return null;
    if (lab && typeof lab.tokenBalanceOf === 'function') {
      try { return asBig(await lab.tokenBalanceOf(t, acct), null); } catch { /* the plain read below */ }
    }
    try {
      const [bal] = await multicall([{ target: t, fn: ERC20_BALANCE, args: [acct] }]);
      return bal.ok ? asBig(bal.value, null) : null;
    } catch { return null; }
  }

  /** The $PONCHEM allowance the lab holds from `acct`: js/lab.js allowanceOf(token, owner, spender), else the ERC-20 read. */
  async function allowanceOf(acct) {
    const t = tokenAddress();
    const spender = address();
    if (lab && typeof lab.allowanceOf === 'function') {
      try {
        const v = await lab.allowanceOf(t, acct, spender);
        if (v !== undefined && v !== null) return asBig(v, 0n);
      } catch { /* the plain read below */ }
    }
    const [r] = await multicall([{ target: t, fn: ERC20_ALLOWANCE, args: [acct, spender] }]);
    if (!r.ok) throw new Error('Could not read the $PONCHEM allowance. Try again.');
    return asBig(r.value, 0n);
  }

  /** The approve transaction: js/lab.js buildApprove(token, spender, amount), else the plain ERC-20 call. */
  function buildApprove(amount) {
    const t = tokenAddress();
    const spender = address();
    if (lab && typeof lab.buildApprove === 'function') {
      try {
        const built = lab.buildApprove(t, spender, amount);
        if (built && isAddress(built.to) && typeof built.data === 'string') return { to: built.to, data: built.data, value: built.value || '0x0' };
      } catch { /* the plain call below */ }
    }
    return { to: t, data: encodeCall(ERC20_APPROVE, [spender, amount]), value: '0x0' };
  }

  function stateOf() {
    const run = getRun ? getRun() : null;
    if (!lab || !chain || !live()) return { key: 'not-live', run };
    if (!run) return { key: 'no-run', run };
    if (busy && busy.run === run) return { key: busy.phase === 'wait' ? 'pending' : busy.phase === 'approve' ? 'approving' : 'quoting', run };
    if (run.chain) return { key: 'done', run };
    if (run.result && run.result.checks && run.result.checks.ok === false) return { key: 'geometry', run };
    const w = wallet();
    if (!w.account) return { key: 'connect', run };
    if (wrongNetwork()) return { key: 'switch', run };
    if (busy) return { key: 'busy', run };
    return { key: 'ready', run };
  }

  function button(state) {
    const b = el('button', { type: 'button', class: 'lab-btn lab-btn-record', dataset: { record: state.key } });
    switch (state.key) {
      case 'not-live':
        b.classList.add('lab-btn-primary'); b.disabled = true; b.append(S.record); break;
      case 'no-run':
      case 'geometry':
      case 'busy':
        b.classList.add('lab-btn-primary'); b.disabled = true; b.append(S.record);
        if (state.key === 'geometry') b.title = S.geoFail;
        break;
      case 'quoting':
        b.classList.add('lab-btn-primary'); b.disabled = true; b.append(icon('spinner', { size: 18, className: 'lab-spin' }), S.record); break;
      case 'approving':
        b.classList.add('lab-btn-primary'); b.disabled = true; b.append(icon('spinner', { size: 18, className: 'lab-spin' }), S.recordApproving); break;
      case 'pending':
        b.classList.add('lab-btn-primary'); b.disabled = true; b.append(icon('spinner', { size: 18, className: 'lab-spin' }), S.recordPending); break;
      case 'done':
        b.classList.add('lab-btn-done'); b.disabled = true; b.append(icon('check', { size: 18 }), S.recordDone); break;
      case 'connect':
        b.classList.add('lab-btn-receptor'); b.append(icon('wallet', { size: 18 }), S.recordConnect);
        b.addEventListener('click', () => openWalletMenu());
        break;
      case 'switch':
        b.classList.add('lab-btn-warn'); b.append(icon('alert', { size: 18 }), S.recordSwitch);
        b.addEventListener('click', async () => { try { await W.ensureChain(); } catch (e) { toast(e && e.message ? e.message : S.errRejected, { kind: 'error' }); } render(); });
        break;
      default:
        b.classList.add('lab-btn-primary'); b.append(icon('chain', { size: 18 }), S.record);
        b.addEventListener('click', () => record(state.run));
    }
    return b;
  }

  /** The two payment cards (SPEC.md 9.1): Pay {fee} ETH, Pay {price} $PONCHEM. */
  function payCards(state) {
    const locked = !!busy || state.key === 'done';
    const card = (key, label, note, enabled) => {
      const checked = pay === key;
      const c = el('button', {
        type: 'button', role: 'radio', class: 'lab-pay-card', dataset: { pay: key, on: enabled ? '1' : '0' },
        'aria-checked': checked ? 'true' : 'false', 'aria-disabled': enabled ? 'false' : 'true', disabled: !enabled || locked,
      }, [
        el('span', { class: 'lab-pay-dot', 'aria-hidden': 'true' }),
        el('span', { class: 'lab-pay-text' }, [el('span', { class: 'lab-pay-label' }, label), note ? el('span', { class: 'lab-pay-note lab-mono', dataset: { payNote: key } }, note) : null]),
      ]);
      c.addEventListener('click', () => { if (!enabled || locked) return; pay = key; render(); });
      return c;
    };
    const eth = card('eth', fill(S.payEth, { fee: feeText(runFee()) }), ethOn() ? null : S.payEthOff, ethOn());
    const tok = card('token', fill(S.payToken, { price: priceText() }), tokenOn() ? null : S.payTokenSoon, tokenOn());
    return el('div', { class: 'lab-pay', role: 'radiogroup', 'aria-label': S.payAria, dataset: { labPay: pay } }, [eth, tok]);
  }

  function lines(state) {
    const out = [];
    if (state.key === 'not-live') {
      // js/chain.js names the reason (NOT_LIVE or UNREACHABLE); without it, the same sentence in our words
      const reason = (status && typeof status.reason === 'string' && status.reason) || (status && status.unreachable ? S.errChain : S.labNotLive);
      out.push(el('p', { class: 'lab-caption lab-record-note', dataset: { recordNote: 'not-live' } }, reason));
      return out;
    }
    if (status && status.runFee !== undefined) {
      out.push(el('p', { class: 'lab-caption lab-mono lab-fee', dataset: { fee: '' } }, fill(S.feeLine, { price: priceText(), fee: feeText(runFee()) })));
    }
    if (quoteLine && state.run && quoteLine.run === state.run) {
      out.push(el('p', { class: `lab-caption lab-mono lab-quote lab-quote-${quoteLine.kind}`, dataset: { quote: quoteLine.kind } }, quoteLine.text));
    }
    const txLink = (hash, label = S.viewTx) => el('p', { class: 'lab-caption' }, el('a', { class: 'lab-link', href: EXPLORER.tx(hash), target: '_blank', rel: 'noopener noreferrer' }, [label, icon('external', { size: 14 })]));
    if (state.key === 'approving' && busy && busy.approveHash) out.push(txLink(busy.approveHash));
    if (state.key === 'pending' && busy && busy.hash) out.push(txLink(busy.hash));
    if (state.key === 'done' && state.run.chain) {
      const id = state.run.chain.runId !== null && state.run.chain.runId !== undefined ? String(state.run.chain.runId) : null;
      if (id) out.push(el('p', { class: 'lab-caption' }, el('a', { class: 'lab-link', href: `/run?id=${encodeURIComponent(id)}`, dataset: { testLink: id } }, [S.viewTest, icon('chevronRight', { size: 14 })])));
      if (state.run.chain.tx) out.push(txLink(state.run.chain.tx));
    }
    return out;
  }

  function render() {
    if (pay === 'token' && !tokenOn()) pay = 'eth';
    if (pay === 'eth' && !ethOn() && tokenOn()) pay = 'token';
    const state = stateOf();
    for (const slot of slots) {
      if (!slot) continue;
      slot.dataset.recordState = state.key;
      slot.dataset.pay = pay;
      slot.replaceChildren(...(state.key === 'not-live' ? [] : [payCards(state)]), button(state), ...lines(state));
    }
    if (onState) onState(state);
  }

  const fail = (message, ms = 8000) => { busy = null; render(); toast(message, { kind: 'error', ms }); };

  async function record(run) {
    if (!run || busy || !lab || !chain || !live()) return;
    const w = wallet();
    if (!w.account) { openWalletMenu(); return; }
    const targetId = Number(run.target.id);
    const ligandId = Number(run.ligand.id);
    const pose = run.result.poseCenti;
    const withToken = payWithToken();
    busy = { run, phase: 'quote', hash: null, approveHash: null };
    quoteLine = null;
    render();
    let quoted = null;
    try {
      // js/lab.js quote() answers { ok, scoreMilli } or { ok: false, reason }; an older shape may return the number
      const q = await lab.quote(targetId, ligandId, pose, { from: w.account });
      if (q && typeof q === 'object' && 'ok' in q) {
        if (!q.ok) throw Object.assign(new Error(q.reason || 'The contract refused this pose.'), { quoteRefused: true });
        quoted = Number(q.scoreMilli);
      } else {
        quoted = Number(q);
      }
      const same = quoted === Number(run.result.scoreMilli);
      quoteLine = { run, kind: same ? 'ok' : 'mismatch', text: same ? fill(S.quoteLine, { dG: fmtDg(quoted) }) : fill(S.quoteMismatch, { dG: fmtDg(quoted), browser: fmtDg(run.result.scoreMilli) }) };
    } catch (e) {
      const reason = (e && e.quoteRefused && e.message) || W.explainRevert(e) || (e && e.message) || 'refused';
      quoteLine = { run, kind: 'refused', text: fill(S.quoteRefused, { reason }) };
      fail(quoteLine.text);
      return;
    }

    // the token path: enough $PONCHEM, then an allowance for the lab (an Approve transaction when it is short)
    if (withToken) {
      busy.phase = 'allowance';
      render();
      const price = runPrice();
      let allowance;
      try {
        const bal = await tokenBalance(w.account);
        if (bal !== null && bal < price) { fail(fill(S.payTokenLow, { balance: units(bal, tokenMeta.decimals, 2), price: priceText() })); return; }
        allowance = await allowanceOf(w.account);
      } catch (e) {
        fail((e && e.message) || S.errFailed);
        return;
      }
      if (allowance < price) {
        busy.phase = 'approve';
        render();
        let approveSent;
        try {
          approveSent = await W.sendTx(buildApprove(price));
        } catch (e) {
          if (e && e.code === 'rejected') fail(S.errRejected, 4200); else fail((e && e.message) || S.errFailed);
          return;
        }
        busy.approveHash = approveSent.hash;
        toast(S.toastApproveSent, { kind: 'info' });
        render();
        let approveReceipt;
        try { approveReceipt = await approveSent.wait({ timeoutMs: 240000 }); } catch (e) { fail((e && e.message) || S.errFailed); return; }
        if (approveReceipt.status !== 'success') { fail(approveReceipt.error || S.toastReverted); return; }
        toast(S.toastApproved, { kind: 'success' });
      }
    }

    busy.phase = 'send';
    render();
    let sent;
    try {
      const methodJson = typeof run.methodJson === 'string' ? run.methodJson : '';
      const built = lab.buildSubmitRun(targetId, ligandId, pose, { payWithToken: withToken, methodJson, runFee: withToken ? 0n : runFee() });
      sent = await W.sendTx(built);
    } catch (e) {
      busy = null;
      render();
      const code = e && e.code;
      if (code === 'rejected') toast(S.errRejected, { kind: 'error' });
      else if (code === 'revert' && /enough ETH/i.test(String(e.message || ''))) toast(fill(S.errFee, { fee: feeText(runFee()) }), { kind: 'error', ms: 8000 });
      else toast((e && e.message) || S.errFailed, { kind: 'error', ms: 8000 });
      return;
    }
    busy.phase = 'wait';
    busy.hash = sent.hash;
    toast(S.toastSent, { kind: 'info' });
    render();
    let receipt;
    try {
      receipt = await sent.wait({ timeoutMs: 240000 });
    } catch (e) {
      fail((e && e.message) || S.errFailed);
      return;
    }
    if (receipt.status !== 'success') {
      fail(receipt.error || S.toastReverted);
      return;
    }
    const ev = decodeRunScored(receipt.logs, address());
    const scoreMilli = ev ? ev.scoreMilli : Number(quoted);
    const chainView = { scoreMilli, tx: sent.hash, runId: ev ? ev.runId : null, block: receipt.block, fromEvent: !!ev, payWithToken: withToken };
    run.chain = chainView;
    busy = null;
    quoteLine = null;
    render();
    const t = toast(S.toastRecorded, { kind: 'success', ms: 7000 });
    t.append(' ', el('a', { class: 'pc-toast-action', href: EXPLORER.tx(sent.hash), target: '_blank', rel: 'noopener noreferrer' }, S.toastViewTx));
    toast(fill(S.toastChainScore, { dG: fmtDg(scoreMilli) }), { kind: 'success', ms: 7000 });
    if (onChain) onChain(run, chainView);
  }

  W.onChange(() => render());
  refreshStatus();
  render();

  return {
    update: () => render(),
    record,
    status: () => status,
    refreshStatus,
    busy: () => busy,
    live,
    payment: () => pay,
    setPayment: (key) => { if (key === 'token' && tokenOn()) pay = 'token'; else if (key === 'eth') pay = 'eth'; render(); return pay; },
    tokenSymbol: () => TOKEN.symbol,
  };
}
