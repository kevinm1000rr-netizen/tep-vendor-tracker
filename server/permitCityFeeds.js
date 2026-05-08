/**
 * Multi-jurisdiction permit collection: City of San Diego CSV/OData first,
 * then Accela Construct agencies when OAuth is configured, then future scrapers.
 */
import axios from 'axios';
import { parseCsvRows } from './csvImport.js';
import {
  daysAgoIso,
  pick,
  pickDate,
  normalizeKey,
  parseCityZipFromAddress,
  mapPermitType,
  isAllowedPermitType,
} from './permitShared.js';
import {
  ACCELA_AGENCIES_PRIORITY,
  PERMIT_JURISDICTIONS,
  ACCELA_STANDARDIZATION_NOTE,
} from './permitSourceRegistry.js';
import {
  getAccelaAccessTokenIfConfigured,
  searchAccelaBuildingRecords,
  accelaRecordToLead,
} from './accelaConstructClient.js';
import { scrapeNonAccelaPermitFeeds } from './permitPortalScrapers.js';

const SD_PERMITS_URL = 'https://data.sandiego.gov/api/odata/development_permits_set2';
const SD_PERMITS_ACTIVE_CSV_URL =
  'https://seshat.datasd.org/development_permits_set2/permits_set2_active_datasd.csv';
const SAN_DIEGO_SOURCE_LABEL = 'San Diego';

/** San Diego open data stays the widest funnel while other cities are wired up. */
export const MAX_SAN_DIEGO_CANDIDATES_PER_RUN = 150;
const MAX_ACCELA_RECORDS_PER_AGENCY = 40;
const ACCELA_LOOKBACK_DAYS = 30;
const SD_LOOKBACK_DAYS = 30;

function isAllowedType(type) {
  return isAllowedPermitType(type);
}

