import * as THREE from 'three';
import { ATTACKER, BUILDINGS, WATCHSTONES, DEFENDER, LEVEL_HEIGHT, LEVEL_MAX, TUNNELS, TUNNEL_GLOW, UPGRADES, SHOP, TROOPS, BOSS, INVENTORY_SLOTS, REGEN_DELAY, QUARRY_WORKERS, MAX_UPGRADE_LEVEL, ROMAN, itemTierName, itemCurrency, PLATINUM } from './config.js';
import { Troops } from './troops.js';
import { Workers } from './workers.js';
import { Boss } from './boss.js';
import { buildTunnels } from './tunnels.js';
import { Debris, RepairFx, BoulderShots, Beams } from './effects.js';
import { generateMap, ZONE, DIRS } from './map.js';
import { randomSeed } from './rng.js';
import { loadShapes } from './shapes.js';
import { buildTerrain, pickGround } from './terrain.js';
import { computeVision, lineOfSight } from './vision.js';
import { findPath } from './pathfinding.js';
import { Attacker } from './attacker.js';
import { Defender } from './defender.js';
import { BuildingManager, lineTiles } from './buildings.js';
import { CameraController } from './camera.js';
import { createColossusHud, createDefenderHud, createResourceBar, createInfoPanel, createEndBanner } from './ui/huds.js';
import { Minimap } from './ui/minimap.js';
import { createDebugPanel, createToasts } from './ui/debug.js';
import { runLobby, ROLES } from './net.js';
import { NET } from './config.js';

// ---- Multiplayer: ?lobby (host) or ?join=CODE opens the lobby first (src/net.js). ----
// NETMODE: 'solo' (one browser plays both sides, as before), 'host' (this browser runs the real
// game and sends it to the others) or 'client' (shows the host's game, sends its clicks).
const params = new URLSearchParams(location.search);
// The page opens on the multiplayer lobby (hosting a room, or ?join=CODE). Solo play is ?solo
// (a ?seed=… link is solo too).
const playSolo = params.has('solo') || params.has('seed');
const session = playSolo ? null : await runLobby(params);
// Debug tools (the debug panel's commands, ?god=1, ?fog=0) only work when the game runs from
// the developer's own computer (localhost), never from the published site.
const DEBUG_ALLOWED = ['localhost', '127.0.0.1', '[::1]', ''].includes(location.hostname);
const NETMODE = session ? session.mode : 'solo';
const isClient = NETMODE === 'client', isHost = NETMODE === 'host', multiplayer = !!session;
const myRole = session ? session.role : null;           // 'attacker' | 'defender' | 'spectator'
const spectating = myRole === 'spectator';

// ---- Seed: from the URL (?seed=abc) so maps can be shared, or a fresh random one. ----
const seed = session ? session.seed : params.get('seed') || randomSeed();
if (!session && !params.get('seed')) history.replaceState(null, '', `?solo&seed=${encodeURIComponent(seed)}`);
document.getElementById('seed-label').textContent = seed;
if (session) document.getElementById('mp-link').hidden = true;
if (session) { // who you are, next to the seed
  const tag = document.createElement('span');
  tag.className = 'mp-tag';
  tag.textContent = `${session.name} · ${ROLES[myRole].name}${isHost ? ' · host' : ''}`;
  document.getElementById('seed-label').after(tag);
}

// ---- Renderer & scene ----
const container = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0e12);
scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x3a3020, 1.1));
const sun = new THREE.DirectionalLight(0xfff1d6, 1.6);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -45, right: 45, top: 45, bottom: -45, near: 1, far: 200 });
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.03;
scene.add(sun, sun.target);

// ---- World ----
const shapes = await loadShapes(); // custom base shapes from shapes/base_shapes.json
const map = generateMap(seed, shapes);
console.log(`${map.sites.length} bases, coverage ${(map.coverage * 100).toFixed(1)}%, reachable: ${map.sites.every((s) => s.reachable)}, `
  + `crystals ${map.crystals.length}/${map.sites.reduce((a, s) => a + s.crystalCount, 0)} (rare ${map.rareCrystals.size})`);
const terrain = buildTerrain(map);
scene.add(terrain.group);
const buildings = new BuildingManager(map, scene);
for (const t of terrain.decorTiles) buildings.occ[t] = -2;
const attacker = new Attacker(map, scene);

// TEST: one defender character standing at the best base. Press C to switch control.
const homeBase = [...map.sites].sort((a, b) => b.quality - a.quality)[0];
let homeTile = homeBase ? homeBase.anchor : map.idx(map.size / 2 | 0, (map.size / 2 | 0) + 10);
if (homeBase) { // stand a couple of tiles from the banner, on the same tier of the same base
  for (const off of [2, -2, 2 * map.size, -2 * map.size, 1, -1]) {
    const t = homeTile + off;
    if (map.siteId[t] === homeBase.id && map.level[t] === map.level[homeTile] && map.ramp[t] < 0) { homeTile = t; break; }
  }
}
// ?defender=warden or ?defender=sentinel picks the look (default: DEFENDER.model in config.js).
const defenderModel = ['warden', 'sentinel'].includes(params.get('defender')) ? params.get('defender') : DEFENDER.model;
const defenderName = defenderModel === 'warden' ? 'Warden' : 'Sentinel';
// The Sentinels: one per Defender player, all starting in the ruined temple around the spot
// the Colossus will rise from (multiplayer); solo, one at the best base. Each Sentinel's own
// orders and cooldowns live in its slot here. Whichever Sentinel is acting is loaded into
// the globals (defender, repair, tunnelTrip, blinkCd, …; see useSentinel), so the rest of
// the code works on "the" Sentinel, and saved back afterwards.
function templeSpot(k, n) {
  const S = map.size, c = S / 2, a = (k / Math.max(1, n)) * Math.PI * 2 + Math.PI / 4;
  const want = { x: c + Math.cos(a) * 3, z: c + Math.sin(a) * 3 };
  let best = -1, bestD = Infinity;
  for (let j = (c | 0) - 6; j <= (c | 0) + 6; j++) for (let i = (c | 0) - 6; i <= (c | 0) + 6; i++) {
    const t = map.idx(i, j);
    if (map.isBlocked(t) || buildings.occ[t] !== -1 || Math.hypot(i + 0.5 - c, j + 0.5 - c) < 1.5) continue;
    const d = Math.hypot(i + 0.5 - want.x, j + 0.5 - want.z);
    if (d < bestD) { bestD = d; best = t; }
  }
  return best >= 0 ? best : homeTile;
}
const defenderPlayers = multiplayer ? session.players.filter((p) => p.role === 'defender') : [{ id: 'solo', name: '' }];
// Each Defender is completely separate: their own Sentinel, buildings, stone and crystals,
// troops, helpers, limits and sight, in their own team color (DEFENDER.colors, in join order).
const sentinels = defenderPlayers.map((p, k) => {
  const t = multiplayer ? templeSpot(k, defenderPlayers.length) : homeTile;
  const color = DEFENDER.colors[k % DEFENDER.colors.length];
  const unit = new Defender(map, scene, t % map.size + 0.5, ((t / map.size) | 0) + 0.5, color, defenderModel);
  unit.hp = unit.maxHp = DEFENDER.hp;
  return { id: p.id, owner: p.id, name: p.name, color, unit, repair: null, repairRepath: 0, tunnelTrip: null, tunnelCooldown: 0,
    blinkCd: 0, autoRepair: DEFENDER.autoRepair.on, autoRepairTimer: 0, autoRepairSkip: new Map(), fx: null, bar: null, target: null,
    stone: 0, crystals: 0, vis: new Uint8Array(map.size * map.size) };
});
// The Sentinel this screen plays (or the first one, for the Colossus's and spectators' screens).
const mySentinel = sentinels.find((s) => s.owner === (multiplayer ? session.me : 'solo')) || sentinels[0];
let curSentinel = mySentinel;
let defender = mySentinel.unit;
const sentinelOf = (unit) => sentinels.find((s) => s.unit === unit);
const TEAM_NAMES = ['Blue', 'Red', 'Green', 'Gold', 'Purple', 'Orange', 'Teal', 'Pink']; // DEFENDER.colors, in order
// Ownership: buildings, troops and helpers belong to one Defender (their Sentinel's id).
const slotById = (id) => sentinels.find((s) => s.id === id) || sentinels[0];
const ownedHere = (x) => !!x && (x.owner ?? sentinels[0].id) === curSentinel.id; // the acting Defender's?
const ownedByMe = (x) => !!x && (x.owner ?? sentinels[0].id) === mySentinel.id;  // this screen's player's?
attacker.hp = attacker.maxHp = ATTACKER.hp;
// The defenders' troops (summoned at a Barracks), and which defender units are selected
// (the Sentinel and/or troops; box-select with a left-drag).
// Troops and helpers walk straight through their own owner's walls, so for them those wall
// tiles are open ground (other Defenders' walls block them). owner null: every wall blocks.
function troopOcc(owner = null) {
  const occ = buildings.occ.slice();
  if (owner === null) return occ;
  buildings.list.forEach((b, i) => {
    if (b.type !== 'wall' || b.destroyed || (b.owner ?? sentinels[0].id) !== owner) return;
    for (const t of b.tiles) if (occ[t] === i) occ[t] = -1;
  });
  return occ;
}
const troops = new Troops(map, scene, troopOcc, DEFENDER.colors[0]);
// Quarry workers (hired at a Quarry): they mine crystal rocks and earn crystals. See workers.js.
const workers = new Workers(map, scene, troopOcc);
const selUnits = new Set();
// The boss in the boss zone's lair (neutral: it fights both sides). See boss.js.
const boss = map.boss ? new Boss(map, scene) : null;

// ---- HUD ----
const uiRoot = document.getElementById('ui');
const showToast = createToasts(uiRoot);
// A message on screen. Multiplayer (host): while running another player's command it goes to
// that player instead (toastTo), and announcements go to everyone.
let toastTo = null;
function toast(text, opts = {}) {
  if (toastTo) { session.net.send(toastTo, { t: 'toast', text, opts }); return; }
  showToast(text, opts);
  if (isHost && opts.announce) session.net.broadcast({ t: 'toast', text, opts });
}
// A message for one side's players only ('attacker' or 'defender'): shown here if this screen
// plays that side (or, solo, is controlling it now), and sent to the other players on it.
function toastSide(side, text, opts = {}) {
  if (isHost) for (const p of session.players) if (p.id !== session.me && p.role === side) session.net.send(p.id, { t: 'toast', text, opts });
  const mine = multiplayer ? myRole === side : (side === 'attacker') === (controlled === attacker);
  if (mine) showToast(text, opts);
}
const resourceBar = createResourceBar(uiRoot);
const colossusHud = createColossusHud(uiRoot, { onAttackMove: () => armAttackMove(), onBuy: (kind, tier) => buyItem(kind, tier), onSell: (slot) => sellItem(slot),
  onToggleShop: (open) => toggleShop(open), onRecall: () => recall(), onTrade: () => tradeForPlatinum(),
  onBlade: () => hiddenDancingBlade(), onGlimpse: () => armGlimpse() });
// The temple shop window (the Colossus): O or the HUD's Shop button opens and closes it.
function toggleShop(open = !colossusHud.shopOpen) {
  colossusHud.setShopOpen(open && controlled === attacker);
}
const defenderHud = createDefenderHud(uiRoot, {
  name: defenderName, teamColor: mySentinel.color, teamName: TEAM_NAMES[sentinels.indexOf(mySentinel) % TEAM_NAMES.length],
  onBuild: (type) => setBuildType(type),
  onAutoRepair: () => toggleAutoRepair(),
  onBlink: () => armBlink(),
});
const infoPanel = createInfoPanel(uiRoot);
if (spectating) { // spectators see the info panel without its buttons
  const show = infoPanel.update.bind(infoPanel);
  infoPanel.update = (info) => show(info && { ...info, actions: [] });
}
const endBanner = createEndBanner(uiRoot);

// ?control=defender starts on the defender. Multiplayer: your role decides (a spectator
// follows the Colossus's camera but sees everything and gives no orders).
let controlled = multiplayer ? (myRole === 'defender' ? defender : attacker)
  : params.get('control') === 'defender' ? defender : attacker;
function setControlled(unit) {
  controlled = unit;
  attacker.setSelected(unit === attacker);
  if (unit === defender && !selUnits.size) selUnits.add(defender);
  refreshUnitRings();
  colossusHud.el.hidden = unit !== attacker;
  if (unit !== attacker) colossusHud.setShopOpen(false);
  defenderHud.el.hidden = unit !== defender;
  if (unit === attacker && buildType) setBuildType(buildType); // building is a defender action
  if (unit !== attacker && attackMoveArmed) armAttackMove(false);
  refreshFog(); // show the controlled side's vision
  minimap?.markDirty();
}
// Selection rings on the defender's units show only while you control the defenders.
function refreshUnitRings() {
  const on = controlled !== attacker && !spectating;
  for (const s of sentinels) s.unit.setSelected(on && s === mySentinel && selUnits.has(s.unit)); // only your own Sentinel
  for (const u of troops.list) troops.setSelected(u, on && selUnits.has(u));
  for (const w of workers.list) workers.setSelected(w, on && selUnits.has(w));
}
const selectedTroops = () => [...selUnits].filter((u) => u !== defender && !u.isWorker && !u.dead);
const selectedWorkers = () => [...selUnits].filter((u) => u.isWorker && !u.dead);
// Select these units (add: keep the current selection too, for Shift).
function setUnitSelection(units, add = false) {
  if (!add) selUnits.clear();
  for (const u of units) selUnits.add(u);
  refreshUnitRings();
}

const cam = new CameraController(renderer.domElement);
cam.target.set(controlled.x, 0, controlled.z);
let minimap = null; // created below, once commands exist
let attackMoveArmed = false; // the Colossus's attack move is waiting for its click (see "Attack move")
if (params.get('zoom')) cam.zoom = Math.max(0.45, Math.min(8, Number(params.get('zoom')) || 1));

// ---- Fog of war ----
// Each side has its own vision: vis for the Colossus, defVis for the defenders (their
// character plus every building). The screen shows the side you control.
const vis = new Uint8Array(map.size * map.size);
let defVis = mySentinel.vis; // the acting Defender's sight (each has their own; see useSentinel)
const shownVis = () => (controlled === attacker ? vis : defVis);
let fogEnabled = !(params.get('fog') === '0' && DEBUG_ALLOWED) && !spectating; // ?fog=0 starts with fog off (debug, local only); spectators see all
// What this screen's player sees right now (their side's sight), or null for everything. Unlike
// shownVis() it doesn't change while the host runs another player's command or Sentinel.
const viewVis = () => {
  if (!fogEnabled || spectating) return null;
  const asColossus = multiplayer ? myRole === 'attacker' : controlled === attacker;
  return asColossus ? vis : mySentinel.vis;
};
// Can this screen see that spot right now? Effects, shots and animations in the fog are hidden,
// so the other side's actions there give nothing away.
function seesNow(x, z) {
  const v = viewVis();
  return !v || v[map.tileAt(x, z)] === 2;
}
// Debug: the player characters (the Colossus and the Sentinel) take no damage. Debug command
// Y toggles it; ?god=1 starts with it on.
let godMode = params.get('god') === '1' && DEBUG_ALLOWED;
function setGodMode(on) {
  godMode = on;
  toast(on ? 'Invincible: the Colossus and the Sentinel take no damage' : 'Invincible off');
}
let lastVisionTile = -1;
function refreshFog() {
  terrain.applyFog(shownVis(), fogEnabled);
  buildings.applyFog(shownVis(), fogEnabled);
}
// ---- What the Colossus knows ----
// It plans paths with its own memory of buildings and walls, not the real map.
// Anything it hasn't seen counts as open ground until it sees (or bumps into) it.
// Terrain (cliffs, ramps, crystals, temple pillars) is treated as known.
const knownOcc = buildings.occ.slice();

function replan() {
  if (attacker.goal < 0) return;
  const path = findPath(map, knownOcc, attacker.tile, attacker.goal);
  attacker.setPath(path || [], attacker.goal);
}
const pathBlocked = () => attacker.path.some((t) => knownOcc[t] !== -1);

// Update memory for these tiles; replan if the route now runs into something known.
function learn(tiles, force = false) {
  let changed = false;
  for (const t of tiles) {
    if ((force || vis[t] === 2) && knownOcc[t] !== buildings.occ[t]) {
      knownOcc[t] = buildings.occ[t];
      changed = true;
    }
  }
  if (changed && pathBlocked()) replan();
}

const allTiles = Array.from({ length: map.size * map.size }, (_, t) => t);
let atWatchstone = false;
const templeTiles = allTiles.filter((t) => map.zone[t] === ZONE.RUIN); // the Colossus always sees these
let glimpses = []; // active Watchfire Glimpses: { x, z, t, ring, disc } (see "Watchfire Glimpse")
// ---- Watchstones: lit, used, cold ----
// Each one is 'ready' (its fire lit), 'burning' (the Colossus lit it: far sight for
// WATCHSTONES.duration s while it stands there, shrinking back over the last `fade` s as the
// fire dies), or 'cold' (WATCHSTONES.cooldown s, then it relights). t: seconds left.
const watch = map.watchstones.map(() => ({ state: 'ready', t: 0 }));
const nearStone = (w, tile = attacker.tile) => {
  const S = map.size;
  return Math.max(Math.abs(w.stone % S - tile % S), Math.abs(((w.stone / S) | 0) - ((tile / S) | 0))) <= WATCHSTONES.range;
};
// The Colossus's vision radius now: far sight next to a burning watchstone (fading out at the
// end), otherwise normal. And the burning stone it's using, if any.
function watchSight() {
  let radius = ATTACKER.visionRadius, using = null;
  map.watchstones.forEach((w, k) => {
    const s = watch[k];
    if (s.state !== 'burning' || attacker.dead || !nearStone(w)) return;
    const f = Math.min(1, s.t / WATCHSTONES.fade);
    const r = ATTACKER.visionRadius + (WATCHSTONES.visionRadius - ATTACKER.visionRadius) * f;
    if (r > radius) { radius = r; using = s; }
  });
  return { radius, using };
}
let lastWatchRadius = -1;
function updateWatchstones(dt) {
  let changed = false;
  map.watchstones.forEach((w, k) => {
    const s = watch[k];
    if (s.state === 'ready') {
      if (attacker.dead || !nearStone(w)) return;
      s.state = 'burning'; s.t = WATCHSTONES.duration; changed = true;
      terrain.setFire(k, 1.5, 2); // flares up
      // Using one puts every other watchstone's fire out too (each then cools down).
      watch.forEach((o, j) => {
        if (j === k || o.state === 'cold') return;
        o.state = 'cold'; o.t = WATCHSTONES.cooldown;
        terrain.setFire(j, 0, 0.6); // dies down over a couple of seconds
      });
      toastSide('attacker', `Watchstone lit: ${WATCHSTONES.visionRadius}-tile sight for ${WATCHSTONES.duration}s while you stand by it${map.watchstones.length > 1 ? '. The other watchstone went out' : ''}`);
    } else if (s.state === 'burning') {
      const before = s.t;
      s.t -= dt;
      if (before > WATCHSTONES.fade && s.t <= WATCHSTONES.fade) terrain.setFire(k, 0, 1.5 / WATCHSTONES.fade); // dies down and goes out
      if (s.t <= 0) {
        s.state = 'cold'; s.t = WATCHSTONES.cooldown; changed = true;
        if (nearStone(w)) toastSide('attacker', `The watchstone's fire is out: it relights in ${Math.round(WATCHSTONES.cooldown / 60)} minutes`);
      }
    } else if ((s.t -= dt) <= 0) {
      s.state = 'ready'; s.t = 0; changed = true;
      terrain.setFire(k, 1, 1); // relights
    }
  });
  // Recompute the Colossus's vision when the far sight changes (it shrinks smoothly at the end).
  const r = Math.round(watchSight().radius * 2) / 2;
  if (changed || r !== lastWatchRadius) { lastWatchRadius = r; updateVision(true); }
}
const watchText = (k) => {
  const s = watch[k];
  return s.state === 'ready' ? 'fire lit: stand next to it to light it'
    : s.state === 'burning' ? `burning, ${Math.ceil(s.t)}s left`
      : `cold, relights in ${Math.floor(s.t / 60)}:${String(Math.floor(s.t % 60)).padStart(2, '0')}`;
};
function updateVision(force = false) {
  const t = attacker.tile;
  if (!force && t === lastVisionTile) return;
  lastVisionTile = t;
  // Next to a burning watchstone: far sight (see updateWatchstones).
  const sight = watchSight();
  computeVision(map, attacker.x, attacker.z, sight.radius, vis);
  // Its own ruined temple: the Colossus always sees all of it, wherever it is.
  for (const t of templeTiles) vis[t] = 2;
  // Lit watchstones: the Colossus sees a little way round each one from anywhere.
  map.watchstones.forEach((w, k) => {
    if (watch[k].state === 'ready') computeVision(map, w.x, w.z, WATCHSTONES.readyVision, vis, false);
  });
  // Watchfire Glimpse: everything round each glimpsed spot.
  if (glimpses.length) {
    const S = map.size, R = glimpseRadius();
    for (const g of glimpses) {
      for (let j = Math.max(0, Math.floor(g.z - R)); j <= Math.min(S - 1, Math.ceil(g.z + R)); j++) {
        for (let i = Math.max(0, Math.floor(g.x - R)); i <= Math.min(S - 1, Math.ceil(g.x + R)); i++) {
          if (Math.hypot(i + 0.5 - g.x, j + 0.5 - g.z) <= R) vis[j * S + i] = 2;
        }
      }
    }
  }
  atWatchstone = !!sight.using;
  if (controlled === attacker) { refreshFog(); minimap?.markDirty(); }
  learn(allTiles);
}
// Each Defender sees around their own Sentinel, troops, helpers and buildings (their own sight,
// in their slot's vis). Recomputed when one of their units changes tile or a building changes.
function updateDefVision(force = false) {
  const S = map.size;
  let changed = false;
  for (const s of sentinels) {
    const own = (x) => (x.owner ?? sentinels[0].id) === s.id;
    const blds = buildings.list.filter((b) => !b.destroyed && own(b));
    const live = troops.alive.filter(own), crew = workers.alive.filter(own);
    const key = `${s.unit.tile}:${buildings.list.length}:${blds.length}:${live.map((u) => u.tile).join(',')}:${crew.map((w) => w.tile).join(',')}`;
    if (!force && key === s.visKey) continue;
    s.visKey = key;
    changed ||= s === mySentinel;
    const v = s.vis;
    computeVision(map, s.unit.x, s.unit.z, DEFENDER.visionRadius, v);
    for (const u of live) computeVision(map, u.x, u.z, u.cfg.vision, v, false); // troops see too
    for (const w of crew) computeVision(map, w.x, w.z, QUARRY_WORKERS.vision, v, false); // and quarry workers
    for (const b of blds) {
      const x = b.tiles.reduce((a, t) => a + t % S + 0.5, 0) / b.tiles.length;
      const z = b.tiles.reduce((a, t) => a + ((t / S) | 0) + 0.5, 0) / b.tiles.length;
      computeVision(map, x, z, BUILDINGS[b.type].vision, v, false);
      for (const t of b.tiles) v[t] = 2; // always sees itself
    }
  }
  if (changed && controlled !== attacker) { refreshFog(); minimap?.markDirty(); }
}
updateVision(true);
updateDefVision(true);

// Safety net: if the next step is physically blocked (e.g. an unseen wall), learn it.
function checkNextStep() {
  if (!attacker.path.length) return;
  const S = map.size, cur = attacker.tile, next = attacker.path[0];
  const touched = [next];
  const ci = cur % S, cj = (cur / S) | 0, ni = next % S, nj = (next / S) | 0;
  if (ci !== ni && cj !== nj) touched.push(cj * S + ni, nj * S + ci); // diagonal corners
  if (touched.some((t) => buildings.occ[t] !== -1)) {
    learn(touched, true);
    replan(); // always: a blocked diagonal corner isn't on the path itself
  }
}

function toggleFog() {
  if (multiplayer) return; // no peeking through the fog in a real game
  fogEnabled = !fogEnabled;
  refreshFog();
  minimap?.markDirty();
  toast(`Fog ${fogEnabled ? 'on' : 'off'}`);
}

// ---- Move marker ----
const marker = new THREE.Mesh(
  new THREE.RingGeometry(0.25, 0.4, 24),
  new THREE.MeshBasicMaterial({ color: 0x6ef0ff, transparent: true, depthWrite: false }),
);
marker.rotation.x = -Math.PI / 2;
marker.visible = false;
scene.add(marker);
let markerTime = 0;

// ---- Build mode ----
let buildType = null;
let wallDragStart = -1; // tile where a wall drag began, or -1
let wallDragEnd = -1;
function setBuildType(type) {
  if (defender.dead && !buildType) return; // a fallen Sentinel can't build
  if (type && buildType !== type && limitReached(type)) { toast(limitText(type)); return; }
  buildType = buildType === type ? null : type;
  if (buildType && blinkArmed) armBlink(false); // picking a building cancels a waiting Blink
  wallDragStart = -1;
  defenderHud.setActiveBuild(buildType);
  buildings.showGhost(null, -1, false);
  buildings.showGhostTiles([], () => false);
}
setControlled(controlled);
if (spectating) { colossusHud.el.hidden = true; defenderHud.el.hidden = true; } // spectators only watch
if (multiplayer) { // how the game starts: the Sentinels in the temple, the Colossus rising a little later
  const d = NET.colossusDelay;
  showToast(myRole === 'attacker' ? `You rise from your temple in ${d}s. The temple shop (O) is open while you wait`
    : myRole === 'defender' ? `The Colossus rises from this temple in ${d}s: get out and build your base!`
      : `The Colossus rises from its temple in ${d}s`, { announce: true });
}

