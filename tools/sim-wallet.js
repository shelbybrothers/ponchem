/*
 * tools/sim-wallet.js: a TEST-ONLY wallet that behaves the way MetaMask does, for tools/wallet-test.mjs.
 * No page references this file and tools/ is never deployed: the test injects it over the DevTools protocol before
 * the page's own scripts run (the way an extension's content script does), after setting window.__walletSim.
 *
 * What it models, because these are the things a connect flow gets wrong:
 *   - it starts on ANOTHER network (Ethereum, 0x1) and does not know Robinhood Chain until it is added;
 *   - wallet_switchEthereumChain to an unknown chain fails with 4902 (or, like MetaMask mobile, with -32603 and a
 *     sentence), wallet_addEthereumChain validates its parameters the way MetaMask does and refuses bad ones;
 *   - a person can decline the connection, the switch or the add (4001), or leave a request open (-32002);
 *   - permission survives a reload (eth_accounts answers without a prompt once connected), and is revocable;
 *   - accountsChanged and chainChanged events; EIP-6963 announcements, a legacy window.ethereum, or both.
 * It signs and sends NOTHING: eth_sendTransaction records the transaction and answers a made up hash.
 *
 * window.__walletSim (set by the test before load):
 *   { wallets: [{ name, rdns }], eip6963: true, legacy: true, account, startChain: '0x1', unknownChain: '4902' | 'sentence',
 *     rejectConnect, rejectSwitch, rejectAdd, pendingConnect, addSwitches: true }
 * Everything it is asked lands in sessionStorage 'sim.log' (so a reload keeps the story) and window.__walletLog().
 */
