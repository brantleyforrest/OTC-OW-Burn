// Run with: node _server/test/core.test.js   (no packages needed)
// Checks burn/burn-core.js and burn/burn-scenarios.js: the verified vectors, the round trips,
// the turn engine's rules, and every scenario's reference solution.
'use strict';
const assert = require('node:assert');
const path = require('node:path');
const D = require(path.join(__dirname, '..', '..', 'burn', 'burn-core.js'));
const S = require(path.join(__dirname, '..', '..', 'burn', 'burn-scenarios.js'));

let passed = 0;
let failed = 0;
function check(name, fn) {
    try { fn(); passed++; console.log('ok    ' + name); }
    catch (err) { failed++; console.log('FAIL  ' + name + '\n      ' + err.message); }
}
function near(got, want, tol, what) {
    assert.ok(Math.abs(got - want) <= tol, `${what || 'value'}: got ${got}, want ${want} (tolerance ${tol})`);
}
// 1e-3 relative, with a small absolute floor for values that are zero.
function rel(got, want, what) { near(got, want, Math.max(1e-3 * Math.abs(want), 1e-4), what); }
function angle(got, want, what) {
    if (want === null) { assert.strictEqual(got, null, `${what}: want undefined, got ${got}`); return; }
    assert.notStrictEqual(got, null, `${what}: got undefined`);
    const d = Math.abs(D.wrap360(got - want));
    near(Math.min(d, 360 - d), 0, 0.1, what);
}
// A small fixed-seed generator, so that a failure repeats.
let seed = 20261117;
function rnd(lo, hi) {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return lo + (hi - lo) * seed / 4294967296;
}
const kms = v => v.map(x => x / 1000);
const GEO_N = D.meanMotion(42164);

/* ---------- 5.11 and 5.12 ---------- */
check('reference numbers at GEO', () => {
    near(GEO_N, 7.29216e-5, 1e-9, 'n');
    near(D.period(42164), 86163.6, 0.1, 'P');
    near(D.period(42164) / 8, 10770.45, 0.02, 'one turn');
    near(GEO_N * 1000, 0.0729216, 1e-6, 'n x 1 km in m/s');
});

check('state to RMOEs at GEO (four vectors)', () => {
    const rows = [
        [[2, 6, -2], [0.145843, -0.218765, 0], 2, 2, 2, 90, 2, 270, -18.850],
        [[-2, -1, 0], [0, 0.291686, -0.145843], 0, -1, 2, 0, 2, 180, 0],
        [[0, 7, 0], [0, 0.036460, 0], 1, 7, 1, 0, 0, null, -9.425],
        [[-2, -11, 0], [-0.2917, 0.2188, -0.3646], -1.999, -3, 4, 270, 5, 180, 18.84]
    ];
    rows.forEach(([r, v, xc, yc0, C, M0, zmax, dM0, drift], k) => {
        const e = D.rmoeFromState(r.concat(kms(v)), GEO_N);
        rel(e.xc, xc, `row ${k} xc`); rel(e.yc0, yc0, `row ${k} yc0`); rel(e.C, C, `row ${k} C`);
        angle(e.M0, M0, `row ${k} M0`); rel(e.zmax, zmax, `row ${k} zmax`); angle(e.dM0, dM0, `row ${k} dM0`);
        // The givens are rounded to 6 decimals, which moves x_C by about 1e-5 km and the drift by 3 pi times that.
        near(D.driftRate(e, GEO_N, 42164).kmPerRev, drift, Math.max(1e-3 * Math.abs(drift), 1e-3), `row ${k} drift`);
    });
});

check('RMOEs to state at GEO, now and later', () => {
    const e = { xc: -2, yc0: 0, C: 18, M0: 0, zmax: 10, dM0: 0 };
    const P = D.period(42164);
    const s0 = D.stateFromRmoe(e, GEO_N, 0);
    [-20, 0, 0].forEach((v, k) => rel(s0[k], v, 'rho0[' + k + ']'));
    [0, 2.843942, 0.729216].forEach((v, k) => rel(s0[3 + k] * 1000, v, 'rhodot0[' + k + ']'));
    const q = D.stateFromRmoe(e, GEO_N, P / 4);
    [-2, 40.7124, 10].forEach((v, k) => rel(q[k], v, 'quarter rho[' + k + ']'));
    [1.3126, 0.2188, 0].forEach((v, k) => rel(q[3 + k] * 1000, v, 'quarter rhodot[' + k + ']'));
    const h = D.stateFromRmoe(e, GEO_N, P / 2);
    [16, 9.4248, 0].forEach((v, k) => rel(h[k], v, 'half rho[' + k + ']'));
    const o = D.stateFromRmoe(e, GEO_N, P);
    [-20, 18.8496, 0].forEach((v, k) => rel(o[k], v, 'one rev rho[' + k + ']'));
});

