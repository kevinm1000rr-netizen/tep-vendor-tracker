import pg from 'pg';
import { SEED_VENDORS } from './seed.js';
import { PG_SCHEMA_DDL } from './pgSchema.js';
import { migrateSqliteToPostgres } from './migrateSqliteToPostgres.js';
import { ensureAgentEmailDraftHasContact } from './ai.js';

const { Pool } = pg;

let pool;

function pq(sql, params = []) {
  let i = 0;
  const text = String(sql).replace(/\?/g, () => `$${++i}`);
  return [text, params];
}

async function q(sql, params) {
  const [text, p] = pq(sql, params);
  return pool.query(text, p);
}

async function qGet(sql, params = []) {
  const { rows } = await q(sql, params);
  return rows[0] ?? null;
}

async function qAll(sql, params = []) {
  const { rows } = await q(sql, params);
  return rows;
}

function sslOpt() {
  if (process.env.PGSSLMODE === 'disable') return false;
  if (process.env.DATABASE_URL?.includes('localhost')) return false;
  return { rejectUnauthorized: false };
}

export async function initDatabase() {
  const conn = process.env.DATABASE_URL?.trim();
  if (!conn) throw new Error('DATABASE_URL is required for PostgreSQL mode');
  pool = new Pool({ connectionString: conn, ssl: sslOpt(), max: 20 });
  await pool.query(PG_SCHEMA_DDL);
  await pool
    .query(`ALTER TABLE vendors ADD COLUMN IF NOT EXISTS responded_at TEXT`)
    .catch(() => {});
  await pool
    .query(`ALTER TABLE vendors ADD COLUMN IF NOT EXISTS approved_at TEXT`)
    .catch(() => {});
  await pool.query(`ALTER TABLE vendors ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT ''`).catch(() => {});
  await pool.query(`ALTER TABLE vendors DROP CONSTRAINT IF EXISTS vendors_status_check`).catch(() => {});
  await pool
    .query(
      `ALTER TABLE vendors ADD CONSTRAINT vendors_status_check CHECK (status IN ('new','not_sent','sent','responded','approved'))`
    )
    .catch(() => {});
  await migrateSqliteToPostgres(pool);
  for (const cat of ['restoration', 'property_mgmt', 'hoa', 'contractor']) {
    await q(`INSERT INTO agent_learning (category) VALUES ($1) ON CONFLICT (category) DO NOTHING`, [cat]);
  }
  const SEED_AT = '2020-06-01 08:00:00';
  const { rows: vc } = await q('SELECT COUNT(*)::int AS n FROM vendors');
  if ((vc[0]?.n || 0) === 0) {
    const ins = `
      INSERT INTO vendors (
        name, contact_person, email, phone, category, status,
        date_sent, next_followup_date, notes, letter_version_used,
        website, years_in_business, address, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, 'not_sent',
        NULL, NULL, $6, '',
        COALESCE($7, ''), COALESCE($8, ''), COALESCE($9, ''),
        $10, $10
      )
    `;
    for (const row of SEED_VENDORS) {
      await q(ins, [
        row.name,
        row.contact_person || '',
        row.email || '',
        row.phone || '',
        row.category,
        row.notes || '',
        row.website || '',
        row.years_in_business || '',
        row.address || '',
        SEED_AT,
      ]);
    }
    console.log('[db] Seeded', SEED_VENDORS.length, 'vendors (PostgreSQL).');
  }
  await runPgInflatedMonthFixOnce();
}

async function runPgInflatedMonthFixOnce() {
  const k = 'inflated_new_month_fix';
  const ex = await qGet('SELECT 1 FROM app_meta WHERE key = $1', [k]);
  if (ex) return;
  try {
    const row = await qGet(
      `SELECT COUNT(*)::int AS total,
        SUM(CASE WHEN substring(created_at, 1, 7) = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM') THEN 1 ELSE 0 END)::int AS this_month
       FROM vendors`
    );
    const total = row?.total || 0;
    const thisMonth = row?.this_month || 0;
    if (total >= 10 && thisMonth === total) {
      await q(`UPDATE vendors SET created_at = $1, updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE true`, [
        '2020-06-01 08:00:00',
      ]);
    }
  } catch {
    /* ignore */
  }
  await q(`INSERT INTO app_meta (key, value) VALUES ($1, '1') ON CONFLICT (key) DO NOTHING`, [k]);
}

export async function closePool() {
  if (pool) await pool.end();
}

export function normalizeNameDedupe(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\b(inc|llc|l\.l\.c\.|corp|corporation|company|co\.)\b\.?/gi, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .slice(0, 120);
}

function addDaysIso(isoDateStr, days) {
  const d = new Date(isoDateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function safeJson(s, fallback) {
  try {
    return JSON.parse(s || '{}');
  } catch {
    return fallback;
  }
}

function splitEmailSubjectBody(text) {
  const t = String(text || '').trim();
  const m = t.match(/^Subject:\s*(.+?)(?:\r?\n|$)/im);
  if (m) {
    return { subject: m[1].trim(), body: t.slice(m.index + m[0].length).trim() };
  }
  const nl = t.indexOf('\n');
  if (nl > 0 && nl < 100) {
    const first = t.slice(0, nl).trim();
    const rest = t.slice(nl + 1).trim();
    if (/^(re:|fw:)?\s*.+/i.test(first) && rest.length > 20) {
      return { subject: first.replace(/^subject:\s*/i, '').trim(), body: rest };
    }
  }
  return { subject: '', body: t };
}

function urlsFromReasonText(reason) {
  const s = String(reason || '');
  const out = [];
  const re = /https?:\/\/[^\s)\]'"<>]+/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    out.push({ url: m[0], title: m[0] });
  }
  return out;
}

