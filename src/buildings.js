import * as THREE from 'three';
import { BUILDINGS, LEVEL_HEIGHT, DEFENDER } from './config.js';
import { ZONE, DIRS } from './map.js';

const MAX_WALLS = 4000;
const MAX_GHOSTS = 128;
const UP = new THREE.Vector3(0, 1, 0);

// Tiles on a 4-connected line from a to b (so wall pieces always touch orthogonally).
export function lineTiles(map, a, b, maxLen = MAX_GHOSTS) {
  const S = map.size;
  let x = a % S, y = (a / S) | 0;
  const x1 = b % S, y1 = (b / S) | 0;
  const dx = Math.abs(x1 - x), dy = Math.abs(y1 - y);
  const sx = x < x1 ? 1 : -1, sy = y < y1 ? 1 : -1;
  const out = [y * S + x];
  let ix = 0, iy = 0;
  while ((ix < dx || iy < dy) && out.length < maxLen) {
    if ((0.5 + ix) / dx < (0.5 + iy) / dy) { x += sx; ix++; } else { y += sy; iy++; }
    out.push(y * S + x);
  }
  return out;
}

const lambert = (color, extra = {}) => new THREE.MeshLambertMaterial({ color, ...extra });
// Earth elemental palette: raw, unworked rock (flat-shaded so the facets read).
const MATS = {
  rock: lambert(0x857d70, { flatShading: true }), darkRock: lambert(0x5c564e, { flatShading: true }),
  rubble: lambert(0x6f685e, { flatShading: true }),
  wallPost: lambert(0x7d766a, { flatShading: true }), wallSeg: lambert(0x6a6358, { flatShading: true }), // rock walls
};
// Wall stone colors (set per instance, so upgraded pieces can turn to quartz).
const WALL_STONE = { post: 0x7d766a, seg: 0x6a6358, plate: 0xa39a8a };

function part(geo, mat, x, y, z) {
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(x, y, z);
  mesh.castShadow = mesh.receiveShadow = true;
  return mesh;
}

// The defenders are earth elementals: raw rock held together and lifted by glowing energy
// in the owner's team color. `energy` is solid glowing stone/crystal; `aura` is a soft,
// see-through glow around it.
function energyMats(teamColor) {
  const team = new THREE.Color(teamColor);
  return {
    energy: lambert(team.clone().lerp(new THREE.Color(0xffffff), 0.35), { emissive: team, emissiveIntensity: 0.95, flatShading: true }),
    aura: new THREE.MeshBasicMaterial({ color: team, transparent: true, opacity: 0.16, depthWrite: false, blending: THREE.AdditiveBlending }),
  };
}
// Quartz: what the black stone of an ascended Town Hall and a Siege Titan turns into over
// levels 7-10 (milky white with a faint lilac, glowing slightly from within).
const QUARTZ = new THREE.Color(0xe6e1ee), QUARTZ_DARK = new THREE.Color(0xbfb8cc), QUARTZ_GLOW = new THREE.Color(0x2a2633);

// Native gold: from level 11 the quartz buildings (Ascended Core, Siege Titan, walls) grow
// clusters of raw gold crystals out of their stone, the way gold forms in quartz: one cluster
// at 11, one more each level to five at 15, and every cluster a little bigger each level, so
// the level can be read by counting them. Each cluster is a big octahedral crystal with two
// smaller ones leaning off it.
const GOLD_LEVELS = 5;
const goldLevel = (lv) => Math.max(0, Math.min(GOLD_LEVELS, lv - 10));
const goldSize = (lv) => 1 + Math.max(0, lv - 11) * 0.12; // 11: 1×, 15: 1.48×
const goldMat = () => lambert(0xffcf40, { flatShading: true, emissive: 0xc88412, emissiveIntensity: 0.7 });
// The three crystals of a cluster, relative to the cluster (pointing up its local +y).
const GOLD_PARTS = [
  new THREE.Matrix4().compose(new THREE.Vector3(0, 0.07, 0), new THREE.Quaternion(), new THREE.Vector3(0.09, 0.15, 0.09)),
  new THREE.Matrix4().compose(new THREE.Vector3(0.07, 0.03, 0.02), new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, 0.5, -0.7)), new THREE.Vector3(0.055, 0.09, 0.055)),
  new THREE.Matrix4().compose(new THREE.Vector3(-0.05, 0.03, -0.05), new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.6, 1.1, 0.4)), new THREE.Vector3(0.045, 0.075, 0.045)),
];
const GOLD_GEO = new THREE.OctahedronGeometry(1, 0);
// A cluster as a mesh group (for the Core and the Siege Titan), at a spot, tilted outward.
function goldCluster(mat, x, y, z, tiltX = 0, tiltZ = 0, scale = 1) {
  const g = new THREE.Group();
  for (const m of GOLD_PARTS) {
    const c = new THREE.Mesh(GOLD_GEO, mat);
    c.applyMatrix4(m);
    c.castShadow = true;
    g.add(c);
  }
  g.position.set(x, y, z);
  g.rotation.set(tiltX, 0, tiltZ);
  g.userData.base = scale;
  g.scale.setScalar(scale);
  g.visible = false;
  return g;
}
// Show the first goldLevel(lv) clusters, each sized for the level.
function showGold(clusters, lv) {
  const n = goldLevel(lv), s = goldSize(lv);
  clusters.forEach((c, k) => { c.visible = k < n; c.scale.setScalar(c.userData.base * s); });
}
// A jagged rock: an irregular polyhedron, stretched and turned.
function rock(r, mat, x, y, z, sx = 1, sy = 1, sz = 1, seed = 0) {
  const m = part(seed % 2 ? new THREE.DodecahedronGeometry(r, 0) : new THREE.IcosahedronGeometry(r, 0), mat, x, y, z);
  m.scale.set(sx, sy, sz);
  m.rotation.set(seed * 0.7, seed * 1.3, seed * 0.4);
  return m;
}
// A cluster of glowing crystals pointing up and out.
function crystals(mat, x, y, z, size = 1, count = 4, seed = 1) {
  const g = new THREE.Group();
  for (let k = 0; k < count; k++) {
    const h = (0.35 + ((k * 37 + seed * 11) % 10) / 20) * size;
    const c = part(new THREE.ConeGeometry(0.07 * size, h, 5), mat, 0, h / 2, 0);
    const a = (k / count) * Math.PI * 2 + seed;
    c.position.x = Math.cos(a) * 0.06 * size * (k ? 1 : 0);
    c.position.z = Math.sin(a) * 0.06 * size * (k ? 1 : 0);
    c.rotation.set(Math.sin(a) * 0.35 * (k ? 1 : 0), 0, -Math.cos(a) * 0.35 * (k ? 1 : 0));
    g.add(c);
  }
  g.position.set(x, y, z);
  return g;
}

