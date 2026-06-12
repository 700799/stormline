// Synthetic threat generator for POST /api/demo/inject-storm.
// Two kinds, one canonical shape (the pipeline is threat-agnostic):
//  - wildfire (default): ignites small near the target, then the burn radius
//    GROWS each tick while the front drifts SW on NE (Diablo) winds
//  - thunderstorm: fixed-size cell sweeping SE across the bay
// jua-style live providers would normalize into this same shape (see forecast.js).

const PROFILES = {
  wildfire: {
    moderate: { severity: 'moderate', wind_kph: 35, rain_mm_h: 0, radius_km: 6, confidence: 0.8, spread_km: 0.8 },
    severe: { severity: 'severe', wind_kph: 60, rain_mm_h: 0, radius_km: 9, confidence: 0.9, spread_km: 1.2 },
    extreme: { severity: 'extreme', wind_kph: 85, rain_mm_h: 0, radius_km: 12, confidence: 0.95, spread_km: 1.8 },
  },
  thunderstorm: {
    moderate: { severity: 'moderate', wind_kph: 60, rain_mm_h: 15, radius_km: 10, confidence: 0.75, spread_km: 0 },
    severe: { severity: 'severe', wind_kph: 95, rain_mm_h: 30, radius_km: 15, confidence: 0.9, spread_km: 0 },
    extreme: { severity: 'extreme', wind_kph: 130, rain_mm_h: 55, radius_km: 22, confidence: 0.95, spread_km: 0 },
  },
};

export function targetPoint(asset) {
  const g = asset.geometry;
  if (g.type === 'point') return { lat: g.coordinates[0], lon: g.coordinates[1] };
  const mid = g.coordinates[Math.floor(g.coordinates.length / 2)];
  return { lat: mid[0], lon: mid[1] };
}

export function createStorm({ kind = 'wildfire', intensity = 'severe', target = 'route-7' } = {}, assets) {
  const kindProfiles = PROFILES[kind];
  if (!kindProfiles) throw new Error(`unknown kind: ${kind} (use wildfire|thunderstorm)`);
  const profile = kindProfiles[intensity];
  if (!profile) throw new Error(`unknown intensity: ${intensity} (use moderate|severe|extreme)`);
  const asset = assets.find((a) => a.id === target);
  if (!asset) throw new Error(`unknown target asset: ${target}`);
  const t = targetPoint(asset);
  const now = new Date().toISOString();

  if (kind === 'wildfire') {
    return {
      id: `fire-${Date.now()}`,
      source: 'injected',
      kind,
      ...profile,
      // Ignition just NE (upwind) of the target; Diablo winds push the front SW
      // while the burn radius grows spread_km per tick. Demo-paced, not physical.
      center: { lat: t.lat + 0.04, lon: t.lon + 0.05 },
      movement: { bearing_deg: 225, speed_kmh: Math.round(profile.wind_kph / 5), dLat: -0.008, dLon: -0.01 },
      eta_minutes: 45,
      startedAt: now,
      updatedAt: now,
    };
  }
  return {
    id: `storm-${Date.now()}`,
    source: 'injected',
    kind,
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
  if (storm.kind === 'wildfire') {
    storm.radius_km = Math.min(35, Math.round((storm.radius_km + storm.spread_km) * 10) / 10);
  }
  storm.eta_minutes = Math.max(0, storm.eta_minutes - 12);
  storm.updatedAt = new Date().toISOString();
  return storm;
}