function mapSuggestedCompanyRow(s, draft) {
  const outreach =
    (s.tailored_email || '').trim() || [draft?.subject, draft?.body].filter(Boolean).join('\n\n').trim();
  const reason = String(s.reason_qualified || '');
  const tenureBlock = reason.split('\n\n')[0] || '';
  return {
    ...s,
    tenure_evidence_summary: tenureBlock || s.online_notes || '',
    outreach_email_draft: outreach,
    evidence_urls: urlsFromReasonText(s.reason_qualified),
  };
}

async function refreshAgentLearningForCategory(category) {
  if (!category) return;
  const sent = (
    await qGet(
      `SELECT COUNT(*)::int AS n FROM vendors WHERE category = $1 AND status IN ('sent','responded','approved')`,
      [category]
    )
  )?.n;
  const responded = (
    await qGet(`SELECT COUNT(*)::int AS n FROM vendors WHERE category = $1 AND status IN ('responded','approved')`, [
      category,
    ])
  )?.n;
  const rate = sent > 0 ? Math.round((responded / sent) * 1000) / 1000 : 0;
  await q(
    `UPDATE agent_learning SET sent_count = $1, responded_count = $2, response_rate = $3, updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE category = $4`,
    [sent, responded, rate, category]
  );
}

export async function listVendors({ category, status } = {}) {
  let sql = 'SELECT * FROM vendors WHERE true';
  const params = [];
  if (category) {
    sql += ' AND category = ?';
    params.push(category);
  }
  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  sql += ' ORDER BY LOWER(name)';
  return qAll(sql, params);
}

export async function getVendor(id) {
  return qGet('SELECT * FROM vendors WHERE id = ?', [id]);
}

export async function getAgentLearningForCategory(category) {
  return qGet('SELECT * FROM agent_learning WHERE category = ?', [category]);
}

export async function logAgentActivity({ activity_type, vendor_id = null, summary = '', detail = {} }) {
  await q(
    `INSERT INTO agent_activity (activity_type, vendor_id, summary, detail_json, created_at) VALUES (?, ?, ?, ?, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))`,
    [activity_type, vendor_id, summary, JSON.stringify(detail || {})]
  );
}

export async function listAgentActivity(limit = 100) {
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
  return qAll(
    `SELECT a.*, v.name AS vendor_name FROM agent_activity a
     LEFT JOIN vendors v ON v.id = a.vendor_id
     ORDER BY a.id DESC LIMIT ?`,
    [lim]
  );
}

export async function updateVendor(id, patch) {
  const prev = await getVendor(id);
  const allowed = [
    'name',
    'contact_person',
    'email',
    'phone',
    'category',
    'status',
    'date_sent',
    'next_followup_date',
    'notes',
    'letter_version_used',
    'website',
    'years_in_business',
    'address',
    'agent_enrichment_status',
    'research_miss_streak',
    'research_week_id',
  ];
  const sets = [];
  const vals = [];
  for (const key of allowed) {
    if (patch[key] !== undefined) {
      sets.push(`${key} = ?`);
      vals.push(patch[key]);
    }
  }
  if (patch.status !== undefined && prev && prev.status !== patch.status) {
    if (patch.status === 'responded') {
      sets.push(
        `responded_at = COALESCE(NULLIF(TRIM(responded_at), ''), to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))`
      );
    }
    if (patch.status === 'approved') {
      sets.push(
        `approved_at = COALESCE(NULLIF(TRIM(approved_at), ''), to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))`
      );
    }
  }
  if (!sets.length) return getVendor(id);
  sets.push(`updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`);
  vals.push(id);
  await q(`UPDATE vendors SET ${sets.join(', ')} WHERE id = ?`, vals);
  const next = await getVendor(id);
  if (prev && patch.status && prev.status !== patch.status) {
    try {
      await refreshAgentLearningForCategory(next.category);
    } catch {
      /* ignore */
    }
  }
  return next;
}

export async function markSent(id, { letter_version_used } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const next = addDaysIso(today, 30);
  const v = await getVendor(id);
  if (!v) return null;
  await q(
    `UPDATE vendors SET status = 'sent', date_sent = ?, next_followup_date = ?, letter_version_used = COALESCE(?, letter_version_used), updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`,
    [today, next, letter_version_used || v.letter_version_used || '', id]
  );
  const out = await getVendor(id);
  try {
    await refreshAgentLearningForCategory(out.category);
  } catch {
    /* ignore */
  }
  return out;
}

export async function logFollowup(id, note) {
  const today = new Date().toISOString().slice(0, 10);
  const next = addDaysIso(today, 30);
  await q(`INSERT INTO followup_logs (vendor_id, note) VALUES (?, ?)`, [id, note || '']);
  const v = await getVendor(id);
  const stamp = `[${today}] Follow-up: ${note || '(logged)'}`;
  const newNotes = v.notes ? `${v.notes}\n${stamp}` : stamp;
  await q(
    `UPDATE vendors SET next_followup_date = ?, notes = ?, updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`,
    [next, newNotes, id]
  );
  return getVendor(id);
}

export async function listFollowupLogs(vendorId) {
  return qAll(`SELECT * FROM followup_logs WHERE vendor_id = ? ORDER BY logged_at DESC`, [vendorId]);
}

function daysBetween(a, b) {
  const da = new Date(a + 'T12:00:00Z');
  const db_ = new Date(b + 'T12:00:00Z');
  return Math.round((db_.getTime() - da.getTime()) / 86400000);
}

