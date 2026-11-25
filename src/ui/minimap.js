// Minimap (bottom-right): terrain by height, fog for the Colossus, bases' buildings,
// watchstones, both characters, and the camera's view. Click or drag to move the camera;
// right-click to send the selected character there.
import { el } from './dom.js';
import { LEVEL_COLORS, RUIN_COLOR, ROCK_COLOR, WATCHSTONE_COLOR, PINE_COLOR, BOSS_ZONE_COLOR } from '../config.js';
import { ZONE } from '../map.js';

const hex = (n) => [(n >> 16) & 255, (n >> 8) & 255, n & 255];

export class Minimap {
  constructor(root, map, { onNavigate, onCommand }) {
    this.map = map;
    const wrap = el('div', 'hud minimap');
    this.canvas = el('canvas');
    this.size = 240;
    this.yaw = Math.PI / 4;
    this.canvas.width = this.canvas.height = this.size;
    wrap.appendChild(this.canvas);
    root.appendChild(wrap);
    this.ctx = this.canvas.getContext('2d');

    // Terrain is drawn at one pixel per tile into a small canvas, then scaled up.
    this.base = document.createElement('canvas');
    this.base.width = this.base.height = map.size;
    this.baseCtx = this.base.getContext('2d');
    this.dirty = true;

    const S = map.size;
    this.colors = new Uint8ClampedArray(S * S * 3);
    for (let t = 0; t < S * S; t++) {
      const z = map.zone[t];
      let c = z === ZONE.RUIN ? RUIN_COLOR : z === ZONE.ROCK ? ROCK_COLOR : z === ZONE.WATCH ? WATCHSTONE_COLOR
        : z === ZONE.FOREST ? PINE_COLOR : z === ZONE.BOSS ? BOSS_ZONE_COLOR : LEVEL_COLORS[map.level[t]];
      let [r, g, b] = hex(c);
      if (map.ramp[t] >= 0) { r = r * 0.8 + 50; g = g * 0.8 + 45; b = b * 0.8 + 30; }
      // Darken tiles on a cliff edge so base outlines read.
      for (let d = 0; d < 4 && z === ZONE.SITE; d++) {
        const nb = map.neighbor(t, d);
        if (nb >= 0 && map.level[nb] !== map.level[t] && map.ramp[nb] < 0 && map.ramp[t] < 0) { r *= 0.7; g *= 0.7; b *= 0.7; break; }
      }
      this.colors.set([r, g, b], t * 3);
    }

    // Input: left-click/drag = move the camera; right-click = command.
    // Undo the rotation used in draw() to turn a click into map coordinates.
    const toMap = (e) => {
      const r = this.canvas.getBoundingClientRect(), k = this.scale();
      const u = ((e.clientX - r.left) / r.width - 0.5) * this.size / k;
      const v = ((e.clientY - r.top) / r.height - 0.5) * this.size / k;
      const c = Math.cos(this.yaw), s = Math.sin(this.yaw), clamp = (n) => Math.max(0, Math.min(S - 0.01, n));
      return { x: clamp(S / 2 + u * c + v * s), z: clamp(S / 2 - u * s + v * c) };
    };
    let dragging = false;
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    this.canvas.addEventListener('pointerdown', (e) => {
      const p = toMap(e);
      if (e.button === 0) { dragging = true; onNavigate(p.x, p.z); this.canvas.setPointerCapture(e.pointerId); }
      else if (e.button === 2) onCommand(map.tileAt(p.x, p.z));
    });
    this.canvas.addEventListener('pointermove', (e) => { if (dragging) { const p = toMap(e); onNavigate(p.x, p.z); } });
    this.canvas.addEventListener('pointerup', () => { dragging = false; });
  }

  markDirty() { this.dirty = true; }

  // Pixels per tile. The camera always looks along a diagonal, so the map is a diamond
  // whose corners touch the canvas edges.
  scale() { return this.size / (this.map.size * Math.SQRT2); }

  // fogVis: the Colossus's vision array when fog applies, else null (everything shown).
  redrawTerrain(fogVis) {
    const S = this.map.size, img = this.baseCtx.createImageData(S, S), d = img.data;
    for (let t = 0; t < S * S; t++) {
      const f = !fogVis ? 1 : fogVis[t] === 2 ? 1 : fogVis[t] === 1 ? 0.5 : 0.12;
      d[t * 4] = this.colors[t * 3] * f;
      d[t * 4 + 1] = this.colors[t * 3 + 1] * f;
      d[t * 4 + 2] = this.colors[t * 3 + 2] * f;
      d[t * 4 + 3] = 255;
    }
    this.baseCtx.putImageData(img, 0, 0);
    this.dirty = false;
  }

  // s: { fogVis, buildings: [{tiles, color}], watchstones, units: [{x, z, color, r, selected}],
  //      view: [{x, z}×4], yaw: the camera's yaw (the minimap turns with the camera) }
  draw(s) {
    if (this.dirty) this.redrawTerrain(s.fogVis);
    if (s.yaw !== undefined) this.yaw = s.yaw;
    const ctx = this.ctx, S = this.map.size, W = this.size, k = this.scale();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, W);
    // Map (x, z) -> screen, so that screen-up on the minimap is screen-up in the game.
    const c = Math.cos(this.yaw), sn = Math.sin(this.yaw), h = S / 2;
    ctx.setTransform(k * c, k * sn, -k * sn, k * c, W / 2 - k * (h * c - h * sn), W / 2 - k * (h * sn + h * c));
    const px = 1 / k; // one screen pixel, in tiles
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.base, 0, 0, S, S);

    // Buildings: one square per tile, in the owner's color.
    for (const b of s.buildings) {
      ctx.fillStyle = b.color;
      for (const t of b.tiles) ctx.fillRect(t % S, (t / S) | 0, 1, 1);
    }
    // Tunnel mouths: a dark dot ringed in the tunnel glow (not linked: where they lead isn't shown).
    for (const tn of s.tunnels || []) {
      for (const [p, shown] of [[tn.a, tn.showA], [tn.b, tn.showB]]) {
        if (!shown) continue;
        ctx.beginPath();
        ctx.arc(p.x, p.z, 3 * px, 0, Math.PI * 2);
        ctx.fillStyle = '#0b0906';
        ctx.fill();
        ctx.lineWidth = 1.5 * px;
        ctx.strokeStyle = s.tunnelColor;
        ctx.stroke();
      }
    }
    // Watchstones.
    ctx.fillStyle = '#ffd27a';
    for (const w of s.watchstones) { ctx.beginPath(); ctx.arc(w.x, w.z, 2.5 * px, 0, Math.PI * 2); ctx.fill(); }
    // Characters (the selected one gets a white outline).
    for (const u of s.units) {
      ctx.beginPath();
      ctx.arc(u.x, u.z, u.r * px, 0, Math.PI * 2);
      ctx.fillStyle = u.color;
      ctx.fill();
      ctx.lineWidth = (u.selected ? 2 : 1) * px;
      ctx.strokeStyle = u.selected ? '#ffffff' : '#0b0e12';
      ctx.stroke();
    }
    // The camera's view of the ground.
    if (s.view) {
      ctx.beginPath();
      s.view.forEach((p, i) => (i ? ctx.lineTo(p.x, p.z) : ctx.moveTo(p.x, p.z)));
      ctx.closePath();
      ctx.lineWidth = 1.2 * px;
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.stroke();
    }
  }
}
