/*
 * js/wallet.js: wallet discovery (EIP-6963 plus the window.ethereum fallback), connect, chain switch and sending a
 * transaction to the lab contract. No DOM access at import time: discovery starts on the first listWallets() or
 * connect() call. No ethers: calldata comes from a builder ({ to, data, value }) written by the app (js/lab.js).
 * Nothing app-specific is imported here: the app registers how a revert is explained (useRevertExplainer).
 *
 * SHIPPED API
 *   listWallets() -> [{ id, name, icon (data URL | null), rdns, source: 'eip6963' | 'injected' | 'custom' }]
 *       Starts EIP-6963 discovery on first use. Wallets that announce later arrive through onWallets().
 *   onWallets(cb) -> unsubscribe      cb(list) whenever a wallet announces itself
 *   useProvider(provider, { name, rdns, id } = {}) -> id   register any EIP-1193 provider (tests, keepers, embeds)
 *   async connect(id?) -> account     eth_requestAccounts on that wallet (default: the remembered one, else the
 *       first found); remembers the choice in localStorage ('ponchem.wallet'). Throws WalletError.
 *   async reconnect() -> account | null   silent reconnect to the remembered wallet (eth_accounts, no prompt)
 *   account() -> '0x..' (checksummed) | null     chainId() -> number | null     wallet() -> { id, name, icon } | null
 *   onChange(cb) -> unsubscribe       cb({ account, chainId, wallet }) on connect, disconnect, account or chain change
 *   disconnect()                      forgets the wallet here (and asks it to revoke, best effort)
 *   async ensureChain() -> true       wallet_switchEthereumChain to 4663, else wallet_addEthereumChain (CHAIN), then
 *       switches again if the wallet did not; throws WalletError('...', 'wrong-chain' | 'rejected')
 *   async sendTx(built) -> { hash, wait(opts) }
 *       `built` is { to, data, value? } (value as a 0x hex quantity, wei; omitted or '0x' means 0). Switches to
 *       Robinhood Chain, then gas-estimates through the read endpoint: a call that would revert throws
 *       WalletError(plain words, 'revert') without asking the wallet to sign.
 *       wait({ timeoutMs = 180000, pollMs = 1000, signal }) -> { status: 'success' | 'reverted', hash, block,
 *       gasUsed, effectiveGasPrice, logs, error (plain words when reverted) }. Throws WalletError('...', 'timeout')
 *       when no receipt arrives.
 *   async balance() -> wei bigint | null      the connected account's ETH on Robinhood Chain
 *   useRevertExplainer(fn) -> unregister      fn(rpcError) -> string | null. The app registers one that decodes its
 *       contract's custom errors (from RpcError.data) into a sentence; without one a revert reads as a plain
 *       "The contract would refuse this transaction."
 *   explainRevert(err) -> string | null       what the registered explainer says about an RPC error, or null
 *   WalletError { message (plain words), code: 'no-wallet' | 'rejected' | 'pending' | 'no-account' |
 *       'wrong-chain' | 'revert' | 'send-failed' | 'timeout', cause }
 */
import { CHAIN } from './config.js';
import { rpc, getAddress, isAddress, toHex } from './rpc.js';

const LS_KEY = 'ponchem.wallet';

export class WalletError extends Error {
  constructor(message, code, cause) {
    super(message);
    this.name = 'WalletError';
    this.code = code;
    this.cause = cause;
  }
}

// ---------------------------------------------------------------------------------------------------------
// the revert hook: the app knows its contract's errors, this module does not

let explainer = null;

export function useRevertExplainer(fn) {
  explainer = typeof fn === 'function' ? fn : null;
  return () => { if (explainer === fn) explainer = null; };
}

