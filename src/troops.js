import * as THREE from 'three';
import { TROOPS } from './config.js';
import { findPath, isWalkable } from './pathfinding.js';
import { lineOfSight } from './vision.js';
import { BoulderShots } from './effects.js';

// Defender troops summoned at a Barracks: the Pebble Golem (cheap melee) and the Shard
// Slinger (ranged). Both are small earth elementals in the team color, like the Sentinel.
//
// Orders (mode):
//   idle   - standing at its spot (home). Goes after the Colossus by itself if it comes
//            within TROOPS.acquireRange and the defenders can see it ("engage").
//   move   - walking to a spot; ignores the Colossus on the way. The spot becomes its home.
//   attack - ordered to attack the Colossus: chases it while the defenders can see it.
//   engage - fighting the Colossus by itself; gives up once TROOPS.leash tiles from home.
//   return - walking back home after a fight.

const COLOSSUS_RADIUS = 0.7; // ranges are measured from the Colossus's edge

const lambert = (color, extra = {}) => new THREE.MeshLambertMaterial({ color, flatShading: true, ...extra });
const STONE_MAT = lambert(0x857d70), DARK_MAT = lambert(0x5c564e);

function rock(parent, r, mat, x, y, z, sx = 1, sy = 1, sz = 1, seed = 0) {
  const m = new THREE.Mesh(seed % 2 ? new THREE.DodecahedronGeometry(r, 0) : new THREE.IcosahedronGeometry(r, 0), mat);
  m.position.set(x, y, z);
  m.scale.set(sx, sy, sz);
  m.rotation.set(seed * 0.7, seed * 1.3, seed * 0.4);
  m.castShadow = true;
  parent.add(m);
  return m;
}

