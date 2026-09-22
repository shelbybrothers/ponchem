// mock-wallet.js: a scriptable EIP-1193 wallet for the Ponchem app test (tools/app-test.mjs). Injected before any page
// script with Page.addScriptToEvaluateOnNewDocument, announced over EIP-6963 like a real wallet.
//
// Configure it by defining window.__MOCK_WALLET_CONFIG__ first (the harness prepends one line):
//   account        '0x...'           the connected account (anvil dev account #1 by default)
//   chainId        '0x1237'          the chain the wallet starts on ('0x1' tests the switch flow)
//   rpcUrl         null | 'http://127.0.0.1:8562'
//                  reads, receipts and eth_sendTransaction are forwarded here (anvil signs for its
//                  unlocked accounts). null: reads go to the page's own /api/rpc.
//   rpcUrls        {} | { '0x1237': 'http://127.0.0.1:8581', '0x13b2': 'http://127.0.0.1:8583' }
//                  one RPC per chain, picked by the chain the wallet is on. It wins over rpcUrl, which
//                  stays the fallback for a chain the map does not name. A wallet that has to send on
//                  two chains (Robinhood Chain and Arc) needs this; one chain needs only rpcUrl.
//   dry            true              eth_sendTransaction and signatures reject with 4001 (user rejected)
//   authorized     false             eth_accounts returns the account before eth_requestAccounts
//   name, rdns, uuid                 the EIP-6963 info (the icon is an inline SVG)
//   injectWindowEthereum  true       also expose the provider as window.ethereum
//   extraWallets   []                more announced wallets [{ name, rdns }] that refuse to connect
//   rejectConnect  false             eth_requestAccounts rejects with 4001
//   rejectSwitch   false             wallet_switchEthereumChain rejects with 4001
//   noCustomChains false             switch to and add of 4663 both fail with 4200 (a wallet that cannot
//                                    use custom networks at all)
//   unknownChain   false             wallet_switchEthereumChain to 4663 fails with 4902 until
//                                    wallet_addEthereumChain adds it
//   persist        true              authorization and chain survive reloads (sessionStorage)
//   sessionKey     ''                state is kept per key: a new key starts a fresh wallet in the same tab
//   latencyMs      25                artificial delay per request
//
// Test hooks on window.__mockWallet:
//   calls          every request, in order: { method, params, t, ok, result | error }
//   provider, config, state()        state() = { authorized, chainId, added }
//   setChain(hex)  change chain and emit chainChanged        setAccounts([..])  emit accountsChanged
//   revoke()       forget the authorization (accountsChanged [])
//   emit(event, payload)
(function () {
  'use strict';
  if (window.top !== window) return;
  if (window.__mockWallet) return;

  var cfg = Object.assign({
    account: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    chainId: '0x1237',
    rpcUrl: null,
    rpcUrls: null,
    dry: true,
    authorized: false,
    name: 'Ponchem Test Wallet',
    rdns: 'ai.ponchem.testwallet',
    uuid: '6f1f0b8e-6d2a-4c41-9a5e-0c0ffee04663',
    injectWindowEthereum: true,
    announce: true,
    extraWallets: [],
    rejectConnect: false,
    rejectSwitch: false,
    unknownChain: false,
    persist: true,
    sessionKey: '',
    latencyMs: 25,
  }, window.__MOCK_WALLET_CONFIG__ || {});

  var KEY = '__mockWallet.state.' + cfg.sessionKey;
  var LOG_KEY = '__mockWallet.log.' + cfg.sessionKey;
  var store = {
    get: function (k) { try { return JSON.parse(sessionStorage.getItem(k)); } catch (e) { return null; } },
    set: function (k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } },
  };

  var saved = cfg.persist ? store.get(KEY) : null;
  var state = saved || { authorized: !!cfg.authorized, chainId: String(cfg.chainId).toLowerCase(), added: !cfg.unknownChain };
  var save = function () { if (cfg.persist) store.set(KEY, state); };
  save();

  var calls = [];
  var listeners = {};
  var ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" rx="22" fill="#216B41"/>'
    + '<path d="M22 34a8 8 0 0 1 8-8h36a8 8 0 0 1 8 8v4H30a8 8 0 0 0 0 0z" fill="#7CCB9C"/>'
    + '<rect x="18" y="36" width="60" height="38" rx="8" fill="#E3F5EA"/>'
    + '<circle cx="64" cy="55" r="5" fill="#216B41"/></svg>';
  var ICON = 'data:image/svg+xml;base64,' + btoa(ICON_SVG);

  function rpcError(code, message, data) {
    var err = new Error(message);
    err.code = code;
    if (data !== undefined) err.data = data;
    return err;
  }
  function emit(event, payload) {
    (listeners[event] || []).slice().forEach(function (fn) {
      try { fn(payload); } catch (e) { setTimeout(function () { throw e; }); }
    });
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function same(a, b) { return String(a || '').toLowerCase() === String(b || '').toLowerCase(); }
  function accounts() { return state.authorized ? [cfg.account] : []; }

  // The RPC for the chain the wallet is on right now: rpcUrls[chainId], then rpcUrl, then the page's proxy.
  function rpcFor(chainHex) {
    var map = cfg.rpcUrls || null;
    if (map) {
      var key = String(chainHex || state.chainId).toLowerCase();
      if (map[key]) return map[key];
    }
    return cfg.rpcUrl || null;
  }
  function canSend() { return !cfg.dry && !!rpcFor(state.chainId); }

  async function forward(method, params) {
    var url = rpcFor(state.chainId) || '/api/rpc';
    var res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: method, params: params || [] }),
      });
    } catch (e) {
      throw rpcError(-32603, 'mock wallet: RPC unreachable at ' + url + ': ' + (e && e.message));
    }
    var body = await res.json().catch(function () { return null; });
    if (!body) throw rpcError(-32603, 'mock wallet: RPC returned HTTP ' + res.status);
    if (body.error) throw rpcError(body.error.code || -32603, body.error.message || 'RPC error', body.error.data);
    return body.result;
  }

  async function handle(method, params) {
    params = params || [];
    switch (method) {
      case 'eth_accounts':
        return accounts();
      case 'eth_requestAccounts':
      case 'enable':
        if (cfg.rejectConnect) throw rpcError(4001, 'User rejected the request.');
        if (!state.authorized) {
          state.authorized = true;
          save();
          emit('accountsChanged', accounts());
          emit('connect', { chainId: state.chainId });
        }
        return accounts();
      case 'wallet_requestPermissions':
        if (cfg.rejectConnect) throw rpcError(4001, 'User rejected the request.');
        state.authorized = true;
        save();
        emit('accountsChanged', accounts());
        return [{ parentCapability: 'eth_accounts', caveats: [{ type: 'restrictReturnedAccounts', value: accounts() }] }];
      case 'wallet_getPermissions':
        return state.authorized ? [{ parentCapability: 'eth_accounts', caveats: [{ type: 'restrictReturnedAccounts', value: accounts() }] }] : [];
      case 'wallet_revokePermissions':
        state.authorized = false;
        save();
        emit('accountsChanged', []);
        return null;
      case 'eth_chainId':
        return state.chainId;
      case 'net_version':
        return String(parseInt(state.chainId, 16));
      case 'wallet_switchEthereumChain': {
        var target = String((params[0] && params[0].chainId) || '').toLowerCase();
        if (!/^0x[0-9a-f]+$/.test(target)) throw rpcError(-32602, 'Invalid chainId');
        if (cfg.rejectSwitch) throw rpcError(4001, 'User rejected the request.');
        if (cfg.noCustomChains && target === '0x1237') throw rpcError(4200, 'The wallet does not support custom networks.');
        if (target === '0x1237' && !state.added) throw rpcError(4902, 'Unrecognized chain ID "' + target + '". Try adding the chain using wallet_addEthereumChain first.');
        if (target !== state.chainId) {
          state.chainId = target;
          save();
          emit('chainChanged', target);
        }
        return null;
      }
      case 'wallet_addEthereumChain': {
        var p = params[0] || {};
        var id = String(p.chainId || '').toLowerCase();
        if (!/^0x[0-9a-f]+$/.test(id)) throw rpcError(-32602, 'Invalid chainId');
        if (cfg.rejectSwitch) throw rpcError(4001, 'User rejected the request.');
        if (cfg.noCustomChains) throw rpcError(4200, 'The wallet does not support custom networks.');
        if (id === '0x1237') state.added = true;
        if (id !== state.chainId) {
          state.chainId = id;
          emit('chainChanged', id);
        }
        save();
        return null;
      }
      case 'wallet_watchAsset':
        return true;
      case 'eth_sendTransaction': {
        if (!state.authorized) throw rpcError(4100, 'The requested account and/or method has not been authorized by the user.');
        var tx = Object.assign({}, params[0] || {});
        if (tx.from && !same(tx.from, cfg.account)) throw rpcError(4100, 'mock wallet: from ' + tx.from + ' is not the connected account');
        tx.from = cfg.account;
        if (!canSend()) throw rpcError(4001, 'User rejected the request.');
        if (tx.chainId && !same(tx.chainId, state.chainId)) throw rpcError(-32602, 'mock wallet: chainId ' + tx.chainId + ' does not match ' + state.chainId);
        return forward('eth_sendTransaction', [tx]);
      }
      case 'personal_sign':
      case 'eth_sign':
      case 'eth_signTypedData_v4':
        if (!state.authorized) throw rpcError(4100, 'Unauthorized');
        if (!canSend()) throw rpcError(4001, 'User rejected the request.');
        return forward(method, params);
      default:
        return forward(method, params);
    }
  }

  function record(entry) {
    calls.push(entry);
    if (!cfg.persist) return;
    var log = store.get(LOG_KEY) || [];
    log.push({ method: entry.method, t: entry.t, ok: entry.ok, error: entry.error ? entry.error.code : undefined });
    if (log.length > 400) log = log.slice(-400);
    store.set(LOG_KEY, log);
  }

  var provider = {
    isPonchemMock: true,
    isMetaMask: false,
    request: async function (args) {
      if (!args || typeof args.method !== 'string') throw rpcError(-32600, 'Invalid request');
      var entry = { method: args.method, params: args.params === undefined ? [] : JSON.parse(JSON.stringify(args.params)), t: Date.now(), ok: false };
      if (cfg.latencyMs) await sleep(cfg.latencyMs);
      try {
        var result = await handle(args.method, args.params);
        entry.ok = true;
        entry.result = result;
        record(entry);
        return result;
      } catch (err) {
        entry.error = { code: err.code, message: err.message };
        record(entry);
        throw err;
      }
    },
    enable: function () { return provider.request({ method: 'eth_requestAccounts' }); },
    isConnected: function () { return true; },
    on: function (event, fn) { (listeners[event] = listeners[event] || []).push(fn); return provider; },
    once: function (event, fn) {
      var wrap = function (p) { provider.removeListener(event, wrap); fn(p); };
      return provider.on(event, wrap);
    },
    removeListener: function (event, fn) {
      listeners[event] = (listeners[event] || []).filter(function (f) { return f !== fn; });
      return provider;
    },
  };
  provider.off = provider.removeListener;
  Object.defineProperty(provider, 'selectedAddress', { get: function () { return accounts()[0] || null; } });
  Object.defineProperty(provider, 'chainId', { get: function () { return state.chainId; } });

  function refusingProvider() {
    return {
      request: async function (args) {
        var m = args && args.method;
        calls.push({ method: 'extra:' + m, params: [], t: Date.now(), ok: m === 'eth_accounts' || m === 'eth_chainId' });
        if (m === 'eth_accounts') return [];
        if (m === 'eth_chainId') return '0x1';
        throw rpcError(4001, 'User rejected the request.');
      },
      on: function () { return this; },
      removeListener: function () { return this; },
    };
  }

  var details = [];
  if (cfg.announce) {
    details.push(Object.freeze({ info: Object.freeze({ uuid: cfg.uuid, name: cfg.name, icon: ICON, rdns: cfg.rdns }), provider: provider }));
    (cfg.extraWallets || []).forEach(function (w, i) {
      details.push(Object.freeze({
        info: Object.freeze({ uuid: '00000000-0000-4000-8000-' + String(i + 1).padStart(12, '0'), name: w.name, icon: w.icon || ICON, rdns: w.rdns || ('test.extra' + i) }),
        provider: refusingProvider(),
      }));
    });
  }
  function announce() {
    details.forEach(function (detail) {
      window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: detail }));
    });
  }
  window.addEventListener('eip6963:requestProvider', announce);
  announce();

  if (cfg.injectWindowEthereum) {
    try { Object.defineProperty(window, 'ethereum', { value: provider, configurable: true, writable: true }); } catch (e) { window.ethereum = provider; }
  }

  window.__mockWallet = {
    config: cfg,
    calls: calls,
    provider: provider,
    icon: ICON,
    state: function () { return JSON.parse(JSON.stringify(state)); },
    persistedLog: function () { return store.get(LOG_KEY) || []; },
    setChain: function (hex) {
      state.chainId = String(hex).toLowerCase();
      save();
      emit('chainChanged', state.chainId);
    },
    setAccounts: function (list) {
      if (list && list.length) { cfg.account = list[0]; state.authorized = true; } else state.authorized = false;
      save();
      emit('accountsChanged', accounts());
    },
    revoke: function () {
      state.authorized = false;
      save();
      emit('accountsChanged', []);
    },
    emit: emit,
    announce: announce,
  };
})();
