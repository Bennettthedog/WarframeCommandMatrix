// Small DOM helpers for the HUD. Values are only written when they change, so the HUD can be
// refreshed often without churning the page.

export function el(tag, className = '', html = null) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (html !== null) e.innerHTML = html;
  return e;
}

export function setText(e, value) {
  const v = String(value);
  if (e._text !== v) { e._text = v; e.textContent = v; }
}

// A health/progress bar: `fill` is the inner element; ratio 0..1. Color follows the ratio.
export function setBar(fill, ratio) {
  const r = Math.max(0, Math.min(1, ratio));
  const w = `${(r * 100).toFixed(1)}%`;
  if (fill._w !== w) {
    fill._w = w;
    fill.style.width = w;
    fill.dataset.level = r > 0.6 ? 'high' : r > 0.3 ? 'mid' : 'low';
  }
}

export function show(e, visible) {
  if (e._shown !== visible) { e._shown = visible; e.hidden = !visible; }
}

// Simple line icons (inherit the text color).
const svg = (body, vb = '0 0 16 16') =>
  `<svg class="icon" viewBox="${vb}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
export const ICONS = {
  gold: svg('<circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="3"/>'),
  platinum: svg('<path d="M1.5 12.5l2.5-5h8l2.5 5z"/><path d="M4 7.5l1.2-3h5.6l1.2 3M5.5 12.5l1-5M10.5 12.5l-1-5"/>'), // an ingot
  heart: svg('<path d="M8 13.5S2 9.8 2 5.8A3 3 0 0 1 8 4.5a3 3 0 0 1 6 1.3c0 4-6 7.7-6 7.7z"/>'),
  sword: svg('<path d="M3 13l7.5-7.5M10.5 2.5h3v3L6 13"/><path d="M3.5 9.5l3 3M2.5 13.5l1-1"/>'),
  clock: svg('<circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/>'),
  speed: svg('<path d="M3 4l4 4-4 4M8.5 4l4 4-4 4"/>'),
  eye: svg('<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>'),
  stone: svg('<path d="M3 11l1.5-5L8 3.5l4 2.5 1.5 5L9 13z"/><path d="M8 3.5L7 8l-4 3M7 8l6 3"/>'),
  crystal: svg('<path d="M8 1.5l4 4.5-4 8.5-4-8.5z"/><path d="M4 6h8M8 1.5v13"/>'),
  troops: svg('<circle cx="5.5" cy="5" r="2"/><circle cx="11" cy="5.5" r="1.7"/><path d="M1.8 13c.3-2.5 1.8-4 3.7-4s3.4 1.5 3.7 4M9.5 9.2c1.7-.3 3.6.8 4 3.4"/>'),
  build: svg('<path d="M2 14h12M3.5 14V7L8 3l4.5 4v7"/><path d="M6.5 14v-3.5h3V14"/>'),
  hall: svg('<path d="M2 14h12M3 14V8l5-5.5L13 8v6"/><path d="M8 5.5v2"/>'),
  barracks: svg('<circle cx="8" cy="9" r="4.5"/><path d="M8 4.5V1.5M4 13l-1.5 1.5M12 13l1.5 1.5"/>'),
  turret: svg('<circle cx="8" cy="5" r="2.5"/><path d="M4.5 14l1-5h5l1 5z"/>'),
  quarry: svg('<path d="M2 14l3-6 3 3 3-5 3 8z"/><path d="M11 6l1.5-3"/>'),
  wall: svg('<path d="M2 14V7l2-2 2 2v7M6 14V6l2-2.5L10 6v8M10 14V7l2-2 2 2v7"/>'),
  shield: svg('<path d="M8 1.8l5 2v4c0 3.2-2.2 5.3-5 6.4-2.8-1.1-5-3.2-5-6.4v-4z"/>'),
  plus: svg('<path d="M8 3v10M3 8h10"/>'),
  bug: svg('<rect x="5" y="5" width="6" height="8" rx="3"/><path d="M8 5V3M6 3.5L5 2M10 3.5l1-1.5M5 8H2.5M13.5 8H11M5 11l-2 1.5M11 11l2 1.5"/>'),
};