// Town Hall: an outcrop with a great rock spire floating above it on a beam of energy,
// crowned with team crystals, and a ring of boulders orbiting it.
function buildTownHall(teamColor) {
  const E = energyMats(teamColor);
  const g = new THREE.Group();
  // Its own copies of the rock materials, so upgrades can darken this Town Hall's stone only.
  const hallRock = MATS.rock.clone(), hallDark = MATS.darkRock.clone();
  // The outcrop: a cluster of big rocks.
  for (const [x, z, r, s] of [[0, 0, 0.95, 0], [-0.75, 0.55, 0.5, 1], [0.8, 0.5, 0.45, 2], [0.65, -0.7, 0.5, 3], [-0.7, -0.65, 0.45, 4]]) {
    g.add(rock(r, s ? hallDark : hallRock, x, r * 0.35, z, 1.15, 0.6, 1.15, s));
  }
  g.add(crystals(E.energy, -0.95, 0.15, 0.95, 1, 3, 2));
  g.add(crystals(E.energy, 1.05, 0.12, -0.2, 0.8, 3, 5));
  // Levels 11-15: native gold clusters on the outcrop, one more each level (the biggest first,
  // on the main rock), each leaning out from the middle.
  const gMat = goldMat();
  const hallGold = [[-0.25, 0.78, -0.1, 3.4], [0.7, 0.38, 0.38, 2.7], [-0.65, 0.42, 0.45, 2.7], [0.7, 0.42, -0.75, 2.7], [-0.55, 0.38, -0.6, 2.7]]
    .map(([x, y, z, s]) => { const c = goldCluster(gMat, x, y, z, z * 0.7, -x * 0.7, s); g.add(c); return c; });
  // Energy beam from the outcrop up to the floating spire.
  const beam = part(new THREE.CylinderGeometry(0.12, 0.2, 0.9, 8, 1, true), E.aura, 0, 1.0, 0);
  g.add(beam);
  g.add(part(new THREE.IcosahedronGeometry(0.16, 0), E.energy, 0, 0.75, 0));
  // The floating spire: a tall jagged rock, point down, with a crystal crown.
  const spire = new THREE.Group();
  const spireRock = rock(0.42, hallRock, 0, 0.55, 0, 1, 1.9, 1, 3);
  spire.add(spireRock);
  const tip = part(new THREE.ConeGeometry(0.3, 0.6, 5), hallDark, 0, -0.3, 0);
  tip.rotation.x = Math.PI; // point down
  spire.add(tip);
  const crown = crystals(E.energy, 0, 1.2, 0, 1.6, 5, 7);
  spire.add(crown);
  spire.add(part(new THREE.SphereGeometry(0.75, 12, 10), E.aura, 0, 1.45, 0)); // glow around the crown
  spire.position.y = 1.65;
  g.add(spire);

  // Level 6, "Ascended": a dramatic change. The rock spire gives way to a huge floating
  // team-colored crystal heart, crystal pillars burst up through the outcrop, the orbiting
  // boulders become glowing shards with a second, counter-turning ring, two tilted energy
  // halos circle the heart, and the ground around it glows. Hidden below level 6.
  const ascended = new THREE.Group();
  ascended.visible = false;
  g.add(ascended);
  const heart = part(new THREE.OctahedronGeometry(0.55, 0), E.energy, 0, 0, 0);
  heart.scale.set(1, 2.1, 1);
  const heartGlow = part(new THREE.SphereGeometry(1.0, 14, 10), E.aura, 0, 0, 0);
  heartGlow.castShadow = false;
  const heartGroup = new THREE.Group();
  heartGroup.add(heart, heartGlow);
  heartGroup.position.y = 3.1;
  ascended.add(heartGroup);
  for (const [x, z, s, seed] of [[0.45, 0.3, 2.2, 1], [-0.5, 0.25, 1.8, 2], [0.1, -0.55, 2.0, 3], [-0.85, -0.7, 1.4, 4], [0.95, 0.6, 1.3, 5], [-0.9, 0.75, 1.2, 6]]) {
    ascended.add(crystals(E.energy, x, 0.25, z, s, 4, seed)); // pillars through the outcrop
  }
  const haloMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(teamColor), transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending });
  // Two halos at level 6; a third at 7 and a fourth at 10.
  const halos = [0, 1, 2, 3].map((k) => {
    const h = new THREE.Mesh(new THREE.TorusGeometry(1.35 + k * 0.22, 0.035, 6, 48), haloMat);
    h.position.y = 3.1;
    ascended.add(h);
    return h;
  });
  // Level 9: a crown of four crystal spikes floating above the heart.
  const crownSpikes = new THREE.Group();
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2;
    const c = part(new THREE.OctahedronGeometry(0.11, 0), E.energy, Math.cos(a) * 0.45, 0, Math.sin(a) * 0.45);
    c.scale.set(0.7, 2.6, 0.7);
    c.rotation.set(Math.sin(a) * 0.4, 0, -Math.cos(a) * 0.4);
    crownSpikes.add(c);
  }
  ascended.add(crownSpikes);
  const floorGlow = new THREE.Mesh(new THREE.CircleGeometry(1.9, 32), new THREE.MeshBasicMaterial({
    color: new THREE.Color(teamColor), transparent: true, opacity: 0.22, depthWrite: false }));
  floorGlow.rotation.x = -Math.PI / 2;
  floorGlow.position.y = 0.03;
  ascended.add(floorGlow);
  // The counter-turning outer ring: 8 shards, 12 from level 8.
  const outerRing = Array.from({ length: 12 }, () => {
    const s = part(new THREE.OctahedronGeometry(0.12, 0), E.energy, 0, 0, 0);
    s.scale.set(0.8, 1.8, 0.8);
    ascended.add(s);
    return s;
  });
  let isAscended = false, ascStep = 0, ringCount = 8, haloCount = 2; // ascStep: levels above 6 (0-4)
  // A ring of boulders orbiting the spire. Upgrades show here: one more boulder per level
  // (5 → 10) and the boulders shift toward glowing team-colored rock, while the Town Hall's
  // own stone (outcrop and spire) turns darker each level.
  const team = new THREE.Color(teamColor);
  const orbitMat = lambert(0x857d70, { flatShading: true, emissive: team, emissiveIntensity: 0 });
  const orbit = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((k) => {
    const b = rock(0.13 + (k % 2) * 0.05, orbitMat, 0, 2.2, 0, 1, 1, 1, k + 1);
    b.visible = k < 5;
    g.add(b);
    return b;
  });
  let orbitCount = 5;
  g.userData.setLevel = (lv) => {
    isAscended = lv >= 6;
    orbitCount = Math.min(10, 5 + lv);
    orbit.forEach((b, k) => { b.visible = k < orbitCount; });
    const k5 = Math.min(lv, 5);
    orbitMat.color.set(0x857d70).lerp(team.clone().lerp(new THREE.Color(0xffffff), 0.3), isAscended ? 1 : k5 * 0.13);
    orbitMat.emissiveIntensity = isAscended ? 1.0 : k5 * 0.09; // ascended: they become glowing shards
    hallRock.color.set(0x857d70).lerp(new THREE.Color(0x2a2724), k5 * 0.15); // grey → dark basalt
    hallDark.color.set(0x5c564e).lerp(new THREE.Color(0x1c1a18), k5 * 0.15);
    hallRock.emissive.set(0x000000); hallDark.emissive.set(0x000000);
    if (isAscended) {
      // Level 6 keeps level 5's dark basalt (set just above); levels 7-10 turn it step by step
      // into pale, faintly glowing quartz.
      const s = Math.max(0, Math.min(4, lv - 6)) / 4;
      hallRock.color.lerp(QUARTZ, s);
      hallDark.color.lerp(QUARTZ_DARK, s);
      hallRock.emissive.copy(QUARTZ_GLOW).multiplyScalar(s);
      hallDark.emissive.copy(QUARTZ_GLOW).multiplyScalar(s * 0.6);
    }
    // Levels 11-15: native gold clusters growing out of the quartz, one more each level.
    showGold(hallGold, lv);
    ascended.visible = isAscended;
    spireRock.visible = tip.visible = crown.visible = !isAscended;
    // Levels 7-10, one step each: a 3rd halo (7), a bigger shard ring and ground glow (8),
    // a crown of spikes (9), a 4th halo and a bigger, brighter heart (10). The heart also
    // grows a little every level.
    ascStep = Math.max(0, Math.min(4, lv - 6));
    haloCount = 2 + (ascStep >= 1 ? 1 : 0) + (ascStep >= 4 ? 1 : 0);
    halos.forEach((h, k) => { h.visible = k < haloCount; });
    ringCount = ascStep >= 2 ? 12 : 8;
    outerRing.forEach((s, k) => { s.visible = k < ringCount; });
    floorGlow.scale.setScalar(ascStep >= 2 ? 1.25 : 1);
    crownSpikes.visible = ascStep >= 3;
    heart.scale.set(1, 2.1, 1).multiplyScalar(1 + ascStep * 0.06 + (ascStep >= 4 ? 0.12 : 0));
    heartGlow.material = ascStep >= 4 ? E.aura.clone() : E.aura;
    if (ascStep >= 4) heartGlow.material.opacity = 0.3;
  };
  g.userData.animate = (t) => {
    spire.position.y = 1.65 + Math.sin(t * 1.1) * 0.08;
    spire.rotation.y = t * 0.25;
    const R = isAscended ? 1.35 : 1.05, H = isAscended ? 2.6 : 2.15, sp = isAscended ? 1.1 : 0.6;
    orbit.forEach((b, k) => {
      if (!b.visible) return;
      const a = t * sp + (k / orbitCount) * Math.PI * 2; // evenly spaced, however many there are
      b.position.set(Math.cos(a) * R, H + Math.sin(a * 2 + k) * 0.18, Math.sin(a) * R);
      b.rotation.y = a;
    });
    if (isAscended) {
      heartGroup.position.y = 3.1 + Math.sin(t * 1.3) * 0.12;
      heartGroup.rotation.y = t * 0.7;
      heartGlow.scale.setScalar(1 + Math.sin(t * 2.4) * 0.08);
      halos[0].rotation.set(1.2 + Math.sin(t * 0.5) * 0.1, t * 0.8, 0.3);
      halos[1].rotation.set(-1.0, -t * 0.6, -0.4);
      halos[2].rotation.set(0.2, t * 0.45, 1.3);
      halos[3].rotation.set(Math.PI / 2, 0, t * 0.35); // flat, level with the heart
      halos.forEach((h) => { h.position.y = heartGroup.position.y; });
      crownSpikes.position.y = heartGroup.position.y + 1.6 + Math.sin(t * 1.7) * 0.06;
      crownSpikes.rotation.y = -t * 0.9;
      outerRing.forEach((s, k) => { // counter-turning outer ring, lower and wider
        if (!s.visible) return;
        const a = -t * 0.7 + (k / ringCount) * Math.PI * 2;
        s.position.set(Math.cos(a) * 1.9, 1.5 + Math.sin(t * 2 + k) * 0.15, Math.sin(a) * 1.9);
        s.rotation.y = a * 2;
      });
      floorGlow.material.opacity = 0.18 + Math.sin(t * 2) * 0.06;
    }
    E.energy.emissiveIntensity = 0.85 + Math.sin(t * 2) * 0.15;
    beam.scale.set(1 + Math.sin(t * 4) * 0.08, 1, 1 + Math.sin(t * 4) * 0.08);
  };
  return g;
}

