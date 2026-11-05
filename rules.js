// First Person Boxer: the server's copy of the combat numbers.
// These mirror the single-player client (js_data.js, js_combat.js landHit, js_fighter.js receiveCore, js_frame.js physics
// and the knockdown code) so an online fight scores exactly like a fight against the AI. The server never takes damage,
// health, stamina or guard from a client: it works them out here from the punch, where it landed and both fighters'
// state. Keep these tables in step with the client when the combat is retuned.
'use strict';

const PUNCH = {
  jab:      { hand: 'lead', w: .045, e: .10, r: .15, st: 1.5, reach: .70 },
  straight: { hand: 'rear', w: .07,  e: .13, r: .20, st: 2.6, reach: .74 },
  lhook:    { hand: 'L',    w: .08,  e: .16, r: .22, st: 3.2, reach: .56 },
  rhook:    { hand: 'R',    w: .10,  e: .18, r: .26, st: 3.6, reach: .56 },
  lupper:   { hand: 'L',    w: .08,  e: .14, r: .23, st: 3.3, reach: .52 },
  rupper:   { hand: 'R',    w: .095, e: .155, r: .25, st: 3.6, reach: .52 },
};
const PDMG = { jab: 5.5, straight: 8.3, lhook: 9.9, rhook: 11, lupper: 10.5, rupper: 12.1 };
const DMG_SCALE = .15;
const STAM = { whiff: 1, dodge: 4.5, regenIdle: 18, regenActive: 4.5, idleDelay: .5, bodyTorso: .75, bodyRibs: .95, bodyAbdomen: 1.15 };
const GUARD_WEAR = { jab: .9, straight: 1.1, lhook: 1.3, rhook: 1.3, lupper: 1.3, rupper: 1.3 };
const COMBO_WIN = { jab: .62, straight: .78, lhook: .9, rhook: .92, lupper: .9, rupper: .92 };
const MISS_RECOVER = { jab: .14, straight: .3, lhook: .45, rhook: .5, lupper: .45, rupper: .5 };
// ---- PvP-only additions (single player is untouched: these rules run only on this server) ----
// repeated punches: landing the same punch again within 2.4 s counts for less each time (a jab down to 55 %, others to
// 65 %); a different punch resets it, and switching quickly still adds 8 %. Varied combinations score; one button doesn't
const REPEAT = { jab: [.12, .55], other: [.1, .65] };
// flurries: more than 5 punches in 2 s costs half again as much stamina for each one beyond, up to double
const FLURRY = { window: 2, free: 5, extra: .5, max: 2 };
// how close to a stun knockdown a fighter is, in steps both screens show: shaken, rocked, out on their feet
const ROCK_LV = [.45, .7, .9];
const ZONES = new Set(['head', 'chin', 'side', 'torso', 'ribs', 'abdomen', 'guard']);
const isHook = t => t === 'lhook' || t === 'rhook';
const isUpper = t => t === 'lupper' || t === 'rupper';
const isHead = z => z === 'head' || z === 'chin' || z === 'side';
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

// the shared match rules both players agreed on in the lobby
const RULE_OPTS = {
  rounds: [1, 3, 4, 6, 8, 10, 12],
  len: [60, 120, 180],
  dmg: [.5, .75, 1, 1.25, 1.5, 2],
  stam: ['realistic', 'relaxed', 'arcade'],
  ko: ['rare', 'normal', 'frequent'],
  kd: ['classic', 'health'],
};
const DEFAULT_RULES = { rounds: 3, len: 120, dmg: 1, stam: 'realistic', ko: 'normal', kd: 'classic' };
function cleanRules(r, base = DEFAULT_RULES) {
  const out = Object.assign({}, base);
  if (!r || typeof r !== 'object') return out;
  for (const k in RULE_OPTS) if (k in r && RULE_OPTS[k].includes(r[k])) out[k] = r[k];
  return out;
}
const koMul = r => ({ rare: .6, normal: 1, frequent: 1.6 })[r.ko] || 1;
const stamMul = r => ({ realistic: 1, relaxed: .6, arcade: 0 })[r.stam];
const toughness = r => r.rounds <= 3 ? 1 : r.rounds <= 6 ? 1.1 : r.rounds <= 8 ? 1.2 : 1.3;

