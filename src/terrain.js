import * as THREE from 'three';
import {
  LEVEL_HEIGHT, COLUMN_BOTTOM, LEVEL_COLORS, RUIN_COLOR, ROCK_COLOR, RAMP_TINT, SITE_TINTS, RUIN_RADIUS,
  WATCHSTONE_COLOR, FOREST_FLOOR_COLOR, PINE_COLOR, BOSS_ZONE, BOSS_ZONE_COLOR, BOSS_GLOW,
} from './config.js';
import { ZONE } from './map.js';
import { hashSeed, mulberry32 } from './rng.js';

const FOG_FACTOR = [0.07, 0.42, 1]; // never seen, explored, visible

// Stable per-tile jitter so the ground isn't perfectly flat-coloured.
const jitter = (t) => (((Math.imul(t + 1, 2654435761) >>> 0) / 4294967296) - 0.5) * 0.06;

function tileColor(map, t, out) {
  const S = map.size;
  const zone = map.zone[t];
  if (zone === ZONE.RUIN) out.setHex(RUIN_COLOR);
  else if (zone === ZONE.ROCK) out.setHex(ROCK_COLOR);
  else if (zone === ZONE.WATCH) out.setHex(WATCHSTONE_COLOR);
  else if (zone === ZONE.FOREST) out.setHex(FOREST_FLOOR_COLOR);
  else if (zone === ZONE.BOSS) out.setHex(BOSS_ZONE_COLOR);
  else out.setHex(LEVEL_COLORS[map.level[t]]);
  if (zone === ZONE.SITE) out.lerp(new THREE.Color(SITE_TINTS[map.sites[map.siteId[t]].value]), 0.2);
  if (map.ramp[t] >= 0) out.lerp(new THREE.Color(RAMP_TINT), 0.35);
  const checker = ((t % S) + ((t / S) | 0)) % 2 ? 0.03 : -0.03; // subtle placement-grid read
  const k = 1 + checker + jitter(t) + (map.tint[t] - 0.5) * 0.35;
  out.r *= k; out.g *= k; out.b *= k;
  return out;
}