export async function getStats() {
  const rows = await qAll(`
    SELECT category,
      COUNT(*)::int AS total,
      SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END)::int AS sent,
      SUM(CASE WHEN status = 'responded' THEN 1 ELSE 0 END)::int AS responded,
      SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END)::int AS approved
    FROM vendors GROUP BY category
  `);
  const total = (await qGet(`SELECT COUNT(*)::int AS n FROM vendors`))?.n;
  const sentTotal = (await qGet(`SELECT COUNT(*)::int AS n FROM vendors WHERE status IN ('sent','responded','approved')`))?.n;
  const approvedTotal = (await qGet(`SELECT COUNT(*)::int AS n FROM vendors WHERE status = 'approved'`))?.n;
  const overdue = (await listOverdue()).length;
  return { total, sentTotal, approvedTotal, overdue, byCategory: rows };
}

export async function listOverdue() {
  const today = new Date().toISOString().slice(0, 10);
  const all = await qAll(
    `SELECT * FROM vendors
     WHERE next_followup_date IS NOT NULL
       AND status NOT IN ('responded','approved')
     ORDER BY next_followup_date ASC`
  );
  return all.map((v) => {
    const diff = daysBetween(v.next_followup_date, today);
    return { ...v, daysUntilFollowup: diff };
  });
}

export async function listMonthlyAlerts() {
  return listOverdue();
}

export async function exportVendorsCsvRows() {
  return qAll(`SELECT * FROM vendors ORDER BY category, name`);
}

export async function insertAgentTask({
  dedupe_key,
  vendor_id,
  title,
  description,
  priority,
  due_date,
}) {
  const { rows } = await q(
    `INSERT INTO agent_tasks (dedupe_key, vendor_id, title, description, priority, due_date, status, created_at, approved_by_kevin)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'), 1) RETURNING id`,
    [dedupe_key, vendor_id ?? null, title, description, priority, due_date]
  );
  return getAgentTask(rows[0].id);
}

export async function listAgentTasks({ status } = {}) {
  let sql = `SELECT t.*, v.name AS vendor_name FROM agent_tasks t
    LEFT JOIN vendors v ON v.id = t.vendor_id WHERE true`;
  const params = [];
  if (status) {
    sql += ' AND t.status = ?';
    params.push(status);
  }
  sql += ` ORDER BY
    CASE t.priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
    t.due_date ASC,
    t.created_at ASC`;
  return qAll(sql, params);
}

export async function getAgentTask(id) {
  return qGet(
    `SELECT t.*, v.name AS vendor_name FROM agent_tasks t
     LEFT JOIN vendors v ON v.id = t.vendor_id WHERE t.id = ?`,
    [id]
  );
}

export async function getTodaysPriorityActions(_limit = 12) {
  return [];
}

export async function listAwaitingApproval(_limit = 20) {
  return [];
}

export async function updateAgentTask(id, patch) {
  const allowed = ['status', 'ai_recommendation', 'approved_by_kevin'];
  const sets = [];
  const vals = [];
  for (const key of allowed) {
    if (patch[key] !== undefined) {
      sets.push(`${key} = ?`);
      vals.push(key === 'approved_by_kevin' ? (patch[key] ? 1 : 0) : patch[key]);
    }
  }
  if (!sets.length) return getAgentTask(id);
  vals.push(id);
  await q(`UPDATE agent_tasks SET ${sets.join(', ')} WHERE id = ?`, vals);
  return getAgentTask(id);
}

export async function runAgent() {
  const vendors = await listVendors();
  return { created: 0, reactivated: 0, skipped: 0, scanned: vendors.length };
}

export async function insertAgentRun(runType = 'research') {
  const { rows } = await q(
    `INSERT INTO agent_runs (run_type, status, started_at, summary) VALUES (?, 'running', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'), '{}') RETURNING id`,
    [runType]
  );
  return rows[0].id;
}

export async function insertBackgroundAgentRun() {
  return insertAgentRun('research');
}

export async function completeAgentRun(id, status, summary, errorMessage = '') {
  const sum = { ...(summary || {}) };
  if (errorMessage) sum._errorMessage = errorMessage;
  await q(
    `UPDATE agent_runs SET finished_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'), status = ?, summary = ? WHERE id = ?`,
    [status, JSON.stringify(sum), id]
  );
}

export async function completeBackgroundAgentRun(id, status, summary, errorMessage = '') {
  return completeAgentRun(id, status, summary, errorMessage);
}

export async function listAgentRuns(limit = 20) {
  const lim = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const rows = await qAll(`SELECT * FROM agent_runs ORDER BY id DESC LIMIT ?`, [lim]);
  return rows.map((row) => {
    const parsed = safeJson(row.summary, {});
    const error_message = parsed._errorMessage || '';
    const { _errorMessage, ...restSummary } = parsed;
    const { summary: _sumText, ...restRow } = row;
    return {
      ...restRow,
      summary: restSummary,
      error_message,
      completed_at: row.finished_at,
    };
  });
}

export async function listBackgroundAgentRuns(limit) {
  return listAgentRuns(limit);
}

export async function upsertPendingVendorFieldUpdate({
  run_id: _run_id,
  vendor_id,
  field_name,
  proposed_value,
  source_url,
  source_title: _source_title,
  confidence_score,
}) {
  const v = await getVendor(vendor_id);
  const oldVal = v ? String(v[field_name] || '') : '';
  await q(`DELETE FROM pending_vendor_updates WHERE vendor_id = ? AND field_name = ? AND status = 'pending'`, [
    vendor_id,
    field_name,
  ]);
  const { rows } = await q(
    `INSERT INTO pending_vendor_updates (vendor_id, field_name, old_value, new_value, source_url, confidence_score, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')) RETURNING id`,
    [
      vendor_id,
      field_name,
      oldVal,
      proposed_value || '',
      source_url || '',
      confidence_score != null ? Number(confidence_score) : null,
    ]
  );
  return getPendingVendorFieldUpdate(rows[0].id);
}

