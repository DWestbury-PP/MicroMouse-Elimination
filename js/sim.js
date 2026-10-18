/*
 * MicroMouse Grand Prix — simulation engine.
 *
 * Pure and deterministic: no DOM, no Math.random, no wall-clock. Given the same
 * maze seed, environment and builds it produces byte-identical results, so races
 * are reproducible and replayable. Loaded as a classic script in the browser
 * (window.MMSim) and as a CommonJS module under node for tests.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MMSim = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ENGINE_VERSION = '2.2.0';

  // ---------------------------------------------------------------- geometry
  const N = 16;
  const CELL = 0.18;                    // m, regulation cell pitch
  const TURN_R = CELL / 2;              // smooth-turn radius
  const TURN_ARC = Math.PI * TURN_R / 2;
  const DIAG_HALF = CELL / (2 * Math.SQRT2); // half a cell crossed on a 45° diagonal
  const G = 9.81;
  const DX = [0, 1, 0, -1];
  const DY = [-1, 0, 1, 0];             // N E S W; y grows downward (south)
  const BIT = [1, 2, 4, 8];
  const OPP = [2, 3, 0, 1];
  const DIR_NAMES = ['N', 'E', 'S', 'W'];
  const idx = (x, y) => y * N + x;
  const START = idx(0, N - 1);
  const GOALS = [idx(7, 7), idx(8, 7), idx(7, 8), idx(8, 8)];
  const GOAL_SET = new Set(GOALS);
  const isGoal = (c) => GOAL_SET.has(c);

  function neighbor(c, d) {
    const x = (c % N) + DX[d], y = ((c / N) | 0) + DY[d];
    return x < 0 || y < 0 || x >= N || y >= N ? -1 : idx(x, y);
  }
  function dirBetween(a, b) {
    for (let d = 0; d < 4; d++) if (neighbor(a, d) === b) return d;
    return -1;
  }

  // --------------------------------------------------------------------- rng
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashSeed(...parts) {
    let h = 2166136261;
    for (const p of parts) {
      const s = String(p);
      for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
      h ^= 0x2f; h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  const rngFor = (...parts) => mulberry32(hashSeed(...parts));
  const pickKey = (r, obj) => { const k = Object.keys(obj); return k[Math.floor(r() * k.length)]; };
  function weightedKey(r, obj, weights) {
    const keys = Object.keys(obj);
    const w = keys.map((k) => (weights && weights[k] != null ? weights[k] : 1));
    let x = r() * w.reduce((a, b) => a + b, 0);
    for (let i = 0; i < keys.length; i++) { x -= w[i]; if (x < 0) return keys[i]; }
    return keys[keys.length - 1];
  }
  const lerp = (a, b, t) => a + (b - a) * t;
  const round = (x, p) => Math.round(x * 10 ** p) / 10 ** p;

  // ------------------------------------------------------------------- mazes
  // Growing-tree generator: `newest` near 1 behaves like a recursive backtracker
  // (long corridors), near 0 like Prim's (short, bushy dead ends). `loops`
  // knocks out extra walls so there are competing routes worth searching for.
  const MAZE_STYLES = {
    classic: { label: 'Classic corridors', newest: 0.92, loops: 0.05 },
    branchy: { label: 'Branching labyrinth', newest: 0.3, loops: 0.07 },
    open: { label: 'Open circuit', newest: 0.7, loops: 0.17 },
    switchback: { label: 'Switchback alley', newest: 0.97, loops: 0.11 },
  };

  function generateMaze(seed, style) {
    const r = rngFor('maze', seed);
    if (!MAZE_STYLES[style]) style = pickKey(r, MAZE_STYLES);
    const P = MAZE_STYLES[style];
    const walls = new Array(N * N).fill(15);
    const carve = (c, d) => {
      const n = neighbor(c, d);
      walls[c] &= ~BIT[d];
      walls[n] &= ~BIT[OPP[d]];
    };
    const visited = new Uint8Array(N * N);
    for (const g of GOALS) visited[g] = 1;
    visited[START] = 1;
    const active = [START];
    while (active.length) {
      const k = r() < P.newest ? active.length - 1 : Math.floor(r() * active.length);
      const c = active[k];
      const opts = [];
      for (let d = 0; d < 4; d++) {
        if (c === START && d === 1) continue; // regulation: start cell is walled on its open side
        const n = neighbor(c, d);
        if (n >= 0 && !visited[n]) opts.push(d);
      }
      if (!opts.length) { active.splice(k, 1); continue; }
      const d = opts[Math.floor(r() * opts.length)];
      const n = neighbor(c, d);
      carve(c, d);
      visited[n] = 1;
      active.push(n);
    }
    // Goal: open 2x2 with exactly one entrance.
    carve(GOALS[0], 1); carve(GOALS[0], 2); carve(GOALS[3], 0); carve(GOALS[3], 3);
    const doors = [];
    for (const g of GOALS) for (let d = 0; d < 4; d++) if (!isGoal(neighbor(g, d))) doors.push([g, d]);
    const door = doors[Math.floor(r() * doors.length)];
    carve(door[0], door[1]);

    const fixed = (c, d) => {
      const n = neighbor(c, d);
      return n < 0 || isGoal(c) !== isGoal(n) || (c === START && d === 1);
    };
    // Regulation: every lattice post (except the goal's centre) touches a wall,
    // so loop removal never leaves a post floating on its own.
    const hSeg = (px, py) => px >= 0 && px < N && py >= 0 && py <= N && !!(py < N ? walls[idx(px, py)] & 1 : walls[idx(px, N - 1)] & 4);
    const vSeg = (px, py) => py >= 0 && py < N && px >= 0 && px <= N && !!(px < N ? walls[idx(px, py)] & 8 : walls[idx(N - 1, py)] & 2);
    const degree = (px, py) => hSeg(px - 1, py) + hSeg(px, py) + vSeg(px, py - 1) + vSeg(px, py);
    for (let c = 0; c < N * N; c++) {
      const x = c % N, y = (c / N) | 0;
      for (const d of [1, 2]) {
        if (!(walls[c] & BIT[d]) || fixed(c, d) || r() >= P.loops) continue;
        const ends = d === 1 ? [[x + 1, y], [x + 1, y + 1]] : [[x, y + 1], [x + 1, y + 1]];
        if (ends.every(([px, py]) => degree(px, py) >= 2)) carve(c, d);
      }
    }
    return { seed: seed >>> 0, style, label: P.label, walls, door };
  }

  // Shortest route on the true maze, for spectator overlays and tests.
  function trueShortest(maze) {
    const dist = bfs(GOALS, (c, d) => maze.walls[c] & BIT[d]);
    return dist[START];
  }

  function validateMaze(maze) {
    const errors = [];
    const dist = bfs([START], (c, d) => maze.walls[c] & BIT[d]);
    if (dist.some((x) => x < 0)) errors.push('unreachable cells');
    let doors = 0;
    for (const g of GOALS) for (let d = 0; d < 4; d++) {
      const n = neighbor(g, d);
      if (!isGoal(n) && !(maze.walls[g] & BIT[d])) doors++;
    }
    if (doors !== 1) errors.push('goal must have exactly one entrance, found ' + doors);
    if (!(maze.walls[START] & BIT[1])) errors.push('start cell must be walled to the east');
    const w = maze.walls;
    for (let py = 1; py < N; py++) for (let px = 1; px < N; px++) {
      if (px === N / 2 && py === N / 2) continue;
      const touches = (w[idx(px - 1, py)] & 1) || (w[idx(px, py)] & 1) || (w[idx(px, py - 1)] & 8) || (w[idx(px, py)] & 8);
      if (!touches) errors.push('isolated post at ' + px + ',' + py);
    }
    for (let c = 0; c < N * N; c++) for (let d = 0; d < 4; d++) {
      const n = neighbor(c, d);
      if (n < 0 && !(maze.walls[c] & BIT[d])) errors.push('open boundary at ' + c);
      if (n >= 0 && !!(maze.walls[c] & BIT[d]) !== !!(maze.walls[n] & BIT[OPP[d]])) errors.push('asymmetric wall at ' + c);
    }
    return errors;
  }

  function bfs(sources, blocked) {
    const dist = new Int16Array(N * N).fill(-1);
    const q = new Int16Array(N * N);
    let h = 0, t = 0;
    for (const s of sources) if (dist[s] < 0) { dist[s] = 0; q[t++] = s; }
    while (h < t) {
      const c = q[h++];
      for (let d = 0; d < 4; d++) {
        if (blocked(c, d)) continue;
        const n = neighbor(c, d);
        if (n < 0 || dist[n] >= 0) continue;
        dist[n] = dist[c] + 1;
        q[t++] = n;
      }
    }
    return dist;
  }

  // ------------------------------------------------------------------- parts
  // Every part trades something away. Masses in grams, forces in newtons,
  // speeds in m/s, energy in joules, power in watts.
  const CHASSIS_MASS = 36;
  const BASE_W = 0.6;
  // Corner entry is limited by grip AND by how hard the motors can yaw the
  // chassis: v_yaw = YAW_K * sqrt(motor force / mass). Heavy mice turn lazily.
  const YAW_K = 0.36;
  const PARTS = {
    motor: {
      coreless: { name: 'Coreless 6V', mass: 9, topSpeed: 2.55, force: 0.7, power: 1.4, desc: 'Light and frugal. Modest top speed and punch.' },
      brushless: { name: 'Brushless 12V', mass: 21, topSpeed: 3.6, force: 0.85, power: 3.0, desc: 'Huge top speed, heavy and power-hungry. Needs grip to use it.' },
      geared: { name: 'High-torque gearmotor', mass: 16, topSpeed: 2.3, force: 1.2, power: 1.8, desc: 'Explosive acceleration, low top speed. Loves twisty mazes.' },
    },
    tires: {
      silicone: { name: 'Silicone', mass: 4, grip: 1.07, rolling: 0.86, dustLoss: 0.5, desc: 'Sticky, but drags at speed and loses half its bite on dust.' },
      urethane: { name: 'Urethane', mass: 4, grip: 0.98, rolling: 0.97, dustLoss: 0.28, desc: 'The dependable middle ground.' },
      rubber: { name: 'Hard rubber', mass: 2, grip: 0.95, rolling: 1, dustLoss: 0.1, desc: 'Low grip but rolls freely, and nearly immune to dust.' },
    },
    fan: {
      none: { name: 'No suction', mass: 0, downforce: 0, power: 0, desc: 'Lightest. Grip comes from weight alone.' },
      low: { name: 'Suction fan (low)', mass: 7, downforce: 0.1, power: 2.4, desc: 'Adds downforce for faster corners, costs battery.' },
      high: { name: 'Suction fan (high)', mass: 13, downforce: 0.22, power: 6, desc: 'Glued to the floor. Drains batteries fast.' },
    },
    sensors: {
      short: { name: 'Short-range IR (1 cell)', mass: 2, range: 1, noise: 0.01, desc: 'Only sees adjacent walls. Light and reliable.' },
      mid: { name: 'Mid-range IR (2 cells)', mass: 4, range: 2, noise: 0.03, desc: 'Peeks one cell ahead, including diagonals.' },
      long: { name: 'Long-range IR (4 cells)', mass: 7, range: 4, noise: 0.06, desc: 'Sees far down corridors and two cells of side walls. Heavier, noisier in glare.' },
    },
    battery: {
      s1: { name: '1S 180 mAh', mass: 6, volt: 0.98, energy: 130, desc: 'Featherweight, sags under heavy loads.' },
      s2: { name: '2S 260 mAh', mass: 12, volt: 1.0, energy: 200, desc: 'Standard pack.' },
      s2xl: { name: '2S 450 mAh', mass: 19, volt: 1.04, energy: 340, desc: 'Runs all day. Heavy.' },
    },
    steering: {
      orthogonal: { name: '90° turns only', mass: 0, desc: 'Classic: every corner is a quarter-turn through the cell centre.' },
      diagonal: { name: '45° diagonal steering', mass: 15, desc: 'Gyro and angled sensors let speed runs cut zig-zags on a straight diagonal. Extra weight.' },
    },
  };
  // 45° flicks onto and off a diagonal are tighter than a swept 90° corner.
  // Threading the posts needs constant small steering corrections, so diagonal
  // pace is a share of DIAG_REF x the yaw-limited corner speed (heavy chassis suffer),
  // and how fast is safe depends on how well the sensors see the posts.
  const TURN45 = { grip: 0.9, yaw: 0.9 };
  const DIAG_REF = 2.1;
  const DIAG_SAFE = { short: 0.64, mid: 0.6, long: 0.52 };
  const POLICIES = {
    dash: { name: 'Dash', budget: 0, desc: 'Goes home as soon as it finds the centre.' },
    balanced: { name: 'Balanced', budget: 60, desc: 'Checks promising shortcuts on the way home.' },
    thorough: { name: 'Thorough', budget: 240, desc: 'Searches until its route is provably shortest.' },
  };
  const PLANNERS = {
    cells: { name: 'Fewest cells', desc: 'Classic flood-fill route: shortest distance.' },
    turns: { name: 'Turn-aware', desc: 'Weighs straights against corners using its own physics.' },
  };
  const TIEBREAKS = {
    straight: { name: 'Straight first', desc: 'Keeps its heading when routes tie.' },
    explore: { name: 'Unexplored first', desc: 'Prefers cells it has not visited.' },
    left: { name: 'Left first', desc: 'Breaks ties toward the left.' },
    right: { name: 'Right first', desc: 'Breaks ties toward the right.' },
  };
  const LIMITS = { aggression: [0.7, 1.1], searchSpeed: [0.25, 0.7], diagPace: [0.4, 1] };
  const DEFAULT_BUILD = {
    motor: 'coreless', tires: 'urethane', fan: 'none', sensors: 'mid', battery: 's2',
    policy: 'balanced', planner: 'cells', tieBreak: 'straight', steering: 'orthogonal',
    aggression: 0.9, searchSpeed: 0.45, diagPace: 0.58,
  };
  const CATALOG = { motor: PARTS.motor, tires: PARTS.tires, fan: PARTS.fan, sensors: PARTS.sensors, battery: PARTS.battery, policy: POLICIES, planner: PLANNERS, tieBreak: TIEBREAKS, steering: PARTS.steering };

  function normalizeBuild(b) {
    const out = {};
    for (const k of Object.keys(CATALOG)) out[k] = b && CATALOG[k][b[k]] ? b[k] : DEFAULT_BUILD[k];
    for (const k of Object.keys(LIMITS)) {
      const v = b && Number.isFinite(+b[k]) ? +b[k] : DEFAULT_BUILD[k];
      out[k] = round(Math.min(LIMITS[k][1], Math.max(LIMITS[k][0], v)), 2);
    }
    return out;
  }

  function deriveStats(build) {
    const b = normalizeBuild(build);
    const M = PARTS.motor[b.motor], T = PARTS.tires[b.tires], F = PARTS.fan[b.fan];
    const S = PARTS.sensors[b.sensors], B = PARTS.battery[b.battery], D = PARTS.steering[b.steering];
    const massG = CHASSIS_MASS + M.mass + T.mass + F.mass + S.mass + B.mass + D.mass;
    const m = massG / 1000;
    const normal = m * G + F.downforce;
    const vmax = M.topSpeed * B.volt * T.rolling;
    const motorAccel = (M.force * B.volt) / m;
    const tractionAccel = (T.grip * normal) / m;
    const cornerSpeed = Math.min(Math.sqrt(tractionAccel * TURN_R), YAW_K * Math.sqrt(motorAccel));
    return {
      massG, m, normal, vmax, motorAccel, tractionAccel,
      accel: Math.min(motorAccel, tractionAccel),
      grip: T.grip, dustLoss: T.dustLoss, downforce: F.downforce,
      gripCorner: Math.sqrt(tractionAccel * TURN_R),
      yawCorner: YAW_K * Math.sqrt(motorAccel),
      cornerSpeed,
      range: S.range, noise: S.noise,
      diagonal: b.steering === 'diagonal', diagSafe: DIAG_SAFE[b.sensors], diagRef: Math.min(vmax, DIAG_REF * cornerSpeed),
      corner45: Math.min(Math.sqrt(tractionAccel * TURN_R) * TURN45.grip, YAW_K * Math.sqrt(motorAccel) * TURN45.yaw),
      energy: B.energy, motorW: M.power, fanW: F.power,
      searchCruise: b.searchSpeed * vmax,
    };
  }

  // ----------------------------------------------------------------- teams
  const TEAMS = [
    { id: 'redline', name: 'Redline Racing', short: 'RED', color: '#ff4d6d', shape: 'wedge', emblem: 'R',
      bio: 'Brushless power and late braking.',
      bias: { motor: { brushless: 5, coreless: 1, geared: 0.3 }, fan: { none: 1, low: 3, high: 1 }, steering: { orthogonal: 2 }, aggression: [0.93, 1.03] } },
    { id: 'bluevector', name: 'Blue Vector', short: 'BLU', color: '#4cc9f0', shape: 'disc', emblem: 'V',
      bio: 'Long-range eyes and methodical searches.',
      bias: { sensors: { long: 5, mid: 1, short: 0.2 }, policy: { thorough: 4, balanced: 1, dash: 0.2 }, steering: { diagonal: 2 }, aggression: [0.88, 0.98] } },
    { id: 'apex', name: 'Apex Dynamics', short: 'APX', color: '#ffd166', shape: 'arrow', emblem: 'A',
      bio: 'Featherweight chassis on sticky silicone.',
      bias: { motor: { coreless: 5 }, tires: { silicone: 5 }, battery: { s1: 2, s2: 2, s2xl: 0.3 }, fan: { none: 2, low: 2 }, sensors: { mid: 3, long: 2 } } },
    { id: 'phantom', name: 'Phantom Labs', short: 'PHL', color: '#b388ff', shape: 'stealth', emblem: 'P',
      bio: 'Vacuum downforce, turn-aware planning and diagonal cuts.',
      bias: { fan: { high: 5, low: 2, none: 0.2 }, planner: { turns: 5 }, battery: { s2xl: 4 }, steering: { diagonal: 5 }, diagPace: [0.5, 0.62] } },
    { id: 'velocity', name: 'Velocity Works', short: 'VEL', color: '#06d6a0', shape: 'needle', emblem: 'W',
      bio: 'Built for long straights, diagonal ones included.',
      bias: { motor: { brushless: 4 }, planner: { turns: 4 }, tires: { urethane: 3 }, policy: { thorough: 2 }, steering: { diagonal: 2 } } },
    { id: 'nova', name: 'Nova Robotics', short: 'NOV', color: '#ff9f1c', shape: 'hex', emblem: 'N',
      bio: 'The sensible all-rounder.',
      bias: { aggression: [0.88, 0.96] } },
    { id: 'circuit', name: 'Circuit Breakers', short: 'CBK', color: '#f15bb5', shape: 'box', emblem: 'C',
      bio: 'Gearmotors that leap out of every corner.',
      bias: { motor: { geared: 5 }, fan: { low: 3, high: 3 }, battery: { s2xl: 3 }, policy: { dash: 2, balanced: 2 }, steering: { diagonal: 2 } } },
    { id: 'pulse', name: 'Pulse Dynamics', short: 'PUL', color: '#9ef01a', shape: 'bug', emblem: 'Ψ',
      bio: 'A wild new concept every season.',
      bias: { aggression: [0.84, 1.04], searchSpeed: [0.32, 0.62], diagPace: [0.45, 0.8] } },
  ];
  const TEAM_BY_ID = Object.fromEntries(TEAMS.map((t) => [t.id, t]));

  function randomBuild(r, bias) {
    bias = bias || {};
    const b = {};
    for (const k of Object.keys(CATALOG)) b[k] = weightedKey(r, CATALOG[k], bias[k]);
    const ag = bias.aggression || [0.84, 1.01], ss = bias.searchSpeed || [0.33, 0.58];
    b.aggression = round(lerp(ag[0], ag[1], r()), 3);
    b.searchSpeed = round(lerp(ss[0], ss[1], r()), 3);
    const dp = bias.diagPace || [0.42, 0.68];
    b.diagPace = round(lerp(dp[0], dp[1], r()), 3);
    // Procedural builds stay sane: a big fan gets a pack that can feed it.
    if (b.fan === 'high' && b.battery === 's1') b.battery = 's2';
    if (b.fan === 'high' && b.policy === 'thorough') b.battery = 's2xl';
    return normalizeBuild(b);
  }
  const rivalBuild = (teamId, seed) => randomBuild(rngFor('rival', teamId, seed), (TEAM_BY_ID[teamId] || {}).bias);

  // ------------------------------------------------------------- environment
  function generateEnvironment(seed, advanced) {
    const env = { seed: seed >>> 0, advanced: !!advanced, grip: 1, glare: 0, battery: 1, dust: null, conditions: [] };
    if (!advanced) { env.conditions.push('Lab conditions'); return env; }
    const r = rngFor('env', seed);
    env.grip = round(lerp(0.86, 1.06, r()), 3);
    env.glare = round(lerp(0.6, 2.4, r()), 2);
    env.battery = round(lerp(0.86, 1, r()), 3);
    env.dust = new Array(N * N).fill(0);
    const patches = 1 + Math.floor(r() * 5);
    for (let p = 0; p < patches; p++) {
      let c = Math.floor(r() * N * N);
      const level = round(lerp(0.3, 0.9, r()), 2), size = 2 + Math.floor(r() * 5);
      for (let k = 0; k < size; k++) {
        if (c !== START) env.dust[c] = Math.max(env.dust[c], level);
        const n = neighbor(c, Math.floor(r() * 4));
        if (n >= 0) c = n;
      }
    }
    env.conditions.push(env.grip < 0.93 ? 'Slick surface' : env.grip > 1.01 ? 'Grippy surface' : 'Normal surface');
    env.conditions.push(patches + ' dust patch' + (patches > 1 ? 'es' : ''));
    if (env.glare > 1.6) env.conditions.push('IR glare');
    if (env.battery < 0.92) env.conditions.push('Cold batteries');
    return env;
  }

  // ------------------------------------------------------------ min-heap
  function heapPush(h, item) {
    h.push(item);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (h[p][0] <= h[i][0]) break;
      [h[p], h[i]] = [h[i], h[p]]; i = p;
    }
  }
  function heapPop(h) {
    const top = h[0], last = h.pop();
    if (h.length) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < h.length && h[l][0] < h[m][0]) m = l;
        if (r < h.length && h[r][0] < h[m][0]) m = r;
        if (m === i) break;
        [h[m], h[i]] = [h[i], h[m]]; i = m;
      }
    }
    return top;
  }

  // ------------------------------------------------------------ the mouse
  const PIVOT_180 = 0.28;       // s, stop-and-spin at a dead end
  const SLIP_RECOVERY = 1.1;    // s, regaining control after a slide while searching
  const SLIP_K = 1.8;           // slide probability per unit of corner overspeed
  const RUN_FACTORS = [0.93, 1];// first speed run is a banker, second is the attack
  const RESET_PAUSE = 0.6;      // s, handler re-seats the mouse at the start
  const MAX_MOVES = 4000;

  function slipChance(ratio) { return ratio <= 1 ? 0 : Math.min(0.95, 0.02 + (ratio - 1) * SLIP_K); }

  function simulateEntrant(maze, build, env, opts) {
    opts = opts || {};
    const b = normalizeBuild(build), st = deriveStats(b);
    const r = rngFor('entrant', maze.seed, env.seed, opts.salt || '');
    const walls = maze.walls;
    const kWall = new Uint8Array(N * N), kMask = new Uint8Array(N * N), unsure = new Uint8Array(N * N);
    const visited = new Uint8Array(N * N);
    const moves = [], learn = [], marks = [], phases = [];
    const fullEnergy = st.energy * env.battery;
    let t = 0, pos = START, heading = 0, v = 0, energy = fullEnergy, phase = 'search';
    let moveCount = 0, slips = 0, goalTime = null, dnf = null;

    for (let c = 0; c < N * N; c++) for (let d = 0; d < 4; d++) {
      if (neighbor(c, d) < 0) { kWall[c] |= BIT[d]; kMask[c] |= BIT[d]; }
    }
    const setPhase = (p) => { phase = p; phases.push({ t, phase: p }); };
    setPhase('search');

    function setEdge(c, d, wall, sure) {
      const n = neighbor(c, d);
      if (n < 0) return;
      const bit = BIT[d], ob = BIT[OPP[d]];
      if (kMask[c] & bit && !(unsure[c] & bit) && !sure) return;
      const was = kMask[c] & bit ? !!(kWall[c] & bit) : null;
      kMask[c] |= bit; kMask[n] |= ob;
      if (wall) { kWall[c] |= bit; kWall[n] |= ob; } else { kWall[c] &= ~bit; kWall[n] &= ~ob; }
      if (sure) { unsure[c] &= ~bit; unsure[n] &= ~ob; } else { unsure[c] |= bit; unsure[n] |= ob; }
      if (was !== wall) learn.push({ t, c, d, wall, sure });
    }
    const truth = (c, d) => !!(walls[c] & BIT[d]);
    const noise = env.advanced ? st.noise * env.glare : 0;
    function read(c, d, dist) {
      let w = truth(c, d);
      if (dist === 0) return setEdge(c, d, w, true);
      if (noise > 0 && r() < noise * dist) w = !w;
      setEdge(c, d, w, false);
    }
    function sense() {
      visited[pos] = 1;
      for (let d = 0; d < 4; d++) read(pos, d, 0);
      let c = pos;
      for (let k = 1; k < st.range; k++) {
        if (truth(c, heading)) break;
        c = neighbor(c, heading);
        read(c, heading, k);
        if (k <= Math.floor(st.range / 2)) { read(c, (heading + 3) % 4, k); read(c, (heading + 1) % 4, k); }
      }
    }

    // Below 25% charge the motors sag; a flat pack limps home with the fan off.
    const sag = () => (energy <= 0 ? 0.55 : energy / fullEnergy < 0.25 ? 0.8 : 1);
    // A sagging battery also slows the suction fan, so downforce drops with it.
    const normalAt = (s) => st.m * G + st.downforce * (s >= 1 ? 1 : s >= 0.8 ? 0.4 : 0);
    const mu = (c) => st.grip * env.grip * (1 - st.dustLoss * (env.dust ? env.dust[c] : 0));
    const accelAt = (c, s) => Math.min(st.motorAccel * s, (mu(c) * normalAt(s)) / st.m);
    const cornerPlan = (s) => Math.min(Math.sqrt(((st.grip * normalAt(s)) / st.m) * TURN_R), YAW_K * Math.sqrt(st.motorAccel * s));
    // Overspeed past either limit risks a slide (grip) or clipping a post (yaw).
    const vCornerActual = (c, s) => Math.min(Math.sqrt(((mu(c) * normalAt(s)) / st.m) * TURN_R), YAW_K * Math.sqrt(st.motorAccel * s));
    const corner45Plan = (s) => Math.min(Math.sqrt(((st.grip * normalAt(s)) / st.m) * TURN_R) * TURN45.grip, YAW_K * Math.sqrt(st.motorAccel * s) * TURN45.yaw);
    const corner45Actual = (c, s) => Math.min(Math.sqrt(((mu(c) * normalAt(s)) / st.m) * TURN_R) * TURN45.grip, YAW_K * Math.sqrt(st.motorAccel * s) * TURN45.yaw);
    // Fastest a diagonal can be threaded without clipping a post (glare blinds the sensors).
    const diagSafeV = () => st.diagRef * st.diagSafe * (env.advanced ? 1 - 0.03 * env.glare : 1);
    const power = (frac) => BASE_W + st.motorW * (0.35 + 0.65 * frac) + st.fanW;
    let flat = false;
    function drain(dt, frac) {
      energy -= power(frac) * dt;
      if (energy <= 0) {
        energy = 0;
        if (!flat) { flat = true; marks.push({ t, type: 'flat', c: pos }); }
      }
    }

    // One cell move at search pace. Turns happen in the current cell.
    function stepTo(d, label) {
      const s = sag();
      const vc = Math.min(st.vmax * s, Math.max(0.15, b.searchSpeed * st.vmax * s));
      const a = accelAt(pos, s);
      const from = pos, to = neighbor(pos, d);
      let dt = 0, kind = 'straight', slipped = false;
      if (d === OPP[heading]) { kind = 'reverse'; dt += v / (2 * a) + PIVOT_180; v = 0; }
      if (v === 0) dt += vc / (2 * a);
      if (kind === 'reverse' || d === heading) dt += CELL / vc;
      else {
        kind = 'turn';
        const vt = Math.min(vc, b.aggression * cornerPlan(s));
        dt += TURN_ARC / vt + (vc - vt) ** 2 / (a * vc);
        const ratio = vt / vCornerActual(pos, s);
        if (r() < slipChance(ratio)) { slipped = true; slips++; dt += SLIP_RECOVERY; }
      }
      moves.push({ t0: t, t1: t + dt, from, to, h: d, ph: label || phase, kind });
      if (slipped) marks.push({ t: t + dt * 0.4, type: 'slip', c: from });
      t += dt;
      drain(dt, vc / st.vmax);
      pos = to; heading = d; v = slipped ? 0 : vc;
      moveCount++;
    }

    function chooseDir(targets) {
      const wallBlocked = (c, d) => kWall[c] & BIT[d];
      let dist = bfs(targets, wallBlocked);
      if (dist[pos] < 0) dist = bfs(targets, (c, d) => kWall[c] & BIT[d] && !(unsure[c] & BIT[d]));
      if (dist[pos] < 0) return -1;
      const relRank = (d) => (d - heading + 4) % 4; // 0 straight, 1 right, 2 back, 3 left
      const key = (d, n) => {
        const rel = relRank(d), back = rel === 2 ? 1 : 0;
        switch (b.tieBreak) {
          case 'explore': return [back, visited[n], rel === 0 ? 0 : 1, d];
          case 'left': return [back, [1, 2, 3, 0][rel], visited[n], d];
          case 'right': return [back, [1, 0, 3, 2][rel], visited[n], d];
          default: return [back, rel === 0 ? 0 : 1, visited[n], d];
        }
      };
      let best = -1, bestKey = null;
      for (let d = 0; d < 4; d++) {
        const n = neighbor(pos, d);
        if (n < 0 || kWall[pos] & BIT[d] || dist[n] < 0) continue;
        const k = [dist[n], ...key(d, n)];
        if (!bestKey || compareKeys(k, bestKey) < 0) { best = d; bestKey = k; }
      }
      return best;
    }

    // Unvisited cells lying on an optimistic shortest route that the verified
    // (visited-only) map can't yet match. Empty means the known route is optimal.
    function shortcutCandidates() {
      const blocked = (c, d) => kWall[c] & BIT[d];
      const dS = bfs([START], blocked), dG = bfs(GOALS, blocked);
      const opt = Math.min(...GOALS.map((g) => (dS[g] < 0 ? 1e9 : dS[g])));
      const dV = bfs([START], (c, d) => blocked(c, d) || !visited[neighbor(c, d)]);
      const ver = Math.min(...GOALS.map((g) => (dV[g] < 0 ? 1e9 : dV[g])));
      if (ver <= opt) return [];
      const out = [];
      for (let c = 0; c < N * N; c++) if (!visited[c] && dS[c] >= 0 && dG[c] >= 0 && dS[c] + dG[c] === opt) out.push(c);
      return out;
    }

    // ---- exploration
    sense();
    const budget = POLICIES[b.policy].budget;
    let scanMoves = 0;
    while (!dnf) {
      if (phase === 'search' && isGoal(pos)) {
        goalTime = t;
        marks.push({ t, type: 'goal', c: pos });
        setPhase('scan');
      }
      let targets = null;
      if (phase === 'scan') {
        const cand = scanMoves < budget ? shortcutCandidates() : [];
        if (cand.length) targets = cand; else setPhase('return');
      }
      if (phase === 'return' && pos === START) break;
      if (!targets) targets = phase === 'search' ? GOALS : [START];
      const d = chooseDir(targets);
      if (d < 0) { dnf = 'Lost: no route'; break; }
      stepTo(d);
      if (phase === 'scan') scanMoves++;
      sense();
      if (moveCount > MAX_MOVES) dnf = 'Search timeout';
    }
    const exploreTime = t;
    let cellsVisited = 0;
    for (let c = 0; c < N * N; c++) cellsVisited += visited[c];

    // ---- speed runs
    const runs = [];
    let route = null;
    if (!dnf) {
      route = planRoute();
      if (!route) dnf = 'No verified route';
    }
    if (!dnf) {
      for (let i = 0; i < RUN_FACTORS.length && !dnf; i++) {
        if (i > 0) {
          const prev = runs[i - 1];
          if (prev.crashed) {
            // Handler picks the mouse up and re-seats it at the start.
            moves.push({ t0: t + RESET_PAUSE, t1: t + RESET_PAUSE * 2, from: pos, to: START, h: 0, ph: 'reset', kind: 'reset' });
            t += RESET_PAUSE * 2;
          } else {
            setPhase('reset');
            v = 0;
            for (let k = route.length - 1; k > 0 && !dnf; k--) stepTo(dirBetween(route[k], route[k - 1]), 'reset');
          }
          pos = START;
          t += RESET_PAUSE;
        } else t += RESET_PAUSE;
        if (dnf) break;
        heading = 0; v = 0;
        setPhase('run' + (i + 1));
        runs.push(speedRun(route, b.aggression * RUN_FACTORS[i], i + 1));
      }
    }

    // Dijkstra over (cell, heading, last turn). The last turn only matters for
    // diagonal steering, where a turn opposite to the previous one continues a
    // zig-zag that the speed run will cut as a straight diagonal.
    function planRoute() {
      const vt = b.aggression * st.cornerSpeed;
      const vs = Math.min(st.vmax, vt * 2.2);
      const vd = Math.min(vs, b.diagPace * st.diagRef);
      const turns = b.planner === 'turns';
      const turnCost = turns ? TURN_ARC / vt + (vs - vt) ** 2 / (2 * st.accel * vs) : 1.01;
      const straightCost = turns ? CELL / vs : 1;
      const zigCost = turns ? (2 * DIAG_HALF) / vd : 1.005;
      const best = new Float64Array(N * N * 12).fill(Infinity);
      const prev = new Int32Array(N * N * 12).fill(-1);
      const h = [];
      best[START * 12] = 0;
      heapPush(h, [0, START * 12]);
      let end = -1;
      while (h.length) {
        const [cost, s] = heapPop(h);
        if (cost > best[s]) continue;
        const c = (s / 12) | 0, hd = ((s / 3) | 0) & 3, lt = s % 3;
        if (isGoal(c)) { end = s; break; }
        for (let d = 0; d < 4; d++) {
          if (d === OPP[hd] || kWall[c] & BIT[d]) continue;
          const n = neighbor(c, d);
          if (n < 0 || !visited[n]) continue;
          const turn = d === hd ? 0 : d === (hd + 1) % 4 ? 1 : 2;
          const zig = st.diagonal && turn && lt && lt !== turn;
          const nlt = st.diagonal ? turn : 0;
          const ns = (n * 4 + d) * 3 + nlt, nc = cost + (!turn ? straightCost : zig ? zigCost : turnCost);
          if (nc < best[ns]) { best[ns] = nc; prev[ns] = s; heapPush(h, [nc, ns]); }
        }
      }
      if (end < 0) return null;
      const path = [];
      for (let s = end; s >= 0; s = prev[s]) path.push((s / 12) | 0);
      return path.reverse();
    }

    function speedRun(path, aggression, n) {
      const L = path.length - 1;
      const hd = [];
      for (let i = 0; i < L; i++) hd.push(dirBetween(path[i], path[i + 1]));
      const turnAt = (i) => i > 0 && i < L && hd[i - 1] !== hd[i];
      const s = sag();
      const vmax = st.vmax * s;
      const a = Math.min(st.motorAccel * s, (st.grip * normalAt(s)) / st.m); // planned on nominal grip
      const vt = () => Math.min(vmax, aggression * cornerPlan(s));
      // Diagonal cells: turning cells inside a zig-zag (alternating turns). A run of
      // them is driven as one straight diagonal through the edge midpoints.
      const tdir = (i) => (hd[i] - hd[i - 1] + 4) % 4;
      const diag = new Uint8Array(L + 1);
      if (st.diagonal) {
        for (let i = 1; i < L; i++) {
          if (turnAt(i) && ((turnAt(i - 1) && tdir(i - 1) !== tdir(i)) || (turnAt(i + 1) && tdir(i + 1) !== tdir(i)))) diag[i] = 1;
        }
      }
      const zig = (i, j) => diag[i] && diag[j] && tdir(i) !== tdir(j);
      const vt45 = Math.min(vmax, aggression * corner45Plan(s));
      // The banker run also keeps its diagonals inside the sensors' rated limit.
      const pace = n === 1 ? Math.min(b.diagPace * RUN_FACTORS[0], st.diagSafe * 0.97) : b.diagPace;
      const vd = Math.min(vmax, pace * st.diagRef * s);
      const half = (i) => (diag[i] ? DIAG_HALF : turnAt(i) ? TURN_ARC / 2 : CELL / 2);
      const K = 2 * L;
      const ds = new Float64Array(K), cap = new Float64Array(K + 1).fill(vmax), vel = new Float64Array(K + 1);
      const capAt = (k, v) => { cap[k] = Math.min(cap[k], v); };
      // Corner kind at the edge node between cell i and its neighbour j (diagonal cells only).
      const edgeKind = (i, j) => (zig(i, j) ? 'diag' : diag[j] ? 'v90' : '45');
      for (let i = 0; i < L; i++) {
        ds[2 * i] = half(i);
        ds[2 * i + 1] = half(i + 1);
        if (diag[i]) {
          capAt(2 * i, vd);
          for (const [k, j] of [[2 * i - 1, i - 1], [2 * i + 1, i + 1]]) {
            const kind = edgeKind(i, j);
            capAt(k, kind === 'diag' ? vd : kind === 'v90' ? vt() : vt45);
          }
          continue;
        }
        if (turnAt(i)) { capAt(2 * i, vt()); capAt(2 * i + 1, vt()); }
        if (turnAt(i + 1) && !diag[i + 1]) capAt(2 * i + 1, vt());
      }
      cap[0] = 0;
      vel[0] = 0;
      for (let k = 0; k < K; k++) vel[k + 1] = Math.min(cap[k + 1], Math.sqrt(vel[k] ** 2 + 2 * a * ds[k]));
      for (let k = K - 1; k >= 0; k--) vel[k] = Math.min(vel[k], Math.sqrt(vel[k + 1] ** 2 + 2 * a * ds[k]));
      const tn = new Float64Array(K + 1);
      for (let k = 0; k < K; k++) {
        const sum = vel[k] + vel[k + 1];
        tn[k + 1] = tn[k] + (sum > 0 ? (2 * ds[k]) / sum : Math.sqrt((2 * ds[k]) / a));
      }
      const t0 = t;
      let crashAt = -1, cause = 'corner', diagonals = 0;
      const crashed = (ratio) => r() < slipChance(ratio);
      for (let i = 1; i < L && crashAt < 0; i++) {
        if (!turnAt(i)) continue;
        if (!diag[i]) {
          if (crashed(vel[2 * i] / vCornerActual(path[i], s))) crashAt = i;
          continue;
        }
        // Entering a diagonal: a 45° flick, unless a V90 already turned us onto it.
        if (!zig(i, i - 1)) {
          if (!diag[i - 1] && crashed(vel[2 * i - 1] / corner45Actual(path[i], s))) { crashAt = i; break; }
          // Thread the whole diagonal: the fastest point decides whether a post gets clipped.
          let j = i, peakK = 2 * i;
          while (j + 1 < L && zig(j, j + 1)) j++;
          for (let k = 2 * i; k <= 2 * j; k++) if (vel[k] > vel[peakK]) peakK = k;
          diagonals++;
          if (crashed(vel[peakK] / diagSafeV())) { crashAt = Math.max(i, peakK >> 1); cause = 'diagonal'; break; }
        }
        // Leaving it: a 45° flick back to the grid, or a V90 onto the next diagonal.
        if (!zig(i, i + 1)) {
          const v90 = diag[i + 1];
          if (crashed(vel[2 * i + 1] / (v90 ? vCornerActual(path[i], s) : corner45Actual(path[i], s)))) crashAt = i;
        }
      }
      // Diagonal moves carry waypoints (cell units) so the replay can draw the real line.
      const centre = (c) => [(c % N) + 0.5, ((c / N) | 0) + 0.5];
      const edge = (j) => { const [x, y] = centre(path[j]); return [x + DX[hd[j]] / 2, y + DY[hd[j]] / 2]; };
      const node = (k) => {
        if (k & 1) return edge(k >> 1);
        const j = k >> 1;
        if (!diag[j]) return centre(path[j]);
        const [ax, ay] = edge(j - 1), [bx, by] = edge(j);
        return [(ax + bx) / 2, (ay + by) / 2];
      };
      const lastMove = crashAt >= 0 ? crashAt : L;
      for (let i = 0; i < lastMove; i++) {
        const m = { t0: t0 + tn[2 * i], t1: t0 + tn[2 * i + 2], from: path[i], to: path[i + 1], h: hd[i], ph: 'run' + n, kind: diag[i + 1] ? 'diag' : turnAt(i + 1) ? 'turn' : 'straight', v: vel[2 * i + 2] };
        if (diag[i] || diag[i + 1]) {
          m.tm = t0 + tn[2 * i + 1];
          m.pts = [node(2 * i), node(2 * i + 1), node(2 * i + 2)].map(([x, y]) => [round(x, 3), round(y, 3)]);
        }
        moves.push(m);
      }
      const finishT = t0 + tn[K - 1];
      let peak = 0;
      for (let k = 0; k <= K; k++) peak = Math.max(peak, vel[k]);
      // Speed trace for telemetry: [distance m, speed m/s, time s] at each half-cell node.
      const lastNode = crashAt >= 0 ? 2 * crashAt : K - 1;
      const profile = [];
      for (let k = 0, dist = 0; k <= lastNode; dist += ds[k] || 0, k++) profile.push([round(dist, 4), round(vel[k], 3), round(tn[k], 4)]);
      let res;
      if (crashAt >= 0) {
        const tc = t0 + tn[2 * crashAt];
        marks.push({ t: tc, type: 'crash', c: path[crashAt], run: n, cause });
        t = tc + 0.8;
        drain(t - t0, 1);
        pos = path[crashAt];
        res = { n, time: null, crashed: true, cause, aggression, at: tc, start: t0, peak, profile, diagonals };
      } else {
        marks.push({ t: finishT, type: 'finish', c: path[L], run: n });
        t = t0 + tn[K];
        drain(t - t0, 1);
        pos = path[L]; heading = hd[L - 1];
        res = { n, time: tn[K - 1], crashed: false, sag: s, aggression, at: finishT, start: t0, peak, profile, diagonals };
      }
      return res;
    }

    const good = runs.filter((x) => x.time != null);
    const best = good.length ? Math.min(...good.map((x) => x.time)) : null;
    return {
      build: b, stats: st,
      moves, learn, marks, phases,
      exploreTime, goalTime, cellsVisited, moveCount, slips,
      route, runs, best,
      energyUsed: 1 - energy / fullEnergy, flat,
      dnf: best == null ? dnf || (runs.length ? 'Both runs crashed' : 'Did not finish') : null,
      endT: t,
    };
  }

  function compareKeys(a, b) {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return 0;
  }

  // ------------------------------------------------------------ scoring
  const SCORING = {
    combined: { name: 'Run + search/30', desc: 'Best run plus a 1/30 penalty on search time — rewards efficient exploration.' },
    best: { name: 'Fastest run', desc: 'Only the best speed run counts.' },
  };
  function score(res, mode) {
    if (res.best == null) return null;
    return res.best + (mode === 'best' ? 0 : res.exploreTime / 30);
  }
  // Lower is better; DNFs rank by how far they got.
  function compareResults(a, b) {
    const sa = a.score, sb = b.score;
    if (sa != null || sb != null) {
      if (sa == null) return 1;
      if (sb == null) return -1;
      if (sa !== sb) return sa - sb;
    }
    const ga = a.result.goalTime, gb = b.result.goalTime;
    if (ga != null || gb != null) {
      if (ga == null) return 1;
      if (gb == null) return -1;
      if (ga !== gb) return ga - gb;
    }
    return a.order - b.order;
  }

  // Race every entrant independently on the same maze and environment.
  function simulateRace(maze, env, entrants, opts) {
    opts = opts || {};
    const mode = opts.scoring || 'combined';
    const rows = entrants.map((e, order) => {
      const result = simulateEntrant(maze, e.build, env, { salt: e.id });
      return { id: e.id, order, result, score: score(result, mode) };
    });
    const ranking = [...rows].sort(compareResults).map((x) => x.id);
    return {
      engine: ENGINE_VERSION, mazeSeed: maze.seed, style: maze.style, envSeed: env.seed,
      advanced: env.advanced, scoring: mode, rows, ranking,
      endT: Math.max(...rows.map((x) => x.result.endT)),
    };
  }

  // Pair heats (a vs b) out of a race: winner is whoever ranks higher.
  function decideHeats(race, heats) {
    const rank = new Map(race.ranking.map((id, i) => [id, i]));
    return heats.map(([a, b]) => ({ a, b, winner: rank.get(a) < rank.get(b) ? a : b }));
  }

  // ------------------------------------------------------------ championship
  const ROUND_NAMES = ['Quarter-finals', 'Semi-finals', 'Final'];

  function createChampionship(seed, opts) {
    opts = opts || {};
    seed = seed >>> 0;
    const r = rngFor('draw', seed);
    const ids = TEAMS.map((t) => t.id);
    for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
    const builds = {};
    for (const id of ids) builds[id] = id === opts.playerTeam && opts.playerBuild ? normalizeBuild(opts.playerBuild) : rivalBuild(id, seed);
    return {
      engine: ENGINE_VERSION, seed, advanced: !!opts.advanced, scoring: opts.scoring || 'combined',
      playerTeam: opts.playerTeam || null, builds, draw: ids,
      rounds: [], champion: null,
    };
  }

  function roundSetup(champ, i) {
    const prev = champ.rounds[i - 1];
    const field = i === 0 ? champ.draw : prev.heats.map((h) => h.winner);
    const heats = [];
    for (let k = 0; k < field.length; k += 2) heats.push([field[k], field[k + 1]]);
    const mazeSeed = hashSeed('round-maze', champ.seed, i);
    return {
      index: i, name: ROUND_NAMES[i], field, heats,
      maze: generateMaze(mazeSeed),
      env: generateEnvironment(hashSeed('round-env', champ.seed, i), champ.advanced),
    };
  }

  function runRound(champ, i) {
    const setup = roundSetup(champ, i);
    const race = simulateRace(setup.maze, setup.env, setup.field.map((id) => ({ id, build: champ.builds[id] })), { scoring: champ.scoring });
    const heats = decideHeats(race, setup.heats);
    const rd = { ...setup, race, heats };
    champ.rounds[i] = rd;
    if (heats.length === 1) champ.champion = heats[0].winner;
    return rd;
  }

  // ------------------------------------------------------------ auto-tune
  // Beginner helper: try random builds on practice mazes and keep the best.
  function autoTune(seed, opts) {
    opts = opts || {};
    const tries = opts.tries || 24, mazes = opts.mazes || 3;
    const r = rngFor('autotune', seed);
    const tracks = [];
    for (let k = 0; k < mazes; k++) {
      const s = hashSeed('tune-maze', seed, k);
      tracks.push({ maze: generateMaze(s), env: generateEnvironment(s, opts.advanced) });
    }
    let best = null;
    const tested = [];
    for (let i = 0; i < tries; i++) {
      const build = i === 0 && opts.base ? normalizeBuild(opts.base) : randomBuild(r, opts.bias);
      let total = 0, dnfs = 0;
      for (const tr of tracks) {
        const res = simulateEntrant(tr.maze, build, tr.env, { salt: 'tune' + i });
        const s = score(res, opts.scoring);
        if (s == null) { dnfs++; total += 60; } else total += s;
      }
      const row = { build, avg: total / tracks.length, dnfs };
      tested.push(row);
      if (!best || row.avg < best.avg) best = row;
    }
    return { best, tested };
  }

  // ------------------------------------------------------------ share codes
  // Codes from before diagonal steering (8 keys + 2 numbers) still decode.
  const BUILD_KEYS = ['motor', 'tires', 'fan', 'sensors', 'battery', 'policy', 'planner', 'tieBreak'];
  function encodeBuild(b) {
    b = normalizeBuild(b);
    return [...BUILD_KEYS.map((k) => b[k]), Math.round(b.aggression * 100), Math.round(b.searchSpeed * 100), b.steering, Math.round(b.diagPace * 100)].join('.');
  }
  function decodeBuild(s) {
    const p = String(s || '').split('.');
    const n = BUILD_KEYS.length;
    if (p.length !== n + 2 && p.length !== n + 4) return null;
    const b = {};
    BUILD_KEYS.forEach((k, i) => { b[k] = p[i]; });
    if (p.length === n + 4) { b.steering = p[n + 2]; b.diagPace = +p[n + 3] / 100; }
    if ([...BUILD_KEYS, 'steering'].some((k) => !CATALOG[k][b[k] || DEFAULT_BUILD[k]])) return null;
    b.aggression = +p[n] / 100;
    b.searchSpeed = +p[n + 1] / 100;
    return normalizeBuild(b);
  }

  return {
    ENGINE_VERSION, N, CELL, TURN_R, TURN_ARC, DIAG_HALF, BIT, OPP, DX, DY, DIR_NAMES, START, GOALS,
    MAZE_STYLES, PARTS, POLICIES, PLANNERS, TIEBREAKS, LIMITS, DEFAULT_BUILD, CATALOG, TEAMS, TEAM_BY_ID,
    SCORING, ROUND_NAMES,
    idx, neighbor, dirBetween, isGoal, hashSeed, rngFor, bfs,
    generateMaze, validateMaze, trueShortest, generateEnvironment,
    normalizeBuild, deriveStats, randomBuild, rivalBuild,
    simulateEntrant, simulateRace, decideHeats, score, slipChance,
    createChampionship, roundSetup, runRound, autoTune,
    encodeBuild, decodeBuild,
  };
});