export function buildTerrain(map) {
  const S = map.size, n = S * S;
  const group = new THREE.Group();
  const material = new THREE.MeshLambertMaterial({ color: 0xffffff });

  // --- Columns: one box per tile, from the bottom up to its level. ---
  const colGeo = new THREE.BoxGeometry(1, 1, 1);
  colGeo.translate(0, 0.5, 0);
  const columns = new THREE.InstancedMesh(colGeo, material, n);
  columns.castShadow = columns.receiveShadow = true;

  const m = new THREE.Matrix4(), q = new THREE.Quaternion();
  const p = new THREE.Vector3(), s = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const baseColors = new Float32Array(n * 3);
  const c = new THREE.Color();
  for (let t = 0; t < n; t++) {
    const i = t % S, j = (t / S) | 0;
    const top = map.level[t] * LEVEL_HEIGHT;
    p.set(i + 0.5, COLUMN_BOTTOM, j + 0.5);
    s.set(1, top - COLUMN_BOTTOM, 1);
    q.identity();
    columns.setMatrixAt(t, m.compose(p, q, s));
    tileColor(map, t, c);
    baseColors[t * 3] = c.r; baseColors[t * 3 + 1] = c.g; baseColors[t * 3 + 2] = c.b;
  }
  columns.instanceColor = new THREE.InstancedBufferAttribute(baseColors.slice(), 3);
  group.add(columns);

  // --- Ramps: a wedge sitting on top of the lower tile, rising toward the higher one. ---
  const rampTiles = [];
  for (let t = 0; t < n; t++) if (map.ramp[t] >= 0) rampTiles.push(t);
  const wedgeGeo = new THREE.BoxGeometry(1, 1, 1);
  wedgeGeo.translate(0, 0.5, 0);
  const pos = wedgeGeo.attributes.position;
  for (let k = 0; k < pos.count; k++) if (pos.getY(k) > 0.5 && pos.getX(k) < 0) pos.setY(k, 0);
  pos.needsUpdate = true;
  wedgeGeo.computeVertexNormals();
  const wedges = new THREE.InstancedMesh(wedgeGeo, material, Math.max(1, rampTiles.length));
  wedges.count = rampTiles.length;
  wedges.castShadow = wedges.receiveShadow = true;
  const rampColors = new Float32Array(Math.max(1, rampTiles.length) * 3);
  rampTiles.forEach((t, k) => {
    const i = t % S, j = (t / S) | 0;
    p.set(i + 0.5, map.level[t] * LEVEL_HEIGHT, j + 0.5);
    q.setFromAxisAngle(up, -map.ramp[t] * Math.PI / 2);
    s.set(1, LEVEL_HEIGHT, 1);
    wedges.setMatrixAt(k, m.compose(p, q, s));
    rampColors.set(baseColors.subarray(t * 3, t * 3 + 3), k * 3);
  });
  wedges.instanceColor = new THREE.InstancedBufferAttribute(rampColors.slice(), 3);
  group.add(wedges);

  // Landmarks (watchstones, crystals, the boss lair): hidden until explored (see applyFog).
  // Bases have no flags or banners.
  const banners = [];
  const fires = []; // watchstone fires, animated by animate()

  // --- Broken pillars around the ruined temple (decor that blocks movement). ---
  const decorTiles = [];
  const pillars = []; // { mesh, tile }: always shown, but darkened by fog
  const rand = mulberry32(hashSeed(map.seed + ':decor'));
  const pillarMat = new THREE.MeshLambertMaterial({ color: 0xb3ac9e });
  const cx = S / 2;
  for (let k = 0; k < 10; k++) {
    if (rand() < 0.25) continue;
    const a = (k / 10) * Math.PI * 2;
    const i = Math.floor(cx + Math.cos(a) * (RUIN_RADIUS - 1.5));
    const j = Math.floor(cx + Math.sin(a) * (RUIN_RADIUS - 1.5));
    const h = 0.6 + rand() * 1.8;
    const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.6, h, 0.6), pillarMat);
    pillar.position.set(i + 0.5, h / 2, j + 0.5);
    pillar.rotation.y = rand() * 0.4;
    pillar.castShadow = pillar.receiveShadow = true;
    group.add(pillar);
    decorTiles.push(map.idx(i, j));
    pillars.push({ mesh: pillar, tile: map.idx(i, j) }); // dimmed by fog like the ground
  }

  // --- Watchstones: a natural pillar of stacked, weathered boulders (each one different, a bit
  //     off-center and tilted, narrowing as it rises, with rubble round its foot) and a fire
  //     burning in a hollow of rock on its top: flickering flame tongues, a hot core, a soft
  //     glow and rising embers (animated by animate() below). ---
  const pillarMats = [0x8d8577, 0x7d766a, 0x9a9284].map((c) => new THREE.MeshLambertMaterial({ color: c, flatShading: true }));
  const flameMats = [
    new THREE.MeshBasicMaterial({ color: 0xff5a1f, transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending }), // outer: red-orange
    new THREE.MeshBasicMaterial({ color: 0xffa531, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending }),  // middle: orange
    new THREE.MeshBasicMaterial({ color: 0xfff0a0, transparent: true, opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending }), // core: pale yellow
  ];
  const glowMat = new THREE.MeshBasicMaterial({ color: 0xff7a1a, transparent: true, opacity: 0.09, depthWrite: false, blending: THREE.AdditiveBlending });
  const emberMat = new THREE.MeshBasicMaterial({ color: 0xffc060, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending });
  const smokeMat = new THREE.MeshLambertMaterial({ color: 0xa49e96, transparent: true, opacity: 0.26, depthWrite: false });
  const flameGeo = new THREE.ConeGeometry(1, 1, 6, 1, true);
  flameGeo.translate(0, 0.5, 0); // grows up from its base
  for (const w of map.watchstones) {
    const node = new THREE.Group();
    const rnd = mulberry32(hashSeed(`${map.seed}:watch:${w.stone}`));
    const rockAt = (r, x, y, z, sx, sy, sz, mat) => {
      const m = new THREE.Mesh(rnd() < 0.5 ? new THREE.DodecahedronGeometry(r, 0) : new THREE.IcosahedronGeometry(r, 0), mat);
      m.position.set(x, y, z);
      m.scale.set(sx, sy, sz);
      m.rotation.set((rnd() - 0.5) * 0.5, rnd() * Math.PI * 2, (rnd() - 0.5) * 0.5);
      m.castShadow = m.receiveShadow = true;
      node.add(m);
      return m;
    };
    const mat = () => pillarMats[Math.floor(rnd() * pillarMats.length)];
    // Rubble and a few big boulders round the foot.
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2 + rnd() * 0.6, d = 0.55 + rnd() * 0.35, r = 0.16 + rnd() * 0.16;
      rockAt(r, Math.cos(a) * d, r * 0.4, Math.sin(a) * d, 1, 0.7, 1, mat());
    }
    // The pillar: 5 stacked boulders, narrowing, each nudged off the one below.
    let y = 0, ox = 0, oz = 0;
    for (let k = 0; k < 5; k++) {
      const r = 0.5 - k * 0.055 + (rnd() - 0.5) * 0.06, h = 0.62 + rnd() * 0.18;
      ox += (rnd() - 0.5) * 0.12; oz += (rnd() - 0.5) * 0.12;
      rockAt(r, ox, y + h * r * 1.05, oz, 1 + rnd() * 0.15, h * 1.25, 1 + rnd() * 0.15, mat());
      y += h * r * 1.55;
    }
    // A hollow of rock on top: three chunks leaning out round the fire.
    const top = y + 0.05;
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2 + rnd();
      const m = rockAt(0.16 + rnd() * 0.05, ox + Math.cos(a) * 0.2, top, oz + Math.sin(a) * 0.2, 1, 0.8, 1, mat());
      m.rotation.z += Math.cos(a) * 0.5; m.rotation.x += Math.sin(a) * 0.5;
    }
    // The fire.
    const fire = new THREE.Group();
    fire.position.set(ox, top + 0.02, oz);
    const flames = [];
    for (let k = 0; k < 7; k++) {
      const layer = k < 3 ? 0 : k < 6 ? 1 : 2; // 3 outer, 3 middle, 1 core
      const f = new THREE.Mesh(flameGeo, flameMats[layer]);
      const a = (k / 3) * Math.PI * 2 + layer;
      const off = layer === 2 ? 0 : layer === 1 ? 0.06 : 0.11;
      f.position.set(Math.cos(a) * off, 0, Math.sin(a) * off);
      const fw = [0.17, 0.12, 0.08][layer], hgt = [0.75, 0.6, 0.42][layer];
      f.userData = { w: fw, h: hgt, phase: rnd() * 10, speed: 7 + rnd() * 5, tilt: a };
      fire.add(f);
      flames.push(f);
    }
    const glow = new THREE.Mesh(new THREE.SphereGeometry(0.42, 12, 10), glowMat);
    glow.position.y = 0.32;
    fire.add(glow);
    const embers = Array.from({ length: 6 }, (_, k) => {
      const e = new THREE.Mesh(new THREE.OctahedronGeometry(0.025, 0), emberMat);
      e.userData = { phase: k / 6 + rnd() * 0.1, drift: rnd() * Math.PI * 2 };
      fire.add(e);
      return e;
    });
    // Smoke puffs: they drift up after the fire goes out.
    const smoke = Array.from({ length: 5 }, (_, k) => {
      const s = new THREE.Mesh(new THREE.IcosahedronGeometry(0.12, 2), smokeMat); // round, soft puffs
      s.userData = { phase: k / 5, drift: rnd() * Math.PI * 2 };
      s.visible = false;
      fire.add(s);
      return s;
    });
    node.add(fire);
    // level: how big the fire is now (0 out, 1 lit, 1.5 roaring); it eases toward target at
    // `rate` per second (setFire). smokeT: seconds of smoke left after it went out.
    fires.push({ node, flames, glow, embers, smoke, level: 1, target: 1, rate: 1, smokeT: 0 });
    node.position.set(w.x, map.level[w.stone] * LEVEL_HEIGHT, w.z);
    group.add(node);
    banners.push({ mesh: node, tile: w.stone }); // hidden until explored, like banners
    decorTiles.push(w.stone);                    // the stone itself blocks its tile
  }

  // --- The boss zone: jagged dark spires tipped with purple crystal along its edge, and the
  //     lair: a cracked dark platform with glowing violet cracks, four crystal clusters around
  //     it, and the Crystal Monarch (boss.js) standing at its center (that tile is blocked).
  //     Hidden until explored, like banners. ---
  if (map.boss) {
    const B = map.boss, brand = mulberry32(hashSeed(map.seed + ':boss-decor'));
    const spireMat = new THREE.MeshLambertMaterial({ color: 0x2f2a2d, flatShading: true });
    const slabMat = new THREE.MeshLambertMaterial({ color: 0x3a3236, flatShading: true });
    const emberMat = new THREE.MeshLambertMaterial({ color: 0xd9c2ff, emissive: BOSS_GLOW, emissiveIntensity: 1.1 });
    const tipMat = new THREE.MeshLambertMaterial({ color: 0xc9a6ff, emissive: BOSS_GLOW, emissiveIntensity: 0.7, flatShading: true });
    const inX = B.cx ? -1 : 1, inZ = B.cz ? -1 : 1; // inward from the corner
    const addDecor = (node, t, blocks) => {
      node.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      group.add(node);
      banners.push({ mesh: node, tile: t });
      if (blocks) decorTiles.push(t);
    };
    const spire = (h, r) => {
      const g = new THREE.Group();
      const m = new THREE.Mesh(new THREE.ConeGeometry(r, h, 5), spireMat);
      m.position.y = h / 2;
      g.add(m);
      if (brand() < 0.6) { // a purple crystal growing out of the spire
        const tip = new THREE.Mesh(new THREE.OctahedronGeometry(r * 0.6, 0), tipMat);
        tip.scale.set(1, 2.4, 1);
        tip.position.set(r * 0.5, h * (0.3 + brand() * 0.3), 0);
        tip.rotation.z = -0.5;
        g.add(tip);
      }
      g.rotation.set((brand() - 0.5) * 0.3, brand() * Math.PI, (brand() - 0.5) * 0.3);
      return g;
    };
    // Spires along the arena's rim, kept clear of the ramp tops.
    const nearRamp = (t) => {
      const i = t % S, j = (t / S) | 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (map.inBounds(i + di, j + dj) && map.ramp[map.idx(i + di, j + dj)] >= 0) return true;
      }
      return false;
    };
    const R = BOSS_ZONE.radius - 1.2, used = new Set();
    for (let a = 0.18; a < Math.PI / 2 - 0.15; a += 0.13 + brand() * 0.08) {
      const t = map.tileAt(B.cx + inX * Math.cos(a) * R, B.cz + inZ * Math.sin(a) * R);
      if (map.zone[t] !== ZONE.BOSS || used.has(t) || t === B.lair || nearRamp(t) || B.pads.includes(t)) continue;
      used.add(t);
      const node = spire(1.2 + brand() * 1.6, 0.22 + brand() * 0.12);
      node.position.set(t % S + 0.5, map.level[t] * LEVEL_HEIGHT, ((t / S) | 0) + 0.5);
      addDecor(node, t, true);
    }
    // The lair.
    const lair = new THREE.Group();
    const slab = new THREE.Mesh(new THREE.CylinderGeometry(2.3, 2.6, 0.16, 9), slabMat);
    slab.position.y = 0.08;
    const pit = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.45, 0.06, 8), emberMat);
    pit.position.y = 0.17;
    lair.add(slab, pit);
    for (let k = 0; k < 5; k++) { // glowing cracks running out from the pit
      const a = (k / 5) * Math.PI * 2 + brand() * 0.4, len = 0.5 + brand() * 0.6;
      const crack = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.03, len), emberMat);
      crack.position.set(Math.sin(a) * (1.05 + len / 2), 0.17, Math.cos(a) * (1.05 + len / 2)); // out from under the boss
      crack.rotation.y = a;
      lair.add(crack);
    }
    const top = map.level[B.lair] * LEVEL_HEIGHT; // the arena floor
    lair.position.set(B.x, top, B.z);
    addDecor(lair, B.lair, true); // the boss stands here
    // Turret pads: flat stone rings with a violet inlay, where turrets may be built.
    const padMat = new THREE.MeshLambertMaterial({ color: 0x77707a, flatShading: true });
    const inlayMat = new THREE.MeshLambertMaterial({ color: 0xb9a2d8, emissive: BOSS_GLOW, emissiveIntensity: 0.35 });
    for (const t of B.pads) {
      const pad = new THREE.Group();
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.47, 0.5, 0.08, 8), padMat);
      disc.position.y = 0.04;
      const inlay = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.38, 8), inlayMat);
      inlay.rotation.x = -Math.PI / 2;
      inlay.position.y = 0.085;
      pad.add(disc, inlay);
      pad.position.set(t % S + 0.5, map.level[t] * LEVEL_HEIGHT, ((t / S) | 0) + 0.5);
      addDecor(pad, t, false); // building on it is allowed (turrets only)
    }
    // Four purple crystal clusters around the platform (each blocks its own tile).
    for (const [ox, oz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const t = map.tileAt(B.x + ox * 2.2, B.z + oz * 2.2);
      if (map.zone[t] !== ZONE.BOSS || B.pads.includes(t)) continue;
      const cluster = new THREE.Group();
      const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.3, 0), spireMat);
      rock.scale.set(1.2, 0.5, 1.2); rock.position.y = 0.1;
      cluster.add(rock);
      for (let k = 0; k < 4; k++) {
        const h = 0.6 + brand() * 0.9, a = brand() * Math.PI * 2, r = k ? 0.15 : 0;
        const c = new THREE.Mesh(new THREE.OctahedronGeometry(0.13, 0), tipMat);
        c.scale.set(1, h / 0.26, 1);
        c.position.set(Math.cos(a) * r, 0.15 + h * 0.4, Math.sin(a) * r);
        c.rotation.set(Math.sin(a) * 0.4, 0, -Math.cos(a) * 0.4);
        cluster.add(c);
      }
      cluster.position.set(t % S + 0.5, top, ((t / S) | 0) + 0.5);
      addDecor(cluster, t, true);
    }
  }

  // --- Crystal rocks: violet shards on a dark rock base. ---
  const crandom = mulberry32(hashSeed(map.seed + ':crystals'));
  const shardGeo = new THREE.OctahedronGeometry(0.5, 0);
  const rockGeo = new THREE.DodecahedronGeometry(0.45, 0);
  const shardMat = new THREE.MeshLambertMaterial({ color: 0xb48cff, emissive: 0x5b2bd6, emissiveIntensity: 0.55 });
  const rareMat = new THREE.MeshLambertMaterial({ color: 0xffd25e, emissive: 0xd67a00, emissiveIntensity: 0.7 });
  const rockMat = new THREE.MeshLambertMaterial({ color: 0x4d4852 });
  for (const t of map.crystals) {
    const mat = map.rareCrystals.has(t) ? rareMat : shardMat;
    const node = new THREE.Group();
    const rock = new THREE.Mesh(rockGeo, rockMat);
    rock.scale.set(1, 0.45, 1);
    rock.position.y = 0.1;
    rock.castShadow = rock.receiveShadow = true;
    node.add(rock);
    const shards = 3 + Math.floor(crandom() * 3);
    for (let k = 0; k < shards; k++) {
      const shard = new THREE.Mesh(shardGeo, mat);
      const h = 0.7 + crandom() * 0.9;
      const a = crandom() * Math.PI * 2, r = k === 0 ? 0 : 0.18 + crandom() * 0.12;
      shard.scale.set(0.28, h, 0.28);
      shard.position.set(Math.cos(a) * r, 0.15 + h * 0.4, Math.sin(a) * r);
      shard.rotation.set((crandom() - 0.5) * 0.6, crandom() * Math.PI, (crandom() - 0.5) * 0.6);
      shard.castShadow = true;
      node.add(shard);
    }
    node.position.set(t % S + 0.5, map.level[t] * LEVEL_HEIGHT, ((t / S) | 0) + 0.5);
    node.rotation.y = crandom() * Math.PI * 2;
    group.add(node);
    banners.push({ mesh: node, tile: t }); // same fog rule as banners
    decorTiles.push(t);                     // blocks movement and building
  }

  // --- Pine groves: 1-3 pines per forest tile, each a trunk and three stacked cones,
  //     with its own size, lean and shade. Instanced, dimmed by fog like the ground. ---
  const treeRand = mulberry32(hashSeed(map.seed + ':pines'));
  const trees = []; // { tile, x, z, h, w, rot, lean, shade }
  for (let t = 0; t < n; t++) {
    if (map.zone[t] !== ZONE.FOREST) continue;
    const count = 1 + Math.floor(treeRand() * 2.6);
    for (let k = 0; k < count; k++) {
      trees.push({
        tile: t,
        x: t % S + 0.2 + treeRand() * 0.6, z: ((t / S) | 0) + 0.2 + treeRand() * 0.6,
        h: 1.3 + treeRand() * 1.3, w: 0.8 + treeRand() * 0.35, rot: treeRand() * Math.PI * 2,
        lean: (treeRand() - 0.5) * 0.12, shade: 0.8 + treeRand() * 0.35,
      });
    }
  }
  const treeCount = Math.max(1, trees.length);
  const trunkGeo = new THREE.CylinderGeometry(0.05, 0.08, 0.5, 5);
  trunkGeo.translate(0, 0.25, 0);
  const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshLambertMaterial({ color: 0xffffff }), treeCount);
  // Three cone layers, each narrower and higher (in units of tree height / width).
  const LAYERS = [{ y: 0.18, h: 0.45, r: 0.42 }, { y: 0.42, h: 0.38, r: 0.33 }, { y: 0.64, h: 0.36, r: 0.22 }];
  const coneMeshes = LAYERS.map((L) => {
    const g = new THREE.ConeGeometry(L.r, L.h, 7);
    g.translate(0, L.y + L.h / 2, 0);
    return new THREE.InstancedMesh(g, new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true }), treeCount);
  });
  const treeMeshes = [trunks, ...coneMeshes];
  const trunkBase = new THREE.Color(0x5a4330), pineBase = new THREE.Color(PINE_COLOR), tc = new THREE.Color();
  const trunkColors = new Float32Array(treeCount * 3), pineColors = new Float32Array(treeCount * 3);
  const e = new THREE.Euler();
  trees.forEach((tr, k) => {
    p.set(tr.x, map.level[tr.tile] * LEVEL_HEIGHT, tr.z);
    q.setFromEuler(e.set(tr.lean, tr.rot, tr.lean * 0.5));
    s.set(tr.w, tr.h, tr.w);
    m.compose(p, q, s);
    for (const mesh of treeMeshes) mesh.setMatrixAt(k, m);
    tc.copy(trunkBase).multiplyScalar(tr.shade); trunkColors.set([tc.r, tc.g, tc.b], k * 3);
    tc.copy(pineBase).multiplyScalar(tr.shade); pineColors.set([tc.r, tc.g, tc.b], k * 3);
  });
  for (const mesh of treeMeshes) {
    mesh.count = trees.length;
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.instanceColor = new THREE.InstancedBufferAttribute((mesh === trunks ? trunkColors : pineColors).slice(), 3);
    group.add(mesh);
  }

  function applyFog(vis, enabled) {
    trees.forEach((tr, k) => {
      const f = enabled ? FOG_FACTOR[vis[tr.tile]] : 1;
      for (const mesh of treeMeshes) {
        const src = mesh === trunks ? trunkColors : pineColors, dst = mesh.instanceColor.array;
        dst[k * 3] = src[k * 3] * f; dst[k * 3 + 1] = src[k * 3 + 1] * f; dst[k * 3 + 2] = src[k * 3 + 2] * f;
      }
    });
    for (const mesh of treeMeshes) mesh.instanceColor.needsUpdate = true;
    const ca = columns.instanceColor.array;
    for (let t = 0; t < n; t++) {
      const f = enabled ? FOG_FACTOR[vis[t]] : 1;
      ca[t * 3] = baseColors[t * 3] * f;
      ca[t * 3 + 1] = baseColors[t * 3 + 1] * f;
      ca[t * 3 + 2] = baseColors[t * 3 + 2] * f;
    }
    columns.instanceColor.needsUpdate = true;
    const wa = wedges.instanceColor.array;
    rampTiles.forEach((t, k) => {
      const f = enabled ? FOG_FACTOR[vis[t]] : 1;
      wa[k * 3] = rampColors[k * 3] * f;
      wa[k * 3 + 1] = rampColors[k * 3 + 1] * f;
      wa[k * 3 + 2] = rampColors[k * 3 + 2] * f;
    });
    wedges.instanceColor.needsUpdate = true;
    // Landmarks (banners, watchstones, crystals, the boss lair): hidden until explored, and
    // darkened like the ground while explored but out of sight. Temple pillars: always shown,
    // darkened by fog.
    for (const b of banners) {
      b.mesh.visible = !enabled || vis[b.tile] > 0;
      dimNode(b.mesh, enabled ? FOG_FACTOR[vis[b.tile]] : 1);
    }
    for (const p of pillars) dimNode(p.mesh, enabled ? FOG_FACTOR[vis[p.tile]] : 1);
  }
  // Darken a decor object (0..1). The first time, each of its meshes gets its own copy of its
  // material (they're shared between objects), remembering the original color and glow.
  function dimNode(node, f) {
    if (node.userData.fogF === f) return;
    node.userData.fogF = f;
    node.traverse((o) => {
      if (!o.isMesh || !o.material?.color) return;
      if (!o.userData.fogBase) {
        o.material = o.material.clone();
        o.userData.fogBase = { color: o.material.color.clone(), glow: o.material.emissiveIntensity ?? 0 };
      }
      o.material.color.copy(o.userData.fogBase.color).multiplyScalar(f);
      if (o.material.emissiveIntensity !== undefined) o.material.emissiveIntensity = o.userData.fogBase.glow * f;
    });
  }

  // A watchstone's fire size: 0 out, 1 lit, 1.5 roaring. It changes smoothly at `rate` per
  // second, so going out over 3 s is setFire(k, 0, 1 / 3). Going out leaves smoke for a while.
  function setFire(k, target, rate = 1) {
    const F = fires[k];
    if (!F) return;
    if (target <= 0 && F.target > 0) F.smokeT = 8;
    F.target = target;
    F.rate = rate;
  }
  // The watchstone fires: flames lick and sway, the glow breathes, embers rise and fade.
  // Their size follows each fire's level, so they flare up, die down and go out smoothly.
  let lastT = null;
  function animate(t) {
    const dt = lastT === null ? 0 : Math.min(0.1, t - lastT);
    lastT = t;
    for (const F of fires) {
      // Ease the level toward its target.
      const step = F.rate * dt;
      F.level = F.level < F.target ? Math.min(F.target, F.level + step) : Math.max(F.target, F.level - step);
      F.smokeT = Math.max(0, F.smokeT - dt);
      if (!F.node.visible) continue;
      const L = F.level;
      for (const f of F.flames) {
        const u = f.userData;
        const flick = 1 + Math.sin(t * u.speed + u.phase) * 0.18 + Math.sin(t * u.speed * 2.3 + u.phase * 3) * 0.1;
        // As it dies the flames shrink and sink; dying flames sputter (flicker harder).
        const sput = L < 0.6 ? 1 + Math.sin(t * 23 + u.phase) * 0.25 * (1 - L) : 1;
        f.visible = L > 0.02;
        f.scale.set(u.w * (1 - (flick - 1) * 0.5) * Math.min(1, L * 1.2), u.h * flick * L * sput, u.w * (1 - (flick - 1) * 0.5) * Math.min(1, L * 1.2));
        f.rotation.set(Math.sin(t * 2.1 + u.phase) * 0.12, t * 1.5 + u.phase, Math.cos(t * 1.7 + u.phase) * 0.12);
      }
      F.glow.visible = L > 0.02;
      F.glow.scale.setScalar((1 + Math.sin(t * 5.3) * 0.08 + Math.sin(t * 11.7) * 0.04) * (0.4 + 0.6 * L));
      for (const e of F.embers) {
        const p = (t * 0.45 * (0.6 + 0.4 * L) + e.userData.phase) % 1;
        const a = e.userData.drift + t * 0.8;
        e.visible = L > 0.15;
        e.position.set(Math.cos(a) * 0.12 * p, 0.25 + p * 1.3 * L, Math.sin(a) * 0.12 * p);
        e.scale.setScalar(1 - p * 0.8);
      }
      // Smoke: grey puffs rising and spreading after it went out, thinning as smokeT runs down.
      const sk = F.smokeT / 8;
      for (const s of F.smoke) {
        s.visible = sk > 0;
        if (!s.visible) continue;
        const p = (t * 0.25 + s.userData.phase) % 1;
        const a = s.userData.drift + t * 0.3;
        s.position.set(Math.cos(a) * 0.25 * p, 0.2 + p * 1.8, Math.sin(a) * 0.25 * p);
        s.scale.setScalar((0.6 + p * 1.8) * sk);
      }
    }
  }

  return { group, applyFog, decorTiles, animate, setFire };
}

// Find the tile under a camera ray by marching through the heightfield.
// Much cheaper than raycasting 14k instanced boxes every frame.
export function pickGround(map, ray) {
  const o = ray.origin, d = ray.direction;
  if (d.y >= 0) return null;
  const yTop = 2 * LEVEL_HEIGHT + 0.01, yBot = -2 * LEVEL_HEIGHT - 0.01;
  const t0 = (yTop - o.y) / d.y, t1 = (yBot - o.y) / d.y;
  for (let t = t0; t <= t1; t += 0.04) {
    const x = o.x + d.x * t, z = o.z + d.z * t, y = o.y + d.y * t;
    if (x < 0 || z < 0 || x >= map.size || z >= map.size) continue;
    if (y <= map.heightAt(x, z)) return { tile: map.tileAt(x, z), x, z, y };
  }
  return null;
}