export async function listPendingVendorFieldUpdates({ status = 'pending' } = {}) {
  return qAll(
    `SELECT p.id, p.vendor_id, p.field_name, p.old_value, p.new_value, p.new_value AS proposed_value,
            p.source_url, p.confidence_score, p.status, p.created_at,
            v.name AS vendor_name
     FROM pending_vendor_updates p
     JOIN vendors v ON v.id = p.vendor_id
     WHERE p.status = ?
     ORDER BY p.created_at DESC`,
    [status]
  );
}

export async function getPendingVendorFieldUpdate(id) {
  return qGet(
    `SELECT p.id, p.vendor_id, p.field_name, p.old_value, p.new_value, p.new_value AS proposed_value,
            p.source_url, p.confidence_score, p.status, p.created_at,
            v.name AS vendor_name
     FROM pending_vendor_updates p
     JOIN vendors v ON v.id = p.vendor_id WHERE p.id = ?`,
    [id]
  );
}

export async function setPendingVendorFieldStatus(id, status) {
  await q(`UPDATE pending_vendor_updates SET status = ? WHERE id = ? AND status = 'pending'`, [status, id]);
  return getPendingVendorFieldUpdate(id);
}

export async function insertPendingNewProspect(row) {
  const evidenceUrls = Array.isArray(row.evidence_urls) ? row.evidence_urls : safeJson(row.evidence_urls, []);
  const firstUrl = (evidenceUrls[0] && evidenceUrls[0].url) || row.website || row.source_url || '';
  const reasonParts = [row.tenure_evidence_summary, row.online_notes].filter(Boolean);
  for (const u of evidenceUrls.slice(0, 8)) {
    if (u?.url) reasonParts.push(`${u.title || 'Source'}: ${u.url}`);
  }
  const outreachEnsured = ensureAgentEmailDraftHasContact(row.outreach_email_draft || '');
  const { rows } = await q(
    `INSERT INTO suggested_companies (
      name, category, phone, email, website, address, city, years_in_business, source_url,
      reason_qualified, confidence_score, tailored_email, dedupe_key, prospect_subtype, contact_person, online_notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    [
      row.name,
      row.category,
      row.phone || '',
      row.email || '',
      row.website || '',
      row.address || '',
      row.city || '',
      row.years_in_business || '',
      firstUrl,
      reasonParts.join('\n\n') || '',
      row.confidence_score != null ? Number(row.confidence_score) : 0.85,
      outreachEnsured,
      row.dedupe_key,
      row.prospect_subtype || '',
      row.contact_person || '',
      row.online_notes || '',
    ]
  );
  const sid = rows[0].id;
  const draftText = outreachEnsured.trim();
  if (draftText) {
    const { subject, body } = splitEmailSubjectBody(draftText);
    await q(
      `INSERT INTO email_drafts (vendor_id, suggested_company_id, subject, body, status, created_at) VALUES (NULL, ?, ?, ?, 'draft', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))`,
      [sid, subject, body]
    );
  }
  return getPendingNewProspect(sid);
}

export async function listSuggestedCompanies({ status } = {}) {
  let sql = `SELECT s.*, d.subject AS draft_subject, d.body AS draft_body, d.id AS draft_id
     FROM suggested_companies s
     LEFT JOIN email_drafts d ON d.id = (
       SELECT MAX(id) FROM email_drafts ed WHERE ed.suggested_company_id = s.id
     )
     WHERE true`;
  const params = [];
  if (status != null && status !== '' && status !== 'all') {
    sql += ' AND s.status = ?';
    params.push(status);
  }
  sql += ' ORDER BY s.created_at DESC';
  const rows = await qAll(sql, params);
  return rows.map((row) => {
    const { draft_subject, draft_body, draft_id, ...s } = row;
    return mapSuggestedCompanyRow(s, { subject: draft_subject, body: draft_body });
  });
}

export async function listPendingNewProspects({ status = 'pending' } = {}) {
  return listSuggestedCompanies({ status });
}

export async function listEmailDrafts({ status, limit = 200 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 200, 1), 500);
  let sql = `SELECT d.*, s.name AS suggested_company_name, v.name AS vendor_name
    FROM email_drafts d
    LEFT JOIN suggested_companies s ON s.id = d.suggested_company_id
    LEFT JOIN vendors v ON v.id = d.vendor_id
    WHERE true`;
  const params = [];
  if (status) {
    sql += ' AND d.status = ?';
    params.push(status);
  }
  sql += ' ORDER BY d.id DESC LIMIT ?';
  params.push(lim);
  return qAll(sql, params);
}

export async function getEmailDraft(id) {
  return qGet(
    `SELECT d.*, v.name AS vendor_name, v.category, v.email AS vendor_email, v.contact_person
     FROM email_drafts d
     LEFT JOIN vendors v ON v.id = d.vendor_id
     WHERE d.id = ?`,
    [id]
  );
}

export async function vendorHasPendingOutreachDraft(vendorId) {
  const r = await qGet(
    `SELECT 1 AS x FROM email_drafts WHERE vendor_id = ? AND suggested_company_id IS NULL AND status IN ('draft','pending_kevin') LIMIT 1`,
    [vendorId]
  );
  return Boolean(r);
}

export async function listEmailsReadyToSend() {
  return qAll(
    `SELECT d.*, v.name AS company_name, v.category, v.email AS vendor_email, v.contact_person,
      LEFT(COALESCE(d.subject,''), 120) AS subject_preview
     FROM email_drafts d
     INNER JOIN vendors v ON v.id = d.vendor_id
     WHERE d.vendor_id IS NOT NULL
     AND (d.status = 'pending_kevin' OR d.status = 'draft')
     AND d.suggested_company_id IS NULL
     AND TRIM(COALESCE(d.body,'')) <> ''
     AND TRIM(COALESCE(v.email,'')) <> ''
     ORDER BY COALESCE(d.created_at, '1970-01-01') DESC`
  );
}

function collectContactGaps(v) {
  const missing = [];
  if (!(v.email || '').trim()) missing.push('email address');
  if (!(v.contact_person || '').trim()) missing.push('contact name');
  if (!(v.phone || '').trim()) missing.push('phone');
  return missing;
}

export async function listBlockedVendorIdsForAgent() {
  const rows = await qAll(
    `SELECT id FROM vendors
     WHERE status IN ('not_sent','new')
       AND (
         TRIM(COALESCE(email,'')) = ''
         OR TRIM(COALESCE(contact_person,'')) = ''
         OR TRIM(COALESCE(phone,'')) = ''
       )
       ORDER BY id ASC`
  );
  return rows.map((r) => r.id);
}

export async function listBlockedCompaniesForReport() {
  const rows = await qAll(
    `SELECT * FROM vendors
     WHERE status IN ('not_sent','new')
       AND (
         TRIM(COALESCE(email,'')) = ''
         OR TRIM(COALESCE(contact_person,'')) = ''
         OR TRIM(COALESCE(phone,'')) = ''
       )
       ORDER BY created_at ASC`
  );
  return rows.map((v) => {
    const missingLabels = collectContactGaps(v);
    const created = v.created_at ? new Date(String(v.created_at).replace(' ', 'T') + 'Z') : new Date();
    const daysInSystem = Math.max(0, Math.floor((Date.now() - created.getTime()) / 86400000));
    let agentStatus = 'Searching...';
    if ((v.research_miss_streak || 0) >= 3) agentStatus = 'Manual lookup needed';
    else if ((v.agent_enrichment_status || '') === 'found_saved') agentStatus = 'Found — saved';
    return { ...v, missingLabels, daysInSystem, agentStatus };
  });
}

export async function listOpenIssuesForReport({ limit = 25 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const issues = [];
  const stuck = await qAll(
    `SELECT id, name, category, agent_enrichment_status, research_miss_streak FROM vendors
     WHERE status IN ('not_sent','new') AND COALESCE(research_miss_streak,0) >= 3
     LIMIT 10`
  );
  for (const v of stuck) {
    issues.push({
      kind: 'enrichment_exhausted',
      vendor_id: v.id,
      title: `Research capped: ${v.name}`,
      detail: 'No new fields from Places/Serp after 3 attempts this week.',
    });
  }
  const prospects = await qAll(
    `SELECT id, name, category FROM suggested_companies WHERE status = 'pending' ORDER BY id DESC LIMIT 8`
  );
  for (const p of prospects) {
    issues.push({
      kind: 'prospect_confirm',
      suggested_company_id: p.id,
      title: `Confirm new company: ${p.name}`,
      detail: `Category: ${p.category}`,
    });
  }
  const failed = await qAll(
    `SELECT d.*, v.name AS vendor_name FROM email_drafts d
     LEFT JOIN vendors v ON v.id = d.vendor_id
     WHERE d.status = 'failed' ORDER BY d.id DESC LIMIT 6`
  );
  for (const f of failed) {
    issues.push({
      kind: 'email_failed',
      draft_id: f.id,
      vendor_id: f.vendor_id,
      title: `Email send failed: ${f.vendor_name || 'Unknown'}`,
      detail: f.subject || '',
    });
  }
  return issues.slice(0, lim);
}

export async function getAgentReportSummary() {
  const totalCompanies = (await qGet(`SELECT COUNT(*)::int AS n FROM vendors`))?.n;
  const newCompaniesThisMonth = (
    await qGet(
      `SELECT COUNT(*)::int AS n FROM vendors
       WHERE substring(created_at, 1, 7) = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM')`
    )
  )?.n;
  const emailsSentThisMonth = (
    await qGet(
      `SELECT COUNT(*)::int AS n FROM vendors WHERE date_sent IS NOT NULL
       AND substring(date_sent, 1, 7) = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM')`
    )
  )?.n;
  const vendorApprovals = (await qGet(`SELECT COUNT(*)::int AS n FROM vendors WHERE status = 'approved'`))?.n;
  const companiesBlocked = (
    await qGet(
      `SELECT COUNT(*)::int AS n FROM vendors WHERE status IN ('not_sent','new') AND (
        TRIM(COALESCE(email,'')) = ''
        OR TRIM(COALESCE(contact_person,'')) = ''
        OR TRIM(COALESCE(phone,'')) = ''
      )`
    )
  )?.n;
  const emailsAwaitingApproval = (
    await qGet(
      `SELECT COUNT(*)::int AS n FROM email_drafts d
       INNER JOIN vendors v ON v.id = d.vendor_id
       WHERE d.vendor_id IS NOT NULL
       AND (d.status = 'pending_kevin' OR d.status = 'draft')
       AND d.suggested_company_id IS NULL
       AND TRIM(COALESCE(d.body,'')) <> ''
       AND TRIM(COALESCE(v.email,'')) <> ''`
    )
  )?.n;
  return {
    totalCompanies,
    newCompaniesThisMonth,
    emailsSentThisMonth,
    vendorApprovals,
    companiesBlocked,
    emailsAwaitingApproval,
  };
}

