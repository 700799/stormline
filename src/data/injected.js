// Synthetic storm generator for POST /api/demo/inject-storm.
// Produces the canonical normalized weather shape — jua.js normalizeForecast()
// (M4) must emit this exact shape so the agent pipeline is source-agnostic.

const INTENSITY = {
  moderate: { severity: 'moderate', wind_kph: 60, rain_mm_h: 15, radius_km: 10, confidence: 0.75 },
  severe: { severity: 'severe', wind_kph: 95, rain_mm_h: 30, radius_km: 15, confidence: 0.9 },
  extreme: { severity: 'extreme', wind_kph: 130, rain_mm_h: 55, radius_km: 22, confidence: 0.95 },
};

export function targetPoint(asset) {
  const g = asset.geometry;
  if (g.type === 'point') return { lat: g.coordinates[0], lon: g.coordinates[1] };
  const mid = g.coordinates[Math.floor(g.coordinates.length / 2)];
  return { lat: mid[0], lon: mid[1] };
}

export function createStorm({ intensity = 'severe', target = 'route-7' } = {}, assets) {
  const profile = INTENSITY[intensity];
  if (!profile) throw new Error(`unknown intensity: ${intensity} (use moderate|severe|extreme)`);
  const asset = assets.find((a) => a.id === target);
  if (!asset) throw new Error(`unknown target asset: ${target}`);
  const t = targetPoint(asset);
  const now = new Date().toISOString();
  return {
    id: `storm-${Date.now()}`,
    source: 'injected',
    kind: 'thunderstorm',
    ...profile,
    // Spawn ~6 ticks NW of the target on a fixed SE track. Per-tick map movement
    // is deliberately ~10x faster than the narrative speed_kmh/eta_minutes so the
    // demo reads from across a room — do not reconcile them.
    center: { lat: t.lat + 0.1, lon: t.lon - 0.12 },
    movement: { bearing_deg: 130, speed_kmh: 25, dLat: -0.0167, dLon: 0.02 },
    eta_minutes: 90,
    startedAt: now,
    updatedAt: now,
  };
}

export function advanceStorm(storm) {
  storm.center.lat += storm.movement.dLat;
  storm.center.lon += storm.movement.dLon;
  storm.eta_minutes = Math.max(0, storm.eta_minutes - 12);
  storm.updatedAt = new Date().toISOString();
  return storm;
}
