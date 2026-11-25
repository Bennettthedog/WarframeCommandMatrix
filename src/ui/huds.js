// The two character HUDs (bottom-left), the resource bar (top center), and the info panel
// for the selected building or attack target (bottom center).
import { el, setText, setBar, show, ICONS } from './dom.js';
import { BUILDINGS, DEFENDER, ATTACKER, SHOP, INVENTORY_SLOTS, ROMAN, itemTierName, itemCurrency, PLATINUM } from '../config.js';

const SHOP_ICONS = { damage: 'sword', armor: 'shield', regen: 'plus', attackSpeed: 'clock', moveSpeed: 'speed', maxHp: 'heart' };
// The effect of an upgrade at a given value, e.g. "40 dmg/hit".
// 0.975 → 97.5; past 99% two decimals, so the late armor tiers read apart (99.38, 99.69 …).
const pct = (v) => +(v * 100).toFixed(v >= 0.99 ? 2 : 1);
const shopEffect = (s, v) => (s.id === 'armor' ? `−${pct(v)}% dmg taken`
  : s.id === 'regen' ? `+${v} HP/s` : s.id === 'damage' ? `${v} dmg/hit`
    : s.id === 'attackSpeed' ? `+${v} hits/s` : s.id === 'maxHp' ? `+${v} max HP` : `${v} ${s.stat}`);

// Portraits drawn as tiny inline SVGs, matching the 3D models.
const GOLEM_PORTRAIT = `<svg viewBox="0 0 48 48"><path d="M3 26l3-9 9-3 4 6-2 10-9 3z" fill="#8f887b"/><path d="M45 26l-3-9-9-3-4 6 2 10 9 3z" fill="#8f887b"/>
  <path d="M5 17l5-4 6 1-2 3z M43 17l-5-4-6 1 2 3z" fill="#5f7d3c"/>
  <path d="M13 24l11-5 11 5 2 13-13 10-13-10z" fill="#77705f"/><path d="M17 11l7-4 7 4-1 9h-12z" fill="#a9a191"/>
  <rect x="16" y="11" width="16" height="3" fill="#625c53"/><rect x="18.5" y="15" width="4" height="1.6" fill="#ff4a32"/><rect x="25.5" y="15" width="4" height="1.6" fill="#ff4a32"/>
  <path d="M24 26l4 4-4 5-4-5z" fill="#ff8a5c"/><path d="M20 28l-4-3M28 28l4-3M21 33l-4 3M27 33l4 3" stroke="#ff4a32" stroke-width="1.3"/></svg>`;
const sentinelPortrait = (team) => `<svg viewBox="0 0 48 48"><circle cx="24" cy="29" r="13" fill="${team}" opacity=".25"/>
  <path d="M14 26l6-6 7 2 5 6-3 8-9 2-6-5z" fill="#857d70"/><path d="M20 32l5-3 6 4-4 6-6-1z" fill="#5c564e"/>
  <circle cx="24" cy="29" r="4" fill="${team}"/><path d="M18 8l7-2 6 4-1 8-8 1-5-5z" fill="#857d70"/>
  <circle cx="21.5" cy="12" r="1.4" fill="#fff"/><circle cx="26.5" cy="12" r="1.4" fill="#fff"/>
  <path d="M5 28l5-3 3 4-3 4-5-1zM43 28l-5-3-3 4 3 4 5-1z" fill="#857d70"/></svg>`;

function unitPanel(root, cls, portrait, title) {
  const panel = el('section', `hud unit-hud ${cls}`);
  panel.innerHTML = `
    <header>
      <div class="portrait">${portrait}</div>
      <div class="who"><h2>${title}</h2><div class="status" data-k="status">Idle</div></div>
    </header>
    <div class="bar hp" title="Health"><div class="fill"></div><span class="bar-text" data-k="hp"></span></div>`;
  root.appendChild(panel);
  return panel;
}

// An item's effect, e.g. "80 dmg/hit" or "+30 HP/s out of combat".
const itemEffect = (s, v) => (s.id === 'regen' ? `+${v} HP/s out of combat` : shopEffect(s, v));

