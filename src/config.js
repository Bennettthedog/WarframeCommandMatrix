// Central tuning values. Change numbers here rather than inside the systems.

// Multiplayer (src/net.js): browsers connect peer to peer (WebRTC) through the free public
// PeerJS service. iceServers: STUN servers that help two browsers find a direct route.
// Behind carrier-grade NAT (Starlink, many mobile networks) a direct route often isn't
// possible, and the connection needs a TURN relay: make a free account at metered.ca (Open
// Relay, about 20 GB a month free), create a TURN app, and put its app name (the part before
// ".metered.live") and API key in `metered`. The game then fetches relay credentials before
// connecting. The key ends up in the page, so use one made just for this game.
// countdown: seconds from everyone being ready to the game starting. snapshotRate: how many
// times a second the host sends the game state to the other players.
export const NET = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }],
  metered: { app: '', apiKey: '' },
  countdown: 5,
  colossusDelay: 30, // seconds after the start before the Colossus rises (the Sentinels start in its temple)
  snapshotRate: 10,
  maxName: 16,
};

export const MAP_SIZE = 75;           // tiles per side
export const LEVEL_MIN = -2;          // five height levels: -2, -1, 0 (base), +1, +2
export const LEVEL_MAX = 2;
export const LEVEL_HEIGHT = 0.75;     // world units per level
export const COLUMN_BOTTOM = -3;      // world y where terrain columns end

export const RUIN_RADIUS = 6;         // the Colossus's temple in the map center

// Defender bases, built from the custom shapes (shapes/base_shapes.json, made with
// tools/shape_editor.py).
// BASE_COUNT: how many bases per map (random in this range).
// BASE_RADIUS: each base's random size, in tiles from its center to its farthest edge.
// SPREAD_CANDIDATES: each base tries this many spots and takes the one farthest from the
//   others, so bases spread out evenly. Higher = more even spacing.
// PLACEMENT_TRIES: the most random spots tried per base before giving up.
// RAMP_WIDTHS: each ramp is randomly one of these widths (tiles).
export const BASE_COUNT = [17, 20];
// EDGE_SHARE: about this share of bases are placed backed up against the map edge.
// EDGE_WALL: open ground within this many tiles of the edge becomes an impassable rock wall,
//   so the map's border is never a walkway.
export const EDGE_SHARE = 0.5;
// CORNER_BASES: put a base into each map corner first (the shape that fills it best), so
//   corners aren't left as dead wall or empty ground.
export const CORNER_BASES = true;
// INNER_BASES: bases placed out in the middle of the map, in a ring around the temple
//   (never on the edge), to fill the open ground there. maxDistance: how far out, as a
//   fraction of half the map width. radius: their size (smaller than BASE_RADIUS, so they
//   fit in close to the temple). Small bases of this size also fill leftover gaps anywhere.
// centerFill: after everything else, extra bases (up to BASE_COUNT's max) go wherever they
//   cover the most open ground in the middle ring, while each still covers at least this many
//   tiles of it.
export const INNER_BASES = { count: [5, 7], maxDistance: 0.62, radius: [7, 12], centerFill: 30 };
// TEMPLE_CLEARING: open ground kept around the temple's edge, in tiles (no base closer).
export const TEMPLE_CLEARING = 4;
export const EDGE_WALL = 2;
export const BASE_RADIUS = [8, 14];
export const SPREAD_CANDIDATES = 20;
export const PLACEMENT_TRIES = 600;
export const CORRIDOR_WIDTH = 4;      // open ground between neighbouring bases (tiles)
// Bases may also back right up against each other (never connected: always a cliff where
// they meet, and no ramp between them).
// TOUCH_SHARE: about this share of all bases back up against at least one other base.
// MAX_TOUCH_SHARE: the most of a base's edge that may touch other bases (rest faces open ground).
export const TOUCH_SHARE = 0.3;
export const MAX_TOUCH_SHARE = 0.5;
export const RAMP_WIDTHS = [1, 2];
// How often each width is picked: 1-wide ramps are a little rarer than 2-wide (40% / 60%).
export const RAMP_WIDTH_WEIGHTS = [0.4, 0.6];

