// Debug panel (top-right, toggled with the ` key). Seed controls, toggles and a list of
// debug commands. Each command can be clicked, or triggered with its key while the panel is open.
import { el, setText, ICONS } from './dom.js';

// commands: [{ key: 'G', code: 'KeyG', label, run }], always: [{ key, label }] (shown, handled elsewhere)
// locked: no debug commands or seed loading (the game isn't running on the developer's own
// computer): the panel is just the list of keys.
export function createDebugPanel(root, { seed, onLoadSeed, onNewMap, commands, always, locked = false }) {
  if (locked) commands = [];
  const toggleBtn = el('button', 'hud debug-toggle', `${ICONS.bug}<span>${locked ? 'Keys' : 'Debug'}</span><kbd>\`</kbd>`);
  toggleBtn.title = locked ? 'The game\'s keys (`)' : 'Debug panel (`)';
  const fps = el('div', 'hud fps');
  fps.hidden = true;
  const panel = el('section', 'hud debug-panel');
  panel.hidden = true;
  panel.innerHTML = `
    <h3>${ICONS.bug} ${locked ? 'Keys' : 'Debug'}</h3>
    <div class="dbg-seed">
      <label>Seed <b data-k="seed"></b></label>
      <div class="dbg-row" ${locked ? 'hidden' : ''}><input data-k="input" placeholder="seed" maxlength="24"><button data-k="load">Load</button><button data-k="new">New map</button></div>
    </div>
    <div ${locked ? 'hidden' : ''}>
      <h4>Commands <small>(keys work while this panel is open)</small></h4>
      <table class="dbg-cmds"><tbody data-k="cmds"></tbody></table>
    </div>
    <h4>${locked ? 'Keys' : 'Always available'}</h4>
    <table class="dbg-cmds"><tbody data-k="always"></tbody></table>`;
  root.append(toggleBtn, fps, panel);
  const q = (k) => panel.querySelector(`[data-k="${k}"]`);
  setText(q('seed'), seed);
  const input = q('input');
  if (!locked) {
    q('load').addEventListener('click', () => { if (input.value.trim()) onLoadSeed(input.value.trim()); });
    q('new').addEventListener('click', onNewMap);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && input.value.trim()) onLoadSeed(input.value.trim()); });
  }

  for (const c of commands) {
    const row = el('tr', 'dbg-cmd', `<td><kbd>${c.key}</kbd></td><td>${c.label}</td>`);
    row.title = 'Click to run';
    row.addEventListener('click', () => c.run());
    q('cmds').appendChild(row);
  }
  for (const a of always) q('always').appendChild(el('tr', '', `<td><kbd>${a.key}</kbd></td><td>${a.label}</td>`));

  const api = {
    isOpen: () => !panel.hidden,
    toggle() { panel.hidden = !panel.hidden; toggleBtn.classList.toggle('active', !panel.hidden); },
    setFpsVisible(v) { fps.hidden = !v; },
    get fpsVisible() { return !fps.hidden; },
    setFps(v) { setText(fps, `${v} fps`); },
  };
  toggleBtn.addEventListener('click', () => { api.toggle(); toggleBtn.blur(); });
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return;
    if (e.code === 'Backquote') { api.toggle(); return; }
    if (!api.isOpen()) return;
    const c = commands.find((x) => x.code === e.code);
    if (c) { e.preventDefault(); c.run(); }
  });
  return api;
}

// Brief messages at the top of the screen.
export function createToasts(root) {
  const box = el('div', 'toasts');
  root.appendChild(box);
  // opts.announce: a bigger, longer-lasting message for game events everyone should see.
  return (text, opts = {}) => {
    const t = el('div', opts.announce ? 'toast announce' : 'toast', text);
    if (opts.html) t.innerHTML = opts.html; // our own markup (e.g. the fancy capitals), never data
    box.appendChild(t);
    const life = opts.announce ? 5000 : 1800;
    setTimeout(() => t.classList.add('out'), life);
    setTimeout(() => t.remove(), life + 500);
  };
}