// ---- Placement range: the defender can only build near itself ----
function inBuildRange(type, tile) {
  const { i0, j0, size } = buildings.footprint(type, tile);
  return Math.hypot(i0 + size / 2 - defender.x, j0 + size / 2 - defender.z) <= DEFENDER.buildRange;
}
// ...and only on ground the defenders can see right now (every tile of the footprint).
function inSight(type, tile) {
  const { i0, j0, size } = buildings.footprint(type, tile);
  for (let j = j0; j < j0 + size; j++) {
    for (let i = i0; i < i0 + size; i++) if (!map.inBounds(i, j) || defVis[map.idx(i, j)] !== 2) return false;
  }
  return true;
}
const canBuild = (type, tile) => buildings.canPlace(type, tile, attacker.tile) && inBuildRange(type, tile) && inSight(type, tile)
  && !limitReached(type)
  && (map.zone[tile] !== ZONE.BOSS || type === 'cannon'); // the boss arena: turrets only (on its pads)
// A glowing band on the ground around the defender, shown while picking a building to place.
// It's a strip of quads (inner and outer edge) that follows the ground height over cliffs.
const RING_POINTS = 200, RING_HALF_WIDTH = 0.14;
const ringGeo = new THREE.BufferGeometry();
ringGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(RING_POINTS * 2 * 3), 3));
const ringIndex = [];
for (let k = 0; k < RING_POINTS; k++) {
  const a = k * 2, b = a + 1, c = ((k + 1) % RING_POINTS) * 2, d = c + 1;
  ringIndex.push(a, b, c, b, d, c);
}
ringGeo.setIndex(ringIndex);
const rangeRing = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
  color: new THREE.Color(DEFENDER.colors[0]).lerp(new THREE.Color(0xffffff), 0.35),
  transparent: true, opacity: 0.9, depthTest: false, side: THREE.DoubleSide,
}));
rangeRing.renderOrder = 5;
rangeRing.frustumCulled = false;
rangeRing.visible = false;
scene.add(rangeRing);
// ---- Blink (the Sentinel, F, then click): teleport within the build range ----
// Any open tile within DEFENDER.buildRange of it, even one it can't see (no building, rock,
// grove or crystal on it). Cancels its orders. Then DEFENDER.blink.cooldown seconds to recharge.
let blinkArmed = false;
let blinkCd = 0;
function armBlink(on = !blinkArmed) {
  if (on && blinkCd > 0) { toast(`Blink is ready in ${Math.ceil(blinkCd)}s`); on = false; }
  if (on && defender.dead) on = false;
  blinkArmed = on && controlled === defender;
  if (blinkArmed && buildType) setBuildType(buildType); // leaves build mode
  defenderHud.setBlinkArmed(blinkArmed);
  renderer.domElement.style.cursor = blinkArmed ? 'crosshair' : '';
}
function blinkTo(tile) {
  armBlink(false);
  if (tile < 0 || defender.dead || blinkCd > 0) return;
  if (tunnelTrip && tunnelTrip.phase !== 'walk') { toast('Can\'t blink while travelling through a tunnel'); return; }
  const S = map.size, x = tile % S + 0.5, z = ((tile / S) | 0) + 0.5;
  if (Math.hypot(x - defender.x, z - defender.z) > DEFENDER.buildRange) { toast(`Too far: Blink reaches ${DEFENDER.buildRange} tiles (the ring)`); return; }
  if (map.isBlocked(tile) || buildings.occ[tile] !== -1) { toast('Can\'t blink there: something is in the way'); return; }
  const c = DEFENDER.colors[0];
  debris.burst(defender.x, map.heightAt(defender.x, defender.z) + 0.6, defender.z, c, 22);
  defender.x = x; defender.z = z;
  defender.setPath([], tile);
  repair = null; tunnelTrip = null; // its orders are cancelled
  defender.syncMesh();
  debris.burst(x, map.heightAt(x, z) + 0.6, z, c, 22);
  updateDefVision(true);
  blinkCd = DEFENDER.blink.cooldown;
}
function updateBlink(dt) {
  blinkCd = Math.max(0, blinkCd - dt);
  if (curSentinel === mySentinel) defenderHud.setBlink(blinkCd, DEFENDER.blink.cooldown);
}
function updateRangeRing(time) {
  rangeRing.visible = (!!buildType || blinkArmed) && controlled === defender; // also shows Blink's reach
  if (!rangeRing.visible) return;
  const pos = ringGeo.attributes.position, R = DEFENDER.buildRange;
  for (let k = 0; k < RING_POINTS; k++) {
    const a = (k / RING_POINTS) * Math.PI * 2, cx = Math.cos(a), cz = Math.sin(a);
    // Both edges take the ground height at the ring's center line, so the band stays flat.
    const mx = THREE.MathUtils.clamp(defender.x + cx * R, 0, map.size - 0.01);
    const mz = THREE.MathUtils.clamp(defender.z + cz * R, 0, map.size - 0.01);
    const y = map.heightAt(mx, mz) + 0.06;
    pos.setXYZ(k * 2, defender.x + cx * (R - RING_HALF_WIDTH), y, defender.z + cz * (R - RING_HALF_WIDTH));
    pos.setXYZ(k * 2 + 1, defender.x + cx * (R + RING_HALF_WIDTH), y, defender.z + cz * (R + RING_HALF_WIDTH));
  }
  pos.needsUpdate = true;
  rangeRing.material.opacity = 0.7 + 0.25 * Math.sin(time * 4);
}

// ---- Town Halls: stone income, and a limit of one standing per Sentinel ----
// Each Defender's own standing Core gives them BUILDINGS.townhall.income stone per second.
// stone and crystals are the acting Defender's (each has their own; see useSentinel).
let stone = 0;
let crystals = 0; // the rare currency: from Quarry helpers and killing the boss (BOSS.rewardCrystals)
const standingTownHalls = () => buildings.list.filter((b) => b.type === 'townhall' && !b.destroyed && ownedHere(b)).length;
const townHallLimitReached = () => limitReached('townhall');
// Buildings with BUILDINGS[type].perSentinel (the Core and the Quarry): one standing per Defender.
const limitReached = (type) => !!BUILDINGS[type].perSentinel
  && buildings.list.filter((b) => b.type === type && !b.destroyed && ownedHere(b)).length >= BUILDINGS[type].perSentinel;
const limitText = (type) => `Each ${defenderName} can only have one ${BUILDINGS[type].name} standing`;
const stoneRate = () => buildings.list.reduce((sum, b) => // the acting Defender's own Cores
  sum + (b.type === 'townhall' && !b.destroyed && !b.constructing && ownedHere(b) ? townHallIncome(b.level || 0) : 0), 0); // a Core still being built makes nothing
// Stone per second from a Town Hall at this level: doubles each level, except where
// UPGRADES.townhall.incomeAt sets it (level 6: 128).
function townHallIncome(lv) {
  return UPGRADES.townhall.incomeAt?.[lv] ?? BUILDINGS.townhall.income * 2 ** lv;
}
// (Run for each Defender in turn: their own income; the build buttons are this screen's player's.)
function updateIncome(dt) {
  if (!defender.dead && !isClient) stone += stoneRate() * dt; // a client gets its stone from the host
  if (curSentinel !== mySentinel) return;
  for (const type of ['townhall', 'quarry']) {
    defenderHud.setBuildDisabled(type, limitReached(type), `You already have a ${BUILDINGS[type].name} (one per ${defenderName})`);
  }
  defenderHud.setStone(stone, crystals); // greys out what you can't afford
  if (buildType && limitReached(buildType)) setBuildType(buildType); // just placed it
}

// ---- Building costs (stone, and crystals for some) ----
const costOf = (type) => BUILDINGS[type].cost || 0;
const crystalCostOf = (type) => BUILDINGS[type].crystalCost || 0;
// Safety net: a destroyed Quarry always leaves its owner enough crystals to build another (its
// 10), since without a Quarry no more crystals come in. Salvaging refunds them anyway.
buildings.onDestroy = (b) => {
  if (b.type !== 'quarry' || isClient) return;
  const s = slotById(b.owner ?? sentinels[0].id); // its owner's crystals
  withSentinel(s, () => {
    if (crystals >= crystalCostOf('quarry')) return;
    crystals = crystalCostOf('quarry');
    toastOwner(s.id, `Quarry destroyed: crystals topped up to ${crystals} so you can rebuild it`);
  });
};
const canAfford = (type, count = 1) => stone >= costOf(type) * count && crystals >= crystalCostOf(type) * count;
// "6 stone", "10 crystals", "4 stone + 2 crystals" or "free".
function costText(type) {
  const parts = [];
  if (costOf(type)) parts.push(`${costOf(type)} stone`);
  if (crystalCostOf(type)) parts.push(`${crystalCostOf(type)} crystals`);
  return parts.join(' + ') || 'free';
}
// What salvaging this building gives back.
const refundText = (b) => [b.paid ? `${b.paid} stone` : '', b.paidCrystals ? `${b.paidCrystals} crystals` : ''].filter(Boolean).join(' + ') || 'nothing';
// For a dragged wall line: which of these tiles would actually be built, in order, given the
// stone on hand (each valid piece uses up its cost until the stone runs out).
function affordableTiles(type, tiles) {
  let left = Math.min(costOf(type) ? Math.floor(stone / costOf(type)) : Infinity,
    crystalCostOf(type) ? Math.floor(crystals / crystalCostOf(type)) : Infinity);
  const ok = new Set();
  for (const t of tiles) if (canBuild(type, t) && left > 0) { ok.add(t); left--; }
  return ok;
}

// Place buildings on the given tiles, then reroute the Colossus if they cut its path.
// ignoreRange: debug spawning skips the placement range, sight, the Town Hall limit and the cost.
function placeOnTiles(type, tiles, ignoreRange = false) {
  const placed = [];
  let outOfRange = false, unseen = false, broke = false;
  for (const t of tiles) {
    if (!ignoreRange && !inBuildRange(type, t)) { outOfRange = true; continue; }
    if (!ignoreRange && !inSight(type, t)) { unseen = true; continue; }
    if (!ignoreRange && limitReached(type)) { toast(limitText(type)); return; }
    if (!buildings.canPlace(type, t, attacker.tile)) continue;
    if (map.zone[t] === ZONE.BOSS && type !== 'cannon') { toast('Only turrets can be built in the boss arena (on its pads)'); continue; }
    if (!ignoreRange && !canAfford(type)) { broke = true; break; }
    if (!ignoreRange) { stone -= costOf(type); crystals -= crystalCostOf(type); }
    const b = buildings.place(type, t, curSentinel.id, curSentinel.color); // the acting Defender's, in their color
    b.paid = ignoreRange ? 0 : costOf(type); // what salvaging it gives back
    b.paidCrystals = ignoreRange ? 0 : crystalCostOf(type);
    if (!ignoreRange) startWork(b, 'build', DEFENDER.buildTime, null); // rises over buildTime (no toast: wall lines would spam)
    placed.push(...b.tiles);
  }
  if (broke) toast(`Can't afford it: ${BUILDINGS[type].name} costs ${costText(type)}${type === 'wall' ? ' per piece' : ''}`);
  else if (!placed.length && outOfRange) toast(`Too far: build within ${DEFENDER.buildRange} tiles of the ${defenderName}`);
  else if (!placed.length && unseen) toast('You can only build where you can see');
  if (!placed.length) return;
  buildings.applyFog(shownVis(), fogEnabled);
  learn(placed); // the Colossus only notices it if built where it can currently see
}

// ---- Upgrades (defenders): Town Hall, Boulder Turret and Wall, levels 1-5 ----
// Each level doubles one stat (stone income / turret damage / wall max HP) and changes the
// look a little. Walls: upgrading a piece upgrades its whole connected line (each piece that
// isn't maxed yet goes up one level, and you pay for each). What's spent counts toward salvage.
const maxLevel = (type) => UPGRADES[type].costs.length; // 15
const levelOf = (b) => b.level || 0;
// How much reaching this level multiplies the building's stat (×2 unless UPGRADES[type].mult
// says otherwise: the Turret's ×4 at 11, the Wall's ×4 at 12), and the total from level 0.
const statMult = (type, lv) => UPGRADES[type].mult?.[lv] ?? 2;
function statFactor(type, lv) {
  let f = 1;
  for (let k = 1; k <= lv; k++) f *= statMult(type, k);
  return f;
}
// "384", "1440◆" (crystals only) or "384 + 45◆".
const priceShort = (plan) => (plan.cost && plan.crystals ? `${plan.cost} + ${plan.crystals}◆`
  : plan.crystals ? `${plan.crystals}◆` : `${plan.cost}`);
const priceLong = (plan) => [plan.cost ? `${plan.cost} stone` : '', plan.crystals ? `${plan.crystals} crystals` : ''].filter(Boolean).join(' and ') || 'free';
// The pieces an upgrade would affect, and what it costs: { pieces, cost, crystals, needs }
// or null if maxed/not upgradable. needs: a building type that must be standing first, or null.
function upgradePlan(b) {
  const U = UPGRADES[b.type];
  if (!U || b.destroyed || b.isUnit) return null;
  const pieces = (b.type === 'wall' ? buildings.connectedWalls(b) : [b]).filter((x) => levelOf(x) < maxLevel(x.type));
  if (!pieces.length) return null;
  const next = levelOf(b) + 1;
  const needs = U.requires?.[next];
  const coreNeeded = U.requiresCore?.[next] || 0;
  return {
    pieces,
    cost: pieces.reduce((sum, x) => sum + U.costs[levelOf(x)], 0),
    crystals: pieces.reduce((sum, x) => sum + (U.crystals?.[levelOf(x)] || 0), 0),
    needs: needs && !buildings.list.some((x) => x.type === needs && !x.destroyed && ownedHere(x)) ? needs : null, // your own Quarry
    coreNeeds: coreNeeded > bestCoreLevel() ? coreNeeded : 0, // e.g. the Barracks upgrades
    notYours: !ownedHere(b),
  };
}
// The highest level of the acting Defender's own standing Core (-1 with none).
const bestCoreLevel = () => Math.max(-1, ...buildings.list.filter((x) => x.type === 'townhall' && !x.destroyed && !x.constructing && ownedHere(x)).map(levelOf));
// Why this upgrade can't be bought right now, or ''.
function upgradeBlocker(plan) {
  if (plan.notYours) return 'That isn\'t yours';
  if (plan.pieces.some((x) => x.constructing)) return 'Still being built';
  if (plan.pieces.some((x) => x.upgrading)) return 'Already upgrading';
  if (plan.coreNeeds) return `Needs a level-${plan.coreNeeds} Core`;
  if (plan.needs) return `Needs a ${BUILDINGS[plan.needs].name} first`;
  if (stone < plan.cost) return `Needs ${plan.cost} stone`;
  if (crystals < plan.crystals) return `Needs ${plan.crystals} crystals`;
  return '';
}
// variant: for a level that's a choice (the Turret's level 6), which one (a key of UPGRADES[type].variants).
const isVariantLevel = (b) => !!UPGRADES[b.type]?.variants && levelOf(b) === UPGRADES[b.type].variantLevel - 1;
function upgradeBuilding(b, variant) {
  if (defender.dead) return;
  const plan = upgradePlan(b);
  if (!plan) { toast('Already at the top level'); return; }
  const why = upgradeBlocker(plan);
  if (why) { toast(why); return; }
  if (isVariantLevel(b) && !UPGRADES[b.type].variants[variant]) return; // must pick one
  // Paid now; the new level lands after DEFENDER.upgradeTime (pieces lost meanwhile lose it).
  stone -= plan.cost;
  crystals -= plan.crystals;
  for (const x of plan.pieces) {
    const cost = UPGRADES[x.type].costs[levelOf(x)];
    x.paid = (x.paid || 0) + cost;            // salvage refunds upgrades too
    x.paidCrystals = (x.paidCrystals || 0) + (UPGRADES[x.type].crystals?.[levelOf(x)] || 0);
  }
  const what = plan.pieces.length > 1 ? `${plan.pieces.length} wall pieces` : BUILDINGS[b.type].name;
  toast(`Upgrading ${what} to level ${levelOf(b) + 1}: ${DEFENDER.upgradeTime}s`);
  startWork(b, 'upgrade', DEFENDER.upgradeTime, () => finishUpgrade(b, plan.pieces, variant), plan.pieces);
}
function finishUpgrade(b, pieces, variant) {
  pieces = pieces.filter((x) => !x.destroyed);
  if (!pieces.length) return;
  for (const x of pieces) {
    if (x.type === 'wall') {                  // double max HP (×4 at 12); the extra HP comes with it
      const before = x.maxHp;
      x.maxHp *= statMult('wall', levelOf(x) + 1);
      x.hp += x.maxHp - before;
    }
    if (variant) x.variant = variant;
    buildings.setLevel(x, levelOf(x) + 1);
  }
  if (b.destroyed) b = pieces[0];
  const what = pieces.length > 1 ? `${pieces.length} wall pieces` : BUILDINGS[b.type].name;
  const ascended = b.type === 'townhall' && levelOf(b) === 6;
  const faster = UPGRADES[b.type].rateAt?.[levelOf(b)];
  const V = variant && UPGRADES[b.type].variants?.[variant];
  toast(ascended ? `The Core has ascended! Level 6: ${townHallIncome(6)} stone/s`
    : V ? `Turret became a ${V.name}: ${V.effect}`
      : `${what} upgraded to level ${levelOf(b)}: ${levelEffect(b, levelOf(b))}${faster ? `, +${faster} shots/s` : ''}`, ascended ? { announce: true } : {});
  if (ascended || V) { const c = buildingCenter(b); debris.burst(c.x, c.y + (V ? 1 : 2), c.z, DEFENDER.colors[0], V ? 24 : 40); }
  checkBossTrigger(b); // a level-4 Town Hall wakes the boss
}
// The info panel's Upgrade button(s) for this building: two at a choice level (one per variant).
function upgradeActions(b) {
  if (isVariantLevel(b) && upgradePlan(b)) {
    const plan = upgradePlan(b), why = upgradeBlocker(plan);
    return Object.entries(UPGRADES[b.type].variants).map(([id, V]) => ({
      label: `${V.name} ${priceShort(plan)}`, disabled: !!why,
      title: `Level 6: turn it into a ${V.name} (${V.effect}) for ${priceLong(plan)}. You can only pick one.${why ? ` (${why})` : ''}`,
      run: () => upgradeBuilding(b, id),
    }));
  }
  return [upgradeAction(b)];
}
function upgradeAction(b) {
  if (!UPGRADES[b.type]) return { label: 'Upgrade', disabled: true, title: `${BUILDINGS[b.type].name}s can't be upgraded yet` };
  const plan = upgradePlan(b);
  if (!plan) return { label: 'Max level', disabled: true, title: `Level ${maxLevel(b.type)} is the top` };
  const line = plan.pieces.length > 1 ? ` (${plan.pieces.length} pcs)` : '';
  const price = priceShort(plan);
  const why = upgradeBlocker(plan);
  return {
    label: `${b.type === 'townhall' && levelOf(b) === 5 ? 'Ascend' : 'Upgrade'} ${price}${line}`,
    disabled: !!why,
    title: `${b.type === 'townhall' ? `Stone income → ${townHallIncome(levelOf(b) + 1)}/s` : levelEffect(b, levelOf(b) + 1)}${UPGRADES[b.type].rateAt?.[levelOf(b) + 1] ? ` and +${UPGRADES[b.type].rateAt[levelOf(b) + 1]} shots/s` : ''} for ${priceLong(plan)}${why ? ` (${why})` : ''}`,
    run: () => upgradeBuilding(b),
  };
}
// What reaching level `to` does for this building (not the Core: its income is shown instead).
// "damage ×2", "max HP ×4", or for the Shard Storm's speed steps and beam their own wording.
function levelEffect(b, to) {
  if (b.type === 'barracks') return `unlocks the ${barracksUnlock(to).map((t) => TROOPS[t].name).join(' and ') || 'nothing new'}`;
  const V = b.type === 'cannon' && UPGRADES.cannon.variants[b.variant];
  if (V?.speedUntil && to > (UPGRADES.cannon.variantLevel || 6) && to <= V.speedUntil) {
    return `attack speed ×2${to === 7 ? ', shards fly straight' : ''}`;
  }
  if (V?.beamAt === to) return `becomes a continuous crystal beam, damage ×${statMult(b.type, to)}`;
  return `${UPGRADES[b.type].stat} ×${statMult(b.type, to)}`;
}
// Info-panel line describing a building's level and what the next one gives.
function upgradeLines(b) {
  if (!UPGRADES[b.type]) return [];
  const lv = levelOf(b), max = maxLevel(b.type);
  const now = b.type === 'townhall' ? `${townHallIncome(lv)} stone/s`
    : b.type === 'barracks' ? `trains ${TROOP_TYPES.filter((t) => (TROOPS[t].barracksLevel || 0) <= lv).length} kinds of troop`
      : b.type === 'cannon' ? (b.variant === 'storm' ? `${Math.round(turretDps(b))} damage/s` : `${turretDamage(b)} damage`) : `${b.maxHp} max HP`;
  const faster = UPGRADES[b.type].rateAt?.[lv + 1];
  const next = b.type === 'townhall' ? `next: ${townHallIncome(lv + 1)} stone/s`
    : isVariantLevel(b) ? 'next: pick a level-6 turret below'
      : `next: ${levelEffect(b, lv + 1)}${faster ? ` and +${faster} shots/s` : ''}`;
  const title = lv >= 6 ? (b.type === 'townhall' ? ' (Ascended)' : b.variant ? ` (${UPGRADES[b.type].variants[b.variant].name})` : '') : '';
  const lines = [`Level ${lv}/${max}${title}: ${now}${lv < max ? ` (${next})` : ' (max)'}`];
  if (isVariantLevel(b)) {
    const U = UPGRADES[b.type];
    lines.push(Object.values(U.variants).map((V) => `${V.name}: ${V.effect}`).join(' · ')
      + ` (each ${U.costs[lv]} stone${U.crystals?.[lv] ? ` + ${U.crystals[lv]} crystals` : ''})`);
  }
  const needs = UPGRADES[b.type].requires?.[lv + 1];
  if (needs && lv < max) {
    const has = buildings.list.some((x) => x.type === needs && !x.destroyed && ownedHere(x));
    lines.push(`Level ${lv + 1} needs a ${BUILDINGS[needs].name}${has ? ' ✓' : ''} and ${UPGRADES[b.type].crystals[lv]} crystals`);
  }
  return lines;
}

// ---- Salvage (defenders): take a building apart for a refund ----
// Press Salvage in the info panel: after DEFENDER.salvageTime seconds the building is taken
// apart (no rubble) and what was paid for it comes back as stone. If the Colossus destroys
// it first, there's no refund. A ring filling up on the ground shows the countdown.
const salvaging = new Map(); // building -> { t, ring }
const salvageMat = new THREE.MeshBasicMaterial({ color: 0xe8c25a, transparent: true, opacity: 0.85, depthTest: false, side: THREE.DoubleSide });
function buildingCenter(b) {
  const S = map.size;
  return {
    x: b.tiles.reduce((a, t) => a + t % S + 0.5, 0) / b.tiles.length,
    z: b.tiles.reduce((a, t) => a + ((t / S) | 0) + 0.5, 0) / b.tiles.length,
    y: buildings.groundY(b.tiles[0]), // halfway up for a wall on a ramp
  };
}
function startSalvage(b) {
  if (b.destroyed || salvaging.has(b)) return;
  if (!ownedHere(b)) { toast('That isn\'t yours'); return; }
  const ring = new THREE.Mesh(new THREE.BufferGeometry(), salvageMat);
  ring.rotation.x = -Math.PI / 2;
  ring.renderOrder = 6;
  const c = buildingCenter(b);
  ring.position.set(c.x, c.y + 0.05, c.z);
  scene.add(ring);
  salvaging.set(b, { t: 0, ring });
  toast(`Salvaging ${BUILDINGS[b.type].name}: ${DEFENDER.salvageTime}s`);
}
function cancelSalvage(b) {
  const s = salvaging.get(b);
  if (!s) return;
  scene.remove(s.ring);
  s.ring.geometry.dispose();
  salvaging.delete(b);
}
function updateSalvage(dt) {
  for (const [b, s] of salvaging) {
    if (b.destroyed) { cancelSalvage(b); if (!b.salvaged) toast(`${BUILDINGS[b.type].name} was destroyed: no refund`); continue; }
    s.t += dt;
    const k = Math.min(1, s.t / DEFENDER.salvageTime), r = Math.sqrt(b.tiles.length) * 0.5 + 0.25;
    s.ring.geometry.dispose();
    s.ring.geometry = new THREE.RingGeometry(r, r + 0.1, 40, 1, Math.PI / 2, -k * Math.PI * 2); // fills clockwise
    s.ring.visible = controlled === defender || !fogEnabled || b.tiles.some((t) => vis[t] === 2);
    if (k < 1) continue;
    // Done: take it apart and refund it.
    cancelSalvage(b);
    const c = buildingCenter(b);
    debris.burst(c.x, c.y + 0.3, c.z, 0x9c8f7a, 14);
    buildings.remove(b);
    withSentinel(slotById(b.owner ?? sentinels[0].id), () => { stone += b.paid || 0; crystals += b.paidCrystals || 0; }); // back to its owner
    learn(b.tiles); // the Colossus notices if it can see the spot
    if (selected === b) select(null);
    if (repair && repair.target === b) repair = null;
    toastOwner(b.owner, `${BUILDINGS[b.type].name} salvaged${b.paid || b.paidCrystals ? `: +${refundText(b)}` : ''}`);
  }
}

// ---- Building and upgrading take time (DEFENDER.buildTime / upgradeTime) ----
// A new building rises out of the ground, starting at 10% health and filling up; until it's
// done it doesn't work (b.constructing). An upgrade is paid up front and lands when its time is
// up (b.upgrading on every piece in it). A team-colored ring on the ground fills as it goes.
const works = new Map(); // building -> { kind: 'build' | 'upgrade', t, total, ring, done, pieces }
const workMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(DEFENDER.colors[0]).lerp(new THREE.Color(0xffffff), 0.35),
  transparent: true, opacity: 0.85, depthTest: false, side: THREE.DoubleSide });
