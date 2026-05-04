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
} from './db.js';
import * as ext from './externalSearch.js';
import { buildOutreachResearchBrief } from './outreachResearch.js';
import {
  qualifyDiscoveryProspect,
  extractVendorFieldsFromSnippets,
  generateVendorLetter,
  ensureAgentEmailDraftHasContact,
  isManualResearchLetterOutput,
  getManualResearchLetterReason,
} from './ai.js';

const MAX_VENDORS_ENRICH = 16;
const MAX_BLOCKED_EXTRA_SERPS = 24;
const MAX_PROSPECT_AI_CALLS = 36;
const MAX_AUTO_VENDOR_REGISTRATIONS_PER_RUN = 14;
const MAX_OUTREACH_DRAFTS_PER_RUN = 4;

const CATEGORY_PRIORITY = { restoration: 0, property_mgmt: 1, hoa: 2, contractor: 3 };

/**
 * San Diego County discovery — maps to vendor categories (restoration | property_mgmt | hoa | contractor).
 * `search_focus` guides AI triage (50+ units, franchises, recurring plumbing, etc.).
 */
const DISCOVERY_QUERIES = [
  {
    q: 'large apartment property management 200 units',
    category: 'property_mgmt',
    prospect_subtype: '50_plus_units',
    search_focus:
      'Property management firms likely managing 50+ residential units in San Diego County. Prioritize recurring plumbing (turnovers, boilers, common-area restrooms, irrigation).',
  },
  {
    q: 'commercial office building property management',
    category: 'property_mgmt',
    prospect_subtype: 'commercial_re_manager',
    search_focus:
      'Commercial real estate / building property managers (office, retail, mixed-use). Recurring maintenance plumbing.',
  },
  {
    q: 'homeowners association management companies',
    category: 'hoa',
    prospect_subtype: 'hoa_management',
    search_focus: 'Established HOA / community association management companies (not single HOAs without mgmt co.). Recurring vendor needs.',
  },
  {
    q: 'community association management large HOA',
    category: 'hoa',
    prospect_subtype: 'large_community',
    search_focus: 'Large planned communities / master associations with ongoing facilities spend.',
  },
  { q: 'Servpro restoration', category: 'restoration', prospect_subtype: 'franchise_servpro', search_focus: 'ServPro franchise locations only.' },
  { q: 'ServiceMaster Restore', category: 'restoration', prospect_subtype: 'franchise_servicemaster', search_focus: 'ServiceMaster Restore franchise locations only.' },
  { q: 'Paul Davis restoration', category: 'restoration', prospect_subtype: 'franchise_paul_davis', search_focus: 'Paul Davis Restoration franchise locations only.' },
  {
    q: 'full service hotel resort',
    category: 'contractor',
    prospect_subtype: 'hotel',
    search_focus: 'Hotels and resorts — engineering / facilities plumbing, guest rooms, kitchens.',
  },
  {
    q: 'unified school district office',
    category: 'contractor',
    prospect_subtype: 'school_district',
    search_focus: 'K–12 school districts and large campus facilities (not small private tutors).',
  },
  {
    q: 'hospital medical center campus',
    category: 'contractor',
    prospect_subtype: 'healthcare',
    search_focus: 'Hospitals, medical centers, clinics with building engineering — recurring mechanical/plumbing.',
  },
  {
    q: 'assisted living memory care senior living',
    category: 'contractor',
    prospect_subtype: 'senior_living',
    search_focus: 'Senior living, assisted living, skilled nursing facilities — high plumbing touch.',
  },
];

const SD_MAPS_Q_SUFFIX = ' San Diego County CA';

const MIN_GOOGLE_REVIEWS = 10;

