import {
  MAP_SIZE, LEVEL_MIN, LEVEL_MAX, LEVEL_HEIGHT, RUIN_RADIUS,
  BASE_RADIUS, BASE_COUNT, SPREAD_CANDIDATES, EDGE_SHARE, EDGE_WALL, CORNER_BASES, INNER_BASES, PLACEMENT_TRIES, RAMP_WIDTHS, RAMP_WIDTH_WEIGHTS, WATCHSTONES, TOUCH_SHARE, MAX_TOUCH_SHARE, CORRIDOR_WIDTH, QUALITY_WEIGHTS, STAR_SHARES,
  CRYSTALS_MIN, CRYSTALS_MAX, ELITE_BASES, CRYSTAL_OUTER_SHARE, TUNNELS, GROVES, BOSS_ZONE, TEMPLE_CLEARING,
} from './config.js';
import { hashSeed, mulberry32, createNoise2D, fbm } from './rng.js';
import { sampleShape, pickShape } from './shapes.js';

// Direction indices used for ramps: 0 = +x, 1 = +z, 2 = -x, 3 = -z
export const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];
export const ZONE = { NORMAL: 0, RUIN: 1, SITE: 2, ROCK: 3, WATCH: 4, FOREST: 5, BOSS: 6 };

const clampLevel = (l) => Math.max(LEVEL_MIN, Math.min(LEVEL_MAX, l));
// A ramp width from RAMP_WIDTHS, picked by RAMP_WIDTH_WEIGHTS (1-wide a little rarer).
function pickRampWidth(rand) {
  const total = RAMP_WIDTH_WEIGHTS.reduce((a, w) => a + w, 0);
  let r = rand() * total;
  for (let k = 0; k < RAMP_WIDTHS.length; k++) { r -= RAMP_WIDTH_WEIGHTS[k] ?? 0; if (r < 0) return RAMP_WIDTHS[k]; }
  return RAMP_WIDTHS[RAMP_WIDTHS.length - 1];
}

export class GameMap {
  constructor(size) {
    this.size = size;
    const n = size * size;
    this.level = new Int8Array(n);          // height level of each tile
    this.ramp = new Int8Array(n).fill(-1);  // -1, or direction toward the higher neighbour
    this.zone = new Uint8Array(n);
    this.siteId = new Int16Array(n).fill(-1);
    this.tint = new Float32Array(n);       // 0..1, cosmetic ground colour variation
    this.sites = [];
    this.crystals = [];                     // tiles holding a crystal rock (blocks movement/building)
    this.watchstones = [];                  // { x, z, stone } raised mounds; stone = the stone's tile
    this.rareCrystals = new Set();          // subset of crystals that are rare (elite bases)
    this.tunnels = [];                      // { a, b, dirA, dirB, site }: a = in a deep basin, b = far end;
                                            //   dir = direction from that tile to the cliff wall the mouth is set in
    this.noBuild = new Uint8Array(n);       // 1 = can't build here (in front of tunnel mouths)
    this.groves = 0;                        // number of pine groves (their tiles are ZONE.FOREST)
    this.boss = null;                       // { corner: 0-3, cx, cz (the corner point), lair: tile, x, z }
    this.seed = '';
  }

  idx(i, j) { return j * this.size + i; }
  inBounds(i, j) { return i >= 0 && j >= 0 && i < this.size && j < this.size; }
  isBlocked(t) { return this.zone[t] === ZONE.ROCK || this.zone[t] === ZONE.FOREST; } // rock walls, pine groves

  neighbor(t, d) {
    const i = t % this.size + DIRS[d][0];
    const j = ((t / this.size) | 0) + DIRS[d][1];
    return this.inBounds(i, j) ? j * this.size + i : -1;
  }

  // Can a ground unit walk directly between two orthogonally adjacent tiles?
  // Same level: yes. One level apart: only through a ramp facing the higher tile.
  canStep(a, b) {
    if (this.isBlocked(a) || this.isBlocked(b)) return false;
    const la = this.level[a], lb = this.level[b];
    if (la === lb) return true;
    if (lb === la + 1 && this.ramp[a] >= 0 && this.neighbor(a, this.ramp[a]) === b) return true;
    if (la === lb + 1 && this.ramp[b] >= 0 && this.neighbor(b, this.ramp[b]) === a) return true;
    return false;
  }


  tileAt(x, z) {
    const i = Math.max(0, Math.min(this.size - 1, Math.floor(x)));
    const j = Math.max(0, Math.min(this.size - 1, Math.floor(z)));
    return j * this.size + i;
  }

  // Ground height in world units at a continuous position (ramps slope).
  heightAt(x, z) {
    const t = this.tileAt(x, z);
    const base = this.level[t];
    const d = this.ramp[t];
    if (d < 0) return base * LEVEL_HEIGHT;
    const fx = x - Math.floor(x), fz = z - Math.floor(z);
    const k = d === 0 ? fx : d === 1 ? fz : d === 2 ? 1 - fx : 1 - fz;
    return (base + Math.max(0, Math.min(1, k))) * LEVEL_HEIGHT;
  }
}

// ---------------------------------------------------------------------------

// shapes: the custom base shapes from shapes.js (loadShapes).
export function generateMap(seed, shapes) {
  if (String(seed).toLowerCase() === FLAT_SEED) return flatMap(seed);
  let map = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    map = tryGenerate(attempt === 0 ? seed : `${seed}#${attempt}`, shapes);
    if (map.sites.every((s) => s.reachable) && map.watchOk !== false && map.cornersOk !== false
      && map.bossOk !== false && map.accessOk !== false
      && map.sites.filter((s) => !s.removed).length >= BASE_COUNT[0]) break; // at least the minimum bases
  }
  map.seed = seed;
  return map;
}

// The flat test map (seed "flat"): open, perfectly flat ground with only the temple in the
// middle. No bases, cliffs, ramps, trees, watchstones, tunnels or boss. A field of crystal
// rocks south of the temple (two of them gold) lets Quarry helpers be tested, and the defender
// starts just south of the temple, between the two.
export const FLAT_SEED = 'flat';
function flatMap(seed) {
  const S = MAP_SIZE;
  const map = new GameMap(S);
  const rand = mulberry32(hashSeed(seed));
  const noise = createNoise2D(rand);
  for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) map.tint[map.idx(i, j)] = fbm(noise, i * 0.05, j * 0.05, 3);
  const c = S / 2;
  stamp(map, c, c, (dx, dz) => Math.hypot(dx, dz) <= RUIN_RADIUS, 0, ZONE.RUIN);
  // Crystal rocks: two rows of five, 4 tiles apart, 18-22 tiles south of the temple.
  const ci = c | 0, cj = c | 0;
  for (const dj of [18, 22]) {
    for (let k = -2; k <= 2; k++) {
      const t = map.idx(ci + k * 4, cj + dj);
      map.crystals.push(t);
      if (dj === 22 && Math.abs(k) === 2) map.rareCrystals.add(t); // the two far corners are gold
    }
  }
  map.coverage = 0;
  map.seed = seed;
  map.flat = true;
  return map;
}

