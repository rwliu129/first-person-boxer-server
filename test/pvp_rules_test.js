// PvP combat rules over the real protocol (node test/pvp_rules_test.js [ws://localhost:8787])
'use strict';
const WebSocket = require('ws');
const URL = process.argv[2] || 'ws://localhost:8787';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) fails++; };
function client(name) {
  return new Promise(res => { const ws = new WebSocket(URL); const c = { ws, msgs: [], room: null };
    c.send = m => ws.send(JSON.stringify(m));
    c.wait = async (pred, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { const m = c.msgs.find(pred); if (m) { c.msgs.splice(c.msgs.indexOf(m), 1); return m; } await sleep(10); } return null; };
    ws.on('message', d => { const m = JSON.parse(d); if (m.t === 'room') c.room = m.r; c.msgs.push(m); });
    ws.on('open', () => { c.send({ t: 'hello', v: 1, tok: (name + 'tk').padEnd(20, 'y'), name, look: {}, dev: 'pc' }); res(c); }); });
}
async function match(A, B, rules) {
  A.send({ t: 'create' }); const j = await A.wait(m => m.t === 'joined'); B.send({ t: 'join', code: j.code }); await B.wait(m => m.t === 'joined');
  A.send({ t: 'set', r: rules }); await sleep(100); A.send({ t: 'ready', v: true }); B.send({ t: 'ready', v: true }); await sleep(100); A.send({ t: 'start' });
  await A.wait(m => m.t === 'mstart'); await B.wait(m => m.t === 'mstart');
}
(async () => {
  const A = await client('Atk'), B = await client('Def');
  await match(A, B, { rounds: 3, len: 180 });
  let gen = 0, bLean = 0, bDuck = 0; const loop = g => (async () => { while (g === gen) { A.send({ t: 's', s: [0, 0, Math.PI, -.04, 0, 0, 0, 0, 0, 0, 0] }); B.send({ t: 's', s: [0, .62, 0, -.04, 0, bDuck, bLean, 0, 0, 0, 0] }); await sleep(50); } })();
  loop(++gen);
  await A.wait(m => m.t === 'fight', 7000);
  let id = 0; const punch = async (ty, z = 'chin', wait = 150) => { const k = ++id; A.send({ t: 'p', id: k, ty }); await sleep(wait); A.send({ t: 'h', id: k, z, g: 0, q: 1 }); const h = await A.wait(m => m.t === 'hit' && m.id === k); await sleep(300); return h; };
  // 1. repeated jabs count for less; a different punch resets it
  const js = []; for (let i = 0; i < 6; i++) js.push(await punch('jab', 'head'));
  const reps = js.map(h => h && h.rep); ok(reps[0] === 1 && reps[5] < reps[1] && reps[5] >= .55, 'the same jab landing again counts for less: ' + reps.join(' '));
  const st = await punch('straight', 'head'); ok(st && st.rep >= 1, 'a different punch resets the repeat penalty (x' + (st && st.rep) + ')');
  // 2. jabs alone cannot drop him through stun
  let kd = null; for (let i = 0; i < 40 && !kd; i++) { await punch('jab', 'chin', 130); kd = A.msgs.find(m => m.t === 'kd'); }
  const lastV = A.msgs.filter(m => m.t === 'ms').pop();
  ok(!kd, 'forty clean jabs to the chin do not cause a stun knockdown (rocked level ' + (lastV && lastV.s.v[1][10]) + ', stun ' + (lastV && lastV.s.v[1][4]) + ')');
  // 3. a power shot then finishes it, and the cause is named
  A.msgs.length = 0; let h; for (let i = 0; i < 6 && !kd; i++) { h = await punch(i % 2 ? 'lhook' : 'rhook', 'chin', 170); kd = A.msgs.find(m => m.t === 'kd'); }
  const rk = A.msgs.filter(m => m.t === 'rk' && m.w === 1).map(m => m.lv); ok(rk.length > 0 && Math.max(...rk) >= 1, 'rocked steps are announced on both screens as they change: ' + rk.join(' > '));
  ok(kd && kd.why, 'the knockdown names its real cause: "' + (kd && kd.why) + '" (last punch ' + (h && h.ty + (h.ct ? ', counter' : '') + (h.cn > 1 ? ', ' + h.cn + '-hit combo' : '')) + ')');
  // get up
  for (let n = 0; n < 80; n++) { B.send({ t: 'tap' }); await sleep(60); if (A.msgs.find(m => m.t === 'up')) break; }
  await A.wait(m => m.t === 'resume', 14000); await sleep(1500);
  // 4. a slip while a punch comes in: the attacker reports its miss, the server confirms the dodge, and the defender's next
  // clean shot is a counter
  A.msgs.length = 0; B.msgs.length = 0;
  const k = ++id; A.send({ t: 'p', id: k, ty: 'straight' }); await sleep(60); bLean = .8; await sleep(120); A.send({ t: 'mi', id: k });
  const dg = await B.wait(m => m.t === 'dodge', 2000); const dga = await A.wait(m => m.t === 'dodge', 500);
  ok(dg && dga && dg.w === 1, 'a slipped straight is confirmed as a dodge on both screens');
  bLean = 0; await sleep(200);
  const k2 = 900; B.send({ t: 'p', id: k2, ty: 'straight' }); await sleep(150); B.send({ t: 'h', id: k2, z: 'head', g: 0, q: 1 }); const ch = await B.wait(m => m.t === 'hit' && m.id === k2);
  ok(ch && ch.ct && ch.cf === 'dodge', 'the defender\'s next clean shot is a counter off the dodge (x1.4): ' + (ch && ch.cf));
  // 5. a punch that just misses (no evasion) is no dodge, but leaves the thrower open to a counter
  await sleep(600); A.msgs.length = 0; B.msgs.length = 0;
  const k3 = ++id; A.send({ t: 'p', id: k3, ty: 'rhook' }); await sleep(300); A.send({ t: 'mi', id: k3 }); await sleep(30);
  const noDodge = !(await B.wait(m => m.t === 'dodge', 300));
  const k4 = 901; B.send({ t: 'p', id: k4, ty: 'straight' }); await sleep(150); B.send({ t: 'h', id: k4, z: 'head', g: 0, q: 1 }); const c2 = await B.wait(m => m.t === 'hit' && m.id === k4);
  ok(noDodge && c2 && c2.ct && c2.cf === 'caught', 'a plain miss is no dodge, but punishing the missed hook counts as a counter (' + (c2 && c2.cf) + ')');
  // 6. a flurry costs more stamina than the same punches spaced out
  await sleep(3500); const v0 = A.msgs.filter(m => m.t === 'ms').pop().s.v[0][2]; A.msgs.length = 0;
  for (let i = 0; i < 9; i++) { A.send({ t: 'p', id: ++id, ty: i % 2 ? 'straight' : 'jab' }); await sleep(200); }
  await sleep(120); const v1 = A.msgs.filter(m => m.t === 'ms').pop().s.v[0][2]; const pno = A.msgs.filter(m => m.t === 'pno').length;
  ok(pno === 0 && v0 - v1 > 20, `nine punches in 1.8 s (none refused: ${pno === 0}) cost ${v0 - v1} stamina net of regen (plain cost 18.5, minus about 8 regained)`);
  gen++; console.log(fails ? `\n${fails} FAILED` : '\nall passed'); process.exit(fails ? 1 : 0);
})();
