# PLAN — milestones (build strictly in order)

Mission: autonomous severe-weather ops agent. Judging: autonomy (20%), visible reasoning, working integrations, demo quality. Demo trigger (`/api/demo/inject-storm`) controls WHEN, never WHAT.

## M1 — Brain on a wire ✅ (built; Bedrock live-call check pending user creds)
`npm start` runs; loop ticks; with DEMO_MODE=true and an injected storm, Claude (Bedrock) returns tool calls; reasoning + intended actions print to console and appear in GET /api/state. No Composio yet — tools.js logs "would execute X".

## M2 — Real hands
Composio wired (`@composio/core`); injected storm causes a REAL Slack message in the configured channel. Then email. Then calendar. Dedupe verified (second tick does not re-send). Without COMPOSIO_API_KEY the executors stay in labeled dry-run mode — never silently fake.

## M3 — The face
Dashboard live at `/`; storm visibly moves on the map (Leaflet via CDN, dark high-contrast, readable from 20 ft); asset cards change color (green safe / amber watch / red threatened / blue handled); reasoning feed streams via SSE, newest-first, prominent. Full demo arc works end to end on localhost AND on Render.

## M4 — Data ingestion ✅ (pivoted for submission: Jua aborted)
DEMO_MODE=false ingests `src/data/mock-payload.json` through `forecast.js normalizePayload()` into the same shape injected storms use — agent code path identical, demo 100% reliable. (Jua was dropped by decision on submission day; the normalize seam is where a live provider would plug back in.)

## OpenUI (3rd sponsor) ✅ built — generation needs a key
`/api/ui/openui-card` + the dashboard's bottom panel: OpenUI-generated status card (env-overridable endpoint/model; labeled local fallback card without a key) + the live `[AGENT LOG]` terminal streamed over SSE.

## M5 — Stretch ✅ built (needs CLICKHOUSE_URL to go live)
ClickHouse decision logging (`src/log/clickhouse.js`, bus-listener, fail-soft, OFF without creds) + the autonomy scoreboard (decisions/actions/repeats-blocked counters in header and status card).

## After each milestone
Update PROGRESS.md (works / stubbed / next), commit with a clear message, push to `claude/confident-cannon-v06aak` (draft PR → main; merging deploys via Render).
