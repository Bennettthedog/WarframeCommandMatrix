// Multiplayer: the lobby and the connection between browsers.
//
// One player hosts: their browser runs the real game. Everyone else joins with the host's room
// code; their browsers show the game from the host's updates and send their clicks to the
// host as commands (main.js). The connection is peer to peer (WebRTC) through the free public
// PeerJS service, which only introduces the browsers to each other. `?net=local` instead
// connects tabs of one browser on one computer (BroadcastChannel), for testing.
//
// The page opens here, hosting a new room (or ?lobby=CODE to host with that code); ?join=CODE
// joins one (or type the code into the lobby's Join box). For quick testing,
// &name=…&role=attacker|defender|spectator&ready=1 fill the form in. ?solo skips it.
import { NET } from './config.js';

export const ROLES = {
  attacker: { name: 'Colossus', blurb: 'The attacker. Only one player can be the Colossus.' },
  defender: { name: 'Defender', blurb: 'Builds and defends. Defenders share the Sentinel and its base for now.' },
  spectator: { name: 'Spectator', blurb: 'Watches the whole map, no fog, no orders.' },
};
const PEER_PREFIX = 'colossus-game-';
const HOST_ID = 'host';

// ---- Transports: { send(to, msg), broadcast(msg), onMessage(fn(from, msg)), onJoin, onLeave } ----

// The ICE servers to use: the STUN list, plus Metered TURN relay credentials if configured.
async function iceServers() {
  let list = [...NET.iceServers];
  const { app, apiKey } = NET.metered || {};
  if (app && apiKey) {
    try {
      const r = await fetch(`https://${app}.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(apiKey)}`);
      if (r.ok) list = list.concat(await r.json());
    } catch (e) { console.warn('Could not get TURN relay credentials:', e); }
  }
  return list;
}
async function loadPeer() {
  const m = await import('https://cdn.jsdelivr.net/npm/peerjs@1.5.4/+esm');
  return m.Peer || m.default;
}

// A small event hub every transport uses.
function hub() {
  const h = { msg: null, join: null, leave: null, close: null };
  return {
    h,
    onMessage(fn) { h.msg = fn; },
    onJoin(fn) { h.join = fn; },
    onLeave(fn) { h.leave = fn; },
    onClose(fn) { h.close = fn; },
  };
}

// Host over PeerJS: accepts connections; each peer's id is its connection's peer id.
async function hostPeer(code) {
  const Peer = await loadPeer();
  const peer = new Peer(PEER_PREFIX + code, { config: { iceServers: await iceServers() } });
  await new Promise((ok, fail) => { peer.on('open', ok); peer.on('error', fail); });
  const conns = new Map(), e = hub();
  peer.on('connection', (c) => {
    c.on('open', () => { conns.set(c.peer, c); e.h.join?.(c.peer); });
    c.on('data', (d) => e.h.msg?.(c.peer, d));
    c.on('close', () => { conns.delete(c.peer); e.h.leave?.(c.peer); });
    c.on('error', () => { conns.delete(c.peer); e.h.leave?.(c.peer); });
  });
  return {
    ...e, id: HOST_ID, code,
    send(to, msg) { conns.get(to)?.send(msg); },
    broadcast(msg) { for (const c of conns.values()) c.send(msg); },
    close() { peer.destroy(); },
  };
}
// Client over PeerJS: one connection, to the host.
async function joinPeer(code) {
  const Peer = await loadPeer();
  const peer = new Peer({ config: { iceServers: await iceServers() } });
  await new Promise((ok, fail) => { peer.on('open', ok); peer.on('error', fail); });
  const conn = peer.connect(PEER_PREFIX + code, { reliable: true });
  const e = hub();
  await new Promise((ok, fail) => {
    const t = setTimeout(() => fail(new Error('No answer from that room')), 15000);
    conn.on('open', () => { clearTimeout(t); ok(); });
    conn.on('error', (err) => { clearTimeout(t); fail(err); });
    peer.on('error', (err) => { clearTimeout(t); fail(err); });
  });
  conn.on('data', (d) => e.h.msg?.(HOST_ID, d));
  conn.on('close', () => e.h.close?.());
  return { ...e, id: peer.id, code, send(_to, msg) { conn.send(msg); }, broadcast(msg) { conn.send(msg); }, close() { peer.destroy(); } };
}
// Same-browser test transport (BroadcastChannel): ?net=local.
function localNet(code, isHost) {
  const ch = new BroadcastChannel(`colossus-local-${code}`), e = hub();
  const id = isHost ? HOST_ID : `p${Math.random().toString(36).slice(2, 8)}`;
  const peers = new Set();
  ch.onmessage = ({ data }) => {
    if (data.to !== id && data.to !== '*') return;
    if (data.kind === 'hello' && isHost) { peers.add(data.from); e.h.join?.(data.from); return; }
    if (data.kind === 'bye') { if (isHost) { peers.delete(data.from); e.h.leave?.(data.from); } else e.h.close?.(); return; }
    e.h.msg?.(data.from, data.msg);
  };
  addEventListener('beforeunload', () => ch.postMessage({ kind: 'bye', from: id, to: isHost ? '*' : HOST_ID }));
  if (!isHost) ch.postMessage({ kind: 'hello', from: id, to: HOST_ID });
  return {
    ...e, id, code,
    send(to, msg) { ch.postMessage({ kind: 'msg', from: id, to: isHost ? to : HOST_ID, msg }); },
    broadcast(msg) { ch.postMessage({ kind: 'msg', from: id, to: isHost ? '*' : HOST_ID, msg }); },
    close() { ch.close(); },
  };
}