function tryGenerate(seed, shapes) {
  const S = MAP_SIZE;
  const map = new GameMap(S);
  const rand = mulberry32(hashSeed(seed));
  const noise = createNoise2D(rand);
  const c = S / 2;

  // 1. Everything outside the bases is base level (0). Noise only tints the grass.
  const ox = rand() * 1000, oz = rand() * 1000;
  for (let j = 0; j < S; j++) {
    for (let i = 0; i < S; i++) {
      map.tint[map.idx(i, j)] = fbm(noise, (i + ox) * 0.05, (j + oz) * 0.05, 3);
    }
  }

  // 2. The Colossus's ruined temple in the center.
  stamp(map, c, c, (dx, dz) => Math.hypot(dx, dz) <= RUIN_RADIUS, 0, ZONE.RUIN);
  placeBossZone(map, seed);
  placeWatchstones(map, rand, c);

  // 3. Defender bases built from the custom shapes, richest closest to the center.
  placeSites(map, rand, c, shapes);
  edgeWall(map);

  // 4. Ramps where the shapes mark them, but only where their foot opens onto open ground
  //    that's reachable from the temple (not a pocket sealed off between touching bases).
  const start = map.idx(c | 0, c | 0);
  const ground = floodReach(map, start); // no ramps yet: this is the connected open ground
  placeEntrances(map, rand, ground);
  bossRamps(map, ground);
  watchstoneRamps(map, c, ground);
  ensureAccess(map, start, rand);
  finishSites(map, c);
  if (CORNER_BASES) { // each corner should be mostly base; if one isn't, generateMap tries again
    const C = 14;
    map.cornersOk = [[0, 0], [S - C, 0], [0, S - C], [S - C, S - C]].every(([x0, z0], k) => {
      if (map.boss && map.boss.corner === k) return true; // the boss corner has no base
      let base = 0;
      for (let j = z0; j < z0 + C; j++) for (let i = x0; i < x0 + C; i++) if (map.siteId[j * S + i] >= 0) base++;
      return base >= C * C * 0.5;
    });
  }
  placeCrystals(map, rand);
  const reach = floodReach(map, map.idx(c | 0, c | 0));
  for (let t = 0; t < reach.length; t++) {
    if (reach[t]) continue;
    if (map.zone[t] === ZONE.SITE) map.sites[map.siteId[t]].reachable = false;
    else if (map.zone[t] === ZONE.WATCH && t !== map.watchstones.find((w) => w.stone === t)?.stone) map.watchOk = false;
    else if (map.zone[t] === ZONE.NORMAL || map.zone[t] === ZONE.BOSS) map.zone[t] = ZONE.ROCK;
  }
  if (map.boss) {
    // The arena must be reachable with all its ramps, or generateMap tries again. (The lair
    // tile itself holds the boss, so check the tiles next to it.)
    const L = map.boss.lair;
    map.bossOk = map.boss.ramps === BOSS_ZONE.ramps && [0, 1, 2, 3].some((d) => reach[map.neighbor(L, d)]);
    // Nothing can be built in the arena except turrets on the pads (main.js enforces "turrets only").
    for (let t = 0; t < reach.length; t++) if (map.zone[t] === ZONE.BOSS && !map.boss.pads.includes(t)) map.noBuild[t] = 1;
  }
  // Every base must be enterable straight from open ground (not only through another base).
  map.accessOk = fixAccess(map, map.idx(c | 0, c | 0));
  placeGroves(map, rand, c);
  placeTunnels(map, rand, floodReach(map, map.idx(c | 0, c | 0)));
  return map;
}

// Pine groves: blobs of forest on open ground. They block movement and building. A grove is
// only kept if it doesn't cut any ground off, and groves keep clear of ramps, the temple and
// watchstones, so every base stays reachable.
function placeGroves(map, rand, c) {
  const S = map.size, n = S * S;
  const start = map.idx(c | 0, c | 0);
  const crystal = new Set(map.crystals);
  // Tiles that must stay open: ramps and the ground around them, plus the temple's surroundings.
  const keepClear = new Uint8Array(n);
  for (let t = 0; t < n; t++) {
    const i = t % S, j = (t / S) | 0;
    const near = map.ramp[t] >= 0 ? GROVES.clearance : map.zone[t] === ZONE.RUIN || map.zone[t] === ZONE.WATCH ? 3 : -1;
    for (let dj = -near; dj <= near; dj++) for (let di = -near; di <= near; di++) {
      if (map.inBounds(i + di, j + dj)) keepClear[map.idx(i + di, j + dj)] = 1;
    }
  }
  const open = (t) => map.zone[t] === ZONE.NORMAL && map.level[t] === 0 && map.ramp[t] < 0 && !keepClear[t] && !crystal.has(t);
  let reach = floodReach(map, start);
  const countReach = (r) => { let k = 0; for (let t = 0; t < n; t++) k += r[t]; return k; };
  let reachCount = countReach(reach);
  const want = GROVES.count[0] + Math.floor(rand() * (GROVES.count[1] - GROVES.count[0] + 1));
  const seeds = [];
  for (let tries = 0; map.groves < want && tries < 300; tries++) {
    const s = Math.floor(rand() * n);
    if (!open(s) || !reach[s]) continue;
    const si = s % S, sj = (s / S) | 0;
    if (seeds.some((o) => Math.hypot(o % S - si, ((o / S) | 0) - sj) < GROVES.spacing)) continue;
    // Grow an irregular blob from the seed.
    const size = GROVES.size[0] + Math.floor(rand() * (GROVES.size[1] - GROVES.size[0] + 1));
    const blob = [s], inBlob = new Set([s]);
    for (let k = 0; blob.length < size && k < size * 12; k++) {
      const from = blob[Math.floor(rand() * blob.length)], nb = map.neighbor(from, Math.floor(rand() * 4));
      if (nb >= 0 && !inBlob.has(nb) && open(nb)) { blob.push(nb); inBlob.add(nb); }
    }
    if (blob.length < GROVES.size[0]) continue;
    for (const t of blob) map.zone[t] = ZONE.FOREST;
    // Keep it only if nothing else got cut off, and every base can still be walked into
    // straight from open ground (never only through another base).
    const after = floodReach(map, start);
    const access = directAccess(map, floodOpen(map, start));
    const cutsBase = liveSites(map).some((s) => !access[s.id]);
    if (countReach(after) !== reachCount - blob.length || cutsBase) {
      if (cutsBase && countReach(after) === reachCount - blob.length) map.grovesBlockedAccess = (map.grovesBlockedAccess || 0) + 1;
      for (const t of blob) map.zone[t] = ZONE.NORMAL;
      continue;
    }
    reach = after;
    reachCount -= blob.length;
    seeds.push(s);
    map.groves++;
  }
}

// Tunnels for the Sentinels: from the middle of a deep basin (-2) to open ground on the
// opposite side of the map (the basin's position mirrored through the center).
function placeTunnels(map, rand, reach) {
  const S = map.size, n = S * S;
  const crystal = new Set(map.crystals);
  const deep = map.sites.filter((s) => s.reachable && !s.removed).filter((s) => {
    for (let t = 0; t < n; t++) if (map.siteId[t] === s.id && map.level[t] === -2) return true;
    return false;
  });
  // Shuffle, then take 1-2.
  for (let k = deep.length - 1; k > 0; k--) { const r = Math.floor(rand() * (k + 1)); [deep[k], deep[r]] = [deep[r], deep[k]]; }
  const want = TUNNELS.count[0] + Math.floor(rand() * (TUNNELS.count[1] - TUNNELS.count[0] + 1));
  const used = [];
  for (const site of deep) {
    if (map.tunnels.length >= want) break;
    // Mouth: set into the cliff wall of the basin's -2 floor, near the middle of the floor,
    // preferring taller walls. The Sentinel stands on the floor tile in front of it.
    let cx = 0, cz = 0, m = 0;
    for (let t = 0; t < n; t++) if (map.siteId[t] === site.id && map.level[t] === -2) { cx += t % S + 0.5; cz += ((t / S) | 0) + 0.5; m++; }
    cx /= m; cz /= m;
    const floorOk = (t) => map.siteId[t] === site.id && map.level[t] === -2 && !crystal.has(t) && t !== site.anchor;
    let a = -1, dirA = -1, best = Infinity;
    for (let t = 0; t < n; t++) {
      if (!reach[t] || !floorOk(t)) continue;
      const w = wallAt(map, t);
      if (!w) continue;
      const d = Math.hypot(t % S + 0.5 - cx, ((t / S) | 0) + 0.5 - cz) - (w.drop >= 2 ? 4 : 0) - (w.facing ? 5 : 0);
      if (d < best) { best = d; a = t; dirA = w.dir; }
    }
    if (a < 0) continue;
    // Far end: in a cliff wall (a raised base or the map's edge wall) on open ground, nearest
    // the mirrored point, away from other tunnel ends.
    const tx = S - (a % S) - 0.5, tz = S - ((a / S) | 0) - 0.5;
    let b = -1, dirB = -1;
    best = Infinity;
    for (let t = 0; t < n; t++) {
      if (!reach[t] || map.zone[t] !== ZONE.NORMAL || map.level[t] !== 0 || crystal.has(t)) continue;
      const x = t % S + 0.5, z = ((t / S) | 0) + 0.5;
      const raw = Math.hypot(x - tx, z - tz);
      if (raw - 5 >= best || used.some((u) => Math.hypot(u % S - x, ((u / S) | 0) - z) < 8)) continue;
      const w = wallAt(map, t);
      const d = w ? raw - (w.facing ? 5 : 0) : Infinity;
      if (d < best) { best = d; b = t; dirB = w.dir; }
    }
    if (b < 0) continue;
    map.tunnels.push({ a, b, dirA, dirB, site: site.id });
    used.push(a, b);
    map.noBuild[a] = map.noBuild[b] = 1; // just the tile in front of each mouth
  }
}