function addCalendarDayYmdPg(dayYmd, deltaDays) {
  const d = new Date(`${dayYmd}T12:00:00`);
  d.setDate(d.getDate() + deltaDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/**
 * @param {{ date?: string }} params
 */
export async function getReviewDashboard(params = {}) {
  const day =
    typeof params.date === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(params.date.trim())
      ? params.date.trim()
      : new Date().toISOString().slice(0, 10);
  const monthKey = day.slice(0, 7);
  const dayStart = `${day} 00:00:00`;
  const dayEnd = `${addCalendarDayYmdPg(day, 1)} 00:00:00`;

  const cnt = async (sql, ...args) => Number((await qGet(sql, args))?.n || 0);

  const newCompaniesAgentToday = await cnt(
    `SELECT COUNT(*)::int AS n FROM agent_activity
     WHERE activity_type = 'discovery_register' AND created_at >= ? AND created_at < ?`,
    dayStart,
    dayEnd
  );
  const newVendorRowsToday = await cnt(
    `SELECT COUNT(*)::int AS n FROM vendors WHERE created_at >= ? AND created_at < ?`,
    dayStart,
    dayEnd
  );
  const draftsCreatedToday = await cnt(
    `SELECT COUNT(*)::int AS n FROM agent_activity
     WHERE activity_type = 'draft_created' AND created_at >= ? AND created_at < ?`,
    dayStart,
    dayEnd
  );
  const emailsSentToday = await cnt(
    `SELECT COUNT(*)::int AS n FROM agent_activity
     WHERE activity_type IN ('email_sent','followup_email_sent')
       AND created_at >= ? AND created_at < ?`,
    dayStart,
    dayEnd
  );
  const respondedToday = await cnt(
    `SELECT COUNT(*)::int AS n FROM vendors
     WHERE COALESCE(TRIM(responded_at), '') <> ''
       AND (responded_at LIKE ? OR responded_at LIKE ?)`,
    `${day} %`,
    `${day}T%`
  );
  const partnershipsThisMonth = await cnt(
    `SELECT COUNT(*)::int AS n FROM vendors
     WHERE status = 'approved'
       AND COALESCE(TRIM(approved_at), '') <> ''
       AND substring(replace(approved_at, 'T', ' '), 1, 7) = ?`,
    monthKey
  );

  const monthlyContacted = await cnt(
    `SELECT COUNT(*)::int AS n FROM vendors
     WHERE date_sent IS NOT NULL AND TRIM(date_sent) <> ''
       AND substring(trim(date_sent), 1, 7) = ?`,
    monthKey
  );
  const monthlyRespondedAmongContacted = await cnt(
    `SELECT COUNT(*)::int AS n FROM vendors
     WHERE date_sent IS NOT NULL AND TRIM(date_sent) <> ''
       AND substring(trim(date_sent), 1, 7) = ?
       AND status IN ('responded','approved')`,
    monthKey
  );
  const monthlyPartnershipsWithStamp = await cnt(
    `SELECT COUNT(*)::int AS n FROM vendors
     WHERE status = 'approved'
       AND COALESCE(TRIM(approved_at), '') <> ''
       AND substring(replace(approved_at, 'T', ' '), 1, 7) = ?`,
    monthKey
  );
  const responseRatePct =
    monthlyContacted > 0
      ? Math.round((monthlyRespondedAmongContacted / monthlyContacted) * 1000) / 10
      : null;

  const EST_PER_PARTNER_MONTHLY_USD = 3500;
  const estimatedRevenuePotentialMonthly = monthlyPartnershipsWithStamp * EST_PER_PARTNER_MONTHLY_USD;

  const chartStart = `${addCalendarDayYmdPg(day, -29)} 00:00:00`;
  const chartEnd = dayEnd;
  const activityBuckets = await qAll(
    `SELECT substring(replace(created_at, 'T', ' '), 1, 10) AS d,
            activity_type AS t,
            COUNT(*)::int AS c
     FROM agent_activity
     WHERE created_at >= ? AND created_at < ?
       AND activity_type IN ('discovery_register','draft_created','email_sent','followup_email_sent')
     GROUP BY d, t`,
    [chartStart, chartEnd]
  );
  const byDay = {};
  for (let i = -29; i <= 0; i += 1) {
    const d = addCalendarDayYmdPg(day, i);
    byDay[d] = { date: d, discoveries: 0, drafts: 0, sends: 0 };
  }
  for (const row of activityBuckets) {
    const b = byDay[row.d];
    if (!b) continue;
    if (row.t === 'discovery_register') b.discoveries += row.c;
    if (row.t === 'draft_created') b.drafts += row.c;
    if (row.t === 'email_sent' || row.t === 'followup_email_sent') b.sends += row.c;
  }
  const chart30 = Object.keys(byDay)
    .sort()
    .map((k) => byDay[k]);

  const timelineRows = await qAll(
    `SELECT a.activity_type, a.summary, a.created_at, v.name AS vendor_name
     FROM agent_activity a
     LEFT JOIN vendors v ON v.id = a.vendor_id
     WHERE a.created_at >= ? AND a.created_at < ?
     ORDER BY a.created_at ASC`,
    [dayStart, dayEnd]
  );

  const timelineByHour = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    label: `${String(hour).padStart(2, '0')}:00`,
    activities: [],
  }));
  for (const r of timelineRows) {
    const raw = String(r.created_at || '').replace('T', ' ');
    const hh = parseInt(raw.slice(11, 13), 10);
    const hour = Number.isFinite(hh) ? hh : 0;
    const slot = timelineByHour[Math.min(23, Math.max(0, hour))];
    slot.activities.push({
      created_at: r.created_at,
      activity_type: r.activity_type,
      summary: r.summary,
      vendor_name: r.vendor_name || null,
    });
  }

  return {
    day,
    monthKey,
    daily: {
      newCompaniesAgentToday,
      newVendorRowsToday,
      draftsCreatedToday,
      emailsSentToday,
      respondedToday,
      partnershipsThisMonth,
    },
    monthly: {
      contactedThisMonth: monthlyContacted,
      respondedAmongContactedThisMonth: monthlyRespondedAmongContacted,
      responseRatePct,
      partnershipsEstablishedThisMonth: monthlyPartnershipsWithStamp,
      estimatedRevenuePotentialMonthly,
      estimatedRevenueNote:
        'Rough pipeline: new approvals this month × $3,500/mo assumed partner job mix (adjust to your book of business).',
    },
    chart30,
    timelineByHour,
  };
}