// A name with its words' first letters in the fancy capitals (like the New Hematite Helper).
const fancyHtml = (text) => `<span class="fancy-name">${text.split(' ').map((w) => `<span class="fancy-cap">${w[0]}</span>${w.slice(1)}`).join(' ')}</span>`;
// A price with its currency's icon: "◎ 400" in gold, or "▱ 8000" in platinum.
const coin = (cur) => (cur === 'platinum' ? `<i class="plat">${ICONS.platinum}</i>` : ICONS.gold);

export function createColossusHud(root, { onAttackMove, onBuy, onSell, onToggleShop, onRecall, onTrade, onBlade, onGlimpse } = {}) {
  const panel = unitPanel(root, 'hud-colossus', GOLEM_PORTRAIT, 'The Colossus');
  panel.insertAdjacentHTML('beforeend', `
    <div class="unit-actions">
      <button class="act-btn" data-k="amove" title="Attack move: then click where to go. It attacks anything it sees on the way.">
        ${ICONS.sword}<span>Attack move</span><kbd>X</kbd></button>
      <button class="act-btn" data-k="shopBtn" title="Open or close the temple shop (buying needs the Colossus in its temple)">
        ${ICONS.gold}<span>Shop</span><i class="shop-dot" data-k="shopDot" hidden></i><kbd>O</kbd></button>
    </div>
    <div class="unit-actions">
      <button class="act-btn recall-btn" data-k="recall" title="Recall: teleport back into the temple (${ATTACKER.recall.cooldown} s cooldown)">
        <i class="cd-fill" data-k="recallFill"></i>${ICONS.hall}<span data-k="recallText">Recall</span><kbd>R</kbd></button>
      <button class="act-btn recall-btn" data-k="glimpse" title="${ATTACKER.glimpse.name}: then click a spot (or the minimap) to see everything round it, about a sixth of the map, for ${ATTACKER.glimpse.duration}s. ${ATTACKER.glimpse.cooldown} s cooldown. Right-click or Esc cancels.">
        <i class="cd-fill" data-k="glimpseFill"></i>${ICONS.eye}<span data-k="glimpseText">Glimpse</span><kbd>G</kbd></button>
    </div>
    <div class="unit-actions">
      <button class="act-btn blade-btn" data-k="blade" title="${ATTACKER.hiddenBlade.name}: untargetable for ${ATTACKER.hiddenBlade.duration}s (turrets, beams and troops can't target it; boulders already flying at it miss). ${ATTACKER.hiddenBlade.charges} per game, no cooldown.">
        <i class="cd-fill" data-k="bladeFill"></i>${ICONS.sword}<span>${fancyHtml(ATTACKER.hiddenBlade.name)}</span><b class="charges" data-k="bladeCharges"></b><kbd>F</kbd></button>
    </div>
    <div class="stats">
      <div title="Damage per hit">${ICONS.sword}<span data-k="dmg"></span></div>
      <div title="Hits per second">${ICONS.clock}<span data-k="rate"></span></div>
      <div title="Move speed (tiles per second)">${ICONS.speed}<span data-k="speed"></span></div>
      <div title="Vision radius (tiles)" data-k="visionBox">${ICONS.eye}<span data-k="vision"></span></div>
    </div>
    <div class="chips" data-k="chips"></div>
    <div class="inv-title">Inventory <small data-k="invHint"></small></div>
    <div class="inventory" data-k="inventory">
      ${Array.from({ length: INVENTORY_SLOTS }, (_, k) => `<button class="inv-slot empty" data-slot="${k}"></button>`).join('')}
    </div>`);

  // The temple shop: a separate pop-up window, hidden until opened (O or the Shop button).
  // Pick a kind of item with the tabs (or 1-6), then its tiers I-V are listed. Click one to
  // buy it into a free inventory slot.
  const shop = el('section', 'hud shop-panel');
  shop.hidden = true;
  shop.innerHTML = `
    <header class="shop-head">
      <h3>${ICONS.gold} Temple shop</h3>
      <span class="shop-gold" data-k="shopGold"></span>
      <button class="shop-close" data-k="shopClose" title="Close (O or Esc)">×</button>
    </header>
    <div class="shop-trade" title="Platinum pays for tiers XI–XV. ${PLATINUM.rate} gold = 1 platinum.">
      <span class="shop-plat">${ICONS.platinum}<span data-k="shopPlat"></span></span>
      <small>${PLATINUM.rate} gold = 1</small>
      <button class="shop-trade-btn" data-k="trade" title="Trade all your gold for platinum (${PLATINUM.rate} gold each; the leftover gold stays). One-way. In the temple only.">Trade gold</button>
    </div>
    <div class="shop-tabs">
      ${SHOP.map((s) => `
        <button class="shop-tab${s.costs.length ? '' : ' soon'}" data-id="${s.id}" title="${s.name} (${s.key})${s.costs.length ? '' : ': coming soon'}">
          ${ICONS[SHOP_ICONS[s.id]]}<span>${s.name}</span><kbd>${s.key}</kbd>
          <span class="tab-held"></span>
        </button>`).join('')}
    </div>
    <div class="shop-levels" data-k="shopLevels"></div>
    <div class="shop-hint" data-k="shopHint"></div>`;
  root.appendChild(shop);
  const q = (k) => panel.querySelector(`[data-k="${k}"]`) || shop.querySelector(`[data-k="${k}"]`);
  const fill = panel.querySelector('.hp .fill');
  q('amove').addEventListener('click', () => { q('amove').blur(); onAttackMove?.(); });
  q('shopBtn').addEventListener('click', () => { q('shopBtn').blur(); onToggleShop?.(); });
  q('recall').addEventListener('click', () => { q('recall').blur(); onRecall?.(); });
  q('blade').addEventListener('click', () => { q('blade').blur(); onBlade?.(); });
  q('glimpse').addEventListener('click', () => { q('glimpse').blur(); onGlimpse?.(); });
  q('shopClose').addEventListener('click', () => { q('shopClose').blur(); onToggleShop?.(false); });
  q('trade').addEventListener('click', () => { q('trade').blur(); onTrade?.(); });
  const tabs = [...shop.querySelectorAll('.shop-tab')];
  let tab = SHOP[0].id;
  let last = null; // the last state passed to update(), to redraw right away on a tab change
  const selectTab = (id) => {
    tab = id;
    tabs.forEach((t) => t.classList.toggle('active', t.dataset.id === id));
    shop._levelsKey = '';
    if (last) drawLevels(last);
  };
  tabs.forEach((t) => t.addEventListener('click', () => { t.blur(); selectTab(t.dataset.id); }));
  selectTab(tab);
  // Clicking a tier row buys that item.
  q('shopLevels').addEventListener('click', (e) => {
    const row = e.target.closest('.shop-level');
    if (!row || row.disabled) return;
    row.blur();
    onBuy?.(tab, Number(row.dataset.level));
  });
  // Clicking a filled inventory slot sells that item (full price, in the temple).
  const slots = [...panel.querySelectorAll('.inv-slot')];
  slots.forEach((b) => b.addEventListener('click', () => {
    b.blur();
    if (!b.classList.contains('empty')) onSell?.(Number(b.dataset.slot));
  }));
  const invKey = (s) => s.inventory.map((it) => (it ? `${it.kind}${it.tier}` : '-')).join(',');
  // The selected kind's five tiers, each with its effect, price and whether you can buy it
  // now (s.buyable(kind, tier) says why not: no gold, away from the temple, no free slot).
  function drawLevels(s) {
    const item = SHOP.find((x) => x.id === tab);
    const key = `${tab}|${invKey(s)}|${s.gold}|${s.platinum}|${s.inTemple}`;
    if (shop._levelsKey === key) return;
    shop._levelsKey = key;
    if (!item.costs.length) { // a placeholder: no items yet
      q('shopLevels').innerHTML = `<div class="shop-empty">${item.name} items are coming soon.</div>`;
      return;
    }
    const note = item.stacks ? 'Stacks: several add up.' : 'Doesn\'t stack: only your best one counts.';
    q('shopLevels').innerHTML = `<div class="shop-note">${note}</div>` + item.costs.map((cost, i) => {
      const tier = i + 1, plan = s.buyable(item.id, tier);
      const have = s.inventory.filter((it) => it && it.kind === item.id && it.tier === tier).length;
      const state = !plan.why ? 'ok' : plan.why.startsWith('Return') ? 'away' : plan.why.startsWith('Needs') ? 'poor' : 'full';
      const swap = plan.swap ? `<small> (swap ${ROMAN[plan.swap.tier - 1]})</small>` : '';
      const cur = itemCurrency(item, tier);
      const price = `${coin(cur)}${plan.cost ?? cost}${swap}`;
      const name = itemTierName(item, tier);
      const title = `${name} ${ROMAN[i]}: ${itemEffect(item, item.values[i])}. ${cost} ${cur}`
        + (plan.swap ? `; replaces your ${itemTierName(item, plan.swap.tier)} ${ROMAN[plan.swap.tier - 1]}, so you pay ${plan.cost} ${cur}${plan.refund ? ` and get ${plan.refund.amount} ${plan.refund.cur} back` : ''}` : '')
        + (plan.why ? ` (${plan.why})` : '');
      // A tier with its own name (Titan Blade from XI) says so, and a divider marks where it starts.
      const renamed = name !== item.name;
      const first = renamed && itemTierName(item, tier - 1) !== name;
      const platStart = cur === 'platinum' && itemCurrency(item, tier - 1) !== cur; // where platinum prices begin
      const split = first || platStart ? `<div class="shop-note shop-split">${first ? name : `Tier ${ROMAN[i]}+`} · paid in platinum</div>` : '';
      return `${split}<button class="shop-level ${state}${renamed ? ' renamed' : ''}${cur === 'platinum' ? ' plat-price' : ''}" data-level="${tier}" ${state !== 'ok' ? 'disabled' : ''} title="${title}">
        <span class="lv">${ROMAN[i]}${have ? `<b class="held">×${have}</b>` : ''}</span><span class="fx">${itemEffect(item, item.values[i])}</span><span class="price">${price}</span>
      </button>`;
    }).join('');
  }
  // The inventory slots in the HUD: each item's icon and tier; click one in the temple to sell it.
  function drawInventory(s) {
    const key = `${invKey(s)}|${s.inTemple}`;
    if (panel._invKey === key) return;
    panel._invKey = key;
    s.inventory.forEach((it, k) => {
      const b = slots[k];
      b.classList.toggle('empty', !it);
      b.classList.toggle('away', !!it && !s.inTemple);
      if (!it) { b.innerHTML = ''; b.title = 'Empty slot: buy items in the temple shop (O)'; return; }
      const item = SHOP.find((x) => x.id === it.kind);
      b.innerHTML = `${ICONS[SHOP_ICONS[it.kind]]}<span class="tier">${ROMAN[it.tier - 1]}</span>`;
      b.title = `${itemTierName(item, it.tier)} ${ROMAN[it.tier - 1]}: ${itemEffect(item, item.values[it.tier - 1])}`
        + (s.inTemple ? `. Click to sell for ${item.costs[it.tier - 1]} ${itemCurrency(item, it.tier)}` : '. Sell it in the temple');
    });
    const used = s.inventory.filter(Boolean).length;
    setText(q('invHint'), `${used}/${s.inventory.length}${used && s.inTemple ? ' · click to sell' : ''}`);
  }
  return {
    el: panel,
    shopEl: shop,
    get shopOpen() { return !shop.hidden; },
    setShopOpen(open) {
      shop.hidden = !open;
      q('shopBtn').classList.toggle('active', open);
      if (open && last) { shop._levelsKey = ''; drawLevels(last); }
    },
    selectShopTab: (id) => selectTab(id),
    // Recall's cooldown: seconds left (0 = ready) out of max. The button fills back up as it recharges.
    setRecall(left, max) {
      const secs = Math.ceil(left - 1e-6);
      if (q('recall')._secs === secs) return;
      q('recall')._secs = secs;
      q('recall').classList.toggle('cooling', left > 0);
      q('recallFill').style.width = `${(left / max) * 100}%`;
      setText(q('recallText'), left > 0 ? `Recall ${secs}s` : 'Recall');
    },
    // Watchfire Glimpse's cooldown (like Recall's), and whether it's waiting for its click.
    setGlimpse(left, max) {
      const secs = Math.ceil(left - 1e-6);
      if (q('glimpse')._secs === secs) return;
      q('glimpse')._secs = secs;
      q('glimpse').classList.toggle('cooling', left > 0);
      q('glimpseFill').style.width = `${(left / max) * 100}%`;
      setText(q('glimpseText'), left > 0 ? `Glimpse ${secs}s` : 'Glimpse');
    },
    setGlimpseArmed(armed) { q('glimpse').classList.toggle('active', armed); },
    // Hidden Dancing Blade: charges left, and seconds left while it's active (the bar drains).
    setBlade(charges, activeLeft, duration) {
      const key = `${charges}|${Math.ceil(activeLeft * 4)}`;
      if (q('blade')._key === key) return;
      q('blade')._key = key;
      setText(q('bladeCharges'), `×${charges}`);
      q('blade').classList.toggle('active', activeLeft > 0);
      q('blade').classList.toggle('cooling', charges <= 0 && activeLeft <= 0);
      q('bladeFill').style.width = activeLeft > 0 ? `${(activeLeft / duration) * 100}%` : (charges <= 0 ? '100%' : '0%');
    },
    setHp(hp, maxHp) { setBar(fill, hp / maxHp); setText(q('hp'), `${Math.ceil(hp)} / ${maxHp}`); },
    // armed: waiting for the click that says where to attack-move.
    setAttackMoveArmed(armed) { q('amove').classList.toggle('active', armed); },
    update(s) {
      setText(q('status'), s.status);
      setBar(fill, s.hp / s.maxHp);
      setText(q('hp'), `${Math.ceil(s.hp)} / ${s.maxHp}`);
      setText(q('dmg'), s.damage);
      // A dot on the Shop button when something can be bought right now.
      const canBuy = s.inTemple && SHOP.some((x) => x.costs.some((_, i) => !s.buyable(x.id, i + 1).why));
      q('shopDot').hidden = !canBuy;
      setText(q('shopGold'), `${s.gold} gold`);
      setText(q('shopPlat'), `${s.platinum}`);
      const tradable = Math.floor(s.gold / PLATINUM.rate);
      q('trade').disabled = !s.inTemple || tradable < 1;
      setText(q('trade'), tradable >= 1 ? `Trade → ${tradable}` : 'Trade gold');
      const free = s.inventory.filter((it) => !it).length;
      setText(q('shopHint'), !s.inTemple ? 'Return to the temple to buy or sell. You can still look.'
        : `Click an item to buy it (${free} free slot${free === 1 ? '' : 's'}). Sell by clicking it in your inventory.`);
      last = s;
      tabs.forEach((t) => { // how many of each kind you hold
        const n = s.inventory.filter((it) => it && it.kind === t.dataset.id).length;
        setText(t.querySelector('.tab-held'), n ? `×${n}` : '');
      });
      drawInventory(s);
      if (!shop.hidden) drawLevels(s);
      setText(q('rate'), `${s.rate}/s`);
      setText(q('speed'), s.speed);
      setText(q('vision'), s.vision);
      q('visionBox').classList.toggle('boosted', s.watchstone);
      const chips = (s.godMode ? '<span class="chip chip-amber" title="Debug (Y): the Colossus and the Sentinel take no damage">Invincible</span> ' : '')
        + (s.underFire ? '<span class="chip chip-red" title="Being hit by turret boulders">Under fire</span> ' : '')
        + (s.crushed ? `<span class="chip chip-red" title="Siege Titan boulders: damage over time, which also keeps Regen Core paused. The temple still heals.">Crushed −${s.crushed.perSec}/s · ${Math.ceil(s.crushed.left)}s</span> ` : '')
        + (s.templeHealing ? `<span class="chip chip-cyan" title="The temple heals the Colossus while it stands inside">Temple healing +${Math.round(ATTACKER.templeHeal * s.maxHp)}/s</span> ` : '')
        + (s.regen && s.hp < s.maxHp ? (s.regenActive
          ? `<span class="chip chip-cyan" title="Regen Core: heals while out of combat">Regen +${s.regen}/s</span> `
          : '<span class="chip" title="Regen Core only heals 4 seconds after the Colossus was last hit">Regen paused</span> ') : '')
        + (s.armor ? `<span class="chip chip-cyan" title="Stone armor (shop): turret boulders deal less damage">Armor ${pct(s.armor)}%</span> ` : '')
        + (s.watchstone ? `<span class="chip chip-amber" title="Standing next to a burning watchstone: far sight until its fire goes out">Watchstone vision ${s.watchLeft}s</span>`
          : s.watchBurning ? `<span class="chip" title="Your watchstone is still burning down: go back and stand next to it for its far sight before it goes out">Watchstone burning ${s.watchBurning}s</span>` : '');
      if (q('chips')._html !== chips) { q('chips')._html = chips; q('chips').innerHTML = chips; }
    },
  };
}