// A cliff wall right beside this floor tile that a tunnel mouth can be set into: a neighbour
// at least one level higher (a raised base or the edge wall), with no ramps nearby.
// Returns { dir, drop } for the tallest such wall, or null.
function wallAt(map, t) {
  if (map.ramp[t] >= 0 || map.isBlocked(t)) return null;
  for (let d = 0; d < 4; d++) { const nb = map.neighbor(t, d); if (nb >= 0 && map.ramp[nb] >= 0) return null; }
  // facing: the default camera looks from +x/+z, so it sees cliff faces that point that way:
  // walls on the -x (dir 2) or -z (dir 3) side of the tile. Those are preferred.
  let out = null;
  for (let d = 0; d < 4; d++) {
    const nb = map.neighbor(t, d);
    if (nb < 0 || map.zone[nb] === ZONE.FOREST || map.zone[nb] === ZONE.WATCH) continue;
    const drop = map.level[nb] - map.level[t];
    const facing = d === 2 || d === 3;
    const score = drop + (facing ? 1.5 : 0);
    if (drop >= 1 && (!out || score > out.score)) out = { dir: d, drop, facing, score };
  }
  return out;
}

// The boss zone: a raised (+1) quarter-circle arena in one map corner (picked from the seed,
// with its own random stream so it doesn't reshuffle the rest of the map's choices).
// Turret pads: BOSS_ZONE.pads spots in an arc around the lair, facing out of the corner,
// where the defenders may build turrets (the only building allowed in the arena).
function placeBossZone(map, seed) {
  const S = map.size, R = BOSS_ZONE.radius;
  const corner = Math.floor(mulberry32(hashSeed(`${seed}:boss`))() * 4);
  const cx = corner % 2 ? S : 0, cz = corner >= 2 ? S : 0; // corners: 0 = (0,0), 1 = (S,0), 2 = (0,S), 3 = (S,S)
  stamp(map, cx, cz, (dx, dz) => Math.hypot(dx, dz) <= R, BOSS_ZONE.level, ZONE.BOSS);
  const d = BOSS_ZONE.lair + 0.5;
  const x = cx ? S - d : d, z = cz ? S - d : d;
  const inward = Math.atan2(cz ? -1 : 1, cx ? -1 : 1); // pointing out of the corner
  const pads = [];
  for (let k = 0; k < BOSS_ZONE.pads; k++) {
    const a = inward + (k / (BOSS_ZONE.pads - 1) - 0.5) * BOSS_ZONE.padArc;
    const t = map.tileAt(x + Math.cos(a) * BOSS_ZONE.padDistance, z + Math.sin(a) * BOSS_ZONE.padDistance);
    if (map.zone[t] === ZONE.BOSS && !pads.includes(t)) pads.push(t);
  }
  map.boss = { corner, cx, cz, x, z, lair: map.tileAt(x, z), pads, ramps: 0 };
}

// Ramps up onto the raised arena: BOSS_ZONE.ramps of them, spread evenly around its arc, each
// 2 tiles wide where there's room. ground: reachable open ground (a ramp's foot must be on it).
function bossRamps(map, ground) {
  const B = map.boss;
  if (!B) return;
  const S = map.size, n = S * S, R = BOSS_ZONE.radius;
  const inX = B.cx ? -1 : 1, inZ = B.cz ? -1 : 1;
  const ok = (t, d) => isRampCandidate(map, t, d) && map.zone[map.neighbor(t, d)] === ZONE.BOSS
    && ground[t] && ground[map.neighbor(t, (d + 2) % 4)];
  for (let k = 0; k < BOSS_ZONE.ramps; k++) {
    const a = (Math.PI / 2) * (k + 0.5) / BOSS_ZONE.ramps; // even spread from one map edge to the other
    const px = B.cx + inX * Math.cos(a) * (R + 0.5), pz = B.cz + inZ * Math.sin(a) * (R + 0.5);
    let best = null, bestD = Infinity;
    for (let t = 0; t < n; t++) {
      const dist = Math.hypot(t % S + 0.5 - px, ((t / S) | 0) + 0.5 - pz);
      if (dist > 4 || dist >= bestD) continue;
      for (let d = 0; d < 4; d++) if (ok(t, d)) { best = { t, d }; bestD = dist; break; }
    }
    if (!best) continue;
    map.ramp[best.t] = best.d;
    for (const side of [(best.d + 1) % 4, (best.d + 3) % 4]) { // widen to 2 tiles
      const s = map.neighbor(best.t, side);
      if (s >= 0 && ok(s, best.d)) { map.ramp[s] = best.d; break; }
    }
    B.ramps++;
  }
}

// Set level (and optionally zone) for every tile where inside(dx, dz) holds.
// Never overwrites the ruin or a different base site.
function stamp(map, cx, cz, inside, level, zone, siteId = -1) {
  const S = map.size;
  for (let j = 0; j < S; j++) {
    for (let i = 0; i < S; i++) {
      if (!inside(i + 0.5 - cx, j + 0.5 - cz)) continue;
      const t = map.idx(i, j);
      if (map.zone[t] === ZONE.RUIN) continue;
      if (map.zone[t] === ZONE.SITE && map.siteId[t] !== siteId) continue;
      map.level[t] = level;
      if (zone !== null) { map.zone[t] = zone; map.siteId[t] = siteId; }
    }
  }
}

const ELEVATION_NAMES = { 1: 'plateau', 2: 'high plateau', '-1': 'basin', '-2': 'deep basin' };