// Base quality (0..1): mostly closeness to the center, partly base size.
export const QUALITY_WEIGHTS = { closeness: 0.8, size: 0.2 };
// Stars by quality rank: top 25% are 3-star, next 35% are 2-star, the rest 1-star.
export const STAR_SHARES = { 3: 0.25, 2: 0.35 };

// Crystal rocks (future advanced currency). Count scales with quality rank.
export const CRYSTALS_MIN = 2;        // worst base
export const CRYSTALS_MAX = 9;        // best base
export const ELITE_BASES = 2;        // the very best bases get rare gold crystals
export const CRYSTAL_OUTER_SHARE = 0.4; // two-tier bases: share of crystals on the outer (±1) tier

export const LEVEL_COLORS = {
  '-2': 0x3e5c4c,   // marsh lowland
  '-1': 0x5d7f45,   // meadow
  '0': 0x7f9651,    // base grassland
  '1': 0xa69463,    // dry upland
  '2': 0x8e8a82,    // rocky highland
};
export const RUIN_COLOR = 0x9c968a;
export const ROCK_COLOR = 0x4a4540;
export const RAMP_TINT = 0xb39c6b;
export const SITE_TINTS = { 3: 0xe0b852, 2: 0xc4ccd4, 1: 0xb5794a };

// damage: per hit. attackRate: hits per second. range: how far it reaches (tiles, from its
// center to the nearest tile of the target); it can hit up to one level above or below.
// hp: health (the Colossus has a single life).
// templeHeal: share of its max HP it regains per second while standing in its temple
//   (0.25 = 25%/s; it can't be revived there).
// templeRamp: seconds for the healing to build up to full speed after it steps in.
// acquireRange: during an attack move, it attacks anything it can see within this many tiles.
// splash: each slam also hits every defender troop within this many tiles of where it lands.
// recall: the Recall ability (R) teleports it back into its temple; cooldown in seconds.
export const ATTACKER = { hp: 500, speed: 4.2, visionRadius: 10, damage: 10, attackRate: 0.9, range: 1.8,
  templeHeal: 0.25, templeRamp: 1, acquireRange: 6, splash: 1.2, recall: { cooldown: 60 },
  // Hidden Dancing Blade (F): the Colossus can't be targeted for `duration` seconds (turrets,
  // beams and troops ignore it; boulders already flying at it miss). `charges` per game, no cooldown.
  hiddenBlade: { name: 'Hidden Dancing Blade', charges: 3, duration: 8 },
  // Watchfire Glimpse (G, then click a spot): sight of everything within an area of `areaShare`
  // of the map round that spot (cliffs don't block it) for `duration` seconds.
  glimpse: { name: 'Watchfire Glimpse', duration: 5, cooldown: 25, areaShare: 1 / 24 } }; // 1/24: half the radius of 1/6

