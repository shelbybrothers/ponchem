/*
 * js/lab.js: the write side of the lab. Calldata builders for js/wallet.js sendTx, the eth_call quote, and the
 * revert explainer that turns the contract's custom errors into plain sentences. Nothing here signs or sends.
 * Browser ES module with no DOM access at import time; Node imports it too.
 *
 * SHIPPED API (SPEC.md 8.4 write helpers, extended to SPEC.md 9.1, 9.2, 9.7 and 9.8)
 *   LAB_FRAGMENTS                     human-readable ABI of contracts/src/PonchemLab.sol (SPEC.md 8.2 + 9). Until js/abi.js
 *                                     from the contract builder is wired in, this is the one place the ABI lives;
 *                                     js/chain.js and api/_lab.mjs import it from here. LAB_ABI is an alias.
 *                                     notes/data-layer.md carries the same table as the contract builder's alignment sheet.
 *   ERC20_FRAGMENTS                   approve / allowance / balanceOf / decimals for the $PONCHEM payment path
 *   labFragment(name)                 parsed fragment by name (function, event or error)
 *   labAddress()  -> '0x..' | null    the contract reads and writes go to: useLab() override, else the localhost
 *                                     ?contract= override (js/rpc.js overrides()), else LAB.address from js/config.js
 *   labDeployBlock() -> number        LAB.deployBlock, or 0 while an override points somewhere else
 *   useLab(address | null, { deployBlock } = {})   process-wide override (the API routes set it from env, tests too)
 *   buildSubmitRun(targetId, ligandId, poseCenti, { payWithToken = false, methodJson = '', runFee } = {})
 *                                     -> { to, data, value }   value = runFee (wei) on the ETH path, 0 on the token path.
 *                                     The fourth argument may also be the bare runFee (the v1 call shape).
 *                                     methodJson: a compact JSON string or an object (stringified); at most METHOD_MAX_BYTES.
 *   buildApprove(token, spender, amount) -> { to: token, data, value: '0x0' }    the ERC-20 approve the token path needs
 *   allowanceOf(token, owner, spender, { signal } = {}) -> bigint           tokenBalanceOf(token, owner) -> bigint
 *   buildReview(runId, stars, note)   -> { to, data, value: '0x0' }   stars 1..5, note at most NOTE_MAX_BYTES (UTF-8)
 *   buildAttachAnalysis(runId, provider, text) -> { to, data, value: '0x0' }   text at most ANALYSIS_MAX_BYTES
 *   buildFund(targetId, wei)          -> { to, data, value }
 *   buildSettle(targetId, epoch)      -> { to, data, value: '0x0' }
 *   buildWithdraw()                   -> { to, data, value: '0x0' }
 *   quote(targetId, ligandId, poseCenti, { from, signal } = {}) -> { ok: true, scoreMilli }
 *                                     | { ok: false, reason (plain words), code (BadPose code | null), error (name | null), transient }
 *   POSE_REASONS                      [{ code, name, label, sentence }] for codes 0..5 (SPEC-ENGINE.md section 6)
 *   labelForReason(code) -> 'box'     sentenceForReason(code) -> 'An atom lies outside the target box.'
 *   PAYMENT                           { eth: 0, token: 1 } the Paid.method codes;  paymentName(code) -> 'eth' | 'token'
 *   NOTE_MAX_BYTES 280, METHOD_MAX_BYTES 1024, ANALYSIS_MAX_BYTES 2048     the contract's byte limits
 *   utf8Bytes(text) -> number         byte length of a string, the way the contract measures it
 *   decodeRevert(data) -> { selector, name, args, message } | null     custom errors, Error(string), Panic(uint256)
 *   revertDataOf(err) -> '0x..' | null       the revert data however a wallet or RpcError wrapped it
 *   sentenceFor(decoded, context)     the sentence for a decoded revert; ERROR_SENTENCES lists one per error name
 *   explainRevert(err, context) -> sentence | null
 *       context (all optional): { runFee, runPrice, epochEnd, now, payWithToken, token }
 *   registerRevertExplainer(context = {}) -> unregister    wallet.useRevertExplainer with explainRevert bound to
 *                                     `context` (an object or a function returning one; read at explain time)
 *   NOT_LIVE                          'The lab opens when the contract is live.'
 */
import { LAB } from './config.js';
import { fragment, encodeCall, decodeResult, decodeAbi, errorsOf, ethCall, toHex, overrides, isAddress, getAddress } from './rpc.js';
import { useRevertExplainer } from './wallet.js';
import { eth as fmtEth, units, countdown } from './format.js';

export const NOT_LIVE = 'The lab opens when the contract is live.';