function newFighter(dev) {
  return {
    dev: dev === 'touch' ? 'touch' : 'pc',
    health: 100, maxHealth: 100, stamina: 100, guard: 100, stun: 0, stunLastT: -9, stunLastType: null, stunRep: 0,
    guardBreak: 0, gbImm: 0, guardHitT: -9, lastActT: -9, counterT: 0,
    kd: 0, kdRound: 0, down: false, rising: 0,
    blk: false, blockSince: -9, gLvl: 0, duck: 0, lastEvade: -9, lastDodge: -9,
    pos: { x: 0, z: 0 }, yaw: 0,
    punches: new Map(), handBusy: { L: -9, R: -9 }, lastPunchT: -9,
    chain: { n: 0, last: null, zone: null, t: -9 }, lastLandType: null, lastLandT: -9,
    roundDmg: 0, roundLanded: 0, stats: { thrown: 0, landed: 0, power: 0, dmg: 0, dodged: 0, counters: 0 },
    repeatN: 0, recent: [], gbAt: -9, rockLv: 0, counterFrom: null,
  };
}
// the same tiredness curve as the client's Fighter.tired(): 0 above 75 % stamina, .15 at 40 %, .5 at 15 %, 1 at empty
function tired(s) { return s >= 75 ? 0 : s >= 40 ? (75 - s) / 35 * .15 : s >= 15 ? .15 + (40 - s) / 25 * .35 : .5 + (15 - s) / 15 * .5; }
const speedMul = f => 1 + .12 * tired(f.stamina);
const stunThr = f => 45 + f.health * .3;
const rockR = (f, R) => !f.down && R.kd !== 'health' ? clamp(f.stun / stunThr(f), 0, 1.2) : 0;
function spend(f, x, R) { if (R.stam === 'arcade') return; f.stamina = Math.max(0, f.stamina - x * stamMul(R)); }
function handFor(type, stance) { const h = PUNCH[type].hand, sp = stance === 'southpaw'; return h === 'lead' ? (sp ? 'R' : 'L') : h === 'rear' ? (sp ? 'L' : 'R') : h; }
// how long a punch keeps its hand busy (load, snap, recovery), at its slowest
const punchSpan = (type, sm) => (PUNCH[type].w + PUNCH[type].e + PUNCH[type].r) * sm;