// cfg.model picks the shape ('pebble' or 'slinger'); cfg.stone / dark / glow recolor it
// (the late troops: quartz Lancers, quartz-and-gold Wardens).
function buildModel(type, team) {
  const cfg = TROOPS[type];
  const glowColor = cfg.glow !== undefined ? new THREE.Color(cfg.glow) : team;
  const STONE = cfg.stone !== undefined ? lambert(cfg.stone) : STONE_MAT, DARK = cfg.dark !== undefined ? lambert(cfg.dark) : DARK_MAT;
  type = cfg.model || type;
  const energy = lambert(glowColor.clone().lerp(new THREE.Color(0xffffff), 0.35), { emissive: glowColor, emissiveIntensity: 0.9 });
  const eyeMat = new THREE.MeshBasicMaterial({ color: glowColor.clone().lerp(new THREE.Color(0xffffff), 0.6) });
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const limb = (x, y) => { const p = new THREE.Group(); p.position.set(x, y, 0); body.add(p); return p; };
  const eyes = (y, z) => {
    for (const x of [-0.035, 0.035]) {
      const e = new THREE.Mesh(new THREE.SphereGeometry(0.018, 6, 5), eyeMat);
      e.position.set(x, y, z);
      body.add(e);
    }
  };
  let armL, armR, legL, legR, shard = null;

  if (type === 'pebble') {
    // A squat little golem: round boulder body, glowing core, big fists.
    rock(body, 0.2, STONE, 0, 0.34, 0, 1.15, 0.95, 1.0, 1);
    rock(body, 0.09, DARK, 0, 0.56, 0.05, 1.1, 0.9, 1, 2);
    eyes(0.57, 0.13);
    const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.06, 0), energy);
    core.position.set(0, 0.36, 0.19);
    body.add(core);
    armL = limb(-0.24, 0.44); armR = limb(0.24, 0.44);
    for (const a of [armL, armR]) rock(a, 0.1, DARK, 0, -0.16, 0.02, 1.1, 1.15, 1.1, 3);
    legL = limb(-0.1, 0.16); legR = limb(0.1, 0.16);
    for (const l of [legL, legR]) rock(l, 0.07, DARK, 0, -0.08, 0, 1, 0.9, 1.2, 4);
  } else {
    // A slim figure of stacked stones with a crystal crest; a floating shard by its hand.
    const upright = (m) => m.rotation.set(0, m.rotation.y, 0); // stretched pieces stay upright
    upright(rock(body, 0.13, STONE, 0, 0.42, 0, 0.95, 1.45, 0.8, 1));
    rock(body, 0.08, DARK, 0, 0.66, 0.02, 1, 1, 1, 2);
    eyes(0.67, 0.08);
    for (const [x, y, rz] of [[0, 0.78, 0], [-0.05, 0.74, 0.5], [0.05, 0.74, -0.5]]) {
      const c = new THREE.Mesh(new THREE.OctahedronGeometry(0.035, 0), energy);
      c.position.set(x, y, -0.02); c.scale.set(0.7, 1.8, 0.7); c.rotation.z = rz;
      body.add(c);
    }
    armL = limb(-0.15, 0.52); armR = limb(0.15, 0.52);
    for (const a of [armL, armR]) upright(rock(a, 0.05, DARK, 0, -0.14, 0, 1, 2.2, 1, 3));
    legL = limb(-0.07, 0.24); legR = limb(0.07, 0.24);
    for (const l of [legL, legR]) upright(rock(l, 0.055, DARK, 0, -0.12, 0, 1, 2.3, 1, 4));
    shard = new THREE.Mesh(new THREE.OctahedronGeometry(0.07, 0), energy);
    shard.scale.set(0.6, 1.5, 0.6);
    body.add(shard);
  }

  // Team glow on the ground, the selection ring, and a small health bar.
  const glow = new THREE.Mesh(new THREE.CircleGeometry(0.22, 16),
    new THREE.MeshBasicMaterial({ color: team, transparent: true, opacity: 0.18, depthWrite: false }));
  glow.rotation.x = -Math.PI / 2; glow.position.y = 0.02;
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.27, 0.33, 24),
    new THREE.MeshBasicMaterial({ color: team, transparent: true, opacity: 0.8, depthWrite: false }));
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.03; ring.visible = false;
  root.add(glow, ring);

  const w = 0.5, bar = new THREE.Group();
  const back = new THREE.Mesh(new THREE.PlaneGeometry(w + 0.04, 0.1), new THREE.MeshBasicMaterial({ color: 0x111418, depthTest: false }));
  const fillGeo = new THREE.PlaneGeometry(w, 0.06);
  fillGeo.translate(w / 2, 0, 0);
  const fill = new THREE.Mesh(fillGeo, new THREE.MeshBasicMaterial({ color: 0x6fd36f, depthTest: false }));
  fill.position.set(-w / 2, 0, 0.001);
  back.renderOrder = 10; fill.renderOrder = 11;
  bar.add(back, fill);
  bar.visible = false;

  return { root, body, armL, armR, legL, legR, shard, ring, bar, fill };
}

let nextId = 1;
class Troop {
  constructor(type, x, z, map, scene, team) {
    this.id = nextId++;
    this.type = type;
    this.cfg = TROOPS[type];
    this.name = this.cfg.name;
    this.map = map;
    this.x = x; this.z = z;
    this.homeX = x; this.homeZ = z;
    this.path = [];
    this.mode = 'idle';
    this.hp = this.maxHp = this.cfg.hp;
    this.size = this.cfg.scale || 1;
    this.life = this.cfg.lifetime || 0; // seconds left before it crumbles (0 = lasts forever)
    this.cooldown = 0;
    this.repath = 0;
    this.yaw = 0; this.targetYaw = 0;
    this.walkPhase = Math.random() * 6;
    this.swing = 0;
    this.time = Math.random() * 10;
    this.parts = buildModel(type, team);
    scene.add(this.parts.root, this.parts.bar);
  }

  get tile() { return this.map.tileAt(this.x, this.z); }
  get ranged() { return !!this.cfg.flight; }
}

export class Troops {
  // occFn(): the building map as troops see it (they know their own side's map, and their
  // own walls don't block them). Read once per frame and cached. team: team color.
  constructor(map, scene, occFn, teamColor) {
    this.map = map;
    this.scene = scene;
    this.occFn = occFn;
    this.occCache = null;
    this.team = new THREE.Color(teamColor);
    this.list = [];
    // Thrown crystal shards: the boulder arcs, with a glowing team-colored shard instead.
    this.shots = new BoulderShots(scene);
    this.shots.geo = new THREE.OctahedronGeometry(0.1, 0);
    this.shots.mat = lambert(this.team.clone().lerp(new THREE.Color(0xffffff), 0.4), { emissive: this.team, emissiveIntensity: 1 });
  }

