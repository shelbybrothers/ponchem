/*
 * js/lab-ui/pickers.js: the target and ligand pickers of the lab (search, filter pills, list rows; a multi-select
 * with check marks in the screening modes). One factory for both kinds; the page supplies how an item reads.
 *
 *   createPicker({ kind: 'target' | 'ligand', host, eyebrow, placeholder, items, groups: [{ key, name }],
 *                  groupsOf(item) -> string[], textOf(item) -> lowercase haystack, rowOf(item) -> RowView,
 *                  onPick(item), onChange(checkedIds) })
 *     RowView { id, title, caption, badge, image, imageAlt, link: null | { href, label } }
 *       (image null: the ligand mark is drawn instead; link: the direct RCSB or PubChem link of SPEC.md 9.4)
 *   -> { el, list, setSelected(id), selected(), setMulti(on), isMulti(), setChecked(ids), checked(), selectTop(n),
 *        search(q), setGroup(key), visibleItems(), focus() }
 *
 * Rows are 64 px options (SPEC-DESIGN.md 5.4 list variant): a focusable div with role="option" (Enter and Space
 * select it) so the row can carry a real <a> link that opens the RCSB or PubChem page in a new tab without taking
 * the tap that selects the row (the link stops its click from bubbling). Selected rows carry the accent tint and
 * bar through [aria-selected]. Everything is text nodes and el(): catalog text never reaches innerHTML.
 */
import { el } from '../shell.js';
import { icon } from './icons.js';
import { S } from './strings.js';

