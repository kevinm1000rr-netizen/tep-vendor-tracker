export function categoryLabel(c) {
  const m = {
    restoration: 'Restoration',
    property_mgmt: 'Property mgmt',
    hoa: 'HOA',
    contractor: 'ADU / Contractor',
  };
  return m[c] || c;
}

/** Short labels for dashboard / tracker category pills */
export function categoryBadgeShort(c) {
  const m = {
    restoration: 'Restoration',
    property_mgmt: 'Property Mgmt',
    hoa: 'HOA',
    contractor: 'Contractor',
  };
  return m[c] || c || '—';
}

export function daysSince(isoDate) {
  if (!isoDate) return null;
  const a = new Date(isoDate + 'T12:00:00Z');
  const b = new Date();
  return Math.max(0, Math.round((b - a) / 86400000));
}

export function daysUntilFollowup(nextIso, todayStr) {
  if (!nextIso) return null;
  const a = new Date(nextIso + 'T12:00:00Z');
  const b = new Date((todayStr || new Date().toISOString().slice(0, 10)) + 'T12:00:00Z');
  return Math.round((b - a) / 86400000);
}

export const LETTER_VERSION_TAG = 'claude-sonnet-4-6';
