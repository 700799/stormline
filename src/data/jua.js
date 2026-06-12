// Jua AI forecast client — M4 (live data). Not called while DEMO_MODE=true.
//
// CONTRACT: getForecast() must resolve to the same normalized storm shape that
// src/data/injected.js produces, or null when there is no significant weather:
//   { id, source: 'jua', kind, severity: 'moderate'|'severe'|'extreme',
//     center: { lat, lon }, radius_km,
//     movement: { bearing_deg, speed_kmh, dLat, dLon },
//     wind_kph, rain_mm_h, confidence, eta_minutes, startedAt, updatedAt }
// That keeps the agent code path identical for live and injected weather.

export async function getForecast() {
  // M4: fetch(`${process.env.JUA_BASE_URL}/...`) with JUA_API_KEY, then normalizeForecast(raw)
  return null;
}

export function normalizeForecast(raw) {
  // M4: map Jua's response into the shape above
  return null;
}