export function createPicker({ kind, host, eyebrow, placeholder, items, groups = [], groupsOf, textOf, rowOf, onPick, onChange, topLabel = S.selectTop }) {
  let multi = false;
  let selectedId = null;
  let query = '';
  let group = null;
  const checked = new Set();
  const rows = new Map(); // id -> { item, node, text, groups }

  const input = el('input', { type: 'search', class: 'lab-search-input', placeholder, 'aria-label': placeholder, autocomplete: 'off', spellcheck: 'false' });
  const clearBtn = el('button', { type: 'button', class: 'lab-search-clear', 'aria-label': S.clearSearch, hidden: true }, icon('close', { size: 18 }));
  const searchBox = el('div', { class: 'lab-search' }, [icon('search', { size: 20, className: 'lab-search-icon' }), input, clearBtn]);

  const pills = el('div', { class: 'lab-pills', role: 'group', 'aria-label': `${eyebrow.toLowerCase()} filters` });
  const pillNodes = new Map();
  const makePill = (key, name) => {
    const b = el('button', { type: 'button', class: 'lab-pill', 'aria-pressed': key === null ? 'true' : 'false', dataset: { group: key === null ? '' : key } }, name);
    b.addEventListener('click', () => { setGroup(key === group ? null : key); });
    pillNodes.set(key, b);
    return b;
  };
  pills.append(makePill(null, S.filterAll));
  for (const g of groups) pills.append(makePill(g.key, g.name));

  const list = el('div', { class: 'lab-list', role: 'listbox', 'aria-label': eyebrow.toLowerCase(), dataset: { kind } });
  const empty = el('div', { class: 'lab-picker-empty', hidden: true });
  const topBtn = el('button', { type: 'button', class: 'lab-link-btn lab-picker-top', hidden: true }, topLabel);
  topBtn.addEventListener('click', () => selectTop(20));
  const head = el('div', { class: 'lab-picker-head' }, [el('span', { class: 'lab-eyebrow' }, eyebrow), topBtn]);
  const count = el('span', { class: 'lab-picker-count' });

  const root = el('section', { class: 'lab-picker', dataset: { picker: kind } }, [head, searchBox, pills, list, empty]);
  host.append(root);

  const pick = (item, id) => {
    if (multi) {
      if (checked.has(id)) checked.delete(id); else checked.add(id);
      paintChecks();
      if (onChange) onChange([...checked]);
    } else {
      setSelected(id);
      if (onPick) onPick(item);
    }
  };

  const rowNode = (item) => {
    const v = rowOf(item);
    const thumb = el('span', { class: 'lab-row-thumb', 'aria-hidden': 'true' }, v.image
      ? el('img', { src: v.image, alt: '', loading: 'lazy', decoding: 'async', width: 48, height: 48 })
      : icon('reference', { size: 26 }));
    const text = el('span', { class: 'lab-row-text' }, [
      el('span', { class: 'lab-row-title' }, v.title),
      el('span', { class: 'lab-row-caption' }, v.caption),
    ]);
    // SPEC.md 9.4: the direct RCSB (or PubChem) link, a new tab, the text names the destination
    const link = v.link && v.link.href
      ? el('a', { class: 'lab-row-link', href: v.link.href, target: '_blank', rel: 'noopener noreferrer', title: v.link.label, 'aria-label': v.link.label, dataset: { rowLink: v.link.source || '' } }, [
        el('span', { class: 'lab-visually-hidden' }, v.link.label),
        icon('external', { size: 16 }),
      ])
      : el('span', { class: 'lab-row-link lab-row-link-none', 'aria-hidden': 'true' });
    if (v.link && v.link.href) {
      link.addEventListener('click', (e) => { e.stopPropagation(); });
      link.addEventListener('keydown', (e) => { e.stopPropagation(); });
    }
    const mark = el('span', { class: 'lab-row-mark', 'aria-hidden': 'true' }, [icon('chevronRight', { size: 18, className: 'lab-row-chevron' }), icon('check', { size: 16, className: 'lab-row-check' })]);
    const node = el('div', { class: 'lab-row', role: 'option', tabindex: '0', 'aria-selected': 'false', dataset: { id: String(v.id), badge: v.badge || '' } }, [thumb, text, link, mark]);
    node.addEventListener('click', () => pick(item, v.id));
    node.addEventListener('keydown', (e) => {
      if (e.target !== node) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(item, v.id); }
    });
    return node;
  };

  for (const item of items) {
    const v = rowOf(item);
    const node = rowNode(item);
    rows.set(v.id, { item, node, text: textOf(item), groups: new Set(groupsOf(item) || []) });
    list.append(node);
  }

  function paintChecks() {
    for (const [id, r] of rows) {
      const on = multi ? checked.has(id) : selectedId === id;
      r.node.setAttribute('aria-selected', on ? 'true' : 'false');
      if (multi) r.node.setAttribute('aria-checked', checked.has(id) ? 'true' : 'false'); else r.node.removeAttribute('aria-checked');
    }
  }

  function applyFilter() {
    const q = query.trim().toLowerCase();
    let shown = 0;
    for (const r of rows.values()) {
      const okGroup = !group || r.groups.has(group);
      const okText = !q || r.text.includes(q);
      const show = okGroup && okText;
      r.node.hidden = !show;
      if (show) shown++;
    }
    empty.replaceChildren();
    if (!shown) {
      const byGroup = !!group && !q;
      const btn = el('button', { type: 'button', class: 'lab-btn lab-btn-outline lab-btn-sm' }, byGroup ? S.clearFilter : S.clearSearch);
      btn.addEventListener('click', () => { if (byGroup) setGroup(null); else search(''); input.focus(); });
      empty.append(
        el('h4', {}, byGroup ? S.noGroupTitle : S.noMatchesTitle),
        el('p', {}, byGroup ? S.noGroupLine : S.noMatchesLine),
        btn,
      );
    }
    empty.hidden = shown > 0;
    list.hidden = shown === 0;
    clearBtn.hidden = !q;
  }

  function search(q) {
    query = q || '';
    if (input.value !== query) input.value = query;
    applyFilter();
  }

  function setGroup(key) {
    group = key || null;
    for (const [k, b] of pillNodes) b.setAttribute('aria-pressed', (k === null ? group === null : k === group) ? 'true' : 'false');
    applyFilter();
  }

  function setSelected(id) {
    selectedId = id === undefined ? null : id;
    paintChecks();
    const r = rows.get(selectedId);
    if (r && r.node.hidden) { search(''); setGroup(null); }
    if (r && !list.hidden) {
      // scroll the list only (scrollIntoView would also scroll the rail and the page)
      const top = r.node.offsetTop - list.offsetTop;
      const bottom = top + r.node.offsetHeight;
      if (top < list.scrollTop) list.scrollTop = top;
      else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
    }
  }

  function setMulti(on) {
    multi = !!on;
    root.classList.toggle('lab-picker-multi', multi);
    list.setAttribute('aria-multiselectable', multi ? 'true' : 'false');
    topBtn.hidden = !multi;
    paintChecks();
  }

  function setChecked(ids) {
    checked.clear();
    for (const id of ids || []) if (rows.has(id)) checked.add(id);
    paintChecks();
    if (onChange) onChange([...checked]);
  }

  function visibleItems() {
    const out = [];
    for (const r of rows.values()) if (!r.node.hidden) out.push(r.item);
    return out;
  }

  function selectTop(n) {
    const ids = [];
    for (const [id, r] of rows) { if (!r.node.hidden) { ids.push(id); if (ids.length >= n) break; } }
    setChecked(ids);
  }

  input.addEventListener('input', () => { query = input.value; applyFilter(); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape' && input.value) { e.preventDefault(); search(''); } });
  clearBtn.addEventListener('click', () => { search(''); input.focus(); });

  applyFilter();
  return {
    el: root,
    list,
    count,
    setSelected,
    selected: () => selectedId,
    setMulti,
    isMulti: () => multi,
    setChecked,
    checked: () => [...checked],
    selectTop,
    search,
    setGroup,
    visibleItems,
    focus: () => input.focus(),
  };
}
