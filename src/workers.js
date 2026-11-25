import * as THREE from 'three';
import { QUARRY_WORKERS } from './config.js';
import { findPath, isWalkable } from './pathfinding.js';

// Quarry workers: small stone helpers, one per ore (QUARRY_WORKERS.list). They are units: the
// defender can select them and send them to a crystal rock or anywhere else. Left alone, each
// walks to the crystal rock nearest its Quarry and swings its pick at it. Crystals are earned
// only while a worker is mining (its rate per second; gold rocks give QUARRY_WORKERS.goldBonus
// times that), and only while a Quarry stands. They all share one shape; their ore sets the
// colors of their body crystals, eyes, pick head and selection ring.
//
// update(dt, ctx): ctx = { quarries: [{x, z, tile}] standing Quarries, crystals: tiles of
//   crystal rocks, camera }. Returns the crystals mined this frame.

const STONE = new THREE.MeshLambertMaterial({ color: 0x857d70, flatShading: true });
const DARK = new THREE.MeshLambertMaterial({ color: 0x5c564e, flatShading: true });
const WOOD = new THREE.MeshLambertMaterial({ color: 0x6b4a2f, flatShading: true });

function rock(parent, r, mat, x, y, z, sx = 1, sy = 1, sz = 1, seed = 0) {
  const m = new THREE.Mesh(seed % 2 ? new THREE.DodecahedronGeometry(r, 0) : new THREE.IcosahedronGeometry(r, 0), mat);
  m.position.set(x, y, z);
  m.scale.set(sx, sy, sz);
  m.rotation.set(seed * 0.7, seed * 1.3, seed * 0.4);
  m.castShadow = true;
  parent.add(m);
  return m;
}

function buildModel(def) {
  const ore = new THREE.MeshLambertMaterial({ color: def.color, emissive: def.glow, emissiveIntensity: 0.45, flatShading: true });
  const glow = new THREE.MeshBasicMaterial({ color: def.glow });
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  // A round, hunched stone body with ore crystals growing out of its back.
  rock(body, 0.17, STONE, 0, 0.3, 0, 1.1, 1, 1, 1);
  rock(body, 0.08, DARK, 0, 0.5, 0.05, 1, 0.9, 1, 2);
  for (const [x, y, z, s] of [[0, 0.42, -0.14, 1], [-0.08, 0.36, -0.15, 0.7], [0.08, 0.37, -0.15, 0.8]]) {
    const c = new THREE.Mesh(new THREE.OctahedronGeometry(0.05 * s, 0), ore);
    c.position.set(x, y, z); c.scale.set(1, 2.2, 1); c.rotation.x = -0.5;
    body.add(c);
  }
  for (const x of [-0.035, 0.035]) {
    const e = new THREE.Mesh(new THREE.SphereGeometry(0.016, 6, 5), glow);
    e.position.set(x, 0.51, 0.12);
    body.add(e);
  }
  // Legs.
  const legL = new THREE.Group(), legR = new THREE.Group();
  legL.position.set(-0.08, 0.15, 0); legR.position.set(0.08, 0.15, 0);
  rock(legL, 0.06, DARK, 0, -0.07, 0, 1, 1, 1.2, 3);
  rock(legR, 0.06, DARK, 0, -0.07, 0, 1, 1, 1.2, 4);
  body.add(legL, legR);
  // Right arm with a pick (wooden haft, ore-colored head); left arm holds the ore it carries.
  const armR = new THREE.Group();
  armR.position.set(0.17, 0.36, 0.02);
  rock(armR, 0.045, DARK, 0, -0.06, 0, 1, 1.4, 1, 5);
  const haft = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.32, 5), WOOD);
  haft.position.set(0, -0.08, 0.12); haft.rotation.x = Math.PI / 2;
  const head = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.2, 4), ore);
  head.position.set(0, -0.08, 0.27); head.rotation.z = Math.PI / 2;
  armR.add(haft, head);
  body.add(armR);
  const armL = new THREE.Group();
  armL.position.set(-0.17, 0.36, 0.02);
  rock(armL, 0.045, DARK, 0, -0.06, 0, 1, 1.4, 1, 6);
  body.add(armL);
  const chunk = new THREE.Mesh(new THREE.OctahedronGeometry(0.08, 0), ore);
  chunk.position.set(0, 0.72, 0);
  chunk.visible = false;
  body.add(chunk);
  // Ore-colored glow on the ground and a health bar.
  const pool = new THREE.Mesh(new THREE.CircleGeometry(0.2, 14),
    new THREE.MeshBasicMaterial({ color: def.glow, transparent: true, opacity: 0.18, depthWrite: false }));
  pool.rotation.x = -Math.PI / 2; pool.position.y = 0.02;
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.25, 0.31, 24),
    new THREE.MeshBasicMaterial({ color: def.glow, transparent: true, opacity: 0.85, depthWrite: false }));
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.03; ring.visible = false;
  root.add(pool, ring);
  const w = 0.45, bar = new THREE.Group();
  const back = new THREE.Mesh(new THREE.PlaneGeometry(w + 0.04, 0.09), new THREE.MeshBasicMaterial({ color: 0x111418, depthTest: false }));
  const fillGeo = new THREE.PlaneGeometry(w, 0.05);
  fillGeo.translate(w / 2, 0, 0);
  const fill = new THREE.Mesh(fillGeo, new THREE.MeshBasicMaterial({ color: 0x6fd36f, depthTest: false }));
  fill.position.set(-w / 2, 0, 0.001);
  back.renderOrder = 10; fill.renderOrder = 11;
  bar.add(back, fill);
  bar.visible = false;
  return { root, body, legL, legR, armR, armL, chunk, ring, bar, fill };
}