// The Colossus's items, bought in its temple shop (it must stand inside) with gold, and held
// in INVENTORY_SLOTS slots. Each kind comes in tiers (I-X, or I-V for armor and speed):
//   values[i]: tier i+1's effect. costs[i]: its price.
//   stacks: whether items of this kind add up when you hold several. All are false: only your
//     best item of each kind counts, so a tier matches a defender level (the balance curve).
//   damage: its damage per hit with that item (replaces ATTACKER.damage, 10).
//   armor: share of incoming damage blocked (0.18 = 18%), up to 97.5% at tier X.
//   regen: HP per second it regains, out of combat only (REGEN_DELAY seconds after its last hit).
// The balance: a matched wall always takes 20 hits; with every item at a defender's level, the
// Colossus outlasts the time to break a matched wall by about 1.6-2x at mid attack speed.
// Items sell back for their full price (in the temple).
export const INVENTORY_SLOTS = 6;
export const REGEN_DELAY = 4;
const ITEM_PRICES = [400, 1200, 2800, 6000, 12400, 25200, 50800, 102000, 204400, 409200]; // gold
// Platinum: the late-game currency for tiers XI-XV. The Colossus trades gold for it in its
// temple (one-way, `rate` gold per platinum). XI-XV cost about 10× the old gold prices
// (818,800 → 13,106,800), paid in platinum: 8,000 platinum = 8,000,000 gold.
export const PLATINUM = { rate: 1000 };
const PLAT_PRICES = [8000, 16000, 32000, 64000, 128000]; // XI-XV, platinum
// Tiers XI-XV match defender levels 11-15, with power spikes on both sides:
//   11: Turret ×4 · Blade ×4 · Armor ×4 (damage taken ÷4)   12: Wall ×4
//   15: Blade ×4 (the Colossus should beat most bases)        otherwise ×2 a level.
export const SHOP = [
  // From tier XI the fists become a blade (renamed "Titan Blade" in the shop and inventory).
  { id: 'damage', name: 'Heavy Fists', stat: 'damage per hit', key: '1', stacks: false,
    tierNames: { 11: 'Titan Blade' }, platinumFrom: 11, // XI-XV are paid in platinum
    values: [20, 40, 80, 160, 320, 640, 1280, 2560, 5120, 10240, 40960, 81920, 163840, 327680, 1310720], costs: [...ITEM_PRICES, ...PLAT_PRICES] },
  { id: 'armor',  name: 'Stone Armor', stat: 'damage reduction', key: '2', stacks: false,
    // VIII-X take over from the removed Titan Heart VIII-X: with Titan Heart VII, they keep the
    // Colossus's effective health (HP / (1 - armor)) on the old curve (180k, 360k, 720k).
    // XI cuts the damage taken to a quarter (the spike), XII-XV halve it again each tier.
    platinumFrom: 11,
    values: [0.18, 0.36, 0.53, 0.71, 0.8, 0.82, 0.84, 0.9, 0.95, 0.975,
      0.99375, 0.996875, 0.9984375, 0.99921875, 0.999609375], costs: [...ITEM_PRICES, ...PLAT_PRICES] },
  { id: 'regen',  name: 'Regen Core',  stat: 'HP per second', key: '3', stacks: false,
    values: [30, 45, 75, 105, 135, 270, 525, 1050, 2100, 4300], costs: ITEM_PRICES },
  // attackSpeed: extra hits per second on top of ATTACKER.attackRate (0.9). Stops at tier V.
  { id: 'attackSpeed', name: 'Swift Strikes', stat: 'hits per second', key: '4', stacks: false,
    values: [1.5, 2, 2.5, 3, 3.5], costs: ITEM_PRICES.slice(0, 5) },
  // maxHp: extra max health on top of ATTACKER.hp (500). Buying one also adds that much
  // current health; selling one takes the extra max health away again. Stops at tier VII
  // (Stone Armor carries the survivability from there).
  { id: 'maxHp', name: 'Titan Heart', stat: 'max HP', key: '5', stacks: false,
    values: [500, 1000, 2000, 3000, 4000, 8500, 17500], costs: ITEM_PRICES.slice(0, 7) },
  // Placeholder: it has a tab in the shop but no items yet (fill in values/costs to add it).
  //   moveSpeed: tiles per second.
  { id: 'moveSpeed',   name: 'Move speed',   stat: 'tiles per second', key: '6', values: [], costs: [] },
];
// An item's name at a tier: its tierNames entry at or below that tier, else its name.
export function itemTierName(item, tier) {
  let name = item.name;
  for (const [from, n] of Object.entries(item.tierNames || {})) if (tier >= Number(from)) name = n;
  return name;
}
// Which currency a tier costs: 'platinum' from the item's platinumFrom tier, else 'gold'.
export const itemCurrency = (item, tier) => (item.platinumFrom && tier >= item.platinumFrom ? 'platinum' : 'gold');
export const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV'];