/** For restoration franchise queries, listing title must match the target brand. */
function matchesFranchiseDiscoveryName(name, prospectSubtype) {
  const st = String(prospectSubtype || '');
  if (!st.startsWith('franchise_')) return true;
  const n = name.toLowerCase();
  if (st === 'franchise_servpro') return n.includes('servpro');
  if (st === 'franchise_servicemaster') return n.includes('servicemaster') || n.includes('service master');
  if (st === 'franchise_paul_davis') return n.includes('paul davis');
  return true;
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

async function discoverNewProspects(runId, summary, sKey, aiKey) {
  const log = (...a) => console.log('[discovery]', ...a);
  log('start runId=%s queries=%s aiBudget=%s', runId, DISCOVERY_QUERIES.length, MAX_PROSPECT_AI_CALLS);
  const pendingList = await listPendingNewProspects({ status: 'pending' });
  const takenNames = new Set(pendingList.map((p) => normalizeNameDedupe(p.name)));
  log('pending suggested_companies (queue) count=%s', pendingList.length);
  let aiCalls = 0;
  let mapsTotal = 0;
  let skippedDedupe = 0;
  let skippedVendor = 0;
  let skippedQualify = 0;
  let skippedRegistryCap = 0;
  let skippedLowReviews = 0;
  let skippedNoWebsite = 0;
  let skippedFranchiseMismatch = 0;
  let vendorsAutoRegistered = 0;

  for (const spec of DISCOVERY_QUERIES) {
    if (aiCalls >= MAX_PROSPECT_AI_CALLS) {
      log('AI call budget exhausted (aiCalls=%s), stopping query loop', aiCalls);
      break;
    }
    const mapsQ = `${spec.q}${SD_MAPS_Q_SUFFIX}`;
    log('--- query spec category=%s subtype=%s mapsQ=%s', spec.category, spec.prospect_subtype || '—', mapsQ);
    let locals;
    try {
      locals = await ext.serpGoogleMapsLocal(mapsQ, sKey);
    } catch (e) {
      const msg = e.message || String(e);
      summary.errors.push(`Maps search "${mapsQ}": ${msg}`);
      log('Maps ERROR q=%s: %s', mapsQ, msg);
      continue;
    }
    mapsTotal += locals.length;
    log('Maps candidates for this query: %s (using up to 8 for triage)', locals.length);
    for (const loc of locals.slice(0, 8)) {
      if (aiCalls >= MAX_PROSPECT_AI_CALLS) break;
      const name = (loc.title || '').trim();
      if (!name) {
        log('skip empty Maps title');
        continue;
      }
      const placeId = String(loc.place_id || '').trim();
      const dedupeKey = placeId ? `gplace:${placeId}` : `name:${normalizeNameDedupe(name)}`;
      if (await pendingProspectDedupeExists(dedupeKey)) {
        skippedDedupe += 1;
        log('skip dedupe pending exists name=%s key=%s', name, dedupeKey);
        continue;
      }
      if (await isNameTaken(name, takenNames)) {
        skippedVendor += 1;
        log('skip name matches existing vendor or pending name=%s', name);
        continue;
      }

      const reviewCount = Number(loc.reviews) || 0;
      if (reviewCount < MIN_GOOGLE_REVIEWS) {
        skippedLowReviews += 1;
        log('skip reviews=%s (need >=%s) name=%s', reviewCount, MIN_GOOGLE_REVIEWS, name);
        continue;
      }
      if (!(String(loc.website || '').trim())) {
        skippedNoWebsite += 1;
        log('skip no listing website (online presence gate) name=%s', name);
        continue;
      }
      if (!matchesFranchiseDiscoveryName(name, spec.prospect_subtype)) {
        skippedFranchiseMismatch += 1;
        log('skip franchise brand mismatch name=%s subtype=%s', name, spec.prospect_subtype || '—');
        continue;
      }

      const evidenceUrls = [];
      if (loc.website) evidenceUrls.push({ url: loc.website, title: `${name} — Maps listing website` });
      let extraOrg = [];
      try {
        extraOrg = await ext.serpGoogleOrganic(
          `"${name}" San Diego website years business founded reviews online`,
          sKey,
          6
        );
      } catch (e) {
        log('organic optional fail for %s: %s', name, e.message || e);
      }
      for (const o of extraOrg) {
        evidenceUrls.push({ url: o.link, title: o.title });
      }

      const organicSnippets = extraOrg.map((o) => ({
        title: o.title,
        url: o.link,
        snippet: o.snippet || '',
      }));

      const payload = {
        companyName: name,
        category: spec.category,
        prospect_subtype: spec.prospect_subtype || null,
        search_focus: spec.search_focus || '',
        discoveryHardFilters: {
          minGoogleReviews: MIN_GOOGLE_REVIEWS,
          listingWebsiteRequired: true,
          reviewCountObserved: reviewCount,
        },
        mapsListing: {
          address: loc.address,
          phone: loc.phone,
          website: loc.website,
          reviews: loc.reviews,
          type: loc.type,
        },
        evidenceUrls,
        organicSnippets,
      };

      log(
        'triage name=%s phone=%s addr=%s web=%s reviews=%s',
        name,
        (loc.phone || '').slice(0, 22),
        (loc.address || '').slice(0, 48),
        (loc.website || '').slice(0, 40),
        loc.reviews ?? '—'
      );

      let out;
      try {
        out = await qualifyDiscoveryProspect(payload);
        aiCalls += 1;
      } catch (e) {
        summary.errors.push(`Qualify ${name}: ${e.message || e}`);
        log('qualify ERROR name=%s: %s', name, e.message || e);
        continue;
      }
      if (!out || !out.qualifies) {
        skippedQualify += 1;
        log(
          'skip AI triage name=%s qualifies=false summary=%s',
          name,
          String(out?.evidenceSummary || out?.onlineNotes || 'no reason').slice(0, 160)
        );
        continue;
      }

      if (vendorsAutoRegistered >= MAX_AUTO_VENDOR_REGISTRATIONS_PER_RUN) {
        skippedRegistryCap += 1;
        log('skip registry cap reached (%s this run)', MAX_AUTO_VENDOR_REGISTRATIONS_PER_RUN);
        continue;
      }

      takenNames.add(normalizeNameDedupe(name));
      const mergedEvidence = Array.isArray(out.evidenceUrls) && out.evidenceUrls.length ? out.evidenceUrls : evidenceUrls;
      const noteParts = [
        'Source: live discovery agent (SerpApi + AI).',
        out.evidenceSummary ? `Tenure / fit: ${out.evidenceSummary}` : '',
        out.onlineNotes ? `Notes: ${out.onlineNotes}` : '',
        spec.prospect_subtype ? `Focus: ${spec.prospect_subtype}` : '',
        `Dedupe: ${dedupeKey}`,
      ].filter(Boolean);

      try {
        const v = await insertVendor({
          name,
          category: spec.category,
          contact_person: out.contactPerson || '',
          email: (out.email || '').trim(),
          phone: (out.phone || loc.phone || '').trim(),
          website: (out.website || loc.website || '').trim(),
          years_in_business: (out.yearsInBusiness || '').trim(),
          address: (out.address || loc.address || '').trim(),
          notes: noteParts.join('\n\n'),
        });
        vendorsAutoRegistered += 1;
        summary.newProspects = (summary.newProspects || 0) + 1;

        const draftRaw = ensureAgentEmailDraftHasContact(out.outreachEmailDraft || '');
        if (draftRaw) {
          const parsed = splitSubjectBodyFromLetterText(draftRaw);
          let subject = parsed.subject;
          let body = parsed.body;
          if (!subject) subject = `Partnership — Tri Express Plumbing & ${name}`;
          if (!body) body = draftRaw;
          await upsertVendorOutreachDraft(v.id, subject, body, { draft_type: 'outreach' });
          summary.outreachDraftsCreated = (summary.outreachDraftsCreated || 0) + 1;
        } else if (aiKey && (v.email || '').trim()) {
          await maybeAutoDraftOutreach(v.id, summary, aiKey);
        }

        await logAgentActivity({
          activity_type: 'discovery_register',
          vendor_id: v.id,
          summary: `Registry: auto-added ${name} (${spec.category})`,
          detail: { runId, dedupeKey, evidenceCount: mergedEvidence.length },
        });

        log(
          'REGISTRY insert vendor id=%s name=%s phone=%s email=%s draft=%s',
          v.id,
          name,
          (v.phone || '').slice(0, 22),
          (v.email || '').includes('@') ? 'yes' : 'no',
          draftRaw ? 'yes' : 'no'
        );
      } catch (e) {
        const msg = String(e.message || e);
        if (msg.includes('UNIQUE') || msg.includes('unique')) {
          skippedDedupe += 1;
          log('skip vendor insert UNIQUE name=%s key=%s', name, dedupeKey);
          continue;
        }
        summary.errors.push(`Registry insert ${name}: ${msg}`);
        log('REGISTRY ERROR name=%s: %s', name, msg);
      }
    }
  }
  summary.vendorsAutoRegistered = vendorsAutoRegistered;
  log(
    'done vendorsAutoRegistered=%s newProspects=%s mapsRowsSeen=%s aiCalls=%s skippedDedupe=%s skippedVendor=%s skippedLowReviews=%s skippedNoWebsite=%s skippedFranchise=%s skippedQualify=%s skippedRegistryCap=%s',
    vendorsAutoRegistered,
    summary.newProspects,
    mapsTotal,
    aiCalls,
    skippedDedupe,
    skippedVendor,
    skippedLowReviews,
    skippedNoWebsite,
    skippedFranchiseMismatch,
    skippedQualify,
    skippedRegistryCap
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
      summary.outreachDraftsCreated = (summary.outreachDraftsCreated || 0) + 1;
      n += 1;
    } catch (e) {
      summary.errors.push(`Draft for ${v.name}: ${e.message || e}`);
    }
  }
}