// Build buttons: [type, icon, hotkey]
// A build button's cost line: stone and/or crystals, or "free".
const buildCost = (type) => {
  const { cost, crystalCost } = BUILDINGS[type];
  const parts = [];
  if (cost) parts.push(`${ICONS.stone}${cost}${type === 'wall' ? '/pc' : ''}`);
  if (crystalCost) parts.push(`<span class="c-cost">${ICONS.crystal}${crystalCost}</span>`);
  return parts.join(' ') || 'free';
};
const BUILD_ORDER = [['townhall', 'hall', '1'], ['barracks', 'barracks', '2'], ['cannon', 'turret', '3'], ['quarry', 'quarry', '4'], ['wall', 'wall', '5']];

export function createDefenderHud(root, { name, teamColor, teamName = 'Blue', onBuild, onAutoRepair, onBlink }) {
  const team = `#${teamColor.toString(16).padStart(6, '0')}`;
  const panel = unitPanel(root, 'hud-defender', sentinelPortrait(team), name);
  panel.style.setProperty('--team', team);
  panel.insertAdjacentHTML('beforeend', `
    <div class="team-line"><span class="team-dot"></span>${teamName} defender
      <span class="chip tunnel-chip" data-k="tunnel" title="Tunnels: right-click a tunnel mouth to travel through it" hidden></span></div>
    <div class="unit-actions">
      <button class="act-btn toggle" data-k="autorep" title="Auto-repair: while idle, the Sentinel repairs damaged buildings nearby by itself">
        ${ICONS.build}<span data-k="autorepText">Auto-repair</span><kbd>Z</kbd></button>
      <button class="act-btn recall-btn" data-k="blink" title="Blink: then click a spot within ${DEFENDER.buildRange} tiles (the ring) to teleport there, even where you can't see. ${DEFENDER.blink.cooldown} s cooldown. Right-click or Esc cancels.">
        <i class="cd-fill" data-k="blinkFill"></i>${ICONS.speed}<span data-k="blinkText">Blink</span><kbd>F</kbd></button>
    </div>
    <div class="build-title">${ICONS.build} Build</div>
    <div class="build-grid">
      ${BUILD_ORDER.map(([type, icon, key]) => `
        <button class="build-btn" data-type="${type}" title="${BUILDINGS[type].name} (${key})">
          ${ICONS[icon]}<span class="b-name">${BUILDINGS[type].name}</span>
          <span class="b-cost">${buildCost(type)}</span><kbd>${key}</kbd>
        </button>`).join('')}
    </div>
    <div class="hint">Build within ${DEFENDER.buildRange} tiles of yourself (the ring), where you can see. Costs stone. Esc or right-click cancels.</div>`);
  const buttons = [...panel.querySelectorAll('.build-btn')];
  buttons.forEach((b) => b.addEventListener('click', () => { onBuild(b.dataset.type); b.blur(); }));
  panel.querySelector('[data-k="autorep"]').addEventListener('click', (e) => { e.currentTarget.blur(); onAutoRepair?.(); });
  panel.querySelector('[data-k="blink"]').addEventListener('click', (e) => { e.currentTarget.blur(); onBlink?.(); });
  const q = (k) => panel.querySelector(`[data-k="${k}"]`);
  const fill = panel.querySelector('.hp .fill');
  return {
    el: panel,
    // Blink's cooldown (the button fills back up), and whether it's waiting for its click.
    setBlink(left, max) {
      const secs = Math.ceil(left - 1e-6);
      if (q('blink')._secs === secs) return;
      q('blink')._secs = secs;
      q('blink').classList.toggle('cooling', left > 0);
      q('blinkFill').style.width = `${(left / max) * 100}%`;
      setText(q('blinkText'), left > 0 ? `Blink ${secs}s` : 'Blink');
    },
    setBlinkArmed(armed) { q('blink').classList.toggle('active', armed); },
    setActiveBuild(type) { buttons.forEach((b) => b.classList.toggle('active', b.dataset.type === type)); },
    // Dim the build buttons you can't afford right now.
    setStone(stone, crystals = 0) {
      for (const b of buttons) {
        const def = BUILDINGS[b.dataset.type];
        const poor = stone < (def.cost || 0) || crystals < (def.crystalCost || 0);
        if (b._poor !== poor) { b._poor = poor; b.classList.toggle('poor', poor); }
      }
    },
    // Grey out a build button (e.g. the Town Hall when you already have one), with a reason.
    setBuildDisabled(type, disabled, reason = '') {
      const b = buttons.find((x) => x.dataset.type === type);
      if (!b || b._disabled === disabled) return;
      b._disabled = disabled;
      b.classList.toggle('locked', disabled); // still clickable, so the reason can be shown
      b.title = disabled ? reason : `${BUILDINGS[type].name} (${b.querySelector('kbd').textContent})`;
    },
    setAutoRepair(on) {
      q('autorep').classList.toggle('active', on);
      setText(q('autorepText'), `Auto-repair: ${on ? 'On' : 'Off'}`);
    },
    setHp(hp, maxHp) { setBar(fill, hp / maxHp); setText(q('hp'), `${Math.ceil(hp)} / ${maxHp}`); },
    // s.tunnels: seconds of tunnel cooldown left (0 = ready), or null if the map has none.
    update(s) {
      setText(q('status'), s.status);
      setBar(fill, s.hp / s.maxHp);
      setText(q('hp'), `${Math.ceil(s.hp)} / ${s.maxHp}`);
      const chip = q('tunnel');
      show(chip, s.tunnels !== null && s.tunnels !== undefined);
      if (s.tunnels !== null && s.tunnels !== undefined) {
        const ready = s.tunnels <= 0;
        setText(chip, ready ? 'Tunnels ready' : `Tunnels ${Math.ceil(s.tunnels)}s`);
        chip.classList.toggle('cooling', !ready);
      }
    },
  };
}