// Bases are packed into the map. Each gets a random custom shape, quarter-turn rotation,
// mirroring and size (BASE_RADIUS), and goes at a random spot where it fits: inside the map
// and clear of the temple and watchstones. Usually it keeps a CORRIDOR_WIDTH gap from other
// bases, but about TOUCH_SHARE of all bases back right up against another. Touching bases never
// connect: wherever they meet they must be at different heights (a cliff), and no ramp is
// ever built from one base onto another. Packing keeps going until no more bases fit.
function placeSites(map, rand, c, shapeLib) {
  const S = map.size, n = S * S;
  const hard = new Uint8Array(n); // never usable: temple clearing, watchstones (bases may reach the map edge)
  const halo = new Uint8Array(n); // the corridor around existing bases
  for (let t = 0; t < n; t++) {
    const i = t % S, j = (t / S) | 0;
    if (Math.hypot(i + 0.5 - c, j + 0.5 - c) < RUIN_RADIUS + TEMPLE_CLEARING) hard[t] = 1;
    // The boss zone, plus a corridor around it so its edge stays open ground.
    if (map.boss && Math.hypot(i + 0.5 - map.boss.cx, j + 0.5 - map.boss.cz) <= BOSS_ZONE.radius + CORRIDOR_WIDTH) hard[t] = 1;
  }
  for (const w of map.watchstones) {
    const R = WATCHSTONES.radius + CORRIDOR_WIDTH + 1;
    for (let j = Math.floor(w.z) - R; j <= Math.floor(w.z) + R; j++) {
      for (let i = Math.floor(w.x) - R; i <= Math.floor(w.x) + R; i++) {
        if (map.inBounds(i, j) && Math.hypot(i + 0.5 - w.x, j + 0.5 - w.z) <= R) hard[j * S + i] = 1;
      }
    }
  }
  const corridor = [];
  for (let dj = -CORRIDOR_WIDTH; dj <= CORRIDOR_WIDTH; dj++) {
    for (let di = -CORRIDOR_WIDTH; di <= CORRIDOR_WIDTH; di++) {
      if (Math.hypot(di, dj) <= CORRIDOR_WIDTH + 0.01) corridor.push([di, dj]);
    }
  }

  const QUARTER = [[1, 0], [0, 1], [-1, 0], [0, -1]]; // [cos, sin] for 0°, 90°, 180°, 270°

  // A random look for a base: shape (weighted), quarter-turn rotation, mirroring, size.
  // size: the radius range (BASE_RADIUS, or INNER_BASES.radius for the smaller middle bases).
  const randomLook = (size = BASE_RADIUS) => {
    const shape = pickShape(shapeLib, rand); // weighted: set per shape in the editor
    const [cos, sin] = QUARTER[Math.floor(rand() * 4)];
    const radius = size[0] + rand() * (size[1] - size[0]);
    return { shape, cos, sin, mirror: rand() < 0.5, radius };
  };

  // Work out a base with this look centered at (x, z), without placing it. Returns null if it
  // doesn't fit. allowTouch: it may back right up against other bases (else it must keep the
  // corridor clear).
  const planBase = (x, z, look, allowTouch) => {
    const center = map.tileAt(x, z);
    if (hard[center] || map.siteId[center] >= 0) return null;
    if (!allowTouch && halo[center]) return null;
    const { shape, cos, sin, mirror, radius } = look;
    const form = { shape, cos, sin, mirror, k: radius / shape.radius };
    const probe = { x, z, form };

    // Every tile this base would cover, or give up as soon as one is taken.
    const tiles = [];
    const R = Math.ceil(radius) + 1, ci = Math.floor(x), cj = Math.floor(z);
    for (let j = cj - R; j <= cj + R; j++) {
      for (let i = ci - R; i <= ci + R; i++) {
        const [sx, sz] = toShapeFrame(probe, i + 0.5 - x, j + 0.5 - z);
        const tier = sampleShape(shape, sx / form.k, sz / form.k);
        if (!tier) continue;
        const t = j * S + i;
        if (!map.inBounds(i, j) || hard[t] || map.siteId[t] >= 0 || (!allowTouch && halo[t])) return null;
        tiles.push([t, tier]);
      }
    }
    if (!tiles.length) return null;

    // A two-tier shape whose inner tier came out too small to use becomes one-tier.
    const twoTier = shape.twoTier && tiles.filter(([, tier]) => tier === 2).length >= 6;
    const levelOf = (tier, sign) => sign * (twoTier && tier === 2 ? 2 : 1);

    // Where it touches other bases: at most MAX_TOUCH_SHARE of its edge, and at a different
    // height on every touching side (raised or sunk is picked to make that work).
    const mine = new Set(tiles.map(([t]) => t));
    let edge = 0, touching = 0;
    const contacts = []; // [tier of my tile, level of the other base's tile]
    const neighbors = new Set(); // ids of the bases it touches
    for (const [t, tier] of tiles) {
      let isEdge = false, isTouch = false;
      for (let d = 0; d < 4; d++) {
        const nb = map.neighbor(t, d);
        if (nb >= 0 && mine.has(nb)) continue;
        isEdge = true;
        if (nb >= 0 && map.siteId[nb] >= 0) {
          isTouch = true;
          contacts.push([tier, map.level[nb]]);
          neighbors.add(map.siteId[nb]);
        }
      }
      if (isEdge) edge++;
      if (isTouch) touching++;
    }
    if (touching > edge * MAX_TOUCH_SHARE) return null;
    const signs = rand() < 0.5 ? [1, -1] : [-1, 1];
    const sign = signs.find((s) => contacts.every(([tier, other]) => levelOf(tier, s) !== other));
    if (sign === undefined) return null;
    const plan = { x, z, form, tiles, level: sign * (twoTier ? 2 : 1), levelOf, sign, neighbors };
    return leavesNeighborsOpen(plan) ? plan : null;
  };

  // Slide a new base toward an existing one until they touch; returns that plan or null.
  const planTouching = () => {
    if (!map.sites.length) return null;
    const other = map.sites[Math.floor(rand() * map.sites.length)];
    const look = randomLook();
    const [dx, dz] = QUARTER[Math.floor(rand() * 4)];
    const otherR = other.form.k * other.form.shape.radius;
    const side = (rand() - 0.5) * otherR; // slide in a little off-center
    let fitted = false;
    for (let d = Math.ceil(otherR + look.radius + 3); d >= 0; d--) {
      const plan = planBase(other.x + dx * d - dz * side, other.z + dz * d + dx * side, look, true);
      if (plan && plan.neighbors.size) return plan; // made contact
      if (plan) fitted = true;
      else if (fitted) return null; // bumped into something without a clean touch
    }
    return null;
  };

  // Slide a new base outward toward a random map edge until it reaches the edge.
  const onEdge = (t) => { const i = t % S, j = (t / S) | 0; return i === 0 || j === 0 || i === S - 1 || j === S - 1; };
  // Can a ramp reach this base? Some of its lower (±1) tier must face open ground that won't
  // become edge wall. (Squeezed into a corner, a two-tier base can end up with only its high
  // tier facing the map, which no ramp can climb.)
  const inWall = (t) => { const i = t % S, j = (t / S) | 0; return Math.min(i, j, S - 1 - i, S - 1 - j) < EDGE_WALL; };
  // Open ground a ramp could start from: no base on it (nor in `taken`), not wall, not a mound.
  const freeGround = (t, taken) => t >= 0 && map.siteId[t] < 0 && !taken.has(t) && !inWall(t)
    && (map.zone[t] === ZONE.NORMAL || map.zone[t] === ZONE.RUIN);
  // How many of these base tiles on its lower tier face 2 tiles of free ground (room for a ramp)?
  const openFaces = (tiles, isLow, taken) => {
    let open = 0;
    for (const [t, tier] of tiles) {
      if (!isLow(t, tier)) continue;
      for (let d = 0; d < 4; d++) {
        const nb = map.neighbor(t, d);
        if (freeGround(nb, taken) && freeGround(nb >= 0 ? map.neighbor(nb, d) : -1, taken)) { open++; break; }
      }
      if (open >= 3) break;
    }
    return open;
  };
  const facesOpen = (plan) => openFaces(plan.tiles, (t, tier) => Math.abs(plan.levelOf(tier, 1)) === 1,
    new Set(plan.tiles.map(([t]) => t))) >= 3;
  // A new base must not smother the bases it backs onto: each must keep open faces.
  const leavesNeighborsOpen = (plan) => {
    if (!plan.neighbors.size) return true;
    const taken = new Set(plan.tiles.map(([t]) => t));
    for (const id of plan.neighbors) {
      const s = map.sites[id];
      if (openFaces(s.tiles, (t) => Math.abs(map.level[t]) === 1, taken) < 3) return false;
    }
    return true;
  };
  const planEdge = (allowTouch) => {
    const look = randomLook();
    const side = Math.floor(rand() * 4), along = 4 + rand() * (S - 8);
    let fitted = false;
    for (let d = Math.ceil(look.radius) + 4; d >= 0; d--) { // d: center's distance from that edge
      const x = side === 0 ? d + 0.5 : side === 1 ? S - d - 0.5 : along;
      const z = side === 2 ? d + 0.5 : side === 3 ? S - d - 0.5 : along;
      const plan = planBase(x, z, look, allowTouch);
      if (plan && plan.tiles.some(([t]) => onEdge(t))) return facesOpen(plan) ? plan : null; // backed up to the edge
      if (plan) fitted = true;
      else if (fitted) return null; // bumped into something first
    }
    return null;
  };

  const touched = new Set(); // ids of bases that touch at least one other base
  const place = (plan) => {
    const id = map.sites.length;
    addBase(plan.x, plan.z, plan.form, plan.tiles, plan.level, plan.levelOf, plan.sign);
    if (plan.neighbors.size) { touched.add(id); for (const nb of plan.neighbors) touched.add(nb); }
  };

  // Place BASE_COUNT bases. About TOUCH_SHARE of them are placed backed up against another
  // base; the rest are spread out: up to SPREAD_CANDIDATES spots where it fits, and the one
  // farthest from the bases already placed wins.
  const target = BASE_COUNT[0] + Math.floor(rand() * (BASE_COUNT[1] - BASE_COUNT[0] + 1));
  // Corners first: fill each corner with the base that covers it best. Each try slides a
  // base diagonally into the corner, then along the edge it hit, until it meets both edges.
  if (CORNER_BASES) {
    const CORNER = 14; // size of the corner area being filled (tiles)
    for (const [cx, cz] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      if (map.boss && map.boss.corner === cx + cz * 2) continue; // the boss corner stays free
      const ex = cx ? S - 1 : 0, ez = cz ? S - 1 : 0;     // the corner tile
      const dx = cx ? 1 : -1, dz = cz ? 1 : -1;           // direction toward the corner
      const hitsX = (p) => p.tiles.some(([t]) => t % S === ex);
      const hitsZ = (p) => p.tiles.some(([t]) => ((t / S) | 0) === ez);
      const cover = (p) => p.tiles.filter(([t]) =>
        Math.abs(t % S - ex) < CORNER && Math.abs(((t / S) | 0) - ez) < CORNER).length;
      let best = null, bestScore = 0;
      for (let a = 0; a < 40; a++) {
        const look = randomLook();
        let x = cx ? S - look.radius - 4 : look.radius + 4, z = cz ? S - look.radius - 4 : look.radius + 4;
        let plan = null;
        for (let step = 0; step < 30; step++, x += dx, z += dz) { // diagonal slide
          const p = planBase(x, z, look, false);
          if (!p) { if (plan) break; continue; }
          plan = p;
          if (hitsX(p) || hitsZ(p)) break;
        }
        if (!plan) continue;
        for (let step = 0; step < 30 && !(hitsX(plan) && hitsZ(plan)); step++) { // slide along the edge
          const p = planBase(hitsX(plan) ? plan.x : plan.x + dx, hitsZ(plan) ? plan.z : plan.z + dz, look, false);
          if (!p) break;
          plan = p;
        }
        if (!facesOpen(plan)) continue; // a ramp must be able to reach it
        const score = cover(plan);
        if (score > bestScore) { bestScore = score; best = plan; }
      }
      if (best) place(best);
    }
  }
  // Inner bases: a few out in the middle of the map, in a ring around the temple (not on
  // the edge), spread apart: each takes the best of several spots, farthest from the others.
  const innerTarget = INNER_BASES.count[0] + Math.floor(rand() * (INNER_BASES.count[1] - INNER_BASES.count[0] + 1));
  // Placed before the edge bases, so the middle gets room first. Each takes, of several spots,
  // the one covering the most open ground in the middle ring (and kept apart from the others).
  const ringMax = c * INNER_BASES.maxDistance + 2;
  const inRing = (t) => {
    const d = Math.hypot(t % S + 0.5 - c, ((t / S) | 0) + 0.5 - c);
    return d >= RUIN_RADIUS + TEMPLE_CLEARING && d <= ringMax;
  };
  const innerMin = RUIN_RADIUS + TEMPLE_CLEARING + 3, innerMax = c * INNER_BASES.maxDistance;
  for (let k = 0; k < innerTarget; k++) {
    let best = null, bestScore = -1, found = 0;
    for (let a = 0; a < 600 && found < 16; a++) {
      const ang = rand() * Math.PI * 2, d = innerMin + rand() * Math.max(1, innerMax - innerMin);
      const plan = planBase(c + Math.cos(ang) * d, c + Math.sin(ang) * d, randomLook(INNER_BASES.radius), false);
      if (!plan || plan.tiles.some(([t]) => inWall(t) || Math.min(t % S, (t / S) | 0, S - 1 - t % S, S - 1 - ((t / S) | 0)) < EDGE_WALL + 3)) continue;
      if (!facesOpen(plan)) continue;
      found++;
      let spread = Infinity;
      for (const s of map.sites) spread = Math.min(spread, Math.hypot(s.x - plan.x, s.z - plan.z));
      const score = plan.tiles.filter(([t]) => inRing(t)).length + Math.min(spread, 30) * 2;
      if (score > bestScore) { bestScore = score; best = plan; }
    }
    if (best) place(best);
  }

  // Then line the map edges: about EDGE_SHARE of the bases back up against the edge.
  for (let fails = 0; map.sites.length < target * EDGE_SHARE && fails < 200;) {
    const plan = planEdge(false) || planEdge(true);
    if (plan) { place(plan); fails = 0; } else fails++;
  }
  while (map.sites.length < target) {
    if (touched.size < TOUCH_SHARE * target) {
      let plan = null;
      for (let a = 0; a < 60 && !plan; a++) plan = planTouching();
      if (plan) { place(plan); continue; }
    }
    let best = null, bestScore = -1, found = 0;
    for (let a = 0; a < PLACEMENT_TRIES && found < SPREAD_CANDIDATES; a++) {
      const plan = planBase(2 + rand() * (S - 4), 2 + rand() * (S - 4), randomLook(), false);
      if (!plan) continue;
      found++;
      let score = Infinity;
      for (const s of map.sites) score = Math.min(score, Math.hypot(s.x - plan.x, s.z - plan.z));
      if (score > bestScore) { bestScore = score; best = plan; }
    }
    if (!best) break; // random spots found no room; the sweep below looks properly
    place(best);
  }
  // Still short? Sweep every spot (2-tile grid, random order) for gaps random tries missed:
  // first full-size bases keeping the corridor, then small ones (INNER_BASES.radius) that fit
  // the leftover gaps, then letting bases touch if that's the only way in.
  if (map.sites.length < target) {
    const spots = [];
    for (let z = 3; z < S - 3; z += 2) for (let x = 3; x < S - 3; x += 2) spots.push([x + rand(), z + rand()]);
    for (let k = spots.length - 1; k > 0; k--) {
      const m = Math.floor(rand() * (k + 1));
      [spots[k], spots[m]] = [spots[m], spots[k]];
    }
    for (const [size, allowTouch] of [[BASE_RADIUS, false], [INNER_BASES.radius, false], [INNER_BASES.radius, true]]) {
      for (const [x, z] of spots) {
        if (map.sites.length >= target) break;
        for (let a = 0; a < 8; a++) {
          const plan = planBase(x, z, randomLook(size), allowTouch);
          if (plan && (allowTouch || facesOpen(plan))) { place(plan); break; }
        }
      }
    }
  }

  // Fill the middle some more: any room still left in the middle ring gets extra bases (up to
  // BASE_COUNT's max), each time the candidate covering the most of that ring's open ground.
  while (map.sites.length < BASE_COUNT[1]) {
    let best = null, bestCover = INNER_BASES.centerFill - 1;
    for (let a = 0; a < 300; a++) {
      const ang = rand() * Math.PI * 2, d = innerMin + rand() * (ringMax - innerMin);
      const size = a % 3 ? INNER_BASES.radius : BASE_RADIUS;
      // May back up against other bases (always a cliff between, never connected).
      const plan = planBase(c + Math.cos(ang) * d, c + Math.sin(ang) * d, randomLook(size), a % 2 === 0);
      if (!plan || !facesOpen(plan)) continue;
      const cover = plan.tiles.filter(([t]) => inRing(t)).length;
      if (cover > bestCover) { bestCover = cover; best = plan; }
    }
    if (!best) break;
    place(best);
    map.centerFilled = (map.centerFilled || 0) + 1;
  }

  function addBase(x, z, form, tiles, level, levelOf, sign) {
    const id = map.sites.length;
    map.sites.push({
      id, x, z, shape: form.shape.name, elevation: ELEVATION_NAMES[level], level, reachable: true,
      form,       // how the shape sits here: rotation, mirroring, k = tiles per painted cell
      tiles,      // [tile, tier] it covers (used while placing other bases)
      anchor: -1, // base tile nearest the center, where the banner stands
      removed: false,
      // Filled in by rateSites() once the base's final area is known:
      value: 1, quality: 0, crystalCount: 0, elite: false, area: 0,
    });
    for (const [t, tier] of tiles) {
      map.zone[t] = ZONE.SITE;
      map.siteId[t] = id;
      map.level[t] = levelOf(tier, sign);
      const i = t % S, j = (t / S) | 0;
      for (const [di, dj] of corridor) { // the corridor other (non-touching) bases keep clear of
        if (map.inBounds(i + di, j + dj)) halo[(j + dj) * S + i + di] = 1;
      }
    }
  }

  // Drop stray fragments: keep each base's largest piece.
  for (const site of map.sites) {
    keepLargest(map, (t) => map.siteId[t] === site.id, (t) => {
      map.zone[t] = ZONE.NORMAL; map.siteId[t] = -1; map.level[t] = 0;
    });
  }
}