// ---- The lobby ----
// Resolves when the game starts with { mode: 'host' | 'client', net, me, role, name, seed, players }.
export function runLobby(params) {
  const hosting = !params.has('join'); // the page opens on hosting a room
  const code = ((hosting ? params.get('lobby') : params.get('join')) || randomCode()).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || randomCode();
  const local = params.get('net') === 'local';
  const ui = lobbyUi(hosting, code);
  const want = { name: (params.get('name') || '').slice(0, NET.maxName), role: ROLES[params.get('role')] ? params.get('role') : '', ready: params.get('ready') === '1' };

  return new Promise((resolve) => {
    const start = async () => {
      ui.status(hosting ? 'Opening the room…' : `Joining room ${code}…`);
      let net;
      try {
        net = local ? localNet(code, hosting) : hosting ? await hostPeer(code) : await joinPeer(code);
      } catch (err) {
        ui.status(hosting ? `Couldn't open the room: ${err.message || err}. Try again, or check your connection.`
          : `Couldn't join room ${code}: ${err.message || err}. Check the code and that the host's lobby is open.`, true);
        ui.retry(() => start());
        return;
      }
      if (hosting) hostLobby(net, ui, want, resolve); else clientLobby(net, ui, want, resolve);
    };
    start();
  });
}

function randomCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no look-alikes (0/O, 1/I)
  return Array.from({ length: 5 }, () => A[Math.floor(Math.random() * A.length)]).join('');
}

// What's still missing before the countdown can start, or '' if everyone's set.
function missing(players) {
  if (players.length < 2) return 'Waiting for at least 2 players';
  const att = players.filter((p) => p.role === 'attacker').length;
  if (players.some((p) => !p.name)) return 'Everyone needs a username';
  if (players.some((p) => !p.role)) return 'Everyone needs to pick a role';
  if (att === 0) return 'Someone needs to be the Colossus';
  if (!players.some((p) => p.role === 'defender')) return 'Someone needs to be a Defender';
  if (players.some((p) => !p.ready)) return `Waiting for ${players.filter((p) => !p.ready).map((p) => p.name).join(', ')} to be ready`;
  return '';
}

