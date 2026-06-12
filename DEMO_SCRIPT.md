# DEMO SCRIPT (~3 minutes)

Pre-flight (before judges arrive):
- `curl -s https://<render-url>/healthz` → wakes the instance, expect `ok`.
- Open the dashboard at `/`, confirm header says **live** and all 5 assets are green.
- `curl -X POST <url>/api/demo/clear` to reset between rehearsals.
- If Bedrock flakes on stage: restart with `FAKE_BRAIN=true` (labeled fallback — say so if asked).

## Beats

1. **Set the scene (30s).** "Stormline watches real business assets — two delivery routes, an outdoor festival, a field crew, a warehouse — and acts on severe weather with zero human input." Point at the all-green map.

2. **Trigger (10s).** "A severe cell just formed over the East Bay." Click **Inject storm** (or:)
   ```bash
   curl -X POST <url>/api/demo/inject-storm -H 'content-type: application/json' \
     -d '{"intensity":"severe","target":"route-7"}'
   ```
   Emphasize: *this only controls when the storm happens — everything after is the agent.*

3. **Watch it think (60–90s).** Narrate the reasoning feed as it streams: storm advances on the map each tick → route-7 flips amber→red → Claude's reasoning line appears → real actions fire (Slack alert lands in the channel — show the phone, email, calendar move). Cards flip blue (handled).

4. **Prove autonomy (20s).** Show the feed's "skipped duplicate" lines on later ticks: "it doesn't spam — it knows what it already did." Nobody touched anything since the inject.

5. **Close (10s).** "Same pipeline ingests live Jua forecasts — the injected cell is just a time machine for the demo." `POST /api/demo/clear` resets for the next run.
