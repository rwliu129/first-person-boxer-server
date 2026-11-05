// Protocol test: two scripted clients against a running server (node test/protocol_test.js [ws://localhost:8787])
'use strict';
const WebSocket = require('ws');
const URL = process.argv[2] || 'ws://localhost:8787';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) fails++; };
function client(name, dev) {
  return new Promise(res => {
    const ws = new WebSocket(URL); const c = { ws, name, msgs: [], room: null, last: {} };
    c.send = m => ws.send(JSON.stringify(m));
    c.wait = async (pred, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { const m = c.msgs.find(pred); if (m) { c.msgs.splice(c.msgs.indexOf(m), 1); return m; } await sleep(10); } return null; };
    ws.on('message', d => { const m = JSON.parse(d); if (m.t === 'room') c.room = m.r; c.last[m.t] = m; c.msgs.push(m); });
    ws.on('open', () => { c.send({ t: 'hello', v: 1, tok: (name + 'tok').padEnd(20, 'x'), name, look: { stance: 'orthodox', skin: '#c58a5c' }, dev }); res(c); });
  });
}
(async () => {
  const A = await client('Richard', 'pc'), B = await client('Friend', 'touch');
  await A.wait(m => m.t === 'welcome'); await B.wait(m => m.t === 'welcome');
  // ---- Stage 1: rooms and the lobby
  A.send({ t: 'create' }); const j = await A.wait(m => m.t === 'joined'); ok(j && /^[A-Z2-9]{6}$/.test(j.code), 'create gives a 6-character code: ' + (j && j.code));
  const code = j.code;
  B.send({ t: 'join', code: 'ZZZZZZ' }); let e = await B.wait(m => m.t === 'err'); ok(e && e.code === 'expired', 'unknown code -> ' + (e && e.msg));
  B.send({ t: 'join', code: 'AB1' }); e = await B.wait(m => m.t === 'err'); ok(e && e.code === 'invalid', 'malformed code -> ' + (e && e.msg));
  B.send({ t: 'join', code: code.toLowerCase() }); const jb = await B.wait(m => m.t === 'joined'); ok(jb && jb.slot === 1, 'guest joins with the code (any case) as slot 1');
  await sleep(100); ok(A.room.players[1] && A.room.players[1].name === 'Friend' && A.room.players[1].dev === 'touch', 'host sees the guest in real time (name, device)');
  const C = await client('Third', 'pc'); await C.wait(m => m.t === 'welcome'); C.send({ t: 'join', code }); e = await C.wait(m => m.t === 'err'); ok(e && e.code === 'full', 'third player -> ' + (e && e.msg)); C.ws.close();
  // settings permissions
  B.send({ t: 'set', r: { rounds: 1 } }); await sleep(150); ok(A.room.rules.rounds === 3, 'Host Only: the guest cannot change rules');
  A.send({ t: 'set', r: { rounds: 1, len: 60, dmg: 2, bogus: 1, kd: 'nonsense' } }); await sleep(150); ok(B.room.rules.rounds === 1 && B.room.rules.len === 60 && B.room.rules.dmg === 2 && B.room.rules.kd === 'classic', 'host changes rules; guest sees them; invalid values ignored');
  A.send({ t: 'mode', m: 'approve' }); await sleep(100); B.send({ t: 'set', r: { len: 120 } }); await sleep(150);
  ok(A.room.rules.len === 120 && A.room.approved[1] === true && A.room.approved[0] === false, 'Both Approve: the guest proposes, the host has to approve');
  A.send({ t: 'ready', v: true }); B.send({ t: 'ready', v: true }); await sleep(100); A.send({ t: 'start' }); e = await A.wait(m => m.t === 'err'); ok(e && /approve/.test(e.msg), 'start refused until both approve: ' + (e && e.msg));
  A.send({ t: 'approve' }); await sleep(100); ok(A.room.approved.every(Boolean), 'both approved');
  A.send({ t: 'mode', m: 'shared' }); await sleep(100); ok(!A.room.players[0].ready && !A.room.players[1].ready, 'changing the mode resets ready');
  B.send({ t: 'set', r: { len: 60, rounds: 3 } }); await sleep(150); ok(A.room.rules.len === 60 && A.room.rules.rounds === 3, 'Shared Editing: the guest changes rules directly');
  A.send({ t: 'ready', v: true }); await sleep(80); B.send({ t: 'set', r: { dmg: 1 } }); await sleep(150); ok(!A.room.players[0].ready, 'a rule change resets ready');
  A.send({ t: 'ready', v: true }); await sleep(80); A.send({ t: 'start' }); e = await A.wait(m => m.t === 'err'); ok(e && /ready/.test(e.msg), 'start refused until both ready');
  B.send({ t: 'ready', v: true }); await sleep(80); B.send({ t: 'start' }); await sleep(150); ok(!A.msgs.some(m => m.t === 'mstart'), 'only the host can start');
  // ---- Stage 2-4: a match
  A.send({ t: 'start' }); const sa = await A.wait(m => m.t === 'mstart'), sb = await B.wait(m => m.t === 'mstart');
  ok(sa && sb && sa.you === 0 && sb.you === 1 && sa.foe.name === 'Friend' && sb.foe.name === 'Richard' && sa.rules.len === 60, 'both get the match start, their slot, the opponent and the agreed rules');
  const send = (c, m) => c.send(m);
  // states at 20 Hz from both while the countdown runs
  let run = true, gen = 0; const st = (c, x, z, blk) => send(c, { t: 's', s: [x, z, c === A ? Math.PI : 0, -.04, 0, 0, 0, blk ? 1 : 0, 0, 0, 0] });
  let Ablk = false, Bpos = .62;
  (async (g) => { while (run && g === gen) { st(A, 0, 0, Ablk); st(B, 0, Bpos, false); await sleep(50); } })(++gen);
  const fA = await A.wait(m => m.t === 'fight', 6000); ok(!!fA, 'the bell: fight starts for both after the countdown and intro');
  const o = await A.wait(m => m.t === 'o'); ok(o && Math.abs(o.s[1] - .62) < 1e-6, 'A receives B\'s movement relayed');
  // a punch before claims: unknown punch rejected
  send(A, { t: 'h', id: 999, z: 'head', g: 0, q: 1 }); let r = await A.wait(m => m.t === 'hno'); ok(r && r.why === 'unknown punch', 'a hit claim for a punch never started is rejected');
  // A throws a straight and claims a clean chin shot at the right time
  send(A, { t: 'p', id: 1, ty: 'straight', lo: 0 }); const opb = await B.wait(m => m.t === 'op'); ok(opb && opb.ty === 'straight', 'B is told A started a straight');
  await sleep(140); send(A, { t: 'h', id: 1, z: 'chin', g: 0, q: 1 }); const h1 = await A.wait(m => m.t === 'hit'); const h1b = await B.wait(m => m.t === 'hit');
  ok(h1 && h1b && h1.res === 'clean' && h1.dmg > 0 && h1.v[1][0] < 100, `clean chin straight: server dmg ${h1 && h1.dmg}, B health ${h1 && h1.v[1][0]}`);
  send(A, { t: 'h', id: 1, z: 'chin', g: 0, q: 1 }); r = await A.wait(m => m.t === 'hno'); ok(r && r.why === 'duplicate', 'the same punch cannot hit twice');
  send(A, { t: 'p', id: 2, ty: 'jab', lo: 0 }); await sleep(1500); send(A, { t: 'h', id: 2, z: 'head', g: 0, q: 1 }); r = await A.wait(m => m.t === 'hno'); ok(r && r.why === 'timing', 'a claim long after the punch -> timing');
  // out of reach
  Bpos = 2.2; await sleep(700); send(A, { t: 'p', id: 3, ty: 'jab', lo: 0 }); await sleep(100); send(A, { t: 'h', id: 3, z: 'head', g: 0, q: 1 }); r = await A.wait(m => m.t === 'hno'); ok(r && r.why === 'out of reach', 'a hit from 2.2 m away is rejected');
  Bpos = .62; await sleep(200);
  // spam: same hand faster than a punch can come back
  send(A, { t: 'p', id: 4, ty: 'jab' }); send(A, { t: 'p', id: 5, ty: 'jab' }); r = await A.wait(m => m.t === 'pno'); ok(r && r.id === 5, 'a second jab from the same hand at once is refused');
  // blocks: B blocks; A's straight into the guard
  await sleep(500);
  const Bblk = async (on) => { /* B's state carries the block flag */ };
  run = false; await sleep(60); run = true;
  (async (g) => { while (run && g === gen) { st(A, 0, 0, false); send(B, { t: 's', s: [0, .62, 0, -.04, 0, 0, 0, 1, .2, 0, 0] }); await sleep(50); } })(++gen);
  await sleep(600);
  send(A, { t: 'p', id: 6, ty: 'straight' }); await sleep(140); send(A, { t: 'h', id: 6, z: 'guard', g: 1, q: 1, hd: 'R' }); const hb = await A.wait(m => m.t === 'hit');
  ok(hb && hb.res === 'blocked' && hb.dmg < .2 && hb.v[1][3] < 100, `blocked straight: ${hb && hb.res} dmg ${hb && hb.dmg}, guard ${hb && hb.v[1][3]}`);
  // late block: B raises the guard just now (inside the lag window), A claims clean -> server gives it to the block
  run = false; await sleep(60); run = true;
  (async (g) => { while (run && g === gen) { st(A, 0, 0, false); send(B, { t: 's', s: [0, .62, 0, -.04, 0, 0, 0, 0, .2, 0, 0] }); await sleep(50); } })(++gen);
  await sleep(1700);
  send(A, { t: 'p', id: 7, ty: 'straight' }); await sleep(120); send(B, { t: 's', s: [0, .62, 0, -.04, 0, 0, 0, 1, .2, 0, 0] }); await sleep(20);
  send(A, { t: 'h', id: 7, z: 'head', g: 0, q: 1 }); const hl = await A.wait(m => m.t === 'hit'); ok(hl && hl.res === 'blocked', 'a block raised too late for A to see still counts: ' + (hl && hl.res));
  // a slip inside the lag window
  await sleep(700); send(A, { t: 'p', id: 8, ty: 'jab' }); await sleep(60); send(B, { t: 's', s: [0, .62, 0, -.04, 0, 0, .8, 0, .2, 0, 0] }); await sleep(20);
  send(A, { t: 'h', id: 8, z: 'head', g: 0, q: 1 }); const hd = await A.wait(m => m.t === 'hit'); ok(hd && hd.res === 'dodged' && hd.dmg === 0, 'a slip A could not see yet makes the head shot miss: ' + (hd && hd.res));
  run = false; await sleep(60);
  // pound B down: clean hooks until a knockdown
  run = true; (async (g) => { while (run && g === gen) { st(A, 0, 0, false); st(B, 0, .62, false); await sleep(50); } })(++gen);
  await sleep(400);
  let id = 100, kd = null;
  for (let n = 0; n < 60 && !kd; n++) { const ty = n % 2 ? 'lhook' : 'rhook'; send(A, { t: 'p', id: ++id, ty }); await sleep(170); send(A, { t: 'h', id, z: 'chin', g: 0, q: 1 }); await sleep(260); kd = A.msgs.find(m => m.t === 'kd'); }
  ok(!!kd && kd.w === 1, 'enough clean shots knock B down (' + (kd ? 'stun/health, need ' + kd.need + ' taps' : 'none') + ')');
  B.msgs.length = 0; A.msgs.length = 0;
  // B taps to get up
  for (let n = 0; n < 60; n++) { send(B, { t: 'tap' }); await sleep(60); if (A.msgs.find(m => m.t === 'up')) break; }
  const up = await A.wait(m => m.t === 'up', 4000); ok(!!up, 'B taps and gets up at ' + (up && up.c));
  const rs = await A.wait(m => m.t === 'resume', 12000); ok(!!rs, 'after the mandatory eight the fight resumes');
  // the round ends on the clock (60 s): wait for the break
  const brk = await A.wait(m => m.t === 'brk', 70000); ok(brk && brk.cards.length === 1 && brk.cards[0][0][0] >= brk.cards[0][0][1], 'round 1 ends on the clock; cards ' + (brk && JSON.stringify(brk.cards[0])));
  // B disconnects during the break -> hold; reconnects -> resumes
  B.ws.close(); const hold = await A.wait(m => m.t === 'hold', 3000); ok(hold && hold.w === 1, 'A is told B dropped; the match waits');
  const B2 = await client('Friend', 'touch'); await B2.wait(m => m.t === 'welcome'); B2.send({ t: 'rejoin', code });
  const back = await B2.wait(m => m.t === 'mstart' && m.back, 3000); ok(back && back.you === 1 && back.st.rd === 1, 'B comes back (same browser token) and gets the match state back');
  const rsm = await A.wait(m => m.t === 'resumed', 3000); ok(!!rsm, 'A sees B reconnect');
  run = false; await sleep(60); run = true; (async (g) => { while (run && g === gen) { st(A, 0, 0, false); st(B2, 0, .62, false); await sleep(50); } })(++gen);
  const rnd = await A.wait(m => m.t === 'rnd', 20000); ok(rnd && rnd.rd === 2, 'round 2 starts after the break');
  // B quits -> A wins by forfeit; results; rematch needs both
  B2.send({ t: 'quit' }); const ov = await A.wait(m => m.t === 'over', 3000); ok(ov && ov.winner === 0 && ov.forfeit, 'B quits: A wins (' + (ov && ov.method) + ')');
  run = false; await sleep(150);
  ok(A.room.phase === 'results', 'room goes to results');
  A.send({ t: 'again' }); await sleep(150); ok(!A.msgs.some(m => m.t === 'mstart'), 'one rematch vote is not enough');
  B2.send({ t: 'again' }); const re = await A.wait(m => m.t === 'mstart', 3000); ok(re && re.st.v[0][0] === 100 && re.st.v[1][0] === 100 && re.st.v[1][5] === 0, 'both vote rematch: a new match, health and knockdowns reset');
  B2.send({ t: 'quit' }); await A.wait(m => m.t === 'over', 3000); A.send({ t: 'lobby' }); await sleep(150); ok(A.room.phase === 'lobby' && B2.room.phase === 'lobby', 'Return to Lobby takes both back to the lobby');
  B2.send({ t: 'leave' }); await sleep(150); ok(!A.room.players[1], 'the guest leaves; the host sees it');
  A.send({ t: 'leave' }); await sleep(150);
  console.log(fails ? `\n${fails} FAILED` : '\nall passed'); process.exit(fails ? 1 : 0);
})();