  // The building map as this troop sees it: its own owner's walls don't block it (cached per
  // owner each frame). occFor(null): every wall blocks.
  occFor(u) {
    const owner = u ? u.owner ?? null : null;
    this.occCache ||= new Map();
    if (!this.occCache.has(owner)) this.occCache.set(owner, this.occFn(owner));
    return this.occCache.get(owner);
  }

  get alive() { return this.list.filter((t) => !t.dead); }

  // owner/color: whose troop it is and its team color (the manager's color if not given).
  spawn(type, x, z, owner = null, color = null) {
    const t = new Troop(type, x, z, this.map, this.scene, color !== null ? new THREE.Color(color) : this.team);
    t.owner = owner;
    this.list.push(t);
    this.sync(t, 0);
    return t;
  }

  // A free walkable tile next to these tiles (e.g. a Barracks), on the same level as them
  // (never below a cliff or on a ramp), preferring one no troop stands on.
  spawnTile(tiles) {
    const S = this.map.size, taken = new Set(this.alive.map((t) => t.tile));
    const level = this.map.level[tiles[0]];
    const seen = new Set(tiles), queue = [...tiles];
    let fallback = -1;
    for (let k = 0; k < queue.length && k < 400; k++) {
      const cur = queue[k], ci = cur % S, cj = (cur / S) | 0;
      for (const [dx, dz] of [[0, 1], [1, 0], [0, -1], [-1, 0], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
        const i = ci + dx, j = cj + dz, nb = j * S + i;
        if (!this.map.inBounds(i, j) || seen.has(nb)) continue;
        seen.add(nb);
        if (!isWalkable(this.map, this.occFor(null), nb) || this.map.level[nb] !== level || this.map.ramp[nb] >= 0) continue;
        if (!taken.has(nb)) return nb;
        if (fallback < 0) fallback = nb;
        queue.push(nb);
      }
    }
    return fallback;
  }

  // n walkable tiles around a goal, connected to it (a loose formation).
  formation(goal, n) {
    const { map, occ } = this, S = map.size;
    let start = goal;
    if (!isWalkable(map, occ, start)) {
      start = -1;
      let best = Infinity;
      const gi = goal % S, gj = (goal / S) | 0;
      for (let dj = -4; dj <= 4; dj++) for (let di = -4; di <= 4; di++) {
        const i = gi + di, j = gj + dj, t = j * S + i;
        if (map.inBounds(i, j) && isWalkable(map, occ, t) && di * di + dj * dj < best) { best = di * di + dj * dj; start = t; }
      }
      if (start < 0) return [];
    }
    const out = [], seen = new Set([start]), queue = [start];
    for (let k = 0; k < queue.length && out.length < n; k++) {
      const cur = queue[k];
      out.push(cur);
      const ci = cur % S, cj = (cur / S) | 0;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
        const i = ci + dx, j = cj + dz, nb = j * S + i;
        if (!map.inBounds(i, j) || seen.has(nb)) continue;
        seen.add(nb);
        if (isWalkable(map, occ, nb) && map.canStep(cur, nb)) queue.push(nb);
      }
    }
    return out;
  }

  // Send these troops to a spot, spread out around it. Returns how many could get there.
  orderMove(units, tile) {
    units = units.filter((u) => !u.dead);
    if (!units.length || tile < 0) return 0;
    const S = this.map.size, slots = this.formation(tile, units.length);
    const gx = tile % S + 0.5, gz = ((tile / S) | 0) + 0.5;
    units.sort((a, b) => Math.hypot(a.x - gx, a.z - gz) - Math.hypot(b.x - gx, b.z - gz));
    let ok = 0;
    for (const u of units) {
      if (!slots.length) break;
      // The free slot closest to this unit.
      let bi = 0, bd = Infinity;
      slots.forEach((s, k) => { const d = Math.hypot(s % S + 0.5 - u.x, ((s / S) | 0) + 0.5 - u.z); if (d < bd) { bd = d; bi = k; } });
      const slot = slots.splice(bi, 1)[0];
      const path = findPath(this.map, this.occFor(u), u.tile, slot);
      if (!path) continue;
      u.path = path;
      u.mode = 'move';
      u.foe = null;
      u.homeX = slot % S + 0.5; u.homeZ = ((slot / S) | 0) + 0.5;
      ok++;
    }
    return ok;
  }