check('basic burns from rest at a = 7000 km', () => {
    const n = D.meanMotion(7000);
    near(n, 1.07801e-3, 1e-8, 'n');
    const P = 2 * Math.PI / n;
    const table = {
        R: [[0.05, 0.29, -0.09], [0.25, 0.93, -1.86], [0.5, 0, -3.71], [1, 0, 0]],
        I: [[0.05, 0.09, 0.27], [0.25, 1.86, -0.66], [0.5, 3.71, -8.74], [1, 0, -17.49]]
    };
    for (const [dir, rows] of Object.entries(table)) {
        const dv = dir === 'R' ? [0.001, 0, 0] : [0, 0.001, 0];
        const s0 = D.applyBurn([0, 0, 0, 0, 0, 0], dv);
        rows.forEach(([f, x, y]) => {
            const s = D.cwPropagate(s0, n, f * P);
            near(s[0], x, 0.01, `+${dir} x at ${f} rev`);
            near(s[1], y, 0.01, `+${dir} y at ${f} rev`);
        });
        const e = D.rmoeFromState(s0, n);
        if (dir === 'R') { near(e.xc, 0, 1e-9, 'xc'); rel(e.yc0, -1.855, 'yc0'); rel(e.C, 0.928, 'C'); angle(e.M0, 90, 'M0'); }
        else { rel(e.xc, 1.855, 'xc'); near(e.yc0, 0, 1e-9, 'yc0'); rel(e.C, 1.855, 'C'); angle(e.M0, 0, 'M0'); }
        // The mirror image: -R and -I give the negated path.
        const m = D.cwPropagate(D.applyBurn([0, 0, 0, 0, 0, 0], dv.map(v => -v)), n, P / 4);
        const p = D.cwPropagate(s0, n, P / 4);
        near(m[0], -p[0], 1e-9, 'mirror x'); near(m[1], -p[1], 1e-9, 'mirror y');
    }
});

check('other checks at GEO: perch move, propellant, NMC entry', () => {
    const dv = Math.abs(D.rule.driftOverRevs(GEO_N, 20, 2)) * 1000;
    near(dv, 0.038686, 2e-6, 'perch move burn');
    near(D.propellant(609, 240, 2 * dv) * 1000, 20.0, 0.05, 'propellant in g');
    near(Math.abs(D.rule.recenter(GEO_N, 10)) * 1000, 0.3646, 1e-4, 'NMC entry');
    near(D.rule.raise(GEO_N, 2) * 1000, 0.0729216, 1e-6, 'raise 2 km');
    near(D.rule.resize(GEO_N, 3, -1) * 1000, -0.218765, 1e-5, 'resize');
    near(D.rule.crossTrack(GEO_N, 5, 1) * 1000, 0.364608, 1e-5, 'cross-track');
});

/* ---------- Round trips ---------- */
check('state -> RMOEs -> state for 500 generated states (1e-9)', () => {
    for (let k = 0; k < 500; k++) {
        const a = [42164, 26562, 7000][k % 3];
        const n = D.meanMotion(a);
        const s = [rnd(-50, 50), rnd(-200, 200), rnd(-30, 30), rnd(-3e-3, 3e-3), rnd(-3e-3, 3e-3), rnd(-3e-3, 3e-3)];
        const back = D.stateFromRmoe(D.rmoeFromState(s, n), n, 0);
        for (let j = 0; j < 3; j++) near(back[j], s[j], 1e-9, 'position ' + j);
        for (let j = 3; j < 6; j++) near(back[j], s[j], 1e-12, 'velocity ' + j);
    }
});