// Defender characters. Test version: looks and movement only.
// model: 'sentinel' (small floating stone construct) or 'warden' (soldier).
// colors: team colors, one per defender player.
// visionRadius: the defender character's sight (its buildings see too, see BUILDINGS.vision).
export const DEFENDER = {
  model: 'sentinel',
  hp: 20,            // the Colossus can attack it; if every Sentinel falls, the defenders lose
  speed: 3.6,
  visionRadius: 10,
  buildRange: 8,     // can only place buildings within this many tiles of the character
  // Repairing damaged buildings (free). rate: share of max HP healed per second.
  // Walls: repairing one repairs every wall piece connected to it, but each heals at
  // the full rate for 1-2 pieces, then rate / (n - 1)², where n is the number of connected
  // pieces (3 = ÷4, 4 = ÷9). range: how close it must stay (tiles).
  // 15%: a Sentinel repairing a 1-2 piece ramp plug makes each piece last ~15 s against a
  // matched-level Colossus (4.5 s unrepaired), longer than it survives the turrets.
  repair: { rate: 0.15, range: 2 },
  // Auto-repair (toggle): while idle, it goes to repair damaged buildings within this many tiles.
  autoRepair: { on: true, range: 8 },
  // Salvage: take a building apart for a full refund after this many seconds
  // (no refund if it's destroyed before then).
  salvageTime: 5,
  // Seconds to build a building (it rises out of the ground; a turret can't fire, a Core makes
  // no stone, a Barracks or Quarry can't be used until it's done; walls block at once) and to
  // upgrade one (paid up front, the new level lands when it's done). Debug summons are instant.
  buildTime: 1,
  upgradeTime: 1,
  // Blink (F, then click): teleport to any open tile within buildRange, seen or not.
  blink: { cooldown: 30 },

  // Team colors, one per Defender in a multiplayer game (in join order): blue, red, green,
  // gold, purple, orange, teal, pink. Their Sentinel, buildings, wall crystals and troops.
  colors: [0x2f6fd6, 0xc0392b, 0x2e9e5b, 0xd4a017, 0x8e44ad, 0xe67e22, 0x16a3a3, 0xe0609a],
};

// Troops: units the defenders summon at a Barracks (select it, then click a unit button).
// cap: most troops per defender (counting ones still in training).
// acquireRange: idle troops go after the Colossus when it's this close (tiles) and they can see it.
// leash: troops that went after it by themselves return home once this far from their spot.
// Per unit: cost (stone), trainTime (seconds at the Barracks), hp, damage per attack,
// rate (attacks per second), range (tiles from the Colossus's edge; ranged units also need
// line of sight), speed (tiles per second), vision (tiles).
// Late troops (unlocked by Barracks upgrades): crystalCost (crystals as well as stone),
// barracksLevel (the Barracks level that unlocks it), lifetime (seconds it lasts before it
// crumbles; none = forever), model ('pebble' or 'slinger' shape), scale (size), stone/dark/glow
// (its colors; glow defaults to the team color). A unit with `flight` is ranged.
export const TROOPS = {
  cap: 20,
  acquireRange: 7,
  leash: 10,
  pebble:  { name: 'Pebble Golem', cost: 4, trainTime: 5, hp: 15, damage: 2, rate: 1, range: 0.6, speed: 3.4, vision: 5 },
  slinger: { name: 'Shard Slinger', cost: 8, trainTime: 7, hp: 10, damage: 4, rate: 1 / 1.5, range: 5, speed: 3.1, vision: 7, flight: 0.45 },
  // Barracks level 1 (needs a level-10 Core): hits as hard as a level-10 turret (17,920 dmg/s)
  // and can take about three Heavy Fists X slams, at about twice a full level-10 turret's price.
  lancer:  { name: 'Quartz Lancer', cost: 25000, crystalCost: 1500, barracksLevel: 1, trainTime: 8,
    hp: 30000, damage: 12800, rate: 1.4, range: 5, speed: 3.1, vision: 8, flight: 0.3,
    model: 'slinger', scale: 1.5, stone: 0xd9d3e0, dark: 0xa79fb5 },
  // Barracks level 2 (needs a level-15 Core): a huge golem of quartz and gold that beats a
  // matched Colossus one on one (Blade XV / Armor XV: about 46M effective health, which one Warden
  // takes down in about 20 s; Blade XV needs about 26 s to break a Warden) but crumbles after 40 s.
  warden:  { name: 'Titan Warden', cost: 2000000, crystalCost: 25000, barracksLevel: 2, trainTime: 12, lifetime: 40,
    hp: 150000000, damage: 1500000, rate: 1.5, range: 0.8, speed: 3.6, vision: 8,
    model: 'pebble', scale: 2.3, stone: 0xe6e1ee, dark: 0xc9a43a, glow: 0xffc93c },
};

