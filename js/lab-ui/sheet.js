/*
 * js/lab-ui/sheet.js: the phone bottom sheet that hosts a picker or the method panel (SPEC-DESIGN.md 5.6, phone
 * order item 1). The content element is MOVED into the sheet while it is open and put back where it came from on
 * close, so one DOM serves the rail or the card (desktop) and the sheet (phone). Body scroll locks while open;
 * Escape, the backdrop and Done close it.
 *
 *   createSheet() -> { el, open({ title, content, onClose }), close(), isOpen(), content() }
 */
import { el } from '../shell.js';
import { S } from './strings.js';

export function createSheet() {
  let openState = null; // { content, parent, next, onClose }
  const title = el('h2', { class: 'lab-sheet-title', id: 'lab-sheet-title' });
  const done = el('button', { type: 'button', class: 'lab-btn lab-btn-primary lab-btn-sm lab-sheet-done' }, S.done);
  const body = el('div', { class: 'lab-sheet-body' });
  const panel = el('div', { class: 'lab-sheet-panel', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'lab-sheet-title' }, [
    el('div', { class: 'lab-sheet-handle', 'aria-hidden': 'true' }),
    el('div', { class: 'lab-sheet-head' }, [title, done]),
    body,
  ]);
  const backdrop = el('div', { class: 'lab-sheet-backdrop' });
  const root = el('div', { class: 'lab-sheet', hidden: true, dataset: { labSheet: '' } }, [backdrop, panel]);

  function close() {
    if (!openState) return;
    const { content, parent, next, onClose } = openState;
    openState = null;
    if (parent) { if (next && next.parentNode === parent) parent.insertBefore(content, next); else parent.append(content); }
    root.hidden = true;
    document.body.classList.remove('lab-sheet-open');
    if (onClose) onClose();
  }

  function open({ title: t, content, onClose }) {
    if (openState) close();
    openState = { content, parent: content.parentNode, next: content.nextSibling, onClose };
    title.textContent = t;
    body.replaceChildren(content);
    root.hidden = false;
    document.body.classList.add('lab-sheet-open');
    // the first visible control: a search input, a select or a textarea (never a hidden file input)
    const first = [...content.querySelectorAll('input, select, textarea')].find((n) => !n.hidden && n.type !== 'file' && n.offsetParent !== null);
    setTimeout(() => { try { (first || done).focus({ preventScroll: true }); } catch { /* fine */ } }, 30);
  }

  done.addEventListener('click', close);
  backdrop.addEventListener('click', close);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openState) { e.preventDefault(); close(); } });
  return { el: root, open, close, isOpen: () => !!openState, content: () => (openState ? openState.content : null) };
}