function startWork(b, kind, total, done, pieces = [b]) {
  const ring = new THREE.Mesh(new THREE.BufferGeometry(), workMat);
  ring.rotation.x = -Math.PI / 2;
  ring.renderOrder = 6;
  const c = buildingCenter(b);
  ring.position.set(c.x, c.y + 0.06, c.z);
  scene.add(ring);
  works.set(b, { kind, t: 0, total, ring, done, pieces });
  for (const x of pieces) { if (kind === 'build') x.constructing = true; else x.upgrading = true; }
  if (kind === 'build') { b.hp = Math.max(1, b.maxHp * 0.1); buildings.ensureBar(b); setBuildK(b, 0); }
}
function endWork(b) {
  const w = works.get(b);
  if (!w) return;
  scene.remove(w.ring);
  w.ring.geometry.dispose();
  works.delete(b);
  for (const x of w.pieces) { x.constructing = false; x.upgrading = false; }
  if (w.kind === 'build') setBuildK(b, 1);
}
// How far a building has risen (0..1): meshes grow up from the ground, walls are redrawn.
function setBuildK(b, k) {
  b.buildK = k;
  if (b.mesh) b.mesh.scale.set(1, 0.08 + 0.92 * k, 1);
  if (b.type === 'wall') buildings.rebuildWalls(buildings.lastVis, buildings.lastFog);
}
function updateWorks(dt) {
  for (const [b, w] of works) {
    if (b.destroyed) { endWork(b); continue; } // lost: an upgrade paid for is lost with it
    w.t += dt;
    const k = Math.min(1, w.t / w.total), r = Math.sqrt(b.tiles.length) * 0.5 + 0.18;
    w.ring.geometry.dispose();
    w.ring.geometry = new THREE.RingGeometry(r, r + 0.08, 40, 1, Math.PI / 2, -k * Math.PI * 2);
    w.ring.visible = controlled === defender || !fogEnabled || b.tiles.some((t) => vis[t] === 2);
    if (w.kind === 'build') {
      b.hp = Math.min(b.maxHp, b.hp + b.maxHp * 0.9 * (dt / w.total)); // fills from 10% as it rises
      setBuildK(b, k);
    }
    if (k < 1) continue;
    endWork(b);
    if (w.kind === 'build' && b.hp >= b.maxHp && b.bar) { scene.remove(b.bar); b.bar = null; }
    w.done?.();
  }
}
const workLine = (b) => {
  const w = works.get(b) || [...works.values()].find((x) => x.pieces.includes(b));
  return w ? [`${w.kind === 'build' ? 'Building' : 'Upgrading'}: ${Math.max(0, w.total - w.t).toFixed(1)}s`] : [];
};