// The map's border is not a walkway: any open ground within EDGE_WALL tiles of the edge
// becomes a high, impassable rock wall (bases that reach the edge stay as they are).
function edgeWall(map) {
  const S = map.size;
  for (let t = 0; t < S * S; t++) {
    const i = t % S, j = (t / S) | 0;
    if (Math.min(i, j, S - 1 - i, S - 1 - j) >= EDGE_WALL || (map.zone[t] !== ZONE.NORMAL && map.zone[t] !== ZONE.BOSS)) continue;
    map.zone[t] = ZONE.ROCK;
    map.level[t] = 2;
  }
}

// Remove a base completely (its tiles become open ground, its ramps go).
function removeSite(map, site) {
  const S = map.size;
  for (let t = 0; t < S * S; t++) {
    if (map.siteId[t] === site.id) {
      map.zone[t] = ZONE.NORMAL; map.siteId[t] = -1; map.level[t] = 0; map.ramp[t] = -1;
      const i = t % S, j = (t / S) | 0;
      if (Math.min(i, j, S - 1 - i, S - 1 - j) < EDGE_WALL) { map.zone[t] = ZONE.ROCK; map.level[t] = 2; } // keep the edge walled
    } else if (map.ramp[t] >= 0) {
      const hi = map.neighbor(t, map.ramp[t]);
      if (hi >= 0 && map.siteId[hi] === site.id) map.ramp[t] = -1; // a ramp up onto it
    }
  }
  site.removed = true;
}