// Quarry workers: hired at a Quarry (select it), any kind at any time, up to `cap` alive at
// once (shown above the Quarry). They are units the
// defender can select and order (right-click a crystal rock to mine it, the ground to move,
// the Quarry to go back to mining on their own). Left alone, each walks to the crystal rock
// nearest the Quarry and mines it. Crystals come only while mining: `rate` per second, times
// goldBonus on a gold (rare) rock, and only while a Quarry stands. The Colossus can kill them;
// a lost worker frees its place under the cap. All look the same, colored by their ore. Names: "<ore> Helper".
// fancy: the name is shown with ornate capitals.
export const QUARRY_WORKERS = {
  hp: 40, speed: 2.6, vision: 4,
  cap: 10,             // helpers alive at once (all kinds together)
  sizeStep: 0.07,      // each better kind is this much bigger (Malachite 1×, New Hematite 1.42×)
  dismissRefund: 0.5, // dismissing a helper gives back this share of its stone cost
  mineTime: 2.5,       // seconds of work per chunk of ore (the chunk pops up; income is continuous)
  goldBonus: 1.5,      // gold crystal rocks give this times the crystals
  searchRadius: 25,    // how far from the Quarry they look for a crystal rock (tiles)
  list: [
    { ore: 'Malachite',     color: 0x2fa36b, glow: 0x52e39a, cost: 500,   rate: 0.5 },
    { ore: 'Azurite',       color: 0x2a55c9, glow: 0x5b8bff, cost: 1000,  rate: 1 },
    { ore: 'Cinnabar',      color: 0xc4322b, glow: 0xff5a48, cost: 2000,  rate: 2 },
    { ore: 'Pyrite',        color: 0xc9a43a, glow: 0xffd75e, cost: 4000,  rate: 4 },
    { ore: 'Amethyst',      color: 0x8e4fd8, glow: 0xc28bff, cost: 500000,  rate: 8 },   // 5-7: priced for Core 11-15
    { ore: 'Rhodochrosite', color: 0xe0688f, glow: 0xff9cbc, cost: 2000000, rate: 16 }, // (about 4 / 16 / 65 min of
    { ore: 'New Hematite',  color: 0x5d6168, glow: 0xd8262f, cost: 8000000, rate: 32, fancy: true, // level-10 Core income)
      sound: 'audio/new-hematite-helper.mp3' }, // played when one is hired
  ],
};