function hostLobby(net, ui, want, resolve) {
  const players = [{ id: HOST_ID, name: '', role: '', ready: false, host: true }];
  let countdownEnd = null, started = false;
  const me = players[0];
  const publish = () => {
    const left = countdownEnd ? Math.max(0, Math.ceil((countdownEnd - performance.now()) / 1000)) : null;
    const msg = { t: 'lobby', players, countdown: left, missing: missing(players) };
    net.broadcast(msg);
    ui.render(msg, HOST_ID);
  };
  // A player changes their name, role or ready state (validated here, the host's copy rules).
  const apply = (p, ch) => {
    if (ch.name !== undefined && !p.ready) p.name = String(ch.name).trim().slice(0, NET.maxName);
    if (ch.role !== undefined && !p.ready && (ch.role === '' || ROLES[ch.role])) {
      const taken = ch.role === 'attacker' && players.some((o) => o !== p && o.role === 'attacker');
      if (taken) net.send(p.id, { t: 'notice', text: 'Someone else is already the Colossus' });
      else p.role = ch.role;
    }
    if (ch.ready !== undefined) p.ready = !!ch.ready && !!p.name && !!p.role;
    tick();
  };
  net.onJoin((id) => {
    if (started) { net.send(id, { t: 'notice', text: 'That game has already started' }); return; }
    players.push({ id, name: '', role: '', ready: false });
    tick();
  });
  net.onLeave((id) => { const k = players.findIndex((p) => p.id === id); if (k >= 0) players.splice(k, 1); tick(); });
  net.onMessage((id, msg) => {
    const p = players.find((x) => x.id === id);
    if (p && msg.t === 'set') apply(p, msg);
  });
  // The countdown: starts when everyone's set, stops the moment anyone isn't (e.g. unreadies).
  const tick = () => {
    if (started) return;
    const ok = !missing(players);
    if (ok && countdownEnd === null) { countdownEnd = performance.now() + NET.countdown * 1000; console.info('Lobby: countdown started'); }
    if (!ok && countdownEnd !== null) { countdownEnd = null; console.info(`Lobby: countdown cancelled (${missing(players)})`); }
    if (countdownEnd !== null && performance.now() >= countdownEnd) {
      started = true;
      clearInterval(timer);
      const seed = Math.random().toString(36).slice(2, 10);
      net.broadcast({ t: 'start', seed, players });
      ui.close();
      resolve({ mode: 'host', net, me: HOST_ID, role: me.role, name: me.name, seed, players: players.map((p) => ({ ...p })) });
      return;
    }
    publish();
  };
  const timer = setInterval(tick, 250);
  ui.bind((ch) => apply(me, ch));
  ui.prefill(want, (ch) => apply(me, ch));
  publish();
}

function clientLobby(net, ui, want, resolve) {
  let me = null, last = null;
  net.onMessage((_from, msg) => {
    if (msg.t === 'lobby') { last = msg; me = msg.players.find((p) => p.id === net.id); ui.render(msg, net.id); }
    else if (msg.t === 'notice') ui.notice(msg.text);
    else if (msg.t === 'start') {
      const mine = msg.players.find((p) => p.id === net.id);
      if (!mine) return;
      ui.close();
      resolve({ mode: 'client', net, me: net.id, role: mine.role, name: mine.name, seed: msg.seed, players: msg.players });
    }
  });
  net.onClose(() => ui.status('The host closed the room.', true));
  const send = (ch) => net.send(HOST_ID, { t: 'set', ...ch });
  ui.bind(send);
  ui.prefill(want, send);
  ui.status(`In room ${net.code}`);
  return last && me;
}