// Turn a two-tier base into a one-tier base (its ±2 tier drops to ±1). Refused (false) if
// that would put it level with a touching base, which would join the two.
function flattenSite(map, site) {
  const S = map.size, n = S * S, low = Math.sign(site.level);
  for (let t = 0; t < n; t++) {
    if (map.siteId[t] !== site.id || map.level[t] !== site.level) continue;
    for (let d = 0; d < 4; d++) {
      const nb = map.neighbor(t, d);
      if (nb >= 0 && map.siteId[nb] >= 0 && map.siteId[nb] !== site.id && map.level[nb] === low) return false;
    }
  }
  for (let t = 0; t < n; t++) {
    if (map.siteId[t] !== site.id) continue;
    if (map.level[t] === site.level) map.level[t] = low;
    if (map.ramp[t] >= 0 && map.siteId[map.neighbor(t, map.ramp[t])] === site.id) map.ramp[t] = -1; // old inner ramps
  }
  site.level = low;
  site.elevation = ELEVATION_NAMES[low];
  return true;
}

// The unreachable pocket of open ground next to a cut-off base: which later-placed base
// borders it (and so helped seal it)? Returns the most recently placed one, or null.
function pocketCulprit(map, site, reach) {
  const S = map.size, n = S * S;
  const seen = new Uint8Array(n), stack = [];
  for (let t = 0; t < n; t++) {
    if (map.siteId[t] !== site.id) continue;
    for (let d = 0; d < 4; d++) {
      const nb = map.neighbor(t, d);
      if (nb >= 0 && !seen[nb] && !reach[nb] && map.siteId[nb] < 0 && map.zone[nb] === ZONE.NORMAL) { seen[nb] = 1; stack.push(nb); }
    }
  }
  let culprit = null;
  while (stack.length) {
    const t = stack.pop();
    for (let d = 0; d < 4; d++) {
      const nb = map.neighbor(t, d);
      if (nb < 0) continue;
      const id = map.siteId[nb];
      if (id >= 0) {
        const s = map.sites[id];
        if (id !== site.id && !s.removed && id > site.id && (!culprit || id > culprit.id)) culprit = s;
      } else if (!seen[nb] && !reach[nb] && map.zone[nb] === ZONE.NORMAL) { seen[nb] = 1; stack.push(nb); }
    }
  }
  return culprit;
}

// Every ramp must be usable from the open map, and every base reachable.
// Ramps whose ends can't be reached are removed; a base that still can't be reached after
// trying to give it a ramp is removed, which may open up the ground around it for others.
function ensureAccess(map, start, rand) {
  const S = map.size, n = S * S;
  for (let round = 0; round < 6; round++) {
    connectStragglers(map, start, rand);
    let reach = floodReach(map, start);
    for (let t = 0; t < n; t++) {
      if (map.ramp[t] < 0) continue;
      const hi = map.neighbor(t, map.ramp[t]);
      if (!reach[t] || hi < 0 || !reach[hi]) map.ramp[t] = -1;
    }
    reach = floodReach(map, start);
    let removedAny = false;
    for (const site of map.sites) {
      if (site.removed) continue;
      let cut = 0, inside = 0;
      for (let t = 0; t < n; t++) if (map.siteId[t] === site.id) { inside++; if (!reach[t]) cut++; }
      if (!cut) continue;
      // Only its high (±2) tier cut off? Flatten it to one tier instead of losing the base,
      // as long as that doesn't leave it level with a base it touches.
      if (cut < inside && Math.abs(site.level) === 2 && flattenSite(map, site)) { removedAny = true; continue; }
      // Fully cut off, facing a pocket of ground that later bases sealed off? Remove the most
      // recently placed base around that pocket instead (corner and edge bases go first, so
      // they're kept), and try again.
      if (cut === inside) {
        const culprit = pocketCulprit(map, site, reach);
        if (culprit) { removeSite(map, culprit); removedAny = true; continue; }
      }
      removeSite(map, site);
      removedAny = true;
    }
    if (!removedAny) return;
  }
}

// After access is settled: drop removed bases, renumber, then banners, coverage, ratings.
function finishSites(map, c) {
  const S = map.size, n = S * S;
  const kept = map.sites.filter((s) => !s.removed);
  const newId = new Map(kept.map((s, k) => [s.id, k]));
  for (let t = 0; t < n; t++) if (map.siteId[t] >= 0) map.siteId[t] = newId.get(map.siteId[t]) ?? -1;
  kept.forEach((s, k) => { s.id = k; });
  map.sites = kept;

  // Banner tile: the base tile nearest its center.
  for (const site of map.sites) {
    let best = -1, bestD = Infinity;
    for (let t = 0; t < n; t++) {
      if (map.siteId[t] !== site.id) continue;
      const d = Math.hypot(t % S + 0.5 - site.x, ((t / S) | 0) + 0.5 - site.z);
      if (d < bestD) { bestD = d; best = t; }
    }
    site.anchor = best;
  }
  let count = 0;
  for (let t = 0; t < n; t++) if (map.zone[t] === ZONE.SITE) count++;
  map.coverage = count / n;
  rateSites(map, c);
}

// World offset from a base's center (tiles) → the shape's own frame (tiles), and back.
function toShapeFrame(site, rx, rz) {
  const f = site.form, sx = rx * f.cos + rz * f.sin;
  return [f.mirror ? -sx : sx, -rx * f.sin + rz * f.cos];
}
function shapeToWorld(site, [cx, cy]) {
  const f = site.form;
  const x = (f.mirror ? -cx : cx) * f.k, z = cy * f.k;
  return { x: site.x + x * f.cos - z * f.sin, z: site.z + x * f.sin + z * f.cos };
}

// How good is each base? Sets quality, stars (value), crystal count and elite status.
function rateSites(map, c) {
  for (let t = 0; t < map.siteId.length; t++) if (map.siteId[t] >= 0) map.sites[map.siteId[t]].area++;
  const maxArea = Math.max(...map.sites.map((s) => s.area));
  for (const s of map.sites) {
    const closeness = 1 - Math.min(1, Math.hypot(s.x - c, s.z - c) / (c * Math.SQRT2));
    s.quality = QUALITY_WEIGHTS.closeness * closeness + QUALITY_WEIGHTS.size * (s.area / maxArea);
  }
  const ranked = [...map.sites].sort((a, b) => b.quality - a.quality);
  ranked.forEach((s, k) => {
    const pct = ranked.length > 1 ? 1 - k / (ranked.length - 1) : 1; // 1 = best, 0 = worst
    s.value = k < ranked.length * STAR_SHARES[3] ? 3
      : k < ranked.length * (STAR_SHARES[3] + STAR_SHARES[2]) ? 2 : 1;
    s.crystalCount = Math.round(CRYSTALS_MIN + pct * (CRYSTALS_MAX - CRYSTALS_MIN));
    s.elite = k < ELITE_BASES;
  });
}