export async function upsertVendorOutreachDraft(vendorId, subject, body, { draft_type = 'outreach' } = {}) {
  const bodySafe = ensureAgentEmailDraftHasContact(body || '');
  await q(
    `DELETE FROM email_drafts WHERE vendor_id = ? AND suggested_company_id IS NULL AND draft_type = ? AND status IN ('draft','pending_kevin')`,
    [vendorId, draft_type]
  );
  const { rows } = await q(
    `INSERT INTO email_drafts (vendor_id, suggested_company_id, subject, body, status, draft_type, created_at)
     VALUES (?, NULL, ?, ?, 'draft', ?, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')) RETURNING id`,
    [vendorId, subject || '', bodySafe, draft_type]
  );
  return getEmailDraft(rows[0].id);
}

export async function finalizeEmailDraftSent(draftId, vendorId, { subject, body } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const next = addDaysIso(today, 30);
  await q(
    `UPDATE email_drafts SET subject = COALESCE(?, subject), body = COALESCE(?, body), status = 'sent', sent_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`,
    [subject || null, body || null, draftId]
  );
  await q(
    `UPDATE vendors SET status = 'sent', date_sent = ?, next_followup_date = ?, updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`,
    [today, next, vendorId]
  );
  await logAgentActivity({
    activity_type: 'email_sent',
    vendor_id: vendorId,
    summary: `Outreach email sent`,
    detail: { draftId, subject },
  });
  const v = await getVendor(vendorId);
  if (v) {
    const sub = (subject || '').trim();
    if (sub) {
      const cur = await qGet(`SELECT best_subject_line FROM agent_learning WHERE category = ?`, [v.category]);
      const parts = String(cur?.best_subject_line || '')
        .split('|')
        .map((s) => s.trim())
        .filter(Boolean);
      parts.push(sub);
      const line = parts.slice(-6).join(' | ');
      await q(`UPDATE agent_learning SET best_subject_line = ? WHERE category = ?`, [line, v.category]);
    }
    await refreshAgentLearningForCategory(v.category);
  }
  return v;
}