// ---- The lobby screen ----
function lobbyUi(hosting, code) {
  const root = document.createElement('div');
  root.className = 'lobby';
  const link = `${location.origin}${location.pathname}?join=${code}`;
  root.innerHTML = `
    <div class="lobby-card">
      <h1>Colossus</h1>
      <div class="lobby-sub">${hosting ? 'Hosting a game' : 'Joining a game'}</div>
      <div class="lobby-code">
        <span>Room code</span><b data-k="code">${code}</b>
        <button data-k="copy" title="Copy a link others can open to join">Copy invite link</button>
      </div>
      <label class="lobby-field">Username
        <input data-k="name" maxlength="${NET.maxName}" placeholder="Your name" autocomplete="off" />
      </label>
      <div class="lobby-field">Role
        <div class="lobby-roles">
          ${Object.entries(ROLES).map(([id, r]) => `<button class="lobby-role" data-role="${id}" title="${r.blurb}">${r.name}</button>`).join('')}
        </div>
      </div>
      <button class="lobby-ready" data-k="ready">Ready</button>
      <div class="lobby-countdown" data-k="countdown"></div>
      <div class="lobby-status" data-k="status"></div>
      <ul class="lobby-players" data-k="players"></ul>
      <form class="lobby-join" data-k="joinForm">
        <span>${hosting ? 'Have a code from a friend?' : 'Joining a different room?'}</span>
        <input data-k="joinCode" maxlength="8" placeholder="Room code" autocomplete="off" aria-label="Room code to join" />
        <button type="submit">Join</button>
      </form>
      <div class="lobby-foot"><a href="${location.pathname}?solo">Play solo instead</a></div>
    </div>`;
  document.body.appendChild(root);
  const q = (k) => root.querySelector(`[data-k="${k}"]`);
  let mine = null, onChange = null;
  // Join another room by its code (leaves this one).
  q('joinForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const c = q('joinCode').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (c) location.href = `${location.pathname}?join=${c}`;
  });
  q('copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(link); q('copy').textContent = 'Copied!'; } catch { q('copy').textContent = link; }
    setTimeout(() => { q('copy').textContent = 'Copy invite link'; }, 2000);
  });
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let nameTimer = null;
  return {
    bind(fn) {
      onChange = fn;
      q('name').addEventListener('input', () => { clearTimeout(nameTimer); nameTimer = setTimeout(() => fn({ name: q('name').value }), 200); });
      root.querySelectorAll('.lobby-role').forEach((b) => b.addEventListener('click', () => fn({ role: mine?.role === b.dataset.role ? '' : b.dataset.role })));
      q('ready').addEventListener('click', () => fn({ name: q('name').value, ready: !mine?.ready }));
    },
    prefill(want, fn) {
      if (want.name) q('name').value = want.name;
      if (want.name || want.role) fn({ name: want.name || q('name').value, ...(want.role ? { role: want.role } : {}) });
      if (want.ready) setTimeout(() => fn({ ready: true }), 300);
    },
    render(state, myId) {
      mine = state.players.find((p) => p.id === myId) || null;
      const takenBy = state.players.find((p) => p.role === 'attacker');
      root.querySelectorAll('.lobby-role').forEach((b) => {
        const id = b.dataset.role;
        b.classList.toggle('on', mine?.role === id);
        b.disabled = !!mine?.ready || (id === 'attacker' && takenBy && takenBy.id !== myId);
        b.title = id === 'attacker' && takenBy && takenBy.id !== myId ? `${takenBy.name || 'Someone'} is the Colossus` : ROLES[id].blurb;
      });
      q('name').disabled = !!mine?.ready;
      if (document.activeElement !== q('name') && mine) q('name').value = mine.name;
      q('ready').textContent = mine?.ready ? 'Not ready' : 'Ready';
      q('ready').classList.toggle('on', !!mine?.ready);
      q('ready').disabled = !mine?.ready && (!mine?.role || !q('name').value.trim());
      q('countdown').textContent = state.countdown !== null ? `Starting in ${state.countdown}…` : '';
      q('countdown').classList.toggle('live', state.countdown !== null);
      q('status').textContent = state.countdown !== null ? 'Unready to cancel' : state.missing;
      q('status').classList.remove('bad');
      q('players').innerHTML = state.players.map((p) => `<li class="${p.ready ? 'ready' : ''}">
        <span class="lp-name">${esc(p.name || '(no name yet)')}${p.host ? ' <small>host</small>' : ''}${p.id === myId ? ' <small>you</small>' : ''}</span>
        <span class="lp-role">${p.role ? ROLES[p.role].name : '—'}</span>
        <span class="lp-ready">${p.ready ? 'Ready' : 'Not ready'}</span></li>`).join('');
    },
    status(text, bad = false) { q('status').textContent = text; q('status').classList.toggle('bad', bad); },
    notice(text) { this.status(text, true); },
    retry(fn) {
      const b = document.createElement('button');
      b.className = 'lobby-ready'; b.textContent = 'Try again';
      b.addEventListener('click', () => { b.remove(); fn(); });
      q('status').after(b);
    },
    close() { root.remove(); },
    get onChange() { return onChange; },
  };
}
