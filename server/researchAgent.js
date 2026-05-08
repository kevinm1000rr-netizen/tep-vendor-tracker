import cron from 'node-cron';
import { getApiKey, getGooglePlacesApiKey, getSerpApiKey, getLiveAgentIntervalMinutes } from './config.js';
import {
  listVendors,
  insertBackgroundAgentRun,
  completeBackgroundAgentRun,
  insertVendor,
  vendorNameExistsLoose,
  pendingProspectDedupeExists,
  normalizeNameDedupe,
  listPendingNewProspects,
  applyVendorFieldIfEmpty,
  getVendor,
  updateVendor,
  upsertVendorOutreachDraft,
  getAgentLearningForCategory,
  vendorHasPendingOutreachDraft,
  logAgentActivity,
  listBlockedVendorIdsForAgent,
  listOverdue,
} from './db.js';
import * as ext from './externalSearch.js';
import { buildOutreachResearchBrief } from './outreachResearch.js';
import {
  extractVendorFieldsFromSnippets,
  generateVendorLetter,
  ensureAgentEmailDraftHasContact,
  isManualResearchLetterOutput,
  getManualResearchLetterReason,
} from './ai.js';
import { sendSMS } from './sms.js';

const MAX_VENDORS_ENRICH = 16;
const MAX_BLOCKED_EXTRA_SERPS = 24;
const MAX_AUTO_VENDOR_REGISTRATIONS_PER_RUN = 25;
const MAX_OUTREACH_DRAFTS_PER_RUN = 4;

const CATEGORY_PRIORITY = { restoration: 0, property_mgmt: 1, hoa: 2, contractor: 3 };

/**
 * Google Places Text Search specs. Most entries append `PLACES_DISCOVERY_LOCATION_SUFFIX` at request time;
 * targeted rows set `appendLocationSuffix: false` and pass the full query string in `text`.
 * Key: `GOOGLE_PLACES_API_KEY` (see `getGooglePlacesApiKey()` in config.js).
 */
const DISCOVERY_PLACES_TEXT_SPECS = [
  { text: 'water damage restoration San Diego', category: 'restoration', category_label: 'Water damage restoration', appendLocationSuffix: false },
  { text: 'fire restoration contractor San Diego', category: 'restoration', category_label: 'Fire restoration contractor', appendLocationSuffix: false },
  { text: 'mold remediation San Diego', category: 'restoration', category_label: 'Mold remediation', appendLocationSuffix: false },
  { text: 'plumbing contractor San Diego', category: 'contractor', category_label: 'Plumbing contractor', appendLocationSuffix: false },
  { text: 'facilities management San Diego', category: 'property_mgmt', category_label: 'Facilities management', appendLocationSuffix: false },
  { text: 'commercial property management San Diego', category: 'property_mgmt', category_label: 'Commercial property management', appendLocationSuffix: false },
  { text: 'apartment management company San Diego', category: 'property_mgmt', category_label: 'Apartment management company', appendLocationSuffix: false },
  { text: 'condo association management San Diego', category: 'hoa', category_label: 'Condo association management', appendLocationSuffix: false },
  { text: 'building maintenance contractor San Diego', category: 'contractor', category_label: 'Building maintenance contractor', appendLocationSuffix: false },
  { text: 'insurance restoration contractor San Diego', category: 'restoration', category_label: 'Insurance restoration contractor', appendLocationSuffix: false },
  { text: 'Lars Construction San Diego', category: 'contractor', category_label: 'Lars Construction', appendLocationSuffix: false },
  { text: 'ATI Restoration San Diego', category: 'restoration', category_label: 'ATI Restoration', appendLocationSuffix: false },
  {
    text: 'Christian Brothers Restoration San Diego',
    category: 'restoration',
    category_label: 'Christian Brothers Restoration',
    appendLocationSuffix: false,
  },
  { text: 'ServiceMaster Restore San Diego', category: 'restoration', category_label: 'ServiceMaster Restore', appendLocationSuffix: false },
  { text: 'Servpro San Diego', category: 'restoration', category_label: 'Servpro', appendLocationSuffix: false },
  { text: 'storm damage restoration San Diego', category: 'restoration', category_label: 'Storm damage restoration', appendLocationSuffix: false },
  { text: 'flood damage cleanup San Diego', category: 'restoration', category_label: 'Flood damage cleanup', appendLocationSuffix: false },
  { text: 'property maintenance services San Diego', category: 'contractor', category_label: 'Property maintenance services', appendLocationSuffix: false },
  { text: 'hoa property management San Diego', category: 'hoa', category_label: 'HOA property management', appendLocationSuffix: false },
  { text: 'commercial plumbing contractor San Diego', category: 'contractor', category_label: 'Commercial plumbing contractor', appendLocationSuffix: false },
];

const DISCOVERY_QUERY_ROTATION_BATCH_SIZE = 10;

const PLACES_DISCOVERY_LOCATION_SUFFIX = 'San Diego CA';

/** Google Places `types` that indicate lodging or food service — excluded from discovery registration. */
const DISCOVERY_EXCLUDED_PLACE_TYPES = new Set([
  'lodging',
  'restaurant',
  'food',
  'cafe',
  'meal_delivery',
  'meal_takeaway',
  'bar',
  'night_club',
]);

/** Permanent exclusion list requested by Kevin for discovery registration. */
const DISCOVERY_EXCLUDED_NAME_TERMS = [
  'hotel',
  'resort',
  'spa',
  'inn',
  'suites',
  'motel',
  'lodge',
];