  // Attack the Colossus, or the given foe (the boss): chase it while it can be seen.
  orderAttack(units, foe = null) {
    for (const u of units) if (!u.dead) { u.mode = 'attack'; u.repath = 0; u.foe = foe; }
  }

  // Stop: stand where they are (that becomes home).
  stop(units) {
    for (const u of units) {
      if (u.dead) continue;
      u.path = []; u.mode = 'idle'; u.homeX = u.x; u.homeZ = u.z; u.foe = null;
    }
  }

  // Deal damage; returns how much was actually dealt.
  damage(u, amount) {
    if (u.dead) return 0;
    const dealt = Math.min(u.hp, amount);
    u.hp -= dealt;
    u.shake = 0.3;
    if (u.hp <= 0) { u.dead = true; u.deathT = 0; u.path = []; u.parts.ring.visible = false; u.parts.bar.visible = false; }
    return dealt;
  }

  setSelected(u, on) { u.selected = on; u.parts.ring.visible = on && !u.dead; }

  // ctx: { colossus, seesColossus, camera, onStrike(troop, damage) }
  update(dt, ctx) {
    this.occCache = null; // buildings may have changed since last frame
    const c = ctx.colossus;
    for (let k = this.list.length - 1; k >= 0; k--) {
      const u = this.list[k];
      u.time += dt;
      if (u.dead) {
        u.deathT += dt / 0.8;
        if (u.deathT >= 1) {
          this.scene.remove(u.parts.root, u.parts.bar);
          this.list.splice(k, 1);
          continue;
        }
        this.sync(u, dt);
        continue;
      }
      u.cooldown = Math.max(0, u.cooldown - dt);
      // Troops with a lifetime (the Titan Warden) crumble when it runs out.
      if (u.cfg.lifetime) {
        u.life -= dt;
        if (u.life <= 0) { this.damage(u, u.hp); u.expired = true; ctx.onExpire?.(u); this.sync(u, dt); continue; }
      }
      // Its foe: the boss if ordered to attack it, otherwise the Colossus.
      const foe = u.foe || c;
      // What its own side can see (each defender has their own sight).
      const sees = u.foe ? (ctx.seesFoe ? ctx.seesFoe(u.foe, u) : true) : (ctx.seesColossusFor ? ctx.seesColossusFor(u) : ctx.seesColossus);
      const canFight = !foe.dead && sees;
      const dist = foe.dead ? Infinity : Math.hypot(foe.x - u.x, foe.z - u.z);
      if (!canFight && (u.mode === 'attack' || u.mode === 'engage')) this.endFight(u);
      else if (canFight && u.mode === 'idle' && dist <= TROOPS.acquireRange && !(u.calm > 0)) u.mode = 'engage';
      u.calm = Math.max(0, (u.calm || 0) - dt);
      if (u.mode === 'engage' && Math.hypot(u.x - u.homeX, u.z - u.homeZ) > TROOPS.leash) this.endFight(u);

      if (u.mode === 'attack' || u.mode === 'engage') this.fight(u, dt, foe, dist, ctx);
      else if ((u.mode === 'move' || u.mode === 'return') && !u.path.length) u.mode = 'idle';

      this.step(u, dt);
    }
    this.separate();
    this.shots.update(dt);
    for (const u of this.list) this.sync(u, dt, ctx.camera);
  }

  // Multiplayer client: no fighting or orders here (the host decides), just walk each troop along
  // the path the host sent, animate it, and play out deaths.
  clientUpdate(dt, camera) {
    for (let k = this.list.length - 1; k >= 0; k--) {
      const u = this.list[k];
      u.time += dt;
      if (u.dead) {
        u.deathT = (u.deathT || 0) + dt / 0.8;
        if (u.deathT >= 1) { this.scene.remove(u.parts.root, u.parts.bar); this.list.splice(k, 1); continue; }
      } else {
        u.cooldown = Math.max(0, u.cooldown - dt);
        if (u.cfg.lifetime) u.life = Math.max(0, u.life - dt);
        this.step(u, dt);
      }
      this.sync(u, dt, camera);
    }
    this.shots.update(dt);
  }
  // Remove one at once (it left the host's list).
  drop(u) { this.scene.remove(u.parts.root, u.parts.bar); this.list.splice(this.list.indexOf(u), 1); }