export function explainRevert(err) {
  if (!explainer) return null;
  try {
    const s = explainer(err);
    return typeof s === 'string' && s.trim() ? s.trim() : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------
// discovery

const found = new Map(); // id -> { id, name, icon, rdns, provider, source }
const walletListeners = new Set();
const changeListeners = new Set();
let discovering = false;
let current = null; // { w, account, chainId, detach }

const hasWindow = () => typeof window !== 'undefined' && window && typeof window.addEventListener === 'function';

// localStorage only in a browser page (Node 22+ has an experimental global that warns on access)
function store(k, v) {
  try {
    if (!hasWindow() || typeof localStorage === 'undefined') return;
    if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v);
  } catch { /* private mode or blocked storage */ }
}
function load(k) {
  try { return !hasWindow() || typeof localStorage === 'undefined' ? null : localStorage.getItem(k); } catch { return null; }
}

function notifyWallets() {
  const list = listWallets();
  for (const cb of walletListeners) { try { cb(list); } catch { /* listener bug */ } }
}

function onAnnounce(ev) {
  const d = ev && ev.detail;
  if (!d || !d.info || !d.provider || typeof d.provider.request !== 'function') return;
  const id = String(d.info.uuid || d.info.rdns || d.info.name);
  const known = found.get(id);
  if (known && known.provider === d.provider) return;
  found.set(id, {
    id,
    name: String(d.info.name || 'Wallet').slice(0, 40),
    icon: typeof d.info.icon === 'string' && /^data:image\//.test(d.info.icon) ? d.info.icon : null,
    rdns: d.info.rdns ? String(d.info.rdns) : null,
    provider: d.provider,
    source: 'eip6963',
  });
  notifyWallets();
}

function discover() {
  if (discovering || !hasWindow()) return;
  discovering = true;
  window.addEventListener('eip6963:announceProvider', onAnnounce);
  try { window.dispatchEvent(new Event('eip6963:requestProvider')); } catch { /* old browser */ }
}

function injectedName(eth) {
  if (eth.isRabby) return 'Rabby';
  if (eth.isCoinbaseWallet) return 'Coinbase Wallet';
  if (eth.isBraveWallet) return 'Brave Wallet';
  if (eth.isOkxWallet || eth.isOKExWallet) return 'OKX Wallet';
  if (eth.isPhantom) return 'Phantom';
  if (eth.isMetaMask) return 'MetaMask';
  return 'Browser Wallet';
}

function allWallets() {
  discover();
  const list = [...found.values()];
  const eth = hasWindow() ? window.ethereum : null;
  if (eth && typeof eth.request === 'function' && !list.some((w) => w.provider === eth)) {
    list.push({ id: 'injected', name: injectedName(eth), icon: null, rdns: null, provider: eth, source: 'injected' });
  }
  return list;
}

const publicInfo = (w) => ({ id: w.id, name: w.name, icon: w.icon, rdns: w.rdns, source: w.source });

export function listWallets() {
  return allWallets().map(publicInfo);
}

export function onWallets(cb) {
  walletListeners.add(cb);
  return () => walletListeners.delete(cb);
}

export function useProvider(provider, { name = 'Custom Wallet', rdns = null, id } = {}) {
  if (!provider || typeof provider.request !== 'function') throw new Error('not an EIP-1193 provider');
  const key = id || `custom-${found.size + 1}`;
  found.set(key, { id: key, name, icon: null, rdns, provider, source: 'custom' });
  notifyWallets();
  return key;
}

// ---------------------------------------------------------------------------------------------------------
// state

function snapshot() {
  return { account: current ? current.account : null, chainId: current ? current.chainId : null, wallet: current ? publicInfo(current.w) : null };
}

function emit() {
  const s = snapshot();
  for (const cb of changeListeners) { try { cb(s); } catch { /* listener bug */ } }
}

export function onChange(cb) {
  changeListeners.add(cb);
  return () => changeListeners.delete(cb);
}

export function account() {
  return current ? current.account : null;
}

export function chainId() {
  return current ? current.chainId : null;
}

export function wallet() {
  return current ? publicInfo(current.w) : null;
}

function attach(w) {
  const p = w.provider;
  if (typeof p.on !== 'function') return () => {};
  const onAccounts = (accs) => {
    if (!current || current.w !== w) return;
    const a = Array.isArray(accs) && accs[0] && isAddress(accs[0]) ? getAddress(accs[0]) : null;
    if (!a) { drop(false); return; }
    current.account = a;
    emit();
  };
  const onChain = (hex) => {
    if (!current || current.w !== w) return;
    const n = Number.parseInt(String(hex), 16);
    current.chainId = Number.isFinite(n) ? n : null;
    emit();
  };
  // MetaMask fires "disconnect" when it loses its own node, not when the person leaves. Ask before letting go.
  const onDisconnect = async () => {
    if (!current || current.w !== w) return;
    try {
      const accs = await p.request({ method: 'eth_accounts' });
      if (Array.isArray(accs) && accs[0] && isAddress(accs[0])) return;
    } catch { /* the wallet really is gone */ }
    if (current && current.w === w) drop(false);
  };
  p.on('accountsChanged', onAccounts);
  p.on('chainChanged', onChain);
  p.on('disconnect', onDisconnect);
  return () => {
    const off = typeof p.removeListener === 'function' ? p.removeListener.bind(p) : typeof p.off === 'function' ? p.off.bind(p) : null;
    if (!off) return;
    off('accountsChanged', onAccounts);
    off('chainChanged', onChain);
    off('disconnect', onDisconnect);
  };
}

function drop(forget) {
  if (current && current.detach) { try { current.detach(); } catch { /* ignore */ } }
  current = null;
  if (forget) store(LS_KEY, null);
  emit();
}

async function adopt(w, accounts) {
  const a = Array.isArray(accounts) && accounts[0] && isAddress(accounts[0]) ? getAddress(accounts[0]) : null;
  if (!a) return null;
  let cid = null;
  try { cid = Number.parseInt(String(await w.provider.request({ method: 'eth_chainId' })), 16); } catch { cid = null; }
  if (current && current.w !== w) drop(false);
  if (!current) current = { w, account: a, chainId: Number.isFinite(cid) ? cid : null, detach: attach(w) };
  else { current.account = a; current.chainId = Number.isFinite(cid) ? cid : null; }
  store(LS_KEY, w.rdns || w.id);
  emit();
  return a;
}

function pick(id) {
  const list = allWallets();
  if (id) return list.find((w) => w.id === id || (w.rdns && w.rdns === id)) || null;
  const remembered = load(LS_KEY);
  return (remembered && list.find((w) => w.id === remembered || w.rdns === remembered)) || list[0] || null;
}

// ---------------------------------------------------------------------------------------------------------
// connect

export async function connect(id) {
  const w = pick(id);
  if (!w) throw new WalletError('No wallet found in this browser. Install a wallet that can add Robinhood Chain.', 'no-wallet');
  let accounts;
  try {
    accounts = await w.provider.request({ method: 'eth_requestAccounts' });
  } catch (e) {
    if (isPending(e)) throw new WalletError('Your wallet already has a request open. Open the wallet and finish it there.', 'pending', e);
    const declined = e && (e.code === 4001 || /reject|denied|cancel/i.test(String(e.message || '')));
    throw new WalletError(declined ? 'You declined the connection in your wallet.' : 'Your wallet did not connect. Unlock it and try again.', declined ? 'rejected' : 'send-failed', e);
  }
  const a = await adopt(w, accounts);
  if (!a) throw new WalletError('The wallet did not share an account.', 'no-account');
  return a;
}

export async function reconnect() {
  const remembered = load(LS_KEY);
  if (!remembered) return null;
  let w = pick(remembered);
  if (!w || (w.id !== remembered && w.rdns !== remembered)) {
    // late announcers: give EIP-6963 wallets a moment
    await new Promise((r) => setTimeout(r, 250));
    w = pick(remembered);
  }
  if (!w || (w.id !== remembered && w.rdns !== remembered)) return null;
  try {
    const accounts = await w.provider.request({ method: 'eth_accounts' });
    return await adopt(w, accounts);
  } catch {
    return null;
  }
}

export function disconnect() {
  if (current) {
    const p = current.w.provider;
    try {
      const r = p.request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] });
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch { /* not supported */ }
  }
  drop(true);
}