export const NOTE_MAX_BYTES = 280;
export const METHOD_MAX_BYTES = 1024;
export const ANALYSIS_MAX_BYTES = 2048;

export const PAYMENT = Object.freeze({ eth: 0, token: 1 });
export const paymentName = (code) => (Number(code) === 1 ? 'token' : 'eth');

/*
 * The ABI, SPEC.md 8.2 as amended by 9.1 (payment), 9.2 (reviews), 9.7 (methods) and 9.8 (analysis). Every name
 * and type here is what js/chain.js decodes and what the builders encode; the contract builder aligns to this table
 * (copied in notes/data-layer.md). Changes: submitRun takes (bool payWithToken, string method); run() and the
 * runsFrom tuple end with bytes32 methodHash; stats() has three review counters; minHold and setRunFee are gone,
 * replaced by runPrice, ethAllowed, tokenAllowed, setPrices, setPaymentOptions and setToken(address).
 */
export const LAB_FRAGMENTS = Object.freeze([
  // writes
  'function submitRun(uint16 targetId, uint16 ligandId, int16[] pose, bool payWithToken, string method) payable returns (uint256 runId, int32 scoreMilli)',
  'function quote(uint16 targetId, uint16 ligandId, int16[] pose) view returns (int32 scoreMilli)',
  'function reviewRun(uint256 runId, uint8 stars, string note)',
  'function attachAnalysis(uint256 runId, string provider, string text)',
  'function fund(uint16 targetId) payable',
  'function settle(uint16 targetId, uint32 epoch)',
  'function withdraw()',
  // views (contracts/src/PonchemLab.sol)
  'function targetCount() view returns (uint16)',
  'function ligandCount() view returns (uint16)',
  'function runCount() view returns (uint256)',
  'function currentEpoch() view returns (uint32)',
  'function epochStart(uint32 epoch) view returns (uint64)',
  'function epochLength() view returns (uint64)',
  'function genesis() view returns (uint64)',
  'function runFee() view returns (uint256)',
  'function runPrice() view returns (uint256)',
  'function feeBps() view returns (uint16)',
  'function token() view returns (address)',
  'function ethAllowed() view returns (bool)',
  'function tokenAllowed() view returns (bool)',
  'function treasury() view returns (address)',
  'function owner() view returns (address)',
  'function pendingOwner() view returns (address)',
  'function tables() view returns (address)',
  'function target(uint16 id) view returns (string pdbId, string name, uint32 cancerBits, address data, bytes32 hash, uint16 atoms)',
  'function targetBox(uint16 id) view returns (uint16 hx, uint16 hy, uint16 hz, int32 cx, int32 cy, int32 cz)',
  'function ligand(uint16 id) view returns (string key, string name, address data, bytes32 hash, uint8 atoms, uint8 nrot)',
  'function run(uint256 id) view returns (address wallet, uint16 targetId, uint16 ligandId, int32 scoreMilli, uint32 epoch, uint64 time, bytes32 poseHash, bytes32 methodHash)',
  'function runsFrom(uint256 from, uint256 count) view returns ((address wallet, uint16 targetId, uint16 ligandId, int32 scoreMilli, uint32 epoch, uint64 time, bytes32 poseHash, bytes32 methodHash)[] page)',
  'function bestOf(uint16 targetId) view returns (uint256)',
  'function bestOfEpoch(uint16 targetId, uint32 epoch) view returns (uint256)',
  'function bestPair(uint16 targetId, uint16 ligandId) view returns (uint256)',
  'function pool(uint16 targetId) view returns (uint256)',
  'function poolAt(uint16 targetId, uint32 epoch) view returns (uint256)',
  'function carry(uint16 targetId) view returns (uint256)',
  'function nextSettle(uint16 targetId) view returns (uint32)',
  'function totalHeld() view returns (uint256)',
  'function totalOwed() view returns (uint256)',
  'function owed(address wallet) view returns (uint256)',
  'function stats(address wallet) view returns (uint64 runs, int32 best, uint256 prizes, uint32 reviewsGiven, uint32 reviewsReceived, uint32 starsReceived)',
  'function reviewStats(uint256 runId) view returns (uint32 count, uint32 starSum)',
  'function reviewOf(uint256 runId, address wallet) view returns (uint8 stars, uint64 time)',
  'function MAX_FEE_BPS() view returns (uint16)',
  'function PAGE_LIMIT() view returns (uint256)',
  // owner
  'function setTables(bytes blob)',
  'function registerTarget(string pdbId, string name, uint32 cancerBits, bytes pocket, bytes32 expectedHash) returns (uint16 id)',
  'function registerLigand(string key, string name, bytes topology, bytes32 expectedHash) returns (uint16 id)',
  'function setPrices(uint256 runFee, uint256 runPrice)',
  'function setPaymentOptions(bool ethAllowed, bool tokenAllowed)',
  'function setFeeBps(uint16 feeBps)',
  'function setTreasury(address treasury)',
  'function setToken(address token)',
  'function transferOwnership(address to)',
  'function acceptOwnership()',
  // events
  'event TargetRegistered(uint16 indexed id, string pdbId, string name, address data, bytes32 hash)',
  'event LigandRegistered(uint16 indexed id, string key, string name, address data, bytes32 hash)',
  'event RunScored(uint256 indexed runId, address indexed wallet, uint16 indexed targetId, uint16 ligandId, int32 scoreMilli, uint32 epoch, int16[] pose)',
  'event Paid(uint256 indexed runId, address indexed wallet, uint8 method, uint256 amount)',
  'event Method(uint256 indexed runId, string json)',
  'event Reviewed(uint256 indexed runId, address indexed reviewer, uint8 stars, string note)',
  'event Analysis(uint256 indexed runId, string provider, string text)',
  'event Funded(uint16 indexed targetId, address indexed from, uint256 amount, uint256 pool)',
  'event Settled(uint16 indexed targetId, uint32 indexed epoch, address winner, uint256 runId, uint256 amount)',
  'event Rolled(uint16 indexed targetId, uint32 indexed epoch, uint256 pool)',
  'event TablesSet(address data, bytes32 hash)',
  'event PricesSet(uint256 runFee, uint256 runPrice)',
  'event PaymentOptionsSet(bool ethAllowed, bool tokenAllowed)',
  'event FeeBpsSet(uint16 feeBps)',
  'event TreasurySet(address treasury)',
  'event TokenSet(address token)',
  'event Owed(address indexed to, uint256 amount)',
  'event Withdrawn(address indexed to, uint256 amount)',
  'event OwnershipTransferStarted(address indexed from, address indexed to)',
  'event OwnershipTransferred(address indexed from, address indexed to)',
  // errors: the lab (SPEC.md 8.2 and 9), the engine, the store
  'error BadPose(uint8 reason)',
  'error WrongFee()',
  'error PaymentRefused()',
  'error PaymentDisabled()',
  'error TokenRequired()',
  'error NotEnded()',
  'error NoRuns()',
  'error NotAuthor()',
  'error BadStars()',
  'error NoteTooLong()',
  'error SelfReview()',
  'error MethodTooLong()',
  'error AnalysisTooLong()',
  'error ProviderTooLong()',
  'error NoTarget()',
  'error NoLigand()',
  'error NoRun()',
  'error NoValue()',
  'error AlreadySettled()',
  'error NothingOwed()',
  'error TransferFailed()',
  'error Reentered()',
  'error ScoreOverflow()',
  'error NotOwner()',
  'error NotPendingOwner()',
  'error ZeroAddress()',
  'error FeeTooHigh()',
  'error BadEpochLength()',
  'error NoTables()',
  'error TablesAlreadySet()',
  'error BadTables()',
  'error HashMismatch()',
  'error BadName()',
  'error TooMany()',
  'error BadPocket()',
  'error BadTopology()',
  'error PayloadTooLarge()',
  'error StoreFailed()',
  'function setName(string name)',
  'function nameOf(address wallet) view returns (string)',
  'event Named(address indexed wallet, string name)',
  'error BadResearcherName()',
]);
export const LAB_ABI = LAB_FRAGMENTS;

