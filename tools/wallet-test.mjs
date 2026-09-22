#!/usr/bin/env node
/*
 * wallet-test.mjs: does "connect wallet" really get a person onto Robinhood Chain, and does sendTx refuse a call that
 * would revert before the wallet is asked to sign?
 *
 *   node tools/wallet-test.mjs                            against http://127.0.0.1:6130 (start node tools/dev.mjs first)
 *   node tools/wallet-test.mjs --base https://ponchem.ai  against production, under its real CSP
 *   node tools/wallet-test.mjs --route /lab               the page to drive (default: /lab if lab.html exists, else /,
 *                                                         else the dev server's /__shell)
 *
 * It drives the real pages in headless Chrome with tools/sim-wallet.js, a wallet that behaves like MetaMask: it
 * starts on Ethereum, does not know Robinhood Chain, validates wallet_addEthereumChain the way MetaMask does, and
 * lets the test decline things. The simulated wallet signs and sends NOTHING (eth_sendTransaction is recorded and
 * answered with a made up hash), so this is safe to run against production and the live chain.
 *
 * Also checked, outside the browser: the RPC URLs a wallet is given answer chain id 0x1237 and keep up with the
 * head, and the parameters match the public chain registry (chainid.network) when it is reachable.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, openPage, sleep } from './lib/cdp.mjs';
import { postJson } from '../api/_doh.mjs';
import { CHAIN, MULTICALL3 } from '../js/config.js';
import { selector } from '../js/rpc.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const base = flag('base', 'http://127.0.0.1:6130').replace(/\/$/, '');
const local = /^http:\/\/(127\.0\.0\.1|localhost)/.test(base);
const ROUTE = flag('route', fs.existsSync(path.join(ROOT, 'lab.html')) ? '/lab' : fs.existsSync(path.join(ROOT, 'index.html')) ? '/' : local ? '/__shell' : '/');
const CHROME_PORT = Number(process.env.CHROME_PORT || 9532);
const SIM = fs.readFileSync(path.join(ROOT, 'tools/sim-wallet.js'), 'utf8');
const A1 = '0x1111111111111111111111111111111111111111';
const A2 = '0x2222222222222222222222222222222222222222';
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

let passed = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  ok    ${name}`); } catch (e) {
    failures.push(name);
    console.log(`  FAIL  ${name}\n          ${String((e && e.message) || e).split('\n').slice(0, 4).join('\n          ')}`);
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const show = (v) => JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? `${x}n` : x));
const eq = (a, b, msg) => { if (show(a) !== show(b)) throw new Error(`${msg || 'not equal'}: got ${show(a)}, want ${show(b)}`); };

// ---------------------------------------------------------------------------------------------------------
// outside the browser: what the wallet will be told

console.log(`Ponchem wallet test\n  base   ${base}\n  route  ${ROUTE}\n\nthe network a wallet is given`);
const WANT = { chainId: CHAIN.hex, chainName: CHAIN.name, nativeCurrency: { ...CHAIN.nativeCurrency }, rpcUrls: [...CHAIN.walletRpcUrls], blockExplorerUrls: [CHAIN.explorer] };
await check(`chain id ${CHAIN.id} is ${CHAIN.hex}, unpadded lowercase hex`, async () => {
  eq(CHAIN.hex, `0x${CHAIN.id.toString(16)}`);
});
for (const url of CHAIN.walletRpcUrls) {
  await check(`${url} answers chain id ${CHAIN.hex} and a moving head`, async () => {
    const body = JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }, { jsonrpc: '2.0', id: 2, method: 'eth_blockNumber', params: [] }]);
    let text;
    try { text = await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(12000) })).text(); } catch {
      const r = await postJson(url, body, { 'content-type': 'application/json' }); // this machine's DNS lies about the official host
      text = typeof r === 'string' ? r : r.body || r.text;
    }
    const [a, b] = JSON.parse(text);
    eq(a.result, CHAIN.hex, 'eth_chainId');
    assert(Number.parseInt(b.result, 16) > 60_000_000, `head is ${b.result}`);
  });
}
await check('name, currency, RPC and explorer match the public chain registry (chainid.network)', async () => {
  let list;
  try { list = await (await fetch('https://chainid.network/chains.json', { signal: AbortSignal.timeout(20000) })).json(); } catch { console.log('          (registry not reachable: skipped)'); return; }
  const c = list.find((x) => x.chainId === CHAIN.id);
  assert(c, `chain ${CHAIN.id} is not in the registry`);
  eq(c.name, CHAIN.name, 'name');
  eq(c.nativeCurrency, CHAIN.nativeCurrency, 'native currency');
  for (const u of CHAIN.walletRpcUrls) assert(c.rpc.includes(u), `${u} is not one of the registry's RPCs`);
  assert(c.explorers.some((e) => e.url === CHAIN.explorer), `${CHAIN.explorer} is not one of the registry's explorers`);
});

// ---------------------------------------------------------------------------------------------------------
// in the browser

const chrome = await launchChrome({ port: CHROME_PORT });

async function scenario(cfg, { route = ROUTE, width = 1280, ua = null } = {}) {
  const page = await openPage({ port: CHROME_PORT, width, height: width < 700 ? 844 : 900 });
  await page.emulate({ width, height: width < 700 ? 844 : 900, dpr: 1 });
  if (ua) await page.send('Emulation.setUserAgentOverride', { userAgent: ua });
  await page.goto(`${base}/robots.txt`, { settle: 50 });
  await page.eval(() => { localStorage.clear(); sessionStorage.clear(); });
  if (cfg) await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__walletSim = ${JSON.stringify(cfg)};\n${SIM}` });
  await page.goto(base + route, { settle: 700 });
  const ui = {
    page,
    route,
    button: () => page.eval(() => document.querySelector('[data-wallet-button]').textContent.trim()),
    menu: async () => {
      await page.eval(() => { const m = document.querySelector('[data-wallet-menu]'); if (m.hidden) document.querySelector('[data-wallet-button]').click(); });
      await sleep(80);
      return page.eval(() => document.querySelector('[data-wallet-menu]').innerText.replace(/\s+/g, ' ').trim());
    },
    items: () => page.eval(() => [...document.querySelectorAll('[data-wallet-menu] [role="menuitem"]')].map((n) => ({ text: n.textContent.trim(), href: n.getAttribute('href'), icon: !!n.querySelector('img') }))),
    click: async (label) => {
      const hit = await page.eval((l) => { const n = [...document.querySelectorAll('[data-wallet-menu] [role="menuitem"]')].find((x) => x.textContent.trim().toLowerCase().includes(l.toLowerCase())); if (n) n.click(); return !!n; }, label);
      assert(hit, `no menu item "${label}"`);
    },
    toasts: () => page.eval(() => [...document.querySelectorAll('.pc-toast')].map((t) => t.textContent.trim())),
    log: () => page.eval(() => window.__walletLog().map((e) => e.method)),
    calls: (m) => page.eval((method) => window.__walletLog().filter((e) => e.method === method), m),
    until: async (fn, what, ms = 6000) => { const t0 = Date.now(); for (;;) { if (await fn()) return; if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await sleep(80); } },
    act: (rdns, fn, arg) => page.eval((k, f, a) => window.__walletDo[k][f](a), rdns, fn, arg === undefined ? null : arg),
    reload: async () => { await page.goto(base + route, { settle: 700 }); },
    // a missing stylesheet or image is verify.mjs's business, not the wallet flow's: 404 resource logs are dropped here
    close: async () => { const errs = page.errors.filter((e) => !/favicon/.test(e.text) && !(e.kind === 'log.network' && /404/.test(e.text)) && !/Refused to apply style/.test(e.text)); await page.close(); return errs; },
  };
  return ui;
}

console.log('\nA. a wallet on Ethereum that has never heard of Robinhood Chain');
{
  const w = await scenario({ account: A1, startChain: '0x1' });
  await check('the page has the wallet button and its menu', async () => {
    const found = await w.page.eval(() => !!document.querySelector('[data-wallet-root] [data-wallet-button]') && !!document.querySelector('[data-wallet-root] [data-wallet-menu]'));
    assert(found, `${ROUTE} has no [data-wallet-root] with a button and a menu`);
  });
  await check('nothing is asked of the wallet before the person clicks', async () => {
    eq(await w.button(), 'connect wallet');
    const asked = await w.log();
    assert(!asked.includes('eth_requestAccounts') && !asked.some((m) => m.startsWith('wallet_')), `asked ${asked}`);
  });
  await check('the menu lists the wallet it found, with its icon (EIP-6963, under this site\'s CSP)', async () => {
    const text = await w.menu();
    assert(/connect with/i.test(text) && /MetaMask/.test(text), text);
    const items = await w.items();
    eq(items.filter((i) => /MetaMask/.test(i.text)).length, 1, 'MetaMask is listed once, not again as window.ethereum');
    assert(items[0].icon, 'the wallet icon shows (data: image)');
  });
  await check('connect: accounts, then switch, then (unknown chain 4902) add, in that order', async () => {
    await w.click('MetaMask');
    await w.until(async () => (await w.button()) === short(A1), 'the address on the button');
    const asked = (await w.log()).filter((m) => /eth_requestAccounts|wallet_/.test(m));
    eq(asked.slice(0, 3), ['eth_requestAccounts', 'wallet_switchEthereumChain', 'wallet_addEthereumChain']);
  });
  await check('the network the wallet was given passes MetaMask\'s own validation and is exactly right', async () => {
    eq(await w.act('io.metamask', 'added'), WANT);
    eq((await w.calls('wallet_switchEthereumChain'))[0].params, [{ chainId: CHAIN.hex }]);
  });
  await check('the wallet ends up on Robinhood Chain and the page knows it', async () => {
    eq(await w.page.eval(() => window.ethereum.request({ method: 'eth_chainId' })), CHAIN.hex);
    assert((await w.button()) !== 'wrong network', 'button');
    const text = await w.menu();
    assert(!/Wrong network/i.test(text) && /dashboard/.test(text) && /disconnect/.test(text), text);
    assert(!/\b(null|undefined|NaN)\b|\[object/.test(text), `stray text in the menu: ${text}`);
    eq((await w.items()).map((i) => i.text), ['the lab', 'dashboard', 'disconnect'], 'the menu items, nothing else');
    eq((await w.items()).map((i) => i.href), ['/lab', '/dashboard', null], 'where they go');
    eq(await w.toasts(), [], 'no error toast');
  });
  await check('a reload reconnects silently: no prompt, the address is back', async () => {
    const before = (await w.calls('eth_requestAccounts')).length;
    await w.reload();
    await w.until(async () => (await w.button()) === short(A1), 'the address after reload');
    eq((await w.calls('eth_requestAccounts')).length, before, 'eth_requestAccounts was not called again');
  });
  await check('switching account in the wallet shows the new account', async () => {
    await w.act('io.metamask', 'switchAccount', A2);
    await w.until(async () => (await w.button()) === short(A2), 'the new address');
  });
  await check('leaving Robinhood Chain in the wallet shows "wrong network", and the menu switches back', async () => {
    await w.act('io.metamask', 'switchChain', '0x1');
    await w.until(async () => (await w.button()) === 'wrong network', '"wrong network" on the button');
    const wrongText = await w.menu();
    assert(/Wrong network/i.test(wrongText), 'the menu says so');
    assert(!/\b(null|undefined|NaN)\b|\[object/.test(wrongText), `stray text in the menu: ${wrongText}`);
    await w.click('switch to Robinhood Chain');
    await w.until(async () => (await w.button()) === short(A2), 'the address again');
    eq(await w.page.eval(() => window.ethereum.request({ method: 'eth_chainId' })), CHAIN.hex);
  });
  await check('the wallet losing its node ("disconnect" event) does not log the person out', async () => {
    await w.act('io.metamask', 'loseNode');
    await sleep(300);
    eq(await w.button(), short(A2));
  });
  await check('locking the wallet logs out; disconnect forgets the wallet across a reload', async () => {
    await w.act('io.metamask', 'lock');
    await w.until(async () => (await w.button()) === 'connect wallet', 'logged out after lock');
    await w.menu();
    await w.click('MetaMask');
    await w.until(async () => (await w.button()) === short(A2), 'connected again');
    await w.menu();
    await w.click('disconnect');
    await w.until(async () => (await w.button()) === 'connect wallet', 'logged out after disconnect');
    await w.reload();
    await sleep(600);
    eq(await w.button(), 'connect wallet', 'still logged out after a reload');
  });
  await check('no console errors in the whole session', async () => eq((await w.close()).map((e) => e.text.slice(0, 100)), []));
}

console.log('\nB. the person says no');
{
  let w = await scenario({ account: A1, rejectConnect: 'once' });
  await check('declining the connection: a plain sentence, still "connect wallet", and it works on the second try', async () => {
    await w.menu(); await w.click('MetaMask');
    await w.until(async () => (await w.toasts()).length > 0, 'a toast');
    eq(await w.toasts(), ['You declined the connection in your wallet.']);
    eq(await w.button(), 'connect wallet');
    await w.menu(); await w.click('MetaMask');
    await w.until(async () => (await w.button()) === short(A1), 'connected on the second try');
  });
  await w.close();

  w = await scenario({ account: A1, rejectAdd: 'once' });
  await check('declining the new network: connected, "wrong network", a plain sentence; the menu retries it', async () => {
    await w.menu(); await w.click('MetaMask');
    await w.until(async () => (await w.button()) === 'wrong network', '"wrong network"');
    await w.until(async () => (await w.toasts()).length > 0, 'a toast'); // the toast lands after the button changes
    eq(await w.toasts(), ['You declined adding Robinhood Chain to your wallet.']);
    await w.menu(); await w.click('switch to Robinhood Chain');
    await w.until(async () => (await w.button()) === short(A1), 'on Robinhood Chain after the retry');
  });
  await w.close();

  w = await scenario({ account: A1, pendingConnect: 'once' });
  await check('a request already open in the wallet (-32002) is explained, not shown as a code', async () => {
    await w.menu(); await w.click('MetaMask');
    await w.until(async () => (await w.toasts()).length > 0, 'a toast');
    eq(await w.toasts(), ['Your wallet already has a request open. Open the wallet and finish it there.']);
  });
  await w.close();
}

console.log('\nC. other wallets and other ways of being injected');
{
  let w = await scenario({ account: A1, unknownChain: 'sentence' });
  await check('MetaMask mobile answers an unknown chain with -32603 and a sentence: the network is still added', async () => {
    await w.menu(); await w.click('MetaMask');
    await w.until(async () => (await w.button()) === short(A1), 'connected');
    eq(await w.act('io.metamask', 'added'), WANT);
  });
  await w.close();

  w = await scenario({ account: A1, addSwitches: false });
  await check('a wallet that adds the network but does not move to it is switched explicitly', async () => {
    await w.menu(); await w.click('MetaMask');
    await w.until(async () => (await w.button()) === short(A1), 'connected');
    eq((await w.calls('wallet_switchEthereumChain')).length, 2, 'switch, add, switch again');
    eq(await w.page.eval(() => window.ethereum.request({ method: 'eth_chainId' })), CHAIN.hex);
  });
  await w.close();

  w = await scenario({ account: A1, eip6963: false, legacy: true });
  await check('a wallet that only sets window.ethereum (an in-app browser) is found and connects', async () => {
    const items = await (async () => { await w.menu(); return w.items(); })();
    eq(items.map((i) => i.text), ['MetaMask']);
    await w.click('MetaMask');
    await w.until(async () => (await w.button()) === short(A1), 'connected');
  });
  await w.close();

  w = await scenario({ account: A1, wallets: [{ name: 'MetaMask', rdns: 'io.metamask' }, { name: 'Rabby Wallet', rdns: 'io.rabby' }] });
  await check('two wallets: both listed once, the chosen one is used and remembered', async () => {
    await w.menu();
    eq((await w.items()).map((i) => i.text).sort(), ['MetaMask', 'Rabby Wallet']);
    await w.click('Rabby');
    await w.until(async () => (await w.button()) === short(A1), 'connected');
    const who = await w.page.eval(() => window.__walletLog().filter((e) => e.method === 'eth_requestAccounts').map((e) => e.wallet));
    eq(who, ['Rabby Wallet']);
    await w.reload();
    await w.until(async () => (await w.button()) === short(A1), 'reconnected');
    const asked = await w.page.eval(() => window.__walletLog().filter((e) => e.method === 'eth_accounts').map((e) => e.wallet));
    assert(asked.includes('Rabby Wallet'), 'the reload asked Rabby, the remembered wallet');
  });
  await w.close();

  w = await scenario(null);
  await check('no wallet on a desktop browser: says so, plainly', async () => {
    assert(/No wallet found in this browser/.test(await w.menu()));
  });
  await w.close();

  const phoneRoute = `${ROUTE}${ROUTE.includes('?') ? '&' : '?'}id=EGFR`;
  w = await scenario(null, { width: 390, ua: IPHONE, route: phoneRoute });
  await check('no wallet on a phone browser: links that reopen this exact page inside the wallet app', async () => {
    const text = await w.menu();
    assert(/no wallet in it/.test(text), text);
    const items = await w.items();
    const host = base.replace(/^https?:\/\//, '');
    eq(items.map((i) => i.href), [`https://metamask.app.link/dapp/${host}${phoneRoute}`, `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(`${base}${phoneRoute}`)}`]);
    const over = await w.page.eval(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert(over <= 0, `the open menu makes the page ${over}px too wide`);
  });
  await w.close();
}

console.log('\nD. sendTx from the real page (recorded by the simulated wallet, never sent)');
{
  const w = await scenario({ account: A1, startChain: '0x1' });
  await check('connect, then the person moves the wallet back to Ethereum', async () => {
    await w.menu(); await w.click('MetaMask');
    await w.until(async () => (await w.button()) === short(A1), 'connected');
    await w.act('io.metamask', 'switchChain', '0x1');
    await w.until(async () => (await w.button()) === 'wrong network', '"wrong network"');
  });
  await check('a call the chain would refuse is refused here, in plain words, before the wallet is asked to sign', async () => {
    // Multicall3 has no fallback: empty calldata reverts. eth_estimateGas through /api/rpc says so.
    const r = await w.page.eval(async (to) => {
      const W = await import('/js/wallet.js');
      try { await W.sendTx({ to, data: '0x' }); return { threw: false }; } catch (e) { return { threw: true, name: e.name, code: e.code, message: e.message }; }
    }, MULTICALL3);
    eq(r.threw, true, 'sendTx threw');
    eq(r.name, 'WalletError', 'a WalletError');
    eq(r.code, 'revert', 'code');
    assert(/^[A-Z][^{}<>]*\.$/.test(r.message), `a plain sentence: "${r.message}"`);
    eq(await w.page.eval(() => window.__walletSent().length), 0, 'nothing reached eth_sendTransaction');
  });
  await check('a good call: the wallet is switched to Robinhood Chain first, then asked to sign a gas-estimated tx', async () => {
    const data = selector('getBlockNumber()');
    const r = await w.page.eval(async (to, calldata) => {
      const W = await import('/js/wallet.js');
      const sent = await W.sendTx({ to, data: calldata });
      return { hash: sent.hash };
    }, MULTICALL3, data);
    assert(/^0x[0-9a-f]{64}$/i.test(r.hash), `a hash came back: ${r.hash}`);
    const order = (await w.log()).filter((m) => /wallet_switchEthereumChain|eth_sendTransaction/.test(m));
    eq(order.slice(-2), ['wallet_switchEthereumChain', 'eth_sendTransaction'], 'the switch comes right before the send');
    const [sent] = await w.page.eval(() => window.__walletSent());
    eq(sent.chainAtSend, CHAIN.hex, 'the wallet was on Robinhood Chain when asked to sign');
    eq(sent.tx.to.toLowerCase(), MULTICALL3.toLowerCase(), 'to');
    eq(sent.tx.from.toLowerCase(), A1.toLowerCase(), 'from is the connected account');
    eq(sent.tx.data, data, 'calldata');
    eq(sent.tx.value, '0x0', 'value');
    assert(typeof sent.tx.gas === 'string' && BigInt(sent.tx.gas) > 21000n, `the gas limit came from a real estimate against the chain (${sent.tx.gas})`);
  });
  await check('no console errors in the sendTx session', async () => eq((await w.close()).map((e) => e.text.slice(0, 100)), []));
}

await chrome.close();
console.log(`\n${'-'.repeat(72)}`);
if (failures.length) { console.log(`FAILED  ${failures.length} of ${passed + failures.length} checks failed`); for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
console.log(`PASSED  ${passed} of ${passed} checks passed`);