// Among tiles matching `member`, keep the largest 4-connected group; call `drop` on the rest.
function keepLargest(map, member, drop) {
  const n = map.size * map.size;
  const comp = new Int32Array(n).fill(-1);
  const groups = [];
  const queue = new Int32Array(n);
  for (let s = 0; s < n; s++) {
    if (comp[s] >= 0 || !member(s)) continue;
    const tiles = [];
    let head = 0, tail = 0;
    queue[tail++] = s; comp[s] = groups.length;
    while (head < tail) {
      const t = queue[head++];
      tiles.push(t);
      for (let d = 0; d < 4; d++) {
        const nb = map.neighbor(t, d);
        if (nb < 0 || comp[nb] >= 0 || !member(nb)) continue;
        comp[nb] = groups.length; queue[tail++] = nb;
      }
    }
    groups.push(tiles);
  }
  groups.sort((a, b) => b.length - a.length);
  for (let g = 1; g < groups.length; g++) for (const t of groups[g]) drop(t);
}

// Crystal rocks go on the base's top (or bottom) tier, away from edges and ramps so
// they never block a path, and away from the center so a Town Hall still fits.
function placeCrystals(map, rand) {
  const S = map.size;
  // tier: 'core' = the ±2 top/bottom, 'outer' = the ±1 ring, 'any' = either.
  const collect = (site, tier) => {
    const ci = Math.floor(site.x), cj = Math.floor(site.z);
    const out = [];
    for (let j = 0; j < S; j++) {
      for (let i = 0; i < S; i++) {
        if (Math.hypot(i - ci, j - cj) < 3.5) continue;
        const t = map.idx(i, j);
        if (map.siteId[t] !== site.id) continue;
        if (tier === 'core' && map.level[t] !== site.level) continue;
        if (tier === 'outer' && map.level[t] === site.level) continue;
        // Interior only: all 8 neighbours on the same tier of this base, no ramps.
        let interior = true;
        for (let nj = -1; nj <= 1 && interior; nj++) {
          for (let ni = -1; ni <= 1; ni++) {
            if (!map.inBounds(i + ni, j + nj)) { interior = false; break; }
            const n = map.idx(i + ni, j + nj);
            if (map.siteId[n] !== site.id || map.level[n] !== map.level[t] || map.ramp[n] >= 0) { interior = false; break; }
          }
        }
        if (interior) out.push(t);
      }
    }
    return out;
  };
  for (const site of map.sites) {
    const want = site.crystalCount;
    let placed = 0;
    // Two-tier bases split crystals between tiers; then 'any' fills a shortfall on either.
    const tiered = Math.abs(site.level) === 2;
    const outerWant = tiered ? Math.round(want * CRYSTAL_OUTER_SHARE) : 0;
    const plan = tiered
      ? [['outer', outerWant], ['core', want], ['any', want]]
      : [['any', want]];
    for (const [tier, upTo] of plan) {
      const candidates = collect(site, tier);
      while (placed < upTo && candidates.length) {
        const t = candidates.splice(Math.floor(rand() * candidates.length), 1)[0];
        const ti = t % S, tj = (t / S) | 0;
        if (map.crystals.some((o) => Math.hypot(o % S - ti, ((o / S) | 0) - tj) < 4)) continue;
        map.crystals.push(t);
        if (site.elite) map.rareCrystals.add(t);
        placed++;
      }
    }
  }
}

function isRampCandidate(map, t, d) {
  if (map.isBlocked(t) || map.ramp[t] >= 0 || map.zone[t] === ZONE.RUIN) return false;
  const hi = map.neighbor(t, d), back = map.neighbor(t, (d + 2) % 4);
  if (hi < 0 || back < 0 || map.isBlocked(hi) || map.isBlocked(back)) return false;
  return map.level[hi] === map.level[t] + 1 && map.level[back] === map.level[t];
}

// Ramps go where each shape marks them: on the base edge nearest each entrance marker
// (ground ↔ tier 1) and on the tier edge nearest each inner ramp marker (tier 1 ↔ tier 2).
// Each ramp is randomly 1 or 2 tiles wide (RAMP_WIDTHS), whatever the base's size.
// ground: open ground reachable from the temple. An entrance's foot must be on it.
function placeEntrances(map, rand, ground) {
  const S = map.size, n = S * S;
  const outer = map.sites.map(() => []), inner = map.sites.map(() => []);
  // Is this entrance's foot on reachable open ground? (Plateau: the ramp tile and the tile
  // behind it are ground. Basin: the ramp is inside the base and climbs out onto ground.)
  const footOk = (t, d) => (map.siteId[t] < 0
    ? ground[t] && ground[map.neighbor(t, (d + 2) % 4)]
    : ground[map.neighbor(t, d)]);
  for (let t = 0; t < n; t++) {
    for (let d = 0; d < 4; d++) {
      if (!isRampCandidate(map, t, d)) continue;
      const a = map.siteId[t], b = map.siteId[map.neighbor(t, d)];
      if (a >= 0 && b >= 0) { if (a === b) inner[a].push({ t, d, out: false }); } // never base-to-base
      else if ((a >= 0 || b >= 0) && footOk(t, d)) outer[a >= 0 ? a : b].push({ t, d, out: true });
    }
  }
  // A spot beside the ramp that can take its second tile, or -1.
  const widenSpot = (t, d, out) => {
    for (const side of [(d + 1) % 4, (d + 3) % 4]) {
      const s = map.neighbor(t, side);
      if (s >= 0 && isRampCandidate(map, s, d) && map.siteId[map.neighbor(s, d)] === map.siteId[map.neighbor(t, d)]
        && (!out || footOk(s, d))) return s;
    }
    return -1;
  };
  const carve = (list, p) => {
    const width = pickRampWidth(rand);
    // Nearest spot to the marker; for a 2-wide ramp, nearest spot with room for both tiles
    // (falling back to a 1-wide ramp if there is none).
    for (const needWide of width >= 2 ? [true, false] : [false]) {
      let best = null, bestD = Infinity;
      for (const cand of list) {
        if (!isRampCandidate(map, cand.t, cand.d)) continue;
        if (needWide && widenSpot(cand.t, cand.d, cand.out) < 0) continue;
        const d = Math.hypot(cand.t % S + 0.5 - p.x, ((cand.t / S) | 0) + 0.5 - p.z);
        if (d < bestD) { bestD = d; best = cand; }
      }
      // Don't wander far from the marker just to find room for a wide ramp.
      if (!best || (needWide && bestD > 4)) continue;
      const side = needWide ? widenSpot(best.t, best.d, best.out) : -1;
      map.ramp[best.t] = best.d;
      if (side >= 0) map.ramp[side] = best.d;
      return;
    }
  };
  for (const site of map.sites) {
    const shape = site.form.shape;
    // A shape with no entrance marked gets one at a random spot on its edge.
    // (Anything still cut off afterwards is fixed by connectStragglers.)
    const entrances = shape.entrances.length ? shape.entrances
      : [[Math.cos(rand() * 6.283) * shape.radius, Math.sin(rand() * 6.283) * shape.radius]];
    for (const m of entrances) carve(outer[site.id], shapeToWorld(site, m));
    if (Math.abs(site.level) === 2) {
      const markers = shape.innerRamps.length ? shape.innerRamps : entrances;
      for (const m of markers) carve(inner[site.id], shapeToWorld(site, m));
    }
  }
}