export const ERC20_FRAGMENTS = Object.freeze([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);

// Other spellings a contract (or the token it calls) might give the same errors: matched by selector, the sentence is
// the name's. TokenRequired is the v1 minHold gate, kept so an old deployment still explains itself.
const ERROR_ALTERNATES = Object.freeze([
  'error BadPose(uint8 reason, uint16 atom)',
  'error WrongFee(uint256 sent, uint256 needed)',
  'error PaymentRefused(uint8 method)',
  'error EthRefused()',
  'error TokenRefused()',
  'error TokenNotSet()',
  'error NotEnded(uint64 endsAt)',
  'error NoRuns(uint16 targetId, uint32 epoch)',
  'error TokenRequired()',
  'error TokenRequired(uint256 held, uint256 needed)',
  'error NotAuthor(address wallet)',
  'error BadStars(uint8 stars)',
  'error NoteTooLong(uint256 length)',
  'error MethodTooLong(uint256 length)',
  'error AnalysisTooLong(uint256 length)',
  'error UnknownTarget()',
  'error UnknownLigand()',
  'error ZeroAmount()',
  'error OwnableUnauthorizedAccount(address account)',
  'error OwnableInvalidOwner(address owner)',
  'error ReentrancyGuardReentrantCall()',
  'error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)',
  'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)',
  'error SafeERC20FailedOperation(address token)',
  'error Error(string message)',
  'error Panic(uint256 code)',
]);

export const labFragment = (name) => fragment(LAB_FRAGMENTS, name);
const erc20Fragment = (name) => fragment(ERC20_FRAGMENTS, name);

// ---------------------------------------------------------------------------------------------------------
// where the lab lives

let override = null; // { address, deployBlock }

export function useLab(address, { deployBlock = 0 } = {}) {
  if (address === null || address === undefined || address === '') { override = null; return null; }
  if (!isAddress(address)) throw new Error('not an address');
  override = { address: getAddress(address), deployBlock: Number(deployBlock) || 0 };
  return override.address;
}

export function labAddress() {
  if (override) return override.address;
  const o = overrides();
  if (o.contract) return o.contract;
  return LAB.address ? getAddress(LAB.address) : null;
}

export function labDeployBlock() {
  if (override) return override.deployBlock;
  const o = overrides();
  if (o.contract && (!LAB.address || o.contract.toLowerCase() !== String(LAB.address).toLowerCase())) return 0;
  return Number(LAB.deployBlock) || 0;
}

// ---------------------------------------------------------------------------------------------------------
// builders

function needLab() {
  const to = labAddress();
  if (!to) throw new Error(NOT_LIVE);
  return to;
}

function asId(v, what) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`Unknown ${what} id.`);
  return n;
}

