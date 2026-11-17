// Burn: the scenarios. Plain data, loaded by the game page and by the server. Changing any
// number here means adding 1 to BurnCore.ENGINE_VERSION.
// start: RMOEs (missing ones are zero, angles in degrees) or a state [x, y, z, vx, vy, vz] in km
// and km/s. Goal tolerances are in km. Burns in `reference` are [R, I, C] in m/s, made at the start
// of the given turn; the engine test replays each one and checks the turn it wins and its ΔV.
(function (global) {
    'use strict';

    const GEO = 42164;
    const base = { a: GEO, turnFraction: 0.125, maxBurnPerTurn: 1, keepOutKm: 0.3 };

    const list = [
        { ...base, id: 'stop-drift', title: 'Stop the Drift',
          brief: 'Chase is in a linear drift 2 km above the target, sliding backward from 40 km ahead. Stop it at a perch between 10 and 38 km ahead of the target.',
          hint: 'Stopping a linear drift takes two equal in-track burns half a rev apart. One burn of the whole amount leaves an NMC.',
          start: { xc: 2, yc0: 40 }, maxTurns: 24, dvBudget: 0.25,
          goal: { perch: { yMin: 10, yMax: 38 }, holdTurns: 4 },
          reference: [{ turn: 0, dv: [0, -0.03646, 0] }, { turn: 4, dv: [0, -0.03646, 0] }], winTurn: 8, parDv: 0.0729, dragScale: 0.1 },

        { ...base, id: 'move-perch', title: 'Move the Perch',
          brief: 'Chase is perched 40 km behind the target. Move it to a perch about 20 km behind, between 21 and 19 km.',
          hint: 'An in-track burn starts a drift that covers a set distance in a whole number of revs; the opposite burn that many revs later stops it.',
          start: { yc0: -40 }, maxTurns: 28, dvBudget: 0.25,
          goal: { perch: { yMin: -21, yMax: -19 }, holdTurns: 4 },
          reference: [{ turn: 0, dv: [0, -0.03869, 0] }, { turn: 16, dv: [0, 0.03869, 0] }], winTurn: 20, parDv: 0.0774, dragScale: 0.1 },

        { ...base, id: 'enter-nmc', title: 'Enter an NMC',
          brief: 'Chase is perched 10 km behind the target. Put it on a natural motion circumnavigation (NMC) centered on the target, with C = 5 km.',
          hint: 'One radial burn from a perch moves the NMC center to the target; the perch distance sets the size.',
          start: { yc0: -10 }, maxTurns: 16, dvBudget: 0.6,
          goal: { xc: 0, yc0: 0, C: 5, tol: { xc: 0.05, yc0: 0.5, C: 0.5 }, holdTurns: 8 },
          reference: [{ turn: 0, dv: [-0.36461, 0, 0] }], winTurn: 8, parDv: 0.3646, dragScale: 1.0 },

        { ...base, id: 'resize', title: 'Shrink the NMC',
          brief: 'Chase flies a target-centered NMC with C = 10 km, starting at the bottom. Shrink it to C = 4 km and keep it centered on the target.',
          hint: 'Change C with radial burns where chase crosses the center’s height (the front and back), split into two burns half a rev apart so the center stays put.',
          start: { C: 10, M0: 0 }, maxTurns: 24, dvBudget: 0.8,
          goal: { xc: 0, yc0: 0, C: 4, tol: { xc: 0.05, yc0: 0.5, C: 0.4 }, holdTurns: 8 },
          reference: [{ turn: 2, dv: [-0.21876, 0, 0] }, { turn: 6, dv: [0.21876, 0, 0] }], winTurn: 14, parDv: 0.4375, dragScale: 0.6 },

        { ...base, id: 'cross-track', title: 'Add Cross-Track Motion',
          brief: 'Chase flies a target-centered NMC with C = 5 km. Add a 5 km cross-track swing, with chase crossing the target’s orbit plane at the top or the bottom of the NMC.',
          hint: 'A cross-track burn made at z = 0 sets z_max, and the place where it is made becomes a plane crossing.',
          start: { C: 5, M0: 45 }, maxTurns: 24, dvBudget: 0.6,
          goal: { xc: 0, C: 5, zmax: 5, planeCrossing: [0, 180], tol: { xc: 0.05, C: 0.5, zmax: 0.5 }, holdTurns: 8 },
          reference: [{ turn: 3, dv: [0, 0, 0.36461] }], winTurn: 11, parDv: 0.3646, dragScale: 1.0 },

        { ...base, id: 'full-plan', title: 'The Full Plan',
          brief: 'Chase is perched 30 km behind the target. Close in, then fly a target-centered NMC with C = 3 km and a 3 km cross-track swing.',
          hint: 'Drift to a perch 2C behind, then one combined burn there: radial to enter the NMC, in-track to stop the drift, and cross-track to add the swing.',
          start: { yc0: -30 }, maxTurns: 40, dvBudget: 0.8,
          goal: { xc: 0, yc0: 0, C: 3, zmax: 3, tol: { xc: 0.05, yc0: 0.5, C: 0.3, zmax: 0.3 }, holdTurns: 8 },
          reference: [{ turn: 0, dv: [0, -0.04642, 0] }, { turn: 16, dv: [-0.21876, 0.04642, 0.21876] }], winTurn: 24, parDv: 0.3593, dragScale: 0.6 },

        { ...base, id: 'long-approach', title: 'The Long Approach',
          brief: 'Chase is perched 300 km ahead of the target. Bring it to a perch between 5 and 15 km ahead.',
          hint: 'Choose how many revs the trip takes: fewer revs cost more ΔV. Start the drift, then stop it the same number of revs later.',
          start: { yc0: 300 }, maxTurns: 80, dvBudget: 0.45,
          goal: { perch: { yMin: 5, yMax: 15 }, holdTurns: 4 },
          reference: [{ turn: 0, dv: [0, 0.16027, 0] }, { turn: 56, dv: [0, -0.16027, 0] }], winTurn: 60, parDv: 0.3205, dragScale: 0.5 },

        { ...base, id: 'safe-approach', title: 'The Safe Approach',
          brief: 'Chase is perched 16 km behind the target. Fly a target-centered NMC with C = 2 km and a 2 km cross-track swing, and never let a coast with no more burns pass within 0.3 km of the target.',
          hint: 'Add the cross-track swing first, wait a quarter rev so chase is farthest to the side when it crosses the target’s height, then start the drift.',
          start: { yc0: -16 }, maxTurns: 48, dvBudget: 0.5, coastSafeKm: 0.3, coastSafeRevs: 3,
          goal: { xc: 0, yc0: 0, C: 2, zmax: 2, tol: { xc: 0.05, yc0: 0.5, C: 0.2, zmax: 0.2 }, holdTurns: 8 },
          reference: [{ turn: 0, dv: [0, 0, 0.14584] }, { turn: 2, dv: [0, -0.01547, 0] }, { turn: 26, dv: [-0.14584, 0.01547, 0] }], winTurn: 34, parDv: 0.3080, dragScale: 0.4 }
    ];

    // Duel mode (stage G6). The engine does not run it yet.
    const DUEL = {
        id: 'duel', a: GEO, turnFraction: 0.125, maxTurns: 32, maxBurnPerTurn: 1,
        start: { operator: [0, 0, 0, 0, 0, 0], inspector: [0, -40, 0, 0, 0, 0] },
        dvBudget: { operator: 3, inspector: 6 },
        scoreRangeKm: [5, 15], pointsToWin: 8, tooCloseKm: 1,
        slotBoxKm: { inTrack: 50, radial: 10 }
    };

    const byId = id => (id === 'duel' ? DUEL : list.find(s => s.id === id) || null);

    global.BurnScenarios = { list, byId, DUEL };
})(typeof window !== 'undefined' ? window : globalThis);
if (typeof module !== 'undefined') module.exports = globalThis.BurnScenarios;
