/**
 * CSV parsing and column mapping for vendor bulk import (Tracker).
 */

/** @param {string} text */
export function parseCsvRows(text) {
  const raw = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!raw.trim()) return [];
  const rows = [];
  let row = [];
  let field = '';
  let i = 0;
  let inQuotes = false;
  while (i < raw.length) {
    const c = raw[i];
    if (inQuotes) {
      if (c === '"') {
        if (raw[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (c === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
      continue;
    }
    field += c;
    i += 1;
  }
  row.push(field);
  rows.push(row);
  while (rows.length && rows[rows.length - 1].every((c) => String(c).trim() === '')) {
    rows.pop();
  }
  return rows;
}

function normHeader(h) {
  return String(h || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * Map CSV header cell → canonical field key.
 * @param {string} header
 */
export function mapHeaderToField(header) {
  const h = normHeader(header);
  if (!h) return null;
  if (h === 'company' || h === 'name' || h === 'company name' || h === 'company/name') return 'name';
  if (h === 'phone' || h === 'telephone' || h === 'mobile') return 'phone';
  if (h === 'website' || h === 'url' || h === 'web') return 'website';
  if (
    h === 'service area' ||
    h === 'area' ||
    h === 'service area/area' ||
    h === 'location' ||
    h === 'city'
  ) {
    return 'address';
  }
  if (h === 'notes' || h === 'note') return 'notes';
  if (
    h === 'specialty or portfolio' ||
    h === 'specialty' ||
    h === 'portfolio' ||
    h === 'specialty/portfolio' ||
    h.includes('specialty') ||
    (h.includes('portfolio') && !h.includes('phone'))
  ) {
    return 'specialty_portfolio';
  }
  return null;
}

/**
 * Infer CRM category from free-text specialty / portfolio.
 * @param {string} text
 */
export function inferCategoryFromSpecialty(text) {
  const t = String(text || '').toLowerCase();
  if (!t.trim()) return 'contractor';
  if (
    /\b(servpro|servicemaster|paul davis|restoration|water damage|mitigation|flood|mold)\b/.test(t)
  ) {
    return 'restoration';
  }
  if (/\b(hoa|homeowners|community association|condo association|townhome association)\b/.test(t)) {
    return 'hoa';
  }
  if (
    /\b(property management|apartment|multifamily|residential portfolio|units|pm\b|landlord)\b/.test(t)
  ) {
    return 'property_mgmt';
  }
  return 'contractor';
}

/**
 * Build combined notes: user notes + specialty/portfolio (“category notes”) + import tag.
 * Service area is stored only in the `address` field on the vendor row.
 */
export function buildImportNotes({ notes, specialtyPortfolio }) {
  const parts = [];
  const n = String(notes || '').trim();
  if (n) parts.push(n);
  const sp = String(specialtyPortfolio || '').trim();
  if (sp) parts.push(`Specialty / portfolio: ${sp}`);
  parts.push('Source: manual_import (CSV)');
  return parts.join('\n\n');
}

/**
 * @param {string[][]} rows - first row headers
 * @returns {{ headers: string[], fieldByCol: (string|null)[], dataRows: string[][], errors: string[] }}
 */
export function analyzeCsvTable(rows) {
  const errors = [];
  if (!rows.length) {
    errors.push('CSV is empty.');
    return { headers: [], fieldByCol: [], dataRows: [], errors };
  }
  const headers = rows[0].map((c) => String(c).trim());
  const fieldByCol = headers.map((h) => mapHeaderToField(h));
  const nameCols = fieldByCol.filter((f) => f === 'name').length;
  if (nameCols === 0) {
    errors.push('Missing a name column. Use a header such as "Company" or "Name".');
  }
  if (nameCols > 1) {
    errors.push('Multiple columns map to company name; keep only one.');
  }
  const dataRows = rows.slice(1).filter((r) => r.some((c) => String(c).trim() !== ''));
  return { headers, fieldByCol, dataRows, errors };
}

/**
 * @param {string[]} cells
 * @param {(string|null)[]} fieldByCol
 */
export function rowToImportRecord(cells, fieldByCol) {
  /** @type {Record<string, string>} */
  const acc = { name: '', phone: '', website: '', address: '', notes: '', specialty_portfolio: '' };
  for (let c = 0; c < fieldByCol.length; c += 1) {
    const f = fieldByCol[c];
    if (!f) continue;
    const val = String(cells[c] ?? '').trim();
    if (f === 'specialty_portfolio') acc.specialty_portfolio = acc.specialty_portfolio ? `${acc.specialty_portfolio}; ${val}` : val;
    else acc[f] = val;
  }
  const category = inferCategoryFromSpecialty(acc.specialty_portfolio);
  const notes = buildImportNotes({
    notes: acc.notes,
    specialtyPortfolio: acc.specialty_portfolio,
  });
  return {
    name: acc.name.trim(),
    phone: acc.phone.trim(),
    website: acc.website.trim(),
    address: acc.address.trim(),
    category,
    notes,
    specialty_portfolio: acc.specialty_portfolio.trim(),
  };
}
