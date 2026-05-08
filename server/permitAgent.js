import cron from 'node-cron';
import {
  listPermitLeads,
  getPermitLeadBySourceAndPermitNumber,
  insertPermitLead,
  insertPermitAgentRun,
  updatePermitLearningSnapshot,
  vendorNameExistsLoose,
} from './db.js';
import { serpGoogleOrganic } from './externalSearch.js';
import {
  generatePermitOutreachEmail,
  generatePermitCallScript,
  scorePermitLead,
} from './ai.js';
import { getSerpApiKey, getPermitLeadMinScore } from './config.js';
import { sendSMS } from './sms.js';
import { CITIES_MONITORED_COUNT } from './permitSourceRegistry.js';
import { collectPermitLeadsForRun } from './permitCityFeeds.js';

let permitRunBusy = false;
const SAN_DIEGO_SOURCE_LABEL = 'San Diego';

const PREMIUM_MARKETS = new Set(['coronado', 'del mar', 'solana beach', 'la jolla', 'poway']);
const PRIORITY_ZIPS = new Set([
  '91910',
  '91911',
  '91913',
  '91914',
  '91915',
  '91932',
  '92008',
  '92009',
  '92010',
  '92011',
  '92014',
  '92024',
  '92037',
  '92075',
  '92106',
  '92107',
  '92108',
  '92109',
  '92118',
]);
const PRIORITY_CITIES = new Set([
  'carlsbad',
  'chula vista',
  'coronado',
  'del mar',
  'encinitas',
  'imperial beach',
  'la jolla',
  'mission beach',
  'mission valley',
  'national city',
  'pacific beach',
  'point loma',
  'solana beach',
]);

async function withTimeout(promise, ms, fallbackValue) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(fallbackValue), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function locationBonus(lead) {
  const city = String(lead.city || '').toLowerCase();
  const zip = String(lead.zip_code || '');
  return PRIORITY_CITIES.has(city) || PRIORITY_ZIPS.has(zip) ? 1 : 0;
}

function premiumMarketBonus(lead) {
  const sc = String(lead.source_city || '').toLowerCase().trim();
  const c = String(lead.city || '').toLowerCase().trim();
  if (PREMIUM_MARKETS.has(sc) || PREMIUM_MARKETS.has(c)) return 2;
  for (const p of PREMIUM_MARKETS) {
    if (c.includes(p) || sc.includes(p)) return 2;
  }
  return 0;
}

function aggregateScannedBySource(leads) {
  const m = new Map();
  for (const L of leads) {
    const k = L.source_city || SAN_DIEGO_SOURCE_LABEL;
    m.set(k, (m.get(k) || 0) + 1);
  }
  return Object.fromEntries(m);
}

function buildSmsDigestLines(addedRows) {
  if (!addedRows.length) return '';
  const groups = new Map();
  for (const r of addedRows) {
    const src = r.source_city || SAN_DIEGO_SOURCE_LABEL;
    const ty = r.permit_type || 'permit';
    const key = `${src}\t${ty}`;
    const cur = groups.get(key) || { n: 0, maxVal: 0 };
    cur.n += 1;
    cur.maxVal = Math.max(cur.maxVal, Number(r.project_value) || 0);
    groups.set(key, cur);
  }
  const lines = [];
  for (const [key, v] of groups) {
    const [src, ty] = key.split('\t');
    const money =
      v.maxVal >= 100000
        ? ` ($${Math.round(v.maxVal / 1000)}k)`
        : v.maxVal >= 25000
          ? ` ($${Math.round(v.maxVal / 1000)}k)`
          : '';
    lines.push(`${v.n} ${src} ${ty}${money}`);
  }
  lines.sort((a, b) => a.localeCompare(b));
  return lines.join('\n');
}

function buildRunSummary({ scannedTotal, scannedBySource, added, addedRows, contacted, skippedLowScore = 0, minScore }) {
  const byType = new Map();
  for (const r of addedRows) {
    const k = `${r.source_city || '?'}\t${r.permit_type || '?'}`;
    byType.set(k, (byType.get(k) || 0) + 1);
  }
  const typeLines = [...byType.entries()]
    .map(([k, n]) => {
      const [src, ty] = k.split('\t');
      return `${n}× ${src} / ${ty}`;
    })
    .join('; ');
  const head = `Scanned ${scannedTotal} permit(s); added ${added}; contacted ${contacted}.`;
  const src = `By source: ${Object.entries(scannedBySource)
    .map(([s, c]) => `${s}:${c}`)
    .join(', ')}.`;
  const skipLine = skippedLowScore
    ? ` Skipped ${skippedLowScore} below score ${minScore}/10.`
    : '';
  const tail = typeLines ? ` New by source/type: ${typeLines}.` : '';
  return `${head}\n${src}${skipLine}${tail}`;
}