// Barracks: a spawning well. Leaning standing stones ring a glowing pool, and above it a new
// elemental slowly takes shape: rock chunks gather and turn around a core, pebbles rise.
function buildBarracks(teamColor) {
  const E = energyMats(teamColor);
  const g = new THREE.Group();
  const floor = part(new THREE.CylinderGeometry(0.85, 0.95, 0.14, 9), MATS.darkRock, 0, 0.07, 0); // rocky floor (level)
  g.add(floor);
  const pool = part(new THREE.CircleGeometry(0.45, 16), E.energy, 0, 0.145, 0);       // glowing pool
  pool.rotation.x = -Math.PI / 2;
  g.add(pool);
  const stoneMat = MATS.rock.clone(); // its own, so upgrades can turn its stones to quartz
  for (let k = 0; k < 5; k++) {                                                      // standing stones
    const a = (k / 5) * Math.PI * 2 + 0.3;
    const stone = rock(0.17, stoneMat, Math.cos(a) * 0.72, 0.42, Math.sin(a) * 0.72, 0.8, 2.6, 0.7, k + 2);
    stone.rotation.set(0, -a, 0.18); // leaning out
    g.add(stone);
  }
  // Upgrades: level 1 (Quartz Lancers) turns the standing stones to quartz with a crystal on
  // each tip; level 2 (Titan Wardens) adds a native gold cluster at each stone's foot.
  const tips = [], golds = [];
  const gMat = goldMat();
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2 + 0.3;
    const tip = crystals(E.energy, Math.cos(a) * 0.78, 0.82, Math.sin(a) * 0.78, 0.7, 3, k + 9);
    tip.visible = false;
    g.add(tip); tips.push(tip);
    const gc = goldCluster(gMat, Math.cos(a) * 0.55, 0.14, Math.sin(a) * 0.55, Math.sin(a) * 0.6, -Math.cos(a) * 0.6, 1.8);
    g.add(gc); golds.push(gc);
  }
  g.userData.setLevel = (lv) => {
    stoneMat.color.set(0x857d70).lerp(QUARTZ, lv >= 1 ? 1 : 0);
    stoneMat.emissive.copy(QUARTZ_GLOW).multiplyScalar(lv >= 1 ? 1 : 0);
    tips.forEach((c) => { c.visible = lv >= 1; });
    golds.forEach((c) => { c.visible = lv >= 2; });
  };
  // The forming elemental above the pool.
  const forming = new THREE.Group();
  forming.position.y = 1.1;
  const core = part(new THREE.IcosahedronGeometry(0.13, 0), E.energy, 0, 0, 0);
  forming.add(core);
  forming.add(part(new THREE.SphereGeometry(0.32, 10, 8), E.aura, 0, 0, 0));
  const chunks = [0, 1, 2, 3].map((k) => {
    const c = rock(0.1, MATS.rock, 0, 0, 0, 1, 1.2, 1, k + 3);
    forming.add(c);
    return c;
  });
  g.add(forming);
  const motes = [0, 1, 2, 3, 4, 5].map((k) => { // pebbles rising out of the pool
    const m = rock(0.035, MATS.rock, 0, 0, 0, 1, 1, 1, k);
    g.add(m);
    return m;
  });
  g.userData.animate = (t) => {
    forming.rotation.y = t * 0.5;
    forming.position.y = 1.1 + Math.sin(t * 1.3) * 0.06;
    chunks.forEach((c, k) => {
      const a = t * 0.9 + (k / 4) * Math.PI * 2;
      const r = 0.2 + Math.sin(t * 0.7 + k) * 0.04; // drift in and out as it "forms"
      c.position.set(Math.cos(a) * r, Math.sin(a * 2) * 0.1, Math.sin(a) * r);
    });
    motes.forEach((m, k) => {
      const phase = (t * 0.35 + k / motes.length) % 1;       // rise, then start again
      const a = k * 2.1;
      m.position.set(Math.cos(a) * 0.3 * (1 - phase), 0.15 + phase * 0.95, Math.sin(a) * 0.3 * (1 - phase));
      m.scale.setScalar(1 - phase * 0.5);
    });
    E.energy.emissiveIntensity = 0.75 + Math.sin(t * 2.2) * 0.25;
  };
  return g;
}