export async function fetchSanDiegoPermitCandidates(maxRows = MAX_SAN_DIEGO_CANDIDATES_PER_RUN) {
  let rows = [];
  try {
    const u = new URL(SD_PERMITS_URL);
    u.searchParams.set('$top', '800');
    u.searchParams.set('$orderby', 'receiveddate desc');
    const r = await axios.get(u.toString(), { timeout: 20000 });
    rows = Array.isArray(r?.data?.value) ? r.data.value : [];
    console.log(`[permit-feeds] San Diego OData ok, rows=${rows.length}`);
  } catch (e) {
    console.warn(`[permit-feeds] San Diego OData failed, CSV fallback: ${e?.message || e}`);
    const csvRes = await axios.get(SD_PERMITS_ACTIVE_CSV_URL, {
      responseType: 'text',
      timeout: 120000,
    });
    const matrix = parseCsvRows(String(csvRes?.data || ''));
    if (!matrix.length) return [];
    const headers = matrix[0].map((h) => String(h || '').trim().toLowerCase());
    const idx = (names) => {
      for (const n of names) {
        const i = headers.findIndex((h) => h === n || h.includes(n));
        if (i >= 0) return i;
      }
      return -1;
    };
    const cPermitType = idx([
      'permit type',
      'permit_type',
      'record type',
      'work description',
      'approval_type',
      'approval scope',
      'project scope',
    ]);
    const cDate = idx([
      'submitted',
      'received',
      'application date',
      'filed',
      'approval issued date',
      'approval created date',
      'created date',
    ]);
    const cPermitNo = idx(['permit number', 'permit #', 'record id', 'permitid', 'approval_id', 'job_id']);
    const cAddress = idx(['address', 'site address', 'project address', 'job address', 'street']);
    const cCity = idx(['city']);
    const cZip = idx(['zip']);
    const cContractor = idx(['contractor']);
    const cLic = idx(['license', 'cslb']);
    const cArchitect = idx(['architect']);
    const cValue = idx(['valuation', 'project value', 'value']);
    rows = matrix.slice(1).map((r) => {
      const obj = {};
      for (let i = 0; i < headers.length; i += 1) {
        obj[normalizeKey(headers[i])] = String(r[i] ?? '').trim();
      }
      if (cPermitType >= 0) obj.approval_type = String(r[cPermitType] ?? '').trim();
      if (cDate >= 0) obj.date_approval_create = String(r[cDate] ?? '').trim();
      if (cPermitNo >= 0) obj.approval_id = String(r[cPermitNo] ?? '').trim();
      if (cAddress >= 0) obj.address_job = String(r[cAddress] ?? '').trim();
      if (cCity >= 0) obj.city = String(r[cCity] ?? '').trim();
      if (cZip >= 0) obj.zip = String(r[cZip] ?? '').trim();
      if (cContractor >= 0) obj.approval_permit_holder = String(r[cContractor] ?? '').trim();
      if (cLic >= 0) obj.contractorlicense = String(r[cLic] ?? '').trim();
      if (cArchitect >= 0) obj.architectname = String(r[cArchitect] ?? '').trim();
      if (cValue >= 0) obj.approval_valuation = String(r[cValue] ?? '').trim();
      return obj;
    });
    console.log(`[permit-feeds] San Diego active CSV ok, rows=${rows.length}`);
  }
  const minDate = daysAgoIso(SD_LOOKBACK_DAYS);
  const out = [];
  const seen = new Set();
  for (const p of rows) {
    const permitTypeRaw = pick(p, [
      'permittypename',
      'permit_type_name',
      'permittype',
      'permit_type',
      'workdescription',
      'approval_type',
      'approval_scope',
      'project_scope',
    ]);
    const permit_type = mapPermitType(permitTypeRaw);
    if (!isAllowedType(permit_type)) continue;
    const date_submitted = pickDate(p, [
      'receiveddate',
      'submitteddate',
      'applicationdate',
      'fileddate',
      'approval_issued_date',
      'approval_created_date',
      'date_approval_create',
      'date_approval_issue',
      'date_project_create',
    ]);
    if (!date_submitted || date_submitted < minDate) continue;
    const permit_number = pick(p, [
      'permitnumber',
      'permit_number',
      'recordid',
      'permitid',
      'approval_id',
      'job_id',
    ]);
    if (!permit_number) continue;
    const dedupeKey = `${SAN_DIEGO_SOURCE_LABEL}|${permit_number}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const lead = {
      permit_number,
      source_city: SAN_DIEGO_SOURCE_LABEL,
      permit_type,
      address: pick(p, ['jobaddress', 'address', 'siteaddress', 'projectaddress', 'street', 'address_job']),
      city: pick(p, ['city', 'jobcity']),
      zip_code: pick(p, ['zip', 'zipcode', 'jobzip']),
      contractor_name: pick(p, [
        'contractorname',
        'contractor_name',
        'primarycontractor',
        'approval_permit_holder',
      ]),
      contractor_license: pick(p, ['contractorlicense', 'contractor_license', 'cslb', 'license']),
      architect_name: pick(p, ['architectname', 'architect_name']),
      project_value: Number(
        pick(p, ['valuation', 'projectvalue', 'project_value', 'approval_valuation']) || 0
      ),
      date_submitted,
      notes: `Jurisdiction: City of San Diego. Source: Open Data / active CSV (${SD_PERMITS_ACTIVE_CSV_URL})`,
    };
    const parsed = parseCityZipFromAddress(lead.address);
    if (!lead.city) lead.city = parsed.city || 'San Diego';
    if (!lead.zip_code) lead.zip_code = parsed.zip;
    out.push(lead);
  }
  out.sort((a, b) => String(b.date_submitted || '').localeCompare(String(a.date_submitted || '')));
  return out.slice(0, Math.max(1, maxRows));
}

async function fetchAccelaPermitCandidates(accessToken) {
  const leads = [];
  for (const { sourceCityLabel, agencyCode } of ACCELA_AGENCIES_PRIORITY) {
    const recs = await searchAccelaBuildingRecords({
      accessToken,
      agency: agencyCode,
      days: ACCELA_LOOKBACK_DAYS,
      limit: MAX_ACCELA_RECORDS_PER_AGENCY,
    });
    let n = 0;
    for (const rec of recs) {
      const lead = accelaRecordToLead(rec, sourceCityLabel, agencyCode);
      if (lead) {
        leads.push(lead);
        n += 1;
      }
    }
    console.log(`[permit-feeds] Accela ${agencyCode} (${sourceCityLabel}): ${recs.length} raw → ${n} typed leads`);
  }
  return leads;
}

function logJurisdictionCoveragePlan() {
  console.log(`[permit-feeds] Registry: ${PERMIT_JURISDICTIONS.length} jurisdictions (GET /api/permits/sources).`);
  for (const j of PERMIT_JURISDICTIONS) {
    if (j.id === 'san_diego') continue;
    const portal = j.publicPermitSearchUrl || j.accelaCitizenAccess || j.portalUrl || '';
    const mode = j.automationMode || j.dataMethod;
    console.log(`[permit-feeds]   · ${j.sourceCityLabel}: ${mode}${portal ? ` — ${portal}` : ''}`);
  }
  console.log(`[permit-feeds] Platform note: ${ACCELA_STANDARDIZATION_NOTE}`);
}

/**
 * @returns {Promise<Array<Record<string, unknown>>>} Merged permit lead candidates for one agent run.
 */
export async function collectPermitLeadsForRun() {
  logJurisdictionCoveragePlan();
  const sd = await fetchSanDiegoPermitCandidates(MAX_SAN_DIEGO_CANDIDATES_PER_RUN);
  const token = await getAccelaAccessTokenIfConfigured();
  let accelaLeads = [];
  if (!token) {
    console.warn(
      '[permit-feeds] Accela OAuth not configured (set ACCELA_CLIENT_ID + ACCELA_CLIENT_SECRET); skipping Chula Vista / National City Construct pulls.'
    );
  } else {
    accelaLeads = await fetchAccelaPermitCandidates(token);
  }
  const scraped = await scrapeNonAccelaPermitFeeds();
  const merged = [...sd, ...accelaLeads, ...scraped];
  console.log(
    `[permit-feeds] Run pool: San Diego=${sd.length}, Accela=${accelaLeads.length}, scrape stubs=${scraped.length} (total ${merged.length})`
  );
  return merged;
}
