// Balance report: how often each part option and team wins a race.
// Usage: node tests/balance.js [races] [--advanced] [--scoring=best]
'use strict';
const S = require('../js/sim.js');
const races = +process.argv[2] || 400;
const advanced = process.argv.includes('--advanced');
const scoring = (process.argv.find((a) => a.startsWith('--scoring=')) || '=combined').split('=')[1];

function partWinRates() {
  const seen = {}, won = {};
  const bump = (o, k) => (o[k] = (o[k] || 0) + 1);
  let dnf = 0, crashes = 0, runs = 0;
  for (let i = 0; i < races; i++) {
    const maze = S.generateMaze(S.hashSeed('bal', i));
    const env = S.generateEnvironment(S.hashSeed('bal-env', i), advanced);
    const r = S.rngFor('bal-builds', i);
    const entrants = Array.from({ length: 8 }, (_, k) => ({ id: 'm' + k, build: S.randomBuild(r) }));
    const race = S.simulateRace(maze, env, entrants, { scoring });
    for (const row of race.rows) {
      if (row.score == null) dnf++;
      for (const run of row.result.runs) { runs++; if (run.crashed) crashes++; }
      for (const k of Object.keys(S.CATALOG)) bump(seen, k + ':' + row.result.build[k]);
    }
    const w = race.rows.find((x) => x.id === race.ranking[0]).result.build;
    for (const k of Object.keys(S.CATALOG)) bump(won, k + ':' + w[k]);
  }
  console.log(`\nPart win rate (expected share = 1.00x), ${races} races x 8 random builds, ${advanced ? 'advanced' : 'standard'}, ${scoring}`);
  for (const k of Object.keys(S.CATALOG)) {
    const opts = Object.keys(S.CATALOG[k]);
    console.log('  ' + k.padEnd(9) + opts.map((o) => `${o} ${((won[k + ':' + o] || 0) / races / ((seen[k + ':' + o] || 1) / races / 8)).toFixed(2)}x`).join('  '));
  }
  console.log(`  DNF rate ${(dnf / races / 8 * 100).toFixed(1)}%, speed-run crash rate ${(crashes / runs * 100).toFixed(1)}%`);
}

function teamWinShares() {
  const wins = Object.fromEntries(S.TEAMS.map((t) => [t.id, 0]));
  for (let i = 0; i < races; i++) {
    const seed = S.hashSeed('season', i);
    const champ = S.createChampionship(seed, { advanced, scoring });
    for (let k = 0; k < 3; k++) S.runRound(champ, k);
    wins[champ.champion]++;
  }
  console.log(`\nChampionship titles over ${races} seasons (fair share ${(100 / 8).toFixed(1)}%)`);
  for (const t of S.TEAMS) console.log('  ' + t.name.padEnd(18) + (wins[t.id] / races * 100).toFixed(1).padStart(5) + '%');
  return wins;
}

const t0 = Date.now();
partWinRates();
teamWinShares();
console.log(`\n${Date.now() - t0} ms`);
