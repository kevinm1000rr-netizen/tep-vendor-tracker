/**
 * Google Places (Find Place + Place Details) and SerpApi helpers for the background research agent.
 */

async function fetchJson(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url.slice(0, 80)}…`);
  return r.json();
}

/** @returns {{ place_id?: string, name?: string, formatted_address?: string } | null} */
export async function googleFindPlaceId(query, apiKey) {
  if (!apiKey) return null;
  const input = encodeURIComponent(query);
  const url = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${input}&inputtype=textquery&fields=place_id,name,formatted_address&key=${encodeURIComponent(apiKey)}`;
  const j = await fetchJson(url);
  if (j.status !== 'OK' && j.status !== 'ZERO_RESULTS') {
    throw new Error(j.error_message || `Places find: ${j.status}`);
  }
  const c = j.candidates?.[0];
  if (!c?.place_id) return null;
  return { place_id: c.place_id, name: c.name, formatted_address: c.formatted_address };
}

/** @returns {Record<string, unknown> | null} */
export async function googlePlaceDetails(placeId, apiKey) {
  if (!apiKey || !placeId) return null;
  const fields = encodeURIComponent(
    'name,formatted_phone_number,website,formatted_address,url,business_status,editorial_summary'
  );
  const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(placeId)}&fields=${fields}&key=${encodeURIComponent(apiKey)}`;
  const j = await fetchJson(url);
  if (j.status !== 'OK') return null;
  return j.result || null;
}

/**
 * SerpApi Google Maps local results (San Diego–oriented queries).
 * @returns {Array<{ title: string, place_id?: string, address?: string, phone?: string, website?: string, reviews?: number, type?: string }>}
 */
export async function serpGoogleMapsLocal(query, apiKey) {
  if (!apiKey) return [];
  const params = new URLSearchParams({
    engine: 'google_maps',
    q: query,
    api_key: apiKey,
    hl: 'en',
    gl: 'us',
  });
  const j = await fetchJson(`https://serpapi.com/search.json?${params}`);
  const locals = j.local_results || j.place_results || [];
  if (!Array.isArray(locals)) return [];
  return locals.map((x) => ({
    title: x.title || x.name || '',
    place_id: x.place_id || x.data_cid || '',
    address: x.address || x.snippet || '',
    phone: x.phone || '',
    website: x.website || x.links?.website || '',
    reviews: x.reviews || x.review_count,
    type: x.type,
    gps: x.gps_coordinates,
  }));
}

/**
 * Organic Google results (for extra source URLs / snippets).
 * @returns {Array<{ title: string, link: string, snippet?: string }>}
 */
export async function serpGoogleOrganic(query, apiKey, num = 5) {
  if (!apiKey) return [];
  const params = new URLSearchParams({
    engine: 'google',
    q: query,
    api_key: apiKey,
    hl: 'en',
    gl: 'us',
    num: String(num),
  });
  const j = await fetchJson(`https://serpapi.com/search.json?${params}`);
  const org = j.organic_results || [];
  return org.map((o) => ({ title: o.title, link: o.link, snippet: o.snippet }));
}
