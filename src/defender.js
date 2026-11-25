import * as THREE from 'three';
import { DEFENDER } from './config.js';

// Two looks for the defender character, picked with DEFENDER.model (or ?defender= in the URL):
// the Sentinel (floating construct, default) and the Warden (soldier).

// The Warden: a settler defender. A soldier about half the Colossus's height, in a team-
// colored tabard and cloak over mail, with a kettle helmet, round shield and spear.
// (Test version: looks and movement only.)
function buildWarden(teamColor) {
  const team = new THREE.Color(teamColor);
  const teamDark = team.clone().multiplyScalar(0.62);
  const lambert = (color) => new THREE.MeshLambertMaterial({ color });
  const M = {
    team: lambert(team), teamDark: lambert(teamDark),
    mail: lambert(0x8d9096), steel: lambert(0xb4b8bf), skin: lambert(0xd9a77e),
    cloth: lambert(0x4a3b2e), boot: lambert(0x2b2420), leather: lambert(0x5a3a22),
    wood: lambert(0x7a5a36), gold: new THREE.MeshLambertMaterial({ color: 0xe8c25a, emissive: 0x5a3c00 }),
  };
  const mesh = (geo, mat, x = 0, y = 0, z = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    return m;
  };
  const box = (w, h, d, mat, x, y, z) => mesh(new THREE.BoxGeometry(w, h, d), mat, x, y, z);

  const root = new THREE.Group();
  const body = new THREE.Group(); // bobs while walking / breathing
  root.add(body);

  // Legs (pivot at the hip) with boots.
  const leg = (x) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, 0.46, 0);
    pivot.add(box(0.13, 0.4, 0.15, M.cloth, 0, -0.2, 0));
    pivot.add(box(0.15, 0.1, 0.21, M.boot, 0, -0.41, 0.025));
    body.add(pivot);
    return pivot;
  };
  const legL = leg(-0.085), legR = leg(0.085);

  // Torso: mail shirt, team tabard front and back with a gold emblem, belt, pauldrons.
  body.add(box(0.34, 0.36, 0.2, M.mail, 0, 0.64, 0));
  body.add(box(0.27, 0.42, 0.02, M.team, 0, 0.6, 0.11));
  body.add(box(0.27, 0.42, 0.02, M.team, 0, 0.6, -0.11));
  const emblem = box(0.075, 0.075, 0.01, M.gold, 0, 0.68, 0.125);
  emblem.rotation.z = Math.PI / 4;
  body.add(emblem);
  body.add(box(0.36, 0.05, 0.23, M.leather, 0, 0.47, 0));
  body.add(box(0.05, 0.05, 0.01, M.gold, 0, 0.47, 0.12));
  // Rounded shoulder plates (half-spheres, flattened).
  for (const x of [-0.2, 0.2]) {
    const pauldron = mesh(new THREE.SphereGeometry(0.085, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), M.steel, x, 0.77, 0);
    pauldron.scale.set(1.05, 0.75, 1.2);
    body.add(pauldron);
  }

  // Head and kettle helmet with a team-colored plume.
  body.add(mesh(new THREE.SphereGeometry(0.1, 10, 8), M.skin, 0, 0.92, 0));
  body.add(mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.025, 14), M.steel, 0, 0.96, 0));
  body.add(mesh(new THREE.SphereGeometry(0.112, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), M.steel, 0, 0.965, 0));
  // Horsehair crest running front to back over the helmet, in the team color.
  body.add(box(0.035, 0.07, 0.2, M.team, 0, 1.08, -0.01));
  body.add(box(0.03, 0.05, 0.06, M.team, 0, 1.05, -0.12)); // tail drooping at the back

  // Cloak hanging from the shoulders (pivot at the top so it can sway).
  const cloak = new THREE.Group();
  cloak.position.set(0, 0.8, -0.12);
  cloak.add(box(0.38, 0.58, 0.02, M.teamDark, 0, -0.29, 0));
  body.add(cloak);

  // Arms (pivot at the shoulder): sleeve and hand.
  const arm = (x) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, 0.78, 0);
    pivot.add(box(0.1, 0.34, 0.12, M.mail, 0, -0.17, 0));
    pivot.add(mesh(new THREE.SphereGeometry(0.045, 8, 6), M.skin, 0, -0.37, 0));
    body.add(pivot);
    return pivot;
  };
  const armL = arm(-0.24), armR = arm(0.24);

  // Spear in the right hand: wooden shaft, steel tip, a small team pennant.
  const spear = new THREE.Group();
  spear.position.set(0, -0.37, 0.03);
  spear.add(mesh(new THREE.CylinderGeometry(0.018, 0.018, 1.3, 6), M.wood, 0, 0.3, 0));
  spear.add(mesh(new THREE.ConeGeometry(0.055, 0.24, 6), M.steel, 0, 1.07, 0));
  spear.add(box(0.012, 0.1, 0.15, M.team, 0, 0.86, -0.08)); // pennant
  armR.add(spear);

  // Round shield on the left arm: team face, steel rim, gold boss.
  const shield = new THREE.Group();
  shield.position.set(-0.05, -0.24, 0.13);
  shield.rotation.y = -0.35;
  const face = mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.035, 18), M.team);
  face.rotation.x = Math.PI / 2;
  const rim = mesh(new THREE.TorusGeometry(0.2, 0.018, 6, 22), M.steel, 0, 0, 0.005);
  const boss = mesh(new THREE.SphereGeometry(0.05, 8, 6), M.gold, 0, 0, 0.025);
  shield.add(face, rim, boss);
  armL.add(shield);

  // Selection ring in the team color.
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.34, 0.42, 28),
    new THREE.MeshBasicMaterial({ color: team, transparent: true, opacity: 0.75, depthWrite: false }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.03;
  root.add(ring);

  return { root, body, legL, legR, armL, armR, cloak, spear, ring };
}