  endFight(u) {
    u.foe = null;
    if (u.mode === 'engage') { // go back to its spot (and don't re-engage straight away)
      u.mode = 'return';
      u.calm = 4;
      u.path = findPath(this.map, this.occFor(u), u.tile, this.map.tileAt(u.homeX, u.homeZ)) || [];
    } else { // an ordered attack ends where it is
      u.mode = 'idle'; u.path = []; u.homeX = u.x; u.homeZ = u.z;
    }
  }

  // c: the foe (the Colossus, or the boss; its radius and aimHeight if it has them).
  fight(u, dt, c, dist, ctx) {
    const map = this.map, cfg = u.cfg;
    const size = c.radius ?? COLOSSUS_RADIUS, aim = c.aimHeight ?? 1.1;
    const reach = cfg.range + size;
    // Melee: within one level, like the Colossus. Ranged: line of sight (can throw down a cliff).
    const canHit = dist <= reach && (u.ranged
      ? lineOfSight(map, u.x, u.z, c.x, c.z)
      : Math.abs(map.level[c.tile] - map.level[u.tile]) <= 1);
    if (canHit) {
      u.path = [];
      u.targetYaw = Math.atan2(c.x - u.x, c.z - u.z);
      if (u.cooldown <= 0) {
        u.cooldown = 1 / cfg.rate;
        u.swing = 1e-6;
        if (u.ranged) {
          const h = map.heightAt(u.x, u.z);
          this.shots.fire({ x: u.x, y: h + 0.75, z: u.z },
            () => ({ x: c.x, y: map.heightAt(c.x, c.z) + aim, z: c.z }), cfg.flight, { u, damage: cfg.damage },
            (shot) => { if (!c.dead) ctx.onStrike(shot.data.u, shot.data.damage, true, c); }, 1);
        } else {
          ctx.onStrike(u, cfg.damage, false, c);
        }
      }
      return;
    }
    // Get closer: melee units spread around the Colossus; ranged ones stop short of it.
    u.repath -= dt;
    if (u.repath > 0 && u.path.length) return;
    u.repath = 0.5;
    let gx, gz;
    if (u.ranged && dist > reach) {
      const f = Math.max(0, (dist - cfg.range * 0.7) / dist);
      gx = u.x + (c.x - u.x) * f; gz = u.z + (c.z - u.z) * f;
    } else {
      const a = u.id * 2.4;
      gx = c.x + Math.cos(a) * (size + 0.3); gz = c.z + Math.sin(a) * (size + 0.3);
    }
    let goal = map.tileAt(gx, gz);
    let path = goal >= 0 ? findPath(map, this.occFor(u), u.tile, goal) : null;
    if (!path) path = findPath(map, this.occFor(u), u.tile, c.tile);
    u.path = path || [];
  }

  // Walk along the path.
  step(u, dt) {
    u.moving = false;
    if (!u.path.length) return;
    const S = this.map.size, t = u.path[0];
    const tx = t % S + 0.5, tz = ((t / S) | 0) + 0.5;
    const dx = tx - u.x, dz = tz - u.z, d = Math.hypot(dx, dz), stepLen = u.cfg.speed * dt;
    if (d > 1e-4) u.targetYaw = Math.atan2(dx, dz);
    if (d <= stepLen) { u.x = tx; u.z = tz; u.path.shift(); } else { u.x += (dx / d) * stepLen; u.z += (dz / d) * stepLen; }
    u.moving = true;
  }

  // Standing troops nudge apart so they don't stack on one spot.
  separate() {
    const live = this.list.filter((u) => !u.dead && !u.path.length);
    for (let a = 0; a < live.length; a++) {
      for (let b = a + 1; b < live.length; b++) {
        const u = live[a], v = live[b];
        let dx = v.x - u.x, dz = v.z - u.z, d = Math.hypot(dx, dz);
        if (d >= 0.42) continue;
        if (d < 1e-3) { dx = Math.cos(u.id); dz = Math.sin(u.id); d = 1; }
        const push = (0.42 - d) * 0.25;
        this.nudge(u, -dx / d * push, -dz / d * push);
        this.nudge(v, dx / d * push, dz / d * push);
      }
    }
  }