const rockLevel = (f, R) => { const r = rockR(f, R); return r >= ROCK_LV[2] ? 3 : r >= ROCK_LV[1] ? 2 : r >= ROCK_LV[0] ? 1 : 0; };
// per tick (the same rates as the client's physics()): stamina, guard, stun, timers
function tickFighter(f, dt, now, R) {
  f.counterT = Math.max(0, f.counterT - dt);
  if (f.guardBreak > 0) { f.guardBreak -= dt; if (f.guardBreak <= 0) { f.guardBreak = 0; f.guard = 40; f.gbImm = now + (f.dev === 'touch' ? 1 : 1.8); } }
  if (now - f.guardHitT > 1.6) f.guard = Math.min(100, f.guard + 12 * dt);
  f.stun = Math.max(0, f.stun - (now - f.stunLastT > 1.5 ? 11 : 7) * dt);
  if (R.stam === 'arcade') f.stamina = 100;
  else f.stamina = Math.min(100, f.stamina + dt * (now - f.lastActT > STAM.idleDelay ? STAM.regenIdle : STAM.regenActive));
  if (f.rising > 0) f.rising -= dt;
  // a punch nobody claimed a hit for by the end of its reach was a miss: it costs the whiff stamina, as in the client
  for (const [id, p] of f.punches) if (now > p.t0 + 3) f.punches.delete(id);
}
// a punch that found nothing: its thrower pays the whiff stamina and is open (caught) for its recovery; if the other
// fighter was slipping, ducking or stepping away while it came in, that was a dodge: they get a short counter window.
// Returns 'dodge' when it was dodged. (The thrower's client reports its misses at once; the server also times them out)
function whiff(f, def, p, now, R) {
  if (p.claimed || p.whiffed) return null;
  p.whiffed = true; p.missT = now; spend(f, STAM.whiff, R);
  const D = PUNCH[p.type], from = p.t0 - .25, to = p.t0 + (D.w + D.e) * p.sm + .12;
  const ev = Math.max(def.lastEvade, def.lastDodge);
  if (ev >= from && ev <= to && !def.down) { def.counterT = Math.max(def.counterT, .7); def.counterFrom = 'dodge'; def.stats.dodged++; return 'dodge'; }
  return null;
}
function whiffTimeouts(f, def, now, R) { const out = []; for (const p of f.punches.values()) if (!p.claimed && !p.whiffed && now > p.t0 + (PUNCH[p.type].w + PUNCH[p.type].e) * p.sm * 1.4 + .5) out.push([p, whiff(f, def, p, now, R)]); return out; }

// a punch has started (the attacker's client says so): it is accepted only when that fighter could throw it
function startPunch(f, type, id, now, R, stance) {
  if (!PUNCH[type] || typeof id !== 'number') return null;
  if (f.down || f.rising > 0 || f.punches.has(id)) return null;
  const h = handFor(type, stance), sm = speedMul(f);
  // the same hand can't throw again before its last punch has (nearly) come back: flowing combinations shorten the load,
  // so a quarter of the span is allowed off, plus a little for timing differences between the two clocks
  if (now < f.handBusy[h] - .08) return null;
  const p = { id, type, h, t0: now, sm, tired: tired(f.stamina), claimed: false, whiffed: false };
  f.handBusy[h] = now + punchSpan(type, sm) * .7;
  f.punches.set(id, p);
  // (PvP: a flurry beyond 5 punches in 2 s costs more stamina for each punch past that)
  f.recent = f.recent.filter(t => now - t < FLURRY.window); f.recent.push(now);
  const over = Math.max(0, f.recent.length - FLURRY.free), fm = Math.min(FLURRY.max, 1 + FLURRY.extra * over);
  spend(f, PUNCH[type].st * fm, R); f.lastActT = now; f.lastPunchT = now; f.stats.thrown++;
  return p;
}
// is this fighter caught mid-punch (arm out), or still recovering from a punch that missed (the client's caught())?
// PvP: a missed straight, hook or uppercut leaves its thrower open for that punch's miss recovery
function caught(f, now) { for (const p of f.punches.values()) { const d = PUNCH[p.type]; const a = p.t0 + d.w * p.sm * .55, b = p.t0 + (d.w + d.e) * p.sm * 1.15;
  if (now >= a && now <= b) return true; if (p.whiffed && p.missT && now <= p.missT + MISS_RECOVER[p.type] + .1) return true; } return false; }