// Boulder Turret (the "cannon" slot): a rock pedestal holding a boulder in a cradle of
// glowing energy points, ready to hurl it.
function buildTurret(teamColor) {
  const E = energyMats(teamColor);
  const team = new THREE.Color(teamColor);
  const g = new THREE.Group();
  // Levels 0-5: the pedestal with a boulder in its cradle.
  const basic = new THREE.Group();
  g.add(basic);
  basic.add(rock(0.36, MATS.darkRock, 0, 0.16, 0, 1.1, 0.55, 1.1, 2));
  basic.add(rock(0.2, MATS.rock, 0, 0.42, 0, 0.9, 0.9, 0.9, 4));
  // Cradle points: 3, plus one more per upgrade level.
  const cradle = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => {
    const p = part(new THREE.OctahedronGeometry(0.05, 0), E.energy, 0, 0, 0);
    p.visible = k < 3;
    basic.add(p);
    return p;
  });
  // Upgraded boulders are charged: veined with team energy that glows brighter each level.
  const boulderMat = lambert(0x857d70, { flatShading: true, emissive: team, emissiveIntensity: 0 });
  const boulder = rock(0.2, boulderMat, 0, 0.95, 0, 1, 1, 1, 5);
  basic.add(boulder);
  const aura = part(new THREE.SphereGeometry(0.3, 10, 8), E.aura, 0, 0.95, 0);
  basic.add(aura);
  // Energy rings stacked up the pedestal: one per upgrade level.
  const rings = [0, 1, 2, 3, 4].map((k) => {
    const r = part(new THREE.TorusGeometry(0.3 - k * 0.025, 0.022, 5, 18), E.energy, 0, 0.12 + k * 0.11, 0);
    r.rotation.x = Math.PI / 2;
    r.visible = false;
    basic.add(r);
    return r;
  });

  // Level 6, Siege Titan (damage ×2): heavy and slow. A wide basalt block with buttresses,
  // two great stone arms curling up to hold a giant charged boulder, flat stone slabs
  // grinding slowly around it, and a glowing rune ring on the ground.
  const siege = new THREE.Group();
  siege.visible = false;
  g.add(siege);
  const basalt = lambert(0x24222a, { flatShading: true });
  siege.add(rock(0.5, basalt, 0, 0.22, 0, 1.35, 0.6, 1.35, 3));
  for (const [x, z] of [[0.45, 0.45], [-0.45, 0.45], [0.45, -0.45], [-0.45, -0.45]]) siege.add(rock(0.18, basalt, x, 0.15, z, 1, 1.4, 1, 6));
  for (const side of [-1, 1]) { // the arms: three segments curving up and in
    for (let k = 0; k < 3; k++) {
      const seg = rock(0.14 - k * 0.015, MATS.rock, side * (0.55 - k * 0.14), 0.62 + k * 0.36, 0, 1, 2.2, 1, 7 + k);
      seg.rotation.set(0, 0, side * (0.1 + k * 0.4));
      siege.add(seg);
    }
  }
  const siegeMat = lambert(0x6b6070, { flatShading: true, emissive: team, emissiveIntensity: 0.75 });
  const giant = rock(0.36, siegeMat, 0, 1.45, 0, 1, 1, 1, 5);
  siege.add(giant);
  const giantAura = part(new THREE.SphereGeometry(0.6, 12, 10), E.aura, 0, 1.45, 0);
  siege.add(giantAura);
  // Orbiting slabs: 3 at level 6, one more each level to 7 at level 10.
  const slabs = Array.from({ length: 7 }, (_, k) => { const s = rock(0.16, basalt, 0, 0, 0, 1.4, 0.35, 0.9, 11 + k); siege.add(s); return s; });
  const rune = part(new THREE.TorusGeometry(0.62, 0.03, 5, 32), E.energy, 0, 0.04, 0);
  rune.rotation.x = Math.PI / 2;
  siege.add(rune);
  const rune2 = part(new THREE.TorusGeometry(0.85, 0.025, 5, 40), E.energy, 0, 0.05, 0); // level 10: a second rune ring
  rune2.rotation.x = Math.PI / 2;
  siege.add(rune2);
  // Levels 11-15: native gold clusters, one more each level: first on the block's front, then
  // on the four buttresses.
  const sMat = goldMat();
  const siegeGold = [[0, 0.46, 0.38, 2.1], [0.45, 0.36, 0.45, 1.7], [-0.45, 0.36, -0.45, 1.7], [-0.45, 0.36, 0.45, 1.7], [0.45, 0.36, -0.45, 1.7]]
    .map(([x, y, z, s]) => { const c = goldCluster(sMat, x, y, z, z * 0.9, -x * 0.9, s); siege.add(c); return c; });

  // Level 6, Shard Storm (attack speed ×2): light and fast. A slim hexagonal plinth under a
  // tall team-colored crystal spire with leaning crystals, three tilted rings whirling around
  // it, and a carousel of crystal shards that it fires one after another.
  const storm = new THREE.Group();
  storm.visible = false;
  g.add(storm);
  storm.add(part(new THREE.CylinderGeometry(0.26, 0.34, 0.22, 6), MATS.darkRock, 0, 0.11, 0));
  const spire = part(new THREE.OctahedronGeometry(0.22, 0), E.energy, 0, 1.15, 0);
  spire.scale.set(1, 4.6, 1);
  storm.add(spire);
  for (let k = 0; k < 4; k++) { // leaning crystals round the spire's foot
    const a = (k / 4) * Math.PI * 2 + 0.4;
    const c = part(new THREE.OctahedronGeometry(0.09, 0), E.energy, Math.cos(a) * 0.2, 0.45, Math.sin(a) * 0.2);
    c.scale.set(1, 3.4, 1);
    c.rotation.set(Math.sin(a) * 0.5, 0, -Math.cos(a) * 0.5);
    storm.add(c);
  }
  // Three whirling rings. Racing shards: 6, then one more each level.
  const whirl = [0, 1, 2].map((k) => {
    const r = part(new THREE.TorusGeometry(0.36 + k * 0.08, 0.018, 5, 28), E.energy, 0, 0.8 + k * 0.38, 0);
    storm.add(r);
    return r;
  });
  // Levels 7-10: one more core each level, a big crystal spinning like the main spire, standing
  // around it (opposite pairs first, so it stays balanced): up to five cores at level 10.
  const cores = [0, Math.PI, Math.PI / 2, Math.PI * 1.5].map((a, k) => {
    const c = part(new THREE.OctahedronGeometry(0.16, 0), E.energy, Math.cos(a) * 0.36, 0.95 + (k % 2) * 0.06, Math.sin(a) * 0.36);
    c.scale.set(1, 4.4, 1);
    c.visible = false;
    storm.add(c);
    return c;
  });
  // Levels 11-15: crystal outcrops break up through the ground round the plinth, one more each
  // level (1 at 11, 5 at 15) and each a little bigger every level, so the level can be counted;
  // and the Storm's crystal burns whiter, a step each level.
  const stormOutcrops = Array.from({ length: GOLD_LEVELS }, (_, k) => {
    const a = Math.PI / 4 + k * (Math.PI * 2 / GOLD_LEVELS);
    const x = Math.cos(a) * 0.46, z = Math.sin(a) * 0.46;
    const c = crystals(E.energy, x, 0.02, z, 1, 4, 20 + k);
    c.rotation.set(z * 0.9, 0, -x * 0.9); // lean outward
    c.visible = false;
    storm.add(c);
    return c;
  });
  const stormGlow = new THREE.Color(teamColor).lerp(new THREE.Color(0xffffff), 0.35); // E.energy's own color
  const carousel = Array.from({ length: 6 }, () => {
    const s = part(new THREE.OctahedronGeometry(0.07, 0), E.energy, 0, 0, 0);
    s.scale.set(0.8, 1.9, 0.8);
    storm.add(s);
    return s;
  });
  let shotCount = 0, lastFired = -99;
  let step = 0, slabCount = 3, shardCount = 6; // step: levels above 6 (0-4)

  let level = 0, variant = null;
  // After a shot (userData.firedAt = the time it fired) a new boulder grows back in the cradle.
  g.userData.boulderY = 0.95;
  g.userData.boulderScale = 1;
  g.userData.setLevel = (lv, v = null) => {
    level = lv;
    variant = lv >= 6 ? v : null;
    basic.visible = !variant;
    siege.visible = variant === 'siege';
    storm.visible = variant === 'storm';
    g.userData.boulderY = variant === 'siege' ? 1.45 : variant === 'storm' ? 1.35 : 0.95; // where shots leave from
    g.userData.boulderScale = 1 + Math.min(lv, 5) * 0.12;          // a bigger boulder each level
    cradle.forEach((p, k) => { p.visible = k < 3 + lv; });
    rings.forEach((r, k) => { r.visible = k < lv; });
    boulderMat.emissiveIntensity = Math.min(lv, 5) * 0.12;
    aura.scale.setScalar(1 + Math.min(lv, 5) * 0.1);
    // Levels 7-10, one step each. Siege Titan: one more orbiting slab per level and a slightly
    // bigger giant boulder; a second rune ring at 10. Shard Storm: one more tall crystal beside
    // the spire and one more racing shard per level, and a taller spire.
    step = Math.max(0, Math.min(4, lv - 6));
    slabCount = 3 + step;
    slabs.forEach((s, k) => { s.visible = k < slabCount; });
    rune2.visible = step >= 4;
    giantSize = 1 + step * 0.07;
    g.userData.boulderY = variant === 'siege' ? 1.45 + step * 0.05 : g.userData.boulderY;
    cores.forEach((c, k) => { c.visible = k < step; });
    shardCount = 6;
    // The Siege Titan's black basalt turns step by step into pale, faintly glowing quartz.
    basalt.color.set(0x24222a).lerp(QUARTZ, step / 4);
    basalt.emissive.copy(QUARTZ_GLOW).multiplyScalar(step / 4);
    showGold(siegeGold, variant === 'siege' ? lv : 0); // 11-15: native gold clusters, one more each level
    // Shard Storm 11-15: crystal outcrops (one more each level) and whiter, hotter crystal.
    const out = variant === 'storm' ? goldLevel(lv) : 0;
    stormOutcrops.forEach((c, k) => { c.visible = k < out; c.scale.setScalar(1.25 + Math.max(0, lv - 11) * 0.15); });
    E.energy.color.copy(stormGlow).lerp(new THREE.Color(0xffffff), out * 0.12);
    carousel.forEach((s, k) => { s.visible = k < shardCount; });
    spire.scale.set(1, 4.6 + step * 0.45, 1);
    spire.position.y = 1.15 + step * 0.1;
  };
  let giantSize = 1;
  g.userData.animate = (t) => {
    const since = t - (g.userData.firedAt ?? -99);
    // A Shard Storm firing its beam (userData.beaming, set by the game) blazes brighter.
    E.energy.emissiveIntensity = 0.8 + Math.sin(t * 3) * 0.2 + (g.userData.beaming ? 0.5 + Math.sin(t * 23) * 0.15 : 0);
    if (variant === 'storm') stormOutcrops.forEach((c, k) => { if (c.visible) c.position.y = 0.02 + Math.sin(t * 1.3 + k) * 0.015; });
    if (variant === 'siege') {
      // Slow and heavy: the giant boulder regrows slowly between its huge throws.
      giant.scale.setScalar(Math.max(0.05, Math.min(1, (since - 0.2) / 1.4)) * giantSize);
      giant.rotation.y = t * 0.5; giant.rotation.x = t * 0.3;
      // Aiming (userData.aim 0..1 before its first throw at a new target): the boulder blazes
      // up and trembles, and the rune ring tightens and glows.
      const aimK = g.userData.aim || 0, tremble = aimK > 0 && aimK < 1 ? aimK * 0.03 : 0;
      giant.position.y = giantAura.position.y = 1.45 + Math.sin(t * 1.2) * 0.04;
      giant.position.x = Math.sin(t * 47) * tremble;
      giant.position.z = Math.cos(t * 53) * tremble;
      siegeMat.emissiveIntensity = 0.6 + Math.sin(t * 1.5) * 0.2 + (aimK < 1 ? aimK * 1.4 : 0);
      giantAura.scale.setScalar(1 + (aimK < 1 ? aimK * 0.35 : 0));
      rune.scale.setScalar(1 - (aimK < 1 ? aimK * 0.25 : 0));
      slabs.forEach((s, k) => {
        if (k >= slabCount) return;
        const a = t * 0.35 + (k / slabCount) * Math.PI * 2;
        s.position.set(Math.cos(a) * 0.82, 0.85 + Math.sin(t + k) * 0.06, Math.sin(a) * 0.82);
        s.rotation.y = -a;
      });
      rune.rotation.z = t * 0.2;
      rune2.rotation.z = -t * 0.15;
      return;
    }
    if (variant === 'storm') {
      // Fast and light: rings whirl, shards race round the spire; each shot takes one away.
      if (g.userData.firedAt !== lastFired) { lastFired = g.userData.firedAt; shotCount++; }
      whirl.forEach((r, k) => { r.rotation.set(1.1 + k * 0.35, t * (3 + k), 0.3 * k); });
      spire.rotation.y = t * 1.5;
      cores.forEach((c, k) => { if (c.visible) c.rotation.y = t * (k % 2 ? -1.8 : 1.8) + k; });
      const ringR = 0.48 + step * 0.06; // the racing shards widen to clear the extra cores
      carousel.forEach((s, k) => {
        if (k >= shardCount) { s.visible = false; return; }
        const a = t * 4 + (k / shardCount) * Math.PI * 2;
        s.position.set(Math.cos(a) * ringR, 1.35 + Math.sin(a * 2) * 0.08, Math.sin(a) * ringR);
        s.rotation.y = a;
        s.visible = !(k === shotCount % shardCount && since < 0.6); // the one just fired regrows
      });
      return;
    }
    boulder.scale.setScalar(Math.max(0.05, Math.min(1, (since - 0.15) / 1.2)) * g.userData.boulderScale);
    boulder.rotation.y = t * 1.2;
    boulder.rotation.x = t * 0.7;
    boulder.position.y = 0.95 + Math.sin(t * 2) * 0.05;
    const n = 3 + level;
    cradle.forEach((p, k) => {
      if (!p.visible) return;
      const a = -t * (1.5 + level * 0.15) + (k / n) * Math.PI * 2;
      p.position.set(Math.cos(a) * 0.3, 0.78, Math.sin(a) * 0.3);
    });
    rings.forEach((r, k) => { r.rotation.z = t * (k % 2 ? 0.8 : -0.8); });
  };
  return g;
}

