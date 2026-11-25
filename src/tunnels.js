// Tunnel mouths: earth-elemental burrows only the Sentinels can travel through.
// Each is a cave arch set into a cliff wall: a dark opening framed by jagged rocks, an arc
// of team-colored energy around it, a glow in its throat, and pebbles drifting out front.
// Only the floor tile in front of the mouth is used (to stand on); the wall holds the rest.
import * as THREE from 'three';
import { LEVEL_HEIGHT, TUNNEL_GLOW } from './config.js';
import { DIRS } from './map.js';

const rockMat = new THREE.MeshStandardMaterial({ color: 0x5e574d, roughness: 0.95, flatShading: true });
const darkMat = new THREE.MeshBasicMaterial({ color: 0x050403, side: THREE.DoubleSide });

// Small seeded random so every mouth looks a little different but never changes.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; };
}

// Built facing -z, with the cliff face at z = +0.5 (the edge of the tile in front of it).
// wallHeight: how tall the cliff is (world units), so the arch fits under its top.
export function buildTunnelMouth(tile, teamColor, wallHeight) {
  const rnd = rng(tile * 7919 + 13);
  const group = new THREE.Group();
  const r = Math.min(0.42, wallHeight * 0.55); // opening radius
  const glowColor = new THREE.Color(TUNNEL_GLOW); // tunnels glow purple (not the team color)
  const glow = (opacity) => new THREE.MeshBasicMaterial({ color: glowColor, transparent: true, opacity,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });

  // The dark opening: a half disc on the cliff face.
  const opening = new THREE.Mesh(new THREE.CircleGeometry(r, 18, 0, Math.PI), darkMat);
  opening.position.z = 0.495;
  group.add(opening);

  // Light glowing from deep in the throat (a smaller half disc over the dark).
  const throat = new THREE.Mesh(new THREE.CircleGeometry(r * 0.55, 18, 0, Math.PI), glow(0.3));
  throat.position.z = 0.49;
  group.add(throat);

  // Jagged rocks framing the arch, jutting out of the wall.
  const frame = 8;
  for (let k = 0; k < frame; k++) {
    const a = (k / (frame - 1)) * Math.PI;
    const size = (0.11 + rnd() * 0.07) * (r / 0.42 + 0.3);
    const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(size, 0), rockMat);
    rock.position.set(Math.cos(a) * (r + 0.08), Math.sin(a) * (r + 0.08) + size * 0.3, 0.44 - rnd() * 0.06);
    rock.rotation.set(rnd() * 3, rnd() * 3, rnd() * 3);
    rock.scale.set(1, 0.8 + rnd() * 0.5, 0.8);
    rock.castShadow = rock.receiveShadow = true;
    group.add(rock);
  }
  // Energy arc hugging the opening.
  const arc = new THREE.Mesh(new THREE.TorusGeometry(r + 0.01, 0.05, 6, 24, Math.PI), glow(0.85));
  arc.position.z = 0.47;
  group.add(arc);

  // Seen from above the cliff face is a thin sliver, so the mouth also opens into the floor at
  // the foot of the wall: a dark half-pit dipping under the cliff, rimmed with glowing energy
  // and a horseshoe of low rocks. (Flat pieces: rotated to lie on the ground, flat edge on the wall.)
  const fr = 0.44; // floor mouth radius
  const flat = (mesh, y) => { mesh.rotation.x = -Math.PI / 2; mesh.position.set(0, y, 0.5); mesh.scale.y = 0.9; return mesh; };
  group.add(flat(new THREE.Mesh(new THREE.CircleGeometry(fr, 20, 0, Math.PI), darkMat), 0.015));
  const shade = flat(new THREE.Mesh(new THREE.RingGeometry(fr * 0.45, fr, 20, 1, 0, Math.PI),
    new THREE.MeshBasicMaterial({ color: 0x1c1712, transparent: true, opacity: 0.6, depthWrite: false })), 0.02);
  shade.scale.set(0.98, 0.88, 1);
  group.add(shade);
  for (let k = 0; k < 7; k++) {
    const a = 0.15 + (k / 6) * (Math.PI - 0.3);
    const size = 0.08 + rnd() * 0.06;
    const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(size, 0), rockMat);
    rock.position.set(Math.cos(a) * (fr + 0.13), size * 0.5, 0.5 - Math.sin(a) * (fr + 0.13) * 0.9);
    rock.rotation.set(rnd() * 3, rnd() * 3, rnd() * 3);
    rock.scale.y = 0.7 + rnd() * 0.5;
    rock.castShadow = rock.receiveShadow = true;
    group.add(rock);
  }

  // Coming out of the wall: a pulsing ring of energy on the cliff face, a faint cone of light
  // reaching out from it, and pebbles circling in front of it (the first design's animation,
  // turned to face out of the wall).
  const cy = Math.max(0.3, r * 0.75);       // height of the ring's center on the wall
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.04, 6, 28), glow(0.85));
  ring.position.set(0, cy, 0.46);           // upright, flat against the cliff face
  group.add(ring);
  const beamLen = 0.9;
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.38, beamLen, 18, 1, true), glow(0.12)); // narrow at the wall
  beam.rotation.x = Math.PI / 2;            // axis points straight out of the wall
  beam.position.set(0, cy, 0.48 - beamLen / 2);
  group.add(beam);
  const pebbles = [];
  for (let k = 0; k < 5; k++) {
    const p = new THREE.Mesh(new THREE.DodecahedronGeometry(0.05 + rnd() * 0.04, 0), rockMat);
    p.castShadow = true;
    p.userData = { a: rnd() * Math.PI * 2, r: 0.2 + rnd() * 0.14, out: 0.15 + rnd() * 0.35, sp: 0.5 + rnd() * 0.6 };
    pebbles.push(p);
    group.add(p);
  }

  // cool: 0 = ready, 1 = just used (dims the energy while the tunnel recharges).
  group.userData.animate = (time, cool = 0) => {
    const live = 1 - cool * 0.75;
    const pulse = 0.5 + 0.5 * Math.sin(time * 3 + tile);
    arc.material.opacity = (0.45 + pulse * 0.45) * live;
    throat.material.opacity = (0.15 + pulse * 0.25) * live;
    ring.material.opacity = (0.45 + pulse * 0.45) * live;
    ring.scale.setScalar(1 + pulse * 0.08);
    beam.material.opacity = (0.06 + pulse * 0.08) * live;
    for (const p of pebbles) {
      // Circling the ring's axis (which points out of the wall), drifting in and out.
      const u = p.userData, a = u.a + time * u.sp * (0.3 + live * 0.7);
      p.position.set(Math.cos(a) * u.r, Math.max(0.06, cy + Math.sin(a) * u.r),
        0.46 - u.out - Math.sin(time * 1.5 + u.a) * 0.06);
      p.rotation.z = a;
    }
  };
  return group;
}

// One mouth per tunnel end, set into the wall beside that tile.
export function buildTunnels(map, scene, teamColor) {
  const S = map.size, ends = [];
  map.tunnels.forEach((tun, index) => {
    for (const [tile, dir, other] of [[tun.a, tun.dirA, tun.b], [tun.b, tun.dirB, tun.a]]) {
      const nb = map.neighbor(tile, dir);
      const wallHeight = (map.level[nb] - map.level[tile]) * LEVEL_HEIGHT;
      const mesh = buildTunnelMouth(tile, teamColor, wallHeight);
      mesh.position.set(tile % S + 0.5, map.level[tile] * LEVEL_HEIGHT, ((tile / S) | 0) + 0.5);
      mesh.rotation.y = Math.atan2(DIRS[dir][0], DIRS[dir][1]); // local +z points at the wall
      scene.add(mesh);
      ends.push({ tunnel: index, tile, other, dir, mesh });
    }
  });
  return ends;
}
