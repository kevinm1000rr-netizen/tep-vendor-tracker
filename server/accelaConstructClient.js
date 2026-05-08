/**
 * Accela Construct API (v4) — used when ACCELA_CLIENT_ID + ACCELA_CLIENT_SECRET are set.
 * Agency is passed per request (e.g. CHULAVISTA, PRCITY). See developer.accela.com.
 */
import axios from 'axios';
import {
  getAccelaClientId,
  getAccelaClientSecret,
  getAccelaEnvironment,
} from './config.js';
import { mapPermitType, isAllowedPermitType } from './permitShared.js';

const API_BASE = 'https://apis.accela.com';

function openedRange(days) {
  const to = new Date();
  const from = new Date(Date.now() - days * 86400000);
  const fmt = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} 00:00:00`;
  return { openedDateFrom: fmt(from), openedDateTo: fmt(to) };
}

export async function getAccelaAccessTokenIfConfigured() {
  const clientId = getAccelaClientId();
  const clientSecret = getAccelaClientSecret();
  if (!clientId || !clientSecret) return null;
  const env = getAccelaEnvironment();
  const scope = (process.env.ACCELA_SCOPE || '').trim();
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    environment: env,
  });
  if (scope) body.set('scope', scope);
  const urls = ['https://apis.accela.com/oauth2/token', 'https://api.accela.com/oauth2/token'];
  for (const url of urls) {
    try {
      const r = await axios.post(url, body.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 25000,
        validateStatus: (s) => s < 500,
      });
      const tok = r.data?.access_token;
      if (tok && r.status < 400) return String(tok);
    } catch (e) {
      console.warn(`[accela] token ${url} failed: ${e?.message || e}`);
    }
  }
  return null;
}

function authHeaders(accessToken, agency) {
  const env = getAccelaEnvironment();
  const bearer = accessToken.startsWith('Bearer ') ? accessToken : `Bearer ${accessToken}`;
  return {
    Authorization: bearer,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'x-accela-agency': agency,
    'x-accela-environment': env,
  };
}

export async function searchAccelaBuildingRecords({ accessToken, agency, days = 30, limit = 30 }) {
  const { openedDateFrom, openedDateTo } = openedRange(days);
  const qs = new URLSearchParams({
    limit: String(Math.min(100, Math.max(1, limit))),
    offset: '0',
    expand: 'addresses,professionals',
  });
  const url = `${API_BASE}/v4/search/records?${qs.toString()}`;
  const payload = {
    module: 'Building',
    openedDateFrom,
    openedDateTo,
  };
  try {
    const r = await axios.post(url, payload, {
      headers: authHeaders(accessToken, agency),
      timeout: 35000,
      validateStatus: () => true,
    });
    if (r.status >= 400) {
      console.warn(`[accela] search ${agency} HTTP ${r.status}`, String(r.data || '').slice(0, 200));
      return [];
    }
    const list = Array.isArray(r.data?.result) ? r.data.result : [];
    return list;
  } catch (e) {
    console.warn(`[accela] search ${agency} error: ${e?.message || e}`);
    return [];
  }
}

function addrLine(a) {
  if (!a || typeof a !== 'object') return '';
  const parts = [
    a.addressLine1,
    a.streetAddress,
    a.city && a.state ? `${a.city}, ${typeof a.state === 'object' ? a.state.value || a.state.text : a.state}` : a.city,
    a.postalCode || a.zip,
  ].filter(Boolean);
  return parts.join(', ');
}

function accelaOpenedDateIso(v) {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

export function accelaRecordToLead(rec, sourceCityLabel, agencyCode = '') {
  const typeRaw =
    rec?.type?.text ||
    rec?.type?.value ||
    rec?.name ||
    rec?.description ||
    rec?.capTypeAlias ||
    '';
  const permit_type = mapPermitType(typeRaw);
  if (!isAllowedPermitType(permit_type)) return null;
  const permit_number = String(rec?.customId || rec?.id || '').trim();
  if (!permit_number) return null;
  const addrObj = Array.isArray(rec?.addresses) && rec.addresses[0] ? rec.addresses[0] : null;
  const address = addrLine(addrObj) || '';
  const city = String(addrObj?.city || '').trim();
  const zip_code = String(addrObj?.postalCode || addrObj?.zip || '').trim();
  const opened = rec?.openedDate || rec?.fileDate;
  const date_submitted = accelaOpenedDateIso(opened) || new Date().toISOString().slice(0, 10);
  const prof = Array.isArray(rec?.professionals) && rec.professionals[0] ? rec.professionals[0] : null;
  const contractor_name = (() => {
    if (!prof) return '';
    const biz = String(prof.businessName || prof.fullName || '').trim();
    if (biz) return biz;
    const fn = String(prof.firstName || '').trim();
    const ln = String(prof.lastName || '').trim();
    return [fn, ln].filter(Boolean).join(' ').trim();
  })();
  const contractor_license = String(prof?.licenseNumber || prof?.businessLicense || '').trim();
  const project_value = Number(rec?.jobValue || rec?.estimatedValue || 0) || 0;
  return {
    permit_number,
    source_city: sourceCityLabel,
    permit_type,
    address: address || pick({ a: addrObj?.streetAddress }, ['a']) || '',
    city: city || sourceCityLabel,
    zip_code,
    contractor_name,
    contractor_license,
    contractor_phone: '',
    contractor_email: '',
    architect_name: '',
    project_value,
    date_submitted: date_submitted || new Date().toISOString().slice(0, 10),
    notes: `Jurisdiction: ${sourceCityLabel}. Source: Accela Construct API${agencyCode ? ` (agency ${agencyCode})` : ''}. Citizen portal URL is listed in /api/permits/sources.`,
  };
}
