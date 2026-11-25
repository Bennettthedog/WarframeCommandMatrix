// Custom base shapes, painted in tools/shape_editor.py and saved to shapes/base_shapes.json.
// Each painted grid becomes a template the game samples at any scale: the drawing gives a
// base its outline, its tiers and where its ramps go; the game picks each base's size,
// rotation, mirroring and ramp widths at random.
//
// Painted symbols:  .  open ground   #  tier 1   2  tier 2 (inner tier)
//                   R  ramp marker (entrance from the ground, or between tier 1 and 2)
//                   T, *  older Town Hall / crystal spots: treated as plain floor

const LEVEL = { '.': 0, '#': 1, '2': 2, T: 1, '*': 1 };
const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];

// Used when shapes/base_shapes.json is missing or has no usable shapes.
export const DEFAULT_SHAPES = [
  { name: 'Square', rows: ['#######', '#######', '#######', '#######', '#######', '#######', '###R###'] },
  { name: 'L', rows: ['###....', '###....', '###....', '###....', '#######', '#######', '######R'] },
  { name: 'Arch', rows: ['#########', '#########', '####R####', '###...###', '###...###', '###...###', '###...###'] },
  { name: 'Terraced', rows: ['2222222', '2222222', '222R222', '#######', '#######', '#######', '###R###'] },
];

// Load the editor's shapes, falling back to the built-in set.
export async function loadShapes() {
  try {
    const res = await fetch('./shapes/base_shapes.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const all = (data.shapes || []).map(prepareShape).filter(Boolean);
    // Weight 0 = never used. If every shape is 0, use them all equally rather than none.
    const used = all.filter((s) => s.weight > 0);
    const shapes = used.length ? used : all.map((s) => ({ ...s, weight: 1 }));
    if (!shapes.length) throw new Error('no usable shapes');
    console.info(`Loaded ${shapes.length} base shapes: ${shapes.map((s) => `${s.name} ×${s.weight}`).join(', ')}`);
    return shapes;
  } catch (err) {
    console.info(`Using built-in base shapes (${err.message}).`);
    return DEFAULT_SHAPES.map(prepareShape);
  }
}

// Painted rows → template: per-cell tier (0..2), center, size and ramp markers.
export function prepareShape(s) {
  const rows = s.rows || [];
  const h = rows.length, w = Math.max(0, ...rows.map((r) => r.length));
  if (!w || !h) return null;
  const sym = (x, y) => (y >= 0 && y < h && x >= 0 && x < w ? rows[y][x] || '.' : '.');
  const markerLevel = (x, y) => { // T and * take the tier around them
    const around = DIRS.map(([dx, dy]) => sym(x + dx, y + dy));
    return around.filter((c) => c === '2').length > around.filter((c) => c === '#').length ? 2 : 1;
  };
  const level = (x, y) => {
    const c = sym(x, y);
    if (c === 'T' || c === '*') return markerLevel(x, y);
    return c === 'R' ? null : (LEVEL[c] ?? 0);
  };

  const tier = new Uint8Array(w * h);
  const ramps = [];       // { x, y, inner } in cell units (cell centers)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (sym(x, y) !== 'R') { tier[y * w + x] = level(x, y); continue; }
      // A ramp joins a lower and a higher side one level apart. Low side 0 = entrance.
      let low = null;
      for (const [dx, dy] of DIRS) {
        const hi = level(x + dx, y + dy), lo = level(x - dx, y - dy);
        if (hi !== null && lo !== null && hi === lo + 1) { low = lo; break; }
      }
      tier[y * w + x] = 1; // the ramp's own cell counts as tier-1 floor in the outline
      if (low !== null) ramps.push({ x: x + 0.5, y: y + 0.5, inner: low >= 1 });
    }
  }
  let cells = 0;
  for (const t of tier) if (t) cells++;
  if (!cells) return null;

  // Center on the floor cell nearest the middle of the drawing (so it's always inside).
  let cx = w / 2, cy = h / 2, best = Infinity;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!tier[y * w + x]) continue;
      const d = Math.hypot(x + 0.5 - w / 2, y + 0.5 - h / 2);
      if (d < best) { best = d; cx = x + 0.5; cy = y + 0.5; }
    }
  }
  let radius = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (tier[y * w + x]) radius = Math.max(radius, Math.hypot(x + 0.5 - cx, y + 0.5 - cy) + 0.75);
    }
  }
  const weight = Number(s.weight ?? 1);
  return {
    name: String(s.name || 'Shape'), w, h, tier, cx, cy, radius,
    weight: Number.isFinite(weight) && weight > 0 ? weight : 0, // how often it's picked, relative

    twoTier: tier.includes(2),
    entrances: ramps.filter((r) => !r.inner).map((r) => [r.x - cx, r.y - cy]),
    innerRamps: ramps.filter((r) => r.inner).map((r) => [r.x - cx, r.y - cy]),
  };
}

// Pick a shape at random, in proportion to its weight.
export function pickShape(shapes, rand) {
  const total = shapes.reduce((sum, s) => sum + s.weight, 0);
  let r = rand() * total;
  for (const s of shapes) {
    r -= s.weight;
    if (r < 0) return s;
  }
  return shapes[shapes.length - 1];
}

// Sample the template at (x, y) cells from its center, with smoothed edges.
// Returns 0 (outside), 1 (tier 1) or 2 (tier 2).
export function sampleShape(shape, x, y) {
  const px = shape.cx + x - 0.5, py = shape.cy + y - 0.5;
  const i0 = Math.floor(px), j0 = Math.floor(py);
  const fx = px - i0, fy = py - j0;
  let occ = 0, two = 0;
  for (let dj = 0; dj <= 1; dj++) {
    for (let di = 0; di <= 1; di++) {
      const i = i0 + di, j = j0 + dj;
      const wgt = (di ? fx : 1 - fx) * (dj ? fy : 1 - fy);
      const t = i >= 0 && j >= 0 && i < shape.w && j < shape.h ? shape.tier[j * shape.w + i] : 0;
      if (t) occ += wgt;
      if (t === 2) two += wgt;
    }
  }
  if (occ < 0.5) return 0;
  return two >= 0.5 ? 2 : 1;
}