/**
 * Background agent: auto-enrich vendors, optional weekly discovery, queue outreach drafts.
 * @param {{ discovery?: boolean }} opts — set discovery true on Monday cron for new-company search
 */
export async function runResearchAgent(opts = {}) {
  if (researchAgentRunBusy) {
    console.warn('[research-agent] skip — another run is still in progress (cron, live loop, or manual).');
    return;
  }
  researchAgentRunBusy = true;
  const { discovery = false } = opts;
  let runId;
  const summary = {
    vendorFieldUpdates: 0,
    newProspects: 0,
    vendorsAutoRegistered: 0,
    outreachDraftsCreated: 0,
    skippedNoSearchKeys: false,
    discoverySkippedNoSerpApi: false,
    skippedNoAiKeyForDiscovery: false,
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

    if (discovery) {
      if (!sKey) {
        summary.discoverySkippedNoSerpApi = true;
        console.warn(
          '[research-agent] Discovery skipped: SerpAPI key not resolved. Set SERPAPI_API_KEY (or SERPAPI_KEY / SERP_API_KEY) in the environment, or add serpApiKey / SERPAPI_API_KEY to .tep-config.json in the API project root (or path from TEP_CONFIG_PATH).'
        );
      } else if (!aiKey) {
        summary.skippedNoAiKeyForDiscovery = true;
        console.warn(
          '[research-agent] Discovery skipped: Anthropic key not resolved. Set ANTHROPIC_API_KEY in the environment, or add anthropicApiKey / ANTHROPIC_API_KEY to .tep-config.json in the API project root (or path from TEP_CONFIG_PATH).'
        );
      } else {
        await discoverNewProspects(runId, summary, sKey, aiKey);
      }
    }

    await ensureVendorOutreachDrafts(summary);

    await completeBackgroundAgentRun(runId, 'completed', summary, '');
  } catch (e) {
    const msg = e.message || String(e);
    summary.errors.push(msg);
    await completeBackgroundAgentRun(runId, 'failed', summary, msg);
  } finally {
    researchAgentRunBusy = false;
  }
}

/** Cron + callers: discovery defaults to Mondays only; pass `{ discovery: true }` to force prospecting. */
export async function runResearchAndOutreachAgent(opts = {}) {
  const isMonday = new Date().getDay() === 1;
  return runResearchAgent({
    ...opts,
    discovery: opts.discovery !== undefined ? Boolean(opts.discovery) : isMonday,
  });
}

/** Daily 06:00 — enrich + drafts; prospect discovery on Mondays. */
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
    `[live-agent] Running every ${mins} min (enrich + San Diego discovery + auto-registry + drafts). Overlap skipped if a run is still in progress.`
  );
  const tick = () => {
    runResearchAgent({ discovery: true }).catch((err) => console.error('[live-agent]', err));
  };
  liveAgentIntervalHandle = setInterval(tick, ms);
  setTimeout(tick, 15_000);
}