// The core of an online hit. att and def are server fighters; c is the attacker's claim (what its glove touched on its
// screen); lag is how stale its view of the defender can be. Returns the authoritative result, or a rejection
function resolveHit(att, def, c, now, R, lag, rand) {
  const p = att.punches.get(c.id);
  if (!p) return { reject: 'unknown punch' };
  if (p.claimed) return { reject: 'duplicate' };
  const D = PUNCH[p.type];
  // timing: contact can only happen while the punch is going out (with room for the two clocks and the network)
  const age = now - p.t0, tMin = D.w * p.sm * .45 - .03, tMax = (D.w + D.e) * p.sm * 1.6 + .25 + lag;
  if (age < tMin || age > tMax) return { reject: 'timing' };
  // distance: the two fighters' centres can't be further apart than any punch reaches (plus how far both may have
  // moved inside the lag window at a fighter's top speed)
  const dist = Math.hypot(att.pos.x - def.pos.x, att.pos.z - def.pos.z);
  if (dist > 1.55 + 2.6 * lag) return { reject: 'out of reach' };
  if (def.down || def.rising > 0) return { reject: 'defender down' };
  p.claimed = true;
  let zone = ZONES.has(c.z) ? c.z : 'torso', guard = !!c.g;
  const q = clamp(+c.q || .75, .27, 1), glance = !guard && !!c.gl, pad = guard && !!c.pad;
  // fairness for the defender: a slip, duck or dodge, or a block, that began too recently for the attacker to have seen
  // it still counts. Head shots are slipped by any evasion; body shots only by a dodge (a step out of the way)
  if (!guard) {
    const dodged = () => { p.whiffed = true; p.missT = now; def.counterT = Math.max(def.counterT, .7); def.counterFrom = 'dodge'; def.stats.dodged++; return { res: 'dodged', type: p.type, zone, dmg: 0 }; };
    if (def.lastDodge >= now - lag) return dodged();
    if (isHead(zone) && def.lastEvade >= now - lag) return dodged();
    const covers = isHead(zone) ? def.gLvl > -.45 : def.gLvl < .45;
    if (def.blk && def.guardBreak <= 0 && def.blockSince >= now - lag && covers && !(isUpper(p.type) && isHead(zone))) { guard = true; zone = 'guard'; }
  }
  // the punch's force (landHit): base damage, how tired the thrower was, where it landed and how squarely
  const stf = 1 - .45 * p.tired;
  const base = PDMG[p.type] * stf * R.dmg * DMG_SCALE;
  const hk = isHook(p.type), up = isUpper(p.type);
  let zm = 1;
  if (zone === 'chin') zm = up ? 1.6 : 1.4; else if (zone === 'side') zm = hk ? 1.35 : 1.05; else if (zone === 'head') zm = hk ? .95 : .92;
  else if (zone === 'torso') zm = .72; else if (zone === 'ribs') zm = hk ? .9 : .8; else if (zone === 'abdomen') zm = .85;
  let cm = 1, counter = false, cfrom = null;
  if (!guard && att.counterT > 0) { cm = 1.4; counter = true; cfrom = att.counterFrom || 'parry'; att.counterT = 0; att.counterFrom = null; }
  else if (!guard && caught(def, now)) { cm = 1.25; counter = true; cfrom = 'caught'; }
  if (counter) att.stats.counters++;
  // the same punch landing again and again counts for less; switching punches quickly adds a little (+8 %)
  let rep = 1;
  if (!guard) { const same = att.lastLandType === p.type && now - att.lastLandT < 2.4;
    att.repeatN = same ? att.repeatN + 1 : 0; const rp = p.type === 'jab' ? REPEAT.jab : REPEAT.other; rep = Math.max(rp[1], 1 - rp[0] * att.repeatN);
    if (!same && now - att.lastLandT < 1.1) rep *= 1.08; att.lastLandType = p.type; att.lastLandT = now; }
  // combinations: a clean hit inside the opening the last one made, varied (another punch or the other level), +8 % per hit to +24 %
  let comboN = 1, varied = false;
  const lvl = isHead(zone) ? 'h' : 'b', ch = att.chain;
  if (!guard && ch.n > 0 && now - ch.t < (COMBO_WIN[ch.last] || .8) + .15) { comboN = ch.n + 1; varied = ch.last !== p.type || ch.zone !== lvl; }
  // (only a varied follow-up continues the chain; repeating the same punch at the same level starts it again)
  if (comboN > 1 && !varied) comboN = 1;
  if (guard) ch.n = 0; else { ch.n = comboN; ch.last = p.type; ch.zone = lvl; ch.t = now; }
  const cb = comboN > 1 && varied ? 1 + Math.min(.24, .08 * (comboN - 1)) : 1;
  let dmg = base * zm * q * cm * rep * cb * (glance ? .55 : 1);
  const I = dmg / DMG_SCALE;
  let res = 'clean', gb = false, kd = null;
  if (guard) {
    // receiveCore's guard branch: a proper block takes nearly all of it; a glove merely in the way takes most
    const blk = def.blk && def.guardBreak <= 0;
    res = blk ? 'blocked' : 'parried';
    const commit = Math.min(1, Math.abs(def.gLvl || 0) * 1.25);
    const d0 = dmg;
    dmg *= blk ? (def.guard < 25 ? .08 : .03 + .04 * (1 - commit)) : .15;
    if (pad && blk) dmg = d0 * .1;
    const tw = (GUARD_WEAR[p.type] || 1) * (def.dev === 'touch' ? 1.35 : 1), gPre = def.guard;
    def.guard -= Math.max(I, 2.5) * (blk ? 1.5 : 1.1) * (blk ? 1.3 - .3 * commit : 1) * 1.6 * 1.35 * tw; def.guardHitT = now;
    if (def.guard <= 0 && now < def.gbImm) def.guard = 1;
    if (gPre >= 80) def.guard = Math.max(def.guard, 8);
    // blocking just in time (a parry) or absorbing a big shot opens a counter for the defender
    if (blk && (now - def.blockSince < .3 || I >= 8)) def.counterT = Math.max(def.counterT, now - def.blockSince < .3 ? .8 : .5);
    if (def.guard <= 0) { def.guard = 0; def.guardBreak = .65; def.blk = false; gb = true; def.gbAt = now; }
    att.stats.blocked = (att.stats.blocked || 0) + 1;
  } else {
    if (isHead(zone) && R.kd !== 'health') {
      // head stun: repeats of the same punch count for less, and no single shot adds more than a quarter of the threshold
      const r = now - def.stunLastT < 1.2 && def.stunLastType === p.type ? (def.stunRep = def.stunRep + 1) : (def.stunRep = 0);
      def.stunLastT = now; def.stunLastType = p.type;
      const add = I * 1.1 * (p.type === 'jab' ? .45 : 1) * koMul(R) * (r === 0 ? 1 : r === 1 ? .7 : .5);
      def.stun += Math.min(add, stunThr(def) * .24);
      // (PvP: a jab sets things up but can't be the shot that tips a fighter over: it stops just short of the threshold)
      if (p.type === 'jab' && def.stun >= stunThr(def)) def.stun = stunThr(def) - .5;
    } else if (!isHead(zone) && R.stam !== 'arcade') {
      def.stamina = Math.max(0, def.stamina - I * .55 * (zone === 'abdomen' ? STAM.bodyAbdomen : zone === 'ribs' ? STAM.bodyRibs : STAM.bodyTorso));
    }
    att.stats.landed++; if (hk || up) att.stats.power++;
  }
  def.health = Math.max(guard ? Math.min(1, def.health) : 0, def.health - dmg / toughness(R));
  att.stats.dmg += dmg;
  if (!guard) { att.roundDmg += dmg; att.roundLanded++; }
  // knockdowns (clean shots only): an empty health bar, a full stun meter (Classic), or now and then a flash knockdown
  if (!guard) {
    const fl = R.kd !== 'health' && zone === 'chin' && q > .85 && (hk || up);
    const pF = fl ? Math.min(.1, .03 * koMul(R) * (.35 + 1.3 * clamp(rockR(def, R), 0, 1)) * (counter ? 1.5 : 1) * (q > .95 ? 1.2 : 1) * (1 - .7 * p.tired)) : 0;
    const flash = fl && rand() < pF;
    def.kdHitI = I;
    kd = flash ? 'flash' : def.health <= 0 ? 'health' : R.kd !== 'health' && def.stun >= stunThr(def) ? 'stun' : null;
  }
  // why it went down, from what really happened (shown under KNOCKDOWN on both screens). Only the true cause is named
  let why = null;
  if (kd) {
    if (counter) why = cfrom === 'dodge' ? 'Counter off a dodge' : cfrom === 'parry' ? 'Counter off a block' : 'Clean counter';
    else if (now - def.gbAt < 2.5) why = 'Guard break';
    else if (comboN >= 3 && varied) why = comboN + '-punch combination';
    else if ((hk || up) && isHead(zone) && I >= 8) why = 'Heavy headshot';
    else why = kd === 'health' ? 'Accumulated damage (health empty)' : 'Accumulated damage';
    if (kd === 'flash') why = 'Flash knockdown: ' + why.toLowerCase();
  }
  return { res, type: p.type, zone, dmg, I, q, counter, cfrom, comboN, varied, glance, gb, kd, why, rep: Math.round(rep * 100) / 100 };
}