let nextId = 1;
class Worker {
  constructor(tier, x, z, map, scene) {
    this.id = nextId++;
    this.tier = tier;                  // 1-7
    this.def = QUARRY_WORKERS.list[tier - 1];
    this.size = 1 + (tier - 1) * QUARRY_WORKERS.sizeStep; // better helpers are a bit bigger
    this.name = `${this.def.ore} Helper`;
    this.map = map;
    this.x = x; this.z = z;
    this.isWorker = true;
    this.path = [];
    // order: 'auto' (mine the rock nearest the Quarry), 'rock' (mine this.rock, picked by the
    // player) or 'hold' (moved somewhere by the player: stays there).
    this.order = 'auto';
    this.rock = -1;                    // the rock the player picked (order 'rock')
    this.target = -1;                  // the rock it's working on now (one worker per rock)
    this.anchor = -1;
    this.state = 'walk';               // 'walk' (to the rock), 'mine', 'move' (player order), 'idle'
    this.timer = 0;
    this.earning = 0;                  // crystals per second right now (0 unless mining)
    this.hp = this.maxHp = QUARRY_WORKERS.hp;
    this.yaw = 0; this.targetYaw = 0;
    this.walk = Math.random() * 6;
    this.time = Math.random() * 10;
    this.parts = buildModel(this.def);
    scene.add(this.parts.root, this.parts.bar);
  }
  get tile() { return this.map.tileAt(this.x, this.z); }
}

export class Workers {
  // occFn(): the building map as defenders see it (their walls don't block them).
  constructor(map, scene, occFn) {
    this.map = map;
    this.scene = scene;
    this.occFn = occFn;
    this.list = [];
  }

  get alive() { return this.list.filter((w) => !w.dead); }
  has(tier) { return this.alive.some((w) => w.tier === tier); }
  // Crystals per second if every living worker were mining a plain rock.
  rate() { return this.alive.reduce((s, w) => s + w.def.rate, 0); }
  // Crystals per second being mined right now.
  miningRate() { return this.alive.reduce((s, w) => s + w.earning, 0); }
  // A worker's rate at this rock: gold (rare) rocks give the bonus.
  rockRate(w, rock) { return w.def.rate * (this.map.rareCrystals.has(rock) ? QUARRY_WORKERS.goldBonus : 1); }