// The Sentinel: an earth elemental. No single body: jagged rock chunks float around a
// glowing core of team-colored energy (with a soft aura), a rock head with two glowing eyes
// hovers above, two big jagged rock fists float at its sides, and pebbles orbit it. It
// hovers instead of walking. (Test version: looks and movement.)
function buildSentinel(teamColor) {
  const team = new THREE.Color(teamColor);
  const lambert = (color, extra = {}) => new THREE.MeshLambertMaterial({ color, ...extra });
  const M = {
    rock: lambert(0x857d70, { flatShading: true }), darkRock: lambert(0x5c564e, { flatShading: true }),
    energy: lambert(team.clone().lerp(new THREE.Color(0xffffff), 0.35), { emissive: team, emissiveIntensity: 0.95, flatShading: true }),
    aura: new THREE.MeshBasicMaterial({ color: team, transparent: true, opacity: 0.2, depthWrite: false, blending: THREE.AdditiveBlending }),
    eye: new THREE.MeshBasicMaterial({ color: team.clone().lerp(new THREE.Color(0xffffff), 0.6) }),
  };
  const mesh = (geo, mat, x = 0, y = 0, z = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    return m;
  };
  const rock = (r, mat, x, y, z, sx, sy, sz, seed) => {
    const m = mesh(seed % 2 ? new THREE.DodecahedronGeometry(r, 0) : new THREE.IcosahedronGeometry(r, 0), mat, x, y, z);
    m.scale.set(sx, sy, sz);
    m.rotation.set(seed * 0.7, seed * 1.3, seed * 0.4);
    return m;
  };

  const root = new THREE.Group();
  const body = new THREE.Group(); // floats and bobs; leans when moving
  root.add(body);

  // Glowing energy core and its aura.
  const core = mesh(new THREE.IcosahedronGeometry(0.12, 0), M.energy, 0, 0.68, 0);
  body.add(core);
  const aura = mesh(new THREE.SphereGeometry(0.3, 12, 10), M.aura, 0, 0.68, 0);
  aura.castShadow = false;
  body.add(aura);

  // Rock chunks floating around the core (the "body"), each drifting on its own.
  const chunkSpots = [
    [0, 0.88, -0.05, 0.17, 1.3, 1, 1.1, 1],   // shoulders / chest top
    [-0.17, 0.66, 0.06, 0.14, 1, 1.3, 1, 2],  // left side
    [0.18, 0.64, 0.02, 0.15, 1, 1.25, 1, 3],  // right side
    [0, 0.66, -0.2, 0.16, 1.2, 1.2, 0.8, 4],  // back
    [0.02, 0.46, 0.04, 0.13, 1.1, 0.9, 1, 5], // belly
  ];
  const chunks = chunkSpots.map(([x, y, z, r, sx, sy, sz, s]) => {
    const c = rock(r, s % 2 ? M.rock : M.darkRock, x, y, z, sx, sy, sz, s);
    c.userData.home = new THREE.Vector3(x, y, z);
    body.add(c);
    return c;
  });
  // A jagged keel rock underneath (no legs: it floats).
  const keel = mesh(new THREE.ConeGeometry(0.11, 0.3, 5), M.darkRock, 0, 0.3, 0);
  keel.rotation.x = Math.PI;
  body.add(keel);

  // Head: a rock with two glowing eyes, hovering just above the body.
  const head = new THREE.Group();
  head.position.set(0, 1.12, 0.02);
  head.add(rock(0.13, M.rock, 0, 0, 0, 1.1, 0.95, 1, 6));
  for (const x of [-0.05, 0.05]) head.add(mesh(new THREE.SphereGeometry(0.025, 6, 5), M.eye, x, 0.01, 0.12));
  body.add(head);

  // Two big jagged rock fists, with a little energy where the wrist would be.
  const hands = [-1, 1].map((side) => {
    const hand = new THREE.Group();
    hand.position.set(side * 0.4, 0.62, 0.04);
    hand.add(rock(0.11, M.rock, 0, 0, 0, 1.1, 1.2, 1, side > 0 ? 7 : 8));
    hand.add(mesh(new THREE.IcosahedronGeometry(0.035, 0), M.energy, -side * 0.1, 0.08, 0));
    body.add(hand);
    return hand;
  });

  // Pebbles orbiting it.
  const shards = [0, 1, 2].map((k) => {
    const s = rock(0.035 + k * 0.006, M.rock, 0, 0, 0, 1, 1, 1, k + 2);
    body.add(s);
    return s;
  });

  // Soft team-colored glow on the ground under it, and the selection ring.
  const glow = new THREE.Mesh(
    new THREE.CircleGeometry(0.32, 20),
    new THREE.MeshBasicMaterial({ color: team, transparent: true, opacity: 0.22, depthWrite: false }),
  );
  glow.rotation.x = -Math.PI / 2;
  glow.position.y = 0.025;
  root.add(glow);
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.36, 0.44, 28),
    new THREE.MeshBasicMaterial({ color: team, transparent: true, opacity: 0.75, depthWrite: false }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.03;
  root.add(ring);

  body.scale.setScalar(1.15); // a touch bigger so it reads at normal zoom
  return { kind: 'sentinel', root, body, core, aura, chunks, head, hands, shards, glow, ring, energy: M.energy };
}

