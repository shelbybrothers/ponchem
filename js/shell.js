/*
 * js/shell.js: what every Ponchem page shares. The Buy $PONCHEM and Copy CA controls (nav and footer), the mobile
 * nav toggle, toasts, and the wallet button in the nav (partials/nav.html). No page content lives here.
 *
 *   initShell()                          wire [data-shell="buy"], [data-shell="ca"], [data-nav-toggle] and mark the
 *                                        current page's nav link; call once per page
 *   initWalletButton({ onChange })       wire [data-wallet-root] > [data-wallet-button] + [data-wallet-menu];
 *                                        onChange({ account, chainId, wallet }) fires on connect, disconnect and
 *                                        account or chain changes. Reconnects silently to a remembered wallet.
 *   openWalletMenu()                     open the wallet menu (for "connect to continue" buttons in a page)
 *                                        The menu lists the wallets found (EIP-6963 and window.ethereum), offers
 *                                        "open in wallet" links on a phone browser that has none, and when the
 *                                        wallet sits on another network the button reads "wrong network" and the
 *                                        menu offers the switch to Robinhood Chain.
 *   toast(message, { kind: 'info' | 'success' | 'error', ms = 4200 })
 *   copyText(text) -> bool
 *   el(tag, attrs, children)             small DOM builder: every string child becomes a text node, never HTML
 *   shortAddr('0x1234...cdef')
 *
 * CSS hooks (css/site.css styles these; this file sets no visual style):
 *   .pc-toasts (fixed host) > .pc-toast[data-kind=info|success|error]
 *   [data-wallet-menu] is shown and hidden with the `hidden` attribute: never set display on it without [hidden]
 *   [data-wallet-button].pc-warn (wrong network), .pc-menu-label, .pc-menu-addr, .pc-menu-note, .pc-menu-item,
 *   .pc-menu-item.pc-accent, .pc-menu-icon, .pc-warn-text
 *   nav[data-nav-open] while the mobile menu is open; a[data-nav][aria-current="page"] on the current page
 *
 * Rule: chain data and RCSB data (titles, names, organisms) is other people's text. It only ever reaches the page
 * through textContent or el(): never innerHTML.
 */
import { TOKEN, TOKEN_CA_BLANK, CHAIN, BRAND } from './config.js';
import * as W from './wallet.js';

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, String(v));
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const shortAddr = (a) => (a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || '');

