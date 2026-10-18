'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../js/sim.js');

const lab = (seed) => S.generateEnvironment(seed, false);

test('generated mazes are valid across every style', () => {
  for (const style of Object.keys(S.MAZE_STYLES)) {
    for (let seed = 1; seed <= 150; seed++) {
      const maze = S.generateMaze(seed, style);
      assert.deepEqual(S.validateMaze(maze), [], `${style} seed ${seed}`);
    }
  }
});

test('maze generation is deterministic and seed-sensitive', () => {
  assert.deepEqual(S.generateMaze(7).walls, S.generateMaze(7).walls);
  assert.notDeepEqual(S.generateMaze(7).walls, S.generateMaze(8).walls);
});

test('simulation is fully deterministic', () => {
  const maze = S.generateMaze(99), env = S.generateEnvironment(99, true);
  const build = S.rivalBuild('pulse', 3);
  const a = S.simulateEntrant(maze, build, env, { salt: 'x' });
  const b = S.simulateEntrant(maze, build, env, { salt: 'x' });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('mice never drive through walls and always finish in lab conditions', () => {
  const r = S.rngFor('test-builds');
  for (let i = 0; i < 120; i++) {
    const maze = S.generateMaze(S.hashSeed('walls', i));
    const build = S.randomBuild(r);
    const res = S.simulateEntrant(maze, build, lab(i), {});
    for (const m of res.moves) {
      if (m.kind === 'reset') continue;
      const d = S.dirBetween(m.from, m.to);
      assert.ok(d >= 0, 'moves are between adjacent cells');
      assert.equal(maze.walls[m.from] & S.BIT[d], 0, `move ${m.from}->${m.to} crosses a wall (maze ${i})`);
    }
    assert.ok(res.goalTime > 0, 'reached the goal while searching');
    assert.notEqual(res.best, null, `finished a speed run (maze ${i}, ${res.dnf})`);
  }
});

test('speed-run route only uses cells the mouse actually visited', () => {
  for (let i = 0; i < 60; i++) {
    const maze = S.generateMaze(S.hashSeed('route', i));
    const res = S.simulateEntrant(maze, S.DEFAULT_BUILD, lab(i), {});
    const visited = new Set(res.moves.filter((m) => m.ph !== 'run1' && m.ph !== 'run2').flatMap((m) => [m.from, m.to]));
    visited.add(S.START);
    for (const c of res.route) assert.ok(visited.has(c), `route cell ${c} was never explored`);
    assert.equal(res.route[0], S.START);
    assert.ok(S.isGoal(res.route[res.route.length - 1]));
    assert.ok(res.route.length - 1 >= S.trueShortest(maze), 'cannot beat the true shortest path');
  }
});

test('timeline is monotonic', () => {
  const res = S.simulateEntrant(S.generateMaze(5), S.rivalBuild('redline', 1), S.generateEnvironment(5, true), {});
  let t = 0;
  for (const m of res.moves) {
    assert.ok(m.t1 >= m.t0 && m.t0 >= t - 1e-9, 'moves are ordered and non-overlapping');
    t = m.t1;
  }
});

test('championship produces a champion through a valid bracket', () => {
  const champ = S.createChampionship(1234, { playerTeam: 'nova', playerBuild: S.DEFAULT_BUILD });
  assert.equal(champ.draw.length, 8);
  assert.deepEqual(champ.builds.nova, S.normalizeBuild(S.DEFAULT_BUILD));
  const sizes = [];
  for (let i = 0; i < 3; i++) {
    const rd = S.runRound(champ, i);
    sizes.push(rd.field.length);
    for (const h of rd.heats) assert.ok([h.a, h.b].includes(h.winner));
  }
  assert.deepEqual(sizes, [8, 4, 2]);
  assert.ok(S.TEAM_BY_ID[champ.champion]);
  assert.notEqual(champ.rounds[0].maze.seed, champ.rounds[1].maze.seed, 'each round races a fresh maze');
});

test('build share codes round-trip and reject junk', () => {
  const b = S.rivalBuild('phantom', 77);
  assert.deepEqual(S.decodeBuild(S.encodeBuild(b)), b);
  assert.equal(S.decodeBuild('nonsense'), null);
  assert.equal(S.decodeBuild('warp.urethane.none.mid.s2.balanced.cells.straight.90.45'), null);
});

test('normalizeBuild clamps tuning to legal limits', () => {
  const b = S.normalizeBuild({ aggression: 5, searchSpeed: -1, motor: 'rocket' });
  assert.equal(b.aggression, S.LIMITS.aggression[1]);
  assert.equal(b.searchSpeed, S.LIMITS.searchSpeed[0]);
  assert.equal(b.motor, S.DEFAULT_BUILD.motor);
});

test('auto-tune returns a build at least as good as the ones it tried', () => {
  const { best, tested } = S.autoTune(42, { tries: 8, mazes: 2 });
  assert.equal(tested.length, 8);
  assert.ok(tested.every((t) => t.avg >= best.avg));
});

test('balance guard: no team dominates and every part option can win', () => {
  const titles = Object.fromEntries(S.TEAMS.map((t) => [t.id, 0]));
  const seasons = 120;
  for (let i = 0; i < seasons; i++) {
    const champ = S.createChampionship(S.hashSeed('guard', i));
    for (let k = 0; k < 3; k++) S.runRound(champ, k);
    titles[champ.champion]++;
  }
  for (const [id, n] of Object.entries(titles)) assert.ok(n / seasons < 0.4, `${id} won ${n}/${seasons} titles`);
  assert.ok(Object.values(titles).filter((n) => n > 0).length >= 6, 'most teams win at least once');
});

test('diagonal steering cuts zig-zags, stays continuous and beats 90° turns at a safe pace', () => {
  let diagT = 0, orthoT = 0, segs = 0;
  for (let i = 0; i < 40; i++) {
    const maze = S.generateMaze(S.hashSeed('diag', i));
    const base = { ...S.DEFAULT_BUILD, planner: 'turns', diagPace: 0.5 };
    const d = S.simulateEntrant(maze, { ...base, steering: 'diagonal' }, lab(i), {});
    const o = S.simulateEntrant(maze, base, lab(i), {});
    assert.ok(d.best != null && o.best != null, `both finish (maze ${i})`);
    diagT += d.best; orthoT += o.best;
    for (const run of d.runs) segs += run.diagonals;
    assert.ok(o.runs.every((r) => r.diagonals === 0) && o.moves.every((m) => !m.pts));
    const runMoves = d.moves.filter((m) => m.ph === 'run2');
    for (let k = 0; k + 1 < runMoves.length; k++) {
      const a = runMoves[k], b = runMoves[k + 1];
      if (a.pts) assert.ok(a.tm >= a.t0 && a.tm <= a.t1, 'waypoint time inside the move');
      if (a.pts && b.pts) assert.deepEqual(a.pts[2], b.pts[0], 'diagonal line is continuous');
      for (const [x, y] of a.pts || []) {
        const inFrom = Math.abs(x - ((a.from % S.N) + 0.5)) <= 0.5 && Math.abs(y - (((a.from / S.N) | 0) + 0.5)) <= 0.5;
        const inTo = Math.abs(x - ((a.to % S.N) + 0.5)) <= 0.5 && Math.abs(y - (((a.to / S.N) | 0) + 0.5)) <= 0.5;
        assert.ok(inFrom || inTo, 'waypoints stay inside the two cells of the move');
      }
    }
  }
  assert.ok(segs > 40, 'routes contain diagonals');
  assert.ok(diagT < orthoT * 0.97, `diagonal ${diagT.toFixed(2)} vs orthogonal ${orthoT.toFixed(2)}`);
});

test('pre-diagonal share codes still decode; new codes round-trip steering', () => {
  const old = S.decodeBuild('coreless.urethane.none.mid.s2.balanced.cells.straight.90.45');
  assert.equal(old.steering, 'orthogonal');
  assert.equal(old.diagPace, S.DEFAULT_BUILD.diagPace);
  const b = S.normalizeBuild({ ...S.DEFAULT_BUILD, steering: 'diagonal', diagPace: 0.83 });
  assert.deepEqual(S.decodeBuild(S.encodeBuild(b)), b);
  assert.equal(S.decodeBuild('coreless.urethane.none.mid.s2.balanced.cells.straight.90.45.warp.50'), null);
});