// Watchstones: raised (+1) mounds with a standing stone. Standing next to the stone
// (within `range` tiles) gives a huge vision radius.
// Building upgrades (defenders, instant). Each building goes from level 0 (as built) up to
// level 15. Each level doubles one stat and nothing else, unless `mult` says otherwise:
//   Town Hall: stone income · Turret: damage per shot · Wall: max HP.
// costs: the stone for level 1, 2, ... 15. Walls: per piece (upgrading a piece upgrades its
// whole connected line, and you pay for each piece).
// crystals: extra crystal cost per level (0 = none). requires: { level: building type that
// must be standing to buy that level }. mult: { level: stat multiplier } where it isn't ×2.
// Level 6 is special: the Town Hall "ascends" (needs a Quarry), and the Turret picks one of
// two forms (variants), which it keeps from then on.
// Levels 11-15 (the late game), with the power spikes:
//   11: Turret ×4 (and from 11 on, Turret upgrades cost crystals only)   12: Wall ×4.
//   The Colossus's Titan Blade XI and Stone Armor XI answer 11, and Titan Blade XV is its spike.
// Crystal costs at 11-15 go 1 : 2 : 2 : 4 : 4, matching a full crew of the late helper kinds
// (Amethyst 80/s, Rhodochrosite 160/s, New Hematite 320/s): about 2 minutes per level for a
// Core, 5 Turrets and a 2-piece wall plug.
export const MAX_UPGRADE_LEVEL = 15;
export const UPGRADES = {
  townhall: { stat: 'stone income', costs: [60, 120, 240, 480, 960, 1920, 3840, 7680, 15360, 30720,
    61440, 122880, 245760, 491520, 983040],
    // Crystal costs double from level 7, like helper output, so each level needs the next
    // helper kind at the cap to keep pace (2.5 → 5 → 10 → 20 → 40 crystals/s for a full base).
    crystals: [0, 0, 0, 0, 0, 45, 45, 90, 180, 360, 720, 1440, 1440, 2880, 2880], requires: { 6: 'quarry' },
    // stone/s at these levels, instead of doubling (level 6: 128, ×4, then doubling again)
    incomeAt: { 6: 128, 7: 256, 8: 512, 9: 1024, 10: 2048, 11: 4096, 12: 8192, 13: 16384, 14: 32768, 15: 65536 } },
  cannon:   { stat: 'damage',       costs: [12, 24, 48, 96, 192, 384, 768, 1536, 3072, 6144, // starts at 2× the build cost (6)
    0, 0, 0, 0, 0],                 // 11-15: crystals only
    crystals: [0, 0, 0, 0, 0, 45, 45, 90, 180, 360, 1440, 2880, 2880, 5760, 5760],
    mult: { 6: 1, 11: 4 },          // 6: the form's own bonus instead (variants); 11: the ×4 spike
    rateAt: { 3: 0.1, 5: 0.1 },     // levels 3 and 5 also add this many shots per second (0.5 → 0.6 → 0.7)
    // Level 6 (variantLevel) is a choice between two very different turrets (same price).
    variantLevel: 6,
    variants: {
      // aimsEachShot: the time between throws (1 / its rate, 1.43 s) is spent aiming: it must
      // keep the same target in range that whole time to throw. If the target leaves range
      // (or it switches target), the throw is cancelled and the aim starts over.
      // burn: share of each boulder's damage that lands as damage over time ("Crushed") instead
      // of on impact, spread over `duration` seconds. Each boulder adds its own burn (they
      // stack), armor reduces it, and it keeps Regen Core paused. Only the Colossus burns.
      siege: { name: 'Siege Titan', effect: 'damage ×2, half as a 4 s burn', damage: 2, rate: 1, aimsEachShot: true,
        burn: { share: 0.5, duration: 4 } },
      // speedUntil: from level 7 up to this level, each level doubles its attack speed instead
      // of its damage (same damage per second as the Siege Titan), and its shards fly straight
      // and fast. beamAt: from this level it fires a continuous beam (damage every frame) at the
      // same damage per second; from then on its damage goes up each level as normal.
      storm: { name: 'Shard Storm', effect: 'attack speed ×2', damage: 1, rate: 2, speedUntil: 9, beamAt: 10,
        shardFlight: 0.22 }, // seconds a straight shard takes to reach its target (level 7+)
    } },
  // Priced for a typical base (Core + ~5 Turrets + a 2-piece ramp plug): a plug costs about as
  // much as a same-level Core upgrade (30 s of its income, 15 s from level 6).
  wall:     { stat: 'max HP',       costs: [30, 60, 120, 240, 480, 960, 1920, 3840, 7680, 15360, // per piece
    30720, 61440, 122880, 245760, 491520],
    crystals: [0, 0, 0, 0, 0, 75, 75, 150, 300, 600, 1200, 2400, 2400, 4800, 4800], // crystals per piece from level 6
    mult: { 12: 4 },                                 // the wall spike
    requires: { 6: 'quarry' } },                     // so the boss's crystals can't be spent on walls before the Quarry
  // Barracks: two levels, each unlocking a late troop (TROOPS[..].barracksLevel).
  // requiresCore: { level: the Core level you need standing to buy it }.
  barracks: { stat: 'troops', costs: [30000, 1000000], crystals: [1500, 15000], requiresCore: { 1: 10, 2: 15 } },
};

export const WATCHSTONES = {
  count: [1, 2],            // how many per map (random in this range)
  radius: 4,                // mound size, in tiles
  distance: [0.45, 0.75],   // from the temple, as a fraction of half the map width
  range: 2,                 // how close to the stone counts as "next to it" (tiles)
  visionRadius: 30,         // vision while there (normal vision is ATTACKER.visionRadius)
  // Its fire: the Colossus lights it by stepping next to it while it's ready. Then it gives
  // the far sight for `duration` seconds (only while the Colossus stands there); over the last
  // `fade` seconds the sight shrinks back to normal as the fire dies. Then it's cold for
  // `cooldown` seconds and relights. While ready, the Colossus can see `readyVision` tiles
  // round it from anywhere (it knows the fire is lit and what's next to it).
  duration: 15,
  fade: 3,
  cooldown: 600,            // 10 minutes
  readyVision: 2,
};
export const WATCHSTONE_COLOR = 0x8f8778;