async function enrichContactWithSerp(lead, serpKey) {
  if (!serpKey || !lead.contractor_name) return lead;
  const q = `${lead.contractor_name} ${lead.city} contractor phone email CSLB ${lead.contractor_license || ''}`.trim();
  const rows = await serpGoogleOrganic(q, serpKey, 6);
  const blob = rows.map((r) => `${r.title || ''} ${r.snippet || ''}`).join('\n');
  const email = blob.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || '';
  const phone = blob.match(/\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/)?.[0] || '';
  return {
    ...lead,
    contractor_email: lead.contractor_email || email,
    contractor_phone: lead.contractor_phone || phone,
  };
}

export async function runPermitAgent() {
  if (permitRunBusy) return { skipped: true, reason: 'already_running' };
  permitRunBusy = true;
  try {
    const serpKey = getSerpApiKey();
    let activeSerpKey = serpKey;
    if (serpKey) {
      try {
        const probe = await serpGoogleOrganic('San Diego plumbing contractor', serpKey, 1);
        if (!Array.isArray(probe) || probe.length === 0) {
          console.warn('[permit-agent] SerpAPI probe returned no results; skipping enrichment this run.');
          activeSerpKey = '';
        }
      } catch (e) {
        console.warn(`[permit-agent] SerpAPI probe failed; skipping enrichment this run: ${e?.message || e}`);
        activeSerpKey = '';
      }
    }
    const permits = await collectPermitLeadsForRun();
    const scannedBySource = aggregateScannedBySource(permits);
    const minScore = getPermitLeadMinScore();
    let added = 0;
    let contacted = 0;
    let skippedLowScore = 0;
    let topLead = null;
    const addedRows = [];
    for (const p0 of permits) {
      if (await getPermitLeadBySourceAndPermitNumber(p0.permit_number, p0.source_city)) continue;
      const p1 = await enrichContactWithSerp(p0, activeSerpKey);
      const { lead_score } = await withTimeout(scorePermitLead(p1), 3000, { lead_score: 5 });
      const boostedScore = Math.max(
        1,
        Math.min(10, Number(lead_score || 5) + locationBonus(p1) + premiumMarketBonus(p1))
      );
      // Skip low-quality leads — only keep score >= MIN_PERMIT_SCORE (default 7).
      if (boostedScore < minScore) {
        skippedLowScore += 1;
        continue;
      }
      const alreadyVendor = p1.contractor_name ? await vendorNameExistsLoose(p1.contractor_name) : false;
      const notes = [
        p1.notes,
        'Verify license at cslb.ca.gov',
        alreadyVendor ? 'Already in vendor database' : '',
        locationBonus(p1) ? 'Priority zone lead' : '',
        premiumMarketBonus(p1) ? 'Premium market (+2)' : '',
      ]
        .filter(Boolean)
        .join('\n');
      const email_draft = await withTimeout(
        generatePermitOutreachEmail({ ...p1, lead_score: boostedScore }),
        3000,
        `Hi ${p1.contractor_name || 'there'},\n\nI saw your recent ${p1.permit_type} permit activity in ${p1.city || 'San Diego'}. Tri Express Plumbing supports contractors with fast, licensed plumbing crews for permit-driven jobs.\n\nIf you want a reliable plumbing partner for upcoming work, I can share pricing and next-day availability.\n\nBest,\nTri Express Plumbing`
      );
      const row = await insertPermitLead({
        ...p1,
        status: 'new',
        lead_score: boostedScore,
        email_draft,
        notes,
        sms_sent: 0,
      });
      added += 1;
      addedRows.push({
        source_city: row.source_city,
        permit_type: row.permit_type,
        project_value: row.project_value,
        contractor_name: row.contractor_name,
      });
      if (!topLead || row.lead_score > topLead.lead_score) topLead = row;
      if (row.status === 'contacted') contacted += 1;
    }
    const summary = buildRunSummary({
      scannedTotal: permits.length,
      scannedBySource,
      added,
      addedRows,
      contacted,
      skippedLowScore,
      minScore,
    });
    const runRow = await insertPermitAgentRun({
      run_date: new Date().toISOString().slice(0, 10),
      permits_found: permits.length,
      new_leads_added: added,
      leads_contacted: contacted,
      summary,
    });
    await updatePermitLearningSnapshot();
    if (added > 0 && topLead) {
      const digest = buildSmsDigestLines(addedRows);
      const sms = `🔧 Tri Express: ${added} new leads today\n${digest}\nOpen app to review.`;
      await sendSMS(sms, { alertType: 'permit_new_leads', eventKey: 'daily' });
    }
    return {
      ok: true,
      runId: runRow?.id || null,
      permitsFound: permits.length,
      newLeadsAdded: added,
      skippedLowScore,
      minScore,
      summary,
      citiesMonitored: CITIES_MONITORED_COUNT,
      scannedBySource,
      addedBySourceType: addedRows,
    };
  } finally {
    permitRunBusy = false;
  }
}

export async function regeneratePermitLeadEmail(lead) {
  return generatePermitOutreachEmail(lead);
}

export async function generatePermitLeadCallScript(lead) {
  return generatePermitCallScript(lead);
}

export function startPermitAgentScheduler() {
  cron.schedule('0 7 * * *', () => {
    runPermitAgent().catch((e) => console.error('[permit-agent]', e));
  });
}

export function getPermitLeadExportRows() {
  return listPermitLeads({});
}
