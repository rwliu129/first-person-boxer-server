// First Person Boxer: online 1v1 server.
// One small Node.js process: private two-player rooms with six-character codes, a lobby with shared match rules, and
// an authoritative match (clock, rounds, every hit's result, stamina, guard, stun, knockdowns, scorecards, winner).
// Clients send their own movement and inputs; the server relays movement and works out every outcome itself.
// Plain WebSockets (the 'ws' package), JSON messages, no accounts, no database, no secrets.
'use strict';
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const R = require('./rules');

const PORT = +process.env.PORT || 8787;
// optional: only accept browsers from these sites (comma-separated origins, e.g. https://mygame.netlify.app); empty = any
const ALLOWED = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const TICK = 1 / 20;                  // match simulation: 20 times a second
const RECONNECT_S = 45;               // a dropped player has this long to come back
const LOBBY_IDLE_S = 30 * 60;         // an untouched lobby is closed after this long
const EMPTY_ROOM_S = 90;              // a room with nobody connected is closed after this long
const BREAK_S = 15;                   // rest between rounds
const COUNTDOWN_S = 3;                // 3, 2, 1 before the first bell
const INTRO_S = 1.8;                  // "Round N" ... "Fight" before each round
const now = () => performance.now() / 1000;
const rand = Math.random;
const PUNCHW = p => (R.PUNCH[p.type].w + R.PUNCH[p.type].e) * p.sm;
const CODE_CH = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // no 0/O or 1/I/L: easy to read out and type

const rooms = new Map();              // code -> room
function newCode() { for (let i = 0; i < 50; i++) { let c = ''; for (const b of crypto.randomBytes(6)) c += CODE_CH[b % CODE_CH.length]; if (!rooms.has(c)) return c; } throw new Error('no free code'); }
const cleanName = n => String(n || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 18) || 'Boxer';
const cleanTok = t => /^[A-Za-z0-9_-]{16,64}$/.test(String(t || '')) ? String(t) : null;
// a fighter's look (colours, hair, build...) is cosmetic: only short plain values are passed on
function cleanLook(l) { const o = {}; if (!l || typeof l !== 'object') return o;
  for (const k of ['skin', 'shorts', 'trim', 'glove', 'metal', 'design', 'cuff', 'build', 'stance', 'hair', 'beard', 'hairColor', 'eyeColor', 'shoes'])
    if (k in l && (typeof l[k] === 'string' ? l[k].length <= 24 : typeof l[k] === 'boolean' || typeof l[k] === 'number')) o[k] = l[k];
  return o; }

// ---------------- rooms and the lobby ----------------
function makeRoom() {
  const code = newCode();
  const room = { code, created: now(), touched: now(), phase: 'lobby', mode: 'host', rules: Object.assign({}, R.DEFAULT_RULES),
    approved: [false, false], players: [null, null], match: null, last: null, emptySince: null };
  rooms.set(code, room); return room;
}
const slotOf = (room, p) => room.players.indexOf(p);
const other = (room, i) => room.players[1 - i];
function send(p, m) { if (p && p.ws && p.ws.readyState === 1) { try { p.ws.send(JSON.stringify(m)); } catch (_) {} } }
function sendAll(room, m) { for (const p of room.players) send(p, m); }
function roomView(room) {
  return { code: room.code, phase: room.phase, mode: room.mode, rules: room.rules, approved: room.approved,
    players: room.players.map((p, i) => p && { slot: i, name: p.name, ready: p.ready, conn: p.conn, host: i === 0, dev: p.dev, again: !!p.again }),
    last: room.last };
}
function pushRoom(room) { room.touched = now(); const r = roomView(room); room.players.forEach((p, i) => send(p, { t: 'room', r, you: i })); }
function err(ws, code, msg) { try { ws.send(JSON.stringify({ t: 'err', code, msg })); } catch (_) {} }
function canEdit(room, i) { return room.mode === 'shared' || room.mode === 'approve' || i === 0; }
function unready(room) { for (const p of room.players) if (p) { p.ready = false; p.again = false; } }

