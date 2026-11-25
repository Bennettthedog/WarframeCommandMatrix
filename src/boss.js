import * as THREE from 'three';
import { BOSS, BOSS_GLOW, LEVEL_HEIGHT } from './config.js';

// The Crystal Monarch: a towering purple crystal rooted in a dark rock base in the boss lair.
// It never moves. Very slow, heavy, single-target attack: it marks its target's spot with a
// glowing circle that fills over BOSS.windup seconds, then a cluster of crystal spikes erupts
// there. Only that target is hit, and only if it's still in the circle (so units can dodge;
// buildings can't). It fights the defenders only: the Sentinel, troops and buildings.
//
// update(dt, ctx): ctx = {
//   targets: [{ kind, ref }]  everything it could attack (ref has x, z, dead, and maybe sink),
//   hit(target, damage)        apply a spike hit,
//   camera                     for the health bar,
// }

const crystalMat = (intensity) => new THREE.MeshLambertMaterial({
  color: 0xc9a6ff, emissive: BOSS_GLOW, emissiveIntensity: intensity, flatShading: true,
});
const ROCK = new THREE.MeshLambertMaterial({ color: 0x2f2a33, flatShading: true });

function crystal(mat, r, h) {
  const m = new THREE.Mesh(new THREE.OctahedronGeometry(r, 0), mat);
  m.scale.set(1, h / (2 * r), 1);
  m.castShadow = true;
  return m;
}

export class Boss {
  constructor(map, scene) {
    const B = map.boss;
    this.map = map;
    this.scene = scene;
    this.name = BOSS.name;
    this.x = B.x; this.z = B.z;
    this.tile = B.lair;
    this.radius = BOSS.radius;
    this.aimHeight = 1.8;
    this.sink = 0;
    this.hp = this.maxHp = BOSS.hp;
    this.cooldown = 3;
    this.cast = null;     // { target, x, z, t } while winding up
    this.target = null;   // the ref it's fighting
    this.time = 0;
    this.flash = 0;
    this.spikes = [];
    // Dormant: not on the map yet (the lair stands empty) until spawn() is called.
    this.dormant = true;
    this.spawnT = 1;
    this.build();
    this.root.visible = false;
  }

  // Not dormant and not dead: it's in the fight.
  get active() { return !this.dormant && !this.dead; }

  // Wake up: it rises out of the lair over 2 seconds, then starts fighting.
  spawn() {
    this.dormant = false;
    this.spawnT = 0;
    this.cooldown = 3;
  }