  nudge(u, dx, dz) {
    const from = u.tile, to = this.map.tileAt(u.x + dx, u.z + dz);
    if (to < 0) return;
    if (to !== from && (!isWalkable(this.map, this.occFor(u), to) || !this.map.canStep(from, to))) return;
    u.x += dx; u.z += dz;
  }

  // Place and animate the model.
  sync(u, dt, camera) {
    const p = u.parts, ease = Math.min(1, dt * 10);
    let diff = u.targetYaw - u.yaw;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    u.yaw += diff * Math.min(1, dt * 12);
    let sx = 0, sz = 0;
    if (u.shake > 0) {
      u.shake = Math.max(0, u.shake - dt);
      sx = (Math.random() - 0.5) * u.shake * 0.4; sz = (Math.random() - 0.5) * u.shake * 0.4;
    }
    const ground = this.map.heightAt(u.x, u.z);
    const sink = u.dead ? u.deathT : 0;
    // A troop near the end of its lifetime trembles (last 5 s), harder as it runs out.
    if (u.cfg.lifetime && !u.dead && u.life < 5) {
      const k = (1 - u.life / 5) * 0.06 * u.size;
      sx += (Math.random() - 0.5) * k; sz += (Math.random() - 0.5) * k;
    }
    p.root.position.set(u.x + sx, ground - sink * 0.25, u.z + sz);
    p.root.rotation.y = u.yaw;
    p.root.rotation.z = sink * 1.1;
    p.root.scale.setScalar(u.size * Math.max(0.02, 1 - sink * 0.95));

    // Walk cycle, and an attack: a punch (golem) or a throw (slinger).
    if (u.moving) u.walkPhase += dt * u.cfg.speed * 3.4;
    const sw = u.moving ? Math.sin(u.walkPhase) : 0;
    p.legL.rotation.x += (sw * 0.6 - p.legL.rotation.x) * ease;
    p.legR.rotation.x += (-sw * 0.6 - p.legR.rotation.x) * ease;
    p.body.position.y = u.moving ? Math.abs(Math.cos(u.walkPhase)) * 0.03 : Math.sin(u.time * 2.4) * 0.006;
    let punch = 0;
    if (u.swing) {
      u.swing = Math.min(1, u.swing + dt / 0.35);
      punch = Math.sin(u.swing * Math.PI);
      if (u.swing >= 1) u.swing = 0;
    }
    if (u.ranged) {
      p.armL.rotation.x += (-sw * 0.4 - p.armL.rotation.x) * ease;
      p.armR.rotation.x = -0.3 - punch * 2.2 + sw * 0.3;
      // The shard floats by its hand, regrowing after each throw.
      const ready = 1 - Math.min(1, u.cooldown / (0.6 / u.cfg.rate));
      p.shard.visible = !u.dead && ready > 0.05 && !u.swing;
      p.shard.scale.set(0.6 * ready, 1.5 * ready, 0.6 * ready);
      p.shard.position.set(0.2, 0.62 + Math.sin(u.time * 3) * 0.03, 0.12);
      p.shard.rotation.y = u.time * 3;
    } else {
      p.armL.rotation.x += (-sw * 0.5 - punch * 1.6 - p.armL.rotation.x) * Math.max(ease, punch ? 1 : 0);
      p.armR.rotation.x += (sw * 0.5 - punch * 1.6 - p.armR.rotation.x) * Math.max(ease, punch ? 1 : 0);
      p.body.rotation.x = punch * 0.25;
    }

    // Health bar once hurt.
    const r = u.hp / u.maxHp;
    p.bar.visible = !u.dead && r < 1 && p.root.visible && !!camera;
    if (p.bar.visible) {
      p.bar.position.set(u.x, ground + (u.ranged ? 1.0 : 0.85) * u.size, u.z);
      p.bar.quaternion.copy(camera.quaternion);
      p.fill.scale.x = Math.max(0.001, r);
      p.fill.material.color.setHex(r > 0.6 ? 0x6fd36f : r > 0.3 ? 0xe8c25a : 0xe0533d);
    }
  }
}
