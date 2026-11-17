// Burn: the rules. Relative motion math (the course model: RMOEs and the CW equations) and a
// pure, deterministic turn engine. Loaded by the game page and by the server, so the client's
// preview and the server's result come from the same code. No DOM, no Math.random, no clocks.
// Internal units: km, km/s, seconds, radians. Public angles are degrees. Burns enter in m/s.
(function (global) {
    'use strict';

    // Add 1 whenever a turn rule changes or any number in a scenario or in DUEL changes.
    const ENGINE_VERSION = 1;

    const MU = 398600.44;
    const RE = 6378.137;
    const G0 = 9.81;
    const GEO_A = 42164;
    const OMEGA_E = 7.292115e-5;
    const D2R = Math.PI / 180;
    const R2D = 180 / Math.PI;
    const TWO_PI = 2 * Math.PI;
    const TINY = 1e-9;
    const SUB_STEPS = 16;

    function meanMotion(a) { return Math.sqrt(MU / (a * a * a)); }
    function period(a) { return TWO_PI / meanMotion(a); }
    function wrap360(deg) {
        const w = deg % 360;
        return w < 0 ? w + 360 : (w >= 360 ? 0 : w);
    }

    /* ---------- RMOEs ---------- */
    function rmoeFromState(state, n) {
        const [x0, y0, z0, vx, vy, vz] = state;
        const xc = 4 * x0 + 2 * vy / n;
        const yc0 = y0 - 2 * vx / n;
        const C = Math.hypot(xc - x0, vx / n);
        const zmax = Math.hypot(z0, vz / n);
        return {
            xc, yc0, C, zmax,
            M0: C < TINY ? null : wrap360(Math.atan2(vx / n, xc - x0) * R2D),
            dM0: zmax < TINY ? null : wrap360(Math.atan2(z0, vz / n) * R2D)
        };
    }

    function stateFromRmoe(rmoe, n, t) {
        t = t || 0;
        const M = n * t + (rmoe.M0 === null || rmoe.M0 === undefined ? 0 : rmoe.M0) * D2R;
        const dM = n * t + (rmoe.dM0 === null || rmoe.dM0 === undefined ? 0 : rmoe.dM0) * D2R;
        const ycDot = -1.5 * n * rmoe.xc;
        return [
            rmoe.xc - rmoe.C * Math.cos(M),
            rmoe.yc0 + ycDot * t + 2 * rmoe.C * Math.sin(M),
            rmoe.zmax * Math.sin(dM),
            n * rmoe.C * Math.sin(M),
            ycDot + 2 * n * rmoe.C * Math.cos(M),
            n * rmoe.zmax * Math.cos(dM)
        ];
    }

    function driftRate(rmoe, n, aTarget) {
        return {
            kmPerSec: -1.5 * n * rmoe.xc,
            kmPerRev: -3 * Math.PI * rmoe.xc,
            degPerRev: -(540 / aTarget) * rmoe.xc
        };
    }

    // M at the positive plane crossing, in degrees, or null when either angle is undefined.
    function planeCrossingM(rmoe) {
        if (rmoe.M0 === null || rmoe.dM0 === null) return null;
        return wrap360(rmoe.M0 - rmoe.dM0);
    }

    function timeToAngle(nowDeg, targetDeg, n) {
        return wrap360(targetDeg - nowDeg) / 360 * (TWO_PI / n);
    }

    /* ---------- CW propagation ---------- */
    function cwPropagate(state, n, t) {
        const [x0, y0, z0, vx, vy, vz] = state;
        const c = Math.cos(n * t), s = Math.sin(n * t);
        return [
            4 * x0 + 2 * vy / n - (3 * x0 + 2 * vy / n) * c + (vx / n) * s,
            y0 - 2 * vx / n - (3 * vy + 6 * n * x0) * t + (2 * vx / n) * c + (4 * vy / n + 6 * x0) * s,
            z0 * c + (vz / n) * s,
            (3 * n * x0 + 2 * vy) * s + vx * c,
            -(3 * vy + 6 * n * x0) - 2 * vx * s + (4 * vy + 6 * n * x0) * c,
            -n * z0 * s + vz * c
        ];
    }

    function applyBurn(state, dv) {
        return [state[0], state[1], state[2], state[3] + dv[0], state[4] + dv[1], state[5] + dv[2]];
    }

    // Least range to the origin over a coast of `revs` revs with no burns.
    function minRange(state, n, revs, samplesPerRev) {
        const count = Math.max(2, Math.round(revs * (samplesPerRev || 64)) + 1);
        const tEnd = revs * TWO_PI / n;
        let least = Infinity;
        for (let k = 0; k < count; k++) {
            const s = cwPropagate(state, n, tEnd * k / (count - 1));
            least = Math.min(least, Math.hypot(s[0], s[1], s[2]));
        }
        return least;
    }

    function sampleCoast(state, n, t0, t1, count) {
        const out = new Float64Array(count * 3);
        for (let k = 0; k < count; k++) {
            const t = count > 1 ? t0 + (t1 - t0) * k / (count - 1) : t0;
            const s = cwPropagate(state, n, t);
            out[3 * k] = s[0]; out[3 * k + 1] = s[1]; out[3 * k + 2] = s[2];
        }
        return out;
    }

    /* ---------- Rules of thumb (km/s) ---------- */
    const rule = {
        recenter: (n, dyc) => -(n / 2) * dyc,
        resize: (n, dC, xdotSign) => (xdotSign < 0 ? -1 : 1) * n * dC,
        raise: (n, dxc) => (n / 2) * dxc,
        driftOverRevs: (n, dyc, k) => -(n / (6 * Math.PI)) * (dyc / k),
        crossTrack: (n, dzmax, zdotSign) => (zdotSign < 0 ? -1 : 1) * n * dzmax
    };

    const MOTIONS = {
        '000': ['perch', 'Perch'],
        '100': ['linear-drift', 'Linear drift'],
        '010': ['stationary-nmc', 'Stationary NMC'],
        '110': ['drifting-nmc', 'Drifting NMC'],
        '001': ['cross-track', 'Cross-track motion'],
        '101': ['drifting-cross-track', 'Drifting cross-track motion'],
        '011': ['nmc-cross-track', 'NMC with cross-track motion'],
        '111': ['corkscrew', 'Corkscrew']
    };
    function classifyMotion(rmoe) {
        const eps = Math.max(0.01, 0.002 * Math.max(Math.abs(rmoe.xc), rmoe.C, rmoe.zmax, 1));
        const code = (Math.abs(rmoe.xc) > eps ? '1' : '0') + (rmoe.C > eps ? '1' : '0') + (rmoe.zmax > eps ? '1' : '0');
        const [key, label] = MOTIONS[code];
        if (key === 'perch' && Math.abs(rmoe.yc0) <= eps) return { key, label: 'At the target' };
        return { key, label };
    }

    function propellant(massKg, isp, dvMs) {
        return massKg * (1 - Math.exp(-dvMs / (isp * G0)));
    }

    const minus = text => text.replace(/^-/, '−');
    const fmt = {
        km(v) {
            if (v === null || v === undefined) return 'undefined';
            const a = Math.abs(v);
            return minus(v.toFixed(a < 100 ? 3 : a < 1000 ? 2 : 1));
        },
        ms(vKmPerSec) {
            if (vKmPerSec === null || vKmPerSec === undefined) return 'undefined';
            const v = vKmPerSec * 1000;
            return minus(v.toFixed(Math.abs(v) < 10 ? 4 : 3));
        },
        deg(v) { return v === null || v === undefined ? 'undefined' : minus(v.toFixed(1)); },
        signed(v, digits) {
            if (v === null || v === undefined) return 'undefined';
            const text = Math.abs(v).toFixed(digits);
            return (Number(text) === 0 ? '' : v < 0 ? '−' : '+') + text;
        }
    };

    /* ---------- The turn engine ---------- */
    const clone = value => JSON.parse(JSON.stringify(value));
    const round4 = v => Math.round(v * 1e4) / 1e4;

    function startState(scenario, n, role) {
        const start = scenario.start && !Array.isArray(scenario.start) && role && scenario.start[role] ? scenario.start[role] : scenario.start;
        if (Array.isArray(start)) return start.slice();
        return stateFromRmoe({ xc: 0, yc0: 0, C: 0, M0: null, zmax: 0, dM0: null, ...start }, n, 0);
    }

    function createMatch(scenario, players) {
        if (scenario.id === 'duel') throw new Error('Duel matches arrive in stage G6.');
        const n = meanMotion(scenario.a);
        const turnSeconds = (scenario.turnFraction || 0.125) * TWO_PI / n;
        return {
            scenarioId: scenario.id,
            a: scenario.a,
            n,
            turnSeconds,
            turn: 0,
            maxTurns: scenario.maxTurns,
            status: 'running',
            craft: players.map(p => ({
                id: p.id, role: p.role,
                state: startState(scenario, n, p.role),
                dvLeft: scenario.dvBudget, dvUsed: 0, hold: 0, alive: true
            })),
            log: []
        };
    }

    // ok is true for a legal burn. dvMs: [R, I, C] in m/s.
    function legalBurn(match, craftId, dvMs, scenario) {
        const craft = match.craft.find(c => c.id === craftId);
        if (!craft) return { ok: false, reason: 'unknown-craft' };
        if (!Array.isArray(dvMs) || dvMs.length !== 3 || !dvMs.every(Number.isFinite)) return { ok: false, reason: 'not-finite' };
        const size = Math.hypot(dvMs[0], dvMs[1], dvMs[2]);
        const sc = scenario || scenarioOf(match);
        if (sc && size > sc.maxBurnPerTurn + 1e-9) return { ok: false, reason: 'too-large' };
        if (size > craft.dvLeft + 1e-9) return { ok: false, reason: 'over-budget' };
        return { ok: true, reason: null, size };
    }

    // The scenarios are looked up by id, so a match stays plain JSON.
    function scenarioOf(match) {
        const S = global.BurnScenarios;
        return S && S.byId ? S.byId(match.scenarioId) : null;
    }

    // The goal test at a turn end, on the RMOEs then.
    function goalMet(goal, r) {
        if (goal.perch) {
            return Math.abs(r.xc) <= 0.05 && r.C <= 0.2 && r.zmax <= 0.2 && r.yc0 >= goal.perch.yMin && r.yc0 <= goal.perch.yMax;
        }
        const tol = goal.tol || {};
        for (const key of ['xc', 'yc0', 'C', 'zmax']) {
            if (goal[key] === undefined) continue;
            if (Math.abs(r[key] - goal[key]) > (tol[key] === undefined ? 0 : tol[key]) + 1e-12) return false;
        }
        if (goal.planeCrossing) {
            const m = planeCrossingM(r);
            if (m === null) return false;
            const near = goal.planeCrossing.some(a => { const d = Math.abs(wrap360(m - a)); return Math.min(d, 360 - d) <= 15; });
            if (!near) return false;
        }
        return true;
    }

    function applyTurn(matchIn, burnsByCraftId, scenarioIn) {
        const scenario = scenarioIn || scenarioOf(matchIn);
        if (!scenario) throw new Error('Unknown scenario: ' + matchIn.scenarioId);
        const match = clone(matchIn);
        const events = [];
        const paths = {};
        if (match.status !== 'running') return { match, events, paths };
        const n = match.n, T = match.turnSeconds;
        const burns = burnsByCraftId || {};
        const keepOut = scenario.keepOutKm === undefined ? 0.3 : scenario.keepOutKm;

        for (const craft of match.craft) {
            if (!craft.alive) continue;
            // 1. Validate the burn; 2. spend it.
            const dvMs = burns[craft.id];
            let dv = [0, 0, 0];
            if (dvMs !== undefined && dvMs !== null) {
                const check = legalBurn(match, craft.id, dvMs, scenario);
                if (!check.ok) events.push({ type: 'illegal-burn', craftId: craft.id, turn: match.turn, reason: check.reason });
                else if (check.size > 0) {
                    dv = dvMs.slice();
                    craft.dvLeft = Math.max(0, craft.dvLeft - check.size);
                    craft.dvUsed += check.size;
                    craft.state = applyBurn(craft.state, dv.map(v => v / 1000));
                    match.log.push({ turn: match.turn, craftId: craft.id, dv });
                    events.push({ type: 'burn', craftId: craft.id, turn: match.turn, dv });
                    if (craft.dvLeft <= 1e-9) events.push({ type: 'out-of-fuel', craftId: craft.id, turn: match.turn });
                }
            }
            // 3. Sample the coast for the trail and the keep-out check.
            const pts = [];
            let least = Infinity;
            for (let k = 0; k <= SUB_STEPS; k++) {
                const s = cwPropagate(craft.state, n, T * k / SUB_STEPS);
                pts.push([s[0], s[1], s[2]]);
                least = Math.min(least, Math.hypot(s[0], s[1], s[2]));
            }
            paths[craft.id] = pts;
            // 4. The state at the end of the turn.
            craft.state = cwPropagate(craft.state, n, T);
            if (least < keepOut) {
                craft.alive = false;
                match.status = 'lost';
                events.push({ type: 'keep-out', craftId: craft.id, turn: match.turn, rangeKm: least });
                continue;
            }
            // 5. The goal, held for holdTurns consecutive turn ends.
            const r = rmoeFromState(craft.state, n);
            if (goalMet(scenario.goal, r)) {
                craft.hold += 1;
                events.push({ type: 'goal-progress', craftId: craft.id, turn: match.turn, hold: craft.hold, of: scenario.goal.holdTurns });
                if (craft.hold >= scenario.goal.holdTurns) {
                    match.status = 'won';
                    events.push({ type: 'goal-met', craftId: craft.id, turn: match.turn });
                }
            } else craft.hold = 0;
            // 6. A coast with no more burns must stay clear of the target.
            if (match.status === 'running' && scenario.coastSafeKm) {
                const rng = minRange(craft.state, n, scenario.coastSafeRevs || 3, 64);
                if (rng < scenario.coastSafeKm) {
                    craft.alive = false;
                    match.status = 'lost';
                    events.push({ type: 'unsafe-coast', craftId: craft.id, turn: match.turn, rangeKm: rng });
                }
            }
        }
        match.turn += 1;
        // 7. Out of turns.
        if (match.status === 'running' && match.turn >= match.maxTurns) {
            match.status = 'timeout';
            events.push({ type: 'timeout', turn: match.turn });
        }
        return { match, events, paths };
    }

    function coastMinRange(match, craftId, revs) {
        const craft = match.craft.find(c => c.id === craftId);
        return craft ? minRange(craft.state, match.n, revs, 64) : null;
    }

    // Results, best first: success, then least dvUsed (to 1e-4 m/s), then fewest turns.
    function score(match) {
        return match.craft.map(c => ({
            id: c.id, role: c.role,
            success: match.status === 'won' && c.alive && c.hold > 0,
            dvUsed: round4(c.dvUsed), turns: match.turn, status: match.status
        })).sort((a, b) => (b.success - a.success) || (a.dvUsed - b.dvUsed) || (a.turns - b.turns));
    }

    // Play a burn log from turn 0. burnLog: [{ turn, craftId, dv }] (or { turn, dv } with one craft).
    function replay(scenario, players, burnLog, untilTurn) {
        let match = createMatch(scenario, players);
        const byTurn = new Map();
        (burnLog || []).forEach(entry => {
            const id = entry.craftId === undefined ? players[0].id : entry.craftId;
            if (!byTurn.has(entry.turn)) byTurn.set(entry.turn, {});
            byTurn.get(entry.turn)[id] = entry.dv;
        });
        while (match.status === 'running' && (untilTurn === undefined || match.turn < untilTurn)) {
            match = applyTurn(match, byTurn.get(match.turn) || {}, scenario).match;
        }
        return match;
    }

    global.BurnCore = {
        ENGINE_VERSION, MU, RE, G0, GEO_A, OMEGA_E, D2R, R2D, SUB_STEPS,
        meanMotion, period, wrap360,
        rmoeFromState, stateFromRmoe, driftRate, planeCrossingM, timeToAngle,
        cwPropagate, applyBurn, minRange, sampleCoast, rule,
        classifyMotion, propellant, fmt,
        createMatch, legalBurn, applyTurn, coastMinRange, score, replay, goalMet
    };
})(typeof window !== 'undefined' ? window : globalThis);
if (typeof module !== 'undefined') module.exports = globalThis.BurnCore;