// End-of-game banner (center of the screen): show({ title, text, buttons: [{label, run}] }) / hide().
export function createEndBanner(root) {
  const panel = el('section', 'hud end-banner');
  panel.hidden = true;
  root.appendChild(panel);
  return {
    show({ title, text, buttons }) {
      panel.innerHTML = `<h2></h2><p></p><div class="end-actions"></div>`;
      setText(panel.querySelector('h2'), title);
      setText(panel.querySelector('p'), text);
      for (const b of buttons) {
        const btn = el('button', '', b.label);
        btn.addEventListener('click', () => { btn.blur(); b.run(); });
        panel.querySelector('.end-actions').appendChild(btn);
      }
      panel.hidden = false;
    },
    hide() { panel.hidden = true; },
  };
}

export function createResourceBar(root) {
  const bar = el('div', 'hud resource-bar');
  bar.innerHTML = `
    <div class="res res-gold" data-role="attacker" title="Gold: earned by damaging buildings">${ICONS.gold}<span data-k="gold">0</span></div>
    <div class="res res-plat" data-role="attacker" data-k="platBox" title="Platinum: for items XI-XV. Trade gold for it in the temple shop (${PLATINUM.rate} gold = 1 platinum).">${ICONS.platinum}<span data-k="platinum">0</span></div>
    <div class="res res-stone" data-role="defender" title="Stone (basic currency): your Core makes it">${ICONS.stone}<span data-k="stone">0</span><small data-k="stoneRate"></small></div>
    <div class="res res-crystal" data-role="defender" title="Crystals (the rare currency): mined by Quarry workers, and every defender gets some when the boss dies.">${ICONS.crystal}<span data-k="crystals">0</span><small data-k="crystalRate"></small></div>
    <div class="res res-troops" data-role="defender" title="Troops: alive / limit (troops in training count toward the limit)">${ICONS.troops}<span data-k="troops">0 / 20</span><small data-k="training"></small></div>`;
  root.appendChild(bar);
  const q = (k) => bar.querySelector(`[data-k="${k}"]`);
  const items = [...bar.querySelectorAll('.res')];
  return {
    update(s) {
      // Platinum shows once the Colossus has some (or enough gold to trade for it).
      items.forEach((i) => show(i, i.dataset.role === s.role
        && (i.dataset.k !== 'platBox' || s.platinum > 0 || s.gold >= PLATINUM.rate)));
      setText(q('gold'), s.gold);
      setText(q('platinum'), s.platinum);
      setText(q('stone'), s.stone);
      setText(q('stoneRate'), s.stoneRate ? `+${s.stoneRate}/s` : 'no Core');
      setText(q('crystals'), s.crystals);
      setText(q('crystalRate'), s.crystalRate ? `+${s.crystalRate}/s` : '');
      setText(q('troops'), `${s.troops} / ${s.troopCap}`);
      setText(q('training'), s.training ? `+${s.training} training` : '');
    },
  };
}