function requireWallet() {
  if (!current) throw new WalletError('Connect a wallet first.', 'no-account');
  return current;
}

const isPending = (e) => !!e && (e.code === -32002 || /already pending|request.*pending/i.test(String(e.message || '')));

const chainMissing = (e) => {
  const code = e && (e.code ?? (e.data && e.data.originalError && e.data.originalError.code));
  return code === 4902 || code === -32603 && /unrecognized|not added|unknown chain|no chain/i.test(String(e.message || '')) || /4902|unrecognized chain|not been added|unknown chain/i.test(String((e && e.message) || ''));
};

// ---------------------------------------------------------------------------------------------------------
// chain

export async function ensureChain() {
  const c = requireWallet();
  const p = c.w.provider;
  const read = async () => Number.parseInt(String(await p.request({ method: 'eth_chainId' })), 16);
  let now = await read().catch(() => null);
  if (now === CHAIN.id) { if (c.chainId !== now) { c.chainId = now; emit(); } return true; }
  const doSwitch = () => p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN.hex }] });
  try {
    await doSwitch();
  } catch (e) {
    if (e && e.code === 4001) throw new WalletError('You declined the switch to Robinhood Chain.', 'rejected', e);
    if (isPending(e)) throw new WalletError('Your wallet already has a request open. Open the wallet and finish it there.', 'pending', e);
    if (!chainMissing(e)) throw new WalletError('Your wallet could not switch to Robinhood Chain. Switch it by hand and try again.', 'wrong-chain', e);
    try {
      await p.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: CHAIN.hex,
          chainName: CHAIN.name,
          nativeCurrency: { ...CHAIN.nativeCurrency },
          rpcUrls: [...(CHAIN.walletRpcUrls || [CHAIN.rpc])],
          blockExplorerUrls: [CHAIN.explorer],
        }],
      });
    } catch (e2) {
      if (e2 && e2.code === 4001) throw new WalletError('You declined adding Robinhood Chain to your wallet.', 'rejected', e2);
      if (isPending(e2)) throw new WalletError('Your wallet already has a request open. Open the wallet and finish it there.', 'pending', e2);
      throw new WalletError('Your wallet could not add Robinhood Chain.', 'wrong-chain', e2);
    }
    now = await read().catch(() => null);
    if (now !== CHAIN.id) {
      try { await doSwitch(); } catch (e3) {
        if (e3 && e3.code === 4001) throw new WalletError('You declined the switch to Robinhood Chain.', 'rejected', e3);
        throw new WalletError('Your wallet could not switch to Robinhood Chain.', 'wrong-chain', e3);
      }
    }
  }
  now = await read().catch(() => null);
  if (now !== CHAIN.id) throw new WalletError('Your wallet is still on another network. Switch to Robinhood Chain.', 'wrong-chain');
  c.chainId = now;
  emit();
  return true;
}