  build() {
    const root = new THREE.Group();
    this.floor = this.map.level[this.tile] * LEVEL_HEIGHT; // the raised arena
    root.position.set(this.x, this.floor, this.z);
    // Dark rock base with crystals jutting out of it.
    const base = new THREE.Mesh(new THREE.DodecahedronGeometry(0.85, 0), ROCK);
    base.scale.set(1.35, 0.45, 1.35);
    base.position.y = 0.2;
    base.castShadow = base.receiveShadow = true;
    root.add(base);
    this.mat = crystalMat(0.55);
    this.ring = [];
    for (let k = 0; k < 7; k++) { // a crown of leaning crystals around the base
      const a = (k / 7) * Math.PI * 2, h = 0.7 + ((k * 37) % 5) * 0.18;
      const c = crystal(this.mat, 0.16, h);
      c.position.set(Math.cos(a) * 0.78, 0.35 + h * 0.35, Math.sin(a) * 0.78);
      c.rotation.set(Math.sin(a) * 0.45, 0, -Math.cos(a) * 0.45);
      root.add(c);
      this.ring.push(c);
    }
    // The great floating crystal, with an inner glow.
    this.core = new THREE.Group();
    this.core.position.y = 1.9;
    this.core.add(crystal(this.mat, 0.5, 2.6));
    const glow = new THREE.Mesh(new THREE.SphereGeometry(0.55, 14, 10), new THREE.MeshBasicMaterial({
      color: BOSS_GLOW, transparent: true, opacity: 0.22, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.core.add(glow);
    this.glow = glow;
    root.add(this.core);
    // Shards circling the crystal.
    this.shards = [0, 1, 2, 3].map(() => { const s = crystal(this.mat, 0.1, 0.42); root.add(s); return s; });
    this.scene.add(root);
    this.root = root;

    // Telegraph: a ring plus a filling disc at the marked spot.
    const R = BOSS.spikeRadius;
    this.tele = new THREE.Group();
    const ringMesh = new THREE.Mesh(new THREE.RingGeometry(R - 0.08, R, 32),
      new THREE.MeshBasicMaterial({ color: 0xc9a6ff, transparent: true, opacity: 0.85, depthWrite: false }));
    const disc = new THREE.Mesh(new THREE.CircleGeometry(R, 32),
      new THREE.MeshBasicMaterial({ color: BOSS_GLOW, transparent: true, opacity: 0.35, depthWrite: false }));
    ringMesh.rotation.x = disc.rotation.x = -Math.PI / 2;
    this.tele.add(ringMesh, disc);
    this.teleDisc = disc;
    this.tele.visible = false;
    this.scene.add(this.tele);

    // Health bar.
    const w = 1.6, bar = new THREE.Group();
    const back = new THREE.Mesh(new THREE.PlaneGeometry(w + 0.06, 0.18), new THREE.MeshBasicMaterial({ color: 0x111418, depthTest: false }));
    const fillGeo = new THREE.PlaneGeometry(w, 0.12);
    fillGeo.translate(w / 2, 0, 0);
    this.fill = new THREE.Mesh(fillGeo, new THREE.MeshBasicMaterial({ color: 0xb48cff, depthTest: false }));
    this.fill.position.set(-w / 2, 0, 0.001);
    back.renderOrder = 10; this.fill.renderOrder = 11;
    bar.add(back, this.fill);
    bar.position.set(this.x, this.floor + 3.9, this.z);
    bar.visible = false;
    this.scene.add(bar);
    this.bar = bar;
  }

  // Shown while its side can see it (and its spikes/telegraph with it).
  // v: whether it shows at all (once explored, like a landmark). live: whether its fight shows
  // (the wind-up circle and spikes), only while it's actually in sight.
  setVisible(v, live = v) {
    this.shown = v && !this.dormant;
    this.root.visible = this.shown;
    this.live = this.shown && live;
    for (const s of this.spikes) s.mesh.visible = this.live;
    if (!this.live) this.tele.visible = false;
  }

  // Damage it; returns how much was dealt.
  damage(amount) {
    if (this.dead) return 0;
    const dealt = Math.min(this.hp, amount);
    this.hp -= dealt;
    this.flash = 0.2;
    if (this.hp <= 0) this.die();
    return dealt;
  }

  die() {
    this.dead = true;
    this.deathT = 0;
    this.cast = null;
    this.tele.visible = false;
  }

  revive() {
    if (this.dormant) { this.spawn(); return; }
    this.dead = false;
    this.hp = this.maxHp;
    this.cooldown = 3;
    this.core.position.y = 1.9;
    this.core.rotation.set(0, 0, 0);
    this.core.scale.setScalar(1);
    this.mat.emissiveIntensity = 0.55;
    for (const s of this.shards) s.visible = true;
  }

  // Is this target alive and in reach?
  inReach(t) {
    const r = t.ref;
    return r && !r.dead && !(r.sink > 0) && Math.hypot(r.x - this.x, r.z - this.z) <= BOSS.range;
  }

  update(dt, ctx) {
    if (this.dormant) return;
    this.time += dt;
    this.updateSpikes(dt);
    if (this.dead) { this.animateDeath(dt); return; }
    if (this.spawnT < 1) { // rising out of the lair: it doesn't attack yet
      this.spawnT = Math.min(1, this.spawnT + dt / 2);
      const k = 1 - (1 - this.spawnT) ** 3;
      this.root.scale.setScalar(Math.max(0.01, k));
      this.root.position.y = this.floor - (1 - k) * 1.5;
      this.animate(dt, ctx.camera);
      return;
    }

    this.cooldown -= dt;
    if (this.cast) {
      this.cast.t += dt;
      const k = Math.min(1, this.cast.t / BOSS.windup);
      this.tele.visible = this.live;
      this.tele.position.set(this.cast.x, this.map.heightAt(this.cast.x, this.cast.z) + 0.04, this.cast.z);
      this.teleDisc.scale.setScalar(Math.max(0.01, k));
      if (k >= 1) {
        // Erupt: hits only its target, and only if it's still inside the circle.
        const r = this.cast.target.ref;
        this.spawnSpike(this.cast.x, this.cast.z);
        if (!r.dead && !(r.sink > 0) && Math.hypot(r.x - this.cast.x, r.z - this.cast.z) <= BOSS.spikeRadius) {
          ctx.hit(this.cast.target, this.cast.target.kind === 'building' ? BOSS.buildingDamage : BOSS.damage);
        }
        this.cast = null;
        this.tele.visible = false;
        this.cooldown = BOSS.cooldown;
      }
    } else if (this.cooldown <= 0) {
      // Keep its current target while it's in reach; otherwise the nearest one.
      let t = this.target && ctx.targets.find((x) => x.ref === this.target && this.inReach(x));
      if (!t) {
        let best = Infinity;
        for (const x of ctx.targets) {
          if (!this.inReach(x)) continue;
          const d = Math.hypot(x.ref.x - this.x, x.ref.z - this.z);
          if (d < best) { best = d; t = x; }
        }
      }
      this.target = t ? t.ref : null;
      if (t) this.cast = { target: t, x: t.ref.x, z: t.ref.z, t: 0 };
    }
    this.animate(dt, ctx.camera);
  }

  // Multiplayer client: the host sends its state (dormant, spawnT, dead, hp, cast); this only
  // animates it: rising out of the lair, the wind-up circle, spikes, death.
  clientUpdate(dt, camera) {
    if (this.dormant) return;
    this.time += dt;
    this.updateSpikes(dt);
    if (this.dead) { this.animateDeath(dt); return; }
    if (this.spawnT < 1) {
      const k = 1 - (1 - this.spawnT) ** 3;
      this.root.scale.setScalar(Math.max(0.01, k));
      this.root.position.y = this.floor - (1 - k) * 1.5;
    } else { this.root.scale.setScalar(1); this.root.position.y = this.floor; }
    if (this.cast) {
      this.cast.t += dt;
      const k = Math.min(1, this.cast.t / BOSS.windup);
      this.tele.visible = this.live;
      this.tele.position.set(this.cast.x, this.map.heightAt(this.cast.x, this.cast.z) + 0.04, this.cast.z);
      this.teleDisc.scale.setScalar(Math.max(0.01, k));
    } else this.tele.visible = false;
    this.animate(dt, camera);
  }

  // Idle: the crystal bobs and turns, shards circle. Winding up: everything speeds up and glows.
  animate(dt, camera) {
    const t = this.time, wind = this.cast ? Math.min(1, this.cast.t / BOSS.windup) : 0;
    this.core.position.y = 1.9 + Math.sin(t * 1.3) * 0.08 + wind * 0.25;
    this.core.rotation.y += dt * (0.4 + wind * 4);
    const glowK = 0.55 + Math.sin(t * 2) * 0.1 + wind * 1.2 + this.flash * 3;
    this.mat.emissiveIntensity = glowK;
    this.glow.material.opacity = 0.18 + wind * 0.35 + this.flash;
    this.glow.scale.setScalar(1 + wind * 0.5);
    this.flash = Math.max(0, this.flash - dt);
    const spin = t * (0.8 + wind * 3);
    this.shards.forEach((s, k) => {
      const a = spin + (k / this.shards.length) * Math.PI * 2;
      s.position.set(Math.cos(a) * 1.25, 2.1 + Math.sin(t * 2 + k) * 0.15, Math.sin(a) * 1.25);
      s.rotation.y = a * 2;
    });
    // Health bar while hurt.
    const r = this.hp / this.maxHp;
    this.bar.visible = this.shown && r < 1 && !!camera;
    if (this.bar.visible) {
      this.bar.quaternion.copy(camera.quaternion);
      this.fill.scale.x = Math.max(0.001, r);
    }
  }

  // Shattered: the great crystal topples and sinks, the shards drop, the light goes out.
  animateDeath(dt) {
    this.deathT = Math.min(1, this.deathT + dt / 1.5);
    const k = this.deathT;
    this.core.position.y = 1.9 - k * 1.6;
    this.core.rotation.z = k * 1.3;
    this.core.scale.setScalar(1 - k * 0.5);
    this.mat.emissiveIntensity = 0.55 * (1 - k);
    this.glow.material.opacity = 0.22 * (1 - k);
    this.shards.forEach((s) => { s.position.y = Math.max(0.1, s.position.y - dt * 4); if (k >= 1) s.visible = false; });
    this.bar.visible = false;
  }

  // A cluster of crystal spikes bursting up from the ground, then sinking back.
  spawnSpike(x, z) {
    const g = new THREE.Group();
    const mat = crystalMat(1.2);
    for (let k = 0; k < 5; k++) {
      const h = k === 0 ? 2.4 : 1.1 + Math.random() * 0.8;
      const c = crystal(mat, k === 0 ? 0.28 : 0.15, h);
      const a = (k / 4) * Math.PI * 2, r = k === 0 ? 0 : 0.35 + Math.random() * 0.2;
      c.position.set(Math.cos(a) * r, h * 0.4, Math.sin(a) * r);
      c.rotation.set(Math.sin(a) * r * 0.9, 0, -Math.cos(a) * r * 0.9);
      g.add(c);
    }
    const y = this.map.heightAt(x, z);
    g.position.set(x, y - 2.5, z);
    g.visible = this.live;
    this.scene.add(g);
    this.spikes.push({ mesh: g, y, t: 0, mat });
  }

  updateSpikes(dt) {
    for (let k = this.spikes.length - 1; k >= 0; k--) {
      const s = this.spikes[k];
      s.t += dt;
      // Up fast (0.12 s), hold, then sink (0.5 s) and fade.
      const up = Math.min(1, s.t / 0.12), down = Math.max(0, (s.t - 0.9) / 0.5);
      s.mesh.position.y = s.y - 2.5 * (1 - up) - 2.5 * down;
      s.mat.emissiveIntensity = 1.2 * (1 - down);
      if (down >= 1) { this.scene.remove(s.mesh); this.spikes.splice(k, 1); }
    }
  }
}
