# ⛈ Stormline

**An autonomous severe-weather operations agent.** Stormline watches real business assets — delivery routes, an outdoor festival, a field crew, a warehouse — and when a storm threatens them it **decides and acts entirely on its own**: Slack alerts, customer emails, calendar moves, reroutes. After a weather event enters the pipeline, no human touches anything. You watch it think on a live dashboard.

```
SENSE                 DECIDE                    ACT                     SHOW
weather ingestion  →  Claude (tool use)      →  Composio            →  live dashboard
injected storms       evaluates threats         Slack / Gmail /        Leaflet map · status
or mock payload       against tracked assets    Google Calendar        cards · reasoning feed
                                                                       · [AGENT LOG] · OpenUI
```

## 60-second demo (zero credentials)

```bash
npm install
npm run demo        # FAKE_BRAIN + 5s ticks, clearly labeled
```

Open **http://localhost:3000**, click **⚡ Inject storm**, and watch: the cell sweeps across the Bay Area, assets flip green → amber → red → blue, the agent's reasoning streams in, actions fire exactly once, and every later tick shows it *refusing* to repeat itself.

## Real brain (one key)

```bash
cp .env.example .env          # add OPENROUTER_API_KEY (Claude Sonnet 4.5 via OpenRouter)
npm run dev                   # or AWS Bedrock creds — both paths built in
```

Same demo, but the reasoning is genuine Claude deciding which assets to protect and why. `POST /api/demo/inject-storm` controls **when** a storm happens — never **what** the agent does about it.

## Integrations

| Piece | What it does |
|---|---|
| **Claude** (OpenRouter `anthropic/claude-sonnet-4.5`, or AWS Bedrock) | The brain: one tool-use call per weather change; every action carries a one-sentence `rationale` shown live |
| **Composio** (`@composio/core`) | The hands: real Slack / Gmail / Google Calendar actions (labeled dry-run without a key) |
| **OpenUI** | Generates the dashboard's status-card component from live world state (labeled local fallback without a key) |
| **Weather ingestion** | Demo trigger injects synthetic storms; `DEMO_MODE=false` ingests `src/data/mock-payload.json` through the same normalize seam a live provider would use |
| **ClickHouse** | Every decision/action/status row logged to `stormline_events` over the HTTP interface (off without `CLICKHOUSE_URL`) |

## Autonomy guardrails (poke at them live)

- **Idempotent**: dedupe key `tool:asset_id:threatId` — the agent never repeats an action for the same asset + threat, provably (watch the "skipped duplicate" feed lines).
- **Bounded**: max 5 actions per tick; weather-hash skip means Claude isn't even called when nothing changed.
- **Unkillable loop**: every external call is fail-soft — a dead API logs one feed error and the loop keeps ticking.
- **Transparent**: the `[AGENT LOG]` panel streams the exact context sent to the model, the raw response, and every guardrail decision.

## API

`GET /` dashboard · `GET /api/state` world state · `GET /api/stream` SSE (`state`, `feed`, `agentlog`) · `POST /api/demo/inject-storm {intensity?, target?}` · `POST /api/demo/clear` · `GET /api/ui/openui-card` · `GET /healthz`

## Layout

```
src/server.js          Express + SSE + demo triggers + OpenUI endpoint
src/state.js           in-memory world state, feed ring buffer, broadcast bus
src/agent/loop.js      poll → assess → decide → act → broadcast (+ guardrails)
src/agent/brain.js     Claude call: prompt build, 5 tool defs, provider selection
src/agent/tools.js     action dispatcher; executor bodies = Composio seam
src/data/injected.js   synthetic storm generator (canonical weather shape)
src/data/forecast.js   mock-payload ingestion via the same normalize seam
public/dashboard.html  single-file dashboard (Leaflet CDN, no build step)
```

**Screen modes:** `/?present=1` hides the demo controls (clean presentation screen — drive it from a second device) · `/?attract=1` auto-cycles storms (booth idle loop).

Deploy: one-click via `render.yaml` (Render → New → Blueprint), or manually: Web Service → build `npm install`, start `npm start` (binds `process.env.PORT`), health check `/healthz`.

More: **DEMO_SCRIPT.md** (stage beats) · **PLAN.md** (milestones) · **PROGRESS.md** (verification status) · **.env.example** (every knob, documented).