  setSelected(w, on) { w.selected = on; w.parts.ring.visible = on && !w.dead; }
  // Player orders.
  // Mine this rock. One worker per rock: whoever held it before goes and finds another.
  orderMine(w, rock) {
    for (const o of this.list) if (o !== w && o.order === 'rock' && o.rock === rock) this.orderAuto(o);
    w.order = 'rock'; w.rock = rock; w.target = rock; w.anchor = -1; w.state = 'walk'; w.path = []; w.wait = 0;
  }
  // Mine on their own: the free rock nearest the Quarry, or nearest `anchor` (a tile) if given.
  orderAuto(w, anchor = -1) { w.order = 'auto'; w.anchor = anchor; w.target = -1; w.state = 'walk'; w.path = []; w.wait = 0; }
  orderMove(w, tile) {
    const path = findPath(this.map, this.occFn(w.owner ?? null), w.tile, tile);
    if (!path) return false;
    w.order = 'hold'; w.state = 'move'; w.path = path; w.earning = 0;
    return true;
  }
  // Remove a helper (dismissed by the player): it sinks away like a fallen one.
  dismiss(w) {
    if (w.dead) return;
    w.dead = true; w.dismissed = true; w.deathT = 0; w.path = []; w.earning = 0;
    w.parts.bar.visible = false; w.parts.ring.visible = false;
  }
  stop(w) { w.order = 'hold'; w.state = 'idle'; w.path = []; w.earning = 0; }

  spawn(tier, x, z, owner = null) {
    const w = new Worker(tier, x, z, this.map, this.scene);
    w.owner = owner;
    this.list.push(w);
    this.sync(w, 0);
    return w;
  }

  damage(w, amount) {
    if (w.dead) return 0;
    const dealt = Math.min(w.hp, amount);
    w.hp -= dealt;
    w.shake = 0.3;
    if (w.hp <= 0) { w.dead = true; w.deathT = 0; w.path = []; w.earning = 0; w.parts.bar.visible = false; w.parts.ring.visible = false; }
    return dealt;
  }