export class Defender {
  // model: 'sentinel' (floating construct) or 'warden' (soldier); defaults to DEFENDER.model.
  constructor(map, scene, x, z, teamColor = DEFENDER.colors[0], model = DEFENDER.model) {
    this.map = map;
    this.speed = DEFENDER.speed;
    this.x = x;
    this.z = z;
    this.path = [];
    this.goal = -1;
    this.yaw = 0;
    this.targetYaw = 0;
    this.walkPhase = 0;
    this.time = 0;
    this.parts = model === 'warden' ? buildWarden(teamColor) : buildSentinel(teamColor);
    scene.add(this.parts.root);
    this.syncMesh();
  }

  get tile() { return this.map.tileAt(this.x, this.z); }

  setPath(path, goal) { this.path = path; this.goal = goal; }

  setSelected(on) { this.parts.ring.visible = on; }

  // Struck: a short shudder.
  flinch() { this.shake = 0.3; }

  // Out of health: it stops, and its stone shatters and sinks into the ground.
  die() {
    this.dead = true;
    this.deathT = 0;
    this.path = [];
    this.channeling = false;
  }

  revive() {
    this.dead = false;
    this.deathT = 0;
    this.sink = 0;
    this.parts.root.visible = true;
    this.parts.root.rotation.set(0, this.yaw, 0);
  }

  update(dt) {
    this.time += dt;
    if (this.dead) { // topple sideways while shrinking into the ground
      this.deathT = Math.min(1, this.deathT + dt / 1.2);
      const k = this.deathT;
      this.sink = k;
      this.syncMesh();
      this.parts.root.rotation.z = k * 1.2;
      return;
    }
    let moving = false;
    if (this.path.length) {
      const S = this.map.size;
      const t = this.path[0];
      const tx = t % S + 0.5, tz = ((t / S) | 0) + 0.5;
      const dx = tx - this.x, dz = tz - this.z;
      const dist = Math.hypot(dx, dz);
      const step = this.speed * dt;
      if (dist > 1e-4) this.targetYaw = Math.atan2(dx, dz);
      if (dist <= step) { this.x = tx; this.z = tz; this.path.shift(); }
      else { this.x += (dx / dist) * step; this.z += (dz / dist) * step; }
      moving = true;
    }

    let diff = this.targetYaw - this.yaw;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    this.yaw += diff * Math.min(1, dt * 12);

    if (this.parts.kind === 'sentinel') this.animateSentinel(dt, moving);
    else this.animateWarden(dt, moving);
    this.syncMesh();
  }