function leave(room, i, why) {
  const p = room.players[i]; if (!p) return;
  room.players[i] = null; if (p.ws) p.ws.room = null;
  if (room.match && room.phase === 'match') endMatch(room, 1 - i, 'Opponent left', true);
  // the host leaving hands the room to the guest (who becomes Player 1)
  if (i === 0 && room.players[1]) { room.players[0] = room.players[1]; room.players[1] = null; room.mode = 'host'; }
  unready(room); room.approved = [false, false];
  const o = room.players.find(Boolean);
  if (o) send(o, { t: 'note', msg: (p.name || 'Your opponent') + (why === 'timeout' ? ' lost connection' : ' left the room') });
  if (!room.players.some(Boolean)) rooms.delete(room.code); else pushRoom(room);
}

// ---------------- the match ----------------
function startMatch(room) {
  const t = now();
  room.phase = 'match'; room.last = null;
  const M = room.match = { rules: Object.assign({}, room.rules), f: [R.newFighter(room.players[0].dev), R.newFighter(room.players[1].dev)],
    phase: 'count', phaseT: t + COUNTDOWN_S, round: 1, clock: room.rules.len, cards: [], kd: null, hold: null, id: crypto.randomBytes(4).toString('hex'), t0: t };
  for (let i = 0; i < 2; i++) { const p = room.players[i]; p.ready = false; p.again = false; M.f[i].stance = p.look.stance === 'southpaw' ? 'southpaw' : 'orthodox'; }
  placeCorners(M);
  for (let i = 0; i < 2; i++) send(room.players[i], { t: 'mstart', you: i, id: M.id, rules: M.rules, foe: { name: room.players[1 - i].name, look: room.players[1 - i].look, dev: room.players[1 - i].dev },
    at: M.phaseT, intro: INTRO_S, st: snap(M) });
  pushRoom(room);
}
function placeCorners(M) { M.f[0].pos = { x: 0, z: -1.3 }; M.f[1].pos = { x: 0, z: 1.3 }; }
// the vitals both screens show, sent ten times a second and with every hit
function vit(f, Ru) { return [Math.round(f.health * 10) / 10, f.maxHealth, Math.round(f.stamina), Math.round(f.guard), Math.round(f.stun * 10) / 10, f.kd, f.kdRound, +(f.guardBreak > 0), +f.down, Math.round(R.rockR(f, Ru) * 100) / 100, f.rockLv]; }
function snap(M) { return { ph: M.phase, rd: M.round, ck: Math.max(0, Math.round(M.clock * 10) / 10), v: [vit(M.f[0], M.rules), vit(M.f[1], M.rules)],
  kd: M.kd && { w: M.kd.who, c: M.kd.count, m: Math.round(M.kd.meter * 100) / 100, up: M.kd.up, tko: M.kd.tko, full: M.kd.full },
  hold: M.hold && { w: M.hold.who, left: Math.max(0, Math.ceil(M.hold.until - now())) }, pt: M.phase === 'count' || M.phase === 'intro' || M.phase === 'break' ? Math.max(0, M.phaseT - now()) : 0 }; }
function broadcastSnap(room) { sendAll(room, { t: 'ms', s: snap(room.match) }); }