// Quarry: a crystal outcrop being drawn up out of the ground. Jagged rocks studded with
// team crystals, with chunks of ore floating up off it.
function buildQuarry(teamColor) {
  const E = energyMats(teamColor);
  const g = new THREE.Group();
  for (const [x, z, r, s] of [[-0.3, -0.2, 0.42, 1], [0.35, 0.25, 0.36, 2], [0.4, -0.45, 0.28, 3], [-0.45, 0.45, 0.25, 4]]) {
    g.add(rock(r, s % 2 ? MATS.rock : MATS.darkRock, x, r * 0.45, z, 1.1, 0.75, 1.1, s));
  }
  g.add(crystals(E.energy, -0.3, 0.3, -0.2, 1.2, 4, 3));
  g.add(crystals(E.energy, 0.38, 0.22, 0.28, 0.9, 3, 6));
  const ore = [0, 1, 2].map((k) => {
    const o = part(new THREE.OctahedronGeometry(0.06, 0), E.energy, 0, 0, 0);
    o.scale.set(0.8, 1.4, 0.8);
    g.add(o);
    return o;
  });
  g.userData.animate = (t) => {
    ore.forEach((o, k) => {
      const phase = (t * 0.3 + k / 3) % 1;
      o.position.set(-0.3 + Math.sin(k * 2.3) * 0.25, 0.6 + phase * 0.9, -0.2 + Math.cos(k * 2.3) * 0.25);
      o.rotation.y = t * 2 + k;
      o.scale.setScalar(1 - phase * 0.6);
    });
    E.energy.emissiveIntensity = 0.8 + Math.sin(t * 1.7) * 0.2;
  };
  return g;
}

