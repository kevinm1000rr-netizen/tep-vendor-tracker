/**
 * Google Places (Find Place + Place Details) and SerpApi helpers for the background research agent.
 */

const LOG = '[discovery:serp]';

function safeSerpLogUrl(url) {
  try {
    const u = new URL(url);
    u.searchParams.set('api_key', '(redacted)');
    return u.toString();
  } catch {
    return url.slice(0, 80);
  }
}

async function fetchJson(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${safeSerpLogUrl(url)}`);
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

/** San Diego County centroid — SerpApi Maps `ll` origin (see SerpApi google_maps docs). */
const SD_COUNTY_LL = '@32.78,-116.96,10z';

/**
 * Normalize SerpApi Google Maps hit shapes into one list.
 * @param {Record<string, unknown>} j
 */
function collectMapsLocalBlocks(j) {
  const blocks = [];
  const push = (arr) => {
    if (!arr) return;
    if (!Array.isArray(arr)) {
      console.warn(`${LOG} unexpected non-array maps block:`, typeof arr);
      return;
    }
    blocks.push(...arr);
  };
  push(j.local_results);
  push(j.place_results);
  push(j.places);
  return blocks;
}

/**
 * SerpApi Google Maps local results (San Diego–oriented queries).
 * Requires `type=search` for the google_maps engine (SerpApi docs).
 * @returns {Array<{ title: string, place_id?: string, address?: string, phone?: string, website?: string, reviews?: number, type?: string }>}
 */
export async function serpGoogleMapsLocal(query, apiKey) {
  if (!apiKey) {
    console.warn(`${LOG} skip Maps: empty API key`);
    return [];
  }
  const params = new URLSearchParams({
    engine: 'google_maps',
    type: 'search',
    q: query,
    api_key: apiKey,
    hl: 'en',
    gl: 'us',
    ll: SD_COUNTY_LL,
  });
  const url = `https://serpapi.com/search.json?${params}`;
  console.log(`${LOG} Maps request q=${JSON.stringify(query)} ll=${SD_COUNTY_LL}`);
  let j;
  try {
    j = await fetchJson(url);
  } catch (e) {
    console.error(`${LOG} Maps fetch failed:`, e.message || e);
    throw e;
  }
  if (j.error) {
    console.error(`${LOG} SerpApi JSON error:`, j.error, 'metadata=', j.search_metadata || {});
    return [];
  }
  const meta = j.search_metadata || {};
  console.log(
    `${LOG} Maps response status=${meta.status || 'n/a'} id=${meta.id || 'n/a'} time_taken=${meta.total_time_taken || '?'}s`
  );
  const locals = collectMapsLocalBlocks(j);
  console.log(`${LOG} Maps merged local blocks count=${locals.length}`);
  if (!locals.length && (j.local_results_state || j.search_information)) {
    console.log(`${LOG} Maps empty hints:`, {
      local_results_state: j.local_results_state,
      search_information: j.search_information,
    });
  }
  return locals.map((x) => {
    const rev =
      typeof x.reviews === 'number'
        ? x.reviews
        : x.review_count ?? x.reviews_count ?? x.reviews?.count ?? x.user_review?.reviews_count;
    return {
      title: x.title || x.name || '',
      place_id: x.place_id || x.data_cid || x.data_cid_string || '',
      address: x.address || x.snippet || x.address_lines?.join?.(', ') || '',
      phone: x.phone || '',
      website: x.website || x.links?.website || x.link || '',
      reviews: rev,
      type: x.type || x.types?.[0],
      gps: x.gps_coordinates,
    };
  });
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
  const url = `https://serpapi.com/search.json?${params}`;
  console.log(`${LOG} Organic request q=${JSON.stringify(query)} num=${num}`);
  let j;
  try {
    j = await fetchJson(url);
  } catch (e) {
    console.error(`${LOG} Organic fetch failed:`, e.message || e);
    return [];
  }
  if (j.error) {
    console.error(`${LOG} Organic SerpApi error:`, j.error);
    return [];
  }
  const org = j.organic_results || [];
  console.log(`${LOG} Organic hits=${org.length}`);
  return org.map((o) => ({ title: o.title, link: o.link, snippet: o.snippet }));
}