function knockdown(room, i, flash, why) {
  const M = room.match, f = M.f[i];
  f.down = true; f.kd++; f.kdRound++; f.stun = 0; f.blk = false; f.punches.clear();
  const tko = f.kdRound >= 3, D = R.kdDifficulty(f, flash);
  M.kd = { who: i, t: 0, count: 0, flash, tko, D, need: tko ? 1e9 : Math.round(10 + 20 * D), decay: .03 + .06 * D, nextSlip: 2.2, meter: 0, full: false, up: false };
  M.phase = 'kd';
  f.rockLv = 0;
  sendAll(room, { t: 'kd', w: i, flash, tko, need: M.kd.need, why: tko ? 'Third knockdown this round' : why || null });
}
function endRound(room) {
  const M = room.match, [a, b] = M.f;
  const cards = R.scoreRound(a, b, rand); M.cards.push(cards);
  const landed = [a.roundLanded, b.roundLanded];
  for (const f of M.f) { f.roundDmg = 0; f.roundLanded = 0; f.kdRound = 0; }
  if (M.round >= M.rules.rounds) { const d = R.decide(M.cards); endMatch(room, d.winner, d.method, false, d.tots); return; }
  M.phase = 'break'; M.phaseT = now() + BREAK_S;
  sendAll(room, { t: 'brk', rd: M.round, of: M.rules.rounds, landed, cards: M.cards, left: BREAK_S });
}
function nextRound(room) {
  const M = room.match; M.round++; M.clock = M.rules.len; M.phase = 'intro'; M.phaseT = now() + INTRO_S;
  for (const f of M.f) { f.health = Math.min(f.maxHealth, f.health + 8); f.stamina = 100; f.guard = 100; f.stun = 0; f.counterT = 0; f.punches.clear(); f.guardBreak = 0; f.chain.n = 0; }
  placeCorners(M);
  sendAll(room, { t: 'rnd', rd: M.round, at: M.phaseT, st: snap(M) });
}
function endMatch(room, winner, method, forfeit, tots) {
  const M = room.match; if (!M || M.phase === 'over') return;
  M.phase = 'over';
  const stats = M.f.map(f => ({ thrown: f.stats.thrown, landed: f.stats.landed, power: f.stats.power }));
  room.last = { winner, method, round: M.round, time: Math.round(M.rules.len - M.clock), flash: !!(M.kd && M.kd.flash), tots: tots || null, stats, rounds: M.rules.rounds, forfeit: !!forfeit };
  sendAll(room, Object.assign({ t: 'over' }, room.last));
  room.phase = 'results'; room.match = null; unready(room);
  pushRoom(room);
}

function tickMatch(room, dt) {
  const M = room.match, t = now();
  if (M.hold) {   // a player dropped: everything waits for them (the clock, the count), up to RECONNECT_S
    if (t > M.hold.until) { const i = M.hold.who; const p = room.players[i]; M.hold = null; if (p && !p.conn) { endMatch(room, 1 - i, 'Opponent disconnected', true); leave(room, i, 'timeout'); } }
    return;
  }
  for (const f of M.f) R.tickFighter(f, dt, t, M.rules);
  // misses nobody reported, and the rocked steps (a change is sent at once, so both screens show it start and end)
  for (let i = 0; i < 2; i++) { for (const [p, d] of R.whiffTimeouts(M.f[i], M.f[1 - i], t, M.rules)) if (d) sendAll(room, { t: 'dodge', w: 1 - i, ty: p.type, id: p.id });
    const f = M.f[i], lv = M.phase === 'fight' ? R.rockLevel(f, M.rules) : 0; if (lv !== f.rockLv) { f.rockLv = lv; sendAll(room, { t: 'rk', w: i, lv, r: Math.round(R.rockR(f, M.rules) * 100) / 100 }); } }
  if (M.phase === 'count' || M.phase === 'intro') { if (t >= M.phaseT) { M.phase = 'fight'; sendAll(room, { t: 'fight', rd: M.round }); } }
  else if (M.phase === 'fight') { M.clock -= dt; if (M.clock <= 0) { M.clock = 0; endRound(room); } }
  else if (M.phase === 'break') { if (t >= M.phaseT) nextRound(room); }
  else if (M.phase === 'kd') tickKD(room, dt);
}
// the count and the get-up meter: the downed player fills it by tapping (their taps arrive as messages); it drains a
// little all the time and now and then the legs give way. Up at a count of 2 or later; the fight goes on after 8
function tickKD(room, dt) {
  const M = room.match, K = M.kd, f = M.f[K.who];
  K.t += dt; const c = K.t > 1.2 ? Math.min(10, Math.floor(K.t - 1.2) + 1) : 0;
  if (c !== K.count) { K.count = c; sendAll(room, { t: 'kc', c, m: Math.round(K.meter * 100) / 100 }); }
  if (K.up) { if (c >= 8 && f.rising <= 0) { M.phase = 'fight'; M.kd = null; sendAll(room, { t: 'resume' }); } return; }
  if (K.tko) { if (K.t > 3) endMatch(room, 1 - K.who, 'TKO'); return; }
  if (!K.full) { K.meter = Math.max(0, K.meter - dt * K.decay);
    if (K.t > K.nextSlip) { K.nextSlip = K.t + .8 + rand() * .5; if (K.meter > .25 && rand() < K.D * .32) { K.meter = Math.max(0, K.meter - (.12 + rand() * .12) * (.6 + .5 * K.D)); sendAll(room, { t: 'slip', w: K.who }); } } }
  if (K.full && c >= 2) { R.standUp(f, K.D); K.up = true; sendAll(room, { t: 'up', w: K.who, c, st: snap(M) }); return; }
  if (K.t - 1.2 >= 10.4) endMatch(room, 1 - K.who, 'KO');
}