// ---- Troops: summoned at a Barracks ----
// Select a Barracks and click a unit button: the stone is paid up front, and the troop forms
// next to the Barracks after its training time, then walks to the Barracks' rally point
// (right-click the ground with the Barracks selected). Up to QUEUE_MAX waiting per Barracks.
// TROOPS.cap counts troops alive plus those in training. A lost Barracks loses its queue.
const TROOP_TYPES = ['pebble', 'slinger', 'lancer', 'warden'];
const QUEUE_MAX = 5;
// The acting Defender's own troops: alive, plus in training at their Barracks (their cap).
const queuedTroops = () => buildings.list.reduce((n, b) => n + (b.destroyed || !ownedHere(b) ? 0 : (b.queue?.length || 0)), 0);
const troopCount = () => troops.alive.filter(ownedHere).length + queuedTroops();
// The troops a Barracks level unlocks.
const barracksUnlock = (lv) => TROOP_TYPES.filter((t) => (TROOPS[t].barracksLevel || 0) === lv);
// "4 stone", "25000 stone + 1500 crystals".
const troopPrice = (cfg) => `${cfg.cost} stone${cfg.crystalCost ? ` + ${cfg.crystalCost} crystals` : ''}`;
// Why this unit can't be queued right now, or '' if it can.
function trainBlocker(b, type) {
  const cfg = TROOPS[type];
  if (!ownedHere(b)) return 'That Barracks isn\'t yours';
  if (defender.dead) return `The ${defenderName} has fallen`;
  if (levelOf(b) < (cfg.barracksLevel || 0)) {
    const lv = cfg.barracksLevel, core = UPGRADES.barracks.requiresCore?.[lv];
    return `Needs a level-${lv} Barracks${core ? ` (which needs a level-${core} Core)` : ''}`;
  }
  if (b.constructing) return 'Still being built';
  if ((b.queue?.length || 0) >= QUEUE_MAX) return `Queue full (${QUEUE_MAX})`;
  if (troopCount() >= TROOPS.cap) return `Troop limit reached (${TROOPS.cap})`;
  if (stone < cfg.cost) return `Needs ${cfg.cost} stone`;
  if (crystals < (cfg.crystalCost || 0)) return `Needs ${cfg.crystalCost} crystals`;
  return '';
}
function trainTroop(b, type) {
  if (b.destroyed || b.type !== 'barracks') return;
  const why = trainBlocker(b, type);
  if (why) { toast(why); return; }
  stone -= TROOPS[type].cost;
  crystals -= TROOPS[type].crystalCost || 0;
  (b.queue ||= []).push({ type, t: 0 });
}
// Cancel one queued troop (the last one by default), with a full refund.
function cancelTraining(b, index = (b.queue?.length || 0) - 1) {
  if (!b.queue?.[index] || !ownedHere(b)) return;
  const [item] = b.queue.splice(index, 1);
  const cfg = TROOPS[item.type];
  stone += cfg.cost;
  crystals += cfg.crystalCost || 0;
  toast(`Cancelled ${cfg.name} (+${troopPrice(cfg)})`);
}
function setRally(b, tile) {
  if (tile < 0 || !ownedHere(b)) return;
  b.rally = tile;
  const S = map.size;
  showMarker(tile % S + 0.5, ((tile / S) | 0) + 0.5, curSentinel.color);
  toast('Rally point set');
}
function updateTraining(dt) {
  const S = map.size;
  for (const b of buildings.list) {
    if (!b.queue?.length) continue;
    if (b.destroyed) { b.queue = []; continue; }
    const item = b.queue[0], cfg = TROOPS[item.type];
    item.t = Math.min(cfg.trainTime, item.t + dt);
    if (item.t < cfg.trainTime) continue;
    const tile = troops.spawnTile(b.tiles);
    if (tile < 0) continue; // no room next to it: wait
    b.queue.shift();
    const owner = slotById(b.owner ?? sentinels[0].id); // the Barracks' owner's troop, in their color
    const u = troops.spawn(item.type, tile % S + 0.5, ((tile / S) | 0) + 0.5, owner.id, owner.color);
    debris.burst(u.x, map.heightAt(u.x, u.z) + 0.2, u.z, 0x857d70, 8);
    if (b.rally >= 0) troops.orderMove([u], b.rally);
  }
}
// The Colossus, if the defenders can see it at (or right next to) this tile.
function colossusAt(tile) {
  if (tile < 0 || attacker.dead || defVis[attacker.tile] !== 2) return false;
  const S = map.size;
  return Math.hypot(tile % S + 0.5 - attacker.x, ((tile / S) | 0) + 0.5 - attacker.z) < 1.4;
}
// Right-click with troops selected: attack the Colossus, or move there (spread out).
function commandTroops(group, tile) {
  if (bossAt(tile, defVis)) {
    troops.orderAttack(group, boss);
    showMarker(boss.x, boss.z, 0xb48cff);
    return;
  }
  if (colossusAt(tile)) {
    troops.orderAttack(group);
    showMarker(attacker.x, attacker.z, 0xff5a3d);
    return;
  }
  if (!troops.orderMove(group, tile)) { toast('Can\'t get there'); return; }
  const S = map.size;
  showMarker(tile % S + 0.5, ((tile / S) | 0) + 0.5, DEFENDER.colors[0]);
}
const TROOP_STATUS = { idle: 'Holding', move: 'Moving', attack: 'Attacking the Colossus', engage: 'Fighting the Colossus', return: 'Returning' };
const troopStats = (cfg) => `${cfg.damage} dmg every ${(1 / cfg.rate).toFixed(2)}s, ${cfg.range < 1 ? 'melee' : `range ${cfg.range}`}${cfg.lifetime ? `, lasts ${cfg.lifetime}s` : ''}`;
// Short numbers for the cards: 1500 → 1.5k, 2000000 → 2M.
const shortNum = (n) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${+(n / 1e3).toFixed(1)}k` : `${+n.toFixed(1)}`);
// Info panel for the selected troops.
function troopInfo(group) {
  const one = group.length === 1 ? group[0] : null;
  const counts = TROOP_TYPES.map((t) => [t, group.filter((u) => u.type === t).length]).filter(([, n]) => n);
  return {
    id: `troops:${group.map((u) => u.id).join(',')}`,
    kind: 'selected', kindLabel: one ? 'Troop' : 'Troops',
    title: one ? one.name : `${group.length} troops`,
    subtitle: one ? (one.foe && one.mode === 'attack' ? `Attacking the ${one.foe.name}` : TROOP_STATUS[one.mode]) : counts.map(([t, n]) => `${n} ${TROOPS[t].name}${n > 1 ? 's' : ''}`).join(' · '),
    hp: group.reduce((a, u) => a + u.hp, 0), maxHp: group.reduce((a, u) => a + u.maxHp, 0),
    lines: [...counts.map(([t]) => `${one ? '' : `${TROOPS[t].name}: `}${troopStats(TROOPS[t])}`),
      ...(one && one.cfg.lifetime ? [`Crumbles in ${Math.ceil(one.life)}s`] : [])],
    actions: [{ label: 'Stop', title: 'Stand where they are', run: () => stopTroops(group) }],
  };
}
// Info-panel lines and buttons for a selected Barracks.
function barracksLines(b) {
  const q = b.queue || [];
  return [`Troops ${troopCount()} / ${TROOPS.cap}`, `Queue ${q.length} / ${QUEUE_MAX}`,
    b.rally >= 0 ? 'Rally point set (right-click to move it)' : 'Right-click the ground to set a rally point'];
}
// The training menu: a card per troop (name, price, training time, health, damage per second,
// range; locked ones say what unlocks them), then the queue, one chip per troop (the first
// counts down with a bar; click any chip to cancel it for a full refund).
const TROOP_DOT = { pebble: '#857d70', slinger: '#6ea0e8', lancer: '#d9d3e0', warden: '#ffc93c' };
function barracksActions(b) {
  const acts = TROOP_TYPES.map((type) => {
    const cfg = TROOPS[type], why = trainBlocker(b, type);
    const locked = levelOf(b) < (cfg.barracksLevel || 0);
    const price = `${shortNum(cfg.cost)} stone${cfg.crystalCost ? ` + ${shortNum(cfg.crystalCost)}◆` : ''}`;
    const dps = shortNum(cfg.damage * cfg.rate);
    const stats = `${shortNum(cfg.hp)} HP · ${dps} dmg/s · ${cfg.range < 1 ? 'melee' : `range ${cfg.range}`}${cfg.lifetime ? ` · ${cfg.lifetime}s` : ''}`;
    return {
      label: `${cfg.name}|${locked ? 'locked' : price}`, disabled: !!why, className: `hire troop-card${locked ? ' locked' : ''}`,
      html: `<span class="hire-name"><i class="ore-dot" style="background:${TROOP_DOT[type]}"></i>${cfg.name}</span>`
        + (locked
          ? `<small>🔒 Barracks lvl ${cfg.barracksLevel}${UPGRADES.barracks.requiresCore?.[cfg.barracksLevel] ? ` · Core ${UPGRADES.barracks.requiresCore[cfg.barracksLevel]}` : ''}</small>`
          : `<small>${price} · ${cfg.trainTime}s</small>`)
        + `<small class="troop-stats">${stats}</small>`,
      title: `${cfg.name}: ${cfg.hp} HP, ${troopStats(cfg)}. ${troopPrice(cfg)}, trains in ${cfg.trainTime}s.${why ? ` (${why})` : ''}`,
      run: () => trainTroop(b, type),
    };
  });
  // The queue.
  (b.queue || []).forEach((item, k) => {
    const cfg = TROOPS[item.type], k1 = k === 0 ? Math.min(1, item.t / cfg.trainTime) : 0;
    const left = Math.max(0, Math.ceil(cfg.trainTime - item.t));
    acts.push({
      label: `q${k}|${item.type}|${k === 0 ? Math.round(k1 * 20) : '-'}`, // redraws every 5% of progress
      className: `queue-chip${k === 0 ? ' training' : ''}`,
      html: `<i class="q-fill" style="width:${(k1 * 100).toFixed(0)}%"></i><span>${k === 0 ? `${cfg.name} ${left}s` : cfg.name}</span><b>✕</b>`,
      title: `${k === 0 ? 'Training' : 'Queued'}: ${cfg.name}. Click to cancel (refunds ${troopPrice(cfg)})`,
      run: () => cancelTraining(b, k),
    });
  });
  return acts;
}

// ---- Quarry workers ----
// Select a Quarry and hire the next worker (QUARRY_WORKERS.list, in order, paid in stone). It
// forms beside the Quarry and starts mining. A lost worker is hired again the same way: the
// button always offers the first one you don't have.
const workerDef = (tier) => QUARRY_WORKERS.list[tier - 1];
const workerName = (def) => `${def.ore} Helper`;
// The name as HTML: the New Hematite Helper's words start with ornate capitals.
const workerNameHtml = (def) => (def.fancy
  ? `<span class="fancy-name">${workerName(def).split(' ').map((w) => `<span class="fancy-cap">${w[0]}</span>${w.slice(1)}`).join(' ')}</span>`
  : workerName(def));
// The acting Defender's own Quarry and helpers (each has their own cap).
const standingQuarries = () => buildings.list.filter((b) => b.type === 'quarry' && !b.destroyed && ownedHere(b));
const helperCapReached = () => workers.alive.filter(ownedHere).length >= QUARRY_WORKERS.cap;
const plural = (n) => (n === 1 ? '' : 's');
// Play a sound file (path relative to the page). Each file is loaded once; a hire click is a
// user gesture, so browsers allow it to play.
const sounds = new Map();
function playSound(src) {
  let a = sounds.get(src);
  if (!a) { a = new Audio(src); a.preload = 'auto'; sounds.set(src, a); }
  a.currentTime = 0;
  a.play().catch(() => {}); // blocked or missing: stay silent
}
for (const def of QUARRY_WORKERS.list) if (def.sound) sounds.set(def.sound, Object.assign(new Audio(def.sound), { preload: 'auto' })); // no delay on the first hire
// Hire a helper of this kind (1-7) at the Quarry: any kind, any time, up to the cap.
function hireWorker(q, tier) {
  if (q.destroyed || defender.dead) return;
  if (!ownedHere(q)) { toast('That Quarry isn\'t yours'); return; }
  const def = workerDef(tier);
  if (helperCapReached()) { toast(`Helper limit reached (${QUARRY_WORKERS.cap})`); return; }
  if (stone < def.cost) { toast(`${workerName(def)} costs ${def.cost} stone`); return; }
  const tile = troops.spawnTile(q.tiles);
  if (tile < 0) { toast('No room beside the Quarry'); return; }
  stone -= def.cost;
  const S = map.size;
  const w = workers.spawn(tier, tile % S + 0.5, ((tile / S) | 0) + 0.5, curSentinel.id);
  debris.burst(w.x, map.heightAt(w.x, w.z) + 0.2, w.z, def.glow, 10);
  if (def.sound) playSound(def.sound);
  const gain = `mines ${def.rate} crystal${plural(def.rate)}/s`;
  toast(`Hired the ${workerName(def)}: ${gain}`, { html: `Hired the ${workerNameHtml(def)}: ${gain}` });
}
function updateWorkers(dt) {
  const S = map.size;
  // Every Defender's Quarry (each helper works for its own owner's).
  const quarries = buildings.list.filter((b) => b.type === 'quarry' && !b.destroyed).map((b) => {
    const x = b.tiles.reduce((a, t) => a + t % S + 0.5, 0) / b.tiles.length;
    const z = b.tiles.reduce((a, t) => a + ((t / S) | 0) + 0.5, 0) / b.tiles.length;
    return { x, z, tile: b.tiles[0], owner: b.owner ?? sentinels[0].id };
  });
  // Crystals come only from helpers swinging at a rock, and go to each helper's owner.
  workers.update(dt, { quarries, crystals: map.crystals, camera: cam.camera });
  const minedBy = new Map();
  for (const w of workers.alive) if (w.earning) minedBy.set(w.owner ?? sentinels[0].id, (minedBy.get(w.owner ?? sentinels[0].id) || 0) + w.earning * dt);
  for (const [owner, amount] of minedBy) { const s = slotById(owner); if (!s.unit.dead) withSentinel(s, () => { crystals += amount; }); }
  for (const s of workers.strikes) debris.burst(s.x, map.heightAt(s.x, s.z) + 0.3, s.z, s.color, 4);
  for (const w of selUnits) if (w.isWorker && w.dead) selUnits.delete(w);
  updateHelperLabel();
}
// "Helpers 3/10" floating above the Quarry (the defenders' view only).
const helperLabel = (() => {
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 64;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sprite.scale.set(2.4, 0.6, 1);
  sprite.renderOrder = 12;
  sprite.visible = false;
  scene.add(sprite);
  return { canvas, tex, sprite, text: '' };
})();
function updateHelperLabel() {
  const q = standingQuarries()[0], L = helperLabel; // (your own Quarry: called with yours acting)
  L.sprite.visible = !!q && controlled !== attacker && !spectating;
  if (!q) return;
  const n = workers.alive.filter(ownedHere).length, cap = QUARRY_WORKERS.cap, text = `Helpers ${n}/${cap}`;
  if (text !== L.text) {
    L.text = text;
    const g = L.canvas.getContext('2d');
    g.clearRect(0, 0, 256, 64);
    g.fillStyle = 'rgba(12, 14, 20, 0.72)';
    g.beginPath(); g.roundRect(8, 6, 240, 52, 14); g.fill();
    g.font = '700 30px Cinzel, Georgia, serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = n >= cap ? '#ff9c7a' : '#d9c8ff';
    g.fillText(text, 128, 33);
    L.tex.needsUpdate = true;
  }
  const S = map.size;
  const x = q.tiles.reduce((a, t) => a + t % S + 0.5, 0) / q.tiles.length;
  const z = q.tiles.reduce((a, t) => a + ((t / S) | 0) + 0.5, 0) / q.tiles.length;
  L.sprite.position.set(x, buildings.groundY(q.tiles[0]) + BUILDINGS.quarry.height + 1.3, z);
}
const fmtRate = (r) => +r.toFixed(2);
const crystalRate = () => fmtRate(workers.alive.filter(ownedHere).reduce((s, w) => s + w.earning, 0)); // your own helpers'
// Info-panel lines and the hire button for a selected Quarry.
function quarryLines() {
  const crew = workers.alive.filter(ownedHere), mining = crew.filter((w) => w.state === 'mine').length;
  return [`Helpers ${crew.length}/${QUARRY_WORKERS.cap}, ${mining} mining: +${crystalRate()} crystals/s`,
    `Gold crystal rocks give ×${QUARRY_WORKERS.goldBonus}`];
}
const WORKER_STATUS = { walk: 'Walking to a crystal rock', move: 'Moving', idle: 'Idle', mine: 'Mining' };
function workerStatus(w) {
  if (w.state === 'mine') return `Mining ${map.rareCrystals.has(w.target) ? 'gold' : 'crystal'}: +${fmtRate(w.earning)}/s`;
  if (w.state === 'idle' && !standingQuarries().length) return 'Idle: no Quarry';
  if (w.state === 'idle' && w.order !== 'hold' && w.target < 0) return 'Idle: no free crystal rock nearby';
  return WORKER_STATUS[w.state];
}
// Right-click with workers selected: a crystal rock = mine it, the Quarry = mine on their own,
// anywhere else = move there and wait.
function commandWorkers(group, tile) {
  const S = map.size;
  if (map.crystals.includes(tile)) {
    // One worker per rock: the closest takes it, the rest take the free rocks nearest it.
    const cx = tile % S + 0.5, cz = ((tile / S) | 0) + 0.5;
    const byDist = [...group].sort((a, b) => Math.hypot(a.x - cx, a.z - cz) - Math.hypot(b.x - cx, b.z - cz));
    workers.orderMine(byDist[0], tile);
    for (const w of byDist.slice(1)) workers.orderAuto(w, tile);
    showMarker(tile % S + 0.5, ((tile / S) | 0) + 0.5, map.rareCrystals.has(tile) ? 0xffd75e : 0xb48cff);
    return;
  }
  const b = buildings.at(tile);
  if (b && b.type === 'quarry' && !b.destroyed) { for (const w of group) workers.orderAuto(w); showMarker(tile % S + 0.5, ((tile / S) | 0) + 0.5, DEFENDER.colors[0]); return; }
  const slots = troops.formation(tile, group.length);
  let ok = 0;
  group.forEach((w, k) => { if (slots.length && workers.orderMove(w, slots[k % slots.length])) ok++; });
  if (!ok) { toast('Can\'t get there'); return; }
  showMarker(tile % S + 0.5, ((tile / S) | 0) + 0.5, DEFENDER.colors[0]);
}
// Dismissing helpers refunds QUARRY_WORKERS.dismissRefund of what they cost.
const dismissRefund = (group) => group.reduce((a, w) => a + Math.floor(w.def.cost * QUARRY_WORKERS.dismissRefund), 0);
// Named so they can be sent to the host as commands (multiplayer).
function workersMine(group) { group.forEach((w) => workers.orderAuto(w)); }
function workersStop(group) { group.forEach((w) => workers.stop(w)); }
function stopTroops(group) { troops.stop(group); }
function dismissWorkers(group) {
  const live = group.filter((w) => !w.dead);
  if (!live.length) return;
  const refund = dismissRefund(live);
  stone += refund;
  for (const w of live) {
    debris.burst(w.x, map.heightAt(w.x, w.z) + 0.3, w.z, w.def.glow, 8);
    workers.dismiss(w);
    selUnits.delete(w);
  }
  refreshUnitRings();
  const one = live.length === 1 ? live[0] : null;
  toast(one ? `Dismissed the ${one.name}: +${refund} stone` : `Dismissed ${live.length} helpers: +${refund} stone`,
    one ? { html: `Dismissed the ${workerNameHtml(one.def)}: +${refund} stone` } : {});
}
function workerInfo(group) {
  const one = group.length === 1 ? group[0] : null;
  const rate = fmtRate(group.reduce((a, w) => a + w.earning, 0));
  return {
    id: `workers:${group.map((w) => w.id).join(',')}`,
    kind: 'selected', kindLabel: one ? 'Worker' : 'Workers',
    title: one ? one.name : `${group.length} workers`,
    titleHtml: one ? workerNameHtml(one.def) : null,
    subtitle: one ? workerStatus(one) : `${group.filter((w) => w.state === 'mine').length} mining: +${rate} crystals/s`,
    hp: group.reduce((a, w) => a + w.hp, 0), maxHp: group.reduce((a, w) => a + w.maxHp, 0),
    lines: [
      ...(one ? [`Mines ${one.def.rate} crystal${plural(one.def.rate)}/s (×${QUARRY_WORKERS.goldBonus} on gold)`] : []),
      'One helper per crystal rock. Right-click a rock to mine it, the Quarry to mine on their own, or the ground to move',
    ],
    actions: [
      { label: 'Mine', title: 'Go back to mining the rock nearest the Quarry', run: () => workersMine(group) },
      { label: 'Stop', title: 'Stand where they are (no mining)', run: () => workersStop(group) },
      { label: `Dismiss +${dismissRefund(group)}`,
        title: `Send ${one ? 'this helper' : 'these helpers'} away for ${Math.round(QUARRY_WORKERS.dismissRefund * 100)}% of the stone back (${dismissRefund(group)} stone), freeing ${one ? 'its place' : 'their places'} under the cap`,
        run: () => dismissWorkers(group) },
    ],
  };
}
// Two layers: the Quarry shows one "Hire helper" button; it opens a two-column picker with
// one button per kind (like the Barracks' training buttons) and a Back button.
let quarryMenuOpen = false;
function quarryActions(q) {
  const full = helperCapReached();
  if (!quarryMenuOpen) {
    return [{ label: full ? `Helpers full (${QUARRY_WORKERS.cap})` : 'Hire helper ▸', disabled: full,
      title: full ? 'Helper limit reached' : 'Choose a helper to hire', run: () => { quarryMenuOpen = true; refreshHud(); } }];
  }
  const back = { label: '◂ Back', className: 'back', title: 'Close the helper list', run: () => { quarryMenuOpen = false; refreshHud(); } };
  return [...QUARRY_WORKERS.list.map((def, k) => {
    const poor = stone < def.cost;
    return {
      label: `${workerName(def)} · ${def.cost} stone`,
      className: def.fancy ? 'hire wide' : 'hire',
      html: `<span class="hire-name"><i class="ore-dot" style="background:${hexColor(def.glow)};color:${hexColor(def.glow)}"></i>${workerNameHtml(def)}</span><small>${def.cost.toLocaleString('en-US')} stone · ${def.rate}/s</small>`,
      disabled: poor || full,
      title: `${workerName(def)}: mines ${def.rate} crystal${plural(def.rate)} per second while mining (×${QUARRY_WORKERS.goldBonus} on gold rocks)`
        + (full ? ` (helper limit ${QUARRY_WORKERS.cap} reached)` : poor ? ' (not enough stone)' : ''),
      run: () => hireWorker(q, k + 1),
    };
  }), back];
}

// ---- The Colossus attacking buildings (nothing fights back yet) ----
// Right-click a building or wall: the Colossus walks into reach and slams it. Each hit deals
// colossusDamage() and earns that much gold. It can reach up to one level above or below.
const debris = new Debris(scene);
{ // Bursts of debris and sparks only show where this screen can see.
  const burst = debris.burst.bind(debris);
  debris.burst = (x, y, z, ...rest) => { if (seesNow(x, z)) burst(x, y, z, ...rest); };
}
let gold = 0;
let platinum = 0; // the late-game currency (items XI-XV), traded for gold in the temple

// ---- The temple shop and the Colossus's inventory ----
// Items (SHOP in config.js) are bought in the temple and held in INVENTORY_SLOTS slots.
// Heavy Fists and Regen Cores stack (their effects add up); for Stone Armor only the best
// one counts. Items sell back for their full price in the temple.
const inventory = new Array(INVENTORY_SLOTS).fill(null); // each: { kind, tier } (tier 1-5) or null
const shopItem = (id) => SHOP.find((s) => s.id === id);
const itemName = (it) => `${itemTierName(shopItem(it.kind), it.tier)} ${ROMAN[it.tier - 1]}`;
const itemPrice = (it) => shopItem(it.kind).costs[it.tier - 1];
const held = (kind) => inventory.filter((it) => it && it.kind === kind);
// The value of the best item of this kind you hold (only the best one counts), or `none`.
const best = (kind, none) => Math.max(none, ...held(kind).map((it) => shopItem(kind).values[it.tier - 1]));
const colossusDamage = () => best('damage', ATTACKER.damage);  // Heavy Fists: damage per hit
const colossusArmor = () => best('armor', 0);                  // Stone Armor
const colossusRegen = () => best('regen', 0);                  // Regen Core (out of combat)
const colossusMaxHp = () => ATTACKER.hp + best('maxHp', 0);    // Titan Heart
// Regen only works out of combat: REGEN_DELAY seconds after the Colossus was last hit.
const regenActive = () => !attacker.dead && colossusRegen() > 0 && clock.elapsedTime - lastHitAt >= REGEN_DELAY;
// After buying or selling: a bigger max adds that much current health too; a smaller one
// trims current health to fit (never below 1).
function applyMaxHp() {
  const max = colossusMaxHp(), diff = max - attacker.maxHp;
  if (!diff) return;
  attacker.maxHp = max;
  if (attacker.dead) return;
  attacker.hp = diff > 0 ? attacker.hp + diff : Math.max(1, Math.min(attacker.hp, max));
}
// Hits per second: the base rate plus the best Swift Strikes item (they don't stack).
const colossusRate = () => ATTACKER.attackRate
  + Math.max(0, ...held('attackSpeed').map((it) => shopItem('attackSpeed').values[it.tier - 1]));
const inTemple = () => !attacker.dead && map.zone[attacker.tile] === ZONE.RUIN;
// What buying this item would do: { slot, swap (an item it replaces, or null), cost } or a
// reason it can't be bought. With no free slot, a higher tier replaces your lowest item of
// the same kind (you pay the difference, since items sell for full price).
// The currency an item is priced in ('gold', or 'platinum' for XI-XV), and spending/adding it.
const itemCur = (it) => itemCurrency(shopItem(it.kind), it.tier);
const purse = (cur) => (cur === 'platinum' ? platinum : gold);
function addCurrency(cur, n) { if (cur === 'platinum') platinum += n; else gold += n; }
// cur: what it costs ('gold' or 'platinum'). A swap within one currency pays the difference;
// a swap across them (a gold X replaced by a platinum XI) refunds the old item in gold and
// pays the new one in full (refund).
function buyPlan(kind, tier) {
  const item = shopItem(kind);
  if (!item || !item.costs[tier - 1]) return { why: 'Not available yet' };
  const price = item.costs[tier - 1], cur = itemCurrency(item, tier);
  let slot = inventory.indexOf(null), swap = null;
  if (slot < 0) {
    const lower = inventory.map((it, k) => [it, k]).filter(([it]) => it.kind === kind && it.tier < tier)
      .sort((a, b) => a[0].tier - b[0].tier)[0];
    if (!lower) return { why: `Inventory full (${INVENTORY_SLOTS} slots): sell something first` };
    [swap, slot] = lower;
  }
  const same = swap && itemCur(swap) === cur;
  const cost = price - (same ? itemPrice(swap) : 0);
  const refund = swap && !same ? { cur: itemCur(swap), amount: itemPrice(swap) } : null;
  if (!inTemple()) return { slot, swap, cost, cur, refund, why: 'Return to the temple to shop' };
  if (purse(cur) < cost) return { slot, swap, cost, cur, refund, why: cur === 'platinum' ? `Needs ${cost} platinum (trade gold for it in the shop)` : `Needs ${cost} gold` };
  return { slot, swap, cost, cur, refund, why: '' };
}
function buyItem(kind, tier) {
  const plan = buyPlan(kind, tier);
  if (plan.why) { toast(plan.why); return; }
  addCurrency(plan.cur, -plan.cost);
  if (plan.refund) addCurrency(plan.refund.cur, plan.refund.amount);
  inventory[plan.slot] = { kind, tier };
  applyMaxHp();
  toast(plan.swap ? `${itemName(plan.swap)} → ${itemName(inventory[plan.slot])}${plan.refund ? ` (+${plan.refund.amount} ${plan.refund.cur} back)` : ''}`
    : `Bought ${itemName(inventory[plan.slot])}`);
}
// Sell the item in this slot for its full price, in its own currency (in the temple).
function sellItem(slot) {
  const it = inventory[slot];
  if (!it) return;
  if (!inTemple()) { toast('Return to the temple to sell'); return; }
  addCurrency(itemCur(it), itemPrice(it));
  inventory[slot] = null;
  applyMaxHp();
  toast(`Sold ${itemName(it)} for ${itemPrice(it)} ${itemCur(it)}`);
}
// Trade gold for platinum in the temple: as much as the gold allows, PLATINUM.rate gold each
// (one-way; the leftover gold stays).
function tradeForPlatinum() {
  if (!inTemple()) { toast('Return to the temple to trade'); return; }
  const n = Math.floor(gold / PLATINUM.rate);
  if (n < 1) { toast(`Trading needs at least ${PLATINUM.rate} gold (${PLATINUM.rate} gold = 1 platinum)`); return; }
  gold -= n * PLATINUM.rate;
  platinum += n;
  toast(`Traded ${n * PLATINUM.rate} gold for ${n} platinum`);
}
// ---- Recall (the Colossus's ability, R or the HUD button) ----
// Teleports it into its temple at once, with a burst of red energy where it left and where it
// arrives. Cancels its current orders, and boulders already in flight at it miss. Then it
// can't be used again for ATTACKER.recall.cooldown seconds.
let recallCooldown = 0;
function recall() {
  if (attacker.dead || colossusWaiting()) return;
  if (recallCooldown > 0) { toast(`Recall is ready in ${Math.ceil(recallCooldown)}s`); return; }
  const S = map.size, c = (S / 2) | 0;
  // The free temple tile nearest its center.
  let dest = -1, best = Infinity;
  for (let t = 0; t < S * S; t++) {
    if (map.zone[t] !== ZONE.RUIN || map.isBlocked(t) || buildings.occ[t] !== -1) continue;
    const d = Math.hypot(t % S - c, ((t / S) | 0) - c);
    if (d < best) { best = d; dest = t; }
  }
  if (dest < 0) return;
  const from = { x: attacker.x, z: attacker.z };
  debris.burst(from.x, map.heightAt(from.x, from.z) + 1, from.z, 0xff4a32, 30);
  attacker.x = dest % S + 0.5; attacker.z = ((dest / S) | 0) + 0.5;
  attacker.setPath([], dest);
  attacker.target = null;
  attackMove = null;
  if (attackMoveArmed) armAttackMove(false);
  attacker.syncMesh();
  shots.live = shots.live.filter((s) => { if (s.target === colossusAim) { scene.remove(s.mesh); return false; } return true; });
  shardShots.live = shardShots.live.filter((s) => { if (s.target === colossusAim) { scene.remove(s.mesh); return false; } return true; });
  debris.burst(attacker.x, map.heightAt(attacker.x, attacker.z) + 1, attacker.z, 0xff4a32, 30);
  updateVision(true);
  if (controlled === attacker) cam.target.set(attacker.x, 0, attacker.z);
  recallCooldown = ATTACKER.recall.cooldown;
  toast('Recalled to the temple');
}
// ---- Hidden Dancing Blade (F): untargetable for a few seconds, 3 charges a game ----
// Turrets, beams and troops can't target it while it lasts, and boulders already flying at it
// miss. Burns already on it keep burning. It turns into a shimmering, see-through ghost.
let bladeCharges = ATTACKER.hiddenBlade.charges;
let hiddenT = 0;
// Untargetable: Hidden Dancing Blade, or not risen yet at the start of a multiplayer game.
const colossusHidden = () => (hiddenT > 0 || colossusRiseT > 0) && !attacker.dead;
const fancyHtml = (text) => `<span class="fancy-name">${text.split(' ').map((w) => `<span class="fancy-cap">${w[0]}</span>${w.slice(1)}`).join(' ')}</span>`;
function hiddenDancingBlade() {
  const H = ATTACKER.hiddenBlade;
  if (attacker.dead || colossusWaiting()) return;
  if (hiddenT > 0) { toast(`${H.name} is already active (${Math.ceil(hiddenT)}s left)`); return; }
  if (bladeCharges <= 0) { toast(`No ${H.name} left this game`); return; }
  bladeCharges--;
  hiddenT = H.duration;
  // Anything already flying at it misses, and turrets lose it.
  shots.live = shots.live.filter((s) => { if (s.target === colossusAim) { scene.remove(s.mesh); return false; } return true; });
  shardShots.live = shardShots.live.filter((s) => { if (s.target === colossusAim) { scene.remove(s.mesh); return false; } return true; });
  setGhost(true);
  debris.burst(attacker.x, map.heightAt(attacker.x, attacker.z) + 1, attacker.z, 0xff5a62, 24);
  const msg = `: untargetable for ${H.duration}s (${bladeCharges} left)`;
  toast(`${H.name}${msg}`, { html: `${fancyHtml(H.name)}${msg}` });
}
// The ghost look: every part of the Colossus see-through (its own material copies).
function setGhost(on) {
  attacker.parts.root.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    if (on) {
      if (!o.userData.solidMat) { o.userData.solidMat = o.material; o.material = o.material.clone(); }
      o.material.transparent = true;
      o.material.depthWrite = false;
    } else if (o.userData.solidMat) {
      o.material.dispose();
      o.material = o.userData.solidMat;
      delete o.userData.solidMat;
    }
  });
}
function updateHidden(dt) {
  if (hiddenT <= 0) return;
  hiddenT -= dt;
  if (hiddenT <= 0 || attacker.dead) {
    hiddenT = 0;
    setGhost(false);
    if (!attacker.dead && !isClient) toastSide('attacker', `${ATTACKER.hiddenBlade.name} has worn off`);
    return;
  }
  // Shimmer, flickering harder in the last 2 seconds as a warning.
  const t = clock.elapsedTime, warn = hiddenT < 2;
  const a = warn ? 0.2 + 0.3 * (Math.sin(t * 18) > 0 ? 1 : 0) : 0.25 + Math.sin(t * 6) * 0.07;
  attacker.parts.root.traverse((o) => { if (o.isMesh && o.userData.solidMat) o.material.opacity = a; });
}

// ---- Watchfire Glimpse (G, then click): sight of a big area for a few seconds ----
// Everything within the radius is seen (cliffs don't block it): about a sixth of the map.
let glimpseArmed = false;
let glimpseCd = 0;
const glimpseRadius = () => Math.sqrt((map.size * map.size * ATTACKER.glimpse.areaShare) / Math.PI);
const glimpseRingMat = new THREE.MeshBasicMaterial({ color: 0xff9a3a, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide });
const glimpseDiscMat = new THREE.MeshBasicMaterial({ color: 0xff7a1a, transparent: true, opacity: 0.08, depthWrite: false, side: THREE.DoubleSide });
function armGlimpse(on = !glimpseArmed) {
  if (on && glimpseCd > 0) { toast(`${ATTACKER.glimpse.name} is ready in ${Math.ceil(glimpseCd)}s`); on = false; }
  glimpseArmed = on && controlled === attacker && !attacker.dead;
  if (glimpseArmed && attackMoveArmed) armAttackMove(false);
  colossusHud.setGlimpseArmed(glimpseArmed);
  renderer.domElement.style.cursor = glimpseArmed ? 'crosshair' : (attackMoveArmed ? 'crosshair' : '');
}
function castGlimpse(tile) {
  armGlimpse(false);
  if (attacker.dead || tile < 0 || glimpseCd > 0 || colossusWaiting()) return;
  const S = map.size, x = tile % S + 0.5, z = ((tile / S) | 0) + 0.5;
  addGlimpseRing(x, z, ATTACKER.glimpse.duration);
  glimpseCd = ATTACKER.glimpse.cooldown;
  updateVision(true);
  toast(`${ATTACKER.glimpse.name}: you see round there for ${ATTACKER.glimpse.duration}s`);
}
// A Glimpse's ring and tint over its area (t: seconds left). Drawn at the highest terrain level
// and over everything, so cliffs and plateaus never hide it.
function addGlimpseRing(x, z, t) {
  const R = glimpseRadius(), y = LEVEL_MAX * LEVEL_HEIGHT + 0.1;
  const ring = new THREE.Mesh(new THREE.RingGeometry(R - 0.25, R, 64), glimpseRingMat.clone());
  const disc = new THREE.Mesh(new THREE.CircleGeometry(R, 64), glimpseDiscMat.clone());
  for (const m of [ring, disc]) {
    m.rotation.x = -Math.PI / 2; m.position.set(x, y, z);
    m.material.depthTest = false; m.renderOrder = 20;
    scene.add(m);
  }
  glimpses.push({ x, z, t, ring, disc });
}
function updateGlimpse(dt) {
  glimpseCd = Math.max(0, glimpseCd - dt);
  colossusHud.setGlimpse(glimpseCd, ATTACKER.glimpse.cooldown);
  colossusHud.setBlade(bladeCharges, hiddenT, ATTACKER.hiddenBlade.duration);
  if (!glimpses.length) return;
  let ended = false;
  for (const g of glimpses) {
    g.t -= dt;
    const age = ATTACKER.glimpse.duration - g.t;
    const grow = Math.min(1, age / 0.4); // the ring sweeps out, then fades as it ends
    g.ring.scale.setScalar(0.05 + 0.95 * grow);
    g.disc.scale.setScalar(0.05 + 0.95 * grow);
    const fade = Math.min(1, g.t / 1);
    g.ring.material.opacity = 0.8 * fade;
    g.disc.material.opacity = 0.08 * fade;
    g.ring.visible = g.disc.visible = true; // both sides see where the Colossus is looking
    if (g.t <= 0) { scene.remove(g.ring, g.disc); g.ring.geometry.dispose(); g.disc.geometry.dispose(); ended = true; }
  }
  if (ended) { glimpses = glimpses.filter((g) => g.t > 0); updateVision(true); }
}
function updateRecall(dt) {
  recallCooldown -= dt;
  if (recallCooldown < 1e-3) recallCooldown = 0; // no rounding leftovers keeping it locked
  colossusHud.setRecall(recallCooldown, ATTACKER.recall.cooldown);
}

function updateRegen(dt) {
  if (!regenActive()) return;
  attacker.hp = Math.min(attacker.maxHp, attacker.hp + colossusRegen() * dt);
}
let repathTimer = 0;
function showMarker(x, z, color) {
  if (toastTo) return; // another player's order (run here by the host): their ping is theirs alone
  marker.material.color.setHex(color);
  marker.position.set(x, map.heightAt(x, z) + 0.04, z);
  marker.visible = true;
  markerTime = 0;
}
// Distance from a character (the Colossus by default) to the nearest tile of a building,
// counting only tiles within one level of it.
function reachTo(b, unit = attacker) {
  const S = map.size, myLevel = map.level[unit.tile];
  if (b.isUnit) { // a character: measure to where it actually is
    const t = b.unit.tile;
    const d = Math.abs(map.level[t] - myLevel) > 1 ? Infinity : Math.hypot(b.unit.x - unit.x, b.unit.z - unit.z);
    return { dist: d, tile: t };
  }
  let best = Infinity, bestTile = -1;
  for (const t of b.tiles) {
    if (Math.abs(map.level[t] - myLevel) > 1) continue;
    const d = Math.hypot(t % S + 0.5 - unit.x, ((t / S) | 0) + 0.5 - unit.z);
    if (d < best) { best = d; bestTile = t; }
  }
  return { dist: best, tile: bestTile };
}
// Path to some tile from which the building is in reach (tries the closest few).
// The Colossus plans with what it knows (knownOcc); the defender knows the real map.
function pathIntoReach(b, unit = attacker, occ = knownOcc, range = ATTACKER.range) {
  const S = map.size, cands = [];
  const r = Math.ceil(range);
  for (const bt of b.tiles) {
    const bi = bt % S, bj = (bt / S) | 0;
    for (let dj = -r; dj <= r; dj++) {
      for (let di = -r; di <= r; di++) {
        const i = bi + di, j = bj + dj;
        if (!map.inBounds(i, j) || Math.hypot(di, dj) > range - 0.3) continue;
        const t = j * S + i;
        if (occ[t] !== -1 || map.isBlocked(t) || Math.abs(map.level[t] - map.level[bt]) > 1) continue;
        cands.push(t);
      }
    }
  }
  const uniq = [...new Set(cands)].sort((a, c) =>
    Math.hypot(a % S - unit.x, ((a / S) | 0) - unit.z) - Math.hypot(c % S - unit.x, ((c / S) | 0) - unit.z));
  for (const goal of uniq.slice(0, 8)) {
    const path = findPath(map, occ, unit.tile, goal);
    if (path) return { path, goal };
  }
  return null;
}
// quiet: picked by an attack move (no marker).
function orderAttack(b, quiet = false) {
  if (attacker.dead || !b || colossusWaiting()) return;
  attacker.target = b;
  const S = map.size;
  if (!quiet) {
    showMarker(b.tiles.reduce((a, t) => a + t % S + 0.5, 0) / b.tiles.length,
      b.tiles.reduce((a, t) => a + ((t / S) | 0) + 0.5, 0) / b.tiles.length, 0xff5a3d);
  }
  if (reachTo(b).dist <= ATTACKER.range) { attacker.setPath([], attacker.tile); return; }
  const r = pathIntoReach(b);
  if (r) attacker.setPath(r.path, r.goal);
  else attacker.target = null; // can't get there
}
function updateAttack(dt) {
  const b = attacker.target;
  if (!b) return;
  if (b.destroyed) { attacker.target = null; return; }
  const { dist, tile } = reachTo(b);
  if (b.isUnit && dist > ATTACKER.range) {
    // Chasing the Sentinel or a troop: give up if it slips out of sight (or into a tunnel)...
    const u = b.unit;
    if (vis[u.tile] !== 2 || u.sink > 0) { attacker.target = null; attacker.setPath([], attacker.tile); toast(`Lost sight of the ${b.name}`); return; }
    // ...and keep re-aiming at where it is now.
    const end = attacker.path.length ? attacker.path[attacker.path.length - 1] : -1, S = map.size;
    const far = end < 0 || Math.hypot(end % S + 0.5 - u.x, ((end / S) | 0) + 0.5 - u.z) > ATTACKER.range;
    if (far && (repathTimer -= dt) <= 0) {
      repathTimer = 0.4;
      const r = pathIntoReach(b);
      if (r) attacker.setPath(r.path, r.goal);
    }
    return;
  }
  if (dist <= ATTACKER.range) {
    if (attacker.path.length) attacker.setPath([], attacker.tile); // stop and swing
    const S = map.size;
    attacker.targetYaw = Math.atan2(tile % S + 0.5 - attacker.x, ((tile / S) | 0) + 0.5 - attacker.z);
    attacker.cooldown = (attacker.cooldown || 0) - dt;
    if (attacker.cooldown <= 0 && !attacker.swing) {
      attacker.startSwing();
      const rate = colossusRate();
      attacker.cooldown = 1 / rate;
      attacker.swingTime = Math.min(0.75, 0.85 / rate); // the slam speeds up so it can keep up
    }
  } else if (!attacker.path.length && (repathTimer -= dt) <= 0) {
    repathTimer = 0.5;
    const r = pathIntoReach(b);
    if (r) attacker.setPath(r.path, r.goal); else attacker.target = null;
  }
}
// When a swing lands: damage the target, earn gold, throw up debris.
function landHit() {
  const b = attacker.target;
  if (!b || b.destroyed) return;
  const { dist, tile } = reachTo(b);
  if (dist > ATTACKER.range + 0.3) return;
  if (b.isUnit) {
    const u = b.unit, x = u.x, z = u.z;
    b.hit(colossusDamage());
    splashTroops(x, z, u);
    return;
  }
  const dealt = buildings.damage(b, colossusDamage());
  gold += dealt;
  const S = map.size, x = tile % S + 0.5, z = ((tile / S) | 0) + 0.5;
  splashTroops(x, z, null);
  debris.burst(x, buildings.groundY(tile) + 0.5, z, b.type === 'wall' ? 0xb7ab8e : 0x9c8f7a, b.destroyed ? 26 : 10);
  if (b.destroyed) {
    learn(b.tiles, true); // it now knows that ground is open
    attacker.target = null;
  }
}

// ---- Attack move (the Colossus: X or the HUD button, then click a spot) ----
// It walks to the spot, and on the way attacks anything it can see within
// ATTACKER.acquireRange tiles: the Sentinel first, then turrets, then the nearest other
// building or wall piece. After each kill it carries on to the spot.
let attackMove = null;       // { goal, skip: Set of targets it couldn't reach }
let acquireTimer = 0;
function armAttackMove(on = !attackMoveArmed) {
  attackMoveArmed = on && controlled === attacker && !attacker.dead;
  colossusHud.setAttackMoveArmed(attackMoveArmed);
  renderer.domElement.style.cursor = attackMoveArmed ? 'crosshair' : '';
  if (attackMoveArmed && buildType) setBuildType(buildType);
}
function orderAttackMove(tile) {
  armAttackMove(false);
  if (attacker.dead || tile < 0 || colossusWaiting()) return;
  const path = findPath(map, knownOcc, attacker.tile, tile);
  if (!path) { toast('Can\'t get there'); return; }
  const goal = path.length ? path[path.length - 1] : attacker.tile;
  attacker.target = null;
  attacker.setPath(path, goal);
  attackMove = { goal, skip: new Set() };
  const S = map.size;
  showMarker(goal % S + 0.5, ((goal / S) | 0) + 0.5, 0xff5a3d);
}
// The best thing to attack right now, or null.
function acquireTarget() {
  const S = map.size, R = ATTACKER.acquireRange, level = map.level[attacker.tile];
  const near = (x, z) => Math.hypot(x - attacker.x, z - attacker.z) <= R;
  for (const s of sentinels) { // Sentinels first
    const u = s.unit, st = sentinelTargetOf(s);
    if (!u.dead && vis[u.tile] === 2 && !u.sink && near(u.x, u.z) && Math.abs(map.level[u.tile] - level) <= 1 && !attackMove.skip.has(st)) return st;
  }
  let best = null, bestScore = Infinity;
  for (const u of troops.alive) { // troops before buildings
    const tt = troopTarget(u);
    if (vis[u.tile] !== 2 || !near(u.x, u.z) || attackMove.skip.has(tt) || Math.abs(map.level[u.tile] - level) > 1) continue;
    const score = Math.hypot(u.x - attacker.x, u.z - attacker.z) - 6;
    if (score < bestScore) { best = tt; bestScore = score; }
  }
  for (const w of workers.alive) { // workers next, also before buildings
    const wt = workerTarget(w);
    if (vis[w.tile] !== 2 || !near(w.x, w.z) || attackMove.skip.has(wt) || Math.abs(map.level[w.tile] - level) > 1) continue;
    const score = Math.hypot(w.x - attacker.x, w.z - attacker.z) - 5;
    if (score < bestScore) { best = wt; bestScore = score; }
  }
  for (const b of buildings.list) {
    if (b.destroyed || attackMove.skip.has(b)) continue; // every building, walls included
    if (!b.tiles.some((t) => vis[t] === 2)) continue; // must see it
    const x = b.tiles.reduce((a, t) => a + t % S + 0.5, 0) / b.tiles.length;
    const z = b.tiles.reduce((a, t) => a + ((t / S) | 0) + 0.5, 0) / b.tiles.length;
    if (!near(x, z)) continue;
    const score = Math.hypot(x - attacker.x, z - attacker.z) - (b.type === 'cannon' ? 4 : 0); // turrets first
    if (score < bestScore) { best = b; bestScore = score; }
  }
  return best;
}
function updateAttackMove(dt) {
  if (!attackMove) return;
  if (attacker.dead) { attackMove = null; return; }
  if (attacker.target) return; // busy fighting
  if ((acquireTimer -= dt) <= 0) {
    acquireTimer = 0.25;
    const t = acquireTarget();
    if (t) {
      orderAttack(t, true);
      if (!attacker.target) attackMove.skip.add(t); // couldn't reach it: ignore it from now on
      return;
    }
  }
  if (attacker.path.length) return;
  if (attacker.tile === attackMove.goal) { attackMove = null; return; } // arrived
  // Finished a fight (or got stopped): carry on to the spot.
  const path = findPath(map, knownOcc, attacker.tile, attackMove.goal);
  if (path && path.length) attacker.setPath(path, attackMove.goal); else attackMove = null;
}

// ---- The Colossus vs the Sentinels ----
// A Sentinel can be attacked like a building (right-click it while you can see it). If
// every Sentinel falls, the defenders lose. Each Sentinel gets one target object.
function sentinelTargetOf(s) {
  if (!s.target) {
    s.target = {
      type: 'sentinel', isUnit: true, unit: s.unit, id: `sentinel-${s.id}`, name: multiplayer ? `${s.name}'s ${defenderName}` : defenderName,
      get tiles() { return [s.unit.tile]; },
      get hp() { return s.unit.hp; },
      get maxHp() { return s.unit.maxHp; },
      get destroyed() { return !!s.unit.dead; },
      hit: (damage) => withSentinel(s, () => hitSentinel(damage)),
    };
  }
  return s.target;
}
// Troops can be attacked the same way (each gets one target object, made when first needed).
function troopTarget(u) {
  if (!u.target) {
    u.target = {
      type: 'troop', isUnit: true, unit: u, id: `troop${u.id}`, name: u.name,
      get tiles() { return [u.tile]; },
      get hp() { return u.hp; },
      get maxHp() { return u.maxHp; },
      get destroyed() { return !!u.dead; },
      hit: (damage) => hitTroop(u, damage),
    };
  }
  return u.target;
}
function hitTroop(u, damage) {
  const dealt = troops.damage(u, damage);
  gold += dealt;
  const y = map.heightAt(u.x, u.z) + 0.4;
  debris.burst(u.x, y, u.z, 0x857d70, u.dead ? 16 : 6);
  if (u.dead) selUnits.delete(u);
}
// Quarry workers can be attacked the same way.
function workerTarget(w) {
  if (!w.target) {
    w.target = {
      type: 'worker', isUnit: true, unit: w, id: `worker${w.id}`, name: w.name, def: w.def,
      get tiles() { return [w.tile]; },
      get hp() { return w.hp; },
      get maxHp() { return w.maxHp; },
      get destroyed() { return !!w.dead; },
      hit: (damage) => hitWorker(w, damage),
    };
  }
  return w.target;
}
function hitWorker(w, damage) {
  const dealt = workers.damage(w, damage);
  gold += dealt;
  debris.burst(w.x, map.heightAt(w.x, w.z) + 0.4, w.z, w.def.glow, w.dead ? 16 : 6);
  if (w.dead) toast(`The ${w.name} was destroyed`, { html: `The ${workerNameHtml(w.def)} was destroyed` });
}
// A worker the Colossus can see at (or right next to) this tile.
function workerAt(tile) {
  if (tile < 0) return null;
  const S = map.size, x = tile % S + 0.5, z = ((tile / S) | 0) + 0.5;
  let best = null, bestD = 0.9;
  for (const w of workers.alive) {
    const d = Math.hypot(w.x - x, w.z - z);
    if (d < bestD && vis[w.tile] === 2) { best = w; bestD = d; }
  }
  return best;
}
// A slam also hits every troop and worker near where it lands (except the one it was aimed at).
function splashTroops(x, z, except) {
  for (const u of troops.alive) {
    if (u === except || Math.hypot(u.x - x, u.z - z) > ATTACKER.splash) continue;
    hitTroop(u, colossusDamage());
  }
  for (const w of workers.alive) {
    if (w === except || Math.hypot(w.x - x, w.z - z) > ATTACKER.splash) continue;
    hitWorker(w, colossusDamage());
  }
}
// ---- The boss (Crystal Monarch) ----
// A fight between the defenders and the boss only: troops attack it when you right-click it
// with them selected, and turrets built in range (on the arena's pads) shoot it. It attacks
// the Sentinel, troops and buildings near its lair (boss.js). The Colossus and the boss
// ignore each other.
// It isn't there at the start. The first time any Town Hall reaches BOSS.spawnTownHallLevel,
// everyone is told it's coming, and it rises in its lair BOSS.spawnDelay seconds later.
let bossCountdown = -1; // seconds until it spawns, or -1 if no countdown is running
function checkBossTrigger(b) {
  if (!boss || !boss.dormant || bossCountdown >= 0) return;
  if (b.type !== 'townhall' || levelOf(b) < BOSS.spawnTownHallLevel) return;
  bossCountdown = BOSS.spawnDelay;
  toast(`A Core reached level ${BOSS.spawnTownHallLevel}: the ${BOSS.name} awakens in ${BOSS.spawnDelay} seconds!`, { announce: true });
  // Each side's orders.
  announceTo('attacker', `Defend the ${BOSS.name}! Keep the Sentinels and their troops away from it.`);
  announceTo('defender', `Kill the ${BOSS.name}! Its crystals are your reward.`);
}
// Messages for one side only ('attacker' = the Colossus, 'defender' = the Sentinels). With one
// screen, it's shown if you're playing that side now; otherwise it waits and shows when you
// switch to that side (while the boss is still alive).
const sideMessages = { attacker: [], defender: [] };
const sideOf = (unit) => (unit === attacker ? 'attacker' : 'defender');
function announceTo(side, text) {
  if (multiplayer) { if (!isClient) toastSide(side, text, { announce: true }); return; } // each player sees their side's
  if (sideOf(controlled) === side) toast(text, { announce: true });
  else sideMessages[side].push(text);
}
function showSideMessages() {
  const list = sideMessages[sideOf(controlled)];
  if (boss && boss.dead) list.length = 0; // old news
  while (list.length) toast(list.shift(), { announce: true });
}
function updateBossCountdown(dt) {
  if (bossCountdown < 0) return;
  const before = bossCountdown;
  bossCountdown -= dt;
  if (before > 5 && bossCountdown <= 5) toast(`The ${BOSS.name} awakens in 5 seconds!`, { announce: true });
  if (bossCountdown <= 0) { bossCountdown = -1; spawnBoss(); }
}
function spawnBoss() {
  if (!boss || !boss.dormant) return;
  boss.spawn();
  debris.burst(boss.x, boss.floor + 0.4, boss.z, 0xb48cff, 40);
  toast(`The ${BOSS.name} has awakened in its lair!`, { announce: true });
}
// Announced to every player, whichever side they play: when it drops to 25% and when it dies.
function damageBoss(damage) {
  if (!boss || !boss.active) return;
  boss.damage(damage);
  debris.burst(boss.x + (Math.random() - 0.5), boss.floor + 1.4, boss.z + (Math.random() - 0.5), 0xb48cff, boss.dead ? 40 : 5);
  if (boss.dead) {
    // Every Defender gets the reward.
    for (const s of sentinels) withSentinel(s, () => { crystals += BOSS.rewardCrystals; });
    toast(`The ${BOSS.name} has been shattered! Defenders +${BOSS.rewardCrystals} crystals`, { announce: true });
  }
  else if (!boss.lowAnnounced && boss.hp <= boss.maxHp * BOSS.lowHealth) {
    boss.lowAnnounced = true;
    toast(`The ${BOSS.name} is at ${Math.round(BOSS.lowHealth * 100)}% health!`, { announce: true });
  }
}
// Is the boss at (or next to) this tile, and can this side (its vision array) see it?
function bossAt(tile, sideVis) {
  if (!boss || !boss.active || tile < 0 || sideVis[boss.tile] !== 2) return false;
  const S = map.size;
  return Math.hypot(tile % S + 0.5 - boss.x, ((tile / S) | 0) + 0.5 - boss.z) < boss.radius + 0.9;
}
// The boss's spike lands on its target.
function bossHit(target, damage) {
  const r = target.ref;
  debris.burst(r.x, map.heightAt(r.x, r.z) + 0.5, r.z, 0xb48cff, 18);
  if (target.kind === 'sentinel') withSentinel(sentinelOf(r), () => hitSentinel(damage, false));
  else if (target.kind === 'troop') { troops.damage(r, damage); if (r.dead) selUnits.delete(r); }
  else if (target.kind === 'worker') workers.damage(r, damage);
  else if (target.kind === 'building') {
    const b = r.b;
    buildings.damage(b, damage);
    if (b.destroyed) learn(b.tiles); // the Colossus notices if it's watching
  }
}
// A building as a boss target (one per building, so the boss can keep it as its target).
function buildingRef(b) {
  if (!b.bossRef) {
    const S = map.size;
    const x = b.tiles.reduce((a, t) => a + t % S + 0.5, 0) / b.tiles.length;
    const z = b.tiles.reduce((a, t) => a + ((t / S) | 0) + 0.5, 0) / b.tiles.length;
    b.bossRef = { b, x, z, get dead() { return b.destroyed; } };
  }
  return b.bossRef;
}
// Everything the boss could attack: the defenders' side only.
const bossTargets = () => [
  ...sentinels.filter((s) => !s.unit.dead).map((s) => ({ kind: 'sentinel', ref: s.unit })),
  ...troops.alive.map((u) => ({ kind: 'troop', ref: u })),
  ...workers.alive.map((w) => ({ kind: 'worker', ref: w })),
  ...buildings.list.filter((b) => !b.destroyed).map((b) => ({ kind: 'building', ref: buildingRef(b) })),
];

