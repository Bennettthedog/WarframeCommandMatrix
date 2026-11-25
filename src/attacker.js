import * as THREE from 'three';
import { ATTACKER } from './config.js';

const RUNE_COLOR = 0xff4a32;   // glowing runes, eyes, shards and selection ring
const HEART_COLOR = 0xff8a5c;  // the heart-crystal (hotter, brighter)

// The Colossus: a hunched, ancient stone titan. Faceted boulders for a body, moss on its
// shoulders, cyan rune-cracks and a pulsing heart-crystal, huge fists, and rune shards
// circling its back. Faces +z.
function buildGolem() {
  const lambert = (color, extra = {}) => new THREE.MeshLambertMaterial({ color, flatShading: true, ...extra });
  const stone = lambert(0x8f887b);
  const darkStone = lambert(0x625c53);
  const paleStone = lambert(0xa9a191);
  const moss = lambert(0x5f7d3c);
  const rune = new THREE.MeshBasicMaterial({ color: RUNE_COLOR });
  const heart = new THREE.MeshBasicMaterial({ color: HEART_COLOR });

  // A faceted rock (alternating shapes so it doesn't look repeated), stretched by (sx, sy, sz).
  let n = 0;
  const rock = (parent, r, mat, x, y, z, sx = 1, sy = 1, sz = 1, rot = 0) => {
    const geo = n++ % 2 ? new THREE.DodecahedronGeometry(r, 0) : new THREE.IcosahedronGeometry(r, 0);
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.scale.set(sx, sy, sz);
    m.rotation.set(rot * 0.7, rot, rot * 0.4);
    m.castShadow = true;
    parent.add(m);
    return m;
  };
  const box = (parent, w, h, d, mat, x, y, z, rx = 0, rz = 0) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, 0, rz);
    parent.add(m);
    return m;
  };

  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  // Hips and a hunched chest (tipped forward).
  rock(body, 0.36, darkStone, 0, 0.78, -0.02, 1.35, 0.7, 1.0, 0.3);
  const chest = new THREE.Group();
  chest.position.set(0, 1.18, 0);
  chest.rotation.x = 0.2;
  body.add(chest);
  rock(chest, 0.56, stone, 0, 0.12, 0, 1.25, 0.92, 0.85, 0.15);
  rock(chest, 0.3, darkStone, 0, 0.12, -0.38, 1.5, 0.9, 0.6, 0.8);       // back slab
  // Back spines.
  for (const [x, y, s] of [[0, 0.45, 1], [-0.22, 0.3, 0.75], [0.22, 0.3, 0.75]]) {
    const spike = new THREE.Mesh(new THREE.ConeGeometry(0.09 * s, 0.38 * s, 5), darkStone);
    spike.position.set(x, y, -0.5);
    spike.rotation.x = -0.9;
    chest.add(spike);
  }
  // Heart-crystal in a dark socket, with rune-cracks running out from it.
  rock(chest, 0.17, darkStone, 0, 0.12, 0.42, 1.1, 1.1, 0.5);
  const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.15, 0), heart);
  core.position.set(0, 0.12, 0.48);
  chest.add(core);
  for (const [x, y, len, rz] of [[0.2, 0.28, 0.24, -0.9], [-0.21, 0.27, 0.22, 0.85], [0.22, -0.06, 0.2, 0.7],
    [-0.2, -0.08, 0.24, -0.6], [0.36, 0.38, 0.14, -0.2], [-0.37, 0.36, 0.12, 0.3]]) {
    box(chest, 0.035, len, 0.02, rune, x, y, 0.46 - Math.abs(x) * 0.25, -0.15, rz);
  }

  // Head: low and forward between the shoulders, with a heavy brow and slit eyes.
  const head = new THREE.Group();
  head.position.set(0, 1.82, 0.26);
  body.add(head);
  rock(head, 0.25, paleStone, 0, 0, 0, 1.1, 0.95, 1.05, 0.5);
  box(head, 0.46, 0.09, 0.18, darkStone, 0, 0.1, 0.17, 0.25);            // brow
  box(head, 0.12, 0.045, 0.02, rune, -0.09, 0.02, 0.26);                 // eyes
  box(head, 0.12, 0.045, 0.02, rune, 0.09, 0.02, 0.26);
  rock(head, 0.1, paleStone, 0, -0.14, 0.14, 1.6, 0.6, 0.8);             // jaw

  // Arms: boulder shoulders capped with moss, long arms, and huge fists that drag low.
  const arm = (side) => {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.72, 1.6, 0.02);
    body.add(pivot);
    rock(pivot, 0.34, stone, side * 0.06, 0.06, 0, 1.15, 0.9, 1.05, side);    // shoulder boulder
    rock(pivot, 0.2, moss, side * 0.08, 0.27, -0.04, 1.2, 0.3, 1.0, side);    // moss cap
    rock(pivot, 0.17, darkStone, side * 0.04, -0.32, 0, 0.95, 1.5, 0.95, 0.4);  // upper arm
    rock(pivot, 0.22, stone, side * 0.05, -0.68, 0.02, 1.0, 1.35, 1.0, 1.1);    // forearm
    box(pivot, 0.36, 0.04, 0.36, rune, side * 0.05, -0.6, 0.02);              // rune band
    rock(pivot, 0.27, paleStone, side * 0.05, -1.0, 0.04, 1.05, 0.95, 1.1, 0.7); // fist
    rock(pivot, 0.09, darkStone, side * 0.05, -0.92, 0.27, 1.6, 0.7, 0.8);      // knuckles
    return pivot;
  };
  const armL = arm(-1);
  const armR = arm(1);

  // Short, thick legs with wide stone feet.
  const leg = (side) => {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.27, 0.68, 0);
    body.add(pivot);
    rock(pivot, 0.24, stone, 0, -0.24, 0, 0.95, 1.25, 1.0, side * 0.6);
    rock(pivot, 0.2, darkStone, 0, -0.56, 0.06, 1.3, 0.6, 1.5, 0.2);
    return pivot;
  };
  const legL = leg(-1);
  const legR = leg(1);

  // Rune shards floating in a slow circle behind its shoulders.
  const halo = new THREE.Group();
  halo.position.set(0, 2.05, -0.35);
  body.add(halo);
  const shards = [];
  for (let i = 0; i < 3; i++) {
    const s = new THREE.Mesh(new THREE.OctahedronGeometry(0.075, 0), rune);
    s.scale.set(0.7, 1.6, 0.7);
    halo.add(s);
    shards.push(s);
  }

  // Selection ring on the ground.
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.85, 0.98, 40),
    new THREE.MeshBasicMaterial({ color: RUNE_COLOR, transparent: true, opacity: 0.7, depthWrite: false }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.03;
  root.add(ring);

  return { root, body, armL, armR, legL, legR, ring, core, heart, rune, shards };
}