// ---------------- messages ----------------
function onMsg(ws, raw) {
  let m; try { m = JSON.parse(raw); } catch (_) { return; }
  if (!m || typeof m.t !== 'string') return;
  // a little flood protection: well over what a real client sends (20 states + some events a second)
  const t = now(); ws.rate = ws.rate || { n: 0, t }; if (t - ws.rate.t > 1) { ws.rate.n = 0; ws.rate.t = t; } if (++ws.rate.n > 120) return;
  if (m.t === 'pi') { ws.rtt = Math.min(2, Math.max(0, +m.rtt || 0)); if (ws.player) ws.player.rtt = ws.rtt; try { ws.send(JSON.stringify({ t: 'po', c: m.c, s: now() })); } catch (_) {} return; }
  if (m.t === 'hello') { ws.tok = cleanTok(m.tok); ws.name = cleanName(m.name); ws.look = cleanLook(m.look); ws.dev = m.dev === 'touch' ? 'touch' : 'pc'; ws.ver = +m.v || 0;
    try { ws.send(JSON.stringify({ t: 'welcome', s: now(), v: 1 })); } catch (_) {} return; }
  if (!ws.tok) return err(ws, 'hello', 'Say hello first');
  if (m.t === 'create') {
    if (ws.room) leaveWs(ws);
    const room = makeRoom(); const p = attach(ws, room, 0); p.ready = false; pushRoom(room); return;
  }
  if (m.t === 'join' || m.t === 'rejoin') {
    const code = String(m.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const room = rooms.get(code);
    if (!room) return err(ws, code.length === 6 ? 'expired' : 'invalid', code.length === 6 ? 'That room has closed or the code is wrong.' : 'Room codes are 6 letters and numbers.');
    // the same browser coming back (a refresh, a dropped connection): it takes its old place
    const back = room.players.findIndex(p => p && p.tok === ws.tok);
    if (back >= 0) { if (ws.room && ws.room !== room) leaveWs(ws); reattach(ws, room, back); return; }
    if (m.t === 'rejoin') return err(ws, 'expired', 'That room has closed.');
    const free = room.players.findIndex(p => !p);
    if (free < 0) return err(ws, 'full', 'That room already has two players.');
    if (ws.room) leaveWs(ws);
    attach(ws, room, free); unready(room); room.approved = [false, false];
    const o = other(room, free); if (o) send(o, { t: 'note', msg: ws.name + ' joined' });
    pushRoom(room); return;
  }
  const room = ws.room, p = ws.player; if (!room || !p) return;
  const i = slotOf(room, p); if (i < 0) return;
  room.touched = now();
  switch (m.t) {
    case 'leave': leaveWs(ws); try { ws.send(JSON.stringify({ t: 'left' })); } catch (_) {} return;
    case 'name': p.name = cleanName(m.name); if (m.look) p.look = cleanLook(m.look); pushRoom(room); return;
    case 'ready': if (room.phase !== 'lobby') return; p.ready = !!m.v; pushRoom(room); return;
    case 'mode': if (i !== 0 || room.phase !== 'lobby' || !['host', 'approve', 'shared'].includes(m.m)) return; room.mode = m.m; room.approved = [false, false]; unready(room); pushRoom(room); return;
    case 'set': {
      if (room.phase !== 'lobby' || !canEdit(room, i)) return;
      const next = R.cleanRules(m.r, room.rules); if (JSON.stringify(next) === JSON.stringify(room.rules)) return;
      room.rules = next; unready(room);
      // (Both Players Approve: a change is a proposal by whoever made it; the other has to approve it)
      room.approved = room.mode === 'approve' ? [i === 0, i === 1] : [false, false];
      room.lastBy = i; pushRoom(room); return; }
    case 'approve': if (room.mode !== 'approve' || room.phase !== 'lobby') return; room.approved[i] = true; pushRoom(room); return;
    case 'start': {
      if (room.phase !== 'lobby' || i !== 0) return;
      const ps = room.players; if (!ps[0] || !ps[1] || !ps[0].conn || !ps[1].conn) return err(ws, 'start', 'Waiting for a second player.');
      if (!ps[0].ready || !ps[1].ready) return err(ws, 'start', 'Both players need to be ready.');
      if (room.mode === 'approve' && !(room.approved[0] && room.approved[1])) return err(ws, 'start', 'Both players need to approve the rules.');
      startMatch(room); return; }
    case 'again': {   // rematch: when both press it, a new fight starts with the same rules
      if (room.phase !== 'results') return; p.again = true; pushRoom(room);
      if (room.players[0] && room.players[1] && room.players.every(q => q.again && q.conn)) startMatch(room); return; }
    case 'lobby': if (room.phase !== 'results') return; room.phase = 'lobby'; unready(room); room.approved = [false, false]; pushRoom(room); return;
  }
  // ---- in a match ----
  const M = room.match; if (!M || room.phase !== 'match') return;
  const f = M.f[i], o = M.f[1 - i], op = other(room, i);
  const live = M.phase === 'fight' && !M.hold;
  switch (m.t) {
    case 's': {   // this player's own movement and stance (20 a second); relayed to the other with the server's time
      if (!Array.isArray(m.s) || m.s.length < 10) return;
      const s = m.s.map(Number); if (s.some(v => !Number.isFinite(v))) return;
      // a fighter can't be anywhere: inside the ropes, and no faster than a dodge (with room for network bunching)
      const x = R.clamp(s[0], -2.3, 2.3), z = R.clamp(s[1], -2.3, 2.3);
      // (a jump further than that is followed at that top speed instead of taken at once, so a bad or forged position
      // can't put a fighter in reach, and a real big move, like the corners at a new round, is caught up within moments)
      let nx = x, nz = z;
      if (f.posT && live) { const dt = Math.max(.02, now() - f.posT), d = Math.hypot(x - f.pos.x, z - f.pos.z), mx = 6.5 * dt + .25; if (d > mx) { nx = f.pos.x + (x - f.pos.x) * mx / d; nz = f.pos.z + (z - f.pos.z) * mx / d; } }
      f.pos.x = nx; f.pos.z = nz; f.yaw = s[2]; f.posT = now();
      const blk = !!s[7] && live && f.guardBreak <= 0 && !f.down && f.rising <= 0;
      if (blk && !f.blk) f.blockSince = now(); f.blk = blk; f.gLvl = R.clamp(s[8], -1, 1);
      const duck = R.clamp(s[5], 0, 1); if (duck > .3 && f.duck <= .3) f.lastEvade = now(); f.duck = duck;
      if (Math.abs(s[6]) > .35 && Math.abs(f.lean || 0) <= .35) f.lastEvade = now(); f.lean = s[6];
      send(op, { t: 'o', ts: now(), s: [x, z, s[2], s[3], s[4], duck, R.clamp(s[6], -1.2, 1.2), +blk, f.gLvl, R.clamp(s[9], -3, 3), R.clamp(s[10] || 0, -3, 3)] });
      return; }
    case 'p': {   // a punch has started
      if (!live) return;
      const pr = R.startPunch(f, m.ty, m.id, now(), M.rules, f.stance); if (!pr) { send(p, { t: 'pno', id: m.id }); return; }
      send(op, { t: 'op', ty: m.ty, lo: m.lo ? 1 : 0, id: m.id }); return; }
    case 'dg': if (!live) return; f.lastDodge = now(); f.lastEvade = now(); if (M.rules.stam !== 'arcade') f.stamina = Math.max(0, f.stamina - R.STAM.dodge * ({ realistic: 1, relaxed: .6 })[M.rules.stam]); f.lastActT = now(); send(op, { t: 'odg', d: m.d }); return;
    case 'h': {   // "my glove touched them here": the server decides what it was worth
      if (!(live || M.phase === 'kd')) return;
      if (M.phase === 'kd') return;
      const lag = R.clamp((p.rtt || .1) / 2 + (op.rtt || .1) / 2 + .1, .06, .35);
      const r = R.resolveHit(f, o, m, now(), M.rules, lag, rand);
      if (r.reject) { send(p, { t: 'hno', id: m.id, why: r.reject }); return; }
      const ev = { t: 'hit', a: i, id: m.id, res: r.res, ty: r.type, z: r.zone, dmg: Math.round(r.dmg * 1000) / 1000, I: Math.round((r.I || 0) * 100) / 100, q: r.q, ct: !!r.counter, cf: r.cfrom || null, cn: r.comboN, va: !!r.varied, gl: !!r.glance, gb: !!r.gb, hd: m.hd || null, rep: r.rep, v: [vit(M.f[0], M.rules), vit(M.f[1], M.rules)] };
      sendAll(room, ev);
      if (r.res === 'dodged') sendAll(room, { t: 'dodge', w: 1 - i, ty: r.type, id: m.id });
      if (r.kd) knockdown(room, 1 - i, r.kd === 'flash', r.why);
      return; }
    case 'mi': {   // "my punch missed" (the attacker's own client, at once): the server decides whether it was a dodge
      const pr = f.punches.get(m.id); if (!pr || !live) return;
      if (now() < pr.t0 + PUNCHW(pr) * .4) return;
      if (R.whiff(f, o, pr, now(), M.rules) === 'dodge') sendAll(room, { t: 'dodge', w: 1 - i, ty: pr.type, id: m.id }); return; }
    case 'tap': {   // a get-up tap from the downed player
      const K = M.kd; if (M.phase !== 'kd' || !K || K.who !== i || K.up || K.full || K.tko) return;
      const tt = now(); if (tt - (K.lastTap || 0) < .045) return; K.lastTap = tt;   // faster than any thumb: ignored
      K.meter = Math.min(1, K.meter + 1 / K.need); if (K.meter >= .999) K.full = true; return; }
    case 'quit': endMatch(room, 1 - i, 'Opponent left', true); return;
    // (automated tests only: off unless the server is started with FPB_DEV=1; sets a fighter's health)
    case 'dev': if (process.env.FPB_DEV === '1' && typeof m.hp === 'number') { M.f[m.w === 1 ? 1 : 0].health = R.clamp(m.hp, 1, 100); } return;
  }
}
function attach(ws, room, i) {
  const p = { tok: ws.tok, name: ws.name, look: ws.look, dev: ws.dev, ws, conn: true, ready: false, again: false, rtt: ws.rtt || .1 };
  room.players[i] = p; ws.room = room; ws.player = p; room.emptySince = null;
  try { ws.send(JSON.stringify({ t: 'joined', code: room.code, slot: i })); } catch (_) {}
  return p;
}
function reattach(ws, room, i) {
  const p = room.players[i]; const old = p.ws;
  if (old && old !== ws) { old.room = null; old.player = null; try { old.close(4000, 'replaced'); } catch (_) {} }
  p.ws = ws; p.conn = true; p.name = ws.name || p.name; if (ws.look && Object.keys(ws.look).length) p.look = ws.look; p.dev = ws.dev || p.dev;
  ws.room = room; ws.player = p; room.emptySince = null;
  try { ws.send(JSON.stringify({ t: 'joined', code: room.code, slot: i, back: true })); } catch (_) {}
  const M = room.match;
  if (M && room.phase === 'match') {
    if (M.hold && M.hold.who === i) { M.hold = null; sendAll(room, { t: 'resumed', w: i }); }
    send(p, { t: 'mstart', you: i, id: M.id, rules: M.rules, foe: { name: other(room, i).name, look: other(room, i).look, dev: other(room, i).dev }, at: M.phaseT, intro: INTRO_S, st: snap(M), back: true });
  }
  const o = other(room, i); if (o) send(o, { t: 'note', msg: p.name + ' reconnected' });
  pushRoom(room);
}
function leaveWs(ws) { const room = ws.room, p = ws.player; if (!room || !p) return; const i = slotOf(room, p); ws.room = null; ws.player = null; if (i >= 0) leave(room, i, 'left'); }
function onClose(ws) {
  const room = ws.room, p = ws.player; if (!room || !p || p.ws !== ws) return;
  p.conn = false; p.ws = null; p.lostAt = now();
  const i = slotOf(room, p);
  // in a fight: the match waits (frozen) for them to come back; the other player is told
  if (room.match && room.phase === 'match' && room.match.phase !== 'over') { room.match.hold = { who: i, until: now() + RECONNECT_S }; sendAll(room, { t: 'hold', w: i, left: RECONNECT_S }); }
  else if (room.phase === 'lobby') p.ready = false;
  pushRoom(room);
}

// ---------------- the server ----------------
const httpServer = http.createServer((req, res) => {
  // a plain page, so a free host's health check (and a waking-up visit) has something to load
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
  res.end(req.url === '/health' ? 'ok' : 'First Person Boxer online server is running. Rooms open: ' + rooms.size + '\n');
});
const wss = new WebSocketServer({ server: httpServer, maxPayload: 8 * 1024,
  verifyClient: (info, cb) => { if (!ALLOWED.length || ALLOWED.includes(info.origin)) cb(true); else cb(false, 403, 'Origin not allowed'); } });
wss.on('connection', ws => {
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', d => onMsg(ws, d.toString()));
  ws.on('close', () => onClose(ws));
  ws.on('error', () => {});
});
// keep-alive pings (also how a vanished phone is noticed), the match clock, and tidying up
setInterval(() => { for (const ws of wss.clients) { if (!ws.alive) { try { ws.terminate(); } catch (_) {} continue; } ws.alive = false; try { ws.ping(); } catch (_) {} } }, 10000);
let lastTick = now();
setInterval(() => {
  const t = now(), dt = Math.min(.25, t - lastTick); lastTick = t;
  for (const room of rooms.values()) {
    if (room.match && room.phase === 'match') { tickMatch(room, dt); if (room.match && (room.tickN = (room.tickN || 0) + 1) % 2 === 0) broadcastSnap(room); }
  }
}, TICK * 1000);
setInterval(() => {
  const t = now();
  for (const room of [...rooms.values()]) {
    for (let i = 0; i < 2; i++) { const p = room.players[i]; if (p && !p.conn && t - p.lostAt > RECONNECT_S && !(room.match && room.match.hold)) leave(room, i, 'timeout'); }
    if (!rooms.has(room.code)) continue;
    const anyone = room.players.some(p => p && p.conn);
    if (!anyone) { room.emptySince = room.emptySince || t; if (t - room.emptySince > EMPTY_ROOM_S) rooms.delete(room.code); }
    else if (room.phase !== 'match' && t - room.touched > LOBBY_IDLE_S) { sendAll(room, { t: 'err', code: 'expired', msg: 'This room closed after 30 minutes without activity.' }); rooms.delete(room.code); }
  }
}, 5000);
httpServer.listen(PORT, () => console.log('First Person Boxer server on port ' + PORT + (ALLOWED.length ? ' (origins: ' + ALLOWED.join(', ') + ')' : '')));
module.exports = { rooms };