function asRunId(v) {
  let n;
  try { n = BigInt(v); } catch { throw new Error('Unknown run id.'); }
  if (n < 1n) throw new Error('Unknown run id.');
  return n;
}

function asEpoch(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new Error('That is not an epoch number.');
  return n;
}

function asWei(v) {
  let n;
  try { n = BigInt(v); } catch { throw new Error('Amount must be greater than zero.'); }
  if (n < 0n) throw new Error('Amount must be greater than zero.');
  return n;
}

const utf8 = new TextEncoder();
/** Byte length of a string in UTF-8, which is how the contract measures note, method and analysis limits. */
export function utf8Bytes(text) {
  return utf8.encode(String(text === null || text === undefined ? '' : text)).length;
}

/** Int16Array | number[] -> plain int16 array for the ABI, checked. */
export function asPose(poseCenti) {
  if (!poseCenti || typeof poseCenti.length !== 'number') throw new Error('The pose is empty.');
  const out = new Array(poseCenti.length);
  for (let i = 0; i < poseCenti.length; i++) {
    const v = Number(poseCenti[i]);
    if (!Number.isInteger(v) || v < -32768 || v > 32767) throw new Error('The pose has a coordinate that does not fit int16.');
    out[i] = v;
  }
  if (out.length === 0 || out.length % 3) throw new Error('The pose does not have three coordinates per atom.');
  return out;
}

export const METHOD_TOO_LONG = `The method JSON is longer than ${METHOD_MAX_BYTES.toLocaleString('en-US')} bytes. Shorten it and try again.`;
export const NOTE_TOO_LONG = `The review note is longer than ${NOTE_MAX_BYTES} bytes. Shorten it and try again.`;
export const ANALYSIS_TOO_LONG = `The analysis is longer than ${ANALYSIS_MAX_BYTES.toLocaleString('en-US')} bytes. Shorten it and try again.`;