export class Attacker {
  constructor(map, scene) {
    this.map = map;
    this.speed = ATTACKER.speed;
    this.x = map.size / 2 + 0.5;
    this.z = map.size / 2 + 0.5;
    this.path = [];
    this.goal = -1;
    this.yaw = 0;
    this.targetYaw = 0;
    this.walkPhase = 0;
    this.swing = 0;        // attack animation progress (0 = not swinging, then 0..1)
    this.hitNow = false;   // set for one frame when a swing lands
    this.parts = buildGolem();
    scene.add(this.parts.root);
    this.syncMesh();
  }

  get tile() { return this.map.tileAt(this.x, this.z); }

  setPath(path, goal) { this.path = path; this.goal = goal; }

  setSelected(on) { this.parts.ring.visible = on; }

  // Start a two-fisted overhead slam; `hitNow` turns true for one frame when it lands.
  startSwing() { if (!this.swing) this.swing = 1e-6; }

  // Struck by something: a short shudder.
  flinch() { this.shake = 0.3; }

  // Out of health (it has a single life): it stops and topples over, breaking apart.
  die() {
    this.dead = true;
    this.deathT = 0;
    this.path = [];
    this.swing = 0;
  }

  // Back to life (debug).
  revive() {
    this.dead = false;
    this.deathT = 0;
    const { root, body } = this.parts;
    root.rotation.set(0, this.yaw, 0);
    body.rotation.x = 0;
  }