const DISCOVERY_EXCLUDED_NAME_PATTERN = new RegExp(`\\b(?:${DISCOVERY_EXCLUDED_NAME_TERMS.join('|')})\\b`, 'i');

/**
 * Drop hotels/motels/restaurants (and similar) using Places types and a light name check
 * so generic queries like "restoration company" do not register irrelevant venues.
 */
function isExcludedLodgingOrRestaurantVenue(types, name) {
  const tList = Array.isArray(types) ? types : [];
  for (const x of tList) {
    const id = String(x || '')
      .trim()
      .toLowerCase();
    if (id && DISCOVERY_EXCLUDED_PLACE_TYPES.has(id)) return true;
  }
  const n = String(name || '').trim();
  if (!n) return false;
  return (
    DISCOVERY_EXCLUDED_NAME_PATTERN.test(n) ||
    /\b(hotels|motels|inns|resorts|bed\s+and\s+breakfast|b\s*&\s*b|hostel|lodging|restaurant|restaurants|diner|bistro|grill|eatery|tavern|pub|cafe)\b/i.test(
      n
    )
  );
}

function rotateDiscoveryTextSpecs(runId) {
  const all = DISCOVERY_PLACES_TEXT_SPECS;
  if (all.length <= DISCOVERY_QUERY_ROTATION_BATCH_SIZE) return all;
  const seed = Math.abs(Number(runId) || Date.now());
  const offset = (seed * 5) % all.length;
  const out = [];
  for (let i = 0; i < DISCOVERY_QUERY_ROTATION_BATCH_SIZE; i += 1) {
    out.push(all[(offset + i) % all.length]);
  }
  return out;
}

const MIN_PLACES_RATING = 4.0;
const MIN_PLACES_USER_RATINGS_TOTAL = 20;

function placesDedupeKey(placeId) {
  const pid = String(placeId || '').trim();
  return pid ? `gplace:${pid}` : '';
}

async function logDiscoveryActivity(runId, activity_type, summary, detail = {}) {
  try {
    await logAgentActivity({
      activity_type,
      vendor_id: null,
      summary: String(summary || '').slice(0, 500),
      detail: { ...detail, runId, iso_timestamp: new Date().toISOString() },
    });
  } catch (e) {
    console.warn('[discovery] logAgentActivity failed:', e.message || e);
  }
}

/** Parse optional "Subject: …" line from AI letter/draft output. */
function splitSubjectBodyFromLetterText(raw) {
  const t = String(raw || '').trim();
  if (!t) return { subject: '', body: '' };
  const lines = t.split(/\r?\n/).filter(Boolean);
  const subLine = lines.find((l) => /^subject:\s*/i.test(l));
  if (!subLine) return { subject: '', body: t };
  const subject = subLine.replace(/^subject:\s*/i, '').trim().slice(0, 200);
  const body = lines.filter((l) => l !== subLine).join('\n').trim();
  return { subject, body };
}

let liveAgentIntervalHandle = null;
/** Prevents overlapping agent runs (live loop + cron + manual). */
let researchAgentRunBusy = false;