// how hard a knockdown is to get up from (the client's kdDifficulty, the same for both fighters)
function kdDifficulty(f, flash) {
  const dmg = 1 - clamp(f.health / Math.max(1, f.maxHealth), 0, 1), st = clamp(f.stamina / 100, 0, 1), sv = clamp(((f.kdHitI || 8) - 6) / 10, 0, 1);
  const D = .16 + .24 * dmg + .17 * (f.kd - 1) + .12 * (1 - st) + .12 * sv + (f.health <= 0 ? .1 : 0) + (flash ? .04 : 0);
  return clamp(D, .1, 1.25);
}
// a fighter getting up (the client's standUp)
function standUp(f, D) {
  f.down = false; f.rising = 1.35 + .9 * (D || .3); f.guard = 100; f.guardBreak = 0; f.guardHitT = -9;
  f.maxHealth = Math.max(40, f.maxHealth - 12); f.health = Math.max(f.health, f.maxHealth * .42); f.stun = 0;
  f.stamina = Math.max(f.stamina, 55); f.punches.clear(); f.chain.n = 0;
}
// a round's scorecards from three judges: damage and punches landed decide the round, a knockdown costs a point
function scoreRound(a, b, rand) {
  const sa0 = a.roundDmg + a.roundLanded * .6, sb0 = b.roundDmg + b.roundLanded * .6;
  return [0, 1, 2].map(() => { const na = sa0 * (.88 + .24 * rand()), nb = sb0 * (.88 + .24 * rand()); let sa = 10, sb = 10;
    if (Math.abs(na - nb) > .5) { if (na > nb) sb = 9; else sa = 9; }
    sa -= a.kdRound; sb -= b.kdRound; return [Math.max(7, sa), Math.max(7, sb)]; });
}
function decide(cards) {
  const tots = [0, 1, 2].map(j => cards.reduce((s, c) => [s[0] + c[j][0], s[1] + c[j][1]], [0, 0]));
  const aw = tots.filter(t => t[0] > t[1]).length, bw = tots.filter(t => t[1] > t[0]).length;
  let winner = -1, method;
  if (aw > bw) { winner = 0; method = bw === 0 ? (aw === 3 ? 'Unanimous decision' : 'Majority decision') : 'Split decision'; }
  else if (bw > aw) { winner = 1; method = aw === 0 ? (bw === 3 ? 'Unanimous decision' : 'Majority decision') : 'Split decision'; }
  else method = aw === 0 && bw === 0 ? 'Draw' : 'Split draw';
  return { winner, method, tots };
}

module.exports = { whiff, whiffTimeouts, rockLevel, ROCK_LV, PUNCH, PDMG, STAM, RULE_OPTS, DEFAULT_RULES, cleanRules, newFighter, tickFighter, startPunch, resolveHit, kdDifficulty, standUp, scoreRound, decide, tired, stunThr, rockR, toughness, clamp, isHead };