(() => {
  const cfg = window.__walletSim;
  if (!cfg || window.__walletSimOn) return;
  window.__walletSimOn = true;

  const mem = {
    get(k, d) { try { const v = sessionStorage.getItem(`sim.${k}`); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { sessionStorage.setItem(`sim.${k}`, JSON.stringify(v)); } catch { /* blocked storage */ } },
  };
  const log = (entry) => { const all = mem.get('log', []); all.push(entry); mem.set('log', all); };
  window.__walletLog = () => mem.get('log', []);
  window.__walletSent = () => mem.get('sent', []);

  const fail = (code, message, data) => Object.assign(new Error(message), { code, data });
  const https = (u) => { try { return new URL(u).protocol === 'https:'; } catch { return false; } };

  /* MetaMask's checks on wallet_addEthereumChain, in its own order. */
  function validateChain(p) {
    if (!p || typeof p !== 'object') throw fail(-32602, 'Expected single, object parameter.');
    const extra = Object.keys(p).filter((k) => !['chainId', 'chainName', 'nativeCurrency', 'rpcUrls', 'blockExplorerUrls', 'iconUrls'].includes(k));
    if (extra.length) throw fail(-32602, `Received unexpected keys on object parameter. Unsupported keys: ${extra}`);
    if (typeof p.chainId !== 'string' || !/^0x[1-9a-f][0-9a-f]*$/.test(p.chainId)) throw fail(-32602, `Expected 0x-prefixed, unpadded, non-zero hexadecimal string 'chainId'. Received: ${p.chainId}`);
    if (Number.parseInt(p.chainId, 16) > 4503599627370476) throw fail(-32602, 'Invalid chain ID: too large.');
    if (!Array.isArray(p.rpcUrls) || !p.rpcUrls.length || !p.rpcUrls.every((u) => typeof u === 'string' && https(u))) throw fail(-32602, `Expected an array with at least one valid string HTTPS url 'rpcUrls', Received: ${p.rpcUrls}`);
    if (p.blockExplorerUrls !== null && p.blockExplorerUrls !== undefined && (!Array.isArray(p.blockExplorerUrls) || !p.blockExplorerUrls.length || !p.blockExplorerUrls.every((u) => typeof u === 'string' && https(u)))) {
      throw fail(-32602, `Expected null or array with at least one valid string HTTPS URL 'blockExplorerUrl'. Received: ${p.blockExplorerUrls}`);
    }
    if (typeof p.chainName !== 'string' || !p.chainName) throw fail(-32602, `Expected non-empty string 'chainName'. Received: ${p.chainName}`);
    const c = p.nativeCurrency;
    if (c !== undefined && c !== null) {
      if (typeof c !== 'object' || Array.isArray(c)) throw fail(-32602, "Expected null or object 'nativeCurrency'.");
      if (c.decimals !== 18) throw fail(-32602, `Expected the number 18 for 'nativeCurrency.decimals' when 'nativeCurrency' is provided. Received: ${c.decimals}`);
      if (typeof c.symbol !== 'string' || c.symbol.length < 1 || c.symbol.length > 6) throw fail(-32602, `Expected 1-6 character string 'nativeCurrency.symbol'. Received: ${c.symbol}`);
    }
  }

  function makeProvider(info) {
    const key = info.rdns || info.name;
    const state = {
      get chain() { return mem.get(`${key}.chain`, cfg.startChain || '0x1'); },
      set chain(v) { mem.set(`${key}.chain`, v); },
      get known() { return mem.get(`${key}.known`, [cfg.startChain || '0x1']); },
      set known(v) { mem.set(`${key}.known`, v); },
      get allowed() { return mem.get(`${key}.allowed`, false); },
      set allowed(v) { mem.set(`${key}.allowed`, v); },
      get account() { return mem.get(`${key}.account`, cfg.account); },
      set account(v) { mem.set(`${key}.account`, v); },
    };
    const listeners = new Map();
    const emit = (name, arg) => { for (const fn of [...(listeners.get(name) || [])]) { try { fn(arg); } catch { /* a listener's bug */ } } };
    const once = (flag) => { if (cfg[flag]) { if (cfg[flag] === 'once') cfg[flag] = false; return true; } return false; };

    const provider = {
      isMetaMask: info.name === 'MetaMask' || undefined,
      isRabby: info.name === 'Rabby Wallet' || undefined,
      on(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); return provider; },
      removeListener(name, fn) { if (listeners.has(name)) listeners.get(name).delete(fn); return provider; },
      async request({ method, params } = {}) {
        log({ wallet: info.name, method, params: params === undefined ? null : params });
        await new Promise((r) => setTimeout(r, 15)); // a wallet never answers in the same tick
        switch (method) {
          case 'eth_chainId': return state.chain;
          case 'net_version': return String(Number.parseInt(state.chain, 16));
          case 'eth_accounts': return state.allowed ? [state.account] : [];
          case 'eth_requestAccounts':
            if (once('pendingConnect')) throw fail(-32002, "Request of type 'wallet_requestPermissions' already pending for origin. Please wait.");
            if (once('rejectConnect')) throw fail(4001, 'User rejected the request.');
            state.allowed = true;
            return [state.account];
          case 'wallet_switchEthereumChain': {
            const want = params && params[0] && params[0].chainId;
            if (typeof want !== 'string' || !/^0x[0-9a-f]+$/i.test(want)) throw fail(-32602, `Expected 0x-prefixed, unpadded, non-zero hexadecimal string 'chainId'. Received: ${want}`);
            if (!state.known.includes(want.toLowerCase())) {
              if (cfg.unknownChain === 'sentence') throw fail(-32603, `Unrecognized chain ID "${want}". Try adding the chain using wallet_addEthereumChain first.`);
              throw fail(4902, `Unrecognized chain ID "${want}". Try adding the chain using wallet_addEthereumChain first.`);
            }
            if (once('rejectSwitch')) throw fail(4001, 'User rejected the request.');
            if (state.chain !== want.toLowerCase()) { state.chain = want.toLowerCase(); emit('chainChanged', state.chain); }
            return null;
          }
          case 'wallet_addEthereumChain': {
            const p = params && params[0];
            validateChain(p);
            if (once('rejectAdd')) throw fail(4001, 'User rejected the request.');
            mem.set(`${key}.added`, p);
            state.known = [...new Set([...state.known, p.chainId.toLowerCase()])];
            if (cfg.addSwitches !== false && state.chain !== p.chainId.toLowerCase()) { state.chain = p.chainId.toLowerCase(); emit('chainChanged', state.chain); }
            return null;
          }
          case 'wallet_revokePermissions':
            state.allowed = false;
            emit('accountsChanged', []);
            return null;
          case 'eth_sendTransaction': {
            const tx = params && params[0];
            const sent = mem.get('sent', []);
            sent.push({ chainAtSend: state.chain, tx });
            mem.set('sent', sent);
            if (once('rejectSend')) throw fail(4001, 'User rejected the request.');
            return `0x${'5'.repeat(63)}${sent.length}`;
          }
          case 'eth_getTransactionReceipt': return null;
          default: throw fail(4200, `The simulated wallet does not answer ${method}.`);
        }
      },
    };
    // hooks for the test: what a person does inside the wallet
    (window.__walletDo = window.__walletDo || {})[key] = {
      switchAccount(a) { state.account = a; if (state.allowed) emit('accountsChanged', [a]); },
      lock() { state.allowed = false; emit('accountsChanged', []); },
      switchChain(hex) { state.chain = hex; emit('chainChanged', hex); },
      loseNode() { emit('disconnect', fail(1013, 'MetaMask: Disconnected from chain. Attempting to connect.')); },
      added() { return mem.get(`${key}.added`, null); },
    };
    return provider;
  }

  const ICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 8'%3E%3Crect width='8' height='8' fill='%23f6851b'/%3E%3C/svg%3E";
  const made = (cfg.wallets || [{ name: 'MetaMask', rdns: 'io.metamask' }]).map((info, i) => ({ info: { uuid: `sim-${i}-${info.rdns || info.name}`, icon: ICON, ...info }, provider: makeProvider(info) }));
  if (cfg.legacy !== false && made[0]) { try { Object.defineProperty(window, 'ethereum', { value: made[0].provider, configurable: true }); } catch { window.ethereum = made[0].provider; } }
  if (cfg.eip6963 !== false) {
    const announce = () => { for (const w of made) window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info: w.info, provider: w.provider }) })); };
    window.addEventListener('eip6963:requestProvider', announce);
    announce();
  }
})();