function currentWeekId() {
  const d = new Date();
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function vendorMissingFields(v) {
  const miss = [];
  if (!(v.contact_person || '').trim()) miss.push('contact_person');
  if (!(v.email || '').trim()) miss.push('email');
  if (!(v.phone || '').trim()) miss.push('phone');
  if (!(v.website || '').trim()) miss.push('website');
  if (!(v.address || '').trim()) miss.push('address');
  if (!(v.years_in_business || '').trim()) miss.push('years_in_business');
  return miss;
}

async function isNameTaken(name, takenNames) {
  if (DISCOVERY_EXCLUDED_NAME_PATTERN.test(String(name || '').trim())) return true;
  if (await vendorNameExistsLoose(name)) return true;
  const n = normalizeNameDedupe(name);
  if (!n) return true;
  return takenNames.has(n);
}

function mapPlaceToApplyRows(det, missing, mapUrl) {
  const out = [];
  if (!det) return out;
  if (missing.includes('phone') && det.formatted_phone_number) {
    out.push({
      field_name: 'phone',
      proposed_value: String(det.formatted_phone_number),
      source_url: mapUrl,
    });
  }
  if (missing.includes('website') && det.website) {
    out.push({ field_name: 'website', proposed_value: String(det.website), source_url: mapUrl });
  }
  if (missing.includes('address') && det.formatted_address) {
    out.push({ field_name: 'address', proposed_value: String(det.formatted_address), source_url: mapUrl });
  }
  const summary = det.editorial_summary?.overview;
  if (
    summary &&
    typeof summary === 'string' &&
    /\b(since|20\d{2}|10\+|years)\b/i.test(summary) &&
    missing.includes('years_in_business')
  ) {
    out.push({
      field_name: 'years_in_business',
      proposed_value: summary.slice(0, 280),
      source_url: mapUrl,
    });
  }
  return out;
}

async function formatLearningHints(v) {
  const row = await getAgentLearningForCategory(v.category);
  if (!row) return '';
  const rate = Math.round((Number(row.response_rate) || 0) * 1000) / 10;
  const parts = [
    `Approx. category win rate (responded+approved / touched): ${rate}% (internal estimate).`,
    row.best_subject_line ? `Subject lines that previously worked in this category: ${row.best_subject_line}` : '',
    row.best_day_to_send ? `Best response day hint: ${row.best_day_to_send}` : '',
  ];
  return parts.filter(Boolean).join('\n');
}

async function ensureResearchWeek(v) {
  const wk = currentWeekId();
  if ((v.research_week_id || '') !== wk) {
    await updateVendor(v.id, { research_week_id: wk, research_miss_streak: 0 });
    return await getVendor(v.id);
  }
  return v;
}

/** Same “blocked” rule as Agent Report (missing email, contact name, or phone). */
function vendorBlockedOnContact(v) {
  return (
    !(v.email || '').trim() || !(v.contact_person || '').trim() || !(v.phone || '').trim()
  );
}

/** Regex-only fills from organic titles/snippets when Claude is unavailable. */
async function applyHeuristicContactsFromSnippets(vendorId, snippets, summary) {
  let n = 0;
  for (const s of snippets) {
    const blob = `${s.title || ''} ${s.snippet || ''}`;
    const url = (s.url || '').trim() || 'https://www.google.com/';
    const em = blob.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    if (em && (await applyVendorFieldIfEmpty(vendorId, 'email', em[0], { source_url: url }))) {
      n += 1;
      summary.vendorFieldUpdates += 1;
    }
    const ph = blob.match(/\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
    if (ph && (await applyVendorFieldIfEmpty(vendorId, 'phone', ph[0], { source_url: url }))) {
      n += 1;
      summary.vendorFieldUpdates += 1;
    }
    const cm = blob.match(/\bContact:\s*([A-Za-z][A-Za-z .'-]{1,48})\b/i);
    if (cm && (await applyVendorFieldIfEmpty(vendorId, 'contact_person', cm[1].trim(), { source_url: url }))) {
      n += 1;
      summary.vendorFieldUpdates += 1;
    }
  }
  return n;
}

async function maybeAutoDraftOutreach(vendorId, summary, aiKey) {
  if (!aiKey) return;
  const v = await getVendor(vendorId);
  if (!v || (v.status !== 'not_sent' && v.status !== 'new') || !(v.email || '').trim()) return;
  if (await vendorHasPendingOutreachDraft(vendorId)) return;
  try {
    const learning = await formatLearningHints(v);
    const brief = await buildOutreachResearchBrief(v, {
      googlePlacesKey: getGooglePlacesApiKey(),
      serpKey: getSerpApiKey(),
    });
    const text = await generateVendorLetter(v, learning, brief);
    const t = String(text || '').trim();
    if (!t) return;
    if (isManualResearchLetterOutput(t)) {
      await logAgentActivity({
        activity_type: 'outreach_manual_research',
        vendor_id: v.id,
        summary: 'Outreach draft skipped — manual research needed',
        detail: { reason: getManualResearchLetterReason(t) },
      });
      return;
    }
    const lines = t.split(/\r?\n/).filter(Boolean);
    let subject = `Partnership — Tri Express Plumbing & ${v.name}`;
    let body = t;
    const subLine = lines.find((l) => /^subject:\s*/i.test(l));
    if (subLine) {
      subject = subLine.replace(/^subject:\s*/i, '').trim().slice(0, 200);
      body = lines
        .filter((l) => l !== subLine)
        .join('\n')
        .trim();
    }
    await upsertVendorOutreachDraft(v.id, subject, body, { draft_type: 'outreach' });
    await logAgentActivity({
      activity_type: 'draft_created',
      vendor_id: v.id,
      summary: 'Outreach email draft generated (auto)',
      detail: {},
    });
    await sendSMS(`📧 Tri Express: Email ready to send to ${v.name}. Open app to approve and send.`, {
      alertType: 'email_ready',
      eventKey: `vendor:${v.id}`,
    });
    summary.outreachDraftsCreated = (summary.outreachDraftsCreated || 0) + 1;
  } catch (e) {
    const v0 = await getVendor(vendorId);
    summary.errors.push(`Auto-draft ${v0?.name || vendorId}: ${e.message || e}`);
  }
}

async function enrichOneVendor(runId, summary, v0, gKey, sKey, aiKey) {
  let v = await ensureResearchWeek((await getVendor(v0.id)) || v0);
  const missing = vendorMissingFields(v);
  if (!missing.length) return;

  let applied = 0;

  if (gKey) {
    const q = `${v.name} ${(v.address || '').trim()}`.trim() || v.name;
    const found = await ext.googleFindPlaceId(`${q} San Diego California`, gKey);
    if (found?.place_id) {
      const det = await ext.googlePlaceDetails(found.place_id, gKey);
      if (det?.business_status === 'CLOSED_PERMANENTLY') {
        /* skip */
      } else {
        const mapUrl =
          det.url || `https://www.google.com/maps/search/?api=1&query_place_id=${encodeURIComponent(found.place_id)}`;
        v = (await getVendor(v.id)) || v;
        const miss = vendorMissingFields(v);
        for (const row of mapPlaceToApplyRows(det, miss, mapUrl)) {
          if (await applyVendorFieldIfEmpty(v.id, row.field_name, row.proposed_value, { source_url: row.source_url })) {
            applied += 1;
            summary.vendorFieldUpdates += 1;
          }
        }
      }
    }
  }

  v = (await getVendor(v.id)) || v;
  const miss2 = vendorMissingFields(v);
  if (sKey && miss2.length) {
    const queries = [];
    if (vendorBlockedOnContact(v)) queries.push(`${v.name} San Diego contact email`);
    queries.push(
      `${v.name} San Diego CA contact phone website`,
      `${v.name} San Diego ${(v.category || '').replace('_', ' ')} email phone`
    );
    const snippets = [];
    for (const q of queries) {
      try {
        const org = await ext.serpGoogleOrganic(q, sKey, 8);
        for (const o of org) {
          snippets.push({ title: o.title, url: o.link, snippet: o.snippet || '' });
        }
      } catch {
        /* continue */
      }
    }
    if (snippets.length && aiKey) {
      const parsed = await extractVendorFieldsFromSnippets(v, snippets);
      const list = Array.isArray(parsed.suggestions) ? parsed.suggestions : [];
      const allowed = new Set(['phone', 'email', 'website', 'address', 'contact_person', 'years_in_business']);
      v = (await getVendor(v.id)) || v;
      const miss3 = vendorMissingFields(v);
      for (const s of list) {
        const fn = s.field;
        if (!fn || !allowed.has(fn) || !miss3.includes(fn)) continue;
        const val = (s.value || '').trim();
        const url = (s.sourceUrl || '').trim();
        if (!val || !url) continue;
        if (await applyVendorFieldIfEmpty(v.id, fn, val, { source_url: url })) {
          applied += 1;
          summary.vendorFieldUpdates += 1;
        }
      }
    }
    if (snippets.length) {
      const extra = await applyHeuristicContactsFromSnippets(v.id, snippets, summary);
      applied += extra;
    }
  }

  v = (await getVendor(v.id)) || v;
  const prevStatus = v.agent_enrichment_status || '';
  const newStreak = applied > 0 ? 0 : Math.min((v.research_miss_streak || 0) + 1, 99);
  let agentStatus = 'searching';
  if (newStreak >= 3) agentStatus = 'manual_lookup';
  else if (applied > 0) agentStatus = 'found_saved';
  else if (prevStatus === 'found_saved') agentStatus = 'found_saved';

  await updateVendor(v.id, {
    research_miss_streak: newStreak,
    agent_enrichment_status: agentStatus,
  });

  if (applied > 0) {
    await logAgentActivity({
      activity_type: 'enrich',
      vendor_id: v.id,
      summary: `Auto-filled ${applied} field(s)`,
      detail: { runId },
    });
  }
  await maybeAutoDraftOutreach(v.id, summary, aiKey);
}

/** Second pass: blocked vendors not in the main enrich slice — Serp “{name} San Diego contact email” only. */
async function enrichBlockedVendorDirectedOnly(runId, summary, vendorId, sKey, aiKey) {
  let v = await ensureResearchWeek(await getVendor(vendorId));
  if (!v || (v.status !== 'not_sent' && v.status !== 'new') || !vendorBlockedOnContact(v)) return;

  const prevStatus = v.agent_enrichment_status || '';
  await updateVendor(v.id, { agent_enrichment_status: 'searching' });

  let applied = 0;
  const snippets = [];
  try {
    const org = await ext.serpGoogleOrganic(`${v.name} San Diego contact email`, sKey, 10);
    for (const o of org) {
      snippets.push({ title: o.title, url: o.link, snippet: o.snippet || '' });
    }
  } catch (e) {
    summary.errors.push(`Serp blocked ${v.name}: ${e.message || e}`);
  }

  if (snippets.length && aiKey) {
    const parsed = await extractVendorFieldsFromSnippets(v, snippets);
    const list = Array.isArray(parsed.suggestions) ? parsed.suggestions : [];
    const allowed = new Set(['phone', 'email', 'website', 'address', 'contact_person', 'years_in_business']);
    v = (await getVendor(v.id)) || v;
    const miss3 = vendorMissingFields(v);
    for (const s of list) {
      const fn = s.field;
      if (!fn || !allowed.has(fn) || !miss3.includes(fn)) continue;
      const val = (s.value || '').trim();
      const url = (s.sourceUrl || '').trim();
      if (!val || !url) continue;
      if (await applyVendorFieldIfEmpty(v.id, fn, val, { source_url: url })) {
        applied += 1;
        summary.vendorFieldUpdates += 1;
      }
    }
  }
  if (snippets.length) {
    applied += await applyHeuristicContactsFromSnippets(v.id, snippets, summary);
  }

  v = (await getVendor(v.id)) || v;
  const newStreak = applied > 0 ? 0 : Math.min((v.research_miss_streak || 0) + 1, 99);
  let agentStatus = 'searching';
  if (newStreak >= 3) agentStatus = 'manual_lookup';
  else if (applied > 0) agentStatus = 'found_saved';
  else if (prevStatus === 'found_saved') agentStatus = 'found_saved';

  await updateVendor(v.id, {
    research_miss_streak: newStreak,
    agent_enrichment_status: agentStatus,
  });

  if (applied > 0) {
    await logAgentActivity({
      activity_type: 'enrich',
      vendor_id: v.id,
      summary: `Auto-filled ${applied} field(s) (contact search)`,
      detail: { runId },
    });
  }
  await maybeAutoDraftOutreach(v.id, summary, aiKey);
}

async function enrichVendors(runId, summary, gKey, sKey, aiKey) {
  const vendors = await listVendors();
  const need = vendors.filter((v) => vendorMissingFields(v).length > 0);
  need.sort((a, b) => {
    const ca = CATEGORY_PRIORITY[a.category] ?? 9;
    const cb = CATEGORY_PRIORITY[b.category] ?? 9;
    if (ca !== cb) return ca - cb;
    return vendorMissingFields(b).length - vendorMissingFields(a).length;
  });
  const slice = need.slice(0, MAX_VENDORS_ENRICH);
  const enrichedIds = new Set(slice.map((x) => x.id));
  for (const v of slice) {
    try {
      await enrichOneVendor(runId, summary, v, gKey, sKey, aiKey);
    } catch (e) {
      summary.errors.push(`Enrich vendor ${v.id} (${v.name}): ${e.message || e}`);
    }
  }

  if (sKey) {
    let extra = 0;
    for (const id of await listBlockedVendorIdsForAgent()) {
      if (enrichedIds.has(id)) continue;
      if (extra >= MAX_BLOCKED_EXTRA_SERPS) break;
      extra += 1;
      try {
        await enrichBlockedVendorDirectedOnly(runId, summary, id, sKey, aiKey);
      } catch (e) {
        summary.errors.push(`Blocked enrich ${id}: ${e.message || e}`);
      }
    }
  }
}

/**
 * Google Places Text Search + Place Details (`GOOGLE_PLACES_API_KEY` / `getGooglePlacesApiKey()`).
 * Inserts only when rating >= 4.0, user_ratings_total >= 20, business_status === OPERATIONAL.
 */
async function discoverNewProspects(runId, summary, placesKey, aiKey) {
  const log = (...a) => console.log('[discovery]', ...a);
  const querySpecs = rotateDiscoveryTextSpecs(runId);
  log('start runId=%s placesTextQueries=%s', runId, querySpecs.length);

  await logDiscoveryActivity(runId, 'discovery_run_start', 'Discovery run started (Google Places Text Search + Details)', {
    api: 'place/textsearch/json + place/details/json',
    location_suffix: PLACES_DISCOVERY_LOCATION_SUFFIX,
    query_pool_size: DISCOVERY_PLACES_TEXT_SPECS.length,
    queries: querySpecs.map((s) =>
      s.appendLocationSuffix === false ? String(s.text || '').trim() : `${s.text} ${PLACES_DISCOVERY_LOCATION_SUFFIX}`.trim()
    ),
  });

  const pendingList = await listPendingNewProspects({ status: 'pending' });
  const takenNames = new Set(pendingList.map((p) => normalizeNameDedupe(p.name)));
  const seenRunKeys = new Set();

  let textSearchRowsSeen = 0;
  let skippedDedupe = 0;
  let skippedVendor = 0;
  let skippedFilter = 0;
  let skippedLowReviews = 0;
  let skippedLowRating = 0;
  let skippedNonOperational = 0;
  let skippedNoDetails = 0;
  let skippedExcludedVenueType = 0;
  let vendorsAutoRegistered = 0;

  for (const spec of querySpecs) {
    const fullQuery =
      spec.appendLocationSuffix === false
        ? String(spec.text || '').trim()
        : `${spec.text} ${PLACES_DISCOVERY_LOCATION_SUFFIX}`.trim();

    await logDiscoveryActivity(runId, 'discovery_places_text_search', `Places Text Search: ${fullQuery}`, {
      endpoint: 'https://maps.googleapis.com/maps/api/place/textsearch/json',
      query: fullQuery,
      crm_category: spec.category,
      category_label: spec.category_label,
    });

    let rawResults;
    try {
      rawResults = await ext.googlePlacesTextSearchAll(fullQuery, placesKey, { maxPages: 2 });
    } catch (e) {
      const msg = e.message || String(e);
      summary.errors.push(`Places Text Search "${fullQuery}": ${msg}`);
      await logDiscoveryActivity(runId, 'discovery_places_error', `Text Search failed: ${fullQuery}`, { query: fullQuery, error: msg });
      log('places text search ERROR q=%s: %s', fullQuery, msg);
      continue;
    }

    await logDiscoveryActivity(runId, 'discovery_places_text_results', `Text Search returned ${rawResults.length} raw result(s)`, {
      query: fullQuery,
      text_search_result_count: rawResults.length,
    });

    for (const hit of rawResults) {
      if (vendorsAutoRegistered >= MAX_AUTO_VENDOR_REGISTRATIONS_PER_RUN) break;

      const placeIdRaw = String(hit.place_id || '').trim();
      textSearchRowsSeen += 1;

      const tsName = String(hit.name || '').trim();
      const tsAddr = String(hit.formatted_address || '').trim();
      const tsRating = hit.rating != null ? Number(hit.rating) : null;
      const tsTotal = hit.user_ratings_total != null ? Number(hit.user_ratings_total) : null;

      await logDiscoveryActivity(runId, 'discovery_places_text_hit', `TextSearch row: ${tsName || placeIdRaw || '—'}`, {
        query: fullQuery,
        crm_category: spec.category,
        place_id: placeIdRaw || undefined,
        text_search_preview: {
          name: tsName || undefined,
          formatted_address: tsAddr || undefined,
          rating: Number.isFinite(tsRating) ? tsRating : undefined,
          user_ratings_total: Number.isFinite(tsTotal) ? tsTotal : undefined,
          types: Array.isArray(hit.types) ? hit.types : undefined,
        },
      });

      if (!placeIdRaw) {
        skippedFilter += 1;
        await logDiscoveryActivity(runId, 'discovery_places_candidate', 'Skipped — no place_id from Text Search', {
          query: fullQuery,
          outcome: 'skipped',
          skip_reason: 'no_place_id',
        });
        continue;
      }

      const dedupeKey = placesDedupeKey(placeIdRaw);
      if (!dedupeKey) {
        skippedFilter += 1;
        continue;
      }

      if (seenRunKeys.has(dedupeKey)) {
        skippedDedupe += 1;
        await logDiscoveryActivity(runId, 'discovery_places_candidate', `Skipped — duplicate place in run: ${tsName}`, {
          query: fullQuery,
          place_id: placeIdRaw,
          dedupe_key: dedupeKey,
          outcome: 'skipped',
          skip_reason: 'duplicate_in_run',
        });
        continue;
      }
      seenRunKeys.add(dedupeKey);

      const tsTypes = Array.isArray(hit.types) ? hit.types : [];
      if (isExcludedLodgingOrRestaurantVenue(tsTypes, tsName)) {
        skippedExcludedVenueType += 1;
        await logDiscoveryActivity(runId, 'discovery_places_candidate', `Filtered out (lodging/restaurant): ${tsName}`, {
          query: fullQuery,
          crm_category: spec.category,
          place_id: placeIdRaw,
          outcome: 'filtered_out',
          filter_reason: 'excluded_lodging_or_restaurant',
          text_search_preview: {
            name: tsName || undefined,
            types: tsTypes.length ? tsTypes : undefined,
          },
        });
        continue;
      }

      let det;
      try {
        det = await ext.googlePlaceDetails(placeIdRaw, placesKey);
      } catch (e) {
        const msg = e.message || String(e);
        summary.errors.push(`Place Details ${placeIdRaw}: ${msg}`);
        await logDiscoveryActivity(runId, 'discovery_places_error', `Place Details failed: ${placeIdRaw}`, { place_id: placeIdRaw, error: msg });
        skippedNoDetails += 1;
        continue;
      }

      if (!det) {
        skippedNoDetails += 1;
        await logDiscoveryActivity(runId, 'discovery_places_candidate', `No Place Details: ${tsName}`, {
          query: fullQuery,
          place_id: placeIdRaw,
          outcome: 'skipped',
          skip_reason: 'no_place_details',
        });
        continue;
      }

      const name = String(det.name || tsName || '').trim();
      const phone = String(det.formatted_phone_number || '').trim();
      const website = String(det.website || '').trim();
      const address = String(det.formatted_address || tsAddr || '').trim();
      const rating = det.rating != null ? Number(det.rating) : null;
      const totalRatings = det.user_ratings_total != null ? Number(det.user_ratings_total) : NaN;
      const totalRatingsN = Number.isFinite(totalRatings) ? totalRatings : 0;
      const biz = String(det.business_status || '').toUpperCase();
      const types = Array.isArray(det.types) ? det.types : [];
      const mapUrl = det.url ? String(det.url) : '';

      const detailExtract = {
        query: fullQuery,
        crm_category: spec.category,
        category_label: spec.category_label,
        place_id: placeIdRaw,
        name,
        phone: phone || undefined,
        website: website || undefined,
        address: address || undefined,
        rating: rating != null && Number.isFinite(rating) ? rating : undefined,
        user_ratings_total: totalRatingsN,
        business_status: biz || undefined,
        types,
        maps_url: mapUrl || undefined,
      };

      await logDiscoveryActivity(runId, 'discovery_places_details', `Place Details extracted: ${name}`, {
        ...detailExtract,
        dedupe_key: dedupeKey,
      });

      if (isExcludedLodgingOrRestaurantVenue(types, name)) {
        skippedExcludedVenueType += 1;
        await logDiscoveryActivity(runId, 'discovery_places_candidate', `Filtered out (lodging/restaurant): ${name}`, {
          ...detailExtract,
          dedupe_key: dedupeKey,
          outcome: 'filtered_out',
          filter_reason: 'excluded_lodging_or_restaurant',
        });
        continue;
      }

      let filterReason = '';
      if (!name) filterReason = 'empty_name';
      else if (rating == null || !Number.isFinite(rating)) filterReason = 'missing_rating';
      else if (rating < MIN_PLACES_RATING) filterReason = 'below_min_rating';
      else if (totalRatingsN < MIN_PLACES_USER_RATINGS_TOTAL) filterReason = 'below_min_user_ratings_total';
      else if (biz !== 'OPERATIONAL') filterReason = `business_status_not_operational:${biz || 'UNKNOWN'}`;

      if (filterReason) {
        if (filterReason === 'below_min_user_ratings_total') skippedLowReviews += 1;
        else if (filterReason === 'below_min_rating') skippedLowRating += 1;
        else if (filterReason.startsWith('business_status')) skippedNonOperational += 1;
        else skippedFilter += 1;

        await logDiscoveryActivity(
          runId,
          'discovery_places_candidate',
          `Filtered out: ${name} — ${filterReason}`,
          {
            ...detailExtract,
            dedupe_key: dedupeKey,
            outcome: 'filtered_out',
            filter_reason: filterReason,
            thresholds: { min_rating: MIN_PLACES_RATING, min_user_ratings_total: MIN_PLACES_USER_RATINGS_TOTAL, require_status: 'OPERATIONAL' },
          }
        );
        continue;
      }

      if (await pendingProspectDedupeExists(dedupeKey)) {
        skippedDedupe += 1;
        await logDiscoveryActivity(runId, 'discovery_places_candidate', `Skipped — pending queue: ${name}`, {
          ...detailExtract,
          dedupe_key: dedupeKey,
          outcome: 'skipped',
          skip_reason: 'pending_dedupe_key',
        });
        continue;
      }

      if (await isNameTaken(name, takenNames)) {
        skippedVendor += 1;
        await logDiscoveryActivity(runId, 'discovery_places_candidate', `Skipped — already in CRM: ${name}`, {
          ...detailExtract,
          dedupe_key: dedupeKey,
          outcome: 'skipped',
          skip_reason: 'existing_vendor_or_pending_name',
        });
        continue;
      }

      const noteParts = [
        'Source: discovery agent (Google Places API — Text Search + Place Details).',
        `Text query: ${fullQuery}`,
        `CRM category: ${spec.category_label} (${spec.category}).`,
        `Google types: ${types.length ? types.slice(0, 8).join(', ') : '—'}.`,
        `Rating: ${rating}★ · user_ratings_total: ${totalRatingsN} · status: ${biz}.`,
        mapUrl ? `Maps: ${mapUrl}` : '',
        `Dedupe: ${dedupeKey}`,
      ].filter(Boolean);

      try {
        const v = await insertVendor({
          name,
          category: spec.category,
          contact_person: '',
          email: '',
          phone,
          website,
          years_in_business: '',
          address,
          notes: noteParts.join('\n\n'),
          status: 'new',
          source: 'discovery_agent',
        });
        vendorsAutoRegistered += 1;
        takenNames.add(normalizeNameDedupe(name));
        summary.newProspects = (summary.newProspects || 0) + 1;

        if (aiKey && (v.email || '').trim()) {
          await maybeAutoDraftOutreach(v.id, summary, aiKey);
        }

        const iso = new Date().toISOString();
        await logAgentActivity({
          activity_type: 'discovery_register',
          vendor_id: v.id,
          summary: `Registry: auto-added ${name} (${spec.category}) [Google Places]`,
          detail: {
            runId,
            dedupeKey,
            place_id: placeIdRaw,
            user_ratings_total: totalRatingsN,
            rating,
            query: fullQuery,
            category_label: spec.category_label,
            types,
            business_status: biz,
            iso_timestamp: iso,
          },
        });

        await logDiscoveryActivity(runId, 'discovery_places_candidate', `Inserted: ${name}`, {
          ...detailExtract,
          dedupe_key: dedupeKey,
          outcome: 'inserted',
          vendor_id: v.id,
        });

        log('REGISTRY insert id=%s name=%s rating=%s user_ratings_total=%s', v.id, name, rating, totalRatingsN);
      } catch (e) {
        const msg = String(e.message || e);
        if (msg.includes('UNIQUE') || msg.includes('unique')) {
          skippedDedupe += 1;
          await logDiscoveryActivity(runId, 'discovery_places_candidate', `Skipped — DB unique: ${name}`, {
            ...detailExtract,
            outcome: 'skipped',
            skip_reason: 'unique_constraint',
          });
          log('skip UNIQUE name=%s', name);
          continue;
        }
        summary.errors.push(`Registry insert ${name}: ${msg}`);
        await logDiscoveryActivity(runId, 'discovery_places_error', `Insert failed: ${name}`, { error: msg, ...detailExtract });
        log('REGISTRY ERROR name=%s: %s', name, msg);
      }
    }

    if (vendorsAutoRegistered >= MAX_AUTO_VENDOR_REGISTRATIONS_PER_RUN) {
      await logDiscoveryActivity(runId, 'discovery_cap', `Registry cap reached (${MAX_AUTO_VENDOR_REGISTRATIONS_PER_RUN} this run)`, {});
      log('registry cap reached, stopping discovery');
      break;
    }
  }

  summary.vendorsAutoRegistered = vendorsAutoRegistered;
  summary.exclusionHits = skippedExcludedVenueType;
  summary.discoveryStats = {
    textSearchRowsSeen,
    vendorsAutoRegistered,
    skippedDedupe,
    skippedVendor,
    skippedLowReviews,
    skippedLowRating,
    skippedNonOperational,
    skippedNoDetails,
    skippedFilter,
    skippedExcludedVenueType,
  };

  await logDiscoveryActivity(
    runId,
    'discovery_run_complete',
    `Discovery finished: ${vendorsAutoRegistered} inserted, ${skippedVendor} in CRM, ${skippedLowReviews} low reviews, ${skippedLowRating} low rating, ${skippedNonOperational} not OPERATIONAL, ${skippedExcludedVenueType} lodging/restaurant`,
    summary.discoveryStats
  );

  log(
    'done vendorsAutoRegistered=%s textSearchRowsSeen=%s skippedDedupe=%s skippedVendor=%s',
    vendorsAutoRegistered,
    textSearchRowsSeen,
    skippedDedupe,
    skippedVendor
  );
}

async function ensureVendorOutreachDrafts(summary) {
  const aiKey = getApiKey();
  if (!aiKey) return;
  const gKey = getGooglePlacesApiKey();
  const sKey = getSerpApiKey();
  const allV = await listVendors();
  const vendors = [];
  for (const v of allV) {
    if ((v.status === 'not_sent' || v.status === 'new') && (v.email || '').trim() && !(await vendorHasPendingOutreachDraft(v.id))) {
      vendors.push(v);
    }
  }
  vendors.sort((a, b) => {
    const ca = CATEGORY_PRIORITY[a.category] ?? 9;
    const cb = CATEGORY_PRIORITY[b.category] ?? 9;
    if (ca !== cb) return ca - cb;
    return String(a.name).localeCompare(String(b.name));
  });
  let n = 0;
  for (const v0 of vendors) {
    if (n >= MAX_OUTREACH_DRAFTS_PER_RUN) break;
    const v = await getVendor(v0.id);
    if (!v || !(v.email || '').trim()) continue;
    try {
      const learning = await formatLearningHints(v);
      const brief = await buildOutreachResearchBrief(v, { googlePlacesKey: gKey, serpKey: sKey });
      const text = await generateVendorLetter(v, learning, brief);
      const t = String(text || '').trim();
      if (!t) continue;
      if (isManualResearchLetterOutput(t)) {
        await logAgentActivity({
          activity_type: 'outreach_manual_research',
          vendor_id: v.id,
          summary: 'Outreach draft skipped — manual research needed',
          detail: { reason: getManualResearchLetterReason(t) },
        });
        continue;
      }
      const lines = t.split(/\r?\n/).filter(Boolean);
      let subject = `Partnership — Tri Express Plumbing & ${v.name}`;
      let body = t;
      const subLine = lines.find((l) => /^subject:\s*/i.test(l));
      if (subLine) {
        subject = subLine.replace(/^subject:\s*/i, '').trim().slice(0, 200);
        body = lines
          .filter((l) => l !== subLine)
          .join('\n')
          .trim();
      }
      await upsertVendorOutreachDraft(v.id, subject, body, { draft_type: 'outreach' });
      await logAgentActivity({
        activity_type: 'draft_created',
        vendor_id: v.id,
        summary: 'Outreach email draft generated',
        detail: {},
      });
      await sendSMS(`📧 Tri Express: Email ready to send to ${v.name}. Open app to approve and send.`, {
        alertType: 'email_ready',
        eventKey: `vendor:${v.id}`,
      });
      summary.outreachDraftsCreated = (summary.outreachDraftsCreated || 0) + 1;
      n += 1;
    } catch (e) {
      summary.errors.push(`Draft for ${v.name}: ${e.message || e}`);
    }
  }
}

async function sendOverdueFollowupAlerts() {
  try {
    const rows = await listOverdue();
    for (const v of rows) {
      const overdueDays = Math.max(0, -(Number(v.daysUntilFollowup) || 0));
      if (overdueDays <= 7) continue;
      await sendSMS(
        `⏰ Tri Express: ${v.name} is overdue for follow-up by ${overdueDays} days. Open app to take action.`,
        {
          alertType: 'followup_overdue',
          eventKey: `vendor:${v.id}`,
        }
      );
    }
  } catch (e) {
    console.error('[sms] overdue follow-up alerts failed:', e?.message || e);
  }
}

/**
 * Background agent: auto-enrich vendors, discovery (Google Places Text Search), outreach drafts.
 * @param {{ discovery?: boolean }} opts — pass `{ discovery: false }` to skip new-company discovery
 */
export async function runResearchAgent(opts = {}) {
  if (researchAgentRunBusy) {
    console.warn('[research-agent] skip — another run is still in progress (cron, live loop, or manual).');
    return;
  }
  researchAgentRunBusy = true;
  const discoveryEnabled = opts.discovery !== false;
  let runId;
  const summary = {
    vendorFieldUpdates: 0,
    newProspects: 0,
    vendorsAutoRegistered: 0,
    exclusionHits: 0,
    outreachDraftsCreated: 0,
    skippedNoSearchKeys: false,
    discoverySkippedNoPlacesApi: false,
    errors: [],
  };
  try {
    runId = await insertBackgroundAgentRun();
  } catch (e) {
    researchAgentRunBusy = false;
    throw e;
  }
  const gKey = getGooglePlacesApiKey();
  const sKey = getSerpApiKey();
  const aiKey = getApiKey();

  try {
    if (!gKey && !sKey) {
      summary.skippedNoSearchKeys = true;
    } else {
      await enrichVendors(runId, summary, gKey, sKey, aiKey);
    }

    if (discoveryEnabled) {
      if (gKey) {
        await discoverNewProspects(runId, summary, gKey, aiKey);
      } else {
        summary.discoverySkippedNoPlacesApi = true;
        console.warn(
          '[research-agent] Discovery skipped: GOOGLE_PLACES_API_KEY not resolved. Set GOOGLE_PLACES_API_KEY in the environment, or add googlePlacesApiKey to .tep-config.json (see getGooglePlacesApiKey in config.js).'
        );
        await logDiscoveryActivity(runId, 'discovery_skipped', 'Discovery skipped — Google Places API key required (Text Search + Details)', {
          hasGooglePlacesApiKey: false,
        });
      }
    }

    await ensureVendorOutreachDrafts(summary);
    await sendOverdueFollowupAlerts();

    await completeBackgroundAgentRun(runId, 'completed', summary, '');
  } catch (e) {
    const msg = e.message || String(e);
    summary.errors.push(msg);
    await completeBackgroundAgentRun(runId, 'failed', summary, msg);
  } finally {
    researchAgentRunBusy = false;
  }
}

/** Cron + callers: discovery runs every day unless `{ discovery: false }`. */
export async function runResearchAndOutreachAgent(opts = {}) {
  return runResearchAgent({
    ...opts,
    discovery: opts.discovery !== undefined ? Boolean(opts.discovery) : true,
  });
}

/** Daily 06:00 — enrich + discovery (Google Places) + drafts. */
export function startResearchAgentScheduler() {
  cron.schedule('0 6 * * *', () => {
    runResearchAndOutreachAgent().catch((err) => console.error('[research-agent]', err));
  });
}

/**
 * Non-stop loop: enrich + discovery (auto-registry) + drafts on an interval.
 * Configure with LIVE_AGENT_INTERVAL_MINUTES or LIVE_AGENT_MODE=true (default 30 min).
 */
export function startLiveAgentLoop() {
  const mins = getLiveAgentIntervalMinutes();
  if (!mins) return;
  if (liveAgentIntervalHandle) clearInterval(liveAgentIntervalHandle);
  const ms = mins * 60 * 1000;
  console.log(
    `[live-agent] Running every ${mins} min (enrich + Google Places discovery + auto-registry + drafts). Overlap skipped if a run is still in progress.`
  );
  const tick = () => {
    runResearchAgent().catch((err) => console.error('[live-agent]', err));
  };
  liveAgentIntervalHandle = setInterval(tick, ms);
  setTimeout(tick, 15_000);
}