// Boss zone: one map corner (picked from the seed) is kept for the boss instead of a base.
// radius: its size in tiles, measured from the corner. level: the arena is raised to this
// level, with `ramps` ramps up onto it spread around its edge. lair: how far in from each
// edge the lair (where the boss stands) sits, in tiles. pads: turret pads in an arc of
// `padArc` radians, `padDistance` tiles from the lair (turrets are the only building
// allowed in the arena). Bases keep CORRIDOR_WIDTH away from it; no groves or crystals.
export const BOSS_ZONE = { radius: 15, level: 1, ramps: 3, lair: 6, pads: 5, padArc: 2.4, padDistance: 5 };
export const BOSS_ZONE_COLOR = 0x4a4252;   // ashen ground with a violet cast
export const BOSS_GLOW = 0x9a5bff;         // crystal light in the lair

// The boss: a purple crystal monolith rooted in the lair (it never moves). Neutral: it attacks
// anyone who comes within `range` tiles, the Colossus or the defenders, one target at a time
// and very slowly: it marks the target's spot with a glowing circle, and after `windup`
// seconds a huge crystal spike erupts there for `damage`. Step out of the circle in time and
// it misses. Then it waits `cooldown` seconds. It never heals. radius: its size, for reach
// and ranged aim. lowHealth: everyone is told when it drops to this share of its HP.
// buildingDamage: its spike against buildings (turrets on the pads survive a few).
export const BOSS = {
  name: 'Crystal Monarch',
  hp: 600,
  damage: 120,
  buildingDamage: 30,
  cooldown: 7,
  windup: 1.6,
  range: 8,
  spikeRadius: 1.0,
  radius: 1.1,
  lowHealth: 0.25,
  rewardCrystals: 10,   // every defender gets this many crystals (the rare currency) when it dies
  // It isn't on the map at the start. When the first Town Hall reaches this upgrade level,
  // everyone is told it's coming, and it rises in its lair `spawnDelay` seconds later.
  spawnTownHallLevel: 4,
  spawnDelay: 15,
};

// Tunnels: only the defenders' Sentinels can use them. Each runs from inside a deep basin
// (-2) base to open ground on the far side of the map (mirrored across the center).
// count: how many per map (fewer if the map has fewer deep basins).
// cooldown: seconds before the Sentinel can use a tunnel again. travelTime: seconds spent
// going in and coming out. Mouths are set into cliff walls; only the one floor tile in front
// of each mouth can't be built on.
export const TUNNELS = { count: [1, 2], cooldown: 30, travelTime: 1.2 };
export const TUNNEL_GLOW = 0x9a6bff; // purple energy in the tunnel mouths

// Pine groves on open ground. They block movement and building (not vision).
// count: groves per map. size: tiles per grove. spacing: min distance between grove centers.
// clearance: how far groves stay from ramps, so base entrances stay open.
// Groves that would cut off any ground are skipped.
export const GROVES = { count: [7, 10], size: [6, 16], spacing: 9, clearance: 2 };
export const FOREST_FLOOR_COLOR = 0x4f6a37;
export const PINE_COLOR = 0x2f5a35;

// hp: hit points. height: roughly how tall it is (where its health bar floats).
// vision: how far the defenders see from it (tiles; same cliff rules as the characters).
// cost: stone to build it (walls: per piece). No cost = free.
export const BUILDINGS = {
  // income: stone (the defenders' basic currency) per second while it stands.
  // perSentinel: how many can be standing at once per Sentinel (another can be built once it falls).
  townhall: { name: 'Core', size: 3, hp: 150, height: 4.0, vision: 9, income: 1, perSentinel: 1 },
  barracks: { name: 'Barracks', size: 2, hp: 75, height: 2.0, vision: 6, cost: 10 },
  // The defenders' turret. attack: it lobs its boulder at the Colossus when it's within
  // range (tiles) and in line of sight (same cliff rules as vision: it can fire down a cliff,
  // not up one). damage per boulder, rate = shots per second, flight = seconds in the air.
  cannon:   { name: 'Turret', size: 1, hp: 75, height: 1.3, vision: 8, cost: 6,
    attack: { range: 6, damage: 25, rate: 0.5, flight: 0.9 } },
  // crystalCost: crystals (the rare currency) to build it, on top of any stone cost.
  quarry:   { name: 'Quarry',   size: 2, hp: 75, height: 1.0, vision: 5, crystalCost: 10, perSentinel: 1 },
  wall:     { name: 'Wall',     size: 1, hp: 200, height: 1.2, vision: 2, cost: 3 },   // click-drag to draw a line; cost per piece
};