  // Hovers and bobs; leans into movement with its fists trailing; core spins, shards orbit.
  animateSentinel(dt, moving) {
    const { body, core, hands, shards, glow } = this.parts;
    const t = this.time, ease = Math.min(1, dt * 6);
    this.lean = (this.lean || 0) + ((moving ? 0.22 : 0) - (this.lean || 0)) * ease;
    const hover = 0.28 + Math.sin(t * 2.1) * 0.045;
    body.position.y = hover;
    body.rotation.x = this.lean;
    core.rotation.y += dt * (this.channeling ? 6 : moving ? 3 : 1.2);
    hands.forEach((h, k) => {
      const side = k ? 1 : -1;
      h.position.y = 0.62 + Math.sin(t * 2.6 + k * Math.PI) * 0.035;
      h.position.z += ((moving ? -0.12 : 0.04) - h.position.z) * ease; // trail behind when moving
      h.position.x = side * (0.38 + Math.sin(t * 1.7 + k) * 0.015);
      h.rotation.y = t * 0.8 * side;
    });
    const spin = t * (moving ? 2.6 : 1.4);
    shards.forEach((s, k) => {
      const a = spin + (k / shards.length) * Math.PI * 2;
      s.position.set(Math.cos(a) * 0.44, 0.66 + Math.sin(a * 2 + k) * 0.12, Math.sin(a) * 0.44);
      s.rotation.y = a;
    });
    const pulse = (this.channeling ? 0.32 : 0.18) + Math.sin(t * (this.channeling ? 7 : 3)) * 0.05;
    glow.material.opacity = pulse;
    glow.scale.setScalar(1 - (hover - 0.28) * 1.5);
    // Elemental details: body chunks drift on their own, the core and aura breathe, the head sways.
    const { chunks, aura, head, energy } = this.parts;
    if (chunks) {
      chunks.forEach((c, k) => {
        const h = c.userData.home, spread = moving ? 1.08 : 1;
        c.position.set(h.x * spread + Math.sin(t * 1.3 + k * 1.7) * 0.02,
          h.y + Math.sin(t * 1.8 + k * 2.1) * 0.025, h.z * spread + Math.cos(t * 1.1 + k) * 0.02);
        c.rotation.y += dt * (0.2 + k * 0.05) * (k % 2 ? 1 : -1);
      });
      // While repairing (channeling) the aura swells and the energy burns brighter and faster.
      const ch = this.channeling, breathe = Math.sin(t * (ch ? 6 : 2.4));
      aura.scale.setScalar((ch ? 1.3 : 1) + breathe * 0.12);
      aura.material.opacity = (ch ? 0.3 : 0.18) + breathe * 0.05;
      energy.emissiveIntensity = (ch ? 1.5 : 0.8) + breathe * 0.2;
      head.position.y = 1.12 + Math.sin(t * 1.6 + 1) * 0.02;
      head.rotation.y = Math.sin(t * 0.7) * 0.25;
    }
  }

  // Brisk march when moving; breathing and a gentle cloak sway when standing.
  animateWarden(dt, moving) {
    const { legL, legR, armL, armR, cloak, spear, body } = this.parts;
    if (moving) this.walkPhase += dt * this.speed * 3.2;
    const swing = moving ? Math.sin(this.walkPhase) : 0;
    const ease = Math.min(1, dt * 10);
    legL.rotation.x += (swing * 0.6 - legL.rotation.x) * ease;
    legR.rotation.x += (-swing * 0.6 - legR.rotation.x) * ease;
    armL.rotation.x += ((moving ? -0.25 : -0.15) - swing * 0.12 - armL.rotation.x) * ease; // shield held forward
    armR.rotation.x += (swing * 0.3 - armR.rotation.x) * ease;
    spear.rotation.x = moving ? -0.25 + swing * 0.05 : -0.05 + Math.sin(this.time * 1.3) * 0.02;
    const breathe = Math.sin(this.time * 2.2) * 0.008;
    body.position.y = moving ? Math.abs(Math.cos(this.walkPhase)) * 0.035 : breathe;
    cloak.rotation.x = (moving ? 0.35 + Math.sin(this.walkPhase * 2) * 0.05 : 0.08) + Math.sin(this.time * 1.6) * 0.04;
  }

  // sink: 0 = normal, 1 = fully inside a tunnel (shrunk away into the mouth in the wall).
  syncMesh() {
    const sink = this.sink || 0;
    let sx = 0, sz = 0;
    if (this.shake > 0) { // shudder after a hit
      this.shake = Math.max(0, this.shake - 1 / 60);
      sx = (Math.random() - 0.5) * this.shake * 0.5;
      sz = (Math.random() - 0.5) * this.shake * 0.5;
    }
    this.parts.root.position.set(this.x + sx, this.map.heightAt(this.x, this.z) - sink * 0.3, this.z + sz);
    this.parts.root.rotation.y = this.yaw;
    this.parts.root.scale.setScalar(Math.max(0.02, 1 - sink * 0.98));
  }
}
