/*
 * js/lab-ui/icons.js: the inline SVG stroke icons of the lab (SPEC-DESIGN.md 5.15: 24 px grid, stroke
 * currentColor, width 1.75, round caps and joins, no fills). Built with createElementNS, never innerHTML.
 *
 *   icon(name, { size = 20, label }) -> <svg>   aria-hidden unless a label is given
 */

const NS = 'http://www.w3.org/2000/svg';

const PATHS = {
  search: ['M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Z', 'M20 20l-4.5-4.5'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  cross: ['M7 7l10 10', 'M17 7L7 17'],
  alert: ['M12 4L2.5 20h19L12 4Z', 'M12 10v4', 'M12 17.2v.1'],
  info: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z', 'M12 11v5', 'M12 7.8v.1'],
  copy: ['M9 9h10v11H9V9Z', 'M5 15V4h11'],
  external: ['M7 17L17 7', 'M9 7h8v8'],
  play: ['M8 5l11 7-11 7V5Z'],
  stop: ['M6 6h12v12H6V6Z'],
  spinner: ['M12 3a9 9 0 1 1-8.5 6'],
  reset: ['M4 12a8 8 0 1 0 2.4-5.7', 'M4 4v5h5'],
  reference: ['M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9L12 3Z', 'M12 3v18', 'M4.2 7.5L19.8 16.5'],
  box: ['M4 8l8-4 8 4v8l-8 4-8-4V8Z', 'M4 8l8 4 8-4', 'M12 12v8'],
  pocket: ['M17 6.5A7 7 0 1 0 19 13', 'M12 9.5l3 1.7v3.6l-3 1.7-3-1.7v-3.6l3-1.7Z'],
  surface: ['M4 15c3-6 6-6 8 0s5 6 8 0', 'M4 9c3-6 6-6 8 0s5 6 8 0'],
  fullscreen: ['M4 9V4h5', 'M20 9V4h-5', 'M4 15v5h5', 'M20 15v5h-5'],
  chevronDown: ['M6 9l6 6 6-6'],
  chevronRight: ['M9 6l6 6-6 6'],
  chevronUp: ['M6 15l6-6 6 6'],
  filter: ['M4 6h16', 'M7 12h10', 'M10 18h4'],
  sort: ['M8 4v16', 'M4 8l4-4 4 4', 'M16 20V4', 'M12 16l4 4 4-4'],
  shuffle: ['M4 7h4l8 10h4', 'M17 4l3 3-3 3', 'M4 17h4l2-2.5', 'M13.5 9.5L16 7h4', 'M17 14l3 3-3 3'],
  wallet: ['M3 7h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z', 'M3 7a2 2 0 0 1 2-2h11v2', 'M16 13.5h.1'],
  share: ['M12 3v12', 'M8 7l4-4 4 4', 'M5 12v8h14v-8'],
  chain: ['M10 14a4 4 0 0 0 5.6 0l2.8-2.8a4 4 0 0 0-5.6-5.6l-1.4 1.4', 'M14 10a4 4 0 0 0-5.6 0l-2.8 2.8a4 4 0 0 0 5.6 5.6l1.4-1.4'],
  flask: ['M9 3h6', 'M10 3v6L4.5 19a1.5 1.5 0 0 0 1.3 2h12.4a1.5 1.5 0 0 0 1.3-2L14 9V3', 'M7 15h10'],
  dot: [],
};

export function icon(name, { size = 20, label = null, className = '' } = {}) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.75');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('class', `lab-icon lab-icon-${name}${className ? ` ${className}` : ''}`);
  if (label) { svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', label); } else svg.setAttribute('aria-hidden', 'true');
  const paths = PATHS[name] || PATHS.info;
  for (const d of paths) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  if (name === 'dot') {
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('cx', '12'); c.setAttribute('cy', '12'); c.setAttribute('r', '5');
    c.setAttribute('fill', 'currentColor'); c.setAttribute('stroke', 'none');
    svg.append(c);
  }
  return svg;
}