// A troop the Colossus can see at (or right next to) this tile.
function troopAt(tile) {
  if (tile < 0) return null;
  const S = map.size, x = tile % S + 0.5, z = ((tile / S) | 0) + 0.5;
  let best = null, bestD = 0.9;
  for (const u of troops.alive) {
    const d = Math.hypot(u.x - x, u.z - z);
    if (d < bestD && vis[u.tile] === 2) { best = u; bestD = d; }
  }
  return best;
}
const targetName = (b) => (b.isUnit ? b.name : BUILDINGS[b.type].name);
// The Sentinel (its slot) at (or right next to) this tile that the Colossus can see, or null.
function sentinelAt(tile) {
  if (tile < 0) return null;
  const S = map.size;
  return sentinels.find((s) => !s.unit.dead && vis[s.unit.tile] === 2
    && Math.abs(tile % S + 0.5 - s.unit.x) < 1.2 && Math.abs(((tile / S) | 0) + 0.5 - s.unit.z) < 1.2) || null;
}
// byColossus: the Colossus earns gold for it (not when the boss hits it).
function hitSentinel(damage, byColossus = true) {
  if (defender.dead) return;
  const dealt = godMode ? 0 : Math.min(defender.hp, damage); // debug: invincible (still flinches)
  defender.hp -= dealt;
  if (byColossus) gold += dealt;
  defender.flinch();
  const y = map.heightAt(defender.x, defender.z) + 0.6;
  debris.burst(defender.x, y, defender.z, 0x857d70, defender.hp <= 0 ? 30 : 12);
  if (defender.hp > 0) return;
  // Fallen: it breaks apart and stops whatever it was doing.
  defender.die();
  repair = null;
  tunnelTrip = null;
  if (buildType && curSentinel === mySentinel) setBuildType(buildType);
  attacker.target = null;
  selUnits.delete(defender);
  if (multiplayer && !sentinels.every((s) => s.unit.dead)) toast(`${curSentinel.name}'s ${defenderName} has fallen!`, { announce: true });
  if (sentinels.every((s) => s.unit.dead)) {
    endBanner.show({
      title: 'The Sentinels have fallen',
      text: 'The Colossus wins. The defenders lose when every Sentinel is destroyed.',
      buttons: [
        { label: 'New map', run: () => loadSeed(randomSeed(), keepParams()) },
        { label: 'Revive (debug)', run: reviveSentinel },
      ],
    });
  }
}
function reviveSentinel() {
  defender.revive();
  defender.hp = defender.maxHp;
  endBanner.hide();
  toast(`The ${defenderName} is restored`);
}
// A health bar over a Sentinel once it's hurt (each Sentinel has its own).
const makeSentinelBar = () => {
  const w = 0.9, bar = new THREE.Group();
  const back = new THREE.Mesh(new THREE.PlaneGeometry(w + 0.06, 0.16), new THREE.MeshBasicMaterial({ color: 0x111418, depthTest: false }));
  const fillGeo = new THREE.PlaneGeometry(w, 0.1);
  fillGeo.translate(w / 2, 0, 0);
  const fill = new THREE.Mesh(fillGeo, new THREE.MeshBasicMaterial({ color: 0x6fd36f, depthTest: false }));
  fill.position.set(-w / 2, 0, 0.001);
  back.renderOrder = 10; fill.renderOrder = 11;
  bar.add(back, fill);
  bar.visible = false;
  scene.add(bar);
  return { bar, fill };
};
let sentinelBar = makeSentinelBar(); // the acting Sentinel's (see useSentinel)
function updateSentinelBar() {
  const { bar, fill } = sentinelBar, r = defender.hp / defender.maxHp;
  bar.visible = !defender.dead && r < 1 && defender.parts.root.visible && !defender.sink;
  if (!bar.visible) return;
  bar.position.set(defender.x, map.heightAt(defender.x, defender.z) + 1.75, defender.z);
  bar.quaternion.copy(cam.camera.quaternion);
  fill.scale.x = Math.max(0.001, r);
  fill.material.color.setHex(r > 0.6 ? 0x6fd36f : r > 0.3 ? 0xe8c25a : 0xe0533d);
}

// ---- Turrets fight back ----
// Each Turret lobs its boulder at the Colossus when it's within range and in line of sight
// (it can fire down a cliff, not up one), or else at the boss if it's in range (turrets on
// the arena's pads). A new boulder regrows between shots.
// When struck, the Colossus learns where the shot came from (the turret shows on its map).
const shots = new BoulderShots(scene);
const TURRET = BUILDINGS.cannon.attack;
let lastHitAt = -99; // when the Colossus was last struck (for the "Under fire" tag)
const colossusAim = () => ({ x: attacker.x, y: map.heightAt(attacker.x, attacker.z) + 1.2, z: attacker.z });
function updateTurrets(dt) {
  const S = map.size;
  for (const b of buildings.list) {
    if (b.type !== 'cannon' || b.destroyed || b.constructing) continue; // still being built: can't fire
    b.reload = Math.max(0, (b.reload ?? 0) - dt);
    const aims = !!UPGRADES.cannon.variants[b.variant]?.aimsEachShot;
    const beam = isBeam(b);
    if (b.reload > 0 && !aims && !beam) continue;
    const x = b.tiles[0] % S + 0.5, z = ((b.tiles[0] / S) | 0) + 0.5;
    // The Colossus comes first; otherwise the boss, if it's in range (from its edge).
    let aim = null, foe = null;
    if (!attacker.dead && !colossusHidden() && Math.hypot(attacker.x - x, attacker.z - z) <= TURRET.range
      && lineOfSight(map, x, z, attacker.x, attacker.z)) { aim = colossusAim; foe = 'colossus'; }
    else if (boss && boss.active && Math.hypot(boss.x - x, boss.z - z) <= TURRET.range + boss.radius
      && lineOfSight(map, x, z, boss.x, boss.z)) { aim = bossAim; foe = 'boss'; }
    // Shard Storm at its beam level: a continuous beam, damage every frame while a target is in
    // range (the same damage per second its shards would do).
    if (beam) {
      if (b.mesh) b.mesh.userData.beaming = !!foe;
      if (!foe) { b.beamFoe = null; continue; }
      const from = { x, y: map.level[b.tiles[0]] * LEVEL_HEIGHT + (b.mesh?.userData.boulderY ?? 1.35) + 0.3, z }, to = aim();
      const width = 0.07 + Math.min(levelOf(b) - 10, 5) * 0.015; // a little thicker each level
      if (seesNow(from.x, from.z) || seesNow(to.x, to.z)) beams.set(b, from, to, width); // not one wholly in the fog
      if (isHost) beamFrame.push([buildings.list.indexOf(b), from, to, width]); // sent to the other players
      const dmg = turretDamage(b) * turretRate(b) * dt;
      if (foe === 'boss') damageBoss(dmg);
      else {
        hurtColossus(dmg, true);
        if (b.beamFoe !== foe) { attacker.flinch(); revealTurret(b); } // the first touch: it flinches and sees the turret
        if (Math.random() < dt * 8) debris.burst(to.x, to.y, to.z, DEFENDER.colors[0], 2); // sparks where it lands
      }
      b.beamFoe = foe;
      continue;
    }
    // Siege Titan: every throw takes a full aim (1 / its rate seconds) with the same target in
    // range the whole time. Losing the target (or switching to another) cancels the throw.
    if (aims) {
      const aimTime = 1 / turretRate(b);
      b.aim = foe && foe === b.aimFoe ? (b.aim || 0) + dt : 0;
      b.aimFoe = foe;
      if (b.mesh) b.mesh.userData.aim = foe ? Math.min(1, b.aim / aimTime) : 0;
      if (!foe || b.aim < aimTime) continue;
      b.aim = 0; // throw now, then aim again for the next one
    }
    if (!foe) continue;
    b.reload = aims ? 0 : 1 / turretRate(b);
    if (b.mesh) b.mesh.userData.firedAt = buildings.time;
    const y = map.level[b.tiles[0]] * LEVEL_HEIGHT + (b.mesh?.userData.boulderY ?? 0.95);
    // Damage doubles with each upgrade level (fixed when fired); upgraded boulders are bigger.
    const lv = levelOf(b);
    // Siege Titan: a giant boulder. Shard Storm: a fast crystal shard. Otherwise bigger each level.
    const burn = UPGRADES.cannon.variants[b.variant]?.burn || null; // fixed when fired, like damage
    const V = UPGRADES.cannon.variants[b.variant];
    // Shard Storm from level 7: fast shards in a straight line (level 6 still lobs them).
    if (b.variant === 'storm') {
      const straight = lv >= 7;
      shardShots.fire({ x, y, z }, aim, straight ? V.shardFlight : TURRET.flight * 0.6, { b, foe, damage: turretDamage(b), small: straight }, onBoulderHit, 1, straight);
    } else shots.fire({ x, y, z }, aim, TURRET.flight, { b, foe, damage: turretDamage(b), burn }, onBoulderHit, b.variant === 'siege' ? 2.3 : 1 + lv * 0.12);
  }
}
// Shard Storm: how many times faster it fires from its level-7+ speed steps (1, 2, 4, 8 at
// levels 6-9, and it stays 8 from then on: its beam is the same damage per second).
function stormSpeed(b) {
  const V = UPGRADES.cannon.variants[b.variant];
  if (!V?.speedUntil) return 1;
  return 2 ** Math.max(0, Math.min(levelOf(b), V.speedUntil) - (UPGRADES.cannon.variantLevel || 6));
}
// Shard Storm at or past its beam level: it fires a continuous beam instead of shards.
const isBeam = (b) => !!UPGRADES.cannon.variants[b.variant]?.beamAt && levelOf(b) >= UPGRADES.cannon.variants[b.variant].beamAt;
// Shots per second for a turret: TURRET.rate, plus UPGRADES.cannon.rateAt for each level
// reached (levels 3 and 5: +0.1 each), times its level-6 variant's rate (Shard Storm: ×2),
// times the Shard Storm's speed steps.
function turretRate(b) {
  const lv = levelOf(b);
  let rate = TURRET.rate;
  for (const [at, add] of Object.entries(UPGRADES.cannon.rateAt || {})) if (lv >= Number(at)) rate += add;
  return rate * (UPGRADES.cannon.variants[b.variant]?.rate || 1) * stormSpeed(b);
}
// Damage per shot: doubles each level up to 5, then its level-6 form's damage (Siege Titan: ×2,
// Shard Storm: ×1 but twice the rate), then doubles again at each of levels 7-10.
// Levels 11-15: ×4 at 11 (the spike), then ×2 (UPGRADES.cannon.mult).
// The Shard Storm's speed steps (7-9) double its rate instead, so its damage per shot is divided
// by them: every form does the same damage per second at every level.
function turretDamage(b) {
  return TURRET.damage * statFactor('cannon', levelOf(b))
    * (UPGRADES.cannon.variants[b.variant]?.damage || 1) / stormSpeed(b);
}
const turretDps = (b) => turretDamage(b) * turretRate(b);
// The Colossus now knows where this turret is (it was hit by it).
function revealTurret(b) {
  if (b.destroyed) return;
  let changed = false;
  for (const t of b.tiles) if (vis[t] === 0) { vis[t] = 1; changed = true; }
  learn(b.tiles, true);
  if (changed && controlled === attacker) { refreshFog(); minimap.markDirty(); }
}
// Shard Storm beams (see updateTurrets).
const beams = new Beams(scene, new THREE.Color(DEFENDER.colors[0]).lerp(new THREE.Color(0xffffff), 0.25));
// Shard Storm shots: small glowing team-colored crystal shards instead of boulders.
const shardShots = new BoulderShots(scene);
// Boulders and shards (turrets' and troops') only show over ground this screen can see right now.
shots.canSee = shardShots.canSee = troops.shots.canSee = seesNow;
// Buildings this screen only remembers (in the fog) stand still: no animation, health bar or shaking.
buildings.seesNow = (b) => { const v = viewVis(); return !v || b.tiles.some((t) => v[t] === 2); };
shardShots.geo = new THREE.OctahedronGeometry(0.12, 0);
shardShots.mat = new THREE.MeshLambertMaterial({ color: new THREE.Color(DEFENDER.colors[0]).lerp(new THREE.Color(0xffffff), 0.4),
  emissive: DEFENDER.colors[0], emissiveIntensity: 1 });
const bossAim = () => ({ x: boss.x, y: boss.floor + 1.6, z: boss.z });
function onBoulderHit(shot) {
  const p = shot.mesh.position;
  if (shot.data.small) debris.burst(p.x, p.y, p.z, DEFENDER.colors[0], 3); // a fast shard: a few sparks
  else debris.burst(p.x, p.y, p.z, 0x8a8274, 12);
  if (shot.data.foe === 'boss') { damageBoss(shot.data.damage); return; }
  if (attacker.dead) return;
  // Siege Titan: part of the damage lands now, the rest burns over the next few seconds.
  const burn = shot.data.burn;
  if (burn) addBurn(shot.data.damage * burn.share, burn.duration);
  hurtColossus(shot.data.damage * (burn ? 1 - burn.share : 1), shot.data.small); // fast shards don't each make it flinch
  if (attacker.dead) return;
  revealTurret(shot.data.b); // the Colossus now knows where that turret is
}
// Any damage to the Colossus (turrets, troops, burns). Stone armor reduces it.
// quiet: no flinch (burn ticks land every frame).
function hurtColossus(damage, quiet = false) {
  if (attacker.dead) return;
  if (!godMode) attacker.hp = Math.max(0, attacker.hp - damage * (1 - colossusArmor())); // debug: invincible
  if (!quiet) attacker.flinch();
  lastHitAt = clock.elapsedTime; // also keeps Regen Core paused
  if (attacker.hp <= 0) killColossus();
}
// Info-panel line describing a turret's shots.
function turretShotText(b) {
  const dmg = turretDamage(b), every = (1 / turretRate(b)).toFixed(2);
  const burn = UPGRADES.cannon.variants[b.variant]?.burn;
  if (isBeam(b)) return `Crystal beam: ${Math.round(turretDps(b))} dmg/s while a target is in range ${TURRET.range}`;
  if (b.variant === 'storm') return `Fires crystal shards${levelOf(b) >= 7 ? ' in a straight line' : ''}: ${dmg} dmg every ${every}s (${Math.round(turretDps(b))} dmg/s), range ${TURRET.range}`;
  if (burn) return `Hurls boulders every ${every}s, range ${TURRET.range}: ${Math.round(dmg * (1 - burn.share))} dmg on impact + ${Math.round(dmg * burn.share)} over ${burn.duration}s (Crushed: stacks, pauses the Colossus's regen)`;
  return `Hurls boulders: ${dmg} dmg every ${every}s, range ${TURRET.range}`;
}
// "Crushed": Siege Titan damage over time on the Colossus. Each boulder adds its own burn.
let burns = [];          // [{ perSec, left }]
let burnDust = 0;
function addBurn(total, duration) {
  if (total > 0 && duration > 0) burns.push({ perSec: total / duration, left: duration });
}
function updateBurns(dt) {
  if (attacker.dead) { burns = []; return; }
  if (!burns.length) return;
  let dmg = 0;
  for (const b of burns) { dmg += b.perSec * Math.min(dt, b.left); b.left -= dt; }
  burns = burns.filter((b) => b.left > 0);
  if (dmg > 0) hurtColossus(dmg, true);
  // Grinding stone dust and sparks off the Colossus while it's Crushed.
  if ((burnDust -= dt) <= 0 && !attacker.dead) {
    burnDust = 0.25;
    const y = map.heightAt(attacker.x, attacker.z) + 0.6 + Math.random() * 1.2;
    debris.burst(attacker.x + (Math.random() - 0.5) * 0.8, y, attacker.z + (Math.random() - 0.5) * 0.8, 0xd08a4a, 3);
  }
}
// What the HUD shows: damage per second after armor, and seconds until the last burn ends.
const burnState = () => burns.length && !attacker.dead
  ? { perSec: Math.round(burns.reduce((s, b) => s + b.perSec, 0) * (1 - colossusArmor())), left: Math.max(...burns.map((b) => b.left)) }
  : null;
// A troop's punch or thrown shard lands on the Colossus (or the boss).
function onTroopStrike(u, damage, ranged, foe) {
  if (boss && foe === boss) { damageBoss(damage); return; }
  if (attacker.dead) return;
  const y = map.heightAt(attacker.x, attacker.z) + (ranged ? 1.1 : 0.5);
  debris.burst(attacker.x, y, attacker.z, ranged ? DEFENDER.colors[0] : 0x8a8274, 4);
  hurtColossus(damage);
}
function killColossus() {
  attacker.die();
  attacker.target = null;
  debris.burst(attacker.x, map.heightAt(attacker.x, attacker.z) + 1, attacker.z, 0x8f897d, 40);
  endBanner.show({
    title: 'The Colossus has fallen',
    text: 'The defenders win. The Colossus had a single life.',
    buttons: [
      { label: 'New map', run: () => loadSeed(randomSeed(), keepParams()) },
      { label: 'Revive (debug)', run: reviveColossus },
    ],
  });
}
function reviveColossus() {
  attacker.revive();
  attacker.hp = attacker.maxHp;
  endBanner.hide();
  toast('The Colossus is restored');
}
// ---- The temple heals the Colossus ----
// Standing anywhere in its ruined temple, the Colossus regains ATTACKER.templeHeal of its max HP per
// second. Cyan rune-light streams up around it while it heals. (A fallen Colossus stays down.)
const templeFx = new RepairFx(scene, 0x6ef0ff);
let templeHealing = false;
let templeRamp = 0; // 0..1: healing eases in after stepping into the temple, and out after leaving
function updateTempleHeal(dt) {
  templeHealing = !attacker.dead && map.zone[attacker.tile] === ZONE.RUIN && attacker.hp < attacker.maxHp;
  templeRamp = templeHealing ? Math.min(1, templeRamp + dt / ATTACKER.templeRamp) : 0;
  if (templeHealing) {
    const ease = templeRamp * templeRamp * (3 - 2 * templeRamp); // smooth start
    attacker.hp = Math.min(attacker.maxHp, attacker.hp + ATTACKER.templeHeal * attacker.maxHp * ease * dt);
  }
  const ground = map.heightAt(attacker.x, attacker.z);
  const show = templeHealing && attacker.parts.root.visible;
  templeFx.update(dt, show,
    { x: attacker.x - 0.6, y: ground + 0.1, z: attacker.z + 0.6 },   // light rises from the temple floor
    { x: attacker.x, y: ground + 1.4, z: attacker.z },               // into the Colossus's chest
    show ? [{ x: attacker.x, y: ground, z: attacker.z }] : []);
}