let toastHost = null;
export function toast(message, { kind = 'info', ms = 4200 } = {}) {
  if (!toastHost) {
    toastHost = el('div', { class: 'pc-toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastHost);
  }
  const t = el('div', { class: 'pc-toast', dataset: { kind } }, message);
  toastHost.append(t);
  setTimeout(() => t.remove(), ms);
  return t;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = el('textarea', { readonly: true, style: { position: 'fixed', opacity: '0' } });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// shell controls

function initNavToggle() {
  const nav = document.querySelector('nav[aria-label="Main"]');
  const toggle = nav && nav.querySelector('[data-nav-toggle]');
  if (!nav || !toggle) return;
  const set = (open) => {
    nav.toggleAttribute('data-nav-open', open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  };
  toggle.addEventListener('click', () => set(!nav.hasAttribute('data-nav-open')));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && nav.hasAttribute('data-nav-open')) { set(false); toggle.focus(); } });
  document.addEventListener('click', (e) => { if (nav.hasAttribute('data-nav-open') && !nav.contains(e.target)) set(false); });
  set(false);
}

function markCurrentPage() {
  const here = location.pathname.replace(/\/$/, '') || '/';
  for (const a of document.querySelectorAll('a[data-nav]')) {
    const target = (a.getAttribute('href') || '').split(/[?#]/)[0].replace(/\/$/, '') || '/';
    // /target belongs to Targets, /ligand to Ligands
    const same = target === here || (target !== '/' && here.startsWith(target) && !/^[a-z]/.test(here.slice(target.length)));
    if (same) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
}

export function initShell() {
  // a docking run keeps going across pages (js/bg-dock.js); loaded lazily so a failure never touches the shell
  import('./bg-dock.js').then((m) => m.startBackgroundDock()).catch(() => null);
  for (const buy of document.querySelectorAll('[data-shell="buy"]')) {
    if (!TOKEN.buyUrl) continue;
    buy.href = TOKEN.buyUrl;
    buy.target = '_blank';
    buy.rel = 'noopener noreferrer';
    buy.removeAttribute('aria-disabled');
    buy.removeAttribute('role');
    buy.setAttribute('aria-label', `Buy $${TOKEN.symbol}`);
    buy.textContent = `Buy $${TOKEN.symbol}`;
  }
  for (const ca of document.querySelectorAll('[data-shell="ca"]')) {
    if (!TOKEN.ca) {
      ca.title = TOKEN_CA_BLANK;
      continue;
    }
    ca.disabled = false;
    ca.removeAttribute('title');
    ca.setAttribute('aria-label', `Copy the $${TOKEN.symbol} CA`);
    ca.addEventListener('click', async () => {
      const ok = await copyText(TOKEN.ca);
      toast(ok ? `$${TOKEN.symbol} CA copied` : 'Could not copy. Try again.', { kind: ok ? 'success' : 'error' });
    });
  }
  initNavToggle();
  markCurrentPage();
}

// ---------------------------------------------------------------------------------------------------------
// wallet button

let menuEl = null;
let buttonEl = null;
let open = false;

function setOpen(v) {
  open = v;
  if (!menuEl || !buttonEl) return;
  menuEl.hidden = !v;
  buttonEl.setAttribute('aria-expanded', v ? 'true' : 'false');
  if (v) renderMenu();
}

export function openWalletMenu() {
  if (!buttonEl) return;
  setOpen(true);
  buttonEl.scrollIntoView({ block: 'nearest' });
  const first = menuEl && menuEl.querySelector('button, a');
  (first || buttonEl).focus();
}

async function pick(id) {
  try {
    await W.connect(id);
    setOpen(false);
    await W.ensureChain().catch((e) => toast(e.message, { kind: 'error' }));
  } catch (e) {
    toast(e && e.message ? e.message : 'Could not connect the wallet.', { kind: 'error' });
  }
}

const wrongNetwork = () => !!W.account() && W.chainId() !== null && W.chainId() !== CHAIN.id;

async function switchNetwork() {
  try {
    await W.ensureChain();
    toast(`Your wallet is on ${CHAIN.name}.`, { kind: 'success' });
  } catch (e) {
    toast(e && e.message ? e.message : `Could not switch to ${CHAIN.name}.`, { kind: 'error' });
  }
}

// A phone browser has no wallet inside it. These links reopen this page in the wallet's own browser, where it has one.
const isPhone = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
function walletAppLinks() {
  const here = location.href;
  return [
    ['Open in MetaMask', `https://metamask.app.link/dapp/${here.replace(/^https?:\/\//, '')}`],
    ['Open in Coinbase Wallet', `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(here)}`],
  ];
}

function renderMenu() {
  if (!menuEl) return;
  menuEl.replaceChildren();
  const acct = W.account();
  if (acct) {
    if (wrongNetwork()) {
      menuEl.append(
        el('div', { class: 'pc-menu-label pc-warn-text' }, 'Wrong network'),
        el('p', { class: 'pc-menu-note' }, `Runs are recorded on ${CHAIN.name}. Your wallet is on another network.`),
        el('button', { class: 'pc-menu-item pc-accent', type: 'button', role: 'menuitem', onclick: switchNetwork }, `switch to ${CHAIN.name}`),
      );
    }
    // native append() would print a missing entry as the word null: keep only real nodes
    menuEl.append(...[
      el('div', { class: 'pc-menu-label' }, (W.wallet() && W.wallet().name) || 'Wallet'),
      el('div', { class: 'pc-menu-addr', title: acct }, shortAddr(acct)),
      el('a', { class: 'pc-menu-item', href: '/lab', role: 'menuitem' }, 'the lab'),
      el('a', { class: 'pc-menu-item', href: '/dashboard', role: 'menuitem' }, 'dashboard'),
      el('button', { class: 'pc-menu-item', type: 'button', role: 'menuitem', onclick: () => { W.disconnect(); setOpen(false); } }, 'disconnect'),
    ].filter(Boolean));
    return;
  }
  const wallets = W.listWallets();
  if (!wallets.length) {
    if (isPhone()) {
      menuEl.append(el('p', { class: 'pc-menu-note' }, `This browser has no wallet in it. Open ${BRAND.name} inside your wallet app:`));
      for (const [label, href] of walletAppLinks()) menuEl.append(el('a', { class: 'pc-menu-item pc-accent', href, role: 'menuitem', rel: 'noopener noreferrer' }, label));
      menuEl.append(el('p', { class: 'pc-menu-note' }, `Any wallet with a built in browser works: open ${BRAND.domain} there.`));
      return;
    }
    menuEl.append(el('p', { class: 'pc-menu-note' }, 'No wallet found in this browser. Install MetaMask, Rabby or another wallet that can add Robinhood Chain, then reload.'));
    return;
  }
  menuEl.append(el('div', { class: 'pc-menu-label' }, 'Connect with'));
  for (const w of wallets) {
    menuEl.append(
      el('button', { class: 'pc-menu-item', type: 'button', role: 'menuitem', onclick: () => pick(w.id) }, [
        w.icon ? el('img', { src: w.icon, alt: '', width: 18, height: 18, class: 'pc-menu-icon' }) : null,
        w.name,
      ]),
    );
  }
}

export function initWalletButton({ onChange } = {}) {
  const root = document.querySelector('[data-wallet-root]');
  if (!root) return;
  buttonEl = root.querySelector('[data-wallet-button]');
  menuEl = root.querySelector('[data-wallet-menu]');
  if (!buttonEl || !menuEl) return;
  menuEl.hidden = true;
  const paint = () => {
    const acct = W.account();
    const wrong = wrongNetwork();
    buttonEl.textContent = !acct ? 'connect wallet' : wrong ? 'wrong network' : shortAddr(acct);
    buttonEl.classList.toggle('pc-connected', !!acct && !wrong);
    buttonEl.classList.toggle('pc-warn', wrong);
    buttonEl.title = wrong ? `Your wallet is on another network. Open this menu to switch to ${CHAIN.name}.` : '';
    if (open) renderMenu();
  };
  buttonEl.addEventListener('click', () => setOpen(!open));
  document.addEventListener('mousedown', (e) => { if (open && !root.contains(e.target)) setOpen(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open) { setOpen(false); buttonEl.focus(); } });
  W.onWallets(() => { if (open) renderMenu(); });
  W.onChange((state) => { paint(); if (onChange) onChange(state); });
  W.listWallets();
  paint();
  W.reconnect().catch(() => null);
}
