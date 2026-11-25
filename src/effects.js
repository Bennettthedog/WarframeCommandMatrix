import * as THREE from 'three';

// Repair energy: glowing motes stream in an arc from the repairer to its target, and motes
// rise off every building being mended (all the connected wall pieces, for walls).
const BEAM_MOTES = 26, RISE_MOTES = 60;
export class RepairFx {
  constructor(scene, color) {
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false });
    const make = (n, size) => {
      const m = new THREE.InstancedMesh(new THREE.OctahedronGeometry(size, 0), mat, n);
      m.frustumCulled = false;
      m.count = 0;
      scene.add(m);
      return m;
    };
    this.beam = make(BEAM_MOTES, 0.07);
    this.rise = make(RISE_MOTES, 0.05);
    this.risers = []; // { x, y, z, age, life }
    this.time = 0;
    this.spawn = 0;
    this.m = new THREE.Matrix4();
    this.q = new THREE.Quaternion();
    this.p = new THREE.Vector3();
    this.s = new THREE.Vector3();
  }

  // active: whether repairing right now. from/to: {x, y, z}. spots: [{x, y, z}] on the buildings being repaired.
  update(dt, active, from, to, spots) {
    this.time += dt;
    const { m, q, p, s } = this;
    if (active) {
      // The stream: motes ride a raised arc, each at its own phase, swelling mid-flight.
      const mid = { x: (from.x + to.x) / 2, y: Math.max(from.y, to.y) + 0.8, z: (from.z + to.z) / 2 };
      for (let k = 0; k < BEAM_MOTES; k++) {
        const f = (this.time * 0.9 + k / BEAM_MOTES) % 1, g = 1 - f;
        p.set(g * g * from.x + 2 * g * f * mid.x + f * f * to.x,
          g * g * from.y + 2 * g * f * mid.y + f * f * to.y + Math.sin(this.time * 9 + k) * 0.04,
          g * g * from.z + 2 * g * f * mid.z + f * f * to.z);
        s.setScalar(0.6 + Math.sin(f * Math.PI) * 0.8);
        q.setFromEuler(new THREE.Euler(this.time * 3 + k, this.time * 2, 0));
        this.beam.setMatrixAt(k, m.compose(p, q, s));
      }
      this.beam.count = BEAM_MOTES;
      // Rising motes on the repaired buildings.
      this.spawn += dt * Math.min(40, 8 + spots.length * 2);
      while (this.spawn >= 1 && spots.length) {
        this.spawn -= 1;
        if (this.risers.length >= RISE_MOTES) break;
        const sp = spots[Math.floor(Math.random() * spots.length)];
        this.risers.push({ x: sp.x + (Math.random() - 0.5) * 0.7, y: sp.y + Math.random() * 0.3,
          z: sp.z + (Math.random() - 0.5) * 0.7, age: 0, life: 0.8 + Math.random() * 0.5 });
      }
    } else {
      this.beam.count = 0;
      this.spawn = 0;
    }
    let n = 0;
    for (let k = this.risers.length - 1; k >= 0; k--) {
      const r = this.risers[k];
      r.age += dt;
      r.y += dt * 0.9;
      if (r.age >= r.life) { this.risers.splice(k, 1); continue; }
      s.setScalar(1 - r.age / r.life);
      q.setFromEuler(new THREE.Euler(r.age * 4, r.age * 3, 0));
      this.rise.setMatrixAt(n++, m.compose(p.set(r.x, r.y, r.z), q, s));
    }
    this.rise.count = n;
    this.beam.instanceMatrix.needsUpdate = true;
    this.rise.instanceMatrix.needsUpdate = true;
  }
}

// Boulders lobbed by turrets. Each flies in an arc from where it was fired to its target,
// following the target as it moves (so it always lands), tumbling as it goes, and calls
// onHit(shot) when it arrives.
export class BoulderShots {
  constructor(scene) {
    this.scene = scene;
    this.geo = new THREE.DodecahedronGeometry(0.2, 0);
    this.mat = new THREE.MeshStandardMaterial({ color: 0x8a8274, roughness: 0.9, flatShading: true });
    this.live = [];
  }

  // from: {x, y, z}; target(): {x, y, z} (read every frame); data is passed back on hit.
  // scale: boulder size (upgraded turrets throw bigger ones).
  // straight: fly in a straight line, point first (a stretched shard), instead of an arc.
  fire(from, target, flight, data, onHit, scale = 1, straight = false) {
    const mesh = new THREE.Mesh(this.geo, this.mat);
    if (straight) mesh.scale.set(scale * 0.6, scale * 0.6, scale * 2.6); // long along its flight
    else mesh.scale.setScalar(scale);
    mesh.castShadow = true;
    mesh.position.set(from.x, from.y, from.z);
    if (this.canSee) mesh.visible = this.canSee(from.x, from.z);
    this.scene.add(mesh);
    this.live.push({ mesh, from, target, flight, t: 0, data, onHit, straight, spin: new THREE.Vector3(Math.random() * 9, Math.random() * 9, 0) });
  }