// A health bar over the Colossus once it's hurt.
const colossusBar = (() => {
  const w = 1.4, bar = new THREE.Group();
  const back = new THREE.Mesh(new THREE.PlaneGeometry(w + 0.08, 0.2), new THREE.MeshBasicMaterial({ color: 0x111418, depthTest: false }));
  const fillGeo = new THREE.PlaneGeometry(w, 0.13);
  fillGeo.translate(w / 2, 0, 0);
  const fill = new THREE.Mesh(fillGeo, new THREE.MeshBasicMaterial({ color: 0x6fd36f, depthTest: false }));
  fill.position.set(-w / 2, 0, 0.001);
  back.renderOrder = 10; fill.renderOrder = 11;
  bar.add(back, fill);
  bar.visible = false;
  scene.add(bar);
  return { bar, fill };
})();
function updateColossusBar() {
  const { bar, fill } = colossusBar, r = attacker.hp / attacker.maxHp;
  bar.visible = !attacker.dead && r < 1 && attacker.parts.root.visible;
  if (!bar.visible) return;
  bar.position.set(attacker.x, map.heightAt(attacker.x, attacker.z) + 2.6, attacker.z);
  bar.quaternion.copy(cam.camera.quaternion);
  fill.scale.x = Math.max(0.001, r);
  fill.material.color.setHex(r > 0.6 ? 0x6fd36f : r > 0.3 ? 0xe8c25a : 0xe0533d);
}

// ---- Repairing (the defender) ----
// Right-click a damaged building as the defender (or press Repair in the info panel): the
// Sentinel walks into range and channels energy into it. Free. Only standing buildings can be
// repaired; rubble can't. Walls: repairing one piece repairs every piece connected to it,
// at full speed for 1-2 pieces, then rate / (n - 1)² (n = connected pieces), so long wall
// lines are slow to mend.
const newRepairFx = (color) => new RepairFx(scene, new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.3));
let repairFx = newRepairFx(mySentinel.color); // the acting Sentinel's, in its color (each has its own; see useSentinel)
let repair = null;          // { target, set: [buildings being repaired], active, perSec }
let repairRepath = 0;
const isDamaged = (b) => b && !b.destroyed && b.hp < b.maxHp;
const repairSetOf = (b) => buildings.connectedWalls(b);
// Share of max HP per second, per building. Wall lines of 1 or 2 pieces repair at full speed;
// from 3 pieces on it slows down: rate / (n - 1)², so 3 pieces = ÷4, 4 = ÷9, 5 = ÷16.
function repairRate(set) {
  const m = Math.max(1, set.length - 1);
  return DEFENDER.repair.rate / (m * m);
}
// quiet: from auto-repair (no marker or messages).
function orderRepair(b, quiet = false) {
  if (defender.dead) return;
  if (tunnelTrip && tunnelTrip.phase !== 'walk') return; // underground right now
  tunnelTrip = null;
  if (!b || b.destroyed) { if (!quiet) toast('Destroyed buildings can\'t be repaired'); return; }
  const set = repairSetOf(b);
  if (!set.some(isDamaged)) { if (!quiet) toast(`${BUILDINGS[b.type].name} isn't damaged`); return; }
  repair = { target: b, set, active: false, perSec: 0, auto: quiet };
  const S = map.size;
  if (!quiet) {
    showMarker(b.tiles.reduce((a, t) => a + t % S + 0.5, 0) / b.tiles.length,
      b.tiles.reduce((a, t) => a + ((t / S) | 0) + 0.5, 0) / b.tiles.length, 0x7fe3a0);
  }
  if (reachTo(b, defender).dist <= DEFENDER.repair.range) { defender.setPath([], defender.tile); return; }
  const r = pathIntoReach(b, defender, buildings.occ, DEFENDER.repair.range);
  if (r) defender.setPath(r.path, r.goal);
  else { repair = null; if (!quiet) toast('Can\'t reach it'); }
}
function stopRepair(message) {
  const auto = repair?.auto;
  repair = null;
  if (message && !auto) toast(message); // auto-repairs finish quietly
}
function updateRepair(dt) {
  defender.channeling = false;
  if (!repair) return;
  // The clicked piece may have been destroyed: carry on with another damaged connected piece.
  if (repair.target.destroyed) {
    const next = repair.set.find((x) => !x.destroyed && isDamaged(x));
    if (!next) { stopRepair(); return; }
    repair.target = next;
  }
  repair.set = repairSetOf(repair.target); // walls can be added or knocked out mid-repair
  if (!repair.set.some(isDamaged)) { stopRepair(`${BUILDINGS[repair.target.type].name} repaired`); return; }
  const { dist, tile } = reachTo(repair.target, defender);
  repair.active = dist <= DEFENDER.repair.range;
  if (repair.active) {
    if (defender.path.length) defender.setPath([], defender.tile);
    const S = map.size;
    defender.targetYaw = Math.atan2(tile % S + 0.5 - defender.x, ((tile / S) | 0) + 0.5 - defender.z);
    defender.channeling = true;
    repair.perSec = repairRate(repair.set);
    for (const b of repair.set) buildings.heal(b, b.maxHp * repair.perSec * dt);
  } else if (!defender.path.length && (repairRepath -= dt) <= 0) {
    repairRepath = 0.5;
    const r = pathIntoReach(repair.target, defender, buildings.occ, DEFENDER.repair.range);
    if (r) defender.setPath(r.path, r.goal); else stopRepair('Can\'t reach it');
  }
}
function updateRepairFx(dt) {
  const on = !!repair && repair.active && defender.parts.root.visible && seesNow(defender.x, defender.z); // not in the fog
  let from = null, to = null, spots = [];
  if (on) {
    const S = map.size, center = (b) => ({
      x: b.tiles.reduce((a, t) => a + t % S + 0.5, 0) / b.tiles.length,
      y: buildings.groundY(b.tiles[0]),
      z: b.tiles.reduce((a, t) => a + ((t / S) | 0) + 0.5, 0) / b.tiles.length,
    });
    from = { x: defender.x, y: map.heightAt(defender.x, defender.z) + 0.95, z: defender.z };
    to = center(repair.target);
    to.y += Math.min(1.2, BUILDINGS[repair.target.type].height * 0.5);
    spots = repair.set.filter(isDamaged).map(center);
  }
  repairFx.update(dt, on, from, to, spots);
}

// ---- Auto-repair (the Sentinel, toggle with Z or the HUD button) ----
// While it's on and the Sentinel is idle, it heads to the nearest damaged building within
// DEFENDER.autoRepair.range tiles and repairs it (walls: the whole connected line).
let autoRepair = DEFENDER.autoRepair.on;
let autoRepairTimer = 0;
let autoRepairSkip = new Map(); // building -> time until which it's skipped (couldn't reach it)
function toggleAutoRepair() {
  autoRepair = !autoRepair;
  if (curSentinel === mySentinel) defenderHud.setAutoRepair(autoRepair);
  toast(`Auto-repair ${autoRepair ? 'on' : 'off'}`);
}
defenderHud.setAutoRepair(autoRepair);
function updateAutoRepair(dt) {
  if (!autoRepair || defender.dead || repair || tunnelTrip || defender.path.length) return;
  if ((autoRepairTimer -= dt) > 0) return;
  autoRepairTimer = 0.5;
  const S = map.size, now = clock.elapsedTime;
  let best = null, bestD = Infinity;
  for (const b of buildings.list) {
    if (!isDamaged(b) || !ownedHere(b) || (autoRepairSkip.get(b) ?? 0) > now) continue; // its own buildings only
    const x = b.tiles.reduce((a, t) => a + t % S + 0.5, 0) / b.tiles.length;
    const z = b.tiles.reduce((a, t) => a + ((t / S) | 0) + 0.5, 0) / b.tiles.length;
    const d = Math.hypot(x - defender.x, z - defender.z);
    if (d <= DEFENDER.autoRepair.range && d < bestD) { best = b; bestD = d; }
  }
  if (!best) return;
  orderRepair(best, true);
  if (!repair) autoRepairSkip.set(best, now + 5); // unreachable: try others first
}

// ---- Tunnels (the defender's Sentinel only) ----
// Right-click a tunnel mouth as the defender: the Sentinel walks to it, sinks into the
// ground, and rises out of the other end. Then every tunnel is on cooldown for a while.
const tunnelEnds = buildTunnels(map, scene, DEFENDER.colors[0]);
let tunnelTrip = null;     // { from: end, phase: 'walk' | 'sink' | 'rise', t }
let tunnelCooldown = 0;    // seconds until the Sentinel can use a tunnel again
// The tunnel end at (or right next to) this tile.
function tunnelEndAt(tile) {
  if (tile < 0) return null;
  const S = map.size, i = tile % S, j = (tile / S) | 0;
  return tunnelEnds.find((e) => Math.max(Math.abs(e.tile % S - i), Math.abs(((e.tile / S) | 0) - j)) <= 1) || null;
}
const tileXZ = (t) => ({ x: t % map.size + 0.5, z: ((t / map.size) | 0) + 0.5 });
function orderTunnel(end) {
  const path = findPath(map, buildings.occ, defender.tile, end.tile);
  if (!path) { toast('Can\'t reach that tunnel'); return; }
  defender.setPath(path, end.tile);
  tunnelTrip = { from: end, phase: 'walk', t: 0 };
  const p = tileXZ(end.tile);
  showMarker(p.x, p.z, 0x7fb0ff);
  if (tunnelCooldown > 0) toast(`Tunnels ready in ${Math.ceil(tunnelCooldown)}s`);
}
function updateTunnels(dt) {
  tunnelCooldown = Math.max(0, tunnelCooldown - dt);
  const half = TUNNELS.travelTime / 2;
  const trip = tunnelTrip;
  if (trip && trip.phase === 'walk' && !defender.path.length) {
    if (defender.tile !== trip.from.tile) tunnelTrip = null;       // got stopped somewhere else
    else if (tunnelCooldown <= 0) { trip.phase = 'sink'; trip.t = 0; dustAt(trip.from.tile); }
    // else: wait at the mouth until the cooldown is over
  } else if (trip && trip.phase === 'sink') {
    // Glide into the mouth in the wall while sinking.
    trip.t += dt;
    const k = Math.min(1, trip.t / half), p = tileXZ(trip.from.tile), d = DIRS[trip.from.dir];
    defender.sink = k;
    defender.x = p.x + d[0] * 0.45 * k; defender.z = p.z + d[1] * 0.45 * k;
    defender.targetYaw = Math.atan2(d[0], d[1]);
    if (trip.t >= half) { // come out at the other end
      const to = tunnelEnds.find((e) => e.tile === trip.from.other);
      const q = tileXZ(to.tile), d2 = DIRS[to.dir];
      defender.x = q.x + d2[0] * 0.45; defender.z = q.z + d2[1] * 0.45;
      defender.yaw = defender.targetYaw = Math.atan2(-d2[0], -d2[1]); // facing out of the wall
      defender.setPath([], to.tile);
      trip.phase = 'rise'; trip.t = 0; trip.to = to;
      dustAt(to.tile);
      if (controlled === defender) cam.target.set(q.x, 0, q.z);
    }
  } else if (trip && trip.phase === 'rise') {
    trip.t += dt;
    const k = Math.min(1, trip.t / half), q = tileXZ(trip.to.tile), d2 = DIRS[trip.to.dir];
    defender.sink = 1 - k;
    defender.x = q.x + d2[0] * 0.45 * (1 - k); defender.z = q.z + d2[1] * 0.45 * (1 - k);
    if (trip.t >= half) { defender.sink = 0; defender.x = q.x; defender.z = q.z; tunnelTrip = null; tunnelCooldown = TUNNELS.cooldown; }
  }
  // Mouths animate; their energy dims while recharging. Seen only once explored.
  const time = clock.elapsedTime, cool = tunnelCooldown / TUNNELS.cooldown, seen = shownVis();
  for (const e of tunnelEnds) {
    e.mesh.visible = !fogEnabled || seen[e.tile] > 0; // each side only sees mouths it has explored
    if (e.mesh.visible) e.mesh.userData.animate(time, cool);
  }
}
function dustAt(tile) {
  const p = tileXZ(tile);
  debris.burst(p.x, map.level[tile] * LEVEL_HEIGHT + 0.1, p.z, 0x6b5f4e, 14);
}
const tunnelStatus = () => {
  if (!tunnelTrip) return null;
  if (tunnelTrip.phase !== 'walk') return 'Travelling through a tunnel';
  if (!defender.path.length && tunnelCooldown > 0) return `Waiting for the tunnel (${Math.ceil(tunnelCooldown)}s)`;
  return 'Heading to a tunnel';
};

// ---- Several Sentinels: swapping which one is acting ----
// Save the acting Sentinel's state into its slot, and load another one's into the globals.
function saveSentinel() {
  Object.assign(curSentinel, { repair, repairRepath, tunnelTrip, tunnelCooldown, blinkCd, autoRepair, autoRepairTimer, autoRepairSkip,
    fx: repairFx, bar: sentinelBar, stone, crystals, vis: defVis });
}
function useSentinel(s) {
  curSentinel = s;
  defender = s.unit;
  ({ repair, repairRepath, tunnelTrip, tunnelCooldown, blinkCd, autoRepair, autoRepairTimer, autoRepairSkip, stone, crystals } = s);
  defVis = s.vis; // their own stone, crystals and sight too
  repairFx = s.fx || (s.fx = newRepairFx(s.color));
  sentinelBar = s.bar || (s.bar = makeSentinelBar());
}
// Run fn with this Sentinel acting, then put the previous one back.
function withSentinel(s, fn) {
  if (!s || s === curSentinel) return fn();
  const prev = curSentinel;
  saveSentinel(); useSentinel(s);
  try { return fn(); } finally { saveSentinel(); useSentinel(prev); }
}
// Each Sentinel in turn (yours last, so the globals and your HUD end up on yours). On the
// host, messages from another player's Sentinel go to that player.
function forEachSentinel(fn) {
  for (const s of [...sentinels.filter((x) => x !== mySentinel), mySentinel]) {
    const owner = isHost && !playsSentinel(s) ? s.owner : null; // another player's: their messages go to them
    withSentinel(s, () => { toastTo = owner; try { fn(s); } finally { toastTo = null; } });
  }
}
// Does this screen's player play this Sentinel? (The Colossus's and spectators' screens don't
// play any, even though mySentinel then points at the first one.)
function playsSentinel(s) { return s === mySentinel && (!multiplayer || myRole === 'defender'); }
// A message for one Defender (the owner of a building, troop, …), wherever they're playing.
function toastOwner(owner, text, opts = {}) {
  const s = slotById(owner ?? sentinels[0].id);
  if (playsSentinel(s)) showToast(text, opts);
  else if (isHost) session.net.send(s.owner, { t: 'toast', text, opts });
}

// ---- Multiplayer start: the Colossus rises from its temple after a delay ----
// The Sentinels start in the temple; the Colossus appears there NET.colossusDelay seconds
// later. Until then it's hidden, can't be targeted and can't act (it can use the shop).
let colossusRiseT = multiplayer ? NET.colossusDelay : 0;
function colossusWaiting() {
  if (colossusRiseT <= 0) return false;
  toast(`The Colossus rises in ${Math.ceil(colossusRiseT)}s. You can use the temple shop (O) while you wait`);
  return true;
}
function updateColossusRise(dt) {
  if (colossusRiseT <= 0) return;
  colossusRiseT -= dt;
  if (colossusRiseT > 0) return;
  colossusRiseT = 0;
  debris.burst(attacker.x, map.heightAt(attacker.x, attacker.z) + 1, attacker.z, 0xff4a32, 40);
  toast('The Colossus has risen from its temple!', { announce: true });
  updateVision(true);
}

// ---- Pointer ----
const ndc = new THREE.Vector2();
const raycaster = new THREE.Raycaster();
let hover = null;

renderer.domElement.addEventListener('pointermove', (e) => {
  ndc.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
});
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

// Right-click (in the world or on the minimap): order the selected character to this tile.
function commandAt(tile) {
  if (tile < 0) return;
  const unit = controlled;
  // As the Colossus, right-clicking a building or wall it knows about = attack it.
  if (unit === attacker) {
    if (attacker.dead || colossusWaiting()) return; // it has fallen, or hasn't risen yet
    attackMove = null; // a direct order replaces an attack move
    const st = sentinelAt(tile);
    if (st) { orderAttack(sentinelTargetOf(st)); return; } // a Sentinel itself
    const troop = troopAt(tile);
    if (troop) { orderAttack(troopTarget(troop)); return; }
    const worker = workerAt(tile);
    if (worker) { orderAttack(workerTarget(worker)); return; }
    const target = knownOcc[tile] >= 0 ? buildings.at(tile) : null;
    if (target && !target.destroyed) { orderAttack(target); return; }
    attacker.target = null; // a plain move cancels any attack
  } else {
    // Selected troops take the order; the Sentinel too if it's selected, or if nothing is
    // (so right-click always moves it when you haven't picked anything else).
    const group = selectedTroops(), crew = selectedWorkers();
    if (group.length) commandTroops(group, tile);
    if (crew.length) commandWorkers(crew, tile);
    if (!group.length && !crew.length && selected && selected.type === 'barracks' && !selected.destroyed && !selUnits.has(defender)) { setRally(selected, tile); return; }
    if ((group.length || crew.length) && !selUnits.has(defender)) return;
    if (defender.dead) return; // it has fallen
    if (tunnelTrip && tunnelTrip.phase !== 'walk') return; // busy travelling underground
    // As the defender, right-clicking a damaged building (or wall line) = repair it.
    const b = buildings.at(tile);
    if (b && ownedHere(b) && repairSetOf(b).some(isDamaged)) { tunnelTrip = null; orderRepair(b); return; } // your own buildings
    repair = null; // a plain move cancels any repair
    // Right-clicking a tunnel mouth = go through it.
    const end = tunnelEndAt(tile);
    if (end && defVis[end.tile] > 0) { orderTunnel(end); return; } // only tunnels they've found
    tunnelTrip = null;
  }
  // The Colossus plans from what it has seen; the defender knows its own map.
  const path = findPath(map, unit === attacker ? knownOcc : buildings.occ, unit.tile, tile);
  if (path) {
    unit.setPath(path, path.length ? path[path.length - 1] : unit.tile);
    const S = map.size, end = path.length ? path[path.length - 1] : unit.tile;
    showMarker(end % S + 0.5, ((end / S) | 0) + 0.5, 0x6ef0ff);
  }
}

// ---- Selecting a building (left-click): shows it in the info panel ----
let selected = null;
const selOutline = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 0.02, 1)),
  new THREE.LineBasicMaterial({ color: 0xffe08a }),
);
selOutline.visible = false;
scene.add(selOutline);
function select(b) {
  if (b !== selected) quarryMenuOpen = false; // a new selection starts on the first layer
  selected = b && !b.destroyed ? b : null;
  selOutline.visible = !!selected;
  if (!selected) return;
  const S = map.size, size = Math.sqrt(b.tiles.length);
  const x = b.tiles.reduce((a, t) => a + t % S + 0.5, 0) / b.tiles.length;
  const z = b.tiles.reduce((a, t) => a + ((t / S) | 0) + 0.5, 0) / b.tiles.length;
  selOutline.position.set(x, buildings.groundY(b.tiles[0]) + 0.06, z);
  selOutline.scale.set(size + 0.1, 1, size + 0.1);
}

renderer.domElement.addEventListener('pointerdown', (e) => {
  if (!hover) return;
  if (spectating && e.button !== 0) return; // spectators can look at things, not order them
  if (blinkArmed) { // the click that says where the Sentinel blinks to (right-click cancels)
    if (e.button === 0) blinkTo(hover.tile); else if (e.button === 2) armBlink(false);
    return;
  }
  if (glimpseArmed) { // the click that says where to cast Watchfire Glimpse (right-click cancels)
    if (e.button === 0) castGlimpse(hover.tile); else if (e.button === 2) armGlimpse(false);
    return;
  }
  if (attackMoveArmed) { // the click that says where to attack-move (right-click cancels)
    if (e.button === 0) orderAttackMove(hover.tile); else if (e.button === 2) armAttackMove(false);
    return;
  }
  if (e.button === 2) {
    if (buildType) { setBuildType(buildType); return; } // right-click cancels build mode
    commandAt(hover.tile);
  } else if (e.button === 0 && buildType === 'wall') {
    wallDragStart = wallDragEnd = hover.tile; // finished on pointerup
  } else if (e.button === 0 && buildType) {
    placeOnTiles(buildType, [hover.tile]);
  } else if (e.button === 0) {
    // A click selects; a drag (defender) draws a selection box. Decided on release.
    boxStart = { x: e.clientX, y: e.clientY, add: e.shiftKey };
  }
});
window.addEventListener('pointerup', (e) => {
  if (e.button !== 0) return;
  if (boxStart) {
    const box = selectBox.hidden ? null : boxRect(boxStart, e);
    const add = boxStart.add;
    boxStart = null;
    selectBox.hidden = true;
    if (box) boxSelect(box, add); else clickSelect(e.clientX, e.clientY, add);
    return;
  }
  if (wallDragStart < 0) return;
  placeOnTiles('wall', lineTiles(map, wallDragStart, wallDragEnd));
  wallDragStart = -1;
});

// ---- Selecting units: click, Shift+click, or drag a box (defender) ----
let boxStart = null; // { x, y, add } while the left button is held (no build mode)
const selectBox = document.createElement('div');
selectBox.className = 'select-box';
selectBox.hidden = true;
document.body.appendChild(selectBox);
const boxRect = (a, b) => ({ x0: Math.min(a.x, b.clientX), y0: Math.min(a.y, b.clientY), x1: Math.max(a.x, b.clientX), y1: Math.max(a.y, b.clientY) });
window.addEventListener('pointermove', (e) => {
  if (!boxStart || controlled !== defender) return;
  if (selectBox.hidden && Math.hypot(e.clientX - boxStart.x, e.clientY - boxStart.y) < 6) return;
  const r = boxRect(boxStart, e);
  Object.assign(selectBox.style, { left: `${r.x0}px`, top: `${r.y0}px`, width: `${r.x1 - r.x0}px`, height: `${r.y1 - r.y0}px` });
  selectBox.hidden = false;
});
// Where a unit appears on screen (in pixels).
const screenPos = new THREE.Vector3();
function toScreen(u, lift = 0.4) {
  screenPos.set(u.x, map.heightAt(u.x, u.z) + lift, u.z).project(cam.camera);
  return { x: (screenPos.x + 1) / 2 * window.innerWidth, y: (1 - screenPos.y) / 2 * window.innerHeight };
}
// The defender's units you can select: the Sentinel, living troops and Quarry workers.
// (Your own Sentinel only: each Defender player controls their own.)
const selectableUnits = () => [...(mySentinel.unit.dead ? [] : [mySentinel.unit]), ...troops.alive.filter(ownedByMe), ...workers.alive.filter(ownedByMe)];
function unitAtScreen(px, py) {
  let best = null, bestD = 22; // pixels
  for (const u of selectableUnits()) {
    const p = toScreen(u), d = Math.hypot(p.x - px, p.y - py);
    if (d < bestD) { best = u; bestD = d; }
  }
  return best;
}
function boxSelect(r, add) {
  const inside = selectableUnits().filter((u) => {
    const p = toScreen(u);
    return p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1;
  });
  if (inside.length) select(null);
  setUnitSelection(inside, add);
}
function clickSelect(px, py, add) {
  if (controlled === defender) {
    const u = unitAtScreen(px, py);
    if (u) {
      select(null);
      if (add && selUnits.has(u)) { selUnits.delete(u); refreshUnitRings(); } else setUnitSelection([u], add);
      return;
    }
  }
  if (!hover) return;
  // The Colossus can only select what it has seen; the defender sees its own buildings.
  const occ = controlled === attacker ? knownOcc : buildings.occ;
  const b = occ[hover.tile] >= 0 ? buildings.at(hover.tile) : null;
  if (controlled === defender && !add) setUnitSelection([]); // a building or empty ground clears units
  select(b);
}

// ---- Keyboard ----
const BUILD_KEYS = { Digit1: 'townhall', Digit2: 'barracks', Digit3: 'cannon', Digit4: 'quarry', Digit5: 'wall' };
function switchControl() {
  if (multiplayer) { toast('In a multiplayer game you play the role you picked in the lobby'); return; }
  setControlled(controlled === attacker ? defender : attacker);
  cam.target.set(controlled.x, 0, controlled.z);
  toast(`Controlling ${controlled === attacker ? 'the Colossus' : `the ${defenderName}`}`);
  showSideMessages(); // anything for this side that arrived while you were playing the other
}
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (spectating && e.code !== 'Space') { if (e.code === 'Tab') e.preventDefault(); return; } // spectators only watch
  // Shop keys (1-3) pick an upgrade's tab, only while the shop window is open.
  const shopKey = controlled === attacker && colossusHud.shopOpen && SHOP.find((s) => e.code === `Digit${s.key}`);
  if (shopKey) colossusHud.selectShopTab(shopKey.id);
  else if (e.code === 'KeyO' && controlled === attacker) toggleShop();
  else if (e.code === 'Escape' && colossusHud.shopOpen) toggleShop(false);
  else if (BUILD_KEYS[e.code] && controlled === defender) setBuildType(BUILD_KEYS[e.code]);
  else if (e.code === 'Escape') {
    if (blinkArmed) armBlink(false);
    else if (glimpseArmed) armGlimpse(false);
    else if (attackMoveArmed) armAttackMove(false);
    else if (buildType) setBuildType(buildType);
    else { select(null); setUnitSelection([]); }
  }
  else if (e.code === 'KeyX' && controlled === attacker) armAttackMove();
  else if (e.code === 'KeyR' && controlled === attacker) recall();
  // The Colossus's abilities (F and G are debug commands while the debug panel is open).
  else if (e.code === 'KeyF' && controlled === attacker && !(DEBUG_ALLOWED && debug.isOpen())) hiddenDancingBlade();
  else if (e.code === 'KeyG' && controlled === attacker && !(DEBUG_ALLOWED && debug.isOpen())) armGlimpse();
  else if (e.code === 'KeyF' && controlled === defender && !(DEBUG_ALLOWED && debug.isOpen())) armBlink(); // the Sentinel's Blink
  else if (e.code === 'KeyZ' && controlled === defender) toggleAutoRepair();
  else if (e.code === 'Space') { e.preventDefault(); cam.target.set(controlled.x, 0, controlled.z); }
  else if (e.code === 'KeyC') switchControl();
  else if (e.code === 'Tab') { e.preventDefault(); toggleFog(); }
});

