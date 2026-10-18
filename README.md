# MicroMouse Grand Prix

A browser MicroMouse championship. Tune a robot mouse in the garage, then watch it race seven rival teams through procedurally generated 16×16 mazes in an eight-mouse elimination bracket.

**Play:** https://mellow-spirit-x2jq.here.now/

## How a race works

Every mouse in a round gets the same unseen maze and runs independently (no collisions), mirroring real MicroMouse:

1. **Search.** It starts in the south-west corner knowing only the outer walls, senses walls with its IR array, and flood-fills toward the 2×2 goal.
2. **Scan.** Depending on its search policy, it checks unvisited cells that could still hold a shorter route.
3. **Return** to the start.
4. **Two speed runs** over its best *verified* route. Run 1 is a banker at 93% aggression; run 2 is the all-out attack.

Default scoring is **best run + search time / 30**, which rewards efficient exploration. "Fastest run" scoring is also available. Heat winners advance; each round races a fresh maze.

## The garage

Every part is a trade-off, and the engineering readout shows why:

| Part | Options | Trade-off |
|---|---|---|
| Motor | coreless · brushless · gearmotor | top speed vs acceleration vs mass and power |
| Tires | silicone · urethane · hard rubber | grip vs rolling drag vs dust sensitivity |
| Suction | none · low · high | downforce for faster corners vs mass and battery drain |
| Sensors | 1 · 2 · 4 cell IR | seeing dead ends early vs mass and noise in glare |
| Battery | 1S · 2S · 2S XL | endurance vs mass; a sagging pack also slows the fan |
| Brains | search policy, route planner, tie-break | search time vs route quality |
| Tuning | corner aggression, search pace | over 100% aggression risks crashes |

Corner speed is `min(grip √(μ·N/m·r), yaw k·√(F/m))`, so heavy fan builds need punchy motors, and light builds corner well too. Beginners can use **Wind-tunnel auto-tune**, which tests 30 builds on practice mazes and keeps the best. **Test lap** runs your build alone.

**Advanced mode** adds seeded randomness the mice can't see coming: dust patches (worse on silicone), slick or grippy surfaces, IR glare that corrupts long-range readings, and cold batteries.

Builds lock (homologate) when a championship starts.

## Seasons

Five championships make a season. Points: champion 10, finalist 6, semi-finalist 3, quarter-finalist 1, plus 1 for the championship's fastest single speed run. Standings and past season champions are in **Records**. You can rename your team in the garage.

## Replay and views

Races are fully simulated up front by a deterministic engine, then replayed on a virtual clock. You can pause, scrub, and play at 0.5×–32×, and frame rate never affects results. You can toggle:

- trails
- IR sensor rays
- **mouse map**: a fog-of-war view of what the focused mouse knows; dashed walls are long-range readings it isn't sure of
- flood-fill values
- the true shortest path

Click a mouse to see its spec sheet and a **speed trace** of its best run, overlaid with its heat rival's. After a round, **Speed-run showdown** replays every mouse's best run side by side from a standing start. Races open with start lights, and synthesized sound effects can be muted with **M**.

Use **Seed** to copy a link that reproduces the championship and carries your build.

## Development

No build step and no dependencies. The site is static files.

```sh
npm run serve        # http://127.0.0.1:8765
npm test             # engine tests (node:test)
npm run balance      # win-rate report per part option and per team
npm run deploy       # publish main to here.now (needs HERENOW_API_KEY in .env)
```

| Path | Purpose |
|---|---|
| `js/sim.js` | Simulation engine: maze generation, sensing, flood fill, physics, scoring, bracket. Pure and deterministic; runs in the browser and under node. |
| `js/app.js` | UI: canvas renderer, replay, garage, bracket, records. |
| `css/style.css` | Styles. |
| `tests/` | Engine tests and the balance harness. |
| `scripts/deploy.js` | Release script: clean pushed `main` only, runs tests, uploads, then verifies the live files. |

Every race is reproducible from the engine version, maze seed, environment seed and builds. Times are simulated, so six decimal places are not six places of physical accuracy. Records are stored locally in your browser.