// Defender buildings in the earth elemental style. Origin = footprint center at ground level.
function buildMesh(type, teamColor = DEFENDER.colors[0]) {
  if (type === 'townhall') return buildTownHall(teamColor);
  if (type === 'barracks') return buildBarracks(teamColor);
  if (type === 'cannon') return buildTurret(teamColor);
  if (type === 'quarry') return buildQuarry(teamColor);
  return new THREE.Group();
}

export class BuildingManager {
  constructor(map, scene) {
    this.map = map;
    this.scene = scene;
    this.occ = new Int32Array(map.size * map.size).fill(-1); // -1 free, -2 decor, else building index
    this.list = [];

    this.ghost = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: 0x55ff88, transparent: true, opacity: 0.35, depthWrite: false }),
    );
    this.ghost.visible = false;
    scene.add(this.ghost);

    // Many-tile ghost for dragging out wall lines.
    this.ghosts = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false }),
      MAX_GHOSTS,
    );
    this.ghosts.count = 0;
    this.ghosts.frustumCulled = false;
    scene.add(this.ghosts);

    // Walls: a post on every wall tile, plus a half-segment toward each joined neighbour.
    // Rock walls: a jagged shard on every wall tile and smaller rocks between joined neighbours
    // (each gets its own height and twist from its tile, so walls look natural but stay stable).
    // Each piece's stone color is set per instance, so it can turn to quartz from level 6 (the
    // materials are white and the instance color carries the stone).
    this.wallPosts = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(0.5, 0), lambert(0xffffff, { flatShading: true }), MAX_WALLS);
    // Levels 11-15: native gold clusters on the shard (3 crystals each, up to 5 per piece).
    this.wallGold = new THREE.InstancedMesh(GOLD_GEO, goldMat(), MAX_WALLS * GOLD_LEVELS * GOLD_PARTS.length);
    this.wallSegs = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.5, 0), lambert(0xffffff, { flatShading: true }), MAX_WALLS * 4);
    // Upgraded wall pieces are armored with extra jagged rock plates: one more per level,
    // the last two angled out as spikes. Plain stone, no glow.
    // (A lighter stone than the shard, so each added plate reads.) Levels 4 and 5 add small
    // glowing team crystals jutting out instead of plates.
    this.wallPlates = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.5, 0), lambert(0xffffff, { flatShading: true }), MAX_WALLS * 3);
    // Glowing crystals in each piece's owner's color (set per instance; unlit so they glow).
    this.wallCrystals = new THREE.InstancedMesh(new THREE.OctahedronGeometry(0.5, 0),
      new THREE.MeshBasicMaterial({ color: 0xffffff }), MAX_WALLS * 6); // up to 2 side + 4 crown per piece
    for (const mesh of [this.wallPosts, this.wallGold, this.wallSegs, this.wallPlates, this.wallCrystals]) {
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.castShadow = mesh.receiveShadow = true;
      scene.add(mesh);
    }
  }

  // Upgrade level (0 = as built, up to 5): changes the building's look. Stats are handled by the game.
  setLevel(b, level) {
    b.level = level;
    if (b.mesh?.userData.setLevel) b.mesh.userData.setLevel(level, b.variant); // variant: a level-6 Turret's form
    if (b.type === 'wall') this.rebuildWalls(this.lastVis, this.lastFog);
  }

  isWall(t) { return this.occ[t] >= 0 && this.list[this.occ[t]].type === 'wall'; }

  // The building standing on this tile, or null.
  at(t) { return t >= 0 && this.occ[t] >= 0 ? this.list[this.occ[t]] : null; }

  // Deal damage. Returns how much was actually dealt (it can't go below 0 HP).
  // At 0 HP the building collapses into rubble and its tiles open up.
  damage(b, amount) {
    if (b.destroyed) return 0;
    const dealt = Math.min(amount, b.hp);
    b.hp -= dealt;
    b.shake = 0.3;
    if (b.hp <= 0) this.destroy(b);
    else this.ensureBar(b);
    return dealt;
  }

  // Restore HP (only while standing; rubble can't be repaired). Returns how much was healed.
  // The health bar goes away once it's back to full.
  heal(b, amount) {
    if (b.destroyed || b.hp >= b.maxHp) return 0;
    const healed = Math.min(amount, b.maxHp - b.hp);
    b.hp += healed;
    if (b.hp >= b.maxHp && b.bar) { this.scene.remove(b.bar); b.bar = null; }
    return healed;
  }

  // Ground height under a building tile: a ramp tile counts as halfway up its slope (walls can
  // stand on ramps).
  groundY(t) {
    return (this.map.level[t] + (this.map.ramp[t] >= 0 ? 0.5 : 0)) * LEVEL_HEIGHT;
  }
  // Do these two neighbouring wall tiles join? Wherever a unit could step between them: side
  // by side on one level, or up/down a ramp.
  wallsJoin(a, b) {
    return this.map.canStep(a, b);
  }

  // Wall pieces joined to this one (side by side, same level, or up and down a ramp), including itself.
  connectedWalls(b) {
    if (b.type !== 'wall' || b.destroyed) return b.destroyed ? [] : [b];
    const map = this.map, seen = new Set([b.tiles[0]]), stack = [b.tiles[0]], out = [];
    while (stack.length) {
      const t = stack.pop();
      out.push(this.at(t));
      for (let d = 0; d < 4; d++) {
        const nb = map.neighbor(t, d);
        if (nb < 0 || seen.has(nb) || !this.isWall(nb) || !this.wallsJoin(t, nb) || this.at(nb).owner !== b.owner) continue; // only its owner's walls
        seen.add(nb);
        stack.push(nb);
      }
    }
    return out;
  }

  // Taken apart by its owner (salvaged): it disappears without leaving rubble.
  remove(b) {
    b.destroyed = true;
    b.salvaged = true;
    const index = this.list.indexOf(b);
    for (const t of b.tiles) if (this.occ[t] === index) this.occ[t] = -1;
    if (b.mesh) this.scene.remove(b.mesh);
    if (b.bar) this.scene.remove(b.bar);
    if (b.type === 'wall') this.rebuildWalls(this.lastVis, this.lastFog);
  }

  destroy(b) {
    if (b.destroyed) return;
    b.destroyed = true;
    this.onDestroy?.(b); // the game's hook (main.js): e.g. the Quarry's crystal safety net
    for (const t of b.tiles) if (this.occ[t] === this.list.indexOf(b)) this.occ[t] = -1;
    if (b.mesh) this.scene.remove(b.mesh);
    if (b.bar) this.scene.remove(b.bar);
    // A low pile of rubble where it stood (doesn't block anything).
    const rubble = new THREE.Group();
    const S = this.map.size;
    let seed = b.tiles[0];
    const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };
    for (const t of b.tiles) {
      for (let k = 0; k < 2; k++) {
        const h = 0.08 + rnd() * 0.18;
        const chunk = new THREE.Mesh(new THREE.BoxGeometry(0.25 + rnd() * 0.3, h, 0.25 + rnd() * 0.3), MATS.rubble);
        chunk.position.set(t % S + 0.2 + rnd() * 0.6, this.groundY(t) + h / 2, ((t / S) | 0) + 0.2 + rnd() * 0.6);
        chunk.rotation.y = rnd() * Math.PI;
        chunk.castShadow = chunk.receiveShadow = true;
        rubble.add(chunk);
      }
    }
    this.scene.add(rubble);
    b.rubble = rubble;
    if (b.type === 'wall') this.rebuildWalls(this.lastVis, this.lastFog);
  }

  // A health bar above a damaged building (created on first damage).
  ensureBar(b) {
    if (b.bar) return;
    const w = b.type === 'wall' ? 0.7 : Math.min(2.4, Math.sqrt(b.tiles.length) * 0.9);
    const bar = new THREE.Group();
    const back = new THREE.Mesh(new THREE.PlaneGeometry(w + 0.06, 0.16),
      new THREE.MeshBasicMaterial({ color: 0x111418, depthTest: false }));
    const fillGeo = new THREE.PlaneGeometry(w, 0.1);
    fillGeo.translate(w / 2, 0, 0); // grows from the left edge
    const fill = new THREE.Mesh(fillGeo, new THREE.MeshBasicMaterial({ color: 0x6fd36f, depthTest: false }));
    fill.position.set(-w / 2, 0, 0.001);
    back.renderOrder = 10; fill.renderOrder = 11;
    bar.add(back, fill);
    const S = this.map.size;
    const cx = b.tiles.reduce((a, t) => a + t % S + 0.5, 0) / b.tiles.length;
    const cz = b.tiles.reduce((a, t) => a + ((t / S) | 0) + 0.5, 0) / b.tiles.length;
    bar.position.set(cx, this.groundY(b.tiles[0]) + BUILDINGS[b.type].height + 0.35, cz);
    bar.userData.fill = fill;
    this.scene.add(bar);
    b.bar = bar;
  }

  // Per frame: animated parts (crystals), health bars facing the camera, hit buildings shaking.
  // seesNow(b) (set by the game): whether this screen sees it right now. One that's only
  // remembered from before (in the fog) stands still, with no health bar and no shaking.
  update(dt, camera) {
    this.time = (this.time || 0) + dt;
    for (const b of this.list) {
      if (b.destroyed) continue;
      const live = !this.seesNow || this.seesNow(b);
      if (live && b.mesh && b.mesh.visible && b.mesh.userData.animate) b.mesh.userData.animate(this.time);
      if (b.bar) {
        b.bar.quaternion.copy(camera.quaternion);
        const r = Math.max(0, b.hp / b.maxHp);
        b.bar.userData.fill.scale.x = Math.max(0.001, r);
        b.bar.userData.fill.material.color.setHex(r > 0.6 ? 0x6fd36f : r > 0.3 ? 0xe8c25a : 0xe0533d);
        b.bar.visible = live && (!b.mesh || b.mesh.visible);
      }
      if (b.mesh && b.shake > 0 && !live) { b.shake = 0; b.mesh.position.set(b.home.x, b.home.y, b.home.z); }
      if (b.mesh && b.shake > 0) {
        b.shake = Math.max(0, b.shake - dt);
        const a = b.shake * 0.25;
        b.mesh.position.x = b.home.x + (Math.random() - 0.5) * a;
        b.mesh.position.z = b.home.z + (Math.random() - 0.5) * a;
        if (!b.shake) b.mesh.position.set(b.home.x, b.home.y, b.home.z);
      }
    }
  }

  rebuildWalls(vis, fogEnabled) {
    this.lastVis = vis;
    this.lastFog = fogEnabled;
    const map = this.map, S = map.size;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(1, 1, 1);
    const e = new THREE.Euler(0, 0, 0, 'YXZ');
    let np = 0, ng = 0, ns = 0, nl = 0, nc = 0;
    const gm = new THREE.Matrix4();
    const cPost = new THREE.Color(), cSeg = new THREE.Color(), cPlate = new THREE.Color(), cCrys = new THREE.Color();
    const WHITE = new THREE.Color(0xffffff);
    for (const b of this.list) {
      if (b.type !== 'wall' || b.destroyed) continue;
      const t = b.tiles[0];
      if (fogEnabled && vis[t] === 0) continue;
      const i = t % S, j = (t / S) | 0, y = this.groundY(t); // halfway up if on a ramp
      const lv = b.level || 0;
      // From level 6 the stone turns to quartz, fully by level 10; 11-15 grow gold clusters.
      const qz = Math.max(0, Math.min(1, (lv - 4) / 6)); // 6: a third of the way, 10: all
      cPost.set(WALL_STONE.post).lerp(QUARTZ, qz);
      cSeg.set(WALL_STONE.seg).lerp(QUARTZ_DARK, qz);
      cPlate.set(WALL_STONE.plate).lerp(QUARTZ, qz);
      cCrys.set(b.color ?? DEFENDER.colors[0]).lerp(WHITE, 0.3); // its owner's team color
      const crys = (mat) => { this.wallCrystals.setMatrixAt(nc, mat); this.wallCrystals.setColorAt(nc++, cCrys); };
      // Stable per-tile variation: height, width and twist. Upgrades: a bit taller each level.
      const h1 = ((Math.imul(t + 1, 2654435761) >>> 0) / 4294967296);
      const h2 = ((Math.imul(t + 7, 2246822519) >>> 0) / 4294967296);
      // Still being built (b.buildK 0..1, set by the game): it rises out of the ground.
      const tall = (1.2 + h1 * 0.5) * (1 + lv * 0.05) * (b.buildK === undefined ? 1 : 0.08 + 0.92 * b.buildK);
      q.setFromAxisAngle(UP, h2 * Math.PI * 2);
      s.set(0.52 + h2 * 0.14, tall, 0.46 + h1 * 0.1);
      const radius = (s.x + s.z) * 0.25; // roughly how far the shard's surface is from its center
      this.wallPosts.setMatrixAt(np, m.compose(p.set(i + 0.5, y + tall * 0.42, j + 0.5), q, s));
      this.wallPosts.setColorAt(np++, cPost);
      // Gold clusters (levels 11-15): one per level above 10, spread round the shard at
      // different heights, each leaning out from it.
      const radius0 = (s.x + s.z) * 0.25, gs = goldSize(lv) * 2.1;
      for (let k = 0; k < goldLevel(lv); k++) {
        const a = h2 * Math.PI * 2 + 1.2 + k * 2.4;
        const hf = [0.5, 0.3, 0.72, 0.4, 0.62][k];
        p.set(i + 0.5 + Math.cos(a) * radius0 * 0.8, y + tall * hf, j + 0.5 + Math.sin(a) * radius0 * 0.8);
        // Point the cluster's up axis outward and a little up.
        q.setFromUnitVectors(UP, new THREE.Vector3(Math.cos(a), 0.6, Math.sin(a)).normalize());
        m.compose(p, q, s.set(gs, gs, gs));
        for (const part of GOLD_PARTS) this.wallGold.setMatrixAt(ng++, gm.multiplyMatrices(m, part));
      }
      // Armor plates, one per level, spaced around the shard at different heights. Each lies
      // against the stone (thin side facing out). Levels 4 and 5 are small blue crystals
      // jutting out and up instead. Level 6 crowns the piece with a big crystal standing
      // straight up out of its top.
      for (let k = 0; k < Math.min(lv, 5); k++) {
        const crystal = k >= 3;
        const a = h1 * Math.PI * 2 + k * 2.4;                 // spread around (golden-angle-ish)
        const hf = [0.42, 0.62, 0.28, 0.55, 0.75][k];         // height up the shard
        const out = radius * (crystal ? 0.95 : 0.85);
        p.set(i + 0.5 + Math.cos(a) * out, y + tall * hf, j + 0.5 + Math.sin(a) * out);
        // Face outward (yaw), tilt so it leans out at the top; crystals lean out more.
        q.setFromEuler(e.set(crystal ? 0.7 : 0.18, -a + Math.PI / 2, (k % 2 ? 0.2 : -0.2)));
        if (crystal) crys(m.compose(p, q, s.set(0.13, 0.42, 0.13)));
        else { this.wallPlates.setMatrixAt(nl, m.compose(p, q, s.set(0.48, 0.6, 0.2))); this.wallPlates.setColorAt(nl++, cPlate); }
      }
      if (lv >= 6) {
        // The crown: one tall crystal at 6; 7, 8 and 9 each add a smaller one leaning out
        // around it; 10 makes the centre one bigger.
        const step = lv - 6;
        q.setFromAxisAngle(UP, h2 * Math.PI);
        const big = step >= 4 ? 1.3 : 1;
        crys(m.compose(p.set(i + 0.5, y + tall * 0.95, j + 0.5), q, s.set(0.24 * big, 0.8 * big, 0.24 * big)));
        for (let k = 0; k < Math.min(step, 3); k++) {
          const a = h1 * Math.PI * 2 + k * (Math.PI * 2 / 3);
          q.setFromEuler(e.set(0.55, -a + Math.PI / 2, 0));
          p.set(i + 0.5 + Math.cos(a) * 0.14, y + tall * 0.9, j + 0.5 + Math.sin(a) * 0.14);
          crys(m.compose(p, q, s.set(0.15, 0.48, 0.15)));
        }
      }
      for (let d = 0; d < 4; d++) {
        const nb = map.neighbor(t, d);
        if (nb < 0 || !this.isWall(nb) || !this.wallsJoin(t, nb) || this.at(nb).owner !== b.owner) continue; // different owners' walls don't join
        q.setFromAxisAngle(UP, (d % 2 ? Math.PI / 2 : 0) + h1 * 0.6);
        s.set(0.55, 0.85 + h2 * 0.3, 0.42);
        // The joining rock sits between the two pieces' heights (they differ up a ramp).
        const yj = y + (this.groundY(nb) - y) * 0.38;
        p.set(i + 0.5 + DIRS[d][0] * 0.38, yj + 0.36, j + 0.5 + DIRS[d][1] * 0.38);
        this.wallSegs.setMatrixAt(ns, m.compose(p, q, s));
        this.wallSegs.setColorAt(ns++, cSeg);
      }
    }
    this.wallPosts.count = np;
    this.wallGold.count = ng;
    this.wallSegs.count = ns;
    this.wallPlates.count = nl;
    this.wallCrystals.count = nc;
    for (const mesh of [this.wallPosts, this.wallGold, this.wallSegs, this.wallPlates, this.wallCrystals]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  showGhostTiles(tiles, isValid) {
    const map = this.map, S = map.size;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3();
    const s = new THREE.Vector3(0.9, 1, 0.9), col = new THREE.Color();
    const n = Math.min(tiles.length, MAX_GHOSTS);
    for (let k = 0; k < n; k++) {
      const t = tiles[k];
      p.set(t % S + 0.5, this.groundY(t) + 0.5, ((t / S) | 0) + 0.5);
      this.ghosts.setMatrixAt(k, m.compose(p, q, s));
      this.ghosts.setColorAt(k, col.setHex(isValid(t) ? 0x55ff88 : 0xff5555));
    }
    this.ghosts.count = n;
    this.ghosts.instanceMatrix.needsUpdate = true;
    if (this.ghosts.instanceColor) this.ghosts.instanceColor.needsUpdate = true;
  }

  // Hovered tile becomes the footprint's center (or just up-left of center for even sizes).
  footprint(type, tile) {
    const S = this.map.size, size = BUILDINGS[type].size;
    const off = Math.floor((size - 1) / 2);
    return { i0: tile % S - off, j0: ((tile / S) | 0) - off, size };
  }

  canPlace(type, tile, forbiddenTile) {
    const { i0, j0, size } = this.footprint(type, tile);
    const map = this.map;
    let level = null;
    for (let j = j0; j < j0 + size; j++) {
      for (let i = i0; i < i0 + size; i++) {
        if (!map.inBounds(i, j)) return false;
        const t = map.idx(i, j);
        if (t === forbiddenTile || this.occ[t] !== -1) return false;
        if (map.noBuild[t]) return false; // around tunnel mouths, the boss arena
        if (map.ramp[t] >= 0 && type !== 'wall') return false; // walls may block a ramp; nothing else goes on one
        if (map.zone[t] === ZONE.RUIN || map.isBlocked(t) || map.zone[t] === ZONE.WATCH) return false; // incl. groves
        if (level === null) level = map.level[t];
        else if (map.level[t] !== level) return false; // must sit on one flat level
      }
    }
    return true;
  }

  // owner/color: which defender it belongs to, and their team color.
  place(type, tile, owner = undefined, color = DEFENDER.colors[0]) {
    const { i0, j0, size } = this.footprint(type, tile);
    const map = this.map;
    const index = this.list.length;
    const tiles = [];
    for (let j = j0; j < j0 + size; j++) {
      for (let i = i0; i < i0 + size; i++) {
        const t = map.idx(i, j);
        this.occ[t] = index;
        tiles.push(t);
      }
    }
    let mesh = null; // walls are drawn together by rebuildWalls()
    const home = { x: i0 + size / 2, y: this.groundY(tiles[0]), z: j0 + size / 2 };
    if (type !== 'wall') {
      mesh = buildMesh(type, color);
      mesh.position.set(home.x, home.y, home.z);
      this.scene.add(mesh);
    }
    const hp = BUILDINGS[type].hp;
    const b = { type, tiles, mesh, home, hp, maxHp: hp, destroyed: false, bar: null, shake: 0, rubble: null, owner, color };
    this.list.push(b);
    return b;
  }

  showGhost(type, tile, valid) {
    if (type === null || tile < 0) { this.ghost.visible = false; return; }
    const { i0, j0, size } = this.footprint(type, tile);
    const S = this.map.size;
    const ci = Math.max(0, Math.min(S - 1, i0)), cj = Math.max(0, Math.min(S - 1, j0));
    const y = this.map.level[this.map.idx(ci, cj)] * LEVEL_HEIGHT;
    this.ghost.visible = true;
    this.ghost.scale.set(size, 0.4, size);
    this.ghost.position.set(i0 + size / 2, y + 0.2, j0 + size / 2);
    this.ghost.material.color.setHex(valid ? 0x55ff88 : 0xff5555);
  }

  // Buildings stay visible once their ground has been explored.
  applyFog(vis, enabled) {
    for (const b of this.list) {
      const seen = !enabled || b.tiles.some((t) => vis[t] > 0);
      if (b.mesh && !b.destroyed) b.mesh.visible = seen;
      if (b.rubble) b.rubble.visible = seen;
    }
    this.rebuildWalls(vis, enabled);
  }
}
