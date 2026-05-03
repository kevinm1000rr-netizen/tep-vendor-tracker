import cron from 'node-cron';
import { getApiKey, getGooglePlacesApiKey, getSerpApiKey } from './config.js';
import {
  listVendors,
  insertBackgroundAgentRun,
  completeBackgroundAgentRun,
  insertPendingNewProspect,
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
import { qualifyProspectFromResearch, extractVendorFieldsFromSnippets, generateVendorLetter } from './ai.js';

const MAX_VENDORS_ENRICH = 16;
const MAX_BLOCKED_EXTRA_SERPS = 24;
const MAX_PROSPECT_AI_CALLS = 12;
const MAX_OUTREACH_DRAFTS_PER_RUN = 4;

const CATEGORY_PRIORITY = { restoration: 0, property_mgmt: 1, hoa: 2, contractor: 3 };

const DISCOVERY_QUERIES = [
  { q: 'San Diego water damage restoration contractors', category: 'restoration', prospect_subtype: '' },
  { q: 'San Diego residential property management companies', category: 'property_mgmt', prospect_subtype: '' },
  { q: 'San Diego HOA management companies', category: 'hoa', prospect_subtype: '' },
  { q: 'San Diego ADU contractor builders', category: 'contractor', prospect_subtype: 'adu' },
  { q: 'San Diego home remodel contractors', category: 'contractor', prospect_subtype: 'remodel' },
];

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

function isNameTaken(name, takenNames) {
  if (vendorNameExistsLoose(name)) return true;
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

function formatLearningHints(v) {
  const row = getAgentLearningForCategory(v.category);
  if (!row) return '';
  const rate = Math.round((Number(row.response_rate) || 0) * 1000) / 10;
  const parts = [
    `Approx. category win rate (responded+approved / touched): ${rate}% (internal estimate).`,
    row.best_subject_line ? `Subject lines that previously worked in this category: ${row.best_subject_line}` : '',
    row.best_day_to_send ? `Best response day hint: ${row.best_day_to_send}` : '',
  ];
  return parts.filter(Boolean).join('\n');
}

function ensureResearchWeek(v) {
  const wk = currentWeekId();
  if ((v.research_week_id || '') !== wk) {
    updateVendor(v.id, { research_week_id: wk, research_miss_streak: 0 });
    return getVendor(v.id);
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
function applyHeuristicContactsFromSnippets(vendorId, snippets, summary) {
  let n = 0;
  for (const s of snippets) {
    const blob = `${s.title || ''} ${s.snippet || ''}`;
    const url = (s.url || '').trim() || 'https://www.google.com/';
    const em = blob.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    if (em && applyVendorFieldIfEmpty(vendorId, 'email', em[0], { source_url: url })) {
      n += 1;
      summary.vendorFieldUpdates += 1;
    }
    const ph = blob.match(/\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
    if (ph && applyVendorFieldIfEmpty(vendorId, 'phone', ph[0], { source_url: url })) {
      n += 1;
      summary.vendorFieldUpdates += 1;
    }
    const cm = blob.match(/\bContact:\s*([A-Za-z][A-Za-z .'-]{1,48})\b/i);
    if (cm && applyVendorFieldIfEmpty(vendorId, 'contact_person', cm[1].trim(), { source_url: url })) {
      n += 1;
      summary.vendorFieldUpdates += 1;
    }
  }
  return n;
}

async function maybeAutoDraftOutreach(vendorId, summary, aiKey) {
  if (!aiKey) return;
  const v = getVendor(vendorId);
  if (!v || v.status !== 'not_sent' || !(v.email || '').trim()) return;
  if (vendorHasPendingOutreachDraft(vendorId)) return;
  try {
    const learning = formatLearningHints(v);
    const text = await generateVendorLetter(v, learning);
    const t = String(text || '').trim();
    if (!t) return;
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
    upsertVendorOutreachDraft(v.id, subject, body, { draft_type: 'outreach' });
    logAgentActivity({
      activity_type: 'draft_created',
      vendor_id: v.id,
      summary: 'Outreach email draft generated (auto)',
      detail: {},
    });
    summary.outreachDraftsCreated = (summary.outreachDraftsCreated || 0) + 1;
  } catch (e) {
    const v0 = getVendor(vendorId);
    summary.errors.push(`Auto-draft ${v0?.name || vendorId}: ${e.message || e}`);
  }
}

async function enrichOneVendor(runId, summary, v0, gKey, sKey, aiKey) {
  let v = ensureResearchWeek(getVendor(v0.id) || v0);
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
        v = getVendor(v.id) || v;
        const miss = vendorMissingFields(v);
        for (const row of mapPlaceToApplyRows(det, miss, mapUrl)) {
          if (applyVendorFieldIfEmpty(v.id, row.field_name, row.proposed_value, { source_url: row.source_url })) {
            applied += 1;
            summary.vendorFieldUpdates += 1;
          }
        }
      }
    }
  }

  v = getVendor(v.id) || v;
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
      v = getVendor(v.id) || v;
      const miss3 = vendorMissingFields(v);
      for (const s of list) {
        const fn = s.field;
        if (!fn || !allowed.has(fn) || !miss3.includes(fn)) continue;
        const val = (s.value || '').trim();
        const url = (s.sourceUrl || '').trim();
        if (!val || !url) continue;
        if (applyVendorFieldIfEmpty(v.id, fn, val, { source_url: url })) {
          applied += 1;
          summary.vendorFieldUpdates += 1;
        }
      }
    }
    if (snippets.length) {
      const extra = applyHeuristicContactsFromSnippets(v.id, snippets, summary);
      applied += extra;
    }
  }

  v = getVendor(v.id) || v;
  const prevStatus = v.agent_enrichment_status || '';
  const newStreak = applied > 0 ? 0 : Math.min((v.research_miss_streak || 0) + 1, 99);
  let agentStatus = 'searching';
  if (newStreak >= 3) agentStatus = 'manual_lookup';
  else if (applied > 0) agentStatus = 'found_saved';
  else if (prevStatus === 'found_saved') agentStatus = 'found_saved';

  updateVendor(v.id, {
    research_miss_streak: newStreak,
    agent_enrichment_status: agentStatus,
  });

  if (applied > 0) {
    logAgentActivity({
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
  let v = ensureResearchWeek(getVendor(vendorId));
  if (!v || v.status !== 'not_sent' || !vendorBlockedOnContact(v)) return;

  const prevStatus = v.agent_enrichment_status || '';
  updateVendor(v.id, { agent_enrichment_status: 'searching' });

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
    v = getVendor(v.id) || v;
    const miss3 = vendorMissingFields(v);
    for (const s of list) {
      const fn = s.field;
      if (!fn || !allowed.has(fn) || !miss3.includes(fn)) continue;
      const val = (s.value || '').trim();
      const url = (s.sourceUrl || '').trim();
      if (!val || !url) continue;
      if (applyVendorFieldIfEmpty(v.id, fn, val, { source_url: url })) {
        applied += 1;
        summary.vendorFieldUpdates += 1;
      }
    }
  }
  if (snippets.length) {
    applied += applyHeuristicContactsFromSnippets(v.id, snippets, summary);
  }

  v = getVendor(v.id) || v;
  const newStreak = applied > 0 ? 0 : Math.min((v.research_miss_streak || 0) + 1, 99);
  let agentStatus = 'searching';
  if (newStreak >= 3) agentStatus = 'manual_lookup';
  else if (applied > 0) agentStatus = 'found_saved';
  else if (prevStatus === 'found_saved') agentStatus = 'found_saved';

  updateVendor(v.id, {
    research_miss_streak: newStreak,
    agent_enrichment_status: agentStatus,
  });

  if (applied > 0) {
    logAgentActivity({
      activity_type: 'enrich',
      vendor_id: v.id,
      summary: `Auto-filled ${applied} field(s) (contact search)`,
      detail: { runId },
    });
  }
  await maybeAutoDraftOutreach(v.id, summary, aiKey);
}

async function enrichVendors(runId, summary, gKey, sKey, aiKey) {
  const vendors = listVendors();
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
    for (const id of listBlockedVendorIdsForAgent()) {
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
  const pendingList = listPendingNewProspects({ status: 'pending' });
  const takenNames = new Set(pendingList.map((p) => normalizeNameDedupe(p.name)));
  let aiCalls = 0;

  for (const spec of DISCOVERY_QUERIES) {
    if (aiCalls >= MAX_PROSPECT_AI_CALLS) break;
    let locals;
    try {
      locals = await ext.serpGoogleMapsLocal(spec.q, sKey);
    } catch (e) {
      summary.errors.push(`Maps search "${spec.q}": ${e.message || e}`);
      continue;
    }
    for (const loc of locals.slice(0, 6)) {
      if (aiCalls >= MAX_PROSPECT_AI_CALLS) break;
      const name = (loc.title || '').trim();
      if (!name) continue;
      const placeId = String(loc.place_id || '').trim();
      const dedupeKey = placeId ? `gplace:${placeId}` : `name:${normalizeNameDedupe(name)}`;
      if (pendingProspectDedupeExists(dedupeKey)) continue;
      if (isNameTaken(name, takenNames)) continue;

      const evidenceUrls = [];
      if (loc.website) evidenceUrls.push({ url: loc.website, title: `${name} — listing website` });
      let extraOrg = [];
      try {
        extraOrg = await ext.serpGoogleOrganic(`${name} San Diego business founded years`, sKey, 3);
      } catch {
        /* optional */
      }
      for (const o of extraOrg) {
        evidenceUrls.push({ url: o.link, title: o.title });
      }

      const payload = {
        companyName: name,
        category: spec.category,
        prospect_subtype: spec.prospect_subtype || null,
        mapsListing: {
          address: loc.address,
          phone: loc.phone,
          website: loc.website,
          reviews: loc.reviews,
          type: loc.type,
        },
        evidenceUrls,
      };

      let out;
      try {
        out = await qualifyProspectFromResearch(payload);
        aiCalls += 1;
      } catch (e) {
        summary.errors.push(`Qualify ${name}: ${e.message || e}`);
        continue;
      }
      if (!out || !out.qualifies) continue;

      takenNames.add(normalizeNameDedupe(name));
      const mergedEvidence = Array.isArray(out.evidenceUrls) && out.evidenceUrls.length ? out.evidenceUrls : evidenceUrls;

      try {
        insertPendingNewProspect({
          run_id: runId,
          name,
          category: spec.category,
          prospect_subtype: spec.prospect_subtype || '',
          website: out.website || loc.website || '',
          phone: out.phone || loc.phone || '',
          email: out.email || '',
          address: out.address || loc.address || '',
          contact_person: out.contactPerson || '',
          years_in_business: out.yearsInBusiness || '',
          online_notes: out.onlineNotes || '',
          evidence_urls: mergedEvidence,
          tenure_evidence_summary: out.evidenceSummary || '',
          outreach_email_draft: out.outreachEmailDraft || '',
          google_place_id: placeId,
          dedupe_key: dedupeKey,
        });
        summary.newProspects += 1;
      } catch (e) {
        if (String(e.message).includes('UNIQUE')) continue;
        summary.errors.push(`Insert prospect ${name}: ${e.message || e}`);
      }
    }
  }
}

async function ensureVendorOutreachDrafts(summary) {
  const aiKey = getApiKey();
  if (!aiKey) return;
  const vendors = listVendors().filter(
    (v) => v.status === 'not_sent' && (v.email || '').trim() && !vendorHasPendingOutreachDraft(v.id)
  );
  vendors.sort((a, b) => {
    const ca = CATEGORY_PRIORITY[a.category] ?? 9;
    const cb = CATEGORY_PRIORITY[b.category] ?? 9;
    if (ca !== cb) return ca - cb;
    return String(a.name).localeCompare(String(b.name));
  });
  let n = 0;
  for (const v0 of vendors) {
    if (n >= MAX_OUTREACH_DRAFTS_PER_RUN) break;
    const v = getVendor(v0.id);
    if (!v || !(v.email || '').trim()) continue;
    try {
      const learning = formatLearningHints(v);
      const text = await generateVendorLetter(v, learning);
      const t = String(text || '').trim();
      if (!t) continue;
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
      upsertVendorOutreachDraft(v.id, subject, body, { draft_type: 'outreach' });
      logAgentActivity({
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
  const { discovery = false } = opts;
  const runId = insertBackgroundAgentRun();
  const summary = {
    vendorFieldUpdates: 0,
    newProspects: 0,
    outreachDraftsCreated: 0,
    skippedNoSearchKeys: false,
    discoverySkippedNoSerpApi: false,
    skippedNoAiKeyForDiscovery: false,
    errors: [],
  };
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
      } else if (!aiKey) {
        summary.skippedNoAiKeyForDiscovery = true;
      } else {
        await discoverNewProspects(runId, summary, sKey, aiKey);
      }
    }

    await ensureVendorOutreachDrafts(summary);

    completeBackgroundAgentRun(runId, 'completed', summary, '');
  } catch (e) {
    const msg = e.message || String(e);
    summary.errors.push(msg);
    completeBackgroundAgentRun(runId, 'failed', summary, msg);
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
