/** Shared permit row parsing (City of San Diego CSV / OData-shaped objects, Accela-shaped maps). */

export function daysAgoIso(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

export function pick(obj, keys) {
  for (const k of keys) {
    if (obj[k] != null && String(obj[k]).trim() !== '') return String(obj[k]).trim();
  }
  return '';
}

export function pickDate(obj, keys) {
  const raw = pick(obj, keys);
  if (!raw) return '';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

export function normalizeKey(k) {
  return String(k || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function parseCityZipFromAddress(address) {
  const a = String(address || '').trim();
  if (!a) return { city: '', zip: '' };
  const zip = (a.match(/\b(\d{5})(?:-\d{4})?\b/) || [])[1] || '';
  const cityMatch = a.match(/,\s*([A-Za-z .'-]+)\s*,\s*CA\b/i) || a.match(/,\s*([A-Za-z .'-]+)\s+\d{5}\b/);
  const city = cityMatch ? cityMatch[1].trim() : '';
  return { city, zip };
}

export function mapPermitType(raw) {
  const t = String(raw || '').toLowerCase();
  // Water-heater / standalone-plumbing permits are intentionally excluded:
  // those rows are typically already filed by competing plumbing companies.
  if (t.includes('water heater')) return '';
  if (t.includes('plumbing pmt')) return '';
  if (t.includes('combination building') || t.includes('adu') || t.includes('jadu')) return 'ADU';
  if (t.includes('building construction') || t.includes('construction') || t.includes('new') || t === 'building permit') {
    return 'New Construction';
  }
  if (t.includes('combination mech/elec/plum')) return 'Remodel';
  if (t.includes('mechanical pmt')) return 'Remodel';
  if (t.includes('addition')) return 'Addition';
  if (t.includes('remodel') || t.includes('alteration')) return 'Remodel';
  return '';
}

export function isAllowedPermitType(type) {
  return ['ADU', 'New Construction', 'Remodel', 'Addition'].includes(type);
}