export async function finalizeFollowupEmailSent(draftId, vendorId, { subject, body } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const next = addDaysIso(today, 30);
  await q(
    `UPDATE email_drafts SET subject = COALESCE(?, subject), body = COALESCE(?, body), status = 'sent', sent_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'), draft_type = 'follow_up' WHERE id = ?`,
    [subject || null, body || null, draftId]
  );
  const v0 = await getVendor(vendorId);
  const note = `[${today}] Follow-up email sent via CRM (draft #${draftId}).`;
  const newNotes = v0?.notes ? `${v0.notes}\n${note}` : note;
  await q(
    `UPDATE vendors SET next_followup_date = ?, notes = ?, updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`,
    [next, newNotes, vendorId]
  );
  await logAgentActivity({
    activity_type: 'followup_email_sent',
    vendor_id: vendorId,
    summary: 'Follow-up email sent',
    detail: { draftId, subject },
  });
  const v = await getVendor(vendorId);
  if (v) await refreshAgentLearningForCategory(v.category);
  return v;
}

export async function markEmailDraftFailed(draftId, errMsg = '') {
  await q(`UPDATE email_drafts SET status = 'failed', bounced_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?`, [draftId]);
  await logAgentActivity({
    activity_type: 'email_failed',
    summary: errMsg || 'SMTP send failed',
    detail: { draftId },
  });
}

export async function vendorsAddedSince(isoDate) {
  return qAll(`SELECT * FROM vendors WHERE created_at >= ? ORDER BY id DESC LIMIT 50`, [isoDate]);
}

export async function getPendingNewProspect(id) {
  const s = await qGet(`SELECT * FROM suggested_companies WHERE id = ?`, [id]);
  if (!s) return null;
  const draft = await qGet(
    `SELECT * FROM email_drafts WHERE suggested_company_id = ? AND status = 'draft' ORDER BY id DESC LIMIT 1`,
    [id]
  );
  return mapSuggestedCompanyRow(s, draft);
}

export async function setPendingNewProspectStatus(id, status) {
  await q(`UPDATE suggested_companies SET status = ? WHERE id = ? AND status = 'pending'`, [status, id]);
  await q(`UPDATE email_drafts SET status = ? WHERE suggested_company_id = ? AND status = 'draft'`, [
    status === 'rejected' ? 'void' : 'used',
    id,
  ]);
  return getPendingNewProspect(id);
}

export async function vendorNameExistsLoose(name) {
  const n = normalizeNameDedupe(name);
  if (!n) return false;
  const rows = await qAll(`SELECT id, name FROM vendors`);
  for (const r of rows) {
    if (normalizeNameDedupe(r.name) === n) return true;
  }
  return false;
}