  // Heart-crystal pulse and the rune shards circling its back; the light goes out when it falls.
  animateGlow(dt) {
    this.glowT = (this.glowT ?? 0) + dt;
    const { core, heart, rune, shards } = this.parts;
    const t = this.glowT, life = this.dead ? Math.max(0, 1 - this.deathT * 1.5) : 1;
    const pulse = 0.75 + 0.25 * Math.sin(t * 3);
    heart.color.setHex(HEART_COLOR).multiplyScalar(Math.max(0.12, pulse * life));
    rune.color.setHex(RUNE_COLOR).multiplyScalar(Math.max(0.12, (0.85 + 0.15 * Math.sin(t * 3)) * life));
    core.rotation.y = t * 1.2;
    core.scale.setScalar(0.9 + 0.15 * pulse);
    shards.forEach((s, i) => {
      const a = t * 0.9 + (i * Math.PI * 2) / shards.length;
      s.visible = life > 0;
      s.position.set(Math.cos(a) * 0.55, Math.sin(t * 2 + i) * 0.06, Math.sin(a) * 0.22);
      s.rotation.y = t * 2 + i;
    });
  }

  update(dt) {
    this.animateGlow(dt);
    if (this.dead) { // collapse: pitch forward and sink into the ground
      this.deathT = Math.min(1, this.deathT + dt / 1.6);
      const k = 1 - (1 - this.deathT) ** 3;
      this.parts.body.rotation.x = k * 1.25;
      this.syncMesh();
      this.parts.root.position.y -= k * 0.6;
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

    // Turn smoothly toward the direction of travel.
    let diff = this.targetYaw - this.yaw;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    this.yaw += diff * Math.min(1, dt * 10);

    // Heavy, slow walk cycle.
    const { armL, armR, legL, legR, body } = this.parts;
    if (moving) this.walkPhase += dt * this.speed * 2.2;
    const swing = moving ? Math.sin(this.walkPhase) : 0;
    const ease = Math.min(1, dt * 8);
    legL.rotation.x += (swing * 0.55 - legL.rotation.x) * ease;
    legR.rotation.x += (-swing * 0.55 - legR.rotation.x) * ease;
    body.position.y = moving ? Math.abs(Math.cos(this.walkPhase)) * 0.06 : 0;

    if (this.swing) {
      // Slam: raise both arms overhead (0–55%), crash down (55–70%, the hit), recover.
      // 0.75 s normally; faster when its attack speed needs it (swingTime, set by main.js).
      const SWING_TIME = this.swingTime || 0.75;
      const before = this.swing;
      this.swing = Math.min(1, this.swing + dt / SWING_TIME);
      const p = this.swing;
      let arm, lean;
      if (p < 0.55) { const k = p / 0.55; arm = -2.7 * k; lean = -0.12 * k; }
      else if (p < 0.7) { const k = (p - 0.55) / 0.15; arm = -2.7 + 2.2 * k; lean = -0.12 + 0.42 * k; } // fists end in front, at the ground
      else { const k = (p - 0.7) / 0.3; arm = -0.5 * (1 - k); lean = 0.3 * (1 - k); }
      armL.rotation.x = arm;
      armR.rotation.x = arm;
      body.rotation.x = lean;
      if (before < 0.7 && p >= 0.7) this.hitNow = true;
      if (p >= 1) { this.swing = 0; body.rotation.x = 0; }
    } else {
      armL.rotation.x += (-swing * 0.4 - armL.rotation.x) * ease;
      armR.rotation.x += (swing * 0.4 - armR.rotation.x) * ease;
    }

    this.syncMesh();
  }

  syncMesh() {
    let sx = 0, sz = 0;
    if (this.shake > 0) { // shudder after a hit
      this.shake = Math.max(0, this.shake - 1 / 60);
      sx = (Math.random() - 0.5) * this.shake * 0.4;
      sz = (Math.random() - 0.5) * this.shake * 0.4;
    }
    this.parts.root.position.set(this.x + sx, this.map.heightAt(this.x, this.z), this.z + sz);
    this.parts.root.rotation.y = this.yaw;
  }
}