/** '' | a compact JSON object string, checked against METHOD_MAX_BYTES. Objects are stringified compactly. */
export function asMethodJson(methodJson) {
  if (methodJson === null || methodJson === undefined || methodJson === '') return '';
  let text;
  if (typeof methodJson === 'string') {
    text = methodJson.trim();
    if (!text) return '';
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new Error('The method is not valid JSON.'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('The method must be a JSON object.');
    text = JSON.stringify(parsed);
  } else if (typeof methodJson === 'object' && !Array.isArray(methodJson)) {
    text = JSON.stringify(methodJson);
  } else {
    throw new Error('The method must be a JSON object.');
  }
  if (utf8Bytes(text) > METHOD_MAX_BYTES) throw new Error(METHOD_TOO_LONG);
  return text;
}

/**
 * submitRun(targetId, ligandId, pose, payWithToken, method). ETH path: value = runFee. Token path: value = 0 (the
 * contract pulls runPrice through transferFrom, so buildApprove must have been sent first).
 * The fourth argument accepts the v1 shape (the bare runFee) as well as the options object.
 */
export function buildSubmitRun(targetId, ligandId, poseCenti, options = {}) {
  const to = needLab();
  const opts = options !== null && typeof options === 'object' && !Array.isArray(options) ? options : { runFee: options };
  const payWithToken = !!opts.payWithToken;
  const method = asMethodJson(opts.methodJson === undefined ? opts.method : opts.methodJson);
  const fee = asWei(opts.runFee === undefined || opts.runFee === null ? 0n : opts.runFee);
  const data = encodeCall(labFragment('submitRun'), [asId(targetId, 'target'), asId(ligandId, 'ligand'), asPose(poseCenti), payWithToken, method]);
  return { to, data, value: toHex(payWithToken ? 0n : fee) };
}

/** ERC-20 approve(spender, amount) on `token`; spender defaults to the lab. */
export function buildApprove(token, spender = labAddress(), amount) {
  if (!isAddress(token)) throw new Error('The $PONCHEM token address is not set.');
  const to = spender === null || spender === undefined ? needLab() : spender;
  if (!isAddress(to)) throw new Error('The spender is not an address.');
  const wei = asWei(amount);
  return { to: getAddress(token), data: encodeCall(erc20Fragment('approve'), [getAddress(to), wei]), value: '0x0' };
}

export async function allowanceOf(token, owner, spender = labAddress(), { signal, blockTag = 'latest' } = {}) {
  if (!isAddress(token) || !isAddress(owner) || !isAddress(spender)) throw new Error('not an address');
  const hex = await ethCall({ to: getAddress(token), data: encodeCall(erc20Fragment('allowance'), [getAddress(owner), getAddress(spender)]) }, { signal, blockTag });
  return BigInt(decodeResult(erc20Fragment('allowance'), hex));
}

export async function tokenBalanceOf(token, owner, { signal, blockTag = 'latest' } = {}) {
  if (!isAddress(token) || !isAddress(owner)) throw new Error('not an address');
  const hex = await ethCall({ to: getAddress(token), data: encodeCall(erc20Fragment('balanceOf'), [getAddress(owner)]) }, { signal, blockTag });
  return BigInt(decodeResult(erc20Fragment('balanceOf'), hex));
}

export function buildReview(runId, stars, note = '') {
  const to = needLab();
  const s = Number(stars);
  if (!Number.isInteger(s) || s < 1 || s > 5) throw new Error('Stars must be between 1 and 5.');
  const text = String(note === null || note === undefined ? '' : note).trim();
  if (utf8Bytes(text) > NOTE_MAX_BYTES) throw new Error(NOTE_TOO_LONG);
  return { to, data: encodeCall(labFragment('reviewRun'), [asRunId(runId), s, text]), value: '0x0' };
}

/** setName: the researcher name shown with this wallet's docking tests (empty clears it). */
export function buildSetName(name) {
  const to = needLab();
  const n = String(name === null || name === undefined ? '' : name).trim();
  if (n.length > 32 || !/^[\x20-\x7e]*$/.test(n)) throw new Error('A researcher name is at most 32 plain characters.');
  return { to, data: encodeCall(labFragment('setName'), [n]), value: '0x0' };
}

/** nameOf for many wallets at once (cached for the page): Map<lowercased address, name> (empty names omitted). */
const nameCache = new Map();
export async function namesOf(addresses) {
  const to = labAddress();
  const out = new Map();
  if (!to) return out;
  const want = [...new Set((addresses || []).filter((a) => isAddress(a)).map((a) => a.toLowerCase()))];
  const missing = want.filter((a) => !nameCache.has(a));
  const f = labFragment('nameOf');
  await Promise.all(missing.map(async (a) => {
    try {
      const raw = await ethCall({ to, data: encodeCall(f, [a]) });
      const [n] = decodeResult(f, raw);
      nameCache.set(a, String(n || ''));
    } catch { nameCache.set(a, ''); }
  }));
  for (const a of want) { const n = nameCache.get(a); if (n) out.set(a, n); }
  return out;
}
export function forgetName(address) { if (address) nameCache.delete(String(address).toLowerCase()); }

/** "Dr Alice (0x1234…abcd)" or just the short address. The name is untrusted text: render it with el(). */
export function researcherLabel(address, names) {
  const a = String(address || '');
  const short = a.length > 10 ? `${a.slice(0, 6)}\u2026${a.slice(-4)}` : a;
  const n = names && names.get ? names.get(a.toLowerCase()) : null;
  return n ? `${n} (${short})` : short;
}

export function buildAttachAnalysis(runId, provider, text) {
  const to = needLab();
  const p = String(provider === null || provider === undefined ? '' : provider).trim();
  if (!p || p.length > 64) throw new Error('Choose a provider.');
  const t = String(text === null || text === undefined ? '' : text).trim();
  if (!t) throw new Error('There is no analysis text to attach.');
  if (utf8Bytes(t) > ANALYSIS_MAX_BYTES) throw new Error(ANALYSIS_TOO_LONG);
  return { to, data: encodeCall(labFragment('attachAnalysis'), [asRunId(runId), p, t]), value: '0x0' };
}

export function buildFund(targetId, wei) {
  const to = needLab();
  const amount = asWei(wei);
  if (amount === 0n) throw new Error('Amount must be greater than zero.');
  return { to, data: encodeCall(labFragment('fund'), [asId(targetId, 'target')]), value: toHex(amount) };
}

export function buildSettle(targetId, epoch) {
  const to = needLab();
  return { to, data: encodeCall(labFragment('settle'), [asId(targetId, 'target'), asEpoch(epoch)]), value: '0x0' };
}

export function buildWithdraw() {
  const to = needLab();
  return { to, data: encodeCall(labFragment('withdraw'), []), value: '0x0' };
}

// ---------------------------------------------------------------------------------------------------------
// the geometry proof's reason codes (SPEC-ENGINE.md section 6)

export const POSE_REASONS = Object.freeze([
  { code: 0, name: 'OK', label: 'ok', sentence: 'The pose passes every check.' },
  { code: 1, name: 'ATOM_COUNT', label: 'atom count', sentence: 'The pose does not have the ligand atom count.' },
  { code: 2, name: 'BOX', label: 'box', sentence: 'An atom lies outside the target box.' },
  { code: 3, name: 'BOND', label: 'bond length', sentence: 'A bonded pair is not at its ideal distance.' },
  { code: 4, name: 'PAIR13', label: '1-3 distance', sentence: 'A 1-3 pair is not at its ideal distance.' },
  { code: 5, name: 'CLASH', label: 'clash', sentence: 'Two atoms three or more bonds apart are closer than the clash floor.' },
].map(Object.freeze));

const reasonOf = (code) => POSE_REASONS[Number(code)] || null;
export const labelForReason = (code) => (reasonOf(code) ? reasonOf(code).label : 'unknown check');
export const sentenceForReason = (code) => (reasonOf(code) ? reasonOf(code).sentence : 'The pose fails a check the site does not know.');

export const GEOMETRY_FAIL = 'This pose fails a geometry check, so the chain would reject it. Run again.';

// ---------------------------------------------------------------------------------------------------------
// reverts

const ERRORS = new Map([...errorsOf(LAB_FRAGMENTS), ...errorsOf(ERROR_ALTERNATES)].map(([sel, f]) => [String(sel).toLowerCase(), f]));

/** '0x..' revert data -> { selector, name, args, message } (message set for Error(string) and Panic) or null. */
export function decodeRevert(data) {
  if (typeof data !== 'string' || !/^0x[0-9a-fA-F]*$/.test(data) || data.length < 10) return null;
  const selector = data.slice(0, 10).toLowerCase();
  const f = ERRORS.get(selector);
  if (!f) return { selector, name: null, args: [], message: null };
  let args = [];
  try { args = decodeAbi(f.inputs, '0x' + data.slice(10)); } catch { args = []; }
  const out = { selector, name: f.name, args, message: null };
  if (f.name === 'Error' && typeof args[0] === 'string') out.message = args[0];
  if (f.name === 'Panic' && args.length) out.message = `panic ${args[0]}`;
  return out;
}

const HEX_DATA = /^0x[0-9a-fA-F]{8,}$/;
/** Dig the revert data out of an RpcError, a wallet error (MetaMask nests it) or a plain message. */
export function revertDataOf(err) {
  const seen = new Set();
  const walk = (e, depth) => {
    if (!e || depth > 6 || typeof e !== 'object' || seen.has(e)) return null;
    seen.add(e);
    if (typeof e.data === 'string' && HEX_DATA.test(e.data)) return e.data;
    for (const k of ['data', 'error', 'cause', 'originalError', 'info', 'body']) {
      const v = e[k];
      if (v && typeof v === 'object') { const hit = walk(v, depth + 1); if (hit) return hit; }
      if (typeof v === 'string' && k !== 'data') { const m = /0x[0-9a-fA-F]{8,}/.exec(v); if (m && /revert|execution/i.test(v)) return m[0]; }
    }
    if (typeof e.message === 'string') { const m = /(0x[0-9a-fA-F]{8,})/.exec(e.message); if (m && /revert/i.test(e.message)) return m[1]; }
    return null;
  };
  return walk(err, 0);
}

const ctxOf = (context) => { try { return (typeof context === 'function' ? context() : context) || {}; } catch { return {}; } };
const tokenText = (amount) => `${units(amount, 18, 2)} $PONCHEM`;
const has = (c, k) => c[k] !== undefined && c[k] !== null;
const ZERO_ADDR = /^0x0{40}$/i;

/*
 * One sentence per error name (plain words, no dashes). Entries that need a number read it from `context`:
 * WrongFee (runFee), PaymentRefused (payWithToken, token), NotEnded (epochEnd, now), TransferFailed and the
 * ERC-20 errors (payWithToken, runPrice), TokenRequired (v1 minHold, kept for old deployments).
 */
export const ERROR_SENTENCES = Object.freeze({
  BadPose: GEOMETRY_FAIL,
  WrongFee: 'The run fee changed. Reload the lab and try again.',
  PaymentRefused: 'The $PONCHEM payment did not go through. Check the balance and the allowance, then try again.',
  PaymentDisabled: 'That payment option is switched off right now. Reload the lab and try again.',
  NotEnded: 'The epoch has not ended yet.',
  NoRuns: 'Nothing to settle: no run was recorded this epoch.',
  NotAuthor: 'Only the wallet that recorded this docking test can attach an analysis.',
  BadResearcherName: 'A researcher name is at most 32 plain characters (letters, digits, spaces and punctuation), with no space at either end.',
  BadStars: 'Stars must be between 1 and 5.',
  NoteTooLong: NOTE_TOO_LONG,
  SelfReview: 'You cannot review your own docking test.',
  MethodTooLong: METHOD_TOO_LONG,
  AnalysisTooLong: ANALYSIS_TOO_LONG,
  ProviderTooLong: 'The provider name is too long for the contract (32 bytes at most).',
  NoTarget: 'Unknown target id.',
  NoLigand: 'Unknown ligand id.',
  NoRun: 'Unknown run id.',
  NoValue: 'Amount must be greater than zero.',
  AlreadySettled: 'This epoch was already settled.',
  NothingOwed: 'Nothing to claim from this wallet.',
  TransferFailed: 'The transaction failed on chain. Nothing was recorded.',
  Reentered: 'The contract refused a re-entering call. Try again.',
  ScoreOverflow: 'The score does not fit the number range the contract stores. Run again.',
  NotOwner: 'Only the lab owner can do that.',
  NoTables: 'The lab has no scoring tables yet. Recording opens when they are set.',
  TokenRequired: 'Recording needs a minimum $PONCHEM balance in the connected wallet.',
  ERC20InsufficientAllowance: 'Approve the lab to spend $PONCHEM first, then run the docking test again.',
  ERC20InsufficientBalance: 'The connected wallet does not hold enough $PONCHEM for this docking test.',
  Error: 'The contract refused this transaction.',
  Panic: 'The contract hit an arithmetic check. Nothing was recorded.',
});

/** A plain sentence for a decoded revert, or null when the site does not know the error. */
export function sentenceFor(decoded, context = {}) {
  if (!decoded) return null;
  const c = ctxOf(context);
  const tokenKnown = Object.prototype.hasOwnProperty.call(c, 'token'); // token: null means "known to be unset"
  const tokenSet = tokenKnown && isAddress(String(c.token)) && !ZERO_ADDR.test(String(c.token));
  switch (decoded.name) {
    case 'BadPose': {
      const code = decoded.args.length ? Number(decoded.args[0]) : null;
      return code === null ? GEOMETRY_FAIL : `${GEOMETRY_FAIL} ${sentenceForReason(code)}`;
    }
    case 'WrongFee':
      return has(c, 'runFee') ? `The run fee is ${fmtEth(c.runFee)} plus gas. Reload the lab and try again.` : ERROR_SENTENCES.WrongFee;
    case 'PaymentRefused':
      // the v2 contract: the token's transferFrom returned false, reverted, or answered with something else
      if (!decoded.args.length) return ERROR_SENTENCES.PaymentRefused;
    // falls through: the one-argument spelling names the switched-off option
    case 'PaymentDisabled':
    case 'EthRefused':
    case 'TokenRefused':
    case 'TokenNotSet': {
      const off = decoded.name === 'PaymentRefused' ? 'PaymentDisabled' : decoded.name;
      const viaToken = off === 'TokenRefused' || off === 'TokenNotSet' || (off === 'PaymentDisabled' && (decoded.args.length ? Number(decoded.args[0]) === 1 : !!c.payWithToken));
      if (off === 'EthRefused' || (off === 'PaymentDisabled' && has(c, 'payWithToken') && !c.payWithToken)) return 'Paying in ETH is switched off right now. Pay in $PONCHEM.';
      if (viaToken && (off === 'TokenNotSet' || (tokenKnown && !tokenSet))) return 'The $PONCHEM option opens after the launch. Pay in ETH.';
      if (viaToken) return 'Paying in $PONCHEM is switched off right now. Pay in ETH.';
      return ERROR_SENTENCES.PaymentDisabled;
    }
    case 'NotEnded': {
      const end = has(c, 'epochEnd') ? Number(c.epochEnd) : (decoded.args.length ? Number(decoded.args[0]) : null);
      if (end && Number.isFinite(end)) {
        const now = c.now !== undefined ? Number(c.now) : Math.floor(Date.now() / 1000);
        return `The epoch has not ended yet. It ends in ${countdown(end - now)}.`;
      }
      return ERROR_SENTENCES.NotEnded;
    }
    case 'TokenRequired':
      if (!decoded.args.length && !has(c, 'minHold')) return 'The $PONCHEM option opens after the launch. Pay in ETH.';
      return has(c, 'minHold') ? `Recording needs at least ${tokenText(c.minHold)} in the connected wallet.` : (decoded.args.length > 1 ? `Recording needs at least ${tokenText(decoded.args[1])} in the connected wallet.` : ERROR_SENTENCES.TokenRequired);
    case 'TransferFailed':
    case 'SafeERC20FailedOperation':
      return c.payWithToken ? 'The $PONCHEM payment did not go through. Check the balance and the allowance, then try again.' : ERROR_SENTENCES.TransferFailed;
    case 'ERC20InsufficientAllowance':
      return has(c, 'runPrice') ? `Approve the lab to spend ${tokenText(c.runPrice)} first, then run the docking test again.` : ERROR_SENTENCES.ERC20InsufficientAllowance;
    case 'ERC20InsufficientBalance':
      return has(c, 'runPrice') ? `The connected wallet does not hold ${tokenText(c.runPrice)} for this docking test.` : ERROR_SENTENCES.ERC20InsufficientBalance;
    case 'UnknownTarget':
      return ERROR_SENTENCES.NoTarget;
    case 'UnknownLigand':
      return ERROR_SENTENCES.NoLigand;
    case 'ZeroAmount':
      return ERROR_SENTENCES.NoValue;
    case 'NotPendingOwner':
    case 'OwnableUnauthorizedAccount':
    case 'OwnableInvalidOwner':
      return ERROR_SENTENCES.NotOwner;
    case 'ReentrancyGuardReentrantCall':
      return ERROR_SENTENCES.Reentered;
    case 'ZeroAddress':
    case 'FeeTooHigh':
    case 'BadEpochLength':
    case 'TablesAlreadySet':
    case 'BadTables':
    case 'HashMismatch':
    case 'BadName':
    case 'TooMany':
    case 'BadPocket':
    case 'BadTopology':
    case 'PayloadTooLarge':
    case 'StoreFailed':
      return `The contract refused this registration: ${decoded.name}.`;
    case 'Error':
      return decoded.message ? `The contract refused: ${String(decoded.message).replace(/[‒-―]/g, '-').slice(0, 140)}.` : ERROR_SENTENCES.Error;
    default:
      return decoded.name && ERROR_SENTENCES[decoded.name] ? ERROR_SENTENCES[decoded.name] : null;
  }
}

export function explainRevert(err, context = {}) {
  const data = revertDataOf(err);
  if (!data) return null;
  return sentenceFor(decodeRevert(data), context);
}

export function registerRevertExplainer(context = {}) {
  return useRevertExplainer((err) => explainRevert(err, context));
}

// ---------------------------------------------------------------------------------------------------------
// quote: the same checks as submitRun, through eth_call, before anything is signed (free, no payment flag)

export async function quote(targetId, ligandId, poseCenti, { from, signal, blockTag = 'latest' } = {}) {
  const to = labAddress();
  if (!to) return { ok: false, reason: NOT_LIVE, code: null, error: null, transient: false };
  let data;
  try {
    data = encodeCall(labFragment('quote'), [asId(targetId, 'target'), asId(ligandId, 'ligand'), asPose(poseCenti)]);
  } catch (e) {
    return { ok: false, reason: e.message, code: null, error: 'input', transient: false };
  }
  const tx = { to, data };
  if (from && isAddress(from)) tx.from = getAddress(from);
  try {
    const hex = await ethCall(tx, { signal, blockTag });
    const v = decodeResult(labFragment('quote'), hex);
    return { ok: true, scoreMilli: Number(v) };
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    const decoded = decodeRevert(revertDataOf(e));
    if (decoded) {
      const code = decoded.name === 'BadPose' && decoded.args.length ? Number(decoded.args[0]) : null;
      return { ok: false, reason: sentenceFor(decoded) || 'The contract refused this pose.', code, error: decoded.name, transient: false };
    }
    const transient = !!(e && e.transient);
    return { ok: false, reason: transient ? 'Could not reach Robinhood Chain. Reads will retry.' : 'The contract refused this pose.', code: null, error: null, transient };
  }
}