// ---- Debug panel and commands ----
const loadSeed = (s, extra = '') => { location.search = `?solo&seed=${encodeURIComponent(s)}${extra}`; };
const keepParams = () => ['control', 'defender', 'fog', 'debug', 'god'].filter((k) => params.get(k)).map((k) => `&${k}=${params.get(k)}`).join('');
function teleport(unit, tile) {
  if (tile < 0 || map.isBlocked(tile) || buildings.occ[tile] !== -1) { toast('Can\'t teleport there'); return; }
  const S = map.size;
  unit.x = tile % S + 0.5; unit.z = ((tile / S) | 0) + 0.5;
  unit.setPath([], tile);
  if (unit === attacker) { attacker.target = null; updateVision(true); }
  unit.syncMesh();
}
// Debug: every building at every level, packed around the cursor so they can be compared.
// Town Halls and Walls at levels 0-15, Turrets at 0-5 plus both level 6-15 forms, and one
// Barracks and one Quarry. Free, ignoring the build range and the Town Hall limit. Each goes on
// the free spot nearest the cursor (1×1 buildings on every other tile, so walls don't join).
function spawnAllBuildings(tile) {
  if (tile < 0) return;
  const S = map.size, ci = tile % S, cj = (tile / S) | 0;
  const spots = [];
  for (let dj = -30; dj <= 30; dj++) for (let di = -30; di <= 30; di++) {
    if (map.inBounds(ci + di, cj + dj)) spots.push([(cj + dj) * S + ci + di, Math.hypot(di, dj)]);
  }
  spots.sort((a, b) => a[1] - b[1]);
  const want = [];
  const top = MAX_UPGRADE_LEVEL;
  for (let lv = 0; lv <= top; lv++) want.push(['townhall', lv]);
  for (let lv = 0; lv <= 5; lv++) want.push(['cannon', lv]);
  for (const v of ['siege', 'storm']) for (let lv = 6; lv <= top; lv++) want.push(['cannon', lv, v]);
  for (let lv = 0; lv <= top; lv++) want.push(['wall', lv]);
  want.push(['barracks', 0], ['quarry', 0]);
  let made = 0;
  for (const [type, lv, variant] of want) {
    const small = BUILDINGS[type].size === 1;
    const spot = spots.find(([t]) => (!small || (t % S - ci) % 2 === 0 && (((t / S) | 0) - cj) % 2 === 0)
      && map.zone[t] !== ZONE.BOSS && buildings.canPlace(type, t, attacker.tile));
    if (!spot) continue;
    const n = buildings.list.length;
    placeOnTiles(type, [spot[0]], true);
    const b = buildings.list[n];
    if (!b) continue;
    made++;
    if (variant) b.variant = variant;
    if (type === 'wall') b.maxHp = b.hp = BUILDINGS.wall.hp * statFactor('wall', lv);
    if (lv) buildings.setLevel(b, lv);
  }
  updateDefVision(true);
  toast(`Summoned ${made} buildings (every level)`);
}
const hoverTile = () => (hover ? hover.tile : -1);
const debug = createDebugPanel(uiRoot, {
  seed,
  locked: !DEBUG_ALLOWED, // the published site: only the list of keys, no debug commands
  onLoadSeed: (s) => loadSeed(s, keepParams()),
  onNewMap: () => loadSeed(randomSeed(), keepParams()),
  commands: [
    { key: 'N', code: 'KeyN', label: 'New random map', run: () => loadSeed(randomSeed(), keepParams()) },
    { key: 'Y', code: 'KeyY', label: 'Invincible on / off: the Colossus and the Sentinel take no damage (they still flinch)', run: () => setGodMode(!godMode) },
    { key: 'M', code: 'KeyM', label: 'Flat test map (seed "flat": open flat ground, the temple, a field of crystal rocks; no bases)', run: () => loadSeed('flat', keepParams()) },
    { key: 'G', code: 'KeyG', label: 'Give 30,000 of each currency: gold and platinum (Colossus), stone and crystals (defenders)', run: () => { gold += 30000; platinum += 30000; stone += 30000; crystals += 30000; toast('+30,000 gold, platinum, stone and crystals'); } },
    { key: 'T', code: 'KeyT', label: 'Teleport the selected character to the cursor', run: () => teleport(controlled, hoverTile()) },
    { key: 'B', code: 'KeyB', label: 'Summon every building at every level around the cursor (Cores and Walls 0–15, Turrets 0–5 plus both level 6–15 forms, a Barracks and a Quarry)', run: () => spawnAllBuildings(hoverTile()) },
    { key: 'K', code: 'KeyK', label: 'Destroy the building under the cursor', run: () => {
      const b = buildings.at(hoverTile());
      if (!b) { toast('No building there'); return; }
      buildings.destroy(b); learn(b.tiles, true); if (selected === b) select(null); toast(`${BUILDINGS[b.type].name} destroyed`);
    } },
    { key: 'V', code: 'KeyV', label: `Switch the defender's look (now: ${defenderName})`, run: () =>
      loadSeed(seed, `&defender=${defenderModel === 'warden' ? 'sentinel' : 'warden'}${controlled === defender ? '&control=defender' : ''}`) },
    { key: 'H', code: 'KeyH', label: 'Damage the building under the cursor by half its max HP (whole wall line for walls)', run: () => {
      const b = buildings.at(hoverTile());
      if (!b) { toast('No building there'); return; }
      for (const x of repairSetOf(b)) buildings.damage(x, Math.min(x.hp - 1, x.maxHp / 2));
      toast(`Damaged ${BUILDINGS[b.type].name}${b.type === 'wall' ? ' line' : ''}`);
    } },
    { key: 'L', code: 'KeyL', label: 'Heal the Colossus to full (revives it if it has fallen)', run: () => {
      if (attacker.dead) reviveColossus(); else { attacker.hp = attacker.maxHp; toast('Colossus healed'); }
    } },
    { key: 'P', code: 'KeyP', label: `Heal the ${defenderName} to full (revives it if it has fallen)`, run: () => {
      if (defender.dead) reviveSentinel(); else { defender.hp = defender.maxHp; toast(`${defenderName} healed`); }
    } },
    { key: 'F', code: 'KeyF', label: 'Show / hide the FPS counter', run: () => debug.setFpsVisible(!debug.fpsVisible) },
    { key: 'J', code: 'KeyJ', label: `Spawn the ${BOSS.name} (boss) now, or restore it to full health / bring it back`, run: () => {
      if (!boss) return;
      if (boss.dormant) { bossCountdown = -1; spawnBoss(); return; }
      if (boss.dead) boss.revive(); else boss.hp = boss.maxHp;
      boss.lowAnnounced = false;
      toast(`${BOSS.name} restored`);
    } },
    { key: 'I', code: 'KeyI', label: 'Hire one Quarry helper of each kind for free (up to the cap; needs a standing Quarry)', run: () => {
      const q = standingQuarries()[0];
      if (!q) { toast('Build a Quarry first'); return; }
      const keep = stone;
      for (let k = 1; k <= QUARRY_WORKERS.list.length; k++) { stone = 1e9; hireWorker(q, k); }
      stone = keep;
    } },
    { key: 'U', code: 'KeyU', label: 'Spawn troops at the cursor (3 Pebble Golems, 2 Shard Slingers; free, ignores the limit)', run: () => {
      const t = hoverTile();
      if (t < 0) return;
      const spots = troops.formation(t, 5), S = map.size;
      spots.forEach((s, k) => troops.spawn(k < 3 ? 'pebble' : 'slinger', s % S + 0.5, ((s / S) | 0) + 0.5));
      toast(`Spawned ${spots.length} troops`);
    } },
  ].filter((c) => !isClient || c.key === 'F'), // a client only shows the host's game: just the FPS counter
  always: [
    { key: 'Tab', label: 'Fog of war on / off' },
    { key: 'C', label: 'Switch between the Colossus and the defender' },
    { key: 'Space', label: 'Center the camera on the selected character' },
    { key: 'WASD', label: 'Pan the camera (also arrows / middle-drag)' },
    { key: 'Q / E', label: 'Rotate the camera · Scroll: zoom' },
    { key: 'R-click', label: 'Move / attack (Colossus) / repair a damaged building or use a tunnel (defender); selected troops move or attack the Colossus; with a Barracks selected, sets its rally point; also on the minimap' },
    { key: 'X', label: 'Colossus: attack move, then click where to go (Esc / right-click cancels)' },
    { key: 'R', label: `Colossus: Recall, teleport to the temple (${ATTACKER.recall.cooldown} s cooldown)` },
    { key: 'F', label: `Colossus: ${ATTACKER.hiddenBlade.name}, untargetable for ${ATTACKER.hiddenBlade.duration}s (${ATTACKER.hiddenBlade.charges} per game)` },
    { key: 'G', label: `Colossus: ${ATTACKER.glimpse.name}, then click a spot to see round it for ${ATTACKER.glimpse.duration}s (${ATTACKER.glimpse.cooldown} s cooldown)` },
    { key: 'O', label: 'Colossus: open / close the temple shop (1–6 pick a kind of item, click a tier to buy, click an inventory slot to sell; Esc closes)' },
    { key: 'Z', label: 'Sentinel: auto-repair on / off' },
    { key: 'F', label: `Sentinel: Blink, then click a spot within ${DEFENDER.buildRange} tiles to teleport there, seen or not (${DEFENDER.blink.cooldown} s cooldown)` },
    { key: 'L-click', label: 'Select a building or unit · drag on the minimap to look around' },
    { key: 'L-drag', label: 'Defender: box-select units (Shift adds to the selection) · Esc deselects' },
    { key: '1–5', label: 'Defender: pick a building to place · Esc cancels' },
  ],
});

if (params.get('debug') === '1' && DEBUG_ALLOWED) debug.toggle(); // ?debug=1 opens the panel at startup (local only)

// ---- Minimap ----
minimap = new Minimap(uiRoot, map, {
  // While an attack move is armed, a left-click on the minimap sets where it goes.
  onNavigate: (x, z) => {
    if (blinkArmed) blinkTo(map.tileAt(x, z));
    else if (glimpseArmed) castGlimpse(map.tileAt(x, z)); // cast it on the minimap too
    else if (attackMoveArmed) orderAttackMove(map.tileAt(x, z));
    else cam.target.set(x, 0, z);
  },
  onCommand: (tile) => { if (!spectating) commandAt(tile); },
});
// Where the camera looks: the four screen corners projected onto the ground.
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const cornerRay = new THREE.Raycaster();
function cameraFootprint() {
  const out = [], hit = new THREE.Vector3();
  for (const [x, y] of [[-1, 1], [1, 1], [1, -1], [-1, -1]]) {
    cornerRay.setFromCamera(new THREE.Vector2(x, y), cam.camera);
    if (!cornerRay.ray.intersectPlane(groundPlane, hit)) return null;
    out.push({ x: hit.x, z: hit.z });
  }
  return out;
}
const hexColor = (n) => `#${n.toString(16).padStart(6, '0')}`;

// ---- HUD refresh (a few times a second is plenty) ----
function unitStatus(unit) {
  if (unit === attacker && attacker.dead) return 'Fallen';
  if (unit === attacker && colossusRiseT > 0) return `Rising from the temple in ${Math.ceil(colossusRiseT)}s`;
  if (unit === attacker && attacker.target && !attacker.target.destroyed) {
    return `Attacking ${attacker.target.isUnit ? 'the ' : ''}${targetName(attacker.target)}`;
  }
  if (unit === defender && defender.dead) return 'Fallen';
  if (unit === attacker && attackMove) return 'Attack-moving';
  if (unit === defender && tunnelStatus()) return tunnelStatus();
  if (unit === defender && repair) {
    const name = BUILDINGS[repair.target.type].name, n = repair.set.length;
    const what = n > 1 ? `${name} (${n} connected)` : name;
    const auto = repair.auto ? ' (auto)' : '';
    return repair.active ? `Repairing ${what}${auto}` : `Moving to repair ${what}${auto}`;
  }
  return unit.path.length ? 'Moving' : 'Idle';
}
// Info-panel lines about repairing this building (if it's part of the current repair).
function repairLines(b) {
  const set = repairSetOf(b), n = set.length, lines = [];
  if (b.type === 'wall' && n > 1) lines.push(`${n} connected pieces`);
  const perSec = repairRate(set) * b.maxHp;
  if (repair && repair.set.includes(b)) {
    const left = Math.max(0, ...set.map((x) => (x.maxHp - x.hp) / (x.maxHp * repairRate(set))));
    lines.push(repair.active ? `Repairing +${perSec.toFixed(perSec < 10 ? 1 : 0)} HP/s · ${Math.ceil(left)}s left`
      : 'Repair: on the way');
  } else if (isDamaged(b) || set.some(isDamaged)) {
    lines.push(`Repair speed +${perSec.toFixed(perSec < 10 ? 1 : 0)} HP/s`);
  }
  return lines;
}
function refreshHud() {
  const role = controlled === attacker ? 'attacker' : 'defender';
  resourceBar.update({ role, gold, platinum, stone: Math.floor(stone), stoneRate: stoneRate(), crystals: Math.floor(crystals), crystalRate: crystalRate(),
    troops: troops.alive.length, training: queuedTroops(), troopCap: TROOPS.cap });
  if (role === 'attacker') {
    colossusHud.update({
      status: unitStatus(attacker), hp: attacker.hp, maxHp: attacker.maxHp, damage: colossusDamage(),
      gold, platinum, inventory, inTemple: inTemple(), armor: colossusArmor(), regen: colossusRegen(), regenActive: regenActive(),
      buyable: (kind, tier) => buyPlan(kind, tier),
      rate: +colossusRate().toFixed(2), speed: ATTACKER.speed, watchstone: atWatchstone,
      watchLeft: atWatchstone ? Math.ceil(watchSight().using?.t || 0) : 0,
      // A burning watchstone keeps counting down even when the Colossus walks away from it.
      watchBurning: Math.ceil(Math.max(0, ...watch.filter((s) => s.state === 'burning').map((s) => s.t))),
      underFire: !attacker.dead && clock.elapsedTime - lastHitAt < 2.5,
      crushed: burnState(),
      godMode,
      templeHealing,
      vision: Math.round(watchSight().radius),
    });
  } else {
    // With only troops selected, the Sentinel's panel (portrait, build buttons) is hidden;
    // the info panel shows the troops instead.
    defenderHud.el.hidden = selectedTroops().length + selectedWorkers().length > 0 && !selUnits.has(defender);
    defenderHud.update({ status: unitStatus(defender) + (godMode ? ' · Invincible (debug)' : ''), hp: defender.hp, maxHp: defender.maxHp,
      tunnels: tunnelEnds.some((e) => defVis[e.tile] > 0) ? tunnelCooldown : null }); // once one is found
  }
  if (selected && selected.destroyed) select(null);
  const group = role === 'defender' && !selected ? selectedTroops() : [];
  if (group.length) { infoPanel.update(troopInfo(group)); return; }
  const crew = role === 'defender' && !selected ? selectedWorkers() : [];
  if (crew.length) { infoPanel.update(workerInfo(crew)); return; }
  // Nothing selected: show what your character is working on (attack target / repair).
  let b = selected, kind = 'selected', kindLabel = 'Selected';
  if (!b && role === 'attacker' && attacker.target && !attacker.target.destroyed) { b = attacker.target; kind = 'target'; kindLabel = 'Attack target'; }
  if (!b && role === 'defender' && repair) { b = repair.target; kind = 'repair'; kindLabel = 'Repairing'; }
  if (!b) { infoPanel.update(null); return; }
  const site = map.siteId[b.tiles[0]] >= 0 ? map.sites[map.siteId[b.tiles[0]]] : null;
  // Another Defender's building: you see what it is and whose, but get no buttons for it.
  const ownerSlot = !b.isUnit && multiplayer && b.owner !== undefined ? slotById(b.owner) : null;
  const mine = role === 'defender' && (!ownerSlot || ownedByMe(b));
  // The Quarry's helper picker replaces its normal buttons while it's open.
  const hireMenu = mine && kind === 'selected' && b.type === 'quarry' && quarryMenuOpen;
  infoPanel.update({
    id: b.isUnit ? b.id : buildings.list.indexOf(b),
    kind, kindLabel,
    // Upgradable buildings show their level in the title, e.g. "Wall: lvl 3".
    title: !b.isUnit && UPGRADES[b.type] ? `${targetName(b)}: lvl ${levelOf(b)}` : targetName(b),
    titleHtml: b.type === 'worker' ? workerNameHtml(b.def) : null,
    subtitle: b.type === 'worker' ? `Quarry worker: mines ${b.def.rate} crystal${plural(b.def.rate)}/s`
      : b.type === 'troop' ? 'Defender troop' : b.isUnit ? 'Defender: if every Sentinel falls, the defenders lose'
      : `${ownerSlot ? `${ownerSlot.name}'s · ` : ''}${site ? `In a ${'★'.repeat(site.value)} ${site.elevation}` : 'Outside any base'}`,
    hp: b.hp, maxHp: b.maxHp,
    lines: [
      ...(mine && !b.isUnit ? workLine(b) : []),
      ...(b.type === 'cannon' ? [turretShotText(b)] : []),
      ...(mine && b.type === 'barracks' ? barracksLines(b) : []),
      ...(mine && b.type === 'quarry' ? quarryLines() : []),
      ...(mine && !b.isUnit ? upgradeLines(b) : []),
      ...(salvaging.has(b) && mine
        ? [`Salvaging: ${Math.ceil(DEFENDER.salvageTime - salvaging.get(b).t)}s, refund ${refundText(b)}`] : []),
      ...(kind === 'target' ? [`${Math.ceil(b.hp / colossusDamage())} more hits`] : mine ? repairLines(b) : []),
    ],
    // The Barracks' training menu and the Quarry's hire picker are two-column grids.
    actionsLayout: hireMenu || (mine && kind !== 'target' && b.type === 'barracks' && !b.constructing) ? 'grid' : '',
    actions: kind === 'target' ? [] : hireMenu ? quarryActions(b) : role === 'defender' && !mine ? []
      : role === 'defender'
      ? [...(b.type === 'barracks' && !b.constructing ? barracksActions(b) : []), // repairing is by right-click only
      ...(b.type === 'quarry' && !b.constructing ? quarryActions(b) : []),        // (not usable until built)
      ...(b.type === 'quarry' || b.isUnit ? [] : upgradeActions(b).map((a) => ({ ...a, className: b.type === 'barracks' ? 'wide' : a.className }))),
      salvaging.has(b)
        ? { label: 'Cancel salvage', className: b.type === 'barracks' ? 'wide' : '', run: () => cancelSalvage(b) }
        : { label: 'Salvage', className: b.type === 'barracks' ? 'wide' : '', title: `Take it apart in ${DEFENDER.salvageTime}s for a refund of ${refundText(b)} (none if it's destroyed first)`, run: () => startSalvage(b) }]
      : [{ label: 'Attack', run: () => orderAttack(b) }],
  });
}
function refreshMinimap() {
  const asColossus = controlled === attacker;
  const fogVis = fogEnabled ? shownVis() : null;
  const sees = (u) => !fogVis || fogVis[u.tile] === 2;
  const colorOf = (x) => hexColor(slotById(x.owner ?? sentinels[0].id).color); // each Defender's own color
  minimap.draw({
    fogVis,
    buildings: buildings.list.filter((b) => !b.destroyed && (!fogVis || b.tiles.some((t) => fogVis[t] > 0)))
      .map((b) => ({ tiles: b.tiles, color: hexColor(b.color ?? DEFENDER.colors[0]) })),
    watchstones: map.watchstones.filter((w) => !fogVis || fogVis[w.stone] > 0),
    // Tunnel mouths the side you control has explored. Where each tunnel leads isn't shown.
    tunnels: map.tunnels.map((tn) => ({
      a: tileXZ(tn.a), b: tileXZ(tn.b),
      showA: !fogVis || fogVis[tn.a] > 0,
      showB: !fogVis || fogVis[tn.b] > 0,
    })),
    tunnelColor: hexColor(TUNNEL_GLOW),
    units: [
      ...sentinels.filter((s) => sees(s.unit) && !s.unit.dead).map((s) => ({ x: s.unit.x, z: s.unit.z, color: hexColor(s.color), r: 3.5,
        selected: !asColossus && s === mySentinel && selUnits.has(s.unit) })),
      ...troops.alive.filter(sees).map((u) => ({ x: u.x, z: u.z, color: colorOf(u), r: 2, selected: !asColossus && selUnits.has(u) })),
      ...workers.alive.filter(sees).map((w) => ({ x: w.x, z: w.z, color: hexColor(w.def.glow), r: 1.8 })),
      ...((sees(attacker) || asColossus) && !attacker.dead && colossusRiseT <= 0 ? [{ x: attacker.x, z: attacker.z, color: '#6ef0ff', r: 4.5, selected: asColossus }] : []),
      ...(boss && boss.active && (!fogVis || fogVis[boss.tile] > 0) ? [{ x: boss.x, z: boss.z, color: '#b48cff', r: 5 }] : []),
    ],
    view: cameraFootprint(),
    yaw: cam.yaw,
  });
}

// ---- Hover info ----
const hoverInfo = document.getElementById('hover-info');
let lastHoverTile = -2;
function describeTile(t) {
  if (t < 0) return '&nbsp;';
  const S = map.size, lvl = map.level[t];
  const parts = [`(${t % S}, ${(t / S) | 0})`, `level ${lvl > 0 ? '+' : ''}${lvl}`];
  if (map.ramp[t] >= 0) parts.push('ramp');
  const z = map.zone[t];
  if (buildings.occ[t] >= 0) {
    const b = buildings.list[buildings.occ[t]];
    parts.push(`${BUILDINGS[b.type].name}${b.level ? ` Lv ${b.level}` : ''} ${Math.ceil(b.hp)}/${b.maxHp} HP`);
  }
  if (map.rareCrystals.has(t)) parts.push('sunstone crystal (rare)');
  else if (map.crystals.includes(t)) parts.push('crystal rock');
  const tEnd = tunnelEnds.find((e) => e.tile === t) || (map.noBuild[t] ? tunnelEndAt(t) : null);
  if (tEnd && (!fogEnabled || shownVis()[tEnd.tile] > 0)) {
    parts.push(`tunnel (Sentinels only)${controlled === defender ? ': right-click to travel' : ''}`);
  }
  if (z === ZONE.RUIN) parts.push('Colossus temple');
  else if (z === ZONE.WATCH) {
    const S = map.size;
    const k = map.watchstones.reduce((bk, w, i) => (Math.hypot(w.x - (t % S + 0.5), w.z - (((t / S) | 0) + 0.5))
      < Math.hypot(map.watchstones[bk].x - (t % S + 0.5), map.watchstones[bk].z - (((t / S) | 0) + 0.5)) ? i : bk), 0);
    parts.push(`watchstone (${watchText(k)}): ${WATCHSTONES.visionRadius}-tile sight for ${WATCHSTONES.duration}s, then ${Math.round(WATCHSTONES.cooldown / 60)} min to relight`);
  }
  else if (z === ZONE.ROCK) parts.push('impassable');
  else if (z === ZONE.FOREST) parts.push('pine grove (impassable)');
  else if (z === ZONE.BOSS) {
    if (boss && Math.hypot(t % S + 0.5 - boss.x, ((t / S) | 0) + 0.5 - boss.z) < boss.radius + 0.6) {
      parts.push(boss.dormant ? 'boss lair (empty: the boss appears when a Core reaches level 4)'
        : boss.dead ? `${BOSS.name} (shattered)` : `${BOSS.name} ${Math.ceil(boss.hp)}/${boss.maxHp} HP (boss)`);
    } else if (map.boss.pads.includes(t)) parts.push('boss arena · turret pad (turrets only)');
    else parts.push('boss arena (only turrets, on the pads)');
  }
  // (Base tiles show no base details: no stars, quality, crystal count or shape.)
  if (fogEnabled && shownVis()[t] === 0) return 'unexplored';
  return parts.join(' · ');
}