// Info panel: { kind, title, subtitle, hp, maxHp, lines: [], actions: [{label, title, disabled, run}] } or null.
export function createInfoPanel(root) {
  const panel = el('section', 'hud info-panel');
  panel.innerHTML = `
    <div class="info-kind" data-k="kind"></div>
    <h3 data-k="title"></h3>
    <div class="info-sub" data-k="sub"></div>
    <div class="bar hp"><div class="fill"></div><span class="bar-text" data-k="hp"></span></div>
    <div class="info-lines" data-k="lines"></div>
    <div class="info-actions" data-k="actions"></div>`;
  root.appendChild(panel);
  const q = (k) => panel.querySelector(`[data-k="${k}"]`);
  const fill = panel.querySelector('.hp .fill');
  let lastActionsKey = '';
  return {
    update(info) {
      show(panel, !!info);
      if (!info) return;
      panel.dataset.kind = info.kind;
      setText(q('kind'), info.kindLabel);
      // titleHtml: a name with markup we wrote ourselves (the fancy capitals); otherwise plain text.
      if (info.titleHtml) { if (q('title')._html !== info.titleHtml) { q('title')._html = info.titleHtml; q('title').innerHTML = info.titleHtml; } }
      else { q('title')._html = null; setText(q('title'), info.title); }
      setText(q('sub'), info.subtitle || '');
      setBar(fill, info.hp / info.maxHp);
      setText(q('hp'), `${Math.ceil(info.hp)} / ${info.maxHp}`);
      const lines = (info.lines || []).join(' · ');
      setText(q('lines'), lines);
      const key = `${info.id}|${info.actionsLayout || ''}|` + (info.actions || []).map((a) => `${a.label}${a.disabled}`).join('|');
      if (key !== lastActionsKey) {
        lastActionsKey = key;
        const box = q('actions');
        box.innerHTML = '';
        box.classList.toggle('grid', info.actionsLayout === 'grid'); // a two-column menu (e.g. hiring helpers)
        for (const a of info.actions || []) {
          const b = el('button', a.className ? `info-btn ${a.className}` : 'info-btn', a.label);
          if (a.html) b.innerHTML = a.html; // our own markup (the fancy capitals), never data
          b.disabled = !!a.disabled;
          if (a.title) b.title = a.title;
          b.addEventListener('click', () => { a.run?.(); b.blur(); });
          box.appendChild(b);
        }
      }
    },
  };
}
