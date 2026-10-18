/*
 * MicroMouse Grand Prix — browser UI.
 *
 * Races are fully simulated up front by MMSim (deterministic), then replayed
 * here on a virtual clock. Rendering speed can never change a result; the
 * replay can be paused, scrubbed and sped up freely.
 */
(() => {
  'use strict';
  const S = window.MMSim;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  // ------------------------------------------------------------ storage
  const KEYS = { settings: 'mmgp2-settings', records: 'mmgp2-records', history: 'mmgp2-history' };
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode: keep going */ } },
  };

  // ------------------------------------------------------------ formatting
  function fmt(s) {
    if (s == null || !Number.isFinite(s)) return '—';
    const us = Math.round(s * 1e6), m = Math.floor(us / 6e7), rem = us - m * 6e7;
    return String(m).padStart(2, '0') + ':' + String(Math.floor(rem / 1e6)).padStart(2, '0') + '.' + String(rem % 1e6).padStart(6, '0');
  }
  const secs = (s, d = 3) => (s == null ? '—' : s.toFixed(d) + 's');
  const hex = (n) => (n >>> 0).toString(16).toUpperCase().padStart(8, '0');
  const randomSeed = () => (Math.random() * 2 ** 32) >>> 0;
  const team = (id) => S.TEAM_BY_ID[id];

  // ------------------------------------------------------------ settings + state
  const DEFAULT_VIEW = { trails: true, sensors: true, fog: false, flood: false, ideal: false };
  const saved = store.get(KEYS.settings, {});
  const settings = {
    advanced: !!saved.advanced,
    scoring: S.SCORING[saved.scoring] ? saved.scoring : 'combined',
    playerTeam: S.TEAM_BY_ID[saved.playerTeam] ? saved.playerTeam : 'nova',
    build: S.normalizeBuild(saved.build || S.DEFAULT_BUILD),
    speed: [0.5, 1, 2, 4, 8, 16, 32].includes(saved.speed) ? saved.speed : 2,
    view: { ...DEFAULT_VIEW, ...(saved.view || {}) },
  };
  const saveSettings = () => store.set(KEYS.settings, settings);

  const state = {
    mode: 'idle',          // idle | ready | racing | done | champion | practice
    champ: null,
    roundIdx: 0,
    setup: null,           // { maze, env, field, heats, name }
    race: null,            // MMSim race being replayed
    revealed: false,       // has the current race's outcome been shown?
    t: 0,
    playing: false,
    focus: null,
    nextSeed: randomSeed(),
    lap: null,
    tune: null,
  };

  // Share links: #s=SEED&m=adv&sc=best&t=team&b=build
  (function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    if (/^[0-9a-f]{1,8}$/i.test(p.get('s') || '')) state.nextSeed = parseInt(p.get('s'), 16) >>> 0;
    if (p.has('m')) settings.advanced = p.get('m') === 'adv';
    if (S.SCORING[p.get('sc')]) settings.scoring = p.get('sc');
    if (S.TEAM_BY_ID[p.get('t')]) settings.playerTeam = p.get('t');
    const b = S.decodeBuild(p.get('b'));
    if (b) settings.build = b;
  })();
  function shareUrl() {
    const seed = state.champ ? state.champ.seed : state.nextSeed;
    const p = new URLSearchParams({ s: hex(seed), m: settings.advanced ? 'adv' : 'std', sc: settings.scoring, t: settings.playerTeam, b: S.encodeBuild(settings.build) });
    return location.origin + location.pathname + '#' + p;
  }

  // ------------------------------------------------------------ geometry
  const CS = 40, MARGIN = 16, L = S.N * CS + MARGIN * 2;
  const cx = (c) => MARGIN + ((c % S.N) + 0.5) * CS;
  const cy = (c) => MARGIN + (Math.floor(c / S.N) + 0.5) * CS;
  const canvas = $('arena');
  const ctx = canvas.getContext('2d');
  let scale = 1, mazeLayer = null, mazeLayerKey = '';

  function resize() {
    const dpr = Math.min(2.5, window.devicePixelRatio || 1);
    const w = Math.max(200, Math.round(canvas.clientWidth * dpr));
    if (canvas.width !== w) { canvas.width = canvas.height = w; mazeLayerKey = ''; }
    scale = w / L;
  }
  new ResizeObserver(resize).observe(canvas);

  // ------------------------------------------------------------ colours
  function shade(hexColor, amt) {
    const n = parseInt(hexColor.slice(1), 16);
    const mix = (v) => Math.round(amt >= 0 ? v + (255 - v) * amt : v * (1 + amt));
    return 'rgb(' + mix(n >> 16) + ',' + mix((n >> 8) & 255) + ',' + mix(n & 255) + ')';
  }
  const alpha = (hexColor, a) => hexColor + Math.round(a * 255).toString(16).padStart(2, '0');

  // ------------------------------------------------------------ maze layer (cached)
  function buildMazeLayer(maze, env) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = canvas.width;
    const g = cv.getContext('2d');
    g.scale(scale, scale);
    const bg = g.createRadialGradient(L / 2, L / 2, 30, L / 2, L / 2, L * 0.75);
    bg.addColorStop(0, '#0f1c31'); bg.addColorStop(1, '#050911');
    g.fillStyle = bg; g.fillRect(0, 0, L, L);

    g.strokeStyle = '#ffffff07'; g.lineWidth = 1;
    g.beginPath();
    for (let i = 0; i <= S.N; i++) {
      g.moveTo(MARGIN + i * CS, MARGIN); g.lineTo(MARGIN + i * CS, MARGIN + S.N * CS);
      g.moveTo(MARGIN, MARGIN + i * CS); g.lineTo(MARGIN + S.N * CS, MARGIN + i * CS);
    }
    g.stroke();

    if (env && env.dust) {
      const r = S.rngFor('dust-art', env.seed);
      for (let c = 0; c < S.N * S.N; c++) {
        const d = env.dust[c];
        if (!d) continue;
        const x = cx(c), y = cy(c);
        const cloud = g.createRadialGradient(x, y, 2, x, y, CS * 0.75);
        cloud.addColorStop(0, `rgba(196,160,107,${0.22 * d})`); cloud.addColorStop(1, 'rgba(196,160,107,0)');
        g.fillStyle = cloud; g.fillRect(x - CS, y - CS, CS * 2, CS * 2);
        g.fillStyle = `rgba(214,182,130,${0.35 + d * 0.3})`;
        for (let k = 0; k < 6 + d * 18; k++) g.fillRect(x + (r() - 0.5) * CS, y + (r() - 0.5) * CS, 1.2, 1.2);
      }
    }

    // start box
    const sx = cx(S.START), sy = cy(S.START);
    g.fillStyle = '#34e3c012'; g.fillRect(sx - CS / 2, sy - CS / 2, CS, CS);
    g.fillStyle = '#34e3c088'; g.font = '600 7px "Chakra Petch", sans-serif'; g.textAlign = 'center';
    g.fillText('START', sx, sy + CS * 0.36);

    // goal: checkered, glowing
    const gx = MARGIN + 7 * CS, gy = MARGIN + 7 * CS;
    const glow = g.createRadialGradient(gx + CS, gy + CS, 4, gx + CS, gy + CS, CS * 2.2);
    glow.addColorStop(0, '#ffc85740'); glow.addColorStop(1, '#ffc85700');
    g.fillStyle = glow; g.fillRect(gx - CS, gy - CS, CS * 4, CS * 4);
    const q = CS / 4;
    for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) {
      g.fillStyle = (i + j) % 2 ? '#ffc8571a' : '#ffffff0a';
      g.fillRect(gx + i * q, gy + j * q, q, q);
    }

    // walls: glow pass then crisp core
    const wallPath = new Path2D();
    for (let c = 0; c < S.N * S.N; c++) {
      const x = MARGIN + (c % S.N) * CS, y = MARGIN + Math.floor(c / S.N) * CS, w = maze.walls[c];
      if (w & 1) { wallPath.moveTo(x, y); wallPath.lineTo(x + CS, y); }
      if (w & 8) { wallPath.moveTo(x, y); wallPath.lineTo(x, y + CS); }
      if (c % S.N === S.N - 1 && w & 2) { wallPath.moveTo(x + CS, y); wallPath.lineTo(x + CS, y + CS); }
      if (Math.floor(c / S.N) === S.N - 1 && w & 4) { wallPath.moveTo(x, y + CS); wallPath.lineTo(x + CS, y + CS); }
    }
    g.lineCap = 'round';
    g.save();
    g.shadowColor = '#4fd1ff'; g.shadowBlur = 9;
    g.strokeStyle = '#3aa8d8'; g.lineWidth = 4.2; g.stroke(wallPath);
    g.restore();
    g.strokeStyle = '#d9f4ff'; g.lineWidth = 1.5; g.stroke(wallPath);

    g.fillStyle = '#9fc3e6';
    for (let i = 0; i <= S.N; i++) for (let j = 0; j <= S.N; j++) g.fillRect(MARGIN + i * CS - 1.6, MARGIN + j * CS - 1.6, 3.2, 3.2);
    return cv;
  }

  // ------------------------------------------------------------ mouse sprite
  function bodyPath(g, shape, s) {
    const P = (pts) => { g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x * s, y * s) : g.moveTo(x * s, y * s))); g.closePath(); };
    switch (shape) {
      case 'wedge': P([[-0.16, -0.62], [0.16, -0.62], [0.47, 0.5], [-0.47, 0.5]]); break;
      case 'disc': g.beginPath(); g.arc(0, 0, 0.5 * s, 0, Math.PI * 2); break;
      case 'arrow': P([[0, -0.68], [0.48, 0.44], [0, 0.24], [-0.48, 0.44]]); break;
      case 'stealth': P([[0, -0.64], [0.48, 0.08], [0.3, 0.5], [-0.3, 0.5], [-0.48, 0.08]]); break;
      case 'needle': P([[0, -0.72], [0.3, -0.32], [0.3, 0.52], [-0.3, 0.52], [-0.3, -0.32]]); break;
      case 'hex': P([0, 1, 2, 3, 4, 5].map((k) => [0.52 * Math.cos((Math.PI / 3) * k - Math.PI / 2), 0.52 * Math.sin((Math.PI / 3) * k - Math.PI / 2)])); break;
      case 'box': g.beginPath(); g.roundRect(-0.44 * s, -0.5 * s, 0.88 * s, s, 0.16 * s); break;
      default: g.beginPath(); g.ellipse(0, 0.04 * s, 0.42 * s, 0.54 * s, 0, 0, Math.PI * 2);
    }
  }

  function drawMouse(g, tm, build, x, y, ang, s, o = {}) {
    g.save();
    g.translate(x, y);
    g.globalAlpha = o.alpha == null ? 1 : o.alpha;
    if (o.glow !== false) {
      const gl = g.createRadialGradient(0, 0, 0, 0, 0, s * 1.15);
      gl.addColorStop(0, alpha(tm.color, 0.4)); gl.addColorStop(1, alpha(tm.color, 0));
      g.fillStyle = gl; g.beginPath(); g.arc(0, 0, s * 1.15, 0, Math.PI * 2); g.fill();
    }
    g.rotate(ang);
    g.fillStyle = '#05080e'; g.strokeStyle = '#33445f'; g.lineWidth = s * 0.05;
    for (const side of [-1, 1]) {
      g.beginPath(); g.roundRect(side * s * 0.53 - s * 0.09, -s * 0.24, s * 0.18, s * 0.46, s * 0.06); g.fill(); g.stroke();
    }
    bodyPath(g, tm.shape, s);
    const bg = g.createLinearGradient(0, -s * 0.6, 0, s * 0.6);
    bg.addColorStop(0, shade(tm.color, 0.35)); bg.addColorStop(1, shade(tm.color, -0.15));
    g.fillStyle = bg; g.fill();
    g.strokeStyle = '#00000099'; g.lineWidth = s * 0.06; g.stroke();
    if (tm.shape === 'bug') {
      g.strokeStyle = shade(tm.color, 0.2); g.lineWidth = s * 0.05;
      g.beginPath(); g.moveTo(-s * 0.12, -s * 0.5); g.lineTo(-s * 0.26, -s * 0.78); g.moveTo(s * 0.12, -s * 0.5); g.lineTo(s * 0.26, -s * 0.78); g.stroke();
    }
    if (build && build.fan !== 'none') {
      g.strokeStyle = '#00000070'; g.lineWidth = s * 0.06;
      g.beginPath(); g.arc(0, s * 0.2, s * (build.fan === 'high' ? 0.21 : 0.15), 0, Math.PI * 2); g.stroke();
    }
    const leds = build ? S.PARTS.sensors[build.sensors].range : 1;
    g.fillStyle = '#ff3b5c'; g.shadowColor = '#ff3b5c'; g.shadowBlur = s * 0.5;
    for (let i = 0; i < leds; i++) { g.beginPath(); g.arc((i - (leds - 1) / 2) * s * 0.15, -s * 0.48, s * 0.05, 0, Math.PI * 2); g.fill(); }
    g.restore();

    g.save();
    g.globalAlpha = o.alpha == null ? 1 : o.alpha;
    g.fillStyle = '#061018';
    g.font = `700 ${Math.round(s * 0.5)}px "Chakra Petch", sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(tm.emblem, x, y + s * 0.06);
    if (o.ring) {
      g.strokeStyle = o.ring; g.lineWidth = 1.6; g.setLineDash([3, 3]);
      g.beginPath(); g.arc(x, y, s * 1.05, 0, Math.PI * 2); g.stroke();
    }
    g.restore();
  }

  function mousePreview(cv, id, build) {
    const dpr = window.devicePixelRatio || 1, w = cv.clientWidth || 34;
    cv.width = cv.height = Math.round(w * dpr);
    const g = cv.getContext('2d');
    g.scale(dpr, dpr);
    drawMouse(g, team(id), build, w / 2, w / 2 + 1, 0, w * 0.4);
  }

  // ------------------------------------------------------------ replay maths
  function poseAt(res, t) {
    const mv = res.moves;
    const startPose = { c: S.START, x: cx(S.START), y: cy(S.START), a: 0, fade: 1, moving: false };
    if (!mv.length || t <= mv[0].t0) return startPose;
    let lo = 0, hi = mv.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (mv[mid].t0 <= t) lo = mid; else hi = mid - 1; }
    const m = mv[lo];
    const f = Math.min(1, (t - m.t0) / Math.max(1e-9, m.t1 - m.t0));
    if (m.kind === 'reset') {
      const c = f < 0.5 ? m.from : m.to;
      return { c, x: cx(c), y: cy(c), a: 0, fade: Math.abs(f - 0.5) * 2, moving: false, idx: lo };
    }
    const prevH = lo > 0 && mv[lo - 1].kind !== 'reset' ? mv[lo - 1].h : m.h;
    const a0 = prevH * 90, d = ((m.h * 90 - a0 + 540) % 360) - 180;
    const a = (a0 + d * Math.min(1, f / 0.35)) * Math.PI / 180;
    let ang = a;
    for (const k of res.marks) {
      if (k.type === 'crash' && t >= k.t && t < k.t + 0.8) ang += (t - k.t) * 14;
      if (k.type === 'slip' && t >= k.t && t < k.t + 0.6) ang += Math.sin((t - k.t) * 40) * 0.35;
    }
    return {
      c: f < 1 ? m.from : m.to,
      x: cx(m.from) + (cx(m.to) - cx(m.from)) * f,
      y: cy(m.from) + (cy(m.to) - cy(m.from)) * f,
      a: ang, fade: 1, moving: t < m.t1, idx: lo, ph: m.ph,
    };
  }

  function phaseAt(res, t) {
    if (t >= res.endT) return res.best == null ? 'dnf' : 'done';
    let p = 'search';
    for (const x of res.phases) { if (x.t <= t) p = x.phase; else break; }
    return p;
  }
  const PHASE_LABEL = { search: 'Search', scan: 'Scan', return: 'Return', reset: 'Reset', run1: 'Run 1', run2: 'Run 2', done: 'Done', dnf: 'DNF' };

  function slotOffset(i, n) {
    if (n <= 1) return [0, 0];
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    return [Math.cos(a) * CS * 0.13, Math.sin(a) * CS * 0.13];
  }

  // Mouse's own map at time t (fog-of-war view).
  function knowledgeAt(res, t) {
    const kWall = new Uint8Array(S.N * S.N), unsure = new Uint8Array(S.N * S.N), seen = new Uint8Array(S.N * S.N);
    for (const e of res.learn) {
      if (e.t > t) break;
      const n = S.neighbor(e.c, e.d), b = S.BIT[e.d], ob = S.BIT[S.OPP[e.d]];
      if (e.wall) { kWall[e.c] |= b; kWall[n] |= ob; } else { kWall[e.c] &= ~b; kWall[n] &= ~ob; }
      if (e.sure) { unsure[e.c] &= ~b; unsure[n] &= ~ob; } else { unsure[e.c] |= b; unsure[n] |= ob; }
    }
    seen[S.START] = 1;
    for (const m of res.moves) { if (m.t0 > t) break; if (m.kind !== 'reset') seen[m.to] = 1; }
    for (let c = 0; c < S.N * S.N; c++) for (let d = 0; d < 4; d++) if (S.neighbor(c, d) < 0) kWall[c] |= S.BIT[d];
    return { kWall, unsure, seen };
  }

  // ------------------------------------------------------------ scene
  // What the arena is showing: the entrants (with results once raced).
  function scene() {
    if (state.race) {
      return state.race.rows.map((row, i) => ({ id: row.id, build: buildOf(row.id), res: row.result, row, i, n: state.race.rows.length }));
    }
    const field = state.setup ? state.setup.field : S.TEAMS.map((t) => t.id);
    return field.map((id, i) => ({ id, build: buildOf(id), res: null, row: null, i, n: field.length }));
  }
  function buildOf(id) {
    if (state.champ) return state.champ.builds[id];
    if (id === settings.playerTeam) return settings.build;
    return S.rivalBuild(id, state.nextSeed);
  }

  // ------------------------------------------------------------ drawing
  const confetti = [];
  let lastFrame = performance.now();

  function draw() {
    const setup = state.setup;
    if (!setup) return;
    const key = setup.maze.seed + ':' + canvas.width + ':' + (setup.env.seed || 0) + setup.env.advanced;
    if (key !== mazeLayerKey) { mazeLayer = buildMazeLayer(setup.maze, setup.env); mazeLayerKey = key; }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(mazeLayer, 0, 0);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    const t = state.t, items = scene(), v = settings.view;

    if (v.ideal) drawIdealPath(setup.maze);
    const focus = items.find((x) => x.id === state.focus && x.res);
    if (v.fog && focus) drawFog(focus, t);
    if (v.flood) drawFlood(focus, t, setup.maze);
    if (v.trails) for (const it of items) if (it.res) drawTrail(it, t, focus && focus.id !== it.id);

    for (const it of items) {
      const tm = team(it.id);
      const pose = it.res ? poseAt(it.res, t) : { x: cx(S.START), y: cy(S.START), a: 0, fade: 1 };
      const [ox, oy] = slotOffset(it.i, it.n);
      const x = pose.x + ox, y = pose.y + oy;
      const ph = it.res ? phaseAt(it.res, t) : 'search';
      if (v.sensors && it.res && ['search', 'scan', 'return'].includes(ph) && pose.moving) drawRays(it, pose, x, y);
      const dim = focus && focus.id !== it.id ? 0.35 : 1;
      drawMouse(ctx, tm, it.build, x, y, pose.a, CS * 0.34, {
        alpha: pose.fade * dim,
        ring: it.id === settings.playerTeam ? '#ffffffcc' : it.id === state.focus ? tm.color : null,
      });
      if (it.res) drawEffects(it, t);
    }
    drawConfetti();
  }

  function drawIdealPath(maze) {
    const dist = S.bfs(S.GOALS, (c, d) => maze.walls[c] & S.BIT[d]);
    ctx.save();
    ctx.strokeStyle = '#ffc857aa'; ctx.lineWidth = 2; ctx.setLineDash([5, 5]);
    ctx.beginPath();
    let c = S.START;
    ctx.moveTo(cx(c), cy(c));
    while (dist[c] > 0) {
      let next = -1;
      for (let d = 0; d < 4; d++) {
        const n = S.neighbor(c, d);
        if (n >= 0 && !(maze.walls[c] & S.BIT[d]) && dist[n] === dist[c] - 1) { next = n; break; }
      }
      if (next < 0) break;
      c = next;
      ctx.lineTo(cx(c), cy(c));
    }
    ctx.stroke();
    ctx.restore();
  }

  function drawFog(it, t) {
    const k = knowledgeAt(it.res, t), tm = team(it.id);
    ctx.save();
    ctx.fillStyle = 'rgba(3,6,12,0.74)';
    for (let c = 0; c < S.N * S.N; c++) if (!k.seen[c]) ctx.fillRect(MARGIN + (c % S.N) * CS, MARGIN + Math.floor(c / S.N) * CS, CS, CS);
    ctx.lineCap = 'round'; ctx.lineWidth = 2.4; ctx.strokeStyle = tm.color; ctx.shadowColor = tm.color; ctx.shadowBlur = 6;
    for (const sure of [true, false]) {
      ctx.setLineDash(sure ? [] : [3, 4]);
      ctx.beginPath();
      for (let c = 0; c < S.N * S.N; c++) {
        const x = MARGIN + (c % S.N) * CS, y = MARGIN + Math.floor(c / S.N) * CS;
        for (const d of [0, 3]) {
          if (!(k.kWall[c] & S.BIT[d]) || S.neighbor(c, d) < 0) continue;
          if (!!(k.unsure[c] & S.BIT[d]) === sure) continue;
          if (d === 0) { ctx.moveTo(x, y); ctx.lineTo(x + CS, y); } else { ctx.moveTo(x, y); ctx.lineTo(x, y + CS); }
        }
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawFlood(it, t, maze) {
    let blocked, targets = S.GOALS;
    if (it) {
      const k = knowledgeAt(it.res, t);
      blocked = (c, d) => k.kWall[c] & S.BIT[d];
      const ph = phaseAt(it.res, t);
      if (ph === 'return' || ph === 'reset') targets = [S.START];
    } else blocked = (c, d) => maze.walls[c] & S.BIT[d];
    const dist = S.bfs(targets, blocked);
    ctx.save();
    ctx.font = '600 10px "JetBrains Mono", monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let c = 0; c < S.N * S.N; c++) {
      if (dist[c] < 0) continue;
      ctx.fillStyle = dist[c] === 0 ? '#ffc857' : `rgba(160,190,230,${0.75 - Math.min(0.45, dist[c] / 80)})`;
      ctx.fillText(dist[c], cx(c), cy(c) - CS * 0.28);
    }
    ctx.restore();
  }

  function drawTrail(it, t, dimmed) {
    const tm = team(it.id), mv = it.res.moves;
    const [ox, oy] = slotOffset(it.i, it.n);
    const isRun = (ph) => ph === 'run1' || ph === 'run2';
    let curRun = null;
    for (const m of mv) { if (m.t0 > t) break; curRun = isRun(m.ph) ? m.ph : curRun && m.ph === 'reset' ? null : curRun; }
    ctx.save();
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    // exploration trail
    ctx.strokeStyle = alpha(tm.color, dimmed ? 0.12 : 0.32); ctx.lineWidth = 1.6;
    ctx.beginPath();
    let open = false;
    for (const m of mv) {
      if (m.t0 > t) break;
      if (isRun(m.ph) || m.kind === 'reset' || m.ph === 'reset') { open = false; continue; }
      const f = Math.min(1, (t - m.t0) / Math.max(1e-9, m.t1 - m.t0));
      if (!open) { ctx.moveTo(cx(m.from) + ox, cy(m.from) + oy); open = true; }
      ctx.lineTo(cx(m.from) + (cx(m.to) - cx(m.from)) * f + ox, cy(m.from) + (cy(m.to) - cy(m.from)) * f + oy);
    }
    ctx.stroke();
    // current speed run, bright
    if (curRun) {
      ctx.strokeStyle = alpha(tm.color, dimmed ? 0.3 : 0.95); ctx.lineWidth = 3;
      ctx.shadowColor = tm.color; ctx.shadowBlur = dimmed ? 0 : 10;
      ctx.beginPath();
      let first = true;
      for (const m of mv) {
        if (m.t0 > t) break;
        if (m.ph !== curRun) continue;
        const f = Math.min(1, (t - m.t0) / Math.max(1e-9, m.t1 - m.t0));
        if (first) { ctx.moveTo(cx(m.from) + ox, cy(m.from) + oy); first = false; }
        ctx.lineTo(cx(m.from) + (cx(m.to) - cx(m.from)) * f + ox, cy(m.from) + (cy(m.to) - cy(m.from)) * f + oy);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawRays(it, pose, x, y) {
    const tm = team(it.id), walls = state.setup.maze.walls;
    const range = S.PARTS.sensors[it.build.sensors].range;
    const h = Math.round(((pose.a * 180) / Math.PI) / 90) & 3;
    let c = pose.c, len = 0;
    for (let k = 0; k < range; k++) {
      if (walls[c] & S.BIT[h]) break;
      c = S.neighbor(c, h); len++;
      if (c < 0) break;
    }
    const reach = len * CS + CS * 0.5;
    const ex = x + S.DX[h] * reach, ey = y + S.DY[h] * reach;
    ctx.save();
    const gr = ctx.createLinearGradient(x, y, ex, ey);
    gr.addColorStop(0, alpha(tm.color, 0.5)); gr.addColorStop(1, alpha(tm.color, 0));
    ctx.strokeStyle = gr; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(ex, ey);
    for (const side of [-1, 1]) {
      const sh = (h + (side > 0 ? 1 : 3)) % 4;
      ctx.moveTo(x, y);
      ctx.lineTo(x + (S.DX[h] + S.DX[sh]) * CS * 0.42, y + (S.DY[h] + S.DY[sh]) * CS * 0.42);
    }
    ctx.stroke();
    ctx.restore();
  }

  function drawEffects(it, t) {
    const tm = team(it.id);
    for (const k of it.res.marks) {
      const age = t - k.t;
      if (age < 0) continue;
      const x = cx(k.c), y = cy(k.c);
      if (k.type === 'goal' && age < 0.9) ring(x, y, CS * (0.3 + age * 1.6), tm.color, 1 - age / 0.9);
      if (k.type === 'finish' && age < 1.8) {
        ring(x, y, CS * (0.4 + age * 1.2), '#ffc857', 1 - age / 1.8);
        label(x, y - CS * 0.6 - age * 14, `RUN ${k.run}  ${secs(it.res.runs[k.run - 1].time)}`, tm.color, 1 - age / 1.8);
      }
      if (k.type === 'crash' && age < 1.6) { ring(x, y, CS * (0.3 + age), '#ff5d73', 1 - age / 1.6); label(x, y - CS * 0.6 - age * 10, 'CRASH', '#ff5d73', 1 - age / 1.6); }
      if (k.type === 'slip' && age < 1) label(x, y - CS * 0.55 - age * 12, 'SLIP', '#ffc857', 1 - age);
      if (k.type === 'flat' && age < 2) label(x, y - CS * 0.55 - age * 8, 'BATTERY FLAT', '#ff9f1c', 1 - age / 2);
    }
  }
  function ring(x, y, r, color, a) {
    ctx.save(); ctx.globalAlpha = Math.max(0, a); ctx.strokeStyle = color; ctx.lineWidth = 2.2;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
  }
  function label(x, y, text, color, a) {
    ctx.save(); ctx.globalAlpha = Math.max(0, Math.min(1, a));
    ctx.font = '700 11px "Chakra Petch", sans-serif'; ctx.textAlign = 'center';
    ctx.lineWidth = 3.5; ctx.strokeStyle = '#050911'; ctx.strokeText(text, x, y);
    ctx.fillStyle = color; ctx.fillText(text, x, y); ctx.restore();
  }

  function burst(colors, n) {
    for (let i = 0; i < n; i++) {
      confetti.push({
        x: L / 2 + (Math.random() - 0.5) * 60, y: L / 2,
        vx: (Math.random() - 0.5) * 520, vy: -Math.random() * 520 - 120,
        r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 12,
        c: colors[i % colors.length], life: 2.6 + Math.random() * 1.4,
      });
    }
  }
  function drawConfetti() {
    if (!confetti.length) return;
    const dt = Math.min(0.05, (performance.now() - lastFrame) / 1000 || 0.016);
    for (let i = confetti.length - 1; i >= 0; i--) {
      const p = confetti[i];
      p.vy += 620 * dt; p.vx *= 0.99; p.x += p.vx * dt; p.y += p.vy * dt; p.r += p.vr * dt; p.life -= dt;
      if (p.life <= 0 || p.y > L + 20) { confetti.splice(i, 1); continue; }
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.globalAlpha = Math.min(1, p.life);
      ctx.fillStyle = p.c; ctx.fillRect(-4, -2, 8, 4); ctx.restore();
    }
  }

  // ------------------------------------------------------------ main loop
  let towerKey = '', logCount = -1;
  function frame(now) {
    const dt = Math.min(0.1, (now - lastFrame) / 1000);
    if (state.playing && state.race) {
      state.t = Math.min(endOf(), state.t + dt * settings.speed);
      if (state.t >= endOf()) { state.playing = false; onRaceEnd(); syncControls(); }
    }
    draw();
    lastFrame = now;
    $('clock').textContent = fmt(state.t);
    if (state.race && document.activeElement !== $('scrub')) $('scrub').value = Math.round((state.t / endOf()) * 1000);
    const k = state.race ? Math.floor(state.t * 20) + ':' + state.focus + state.revealed : 'static' + state.focus + state.mode;
    if (k !== towerKey) { towerKey = k; renderTower(); renderSpec(); }
    renderLog();
    requestAnimationFrame(frame);
  }
  const endOf = () => (state.race ? state.race.endT + 1.2 : 0);

  // ------------------------------------------------------------ flow
  function prepareIdle() {
    state.mode = 'idle';
    state.champ = null; state.race = null; state.revealed = false; state.t = 0; state.playing = false; state.focus = null;
    const s = state.nextSeed;
    state.setup = { name: 'Paddock', maze: S.generateMaze(S.hashSeed('round-maze', s, 0)), env: S.generateEnvironment(S.hashSeed('round-env', s, 0), settings.advanced), field: S.TEAMS.map((t) => t.id), heats: [] };
    $('banner').classList.add('hidden');
    renderAll();
  }

  function startChampionship() {
    state.champ = S.createChampionship(state.nextSeed, {
      advanced: settings.advanced, scoring: settings.scoring,
      playerTeam: settings.playerTeam, playerBuild: settings.build,
    });
    state.lap = null;
    prepareRound(0);
  }

  function prepareRound(i) {
    state.roundIdx = i;
    state.setup = S.roundSetup(state.champ, i);
    state.race = null; state.revealed = false; state.t = 0; state.playing = false;
    state.mode = 'ready';
    if (state.focus && !state.setup.field.includes(state.focus)) state.focus = null;
    $('banner').classList.add('hidden');
    renderAll();
  }

  function runRound() {
    const rd = S.runRound(state.champ, state.roundIdx);
    state.setup = rd;
    state.race = rd.race;
    state.t = 0; state.playing = true; state.revealed = false;
    state.mode = 'racing';
    renderAll();
  }

  function startPractice() {
    const seed = randomSeed();
    const maze = S.generateMaze(seed), env = S.generateEnvironment(seed, settings.advanced);
    const race = S.simulateRace(maze, env, [{ id: settings.playerTeam, build: settings.build }], { scoring: settings.scoring });
    state.champ = null;
    state.setup = { name: 'Test lap', maze, env, field: [settings.playerTeam], heats: [] };
    state.race = race; state.t = 0; state.playing = true; state.revealed = false;
    state.mode = 'practice'; state.focus = settings.playerTeam;
    $('banner').classList.add('hidden');
    renderAll();
  }

  function onRaceEnd() {
    if (state.revealed || !state.race) return;
    state.revealed = true;
    if (state.mode === 'practice') {
      const row = state.race.rows[0], r = row.result;
      state.lap = { score: row.score, best: r.best, explore: r.exploreTime, runs: r.runs, cells: r.cellsVisited, energy: r.energyUsed, slips: r.slips, dnf: r.dnf, style: state.setup.maze.label };
      showBanner('Test lap complete', row.score == null ? `DNF: ${r.dnf}` : `Score ${secs(row.score)} · best run ${secs(r.best)} · search ${secs(r.exploreTime, 2)}`, 'Run another', startPractice);
      renderGarage();
      return;
    }
    recordRace(state.race, state.setup);
    const rd = state.champ.rounds[state.roundIdx];
    if (state.champ.champion) {
      state.mode = 'champion';
      const champ = team(state.champ.champion);
      recordHistory();
      const mine = state.champ.champion === settings.playerTeam;
      showBanner(`🏆 ${champ.name} are champions`, mine ? 'Your engineering won the Grand Prix!' : `${state.champ.rounds.length} rounds, ${state.champ.rounds.length} fresh mazes.`, 'New championship', newChampionship, 'champion');
      burst([champ.color, '#ffc857', '#ffffff', shade(champ.color, 0.4)], 180);
    } else {
      state.mode = 'done';
      const adv = rd.heats.map((h) => team(h.winner).name).join(', ');
      const out = settings.playerTeam && rd.field.includes(settings.playerTeam) && !rd.heats.some((h) => h.winner === settings.playerTeam);
      showBanner(`${rd.name} complete`, (out ? 'Your mouse is out. ' : '') + 'Advancing: ' + adv, 'Continue to ' + S.ROUND_NAMES[state.roundIdx + 1], () => prepareRound(state.roundIdx + 1));
    }
    renderAll();
  }

  function newChampionship() {
    state.nextSeed = randomSeed();
    history.replaceState(null, '', location.pathname);
    prepareIdle();
  }

  function showBanner(title, sub, action, fn, cls) {
    const b = $('banner');
    b.className = 'banner' + (cls ? ' ' + cls : '');
    b.innerHTML = `<div><div class="b-title">${esc(title)}</div><div class="b-sub">${esc(sub)}</div></div>`;
    if (action) {
      const btn = document.createElement('button');
      btn.className = 'cta'; btn.textContent = action;
      btn.onclick = () => { b.classList.add('hidden'); fn(); };
      b.appendChild(btn);
    }
  }

  // ------------------------------------------------------------ records
  function recordRace(race, setup) {
    const rec = store.get(KEYS.records, []);
    for (const row of race.rows) {
      if (row.result.best == null) continue;
      rec.push({ time: row.result.best, team: row.id, mine: row.id === settings.playerTeam, style: setup.maze.label, seed: hex(setup.maze.seed), adv: race.advanced, round: setup.name, at: Date.now() });
    }
    rec.sort((a, b) => a.time - b.time);
    store.set(KEYS.records, rec.slice(0, 40));
  }
  function recordHistory() {
    const h = store.get(KEYS.history, []);
    const c = state.champ;
    let reached = 'Quarter-finals';
    c.rounds.forEach((rd) => { if (rd.field.includes(c.playerTeam)) reached = rd.name; });
    if (c.champion === c.playerTeam) reached = 'Champion';
    h.unshift({ at: Date.now(), seed: hex(c.seed), champion: c.champion, player: c.playerTeam, reached, adv: c.advanced, scoring: c.scoring });
    store.set(KEYS.history, h.slice(0, 60));
  }

  // ------------------------------------------------------------ rendering: chrome
  function renderAll() {
    syncControls();
    renderHeader();
    renderTower();
    renderSpec();
    renderGarage();
    renderBracket();
    renderRecords();
    logCount = -1;
    renderLog();
  }

  function syncControls() {
    const m = state.mode, hasRace = !!state.race;
    const cta = $('cta');
    const labels = {
      idle: 'Start championship',
      ready: 'Start ' + (state.setup && state.setup.name),
      racing: state.revealed ? 'Results in' : 'Racing…',
      done: 'Continue to ' + (S.ROUND_NAMES[state.roundIdx + 1] || ''),
      champion: 'New championship',
      practice: 'Start championship',
    };
    cta.textContent = labels[m];
    cta.disabled = m === 'racing';
    $('practiceBtn').disabled = !['idle', 'practice', 'champion'].includes(m);
    $('newBtn').classList.toggle('hidden', ['idle', 'practice', 'champion'].includes(m));
    ['restartBtn', 'skipBtn', 'scrub'].forEach((id) => { $(id).disabled = !hasRace; });
    $('playBtn').disabled = !hasRace;
    $('playBtn').textContent = state.playing ? '❚❚' : '▶';
    $('playBtn').setAttribute('aria-label', state.playing ? 'Pause' : 'Play');
    const locked = !['idle', 'practice', 'champion'].includes(m);
    document.querySelectorAll('#modeSeg button').forEach((b) => {
      b.classList.toggle('on', (b.dataset.mode === 'advanced') === settings.advanced);
      b.setAttribute('aria-checked', String((b.dataset.mode === 'advanced') === settings.advanced));
      b.disabled = locked;
    });
    $('scoring').disabled = locked;
    $('scoring').value = settings.scoring;
    document.querySelectorAll('#speedSeg button').forEach((b) => b.classList.toggle('on', +b.dataset.speed === settings.speed));
    document.querySelectorAll('#toggles .toggle').forEach((b) => b.classList.toggle('on', !!settings.view[b.dataset.view]));
    const status = {
      idle: 'Tune your mouse in the garage, then start an 8-mouse elimination championship. Your build locks when the championship starts.',
      ready: 'Every mouse races the same unseen maze independently. Heat winners advance.',
      racing: 'Mice search for the centre, return, then make two timed speed runs: a safe banker, then an all-out attack.',
      done: 'Round complete: a fresh maze awaits the survivors.',
      champion: 'Championship over. Your garage is unlocked: tune, take a test lap, and go again.',
      practice: 'Test lap: your build alone on a fresh maze. Nothing counts toward records.',
    };
    $('status').textContent = status[m];
  }

  function renderHeader() {
    const s = state.setup;
    const seed = state.champ ? state.champ.seed : state.nextSeed;
    $('seedLabel').textContent = 'SEED ' + hex(seed);
    if (state.mode === 'practice') {
      $('roundEyebrow').textContent = 'Test lap · ' + team(settings.playerTeam).name;
      $('roundTitle').textContent = s.maze.label;
    } else if (state.champ) {
      $('roundEyebrow').textContent = `Round ${state.roundIdx + 1} of 3 · ${s.name}`;
      $('roundTitle').textContent = `${s.maze.label} · ${s.field.length} mice`;
    } else {
      $('roundEyebrow').textContent = 'Paddock';
      $('roundTitle').textContent = 'Build your mouse, then start a championship';
    }
    const env = s.env;
    const chips = [];
    chips.push(`<span>${settings.advanced ? 'Advanced' : 'Standard'}</span>`);
    chips.push(`<span>${esc(S.SCORING[settings.scoring].name)}</span>`);
    if (state.mode !== 'idle') for (const c of env.conditions) chips.push(`<span class="${/Slick|glare|Cold/.test(c) ? 'bad' : /dust/.test(c) ? 'warn' : ''}">${esc(c)}</span>`);
    $('envChips').innerHTML = chips.join('');
  }

  // ------------------------------------------------------------ tower
  function renderTower() {
    const box = $('tower');
    const items = scene();
    const t = state.t;
    const heats = state.setup && state.setup.heats && state.setup.heats.length ? state.setup.heats : null;
    const rowHtml = (it, outFlag, win) => {
      const tm = team(it.id);
      let ph = 'search', time = '', timeCls = 'time live', sub = esc(tm.bio);
      if (it.res) {
        const r = it.res;
        ph = phaseAt(r, t);
        const bits = [];
        if (r.goalTime != null && t >= r.goalTime) bits.push('centre ' + secs(r.goalTime, 2));
        if (t >= r.exploreTime) bits.push('search ' + secs(r.exploreTime, 2));
        for (const run of r.runs) if (t >= run.at) bits.push(`R${run.n} ${run.crashed ? 'crash' : secs(run.time)}`);
        sub = bits.join(' · ') || `${countSeen(r, t)} cells mapped`;
        if (ph === 'done' || ph === 'dnf') { time = it.row.score == null ? 'DNF' : fmt(it.row.score); timeCls = 'time'; }
        else if (ph === 'run1' || ph === 'run2') {
          const p = r.phases.find((x) => x.phase === ph), run = r.runs[ph === 'run1' ? 0 : 1];
          time = fmt(t >= run.at ? (run.time != null ? run.time : run.at - p.t) : t - p.t);
        } else time = fmt(Math.min(t, r.exploreTime));
      }
      const you = it.id === settings.playerTeam ? '<span class="you">YOU</span>' : '';
      return `<div class="row${it.id === state.focus ? ' focus' : ''}${outFlag ? ' out' : ''}" data-id="${it.id}">
        <div class="bar" style="background:${tm.color}"></div>
        <div><div class="name">${esc(tm.name)} ${you}<span class="pill ${ph}">${PHASE_LABEL[ph]}</span></div><div class="sub">${sub}</div></div>
        <div class="right"><span class="${timeCls}">${time || '&nbsp;'}</span>${win ? '<span class="win">✔ ADV</span>' : ''}</div></div>`;
    };
    if (!state.race && !state.setup) { box.innerHTML = ''; return; }
    if (state.mode === 'idle') {
      box.innerHTML = '<div class="empty">Eight teams are in the paddock. Start a championship to draw the heats.</div>' + items.map((it) => rowHtml(it)).join('');
      return;
    }
    if (!heats) { box.innerHTML = items.map((it) => rowHtml(it)).join(''); return; }
    const byId = Object.fromEntries(items.map((x) => [x.id, x]));
    const decided = state.race ? Object.fromEntries((state.champ.rounds[state.roundIdx] || { heats: [] }).heats.map((h) => [h.a, h])) : {};
    box.innerHTML = heats.map((h, i) => {
      const [a, b] = Array.isArray(h) ? h : [h.a, h.b];
      const res = decided[a];
      const done = res && byId[a].res && byId[b].res && t >= Math.max(byId[a].res.endT, byId[b].res.endT);
      let order = [a, b];
      if (done && res.winner === b) order = [b, a];
      return `<div class="heat"><div class="heat-label"><span>Heat ${i + 1}</span><span>${done ? team(res.winner).short + ' advances' : 'head to head'}</span></div>
        ${order.map((id) => rowHtml(byId[id], done && res.winner !== id, done && res.winner === id)).join('')}</div>`;
    }).join('');
  }
  function countSeen(r, t) {
    const s = new Set([S.START]);
    for (const m of r.moves) { if (m.t0 > t) break; s.add(m.to); }
    return s.size;
  }

  // ------------------------------------------------------------ spec sheet
  function renderSpec() {
    const card = $('specCard');
    const id = state.focus;
    if (!id) { card.classList.add('hidden'); return; }
    const tm = team(id), b = buildOf(id), st = S.deriveStats(b);
    const it = scene().find((x) => x.id === id);
    const r = it && it.res;
    const P = S.PARTS;
    const live = r ? `
      <div><span class="muted">Cells mapped</span><b>${countSeen(r, state.t)}</b></div>
      <div><span class="muted">Route</span><b>${state.t >= r.exploreTime && r.route ? r.route.length - 1 + ' cells' : '…'}</b></div>
      <div><span class="muted">Slides</span><b>${r.marks.filter((k) => k.type === 'slip' && k.t <= state.t).length}</b></div>
      <div><span class="muted">Battery used</span><b>${state.t >= r.endT ? Math.round(r.energyUsed * 100) + '%' : '…'}</b></div>` : '';
    card.innerHTML = `
      <div class="spec-title"><canvas id="specMouse"></canvas><div><div class="t" style="color:${tm.color}">${esc(tm.name)}</div><div class="bio">${esc(tm.bio)}</div></div>
      <button class="icon-btn" id="specClose" style="margin-left:auto;width:30px;height:30px" aria-label="Close">✕</button></div>
      <div class="spec-grid">
        <div><span class="muted">Motor</span><b>${P.motor[b.motor].name}</b></div>
        <div><span class="muted">Tires</span><b>${P.tires[b.tires].name}</b></div>
        <div><span class="muted">Suction</span><b>${P.fan[b.fan].name}</b></div>
        <div><span class="muted">Sensors</span><b>${P.sensors[b.sensors].name.replace(/ \(.*/, '')}</b></div>
        <div><span class="muted">Battery</span><b>${P.battery[b.battery].name}</b></div>
        <div><span class="muted">Policy</span><b>${S.POLICIES[b.policy].name}</b></div>
        <div><span class="muted">Planner</span><b>${S.PLANNERS[b.planner].name}</b></div>
        <div><span class="muted">Tie-break</span><b>${S.TIEBREAKS[b.tieBreak].name}</b></div>
        <div><span class="muted">Aggression</span><b>${Math.round(b.aggression * 100)}%</b></div>
        <div><span class="muted">Search pace</span><b>${Math.round(b.searchSpeed * 100)}%</b></div>
        <div><span class="muted">Mass</span><b>${st.massG} g</b></div>
        <div><span class="muted">Top / corner</span><b>${st.vmax.toFixed(2)} / ${st.cornerSpeed.toFixed(2)} m/s</b></div>
        ${live}
      </div>`;
    card.classList.remove('hidden');
    mousePreview($('specMouse'), id, b);
    $('specClose').onclick = () => { state.focus = null; towerKey = ''; };
  }

  // ------------------------------------------------------------ garage
  const PART_ROWS = [
    ['motor', 'Motor'], ['tires', 'Tires'], ['fan', 'Suction'], ['sensors', 'Sensors'], ['battery', 'Battery'],
  ];
  const STRAT_ROWS = [['policy', 'Search policy'], ['planner', 'Speed-run planner'], ['tieBreak', 'Flood-fill tie-break']];

  function renderGarage() {
    const box = $('tab-garage');
    const locked = !['idle', 'practice', 'champion'].includes(state.mode);
    const b = settings.build, st = S.deriveStats(b);
    const dis = locked ? 'disabled' : '';
    const optRow = ([k, label]) => {
      const cat = S.CATALOG[k], keys = Object.keys(cat);
      return `<div class="part-row"><div class="label">${label}</div><div class="opts${keys.length === 4 ? ' four' : ''}">
        ${keys.map((v) => `<button class="opt${b[k] === v ? ' on' : ''}" data-k="${k}" data-v="${v}" ${dis} title="${esc(cat[v].desc)}">
          <span class="on-name">${esc(cat[v].name)}</span><span class="desc">${esc(cat[v].desc)}</span></button>`).join('')}
      </div></div>`;
    };
    const searchW = 0.6 + st.motorW * (0.35 + 0.65 * b.searchSpeed) + st.fanW;
    const endurance = st.energy / searchW;
    const limitBy = st.gripCorner < st.yawCorner ? 'grip' : 'yaw';
    const stat = (k, v, frac, note) => `<div class="stat"><span class="k">${k}</span><div class="meter"><i style="width:${Math.max(4, Math.min(100, frac * 100))}%"></i></div><span class="v">${v}</span></div>${note ? `<div class="muted small" style="margin:-4px 0 0 122px">${note}</div>` : ''}`;
    const tune = state.tune;
    const lap = state.lap;
    box.innerHTML = `
      ${locked ? `<div class="lockbar">🔒 <span><b>Homologated.</b> Builds are locked for the rest of this championship. Click any mouse in Live timing to inspect its spec.</span></div>` : ''}
      <h4 style="margin-top:0">Your team</h4>
      <div class="team-pick">${S.TEAMS.map((t) => `<button class="team-btn${t.id === settings.playerTeam ? ' on' : ''}" style="--tc:${t.color}" data-team="${t.id}" ${dis} title="${esc(t.bio)}"><canvas data-prev="${t.id}"></canvas>${t.short}</button>`).join('')}</div>
      <h4>Hardware</h4>
      <div class="parts">${PART_ROWS.map(optRow).join('')}</div>
      <h4>Brains</h4>
      <div class="parts">${STRAT_ROWS.map(optRow).join('')}</div>
      <h4>Tuning</h4>
      <div class="sliders">
        <div class="slider"><label>Corner aggression <b id="aggVal">${Math.round(b.aggression * 100)}%</b></label>
          <input type="range" id="agg" min="70" max="110" step="1" value="${Math.round(b.aggression * 100)}" ${dis}>
          <div class="hint">Share of the cornering limit used on the attack run. Above 100% risks crashes; dust and slick surfaces lower the limit without warning.</div></div>
        <div class="slider"><label>Search pace <b id="ssVal">${Math.round(b.searchSpeed * 100)}%</b></label>
          <input type="range" id="ss" min="25" max="70" step="1" value="${Math.round(b.searchSpeed * 100)}" ${dis}>
          <div class="hint">Cruise speed while exploring, as a share of top speed. Faster searches save time but drain the battery and slide more.</div></div>
      </div>
      <h4>Engineering readout</h4>
      <div class="stats">
        ${stat('Mass', st.massG + ' g', (110 - st.massG) / 60)}
        ${stat('Top speed', st.vmax.toFixed(2) + ' m/s', st.vmax / 3.8)}
        ${stat('Acceleration', st.accel.toFixed(1) + ' m/s²', st.accel / 14, st.motorAccel < st.tractionAccel ? 'motor-limited: more torque would help' : 'traction-limited: more grip would help')}
        ${stat('Corner speed', st.cornerSpeed.toFixed(2) + ' m/s', (st.cornerSpeed - 0.6) / 0.8, limitBy === 'grip' ? 'grip-limited: tires or suction would help' : 'yaw-limited: lighter or punchier would help')}
        ${stat('Search cruise', st.searchCruise.toFixed(2) + ' m/s', st.searchCruise / 2)}
        ${stat('Endurance', (endurance / 60).toFixed(1) + ' min', endurance / 120, 'at search pace, before the battery sags')}
        ${stat('Sensor range', st.range + (st.range > 1 ? ' cells' : ' cell'), st.range / 4)}
      </div>
      <div class="formula">Corner speed = min( grip <code>√(μ·N/m·r)</code> = ${st.gripCorner.toFixed(2)}, yaw <code>k·√(F/m)</code> = ${st.yawCorner.toFixed(2)} ) m/s, with turn radius r = 9 cm. Suction raises N, the normal force, without adding much mass.</div>
      <div class="btn-row">
        <button class="btn primary" id="tuneBtn" ${dis}>⚙ Wind-tunnel auto-tune</button>
        <button class="btn" id="randBtn" ${dis}>🎲 Random build</button>
        <button class="btn" id="defBtn" ${dis}>Reset</button>
      </div>
      ${tune ? `<div class="lap">${tune}</div>` : ''}
      ${lap ? `<div class="lap"><b>Last test lap</b> · ${esc(lap.style)}<br>${lap.score == null ? 'DNF: ' + esc(lap.dnf) : `Score <b>${secs(lap.score)}</b> · best run <b>${secs(lap.best)}</b> · search <b>${secs(lap.explore, 2)}</b>`}<br>
        Runs: ${lap.runs.map((r) => (r.crashed ? 'crash' : secs(r.time))).join(' / ')} · ${lap.cells} cells mapped · ${lap.slips} slides · battery ${Math.round(lap.energy * 100)}%</div>` : ''}`;
    box.querySelectorAll('canvas[data-prev]').forEach((cv) => mousePreview(cv, cv.dataset.prev, cv.dataset.prev === settings.playerTeam ? settings.build : S.rivalBuild(cv.dataset.prev, state.nextSeed)));
  }

  function setBuild(patch) {
    settings.build = S.normalizeBuild({ ...settings.build, ...patch });
    saveSettings();
    renderGarage();
    if (state.mode === 'idle') renderTower();
  }


  $('tab-garage').addEventListener('click', (e) => {
    const opt = e.target.closest('.opt');
    if (opt && !opt.disabled) return setBuild({ [opt.dataset.k]: opt.dataset.v });
    const tb = e.target.closest('.team-btn');
    if (tb && !tb.disabled) { settings.playerTeam = tb.dataset.team; saveSettings(); renderGarage(); renderTower(); return; }
    if (e.target.id === 'randBtn') { state.tune = null; return setBuild(S.randomBuild(S.rngFor('ui-random', randomSeed()))); }
    if (e.target.id === 'defBtn') { state.tune = null; return setBuild(S.DEFAULT_BUILD); }
    if (e.target.id === 'tuneBtn') {
      e.target.disabled = true; e.target.textContent = '⚙ Testing 30 builds on 3 mazes…';
      setTimeout(() => {
        const out = S.autoTune(randomSeed(), { tries: 30, mazes: 3, advanced: settings.advanced, scoring: settings.scoring, base: settings.build });
        const before = out.tested[0].avg;
        if (out.best.avg < before) {
          state.tune = `<b>Wind tunnel:</b> tested 30 builds on 3 practice mazes. The best averaged <b>${secs(out.best.avg)}</b> against <b>${secs(before)}</b> for your old build, so it's now your build.`;
          setBuild(out.best.build);
        } else {
          state.tune = `<b>Wind tunnel:</b> tested 30 builds on 3 practice mazes. None beat your current build (avg <b>${secs(before)}</b>). Nice engineering!`;
          renderGarage();
        }
      }, 30);
    }
  });
  $('tab-garage').addEventListener('input', (e) => {
    if (e.target.id === 'agg') { $('aggVal').textContent = e.target.value + '%'; settings.build.aggression = +e.target.value / 100; }
    if (e.target.id === 'ss') { $('ssVal').textContent = e.target.value + '%'; settings.build.searchSpeed = +e.target.value / 100; }
  });
  $('tab-garage').addEventListener('change', (e) => {
    if (e.target.id === 'agg' || e.target.id === 'ss') setBuild({});
  });

  // ------------------------------------------------------------ bracket
  function renderBracket() {
    const box = $('tab-bracket');
    const c = state.champ;
    if (!c) {
      box.innerHTML = `<p class="muted">Start a championship to draw the bracket. Eight teams, three rounds, a new maze every round.</p>
        <h4>The field</h4>${S.TEAMS.map((t) => `<div class="row" data-id="${t.id}" style="cursor:default"><div class="bar" style="background:${t.color}"></div><div><div class="name">${esc(t.name)}</div><div class="sub">${esc(t.bio)}</div></div><div></div></div>`).join('')}`;
      return;
    }
    const shown = state.revealed ? state.roundIdx + 1 : state.roundIdx;
    const score = (i, id) => {
      const rd = c.rounds[i];
      if (!rd || i >= shown) return '';
      const row = rd.race.rows.find((r) => r.id === id);
      return row && row.score != null ? row.score.toFixed(3) : 'DNF';
    };
    const slot = (i, id, winner) => {
      if (!id) return '<div class="slot tbd"><span class="nm">TBD</span></div>';
      const decided = i < shown;
      const cls = decided ? (winner === id ? 'win' : 'lose') : '';
      const tm = team(id);
      return `<div class="slot ${cls}"><span class="nm"><span class="dot" style="background:${tm.color}"></span>${esc(tm.name)}${id === c.playerTeam ? ' <span class="you">YOU</span>' : ''}</span><span class="sc">${score(i, id)}</span></div>`;
    };
    const fieldFor = (i) => {
      if (i === 0) return c.draw;
      const prev = c.rounds[i - 1];
      return prev && i - 1 < shown ? prev.heats.map((h) => h.winner) : new Array(8 >> i).fill(null);
    };
    const col = (i) => {
      const f = fieldFor(i), rd = c.rounds[i];
      const matches = [];
      for (let k = 0; k < f.length; k += 2) {
        const w = rd && i < shown ? rd.heats[k / 2].winner : null;
        matches.push(`<div class="match">${slot(i, f[k], w)}${slot(i, f[k + 1], w)}</div>`);
      }
      return `<div class="bcol"><h5>${S.ROUND_NAMES[i]}</h5>${matches.join('')}</div>`;
    };
    const champ = c.champion && shown >= 3 ? team(c.champion) : null;
    box.innerHTML = `<div class="bracket">${col(0)}${col(1)}${col(2)}
      <div class="bcol"><h5>Champion</h5><div class="trophy"><div class="cup">🏆</div><div class="who" style="color:${champ ? champ.color : 'var(--dim)'}">${champ ? esc(champ.name) : 'TBD'}</div></div></div></div>
      <p class="muted small" style="margin-top:12px">Seed ${hex(c.seed)} · ${c.advanced ? 'Advanced' : 'Standard'} · ${esc(S.SCORING[c.scoring].name)}. Scores are seconds; lower wins.</p>`;
  }

  // ------------------------------------------------------------ records
  function renderRecords() {
    const box = $('tab-records');
    const rec = store.get(KEYS.records, []);
    const hist = store.get(KEYS.history, []);
    const titles = {};
    for (const h of hist) titles[h.champion] = (titles[h.champion] || 0) + 1;
    const mine = hist.filter((h) => h.reached === 'Champion').length;
    box.innerHTML = `
      <h4 style="margin-top:0">Fastest speed runs</h4>
      ${rec.length ? `<table class="rec"><tr><th>#</th><th>Team</th><th>Maze</th><th style="text-align:right">Time</th></tr>
        ${rec.slice(0, 10).map((r, i) => `<tr class="${r.mine ? 'mine' : ''}"><td>${i + 1}</td><td>${esc(team(r.team) ? team(r.team).name : r.team)}${r.mine ? ' ★' : ''}</td><td class="muted">${esc(r.style)}${r.adv ? ' · adv' : ''}</td><td class="num">${fmt(r.time)}</td></tr>`).join('')}</table>` : '<div class="empty">No records yet. Finish a round to set some.</div>'}
      <h4>Championship titles</h4>
      ${hist.length ? `<div class="titles">${S.TEAMS.map((t) => `<div><span><span class="dot" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${t.color};margin-right:6px"></span>${esc(t.name)}</span><b>${titles[t.id] || 0}</b></div>`).join('')}</div>
        <p class="muted small">You've won ${mine} of ${hist.length} championship${hist.length === 1 ? '' : 's'}.</p>
        <h4>Recent seasons</h4>
        <table class="rec"><tr><th>Seed</th><th>Champion</th><th>You</th><th></th></tr>
        ${hist.slice(0, 6).map((h) => `<tr><td class="muted">${h.seed}</td><td>${esc(team(h.champion).name)}</td><td>${esc(team(h.player).short)} · ${esc(h.reached)}</td><td><button class="btn" data-seed="${h.seed}" style="padding:3px 8px;font-size:10px">Re-run</button></td></tr>`).join('')}</table>` : '<div class="empty">No completed championships yet.</div>'}
      <div class="btn-row"><button class="btn" id="clearRec">Clear records</button></div>`;
  }
  $('tab-records').addEventListener('click', (e) => {
    if (e.target.id === 'clearRec' && confirm('Clear local records and championship history?')) {
      store.set(KEYS.records, []); store.set(KEYS.history, []); renderRecords();
    }
    const seed = e.target.dataset && e.target.dataset.seed;
    if (seed) {
      if (!['idle', 'practice', 'champion'].includes(state.mode) && !confirm('Abandon the current championship?')) return;
      state.nextSeed = parseInt(seed, 16) >>> 0;
      prepareIdle();
      selectTab('garage');
    }
  });

  // ------------------------------------------------------------ log
  function renderLog() {
    if (!state.race) { if (logCount !== 0) { $('log').innerHTML = '<div class="empty" style="display:block">Race events appear here.</div>'; logCount = 0; } return; }
    const items = [];
    for (const row of state.race.rows) {
      const tm = team(row.id), r = row.result;
      for (const k of r.marks) {
        if (k.t > state.t) continue;
        const msg = {
          goal: 'reached the centre',
          finish: `run ${k.run}: <b>${secs(r.runs[k.run - 1] && r.runs[k.run - 1].time)}</b>`,
          crash: `crashed on run ${k.run}`,
          slip: 'slid wide while searching',
          flat: 'battery went flat, limping on',
        }[k.type];
        items.push([k.t, `<span style="color:${tm.color}">${esc(tm.name)}</span> ${msg}`]);
      }
      for (const p of r.phases) if (p.phase === 'return' && p.t <= state.t) items.push([p.t, `<span style="color:${tm.color}">${esc(tm.name)}</span> heading home`]);
    }
    if (items.length === logCount) return;
    logCount = items.length;
    items.sort((a, b) => b[0] - a[0]);
    $('log').innerHTML = items.map(([t, m]) => `<div><span class="lt">${t.toFixed(2)}s</span><span>${m}</span></div>`).join('') || '<div class="empty" style="display:block">Lights out…</div>';
  }

  // ------------------------------------------------------------ tabs + controls
  function selectTab(name) {
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.tabpanel').forEach((p) => p.classList.toggle('hidden', p.id !== 'tab-' + name));
  }
  document.querySelector('.tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) selectTab(b.dataset.tab); });

  $('cta').onclick = () => {
    const m = state.mode;
    if (m === 'idle' || m === 'practice') startChampionship();
    else if (m === 'ready') runRound();
    else if (m === 'done') prepareRound(state.roundIdx + 1);
    else if (m === 'champion') newChampionship();
  };
  $('practiceBtn').onclick = startPractice;
  $('newBtn').onclick = () => { if (state.mode === 'champion' || confirm('Abandon this championship?')) newChampionship(); };
  $('playBtn').onclick = () => {
    if (!state.race) return;
    if (state.t >= endOf()) state.t = 0;
    state.playing = !state.playing;
    syncControls();
  };
  $('restartBtn').onclick = () => { state.t = 0; state.playing = true; syncControls(); };
  $('skipBtn').onclick = () => { state.t = endOf(); state.playing = false; onRaceEnd(); syncControls(); };
  $('scrub').addEventListener('input', (e) => {
    if (!state.race) return;
    state.t = (+e.target.value / 1000) * endOf();
    if (state.t >= endOf() - 1e-6) onRaceEnd();
  });

  $('speedSeg').innerHTML = [0.5, 1, 2, 4, 8, 16, 32].map((s) => `<button data-speed="${s}">${s}×</button>`).join('');
  $('speedSeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; settings.speed = +b.dataset.speed; saveSettings(); syncControls(); });
  const TOGGLES = [['trails', 'Trails'], ['sensors', 'Sensors'], ['fog', 'Mouse map'], ['flood', 'Flood values'], ['ideal', 'True shortest']];
  $('toggles').innerHTML = TOGGLES.map(([k, l]) => `<button class="toggle" data-view="${k}">${l}</button>`).join('');
  $('toggles').addEventListener('click', (e) => {
    const b = e.target.closest('.toggle');
    if (!b) return;
    const k = b.dataset.view;
    settings.view[k] = !settings.view[k];
    if (k === 'fog' && settings.view.fog && !state.focus && state.race) state.focus = state.race.rows.some((r) => r.id === settings.playerTeam) ? settings.playerTeam : state.race.rows[0].id;
    saveSettings(); syncControls();
  });

  document.querySelectorAll('#modeSeg button').forEach((b) => b.addEventListener('click', () => {
    settings.advanced = b.dataset.mode === 'advanced'; saveSettings();
    if (state.mode === 'practice') state.mode = 'idle';
    prepareIdle();
  }));
  $('scoring').innerHTML = Object.entries(S.SCORING).map(([k, v]) => `<option value="${k}" title="${esc(v.desc)}">${esc(v.name)}</option>`).join('');
  $('scoring').addEventListener('change', (e) => { settings.scoring = e.target.value; saveSettings(); renderHeader(); });

  $('shareBtn').onclick = async () => {
    const url = shareUrl();
    history.replaceState(null, '', url);
    try { await navigator.clipboard.writeText(url); flashSeed('LINK COPIED'); } catch { flashSeed('LINK IN ADDRESS BAR'); }
  };
  function flashSeed(msg) {
    const l = $('seedLabel'), prev = l.textContent;
    l.textContent = msg;
    setTimeout(() => { l.textContent = prev; }, 1400);
  }

  $('tower').addEventListener('click', (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    state.focus = state.focus === row.dataset.id ? null : row.dataset.id;
    towerKey = '';
  });
  canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * L, y = ((e.clientY - rect.top) / rect.height) * L;
    let best = null, bd = CS * 0.7;
    for (const it of scene()) {
      const p = it.res ? poseAt(it.res, state.t) : { x: cx(S.START), y: cy(S.START) };
      const [ox, oy] = slotOffset(it.i, it.n);
      const d = Math.hypot(p.x + ox - x, p.y + oy - y);
      if (d < bd) { bd = d; best = it.id; }
    }
    state.focus = best && best !== state.focus ? best : null;
    towerKey = '';
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) return;
    if (e.key === ' ') { e.preventDefault(); $('playBtn').click(); }
    else if (e.key === 'ArrowRight' && state.race) state.t = Math.min(endOf(), state.t + 1);
    else if (e.key === 'ArrowLeft' && state.race) state.t = Math.max(0, state.t - 1);
    else if (e.key === 'Home') $('restartBtn').click();
    else if (e.key === 'End' && state.race) $('skipBtn').click();
    else if (/^[1-7]$/.test(e.key)) { settings.speed = [0.5, 1, 2, 4, 8, 16, 32][+e.key - 1]; saveSettings(); syncControls(); }
    else if (e.key === 'f' || e.key === 'F') $('toggles').querySelector('[data-view=fog]').click();
  });

  // ------------------------------------------------------------ boot
  $('engineVersion').textContent = S.ENGINE_VERSION;
  resize();
  prepareIdle();
  requestAnimationFrame((t) => { lastFrame = t; frame(t); });

  // Test hook: lets automated QA advance the replay without waiting on frames.
  window.__mmgp = { state, settings, advance(sec) { state.t = Math.min(endOf(), state.t + sec); if (state.t >= endOf()) { state.playing = false; onRaceEnd(); syncControls(); } } };
})();