// ---- Multiplayer: the host runs the game; the others show it and send their clicks ----
// Objects travel as references: a building by its place in the list ({$b}), a troop or helper
// by id ({$t}/{$w}), a Sentinel by its id ({$d}, or {$st} for it as the Colossus's target).
// Both sides keep the same lists in the same order.
function enc(v) {
  if (Array.isArray(v)) return v.map(enc);
  if (v && typeof v === 'object') {
    const s = sentinels.find((x) => x.unit === v || x.target === v);
    if (s) return s.unit === v ? { $d: s.id } : { $st: s.id };
    const bi = buildings.list.indexOf(v);
    if (bi >= 0) return { $b: bi };
    if (troops.list.includes(v)) return { $t: v.id };
    if (workers.list.includes(v)) return { $w: v.id };
  }
  return v;
}
function dec(v) {
  if (Array.isArray(v)) return v.map(dec);
  if (v && typeof v === 'object') {
    if ('$d' in v) return sentinels.find((s) => s.id === v.$d)?.unit;
    if ('$st' in v) { const s = sentinels.find((x) => x.id === v.$st); return s && sentinelTargetOf(s); }
    if ('$b' in v) return buildings.list[v.$b];
    if ('$t' in v) return troops.list.find((u) => u.id === v.$t);
    if ('$w' in v) return workers.list.find((w) => w.id === v.$w);
  }
  return v;
}
// The commands a player can send, by role. Each runs on the host as if that player clicked.
const ROLE_COMMANDS = {
  attacker: ['commandAt', 'orderAttack', 'orderAttackMove', 'recall', 'buyItem', 'sellItem', 'tradeForPlatinum', 'hiddenDancingBlade', 'castGlimpse'],
  defender: ['commandAt', 'placeOnTiles', 'upgradeBuilding', 'startSalvage', 'cancelSalvage', 'trainTroop', 'cancelTraining', 'hireWorker',
    'dismissWorkers', 'workersMine', 'workersStop', 'stopTroops', 'toggleAutoRepair', 'blinkTo'],
};
const COMMANDS = {
  commandAt: (...a) => commandAt(...a), orderAttack: (...a) => orderAttack(...a), orderAttackMove: (...a) => orderAttackMove(...a),
  recall: () => recall(), buyItem: (...a) => buyItem(...a), sellItem: (...a) => sellItem(...a), tradeForPlatinum: () => tradeForPlatinum(),
  hiddenDancingBlade: () => hiddenDancingBlade(), castGlimpse: (...a) => castGlimpse(...a),
  placeOnTiles: (type, tiles) => placeOnTiles(type, tiles), // never the debug form
  upgradeBuilding: (...a) => upgradeBuilding(...a), startSalvage: (...a) => startSalvage(...a), cancelSalvage: (...a) => cancelSalvage(...a),
  trainTroop: (...a) => trainTroop(...a), cancelTraining: (...a) => cancelTraining(...a), hireWorker: (...a) => hireWorker(...a),
  dismissWorkers: (...a) => dismissWorkers(...a), workersMine: (...a) => workersMine(...a), workersStop: (...a) => workersStop(...a),
  stopTroops: (...a) => stopTroops(...a), toggleAutoRepair: () => toggleAutoRepair(), blinkTo: (...a) => blinkTo(...a),
};
let beamFrame = [];      // the host's Shard Storm beams this frame (sent in snapshots)
const netEvents = [];    // the host's one-off events since the last snapshot (shots fired)
let clientBeams = [];    // a client's beams from the last snapshot

if (isHost) {
  // Run a player's command as them: their role's unit is "controlled", their selection is the
  // selection, and messages go back to them. Then the host's own view is put back.
  const runAs = (p, sel, fn) => {
    const slot = p.role === 'defender' ? sentinels.find((s) => s.owner === p.id) : null;
    withSentinel(slot, () => { // a Defender's commands act on their own Sentinel
      const saveC = controlled, saveUnits = [...selUnits], saveSel = selected;
      controlled = p.role === 'attacker' ? attacker : defender;
      selUnits.clear();
      for (const u of dec(sel?.units || [])) if (u && !u.dead && (!sentinelOf(u) || u === defender)) selUnits.add(u); // never someone else's Sentinel
      selected = dec(sel?.b ?? null) || null;
      toastTo = p.id;
      try { fn(); } catch (err) { console.error('Command failed', err); }
      finally {
        toastTo = null;
        controlled = saveC;
        selUnits.clear(); for (const u of saveUnits) selUnits.add(u);
        selected = saveSel;
      }
    });
    refreshUnitRings(); refreshFog(); minimap?.markDirty();
  };
  session.net.onMessage((id, msg) => {
    const p = session.players.find((x) => x.id === id);
    if (!p || msg.t !== 'cmd') return;
    if (!(ROLE_COMMANDS[p.role] || []).includes(msg.name) || !COMMANDS[msg.name]) return;
    runAs(p, msg.sel, () => COMMANDS[msg.name](...dec(msg.args || [])));
  });
  session.net.onLeave((id) => {
    const p = session.players.find((x) => x.id === id);
    if (p) { showToast(`${p.name} left the game`); session.net.broadcast({ t: 'toast', text: `${p.name} left the game`, opts: {} }); }
  });
  // Shots fired: the others draw the same boulders and shards (they do no damage there).
  const tap = (sh, kind) => {
    const fire = sh.fire.bind(sh);
    sh.fire = (from, target, flight, data, onHit, scale = 1, straight = false) => {
      const at = target(), foe = boss && Math.hypot(at.x - boss.x, at.z - boss.z) < Math.hypot(at.x - attacker.x, at.z - attacker.z) ? 'b' : 'c';
      netEvents.push(['shot', kind, [from.x, from.y, from.z], foe, flight, scale, straight ? 1 : 0]);
      return fire(from, target, flight, data, onHit, scale, straight);
    };
  };
  tap(shots, 's'); tap(shardShots, 'h'); tap(troops.shots, 't');
  // The end of the game: everyone sees the banner.
  const show = endBanner.show.bind(endBanner);
  endBanner.show = (o) => {
    show({ ...o, buttons: [{ label: 'Main menu', run: () => { location.href = location.pathname; } }, ...(o.buttons || []).filter((b) => b.label.includes('debug'))] });
    session.net.broadcast({ t: 'end', title: o.title, text: o.text });
  };
}

// The host's snapshot of the game, NET.snapshotRate times a second.
let snapTimer = 0;
function hostNetStep(dt) {
  snapTimer -= dt;
  if (snapTimer > 0) return;
  snapTimer = 1 / NET.snapshotRate;
  const r = (n) => Math.round(n * 100) / 100;
  session.net.broadcast({
    t: 'snap',
    res: [gold, platinum], // (each Defender's stone and crystals are in their Sentinel's entry)
    inv: inventory.map((it) => (it ? [it.kind, it.tier] : 0)),
    ab: [bladeCharges, r(hiddenT), r(glimpseCd), r(recallCooldown), r(colossusRiseT), 0, r(bossCountdown)],
    a: [r(attacker.x), r(attacker.z), r(attacker.targetYaw), r(attacker.hp), attacker.maxHp, attacker.dead ? 1 : 0, attacker.path, r(attacker.swing), attacker.swingTime || 0.75],
    // Every Sentinel: where it is, its health, and its own orders and cooldowns.
    d: (saveSentinel(), sentinels.map((s) => {
      const u = s.unit, rp = s.repair && !s.repair.target.destroyed ? s.repair : null;
      return [s.id, r(u.x), r(u.z), r(u.targetYaw), r(u.hp), u.maxHp, u.dead ? 1 : 0, u.path, u.channeling ? 1 : 0, r(u.sink || 0),
        r(s.blinkCd), s.autoRepair ? 1 : 0, rp ? buildings.list.indexOf(rp.target) : -1, rp?.active ? 1 : 0, r(s.tunnelCooldown),
        Math.floor(s.stone), Math.floor(s.crystals)];
    })),
    b: buildings.list.map((b) => [b.type, b.tiles[0], levelOf(b), b.variant || 0, r(b.hp), b.maxHp, b.destroyed ? (b.salvaged ? 2 : 1) : 0,
      b.buildK === undefined ? 1 : r(b.buildK), b.queue?.length ? b.queue.map((q) => [q.type, r(q.t)]) : 0, b.rally ?? -1, b.paid || 0, b.paidCrystals || 0,
      b.constructing ? 1 : 0, b.upgrading ? 1 : 0, b.owner ?? null]),
    tr: troops.list.map((u) => [u.id, u.type, r(u.x), r(u.z), u.path, r(u.hp), u.dead ? 1 : 0, r(u.swing || 0), r(u.life || 0), r(u.targetYaw), u.mode, u.owner ?? null]),
    wk: workers.list.map((w) => [w.id, w.tier, r(w.x), r(w.z), w.path, r(w.hp), w.dead ? 1 : 0, w.state, r(w.timer), r(w.targetYaw), r(w.earning), w.order, w.owner ?? null]),
    boss: boss ? [boss.dormant ? 1 : 0, r(boss.spawnT), boss.dead ? 1 : 0, r(boss.hp), boss.cast ? [r(boss.cast.x), r(boss.cast.z), r(boss.cast.t)] : 0] : 0,
    watch: watch.map((s) => [s.state, r(s.t)]),
    gl: glimpses.map((g) => [r(g.x), r(g.z), r(g.t)]),
    beams: beamFrame,
    burns: burns.map((b) => [r(b.perSec), r(b.left)]),
    ev: netEvents.splice(0),
  });
}

if (isClient) {
  // Clicks become commands to the host. Each sends the current selection too (troops, helpers,
  // the Sentinel, the selected building), since many orders depend on it.
  const send = (name, before) => (...args) => {
    before?.(...args);
    session.net.send('host', { t: 'cmd', name, args: enc(args), sel: { units: enc([...selUnits]), b: enc(selected) } });
  };
  commandAt = send('commandAt', (tile) => { const S = map.size; if (tile >= 0) showMarker(tile % S + 0.5, ((tile / S) | 0) + 0.5, 0x6ef0ff); });
  orderAttack = send('orderAttack');
  orderAttackMove = send('orderAttackMove', () => armAttackMove(false));
  recall = send('recall'); buyItem = send('buyItem'); sellItem = send('sellItem'); tradeForPlatinum = send('tradeForPlatinum');
  hiddenDancingBlade = send('hiddenDancingBlade'); castGlimpse = send('castGlimpse', () => armGlimpse(false));
  placeOnTiles = send('placeOnTiles'); upgradeBuilding = send('upgradeBuilding');
  startSalvage = send('startSalvage'); cancelSalvage = send('cancelSalvage');
  trainTroop = send('trainTroop'); cancelTraining = send('cancelTraining'); hireWorker = send('hireWorker');
  dismissWorkers = send('dismissWorkers'); workersMine = send('workersMine'); workersStop = send('workersStop'); stopTroops = send('stopTroops');
  toggleAutoRepair = send('toggleAutoRepair'); blinkTo = send('blinkTo', () => armBlink(false));

  session.net.onMessage((_from, msg) => {
    if (msg.t === 'snap') applySnapshot(msg);
    else if (msg.t === 'toast') showToast(msg.text, msg.opts || {});
    else if (msg.t === 'end') endBanner.show({ title: msg.title, text: msg.text, buttons: [{ label: 'Main menu', run: () => { location.href = location.pathname; } }] });
  });
  session.net.onClose(() => endBanner.show({ title: 'The host left', text: 'The game ended because the host closed it.',
    buttons: [{ label: 'Main menu', run: () => { location.href = location.pathname; } }] }));
}

// A character the host moves: take its path, and its position if it's drifted (or it stopped);
// it then walks on its own here until the next snapshot.
function mirrorMover(u, x, z, yaw, path) {
  const d = Math.hypot(u.x - x, u.z - z);
  if (d > 1.2) { u.x = x; u.z = z; } else if (!path.length) { u.x += (x - u.x) * 0.5; u.z += (z - u.z) * 0.5; }
  u.path = path.slice();
  if (!path.length) u.targetYaw = yaw;
}
let ghostOn = false;
function applySnapshot(s) {
  [gold, platinum] = s.res;
  s.inv.forEach((it, k) => { inventory[k] = it ? { kind: it[0], tier: it[1] } : null; });
  let hidden;
  [bladeCharges, hidden, glimpseCd, recallCooldown, colossusRiseT] = s.ab;
  bossCountdown = s.ab[6];
  if (hidden > 0 && !ghostOn) { setGhost(true); ghostOn = true; }
  hiddenT = hidden;
  if (hidden <= 0 && ghostOn) { setGhost(false); ghostOn = false; }
  // The Colossus and the Sentinel.
  const [ax, az, ayaw, ahp, amax, adead, apath, aswing, aswingT] = s.a;
  mirrorMover(attacker, ax, az, ayaw, apath);
  attacker.hp = ahp; attacker.maxHp = amax;
  if (adead && !attacker.dead) attacker.die(); else if (!adead && attacker.dead) attacker.revive();
  if (aswing > 0 && !attacker.swing) { attacker.swingTime = aswingT; attacker.startSwing(); attacker.swing = aswing; }
  // Every Sentinel, each with its own orders and cooldowns (loaded into its slot).
  for (const e of s.d) {
    const slot = sentinels.find((x) => x.id === e[0]);
    if (!slot) continue;
    withSentinel(slot, () => {
      const [, dx, dz, dyaw, dhp, dmax, ddead, dpath, dch, dsink, bcd, auto, repIdx, repActive, tcd, st, cr] = e;
      stone = st; crystals = cr; // that Defender's own
      mirrorMover(defender, dx, dz, dyaw, dpath);
      if (dhp < defender.hp) defender.flinch();
      defender.hp = dhp; defender.maxHp = dmax; defender.channeling = !!dch; defender.sink = dsink;
      if (ddead && !defender.dead) defender.die(); else if (!ddead && defender.dead) defender.revive();
      blinkCd = bcd; tunnelCooldown = tcd;
      if (!!auto !== autoRepair) { autoRepair = !!auto; if (slot === mySentinel) defenderHud.setAutoRepair(autoRepair); }
      const rb = buildings.list[repIdx];
      repair = rb && !rb.destroyed ? { target: rb, set: repairSetOf(rb), active: !!repActive, perSec: 0 } : null;
    });
  }
  // Buildings: the same list in the same order; new ones are placed, changes copied over.
  const S = map.size;
  let wallsChanged = false, added = false;
  s.b.forEach((e, k) => {
    const [type, t0, lv, variant, hp, maxHp, gone, buildK, queue, rally, paid, paidCr, cons, upg, owner] = e;
    let b = buildings.list[k];
    if (!b) {
      const off = Math.floor((BUILDINGS[type].size - 1) / 2);
      const os = owner !== null ? slotById(owner) : null;
      b = buildings.place(type, t0 + off + off * S, owner ?? undefined, os ? os.color : DEFENDER.colors[0]);
      if (variant) b.variant = variant;
      added = true;
    }
    if (variant && b.variant !== variant) b.variant = variant;
    if (levelOf(b) !== lv) { buildings.setLevel(b, lv); if (b.type === 'wall') wallsChanged = true; }
    b.maxHp = maxHp;
    if (!b.destroyed) {
      if (hp < b.hp) b.shake = 0.3; // it was hit
      b.hp = hp;
      if (hp < maxHp) buildings.ensureBar(b); else if (b.bar) { scene.remove(b.bar); b.bar = null; }
    }
    if (gone && !b.destroyed) { if (gone === 2) buildings.remove(b); else buildings.destroy(b); if (selected === b) select(null); }
    if ((b.buildK ?? 1) !== buildK) setBuildK(b, buildK);
    b.constructing = !!cons; b.upgrading = !!upg;
    b.queue = queue ? queue.map(([qt, qtime]) => ({ type: qt, t: qtime })) : [];
    b.rally = rally; b.paid = paid; b.paidCrystals = paidCr;
  });
  if (added) { buildings.applyFog(shownVis(), fogEnabled); learn(allTiles); }
  else if (wallsChanged) buildings.rebuildWalls(buildings.lastVis, buildings.lastFog);
  // Troops and helpers, by id: new ones appear, gone ones are removed, the rest follow.
  const syncUnits = (list, entries, spawn, apply) => {
    const seen = new Set();
    for (const e of entries) {
      seen.add(e[0]);
      let u = list.list.find((x) => x.id === e[0]);
      if (!u) { u = spawn(e); u.id = e[0]; }
      apply(u, e);
    }
    for (const u of [...list.list]) if (!seen.has(u.id) && !u.dead) list.drop(u);
  };
  syncUnits(troops, s.tr, (e) => troops.spawn(e[1], e[2], e[3], e[11], e[11] !== null ? slotById(e[11]).color : null), (u, e) => {
    const [, , x, z, path, hp, dead, swing, life, yaw, mode] = e;
    mirrorMover(u, x, z, yaw, path);
    if (hp < u.hp) u.shake = 0.3;
    u.hp = hp; u.life = life; u.mode = mode;
    if (dead && !u.dead) { u.dead = true; u.deathT = 0; u.path = []; u.parts.ring.visible = false; u.parts.bar.visible = false; }
    if (swing > 0 && !u.swing) u.swing = swing;
  });
  syncUnits(workers, s.wk, (e) => workers.spawn(e[1], e[2], e[3], e[12]), (w, e) => {
    const [, , x, z, path, hp, dead, state, timer, yaw, earning, order] = e;
    mirrorMover(w, x, z, yaw, path);
    if (hp < w.hp) w.shake = 0.3;
    w.hp = hp; w.state = state; w.earning = earning; w.order = order;
    if (state !== 'mine' || Math.abs(w.timer - timer) > 0.5) w.timer = timer;
    if (dead && !w.dead) { w.dead = true; w.deathT = 0; w.path = []; w.parts.ring.visible = false; w.parts.bar.visible = false; }
  });
  // The boss.
  if (boss && s.boss) {
    const [dormant, spawnT, dead, hp, cast] = s.boss;
    if (!dormant && boss.dormant) boss.spawn();
    boss.spawnT = spawnT; boss.hp = hp;
    if (dead && !boss.dead) boss.die(); else if (!dead && boss.dead) boss.revive();
    if (!cast && boss.cast) boss.spawnSpike(boss.cast.x, boss.cast.z); // the spike erupts
    boss.cast = cast ? { x: cast[0], z: cast[1], t: cast[2] } : null;
  }
  // Watchstones: their fires follow the host's (lit, roaring, out).
  let visionChanged = false;
  s.watch.forEach(([state, t], k) => {
    const w = watch[k];
    if (!w) return;
    if (w.state !== state) {
      terrain.setFire(k, state === 'ready' ? 1 : state === 'burning' ? 1.5 : 0, state === 'cold' ? 0.6 : state === 'burning' ? 2 : 1);
      visionChanged = true;
    }
    if (state === 'burning' && t <= WATCHSTONES.fade && w.t > WATCHSTONES.fade) terrain.setFire(k, 0, 1.5 / WATCHSTONES.fade);
    w.state = state; w.t = t;
  });
  // Watchfire Glimpses: new ones get their ring; the rest are kept in step.
  for (const [x, z, t] of s.gl) {
    const g = glimpses.find((o) => Math.abs(o.x - x) < 0.01 && Math.abs(o.z - z) < 0.01);
    if (g) g.t = t; else { addGlimpseRing(x, z, t); visionChanged = true; }
  }
  if (visionChanged) updateVision(true);
  clientBeams = s.beams;
  burns = s.burns.map(([perSec, left]) => ({ perSec, left }));
  // One-off events: shots to draw.
  for (const ev of s.ev) {
    if (ev[0] !== 'shot') continue;
    const [, kind, f, foe, flight, scale, straight] = ev;
    const aim = foe === 'b' && boss ? bossAim : colossusAim;
    const sh = kind === 's' ? shots : kind === 'h' ? shardShots : troops.shots;
    sh.fire({ x: f[0], y: f[1], z: f[2] }, aim, flight, {}, () => {}, scale, !!straight);
  }
}
// A client's frame: no game logic (the host runs it), only following the host and animating.
function clientStep(dt) {
  attacker.update(dt); attacker.hitNow = false; // its swing lands on the host
  terrain.animate(clock.elapsedTime);
  for (const [bi, from, to, width] of clientBeams) {
    const b = buildings.list[bi];
    if (b && !b.destroyed && (seesNow(from.x, from.z) || seesNow(to.x, to.z))) beams.set(b, from, to, width); // not wholly in the fog
  }
  beams.update(buildings.time || 0);
  shots.update(dt);
  shardShots.update(dt);
  updateRecall(dt);
  updateHidden(dt);
  updateGlimpse(dt);
  updateColossusBar();
  forEachSentinel(() => { // each Sentinel walks, streams its repair and shows its health bar
    updateIncome(dt); // (only the build buttons here)
    updateBlink(dt);
    defender.update(dt);
    updateRepairFx(dt);
    updateSentinelBar();
  });
  if (controlled === attacker) colossusHud.setHp(attacker.hp, attacker.maxHp);
  else defenderHud.setHp(defender.hp, defender.maxHp);
  troops.clientUpdate(dt, cam.camera);
  workers.clientUpdate(dt, cam.camera);
  if (boss) boss.clientUpdate(dt, cam.camera);
  buildings.update(dt, cam.camera);
  debris.update(dt);
}

// ---- Main loop ----
const clock = new THREE.Clock();
function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);

  cam.update(dt, map.size);
  sun.target.position.copy(cam.target);
  sun.position.copy(cam.target).add(new THREE.Vector3(-25, 45, -15));

  // The game itself (solo and the host), or showing the host's game (a client).
  if (isClient) clientStep(dt); else gameStep(dt);
  if (isHost) hostNetStep(dt);
  frameView(dt);
  requestAnimationFrame(frame);
}
// One step of the real game: everything that changes the game's state.
function gameStep(dt) {
  beamFrame = [];
  checkNextStep();
  updateAttackMove(dt);
  updateAttack(dt);
  attacker.update(dt);
  if (attacker.hitNow) { attacker.hitNow = false; landHit(); }
  updateWatchstones(dt);
  terrain.animate(clock.elapsedTime); // watchstone fires
  updateTurrets(dt);
  beams.update(buildings.time || 0); // after updateTurrets: beams not fired this frame hide
  updateBurns(dt);
  shots.update(dt);
  shardShots.update(dt);
  updateTempleHeal(dt);
  updateRegen(dt);
  updateRecall(dt);
  updateHidden(dt);
  updateGlimpse(dt);
  updateColossusRise(dt);
  updateColossusBar();
  updateWorks(dt);
  updateSalvage(dt);
  // Each Defender: their income, Blink cooldown, repairing, tunnels, walking, repair stream, health bar.
  forEachSentinel(() => {
    updateIncome(dt);
    updateBlink(dt);
    updateAutoRepair(dt);
    updateRepair(dt);
    updateTunnels(dt);
    defender.update(dt);
    updateRepairFx(dt);
    updateSentinelBar();
  });
  // Health readouts every frame, so healing and damage move smoothly.
  if (controlled === attacker) colossusHud.setHp(attacker.hp, attacker.maxHp);
  else defenderHud.setHp(defender.hp, defender.maxHp);
  updateTraining(dt);
  updateWorkers(dt);
  // Troops see with their own owner's sight.
  const visOf = (u) => slotById(u.owner ?? sentinels[0].id).vis;
  troops.update(dt, { colossus: attacker, seesColossusFor: (u) => visOf(u)[attacker.tile] === 2 && !colossusHidden(), camera: cam.camera, onStrike: onTroopStrike,
    onExpire: (u) => { debris.burst(u.x, map.heightAt(u.x, u.z) + 0.8, u.z, 0xe6e1ee, 30); toastOwner(u.owner, `A ${u.name} crumbled: its ${u.cfg.lifetime}s ran out`); },
    seesFoe: (f, u) => visOf(u)[f.tile] === 2 });
  updateBossCountdown(dt);
  if (boss) boss.update(dt, { targets: bossTargets(), hit: bossHit, camera: cam.camera });
  buildings.update(dt, cam.camera);
  debris.update(dt);
}
// What every screen does each frame after the game step: vision, what's shown, the cursor,
// HUD and minimap, and drawing.
function frameView(dt) {
  updateVision();
  updateDefVision();
  // The other side's character only shows while your side can see it.
  const seen = shownVis();
  // Your own units always show; anyone else's only where you can see right now (each Defender
  // has their own sight, so other Defenders' units in your fog are hidden too).
  const asColossus = multiplayer ? myRole === 'attacker' : controlled === attacker;
  attacker.parts.root.visible = colossusRiseT <= 0 && (asColossus || seesNow(attacker.x, attacker.z)); // not before it rises
  for (const s of sentinels) s.unit.parts.root.visible = (!asColossus && (playsSentinel(s) || !multiplayer)) || seesNow(s.unit.x, s.unit.z);
  for (const u of troops.list) u.parts.root.visible = (!asColossus && ownedByMe(u)) || seesNow(u.x, u.z);
  for (const w of workers.list) w.parts.root.visible = (!asColossus && ownedByMe(w)) || seesNow(w.x, w.z);
  if (boss) boss.setVisible(!fogEnabled || seen[boss.tile] > 0, seesNow(boss.x, boss.z)); // a landmark once explored; its fight only while in sight

  raycaster.setFromCamera(ndc, cam.camera);
  hover = pickGround(map, raycaster.ray);
  const ht = hover ? hover.tile : -1;
  if (ht !== lastHoverTile) { lastHoverTile = ht; hoverInfo.innerHTML = describeTile(ht); }
  if (buildType === 'wall') {
    if (ht >= 0) wallDragEnd = ht;
    const tiles = wallDragStart >= 0 ? lineTiles(map, wallDragStart, wallDragEnd) : ht >= 0 ? [ht] : [];
    const ok = affordableTiles('wall', tiles); // pieces past what you can afford show red
    buildings.showGhostTiles(tiles, (t) => ok.has(t));
  } else if (buildType) {
    buildings.showGhost(buildType, ht, ht >= 0 && canBuild(buildType, ht) && canAfford(buildType));
  }
  updateRangeRing(clock.elapsedTime);

  if (marker.visible) {
    markerTime += dt;
    marker.material.opacity = Math.max(0, 1 - markerTime / 0.8);
    marker.scale.setScalar(1 + markerTime * 0.8);
    if (markerTime > 0.8) marker.visible = false;
  }

  hudTimer -= dt; mapTimer -= dt;
  if (hudTimer <= 0) { hudTimer = 0.1; refreshHud(); }
  if (mapTimer <= 0) { mapTimer = 1 / 15; refreshMinimap(); }
  if (debug.fpsVisible) {
    fpsFrames++; fpsTime += clock.elapsedTime - fpsLast; fpsLast = clock.elapsedTime;
    if (fpsTime >= 0.5) { debug.setFps(Math.round(fpsFrames / fpsTime)); fpsFrames = 0; fpsTime = 0; }
  }

  renderer.render(scene, cam.camera);
}
let hudTimer = 0, mapTimer = 0, fpsFrames = 0, fpsTime = 0, fpsLast = 0;
// A host whose tab is hidden or minimized: the browser stops drawing frames (and so stops
// frame()), but the game has to go on for everyone else. A timer keeps it running in 0.05 s
// steps, catching up on the time since the last step (browsers slow background timers down).
if (isHost) {
  setInterval(() => {
    if (!document.hidden) return;
    let left = Math.min(2, clock.getDelta());
    while (left > 1e-4) { const dt = Math.min(0.05, left); left -= dt; gameStep(dt); hostNetStep(dt); }
  }, 250);
}
window.addEventListener('resize', () => renderer.setSize(window.innerWidth, window.innerHeight));
frame();

// Clicked buttons shouldn't keep focus, or Space would "press" them again.
document.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => b.blur()));