  // The free (unclaimed) crystal rock nearest the Quarry nearest this worker, or nearest its
  // anchor tile, within searchRadius; -1 if there is none.
  autoRock(w, ctx, claims) {
    const S = this.map.size;
    let cx, cz;
    if (w.anchor >= 0) { cx = w.anchor % S + 0.5; cz = ((w.anchor / S) | 0) + 0.5; }
    else {
      let q = null, best = Infinity;
      for (const k of ctx.quarries) { // its owner's Quarry
        if ((k.owner ?? null) !== (w.owner ?? null)) continue;
        const d = Math.hypot(k.x - w.x, k.z - w.z); if (d < best) { best = d; q = k; }
      }
      if (!q) return -1;
      cx = q.x; cz = q.z;
    }
    let rock = -1, rd = Infinity;
    for (const t of ctx.crystals) {
      if (claims.has(t)) continue;
      const d = Math.hypot(t % S + 0.5 - cx, ((t / S) | 0) + 0.5 - cz);
      if (d < rd && d <= QUARRY_WORKERS.searchRadius) { rd = d; rock = t; }
    }
    return rock;
  }
  // Only one worker mines each rock. Work out who has which this frame: player-picked rocks
  // first, then workers keeping the rock they already had (the ones mining first), then
  // everyone else takes the nearest free one.
  assignRocks(ctx, rocks) {
    const claims = new Map();
    const busy = this.list.filter((w) => !w.dead && w.order !== 'hold');
    for (const w of busy) {
      if (w.order !== 'rock') continue;
      if (rocks.has(w.rock) && !claims.has(w.rock)) { claims.set(w.rock, w); w.target = w.rock; } else this.orderAuto(w); // rock gone
    }
    const autos = busy.filter((w) => w.order === 'auto').sort((a, b) => (b.state === 'mine') - (a.state === 'mine'));
    for (const w of autos) {
      if (w.target >= 0 && rocks.has(w.target) && !claims.has(w.target)) claims.set(w.target, w); else w.target = -1;
    }
    for (const w of autos) {
      if (w.target >= 0) continue;
      w.target = this.autoRock(w, ctx, claims);
      if (w.target >= 0) claims.set(w.target, w);
    }
  }
  // Where this worker stands to mine a rock: the open tile beside it nearest the worker.
  standTile(w, rock, occ) {
    const S = this.map.size, ri = rock % S, rj = (rock / S) | 0;
    let best = -1, bd = Infinity;
    for (const [di, dj] of [[0, 1], [1, 0], [0, -1], [-1, 0], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      const i = ri + di, j = rj + dj, t = j * S + i;
      if (!this.map.inBounds(i, j) || !isWalkable(this.map, occ, t)) continue;
      const d = Math.hypot(i + 0.5 - w.x, j + 0.5 - w.z);
      if (d < bd) { bd = d; best = t; }
    }
    return best;
  }

  update(dt, ctx) {
    const S = this.map.size;
    const occs = new Map(); // the building map per owner (their own walls don't block them)
    const occOf = (w) => { const o = w.owner ?? null; if (!occs.has(o)) occs.set(o, this.occFn(o)); return occs.get(o); };
    const rocks = new Set(ctx.crystals);
    let mined = 0;
    this.strikes = [];
    this.assignRocks(ctx, rocks);
    for (let k = this.list.length - 1; k >= 0; k--) {
      const w = this.list[k];
      w.time += dt;
      if (w.dead) {
        w.deathT += dt / 0.8;
        if (w.deathT >= 1) { this.scene.remove(w.parts.root, w.parts.bar); this.list.splice(k, 1); continue; }
        this.sync(w, dt, ctx.camera);
        continue;
      }
      w.earning = 0;
      w.wait = Math.max(0, (w.wait || 0) - dt);
      if (w.order === 'hold') {
        if (!w.path.length) w.state = 'idle';
      } else {
        const rock = w.target; // set by assignRocks: its own rock, or -1 if none is free
        if (w.pathFor !== rock) { w.path = []; w.pathFor = rock; w.wait = 0; } // rock changed: re-route
        const rx = rock % S + 0.5, rz = ((rock / S) | 0) + 0.5;
        const hasQuarry = ctx.quarries.some((q) => (q.owner ?? null) === (w.owner ?? null)); // its owner's
        if (rock < 0 || !hasQuarry) { if (w.state === 'mine') w.state = 'idle'; if (!w.path.length) w.state = 'idle'; }
        else if (Math.hypot(rx - w.x, rz - w.z) < 1.6 && !w.path.length) {
          // Beside the rock: mine it. Crystals come in while the pick swings.
          if (w.state !== 'mine') { w.state = 'mine'; w.timer = QUARRY_WORKERS.mineTime; }
          w.targetYaw = Math.atan2(rx - w.x, rz - w.z);
          w.earning = this.rockRate(w, rock);
          mined += w.earning * dt;
          w.timer -= dt;
          if (w.timer <= 0) { w.timer += QUARRY_WORKERS.mineTime; this.strikes.push({ x: (w.x + rx) / 2, z: (w.z + rz) / 2, color: this.map.rareCrystals.has(rock) ? 0xffd75e : w.def.glow }); }
        } else {
          w.state = 'walk';
          if (!w.path.length && !w.wait) {
            const occ = occOf(w), goal = this.standTile(w, rock, occ);
            w.path = goal >= 0 ? findPath(this.map, occ, w.tile, goal) || [] : [];
            if (!w.path.length) w.wait = 1;
          }
        }
      }
      this.step(w, dt);
      this.sync(w, dt, ctx.camera);
    }
    return mined;
  }

  // Multiplayer client: walk each helper along the host's path, swing the pick while it mines,
  // play out deaths. (The host decides everything else.)
  clientUpdate(dt, camera) {
    for (let k = this.list.length - 1; k >= 0; k--) {
      const w = this.list[k];
      w.time += dt;
      if (w.dead) {
        w.deathT = (w.deathT || 0) + dt / 0.8;
        if (w.deathT >= 1) { this.scene.remove(w.parts.root, w.parts.bar); this.list.splice(k, 1); continue; }
      } else {
        if (w.state === 'mine') { w.timer -= dt; if (w.timer <= 0) w.timer += QUARRY_WORKERS.mineTime; }
        this.step(w, dt);
      }
      this.sync(w, dt, camera);
    }
  }
  drop(w) { this.scene.remove(w.parts.root, w.parts.bar); this.list.splice(this.list.indexOf(w), 1); }

  step(w, dt) {
    w.moving = false;
    if (!w.path.length) return;
    const S = this.map.size, t = w.path[0];
    const tx = t % S + 0.5, tz = ((t / S) | 0) + 0.5;
    const dx = tx - w.x, dz = tz - w.z, d = Math.hypot(dx, dz), stepLen = QUARRY_WORKERS.speed * dt;
    if (d > 1e-4) w.targetYaw = Math.atan2(dx, dz);
    if (d <= stepLen) { w.x = tx; w.z = tz; w.path.shift(); } else { w.x += (dx / d) * stepLen; w.z += (dz / d) * stepLen; }
    w.moving = true;
  }

  sync(w, dt, camera) {
    const p = w.parts, ease = Math.min(1, dt * 10);
    let diff = w.targetYaw - w.yaw;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    w.yaw += diff * Math.min(1, dt * 10);
    let sx = 0, sz = 0;
    if (w.shake > 0) { w.shake = Math.max(0, w.shake - dt); sx = (Math.random() - 0.5) * w.shake * 0.4; sz = (Math.random() - 0.5) * w.shake * 0.4; }
    const ground = this.map.heightAt(w.x, w.z), sink = w.dead ? w.deathT : 0;
    p.root.position.set(w.x + sx, ground - sink * 0.2, w.z + sz);
    p.root.rotation.y = w.yaw;
    p.root.rotation.z = sink * 1.1;
    p.root.scale.setScalar(w.size * Math.max(0.02, 1 - sink * 0.95));
    if (w.moving) w.walk += dt * 9;
    const sw = w.moving ? Math.sin(w.walk) : 0;
    p.legL.rotation.x += (sw * 0.6 - p.legL.rotation.x) * ease;
    p.legR.rotation.x += (-sw * 0.6 - p.legR.rotation.x) * ease;
    p.body.position.y = w.moving ? Math.abs(Math.cos(w.walk)) * 0.025 : 0;
    // Mining: the pick swings down at the rock, and a chunk of ore floats up over its head
    // for a moment after each mineTime of work.
    const mining = w.state === 'mine' && !w.dead;
    p.armR.rotation.x = mining ? -1.6 + Math.abs(Math.sin(w.time * 6)) * 1.9 : -0.3 + sw * 0.3;
    const lift = mining ? 1 - w.timer / QUARRY_WORKERS.mineTime : 1; // 0 just after a chunk comes loose
    p.chunk.visible = mining && lift < 0.35;
    p.armL.rotation.x = p.chunk.visible ? -2.4 : -sw * 0.4;
    p.chunk.rotation.y = w.time * 2;
    p.chunk.position.y = 0.6 + lift * 0.5;
    const r = w.hp / w.maxHp;
    p.bar.visible = !w.dead && r < 1 && p.root.visible && !!camera;
    if (p.bar.visible) {
      p.bar.position.set(w.x, ground + 0.85 * w.size, w.z);
      p.bar.quaternion.copy(camera.quaternion);
      p.fill.scale.x = Math.max(0.001, r);
      p.fill.material.color.setHex(r > 0.6 ? 0x6fd36f : r > 0.3 ? 0xe8c25a : 0xe0533d);
    }
  }
}