export async function pendingProspectDedupeExists(dedupeKey) {
  const ex = await qGet(`SELECT id FROM suggested_companies WHERE dedupe_key = ? AND status = 'pending'`, [dedupeKey]);
  return Boolean(ex);
}

export async function insertVendor({
  name,
  contact_person = '',
  email = '',
  phone = '',
  category,
  notes = '',
  website = '',
  years_in_business = '',
  address = '',
  status = 'not_sent',
  source = '',
}) {
  const st = ['new', 'not_sent', 'sent', 'responded', 'approved'].includes(status) ? status : 'not_sent';
  const { rows } = await q(
    `INSERT INTO vendors (
      name, contact_person, email, phone, category, status,
      date_sent, next_followup_date, notes, letter_version_used,
      website, years_in_business, address, source, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, '', ?, ?, ?, ?, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'), to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')) RETURNING id`,
    [
      name,
      contact_person || '',
      email || '',
      phone || '',
      category,
      st,
      notes || '',
      website || '',
      years_in_business || '',
      address || '',
      source || '',
    ]
  );
  return getVendor(rows[0].id);
}

/**
 * @param {Array<{ name: string, phone?: string, website?: string, address?: string, category: string, notes: string }>} rows
 */
export async function importVendorsFromMappedRows(rows) {
  const inserted = [];
  const skipped = [];
  const errors = [];
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i] || {};
    const name = String(r.name || '').trim();
    if (!name) {
      errors.push({ row: i + 1, error: 'Missing company name' });
      continue;
    }
    if (await vendorNameExistsLoose(name)) {
      skipped.push({ row: i + 1, name, reason: 'Similar name already in CRM' });
      continue;
    }
    try {
      const v = await insertVendor({
        name,
        contact_person: '',
        email: '',
        phone: String(r.phone || '').trim(),
        category: r.category || 'contractor',
        notes: String(r.notes || '').trim(),
        website: String(r.website || '').trim(),
        years_in_business: '',
        address: String(r.address || '').trim(),
        status: 'new',
        source: 'manual_import',
      });
      inserted.push(v);
    } catch (e) {
      errors.push({ row: i + 1, name, error: String(e.message || e) });
    }
  }
  await logAgentActivity({
    activity_type: 'csv_import',
    vendor_id: null,
    summary: `CSV import: ${inserted.length} added, ${skipped.length} skipped`,
    detail: { inserted: inserted.length, skipped: skipped.length, errorCount: errors.length },
  });
  return { insertedCount: inserted.length, skipped, errors, insertedIds: inserted.map((v) => v.id) };
}

const PENDING_VENDOR_FIELDS = new Set([
  'phone',
  'email',
  'website',
  'address',
  'contact_person',
  'years_in_business',
]);

export async function applyVendorFieldIfEmpty(vendorId, field_name, proposed_value, meta = {}) {
  const v = await getVendor(vendorId);
  if (!v || !PENDING_VENDOR_FIELDS.has(field_name)) return false;
  if ((v[field_name] || '').trim()) return false;
  const val = String(proposed_value || '').trim();
  if (!val) return false;
  await updateVendor(vendorId, { [field_name]: val });
  await logAgentActivity({
    activity_type: 'auto_fill',
    vendor_id: vendorId,
    summary: `Filled ${field_name}`,
    detail: meta || {},
  });
  return true;
}

export async function approvePendingVendorFieldUpdate(id) {
  const row = await getPendingVendorFieldUpdate(id);
  if (!row || row.status !== 'pending') return { error: 'Not found or already reviewed' };
  if (!PENDING_VENDOR_FIELDS.has(row.field_name)) return { error: 'Invalid field' };
  const v = await getVendor(row.vendor_id);
  const cur = String(v[row.field_name] || '').trim();
  if (cur) {
    return {
      error:
        'That field already has a value in the tracker. Reject this suggestion or update the vendor manually.',
      conflict: true,
    };
  }
  await updateVendor(row.vendor_id, { [row.field_name]: row.new_value ?? row.proposed_value });
  await setPendingVendorFieldStatus(id, 'approved');
  return { ok: true, vendor: await getVendor(row.vendor_id) };
}

export async function rejectPendingVendorFieldUpdate(id) {
  const row = await getPendingVendorFieldUpdate(id);
  if (!row || row.status !== 'pending') return { error: 'Not found or already reviewed' };
  await setPendingVendorFieldStatus(id, 'rejected');
  return { ok: true };
}

export async function approvePendingNewProspect(id) {
  const row = await getPendingNewProspect(id);
  if (!row || row.status !== 'pending') return { error: 'Not found or already reviewed' };
  if (await vendorNameExistsLoose(row.name)) {
    await setPendingNewProspectStatus(id, 'rejected');
    return { error: 'A vendor with a similar name already exists in the tracker.' };
  }
  const noteParts = [row.online_notes, row.reason_qualified, row.tenure_evidence_summary].filter(Boolean);
  if (row.prospect_subtype) noteParts.push(`Research focus: ${row.prospect_subtype}`);
  await insertVendor({
    name: row.name,
    category: row.category,
    contact_person: row.contact_person,
    email: row.email,
    phone: row.phone,
    website: row.website,
    years_in_business: row.years_in_business,
    address: row.address,
    notes: noteParts.join('\n\n'),
  });
  await setPendingNewProspectStatus(id, 'approved');
  return { ok: true };
}

export async function rejectPendingNewProspect(id) {
  const row = await getPendingNewProspect(id);
  if (!row || row.status !== 'pending') return { error: 'Not found or already reviewed' };
  await setPendingNewProspectStatus(id, 'rejected');
  return { ok: true };
}