  update(dt) {
    for (let k = this.live.length - 1; k >= 0; k--) {
      const s = this.live[k];
      s.t += dt;
      const f = Math.min(1, s.t / s.flight), to = s.target();
      const dist = Math.hypot(to.x - s.from.x, to.z - s.from.z);
      const peak = s.straight ? 0 : 0.8 + dist * 0.22; // higher arcs for longer shots
      s.mesh.position.set(
        s.from.x + (to.x - s.from.x) * f,
        s.from.y + (to.y - s.from.y) * f + Math.sin(f * Math.PI) * peak,
        s.from.z + (to.z - s.from.z) * f,
      );
      if (s.straight) s.mesh.lookAt(to.x, to.y, to.z); // point first, no spin
      else {
        s.mesh.rotation.x += s.spin.x * dt;
        s.mesh.rotation.y += s.spin.y * dt;
      }
      // Hidden while over ground this screen can't see right now (set by the game: canSee(x, z)).
      if (this.canSee) s.mesh.visible = this.canSee(s.mesh.position.x, s.mesh.position.z);
      if (f >= 1) {
        this.scene.remove(s.mesh);
        this.live.splice(k, 1);
        s.onHit(s);
      }
    }
  }

  clear() { for (const s of this.live) this.scene.remove(s.mesh); this.live = []; }
}

// Continuous crystal beams (the Shard Storm from its beam level): a glowing team-colored shaft
// with a bright white core from a turret to its target, flickering. Call set(key, from, to)
// every frame for each beam that's firing, then update(t): beams not set that frame hide.
export class Beams {
  constructor(scene, color) {
    this.scene = scene;
    this.geo = new THREE.CylinderGeometry(1, 1, 1, 10, 1, true);
    this.geo.rotateX(Math.PI / 2); // along +z, so lookAt points it
    this.geo.translate(0, 0, 0.5);  // from its origin forward
    this.outerMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending });
    this.coreMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending });
    this.list = new Map(); // key → { group, outer, core, used, width }
  }
  set(key, from, to, width = 0.09) {
    let b = this.list.get(key);
    if (!b) {
      const group = new THREE.Group();
      const outer = new THREE.Mesh(this.geo, this.outerMat), core = new THREE.Mesh(this.geo, this.coreMat);
      group.add(outer, core);
      this.scene.add(group);
      b = { group, outer, core };
      this.list.set(key, b);
    }
    b.used = true;
    b.width = width;
    b.group.visible = true;
    b.group.position.set(from.x, from.y, from.z);
    b.group.lookAt(to.x, to.y, to.z);
    b.len = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
  }
  update(t) {
    for (const [key, b] of this.list) {
      if (!b.used) { b.group.visible = false; continue; }
      b.used = false;
      const w = b.width * (1 + Math.sin(t * 40 + b.len) * 0.18);
      b.outer.scale.set(w, w, b.len);
      b.core.scale.set(w * 0.35, w * 0.35, b.len);
    }
  }
  remove(key) { const b = this.list.get(key); if (b) { this.scene.remove(b.group); this.list.delete(key); } }
}

// Little stone chunks that burst out, fall and fade when something is hit.
export class Debris {
  constructor(scene) {
    this.scene = scene;
    this.geo = new THREE.BoxGeometry(1, 1, 1);
    this.pool = [];
    this.live = [];
  }

  burst(x, y, z, color = 0x8f897d, count = 10) {
    for (let k = 0; k < count; k++) {
      const m = this.pool.pop() || new THREE.Mesh(this.geo, new THREE.MeshLambertMaterial({ transparent: true }));
      m.material.color.setHex(color);
      m.material.opacity = 1;
      const s = 0.06 + Math.random() * 0.1;
      m.scale.set(s, s, s);
      m.position.set(x + (Math.random() - 0.5) * 0.4, y, z + (Math.random() - 0.5) * 0.4);
      const a = Math.random() * Math.PI * 2, out = 1 + Math.random() * 2;
      m.userData.v = new THREE.Vector3(Math.cos(a) * out, 2.5 + Math.random() * 2.5, Math.sin(a) * out);
      m.userData.spin = new THREE.Vector3(Math.random() * 8, Math.random() * 8, Math.random() * 8);
      m.userData.life = 0.7 + Math.random() * 0.3;
      m.userData.age = 0;
      m.castShadow = true;
      this.scene.add(m);
      this.live.push(m);
    }
  }

  update(dt) {
    for (let k = this.live.length - 1; k >= 0; k--) {
      const m = this.live[k], u = m.userData;
      u.age += dt;
      u.v.y -= 12 * dt;
      m.position.addScaledVector(u.v, dt);
      m.rotation.x += u.spin.x * dt; m.rotation.y += u.spin.y * dt; m.rotation.z += u.spin.z * dt;
      m.material.opacity = Math.max(0, 1 - Math.max(0, u.age - u.life * 0.6) / (u.life * 0.4));
      if (u.age >= u.life) {
        this.scene.remove(m);
        this.live.splice(k, 1);
        this.pool.push(m);
      }
    }
  }
}
