// Weather ingestion (DEMO_MODE=false path). Jua was dropped for submission —
// data comes from mock-payload.json for demo reliability. normalizePayload()
// maps the provider-style payload into the SAME canonical shape injected
// storms use (see src/data/injected.js), so the agent code path is identical
// regardless of source.
import { readFileSync } from 'node:fs';

const PAYLOAD_URL = new URL('./mock-payload.json', import.meta.url);

export function normalizePayload(raw) {
  const cell = raw?.cells?.[0];
  if (!cell) return null;
  const speedKmh = Math.round((cell.speed_ms ?? 0) * 3.6);
  const now = new Date().toISOString();
  return {
    id: `storm-${cell.cell_id}`, // stable id → stable weather hash → the brain decides once, then dedupes
    source: 'mock',
    kind: cell.phenomenon ?? 'thunderstorm',
    severity: ['moderate', 'severe', 'extreme'].includes(cell.category) ? cell.category : 'severe',
    center: { lat: cell.centroid.latitude, lon: cell.centroid.longitude },
    radius_km: Math.round((cell.radius_meters ?? 15000) / 1000),
    movement: { bearing_deg: cell.heading_degrees ?? 0, speed_kmh: speedKmh, dLat: 0, dLon: 0 },
    spread_km: cell.spread_km_per_update ?? 0,
    wind_kph: cell.max_wind_kmh ?? 0,
    rain_mm_h: cell.precip_rate_mmh ?? 0,
    confidence: cell.probability ?? 0.8,
    eta_minutes: cell.minutes_to_impact ?? 60,
    startedAt: now,
    updatedAt: now,
  };
}

export async function getForecast() {
  const raw = JSON.parse(readFileSync(PAYLOAD_URL, 'utf8'));
  return normalizePayload(raw);
}