check('cwPropagate agrees with stateFromRmoe at generated times (1e-9 km)', () => {
    for (let k = 0; k < 300; k++) {
        const n = D.meanMotion([42164, 7000][k % 2]);
        const s = [rnd(-20, 20), rnd(-100, 100), rnd(-10, 10), rnd(-1e-3, 1e-3), rnd(-1e-3, 1e-3), rnd(-1e-3, 1e-3)];
        const t = rnd(0, 5) * 2 * Math.PI / n;
        const a = D.cwPropagate(s, n, t);
        const b = D.stateFromRmoe(D.rmoeFromState(s, n), n, t);
        for (let j = 0; j < 3; j++) near(a[j], b[j], 1e-9 * Math.max(1, Math.abs(a[j])), 'position ' + j);
    }
});

check('classifyMotion, fmt, and undefined angles', () => {
    assert.strictEqual(D.classifyMotion({ xc: 0, yc0: 0, C: 0, zmax: 0 }).label, 'At the target');
    assert.strictEqual(D.classifyMotion({ xc: 2, yc0: 0, C: 6, zmax: 0 }).key, 'drifting-nmc');
    assert.strictEqual(D.classifyMotion({ xc: -1.5, yc0: -40, C: 5, zmax: 5 }).key, 'corkscrew');
    assert.strictEqual(D.fmt.km(12.3456), '12.346');
    assert.strictEqual(D.fmt.km(-512.345), '−512.35');
    assert.strictEqual(D.fmt.km(2000.06), '2000.1');
    assert.strictEqual(D.fmt.ms(0.0000364608), '0.0365');
    assert.strictEqual(D.fmt.ms(0.0123), '12.300');
    assert.strictEqual(D.fmt.deg(null), 'undefined');
    assert.strictEqual(D.fmt.signed(-0.25, 2), '−0.25');
    const e = D.rmoeFromState([0, 5, 0, 0, 0, 0], GEO_N);
    assert.strictEqual(e.M0, null); assert.strictEqual(e.dM0, null);
    assert.strictEqual(D.planeCrossingM(e), null);
});

/* ---------- The turn engine ---------- */
const solo = [{ id: 'you', role: 'chase' }];
function play(scenario, burns) {
    let match = D.createMatch(scenario, solo);
    const byTurn = new Map(burns.map(b => [b.turn, b.dv]));
    const events = [];
    while (match.status === 'running') {
        const dv = byTurn.get(match.turn);
        const out = D.applyTurn(match, dv ? { you: dv } : {}, scenario);
        events.push(...out.events);
        match = out.match;
    }
    return { match, events };
}

check('applyTurn does not mutate its input, and returns 17 path points', () => {
    const sc = S.byId('enter-nmc');
    const m0 = D.createMatch(sc, solo);
    const before = JSON.stringify(m0);
    const out = D.applyTurn(m0, { you: [-0.36461, 0, 0] }, sc);
    assert.strictEqual(JSON.stringify(m0), before, 'input unchanged');
    assert.strictEqual(out.paths.you.length, D.SUB_STEPS + 1, '17 points');
    assert.strictEqual(out.match.turn, 1);
    assert.ok(out.events.some(e => e.type === 'burn'), 'burn event');
});

check('the same burn log gives deeply equal matches, and replay reproduces a played match', () => {
    const sc = S.byId('full-plan');
    const a = play(sc, sc.reference).match;
    const b = play(sc, sc.reference).match;
    assert.deepStrictEqual(a, b);
    const r = D.replay(sc, solo, a.log);
    assert.deepStrictEqual(r, a);
    const partial = D.replay(sc, solo, a.log, 10);
    assert.strictEqual(partial.turn, 10);
    assert.strictEqual(partial.status, 'running');
});

for (const sc of S.list) {
    check(`reference solution: ${sc.id} wins at turn ${sc.winTurn} with ${sc.parDv} m/s`, () => {
        const { match, events } = play(sc, sc.reference);
        assert.strictEqual(match.status, 'won', 'status ' + match.status + ' events ' + JSON.stringify(events.filter(e => e.type !== 'goal-progress' && e.type !== 'burn')));
        assert.strictEqual(match.turn, sc.winTurn, 'turn');
        near(match.craft[0].dvUsed, sc.parDv, 1e-3, 'dvUsed');
        const res = D.score(match)[0];
        assert.ok(res.success, 'score says success');
    });
}