// ---------------------------------------------------------------------------------------------------------
// transactions

const sleep = (ms, signal) => new Promise((ok, fail) => {
  if (signal && signal.aborted) { fail(Object.assign(new Error('aborted'), { name: 'AbortError' })); return; }
  const t = setTimeout(ok, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); fail(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
});

async function receiptOf(hash, provider) {
  try {
    const r = await rpc('eth_getTransactionReceipt', [hash], { timeoutMs: 8000 });
    if (r) return r;
  } catch { /* read endpoint hiccup: ask the wallet */ }
  try {
    return await provider.request({ method: 'eth_getTransactionReceipt', params: [hash] });
  } catch {
    return null;
  }
}

async function revertReason(tx, receipt) {
  try {
    await rpc('eth_call', [{ from: tx.from, to: tx.to, data: tx.data, value: tx.value }, receipt.blockNumber]);
    return 'The transaction reverted on chain.';
  } catch (e) {
    return explainRevert(e) || 'The transaction reverted on chain.';
  }
}

async function waitFor(hash, tx, provider, { timeoutMs = 180000, pollMs = 1000, signal } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await receiptOf(hash, provider);
    if (r && r.blockNumber) {
      const base = {
        hash,
        block: Number(BigInt(r.blockNumber)),
        gasUsed: r.gasUsed ? BigInt(r.gasUsed) : null,
        effectiveGasPrice: r.effectiveGasPrice ? BigInt(r.effectiveGasPrice) : null,
        logs: r.logs || [],
      };
      if (r.status === '0x1' || r.status === 1 || r.status === '1') return { ...base, status: 'success', error: null };
      return { ...base, status: 'reverted', error: await revertReason(tx, r) };
    }
    await sleep(pollMs, signal);
  }
  throw new WalletError('No receipt yet. The transaction may still land: check your wallet activity.', 'timeout');
}

const isRevert = (e) => !!(e && ((typeof e.data === 'string' && e.data.length > 2) || /revert/i.test(String(e.message || ''))));
const lowFunds = (e) => /insufficient funds|exceeds (the )?balance/i.test(String((e && e.message) || ''));

/**
 * Send a transaction built by the app ({ to, data, value }). Switches the wallet to Robinhood Chain first, then
 * simulates through the read endpoint: a call that would revert throws WalletError(plain words, 'revert') before
 * the wallet is asked to sign anything.
 */
export async function sendTx(built) {
  if (!built || !isAddress(built.to) || typeof built.data !== 'string') throw new WalletError('There is nothing to send.', 'revert');
  const c = requireWallet();
  await ensureChain();
  const from = c.account;
  const tx = { from, to: getAddress(built.to), data: built.data, value: built.value && built.value !== '0x' ? built.value : '0x0' };
  try {
    const gas = BigInt(await rpc('eth_estimateGas', [{ from, to: tx.to, data: tx.data, value: tx.value }]));
    tx.gas = toHex((gas * 13n) / 10n);
  } catch (e) {
    if (isRevert(e)) {
      throw new WalletError(lowFunds(e) ? 'This wallet does not hold enough ETH on Robinhood Chain for that.' : explainRevert(e) || 'The contract would refuse this transaction.', 'revert', e);
    }
    if (lowFunds(e)) throw new WalletError('This wallet does not hold enough ETH on Robinhood Chain for that.', 'revert', e);
    // the read endpoint is down: let the wallet estimate
  }
  let hash;
  try {
    hash = await c.w.provider.request({ method: 'eth_sendTransaction', params: [tx] });
  } catch (e) {
    const rejected = e && (e.code === 4001 || /reject|denied|cancel/i.test(String(e.message || '')));
    throw new WalletError(rejected ? 'You declined the transaction in your wallet.' : explainRevert(e) || 'Your wallet could not send the transaction.', rejected ? 'rejected' : 'send-failed', e);
  }
  if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new WalletError('The wallet did not return a transaction hash.', 'send-failed');
  const provider = c.w.provider;
  return { hash, wait: (opts) => waitFor(hash, tx, provider, opts) };
}

/** ETH balance of the connected account in wei (through the read endpoint), or null when nothing is connected. */
export async function balance() {
  if (!current || !current.account) return null;
  return BigInt(await rpc('eth_getBalance', [current.account, 'latest']));
}