// Safety net: scaling or rotating a shape can leave a marked ramp spot with no room for a
// ramp (e.g. an arch's gap closing up), cutting off a base or one of its tiers. Add a
// ramp wherever one can join a cut-off part to the reachable map, until nothing is cut off.
function connectStragglers(map, start, rand) {
  const S = map.size, n = S * S;
  for (let pass = 0; pass < 60; pass++) {
    const reach = floodReach(map, start);
    let cut = -1;
    for (let t = 0; t < n; t++) if (!reach[t] && map.zone[t] === ZONE.SITE) { cut = t; break; }
    if (cut < 0) return;
    // The ramp joining reachable ground to the cut-off part that sits closest to it.
    let best = null, bestD = Infinity;
    for (let t = 0; t < n; t++) {
      for (let d = 0; d < 4; d++) {
        if (!isRampCandidate(map, t, d)) continue;
        const hi = map.neighbor(t, d);
        if (reach[t] === reach[hi]) continue;
        const inside = reach[t] ? hi : t, outside = reach[t] ? t : hi;
        if (map.siteId[inside] !== map.siteId[cut]) continue;
        // Never join two different bases; and a ramp from the ground needs its foot reachable.
        if (map.siteId[outside] >= 0 && map.siteId[outside] !== map.siteId[cut]) continue;
        if (outside === t && map.siteId[t] < 0 && !reach[map.neighbor(t, (d + 2) % 4)]) continue;
        const dd = Math.hypot(t % S - cut % S, ((t / S) | 0) - ((cut / S) | 0));
        if (dd < bestD) { bestD = dd; best = { t, d }; }
      }
    }
    if (!best) return; // nothing can join it; tryGenerate will flag the base as unreachable
    map.ramp[best.t] = best.d;
    if (pickRampWidth(rand) >= 2) {
      for (const side of [(best.d + 1) % 4, (best.d + 3) % 4]) {
        const s = map.neighbor(best.t, side);
        // The second tile must join the same two places as the first.
        if (s >= 0 && isRampCandidate(map, s, best.d) && map.siteId[s] === map.siteId[best.t]
          && map.siteId[map.neighbor(s, best.d)] === map.siteId[map.neighbor(best.t, best.d)]) {
          map.ramp[s] = best.d;
          break;
        }
      }
    }
  }
}

// Watchstones: 1–2 small raised (+1) mounds, spread around the map at mid distance from
// the temple, each with a standing stone in the middle (the stone's tile blocks movement).
function placeWatchstones(map, rand, c) {
  const S = map.size, W = WATCHSTONES;
  const count = W.count[0] + Math.floor(rand() * (W.count[1] - W.count[0] + 1));
  const a0 = rand() * Math.PI * 2;
  for (let k = 0; k < count; k++) {
    const angle = a0 + (k / count) * Math.PI * 2 + (rand() - 0.5) * 0.6; // spread around the map
    const dist = c * (W.distance[0] + rand() * (W.distance[1] - W.distance[0]));
    let ox = Math.cos(angle) * dist, oz = Math.sin(angle) * dist;
    // Keep out of the map corners (they're filled with bases): if it's near a corner,
    // pull it in along the shorter axis, toward the middle of the nearest edge.
    const lim = c - (14 + W.radius + CORRIDOR_WIDTH + 1);
    if (CORNER_BASES && Math.abs(ox) > lim && Math.abs(oz) > lim) {
      if (Math.abs(ox) < Math.abs(oz)) ox = Math.sign(ox) * lim; else oz = Math.sign(oz) * lim;
    }
    const x = Math.floor(c + ox) + 0.5, z = Math.floor(c + oz) + 0.5;
    stamp(map, x, z, (dx, dz) => Math.hypot(dx, dz) <= W.radius, 1, ZONE.WATCH);
    map.watchstones.push({ x, z, stone: map.tileAt(x, z) });
  }
}

// One 2-wide ramp up each mound, on the side facing the temple, with its foot on reachable ground.
function watchstoneRamps(map, c, ground) {
  const S = map.size;
  for (const w of map.watchstones) {
    const d0 = Math.hypot(c - w.x, c - w.z) || 1;
    const px = w.x + ((c - w.x) / d0) * (WATCHSTONES.radius + 1);
    const pz = w.z + ((c - w.z) / d0) * (WATCHSTONES.radius + 1);
    let best = null, bestD = Infinity;
    for (let j = Math.floor(w.z) - WATCHSTONES.radius - 2; j <= Math.floor(w.z) + WATCHSTONES.radius + 2; j++) {
      for (let i = Math.floor(w.x) - WATCHSTONES.radius - 2; i <= Math.floor(w.x) + WATCHSTONES.radius + 2; i++) {
        if (!map.inBounds(i, j)) continue;
        const t = j * S + i;
        for (let d = 0; d < 4; d++) {
          if (!isRampCandidate(map, t, d) || map.zone[map.neighbor(t, d)] !== ZONE.WATCH) continue;
          if (!ground[t] || !ground[map.neighbor(t, (d + 2) % 4)]) continue;
          const dd = Math.hypot(i + 0.5 - px, j + 0.5 - pz);
          if (dd < bestD) { bestD = dd; best = { t, d }; }
        }
      }
    }
    if (!best) continue;
    map.ramp[best.t] = best.d;
    for (const side of [(best.d + 1) % 4, (best.d + 3) % 4]) {
      const s = map.neighbor(best.t, side);
      if (s >= 0 && isRampCandidate(map, s, best.d) && map.zone[map.neighbor(s, best.d)] === ZONE.WATCH) {
        map.ramp[s] = best.d;
        break;
      }
    }
  }
}

// Open ground reachable from `start` without ever entering a base (groves and rock block it).
function floodOpen(map, start) {
  const n = map.size * map.size;
  const seen = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0, tail = 0;
  queue[tail++] = start; seen[start] = 1;
  while (head < tail) {
    const t = queue[head++];
    for (let d = 0; d < 4; d++) {
      const nb = map.neighbor(t, d);
      if (nb < 0 || seen[nb] || map.siteId[nb] >= 0 || !map.canStep(t, nb)) continue;
      seen[nb] = 1; queue[tail++] = nb;
    }
  }
  return seen;
}

// Which bases can be walked straight into from that open ground (one of their own tiles is a
// step away from it), so no base needs a trip through another base. ok[site.id] = 1.
function directAccess(map, open) {
  const ok = new Uint8Array(map.sites.length);
  const n = map.size * map.size;
  for (let t = 0; t < n; t++) {
    const id = map.siteId[t];
    if (id < 0 || ok[id]) continue;
    for (let d = 0; d < 4; d++) {
      const nb = map.neighbor(t, d);
      if (nb >= 0 && open[nb] && map.canStep(nb, t)) { ok[id] = 1; break; }
    }
  }
  return ok;
}
const liveSites = (map) => map.sites.filter((s) => !s.removed);

// Bases that can't be walked into straight from open ground (e.g. the only way in was
// through another base, or ground cut off by other bases): give each its own ramp from open
// ground. Returns true when every base has direct access.
function fixAccess(map, start) {
  const S = map.size, n = S * S;
  map.accessFixes = 0;
  for (let pass = 0; pass < 40; pass++) {
    const open = floodOpen(map, start);
    const ok = directAccess(map, open);
    const bad = liveSites(map).filter((s) => !ok[s.id]);
    if (!bad.length) return true;
    const site = bad[0];
    // A raised base: a ramp on open ground climbing into it. A sunken one: a ramp inside it
    // climbing out onto open ground. Pick the spot nearest the base's center.
    let best = null, bestD = Infinity;
    const crystal = new Set(map.crystals); // crystal rocks block their tile
    for (let t = 0; t < n; t++) {
      for (let d = 0; d < 4; d++) {
        if (!isRampCandidate(map, t, d)) continue;
        const hi = map.neighbor(t, d);
        if (crystal.has(t) || crystal.has(hi) || crystal.has(map.neighbor(t, (d + 2) % 4))) continue;
        const up = map.siteId[t] < 0 && open[t] && map.siteId[hi] === site.id;
        const out = map.siteId[t] === site.id && map.siteId[hi] < 0 && open[hi];
        if (!up && !out) continue;
        const dist = Math.hypot(t % S + 0.5 - site.x, ((t / S) | 0) + 0.5 - site.z);
        if (dist < bestD) { bestD = dist; best = { t, d }; }
      }
    }
    if (!best) return false; // no room for a ramp: generateMap tries another layout
    map.ramp[best.t] = best.d;
    map.accessFixes++;
  }
  return false;
}

// For tests and debugging: ids of bases that can't be walked into straight from open ground.
export function basesWithoutAccess(map) {
  const c = map.size / 2 | 0;
  const ok = directAccess(map, floodOpen(map, map.idx(c, c)));
  return liveSites(map).filter((s) => !ok[s.id]).map((s) => s.id);
}

function floodReach(map, start) {
  const n = map.size * map.size;
  const seen = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0, tail = 0;
  queue[tail++] = start; seen[start] = 1;
  while (head < tail) {
    const t = queue[head++];
    for (let d = 0; d < 4; d++) {
      const nb = map.neighbor(t, d);
      if (nb < 0 || seen[nb] || !map.canStep(t, nb)) continue;
      seen[nb] = 1; queue[tail++] = nb;
    }
  }
  return seen;
}