check('stop-drift: one burn of the whole 0.0729 m/s does not win', () => {
    const sc = S.byId('stop-drift');
    const { match } = play(sc, [{ turn: 0, dv: [0, -0.0729216, 0] }]);
    assert.notStrictEqual(match.status, 'won');
    const e = D.rmoeFromState(match.craft[0].state, match.n);
    near(e.C, 2, 0.01, 'leaves an NMC with C = 2');
});

check('safe-approach: the reference stays at least 0.440 km away; unsafe variants are lost', () => {
    const sc = S.byId('safe-approach');
    let match = D.createMatch(sc, solo);
    let least = Infinity;
    const byTurn = new Map(sc.reference.map(b => [b.turn, b.dv]));
    while (match.status === 'running') {
        least = Math.min(least, D.coastMinRange(match, 'you', 3));
        match = D.applyTurn(match, byTurn.has(match.turn) ? { you: byTurn.get(match.turn) } : {}, sc).match;
    }
    // The guide gives 0.440 km; the reference burns are rounded to 5 decimals, which gives 0.439 km.
    assert.ok(least >= 0.438, 'least coast range ' + least);
    // Starting the drift with no cross-track motion.
    const noSwing = play(sc, [{ turn: 2, dv: [0, -0.01547, 0] }]);
    assert.strictEqual(noSwing.match.status, 'lost');
    assert.ok(noSwing.events.some(e => e.type === 'unsafe-coast'), 'unsafe-coast event');
    // Adding the swing in the same turn as the drift burn.
    const sameTurn = play(sc, [{ turn: 0, dv: [0, -0.01547, 0.14584] }]);
    assert.strictEqual(sameTurn.match.status, 'lost');
    assert.ok(sameTurn.events.some(e => e.type === 'unsafe-coast'), 'unsafe-coast event (same turn)');
});

check('illegal burns are reported and flown as coasts', () => {
    const sc = S.byId('enter-nmc');
    const m0 = D.createMatch(sc, solo);
    const coast = D.applyTurn(m0, {}, sc).match;
    for (const [dv, reason] of [[[2, 0, 0], 'too-large'], [[NaN, 0, 0], 'not-finite'], [[0, Infinity, 0], 'not-finite'], [[0.7, 0, 0], 'over-budget'], ['x', 'not-finite']]) {
        const sc2 = reason === 'over-budget' ? { ...sc, maxBurnPerTurn: 1 } : sc;
        const out = D.applyTurn(m0, { you: dv }, sc2);
        const ev = out.events.find(e => e.type === 'illegal-burn');
        assert.ok(ev, 'illegal-burn for ' + JSON.stringify(dv));
        assert.strictEqual(ev.reason, reason);
        assert.deepStrictEqual(out.match.craft[0].state, coast.craft[0].state, 'flown as a coast');
        assert.strictEqual(out.match.craft[0].dvUsed, 0);
    }
});

check('keep-out: flying into the target is lost', () => {
    const sc = S.byId('enter-nmc');
    // A target-centered NMC with C = 0.1 km passes within 0.3 km of the target.
    let match = D.createMatch(sc, solo);
    match = { ...match, craft: [{ ...match.craft[0], state: D.stateFromRmoe({ xc: 0, yc0: 0, C: 0.1, M0: 0, zmax: 0, dM0: null }, match.n, 0) }] };
    const out = D.applyTurn(match, {}, sc);
    assert.strictEqual(out.match.status, 'lost');
    assert.ok(out.events.some(e => e.type === 'keep-out'));
});

check('timeout after the last turn with no win', () => {
    const sc = S.byId('move-perch');
    const { match, events } = play(sc, []);
    assert.strictEqual(match.status, 'timeout');
    assert.strictEqual(match.turn, sc.maxTurns);
    assert.ok(events.some(e => e.type === 'timeout'));
});

check('scenarios: ids unique, briefs and hints present, version is a whole number', () => {
    const ids = S.list.map(s => s.id);
    assert.strictEqual(new Set(ids).size, ids.length);
    assert.strictEqual(ids.length, 8);
    S.list.forEach(s => { assert.ok(s.brief && s.hint && s.dragScale > 0 && s.parDv > 0, s.id); });
    assert.ok(Number.isInteger(D.ENGINE_VERSION) && D.ENGINE_VERSION >= 1);
    assert.strictEqual(S.byId('duel').id, 'duel');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
