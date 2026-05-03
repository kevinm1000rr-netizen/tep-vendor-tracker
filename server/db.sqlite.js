import Database from 'better-sqlite3';
import fs from 'fs';
import { DB_PATH } from './paths.js';
import { SEED_VENDORS } from './seed.js';
import { VENDOR_TENURE_QUALIFICATION_SHORT } from './qualification.js';

let db;

export function getDb() {
  if (!db) throw new Error('Database not initialized');
  return db;
}

export function initDatabase() {
  const existed = fs.existsSync(DB_PATH);
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS vendors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      contact_person TEXT DEFAULT '',
      email TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      category TEXT NOT NULL CHECK (category IN ('restoration','property_mgmt','hoa','contractor')),
      status TEXT NOT NULL DEFAULT 'not_sent' CHECK (status IN ('not_sent','sent','responded','approved')),
      date_sent TEXT,
      next_followup_date TEXT,
      notes TEXT DEFAULT '',
      letter_version_used TEXT DEFAULT '',
      website TEXT DEFAULT '',
      years_in_business TEXT DEFAULT '',
      address TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS followup_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vendor_id INTEGER NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
      logged_at TEXT NOT NULL DEFAULT (datetime('now')),
      note TEXT DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_vendors_category ON vendors(category);
    CREATE INDEX IF NOT EXISTS idx_vendors_status ON vendors(status);
    CREATE INDEX IF NOT EXISTS idx_followup_vendor ON followup_logs(vendor_id);
    CREATE TABLE IF NOT EXISTS agent_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dedupe_key TEXT NOT NULL UNIQUE,
      vendor_id INTEGER REFERENCES vendors(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      priority TEXT NOT NULL CHECK (priority IN ('high','medium','low')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','skipped')),
      due_date TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      ai_recommendation TEXT DEFAULT '',
      approved_by_kevin INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_agent_tasks_status ON agent_tasks(status);
    CREATE INDEX IF NOT EXISTS idx_agent_tasks_vendor ON agent_tasks(vendor_id);
  `);

  migrateVendorEnrichmentColumns();
  migrateAgentTaskApprovalColumn();
  migrateResearchAgentTables();
  migrateAgentOverhaul();
  migrateInflatedNewThisMonthOnce();

  /** Baseline import date for bundled directory — not “new this month” on first open. */
  const SEED_DIRECTORY_IMPORTED_AT = '2020-06-01 08:00:00';

  if (!existed) {
    const insert = db.prepare(`
      INSERT INTO vendors (
        name, contact_person, email, phone, category, status,
        date_sent, next_followup_date, notes, letter_version_used,
        website, years_in_business, address, created_at, updated_at
      ) VALUES (
        @name, @contact_person, @email, @phone, @category, 'not_sent',
        NULL, NULL, @notes, '',
        COALESCE(@website, ''), COALESCE(@years_in_business, ''), COALESCE(@address, ''),
        @created_at, @created_at
      )
    `);
    const runMany = db.transaction((rows) => {
      for (const row of rows) insert.run({ ...row, created_at: SEED_DIRECTORY_IMPORTED_AT });
    });
    runMany(SEED_VENDORS);
  }
}

/** If every vendor row was created in the current calendar month (bulk seed), back-date once so “New this month” is meaningful. */
function migrateInflatedNewThisMonthOnce() {
  db.exec(`CREATE TABLE IF NOT EXISTS _migration_inflated_new_month_fix (id INTEGER PRIMARY KEY)`);
  if (db.prepare(`SELECT 1 FROM _migration_inflated_new_month_fix WHERE id = 1`).get()) return;
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS total,
         SUM(CASE WHEN strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now', 'localtime') THEN 1 ELSE 0 END) AS this_month
         FROM vendors`
      )
      .get();
    const total = Number(row?.total) || 0;
    const thisMonth = Number(row?.this_month) || 0;
    if (total >= 10 && thisMonth === total) {
      db.prepare(`UPDATE vendors SET created_at = ?, updated_at = datetime('now') WHERE 1=1`).run(
        '2020-06-01 08:00:00'
      );
    }
  } catch {
    /* ignore */
  }
  db.prepare(`INSERT OR IGNORE INTO _migration_inflated_new_month_fix (id) VALUES (1)`).run();
}

function migrateVendorEnrichmentColumns() {
  const cols = new Set(db.prepare(`PRAGMA table_info(vendors)`).all().map((r) => r.name));
  const add = (name, defSql) => {
    if (!cols.has(name)) {
      db.exec(`ALTER TABLE vendors ADD COLUMN ${name} ${defSql}`);
      cols.add(name);
    }
  };
  add('website', "TEXT DEFAULT ''");
  add('years_in_business', "TEXT DEFAULT ''");
  add('address', "TEXT DEFAULT ''");
}

/** Legacy DBs: add approval column; existing rows default to approved so nothing breaks. */
function migrateAgentTaskApprovalColumn() {
  const cols = new Set(db.prepare(`PRAGMA table_info(agent_tasks)`).all().map((r) => r.name));
  if (!cols.has('approved_by_kevin')) {
    db.exec(`ALTER TABLE agent_tasks ADD COLUMN approved_by_kevin INTEGER NOT NULL DEFAULT 1`);
  }
}

function collectMissingBusinessFields(v) {
  const missing = [];
  if (!(v.contact_person || '').trim()) missing.push('contact person');
  if (!(v.email || '').trim()) missing.push('email');
  if (!(v.phone || '').trim()) missing.push('phone');
  if (!(v.website || '').trim()) missing.push('website');
  if (!(v.years_in_business || '').trim()) missing.push('years in business');
  if (!(v.address || '').trim()) missing.push('address / city');
  return missing;
}

export function listVendors({ category, status } = {}) {
  let sql = 'SELECT * FROM vendors WHERE 1=1';
  const params = [];
  if (category) {
    sql += ' AND category = ?';
    params.push(category);
  }
  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  sql += ' ORDER BY name COLLATE NOCASE';
  return db.prepare(sql).all(...params);
}

export function getVendor(id) {
  return db.prepare('SELECT * FROM vendors WHERE id = ?').get(id);
}

function refreshAgentLearningForCategory(category) {
  if (!category) return;
  const sent = db
    .prepare(
      `SELECT COUNT(*) AS n FROM vendors WHERE category = ? AND status IN ('sent','responded','approved')`
    )
    .get(category).n;
  const responded = db
    .prepare(`SELECT COUNT(*) AS n FROM vendors WHERE category = ? AND status IN ('responded','approved')`)
    .get(category).n;
  const rate = sent > 0 ? Math.round((responded / sent) * 1000) / 1000 : 0;
  db.prepare(
    `UPDATE agent_learning SET sent_count = ?, responded_count = ?, response_rate = ?, updated_at = datetime('now') WHERE category = ?`
  ).run(sent, responded, rate, category);
}

export function getAgentLearningForCategory(category) {
  return db.prepare(`SELECT * FROM agent_learning WHERE category = ?`).get(category);
}

export function logAgentActivity({ activity_type, vendor_id = null, summary = '', detail = {} }) {
  db.prepare(
    `INSERT INTO agent_activity (activity_type, vendor_id, summary, detail_json, created_at) VALUES (?,?,?,?, datetime('now'))`
  ).run(activity_type, vendor_id, summary, JSON.stringify(detail || {}));
}

export function listAgentActivity(limit = 100) {
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
  return db
    .prepare(
      `SELECT a.*, v.name AS vendor_name FROM agent_activity a
       LEFT JOIN vendors v ON v.id = a.vendor_id
       ORDER BY a.id DESC LIMIT ?`
    )
    .all(lim);
}

export function updateVendor(id, patch) {
  const prev = getVendor(id);
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
  if (!sets.length) return getVendor(id);
  sets.push("updated_at = datetime('now')");
  vals.push(id);
  db.prepare(`UPDATE vendors SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  const next = getVendor(id);
  if (prev && patch.status && prev.status !== patch.status) {
    try {
      refreshAgentLearningForCategory(next.category);
    } catch {
      /* ignore */
    }
  }
  return next;
}

/** Today as YYYY-MM-DD in local server TZ — use ISO date from client for consistency; server uses UTC date for mark-sent if needed */
export function markSent(id, { letter_version_used } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const next = addDaysIso(today, 30);
  const v = getVendor(id);
  if (!v) return null;
  db.prepare(`
    UPDATE vendors SET
      status = 'sent',
      date_sent = ?,
      next_followup_date = ?,
      letter_version_used = COALESCE(?, letter_version_used),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(today, next, letter_version_used || v.letter_version_used || '', id);
  const out = getVendor(id);
  try {
    refreshAgentLearningForCategory(out.category);
  } catch {
    /* ignore */
  }
  return out;
}

export function logFollowup(id, note) {
  const today = new Date().toISOString().slice(0, 10);
  const next = addDaysIso(today, 30);
  db.prepare(`INSERT INTO followup_logs (vendor_id, note) VALUES (?, ?)`).run(id, note || '');
  const v = getVendor(id);
  const stamp = `[${today}] Follow-up: ${note || '(logged)'}`;
  const newNotes = v.notes ? `${v.notes}\n${stamp}` : stamp;
  db.prepare(`
    UPDATE vendors SET
      next_followup_date = ?,
      notes = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(next, newNotes, id);
  return getVendor(id);
}

export function listFollowupLogs(vendorId) {
  return db
    .prepare(
      `SELECT * FROM followup_logs WHERE vendor_id = ? ORDER BY logged_at DESC`
    )
    .all(vendorId);
}

function addDaysIso(isoDateStr, days) {
  const d = new Date(isoDateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function getStats() {
  const rows = db.prepare(`
    SELECT category,
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
      SUM(CASE WHEN status = 'responded' THEN 1 ELSE 0 END) AS responded,
      SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved
    FROM vendors GROUP BY category
  `).all();
  const total = db.prepare(`SELECT COUNT(*) AS n FROM vendors`).get().n;
  const sentTotal = db.prepare(`SELECT COUNT(*) AS n FROM vendors WHERE status IN ('sent','responded','approved')`).get().n;
  const approvedTotal = db.prepare(`SELECT COUNT(*) AS n FROM vendors WHERE status = 'approved'`).get().n;
  const overdue = listOverdue().length;
  return { total, sentTotal, approvedTotal, overdue, byCategory: rows };
}

/** Days until/since follow-up: negative = overdue */
export function listOverdue() {
  const today = new Date().toISOString().slice(0, 10);
  const all = db.prepare(`
    SELECT * FROM vendors
    WHERE next_followup_date IS NOT NULL
      AND status NOT IN ('responded','approved')
    ORDER BY next_followup_date ASC
  `).all();
  return all.map((v) => {
    const diff = daysBetween(v.next_followup_date, today);
    return { ...v, daysUntilFollowup: diff };
  });
}

export function listMonthlyAlerts() {
  return listOverdue();
}

function daysBetween(a, b) {
  const da = new Date(a + 'T12:00:00Z');
  const db_ = new Date(b + 'T12:00:00Z');
  return Math.round((db_.getTime() - da.getTime()) / 86400000);
}

export function exportVendorsCsvRows() {
  return db.prepare(`SELECT * FROM vendors ORDER BY category, name`).all();
}

export function insertAgentTask({
  dedupe_key,
  vendor_id,
  title,
  description,
  priority,
  due_date,
}) {
  const r = db
    .prepare(
      `INSERT INTO agent_tasks (dedupe_key, vendor_id, title, description, priority, due_date, status, created_at, approved_by_kevin)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', datetime('now'), 1)`
    )
    .run(dedupe_key, vendor_id ?? null, title, description, priority, due_date);
  return db.prepare(`SELECT * FROM agent_tasks WHERE id = ?`).get(r.lastInsertRowid);
}

export function listAgentTasks({ status } = {}) {
  let sql = `SELECT t.*, v.name AS vendor_name FROM agent_tasks t
    LEFT JOIN vendors v ON v.id = t.vendor_id WHERE 1=1`;
  const params = [];
  if (status) {
    sql += ' AND t.status = ?';
    params.push(status);
  }
  sql += ` ORDER BY
    CASE t.priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
    t.due_date ASC,
    t.created_at ASC`;
  return db.prepare(sql).all(...params);
}

export function getAgentTask(id) {
  return db
    .prepare(
      `SELECT t.*, v.name AS vendor_name FROM agent_tasks t
       LEFT JOIN vendors v ON v.id = t.vendor_id WHERE t.id = ?`
    )
    .get(id);
}

/** @deprecated Task queue removed — Agent Report replaces priority list. */
export function getTodaysPriorityActions(_limit = 12) {
  return [];
}

/** @deprecated No task approvals. */
export function listAwaitingApproval(_limit = 20) {
  return [];
}

export function updateAgentTask(id, patch) {
  const allowed = ['status', 'ai_recommendation', 'approved_by_kevin'];
  const sets = [];
  const vals = [];
  for (const key of allowed) {
    if (patch[key] !== undefined) {
      sets.push(`${key} = ?`);
      vals.push(
        key === 'approved_by_kevin' ? (patch[key] ? 1 : 0) : patch[key]
      );
    }
  }
  if (!sets.length) return getAgentTask(id);
  vals.push(id);
  db.prepare(`UPDATE agent_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return getAgentTask(id);
}

function getTaskByDedupe(dedupeKey) {
  return db.prepare(`SELECT id, status FROM agent_tasks WHERE dedupe_key = ?`).get(dedupeKey);
}

/**
 * Vendor-linked tasks: one row per dedupe_key. Pending = skip. Done/skipped + still applies = re-open as pending.
 */
function upsertVendorTask(dedupe, vendorId, title, description, priority, dueDate) {
  const ex = getTaskByDedupe(dedupe);
  if (ex?.status === 'pending') {
    return 'skipped';
  }
  if (ex) {
    db.prepare(
      `UPDATE agent_tasks SET vendor_id = ?, title = ?, description = ?, priority = ?, due_date = ?, status = 'pending', approved_by_kevin = 1, ai_recommendation = '' WHERE dedupe_key = ?`
    ).run(vendorId ?? null, title, description, priority, dueDate, dedupe);
    return 'reactivated';
  }
  insertAgentTask({
    dedupe_key: dedupe,
    vendor_id: vendorId,
    title,
    description,
    priority,
    due_date: dueDate,
  });
  return 'created';
}

/**
 * Monthly strategy: one task per calendar month; never recreate the same month after done/skipped.
 */
function insertMonthlyTask(monthKey, dueFirst, priority) {
  const dedupe = `monthly_strategy:${monthKey}`;
  const ex = getTaskByDedupe(dedupe);
  if (ex) {
    return ex.status === 'pending' ? 'skipped' : 'month_done';
  }
  insertAgentTask({
    dedupe_key: dedupe,
    vendor_id: null,
    title: 'Prepare monthly strategy report',
    description:
      'Run Monthly Review in the app (Monthly Review page), then execute the top actions from the report.',
    priority,
    due_date: dueFirst,
  });
  return 'created';
}

/**
 * Legacy “task queue” agent — disabled. Background research runs via `researchAgent.js` + cron.
 */
export function runAgent() {
  const vendors = listVendors();
  return { created: 0, reactivated: 0, skipped: 0, scanned: vendors.length };
}

/**
 * One task per month: research additional San Diego partners (10+ years in business).
 */
function insertDiscoverVendorsTask(monthKey, dueDate) {
  const dedupe = `discover_vendors:${monthKey}`;
  const ex = getTaskByDedupe(dedupe);
  if (ex) {
    return ex.status === 'pending' ? 'skipped' : 'month_done';
  }
  insertAgentTask({
    dedupe_key: dedupe,
    vendor_id: null,
    title: 'Find new partner companies (10+ years in business)',
    description: `Use “Suggest companies (10+ yrs)” for AI research leads, then confirm in writing. ${VENDOR_TENURE_QUALIFICATION_SHORT} Add to Tracker only after one rule is satisfied.`,
    priority: 'low',
    due_date: dueDate,
  });
  return 'created';
}

/** --- 24h Research & Outreach Agent (schema: agent_runs, pending_vendor_updates, suggested_companies, email_drafts) --- */

function migrateResearchAgentTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_type TEXT,
      status TEXT,
      started_at TEXT,
      finished_at TEXT,
      summary TEXT
    );
    CREATE TABLE IF NOT EXISTS pending_vendor_updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vendor_id INTEGER NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
      field_name TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      source_url TEXT,
      confidence_score REAL,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_pending_vendor_updates_vendor ON pending_vendor_updates(vendor_id);
    CREATE INDEX IF NOT EXISTS idx_pending_vendor_updates_status ON pending_vendor_updates(status);
    CREATE TABLE IF NOT EXISTS suggested_companies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      category TEXT NOT NULL CHECK (category IN ('restoration','property_mgmt','hoa','contractor')),
      phone TEXT,
      email TEXT,
      website TEXT,
      address TEXT,
      city TEXT,
      years_in_business TEXT,
      source_url TEXT,
      reason_qualified TEXT,
      confidence_score REAL,
      tailored_email TEXT,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_suggested_companies_status ON suggested_companies(status);
    CREATE TABLE IF NOT EXISTS email_drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vendor_id INTEGER REFERENCES vendors(id) ON DELETE SET NULL,
      suggested_company_id INTEGER REFERENCES suggested_companies(id) ON DELETE CASCADE,
      subject TEXT,
      body TEXT,
      status TEXT DEFAULT 'draft',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_email_drafts_suggested ON email_drafts(suggested_company_id);
  `);
  migrateSuggestedCompaniesExtraColumns();
  migrateLegacyResearchTablesIfPresent();
}

function suggestedCompaniesCols() {
  return new Set(db.prepare(`PRAGMA table_info(suggested_companies)`).all().map((c) => c.name));
}

function migrateSuggestedCompaniesExtraColumns() {
  const cols = suggestedCompaniesCols();
  if (!cols.has('dedupe_key')) {
    db.exec(`ALTER TABLE suggested_companies ADD COLUMN dedupe_key TEXT`);
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_suggested_companies_dedupe ON suggested_companies(dedupe_key) WHERE dedupe_key IS NOT NULL AND dedupe_key != ''`
    );
  }
  if (!cols.has('prospect_subtype')) {
    db.exec(`ALTER TABLE suggested_companies ADD COLUMN prospect_subtype TEXT NOT NULL DEFAULT ''`);
  }
  if (!cols.has('contact_person')) {
    db.exec(`ALTER TABLE suggested_companies ADD COLUMN contact_person TEXT NOT NULL DEFAULT ''`);
  }
  if (!cols.has('online_notes')) {
    db.exec(`ALTER TABLE suggested_companies ADD COLUMN online_notes TEXT NOT NULL DEFAULT ''`);
  }
}

function tableExists(name) {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name));
}

/** One-time copy from pre-rename tables, then drop legacy. */
function migrateLegacyResearchTablesIfPresent() {
  if (!tableExists('background_agent_runs')) return;

  const oldRuns = db.prepare(`SELECT * FROM background_agent_runs`).all();
  for (const r of oldRuns) {
    let sum = {};
    try {
      sum = JSON.parse(r.summary_json || '{}');
    } catch {
      sum = {};
    }
    if (r.error_message) sum._errorMessage = r.error_message;
    db.prepare(
      `INSERT INTO agent_runs (run_type, status, started_at, finished_at, summary) VALUES ('research', ?, ?, ?, ?)`
    ).run(r.status, r.started_at, r.completed_at || null, JSON.stringify(sum));
  }

  if (tableExists('pending_vendor_field_updates')) {
    const rows = db.prepare(`SELECT * FROM pending_vendor_field_updates`).all();
    for (const p of rows) {
      const v = getVendor(p.vendor_id);
      const oldVal = v ? String(v[p.field_name] || '') : '';
      db.prepare(
        `INSERT INTO pending_vendor_updates (vendor_id, field_name, old_value, new_value, source_url, confidence_score, status, created_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`
      ).run(
        p.vendor_id,
        p.field_name,
        oldVal,
        p.proposed_value ?? '',
        p.source_url ?? '',
        p.status,
        p.created_at || new Date().toISOString()
      );
    }
  }

  if (tableExists('pending_new_prospects')) {
    const rows = db.prepare(`SELECT * FROM pending_new_prospects`).all();
    for (const p of rows) {
      let evidenceUrls = [];
      try {
        evidenceUrls = JSON.parse(p.evidence_urls || '[]');
      } catch {
        evidenceUrls = [];
      }
      const firstUrl =
        (Array.isArray(evidenceUrls) && evidenceUrls[0]?.url) || p.website || p.source_url || '';
      const reasonParts = [p.tenure_evidence_summary, p.online_notes].filter(Boolean);
      if (Array.isArray(evidenceUrls)) {
        for (const u of evidenceUrls.slice(0, 6)) {
          if (u?.url) reasonParts.push(`${u.title || 'Source'}: ${u.url}`);
        }
      }
      const r = db
        .prepare(
          `INSERT INTO suggested_companies (
            name, category, phone, email, website, address, city, years_in_business, source_url,
            reason_qualified, confidence_score, tailored_email, status, created_at, dedupe_key, prospect_subtype, contact_person, online_notes
          ) VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?, 0.85, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          p.name,
          p.category,
          p.phone || '',
          p.email || '',
          p.website || '',
          p.address || '',
          p.years_in_business || '',
          firstUrl,
          reasonParts.join('\n\n') || '',
          p.outreach_email_draft || '',
          p.status,
          p.created_at || new Date().toISOString(),
          p.dedupe_key || `legacy:${p.id}`,
          p.prospect_subtype || '',
          p.contact_person || '',
          p.online_notes || ''
        );
      const newId = r.lastInsertRowid;
      const draft = (p.outreach_email_draft || '').trim();
      if (draft) {
        const { subject, body } = splitEmailSubjectBody(draft);
        db.prepare(
          `INSERT INTO email_drafts (vendor_id, suggested_company_id, subject, body, status, created_at) VALUES (NULL, ?, ?, ?, 'draft', datetime('now'))`
        ).run(newId, subject, body);
      }
    }
  }

  db.exec(`DROP TABLE IF EXISTS pending_vendor_field_updates`);
  db.exec(`DROP TABLE IF EXISTS pending_new_prospects`);
  db.exec(`DROP TABLE IF EXISTS background_agent_runs`);
}

function migrateAgentOverhaul() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_learning (
      category TEXT PRIMARY KEY CHECK (category IN ('restoration','property_mgmt','hoa','contractor')),
      response_rate REAL NOT NULL DEFAULT 0,
      best_day_to_send TEXT NOT NULL DEFAULT '',
      best_subject_line TEXT NOT NULL DEFAULT '',
      avg_days_to_response INTEGER NOT NULL DEFAULT 0,
      sent_count INTEGER NOT NULL DEFAULT 0,
      responded_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS agent_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      activity_type TEXT NOT NULL,
      vendor_id INTEGER REFERENCES vendors(id) ON DELETE SET NULL,
      summary TEXT NOT NULL DEFAULT '',
      detail_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_agent_activity_at ON agent_activity(created_at);
  `);
  for (const cat of ['restoration', 'property_mgmt', 'hoa', 'contractor']) {
    db.prepare(`INSERT OR IGNORE INTO agent_learning (category) VALUES (?)`).run(cat);
  }
  const vcols = new Set(db.prepare(`PRAGMA table_info(vendors)`).all().map((r) => r.name));
  const addV = (name, defSql) => {
    if (!vcols.has(name)) {
      db.exec(`ALTER TABLE vendors ADD COLUMN ${name} ${defSql}`);
      vcols.add(name);
    }
  };
  addV('agent_enrichment_status', "TEXT NOT NULL DEFAULT 'searching'");
  addV('research_miss_streak', 'INTEGER NOT NULL DEFAULT 0');
  addV('research_week_id', "TEXT NOT NULL DEFAULT ''");

  const dcols = new Set(db.prepare(`PRAGMA table_info(email_drafts)`).all().map((r) => r.name));
  const addD = (name, defSql) => {
    if (!dcols.has(name)) {
      db.exec(`ALTER TABLE email_drafts ADD COLUMN ${name} ${defSql}`);
      dcols.add(name);
    }
  };
  addD('draft_type', "TEXT NOT NULL DEFAULT 'outreach'");
  addD('sent_at', 'TEXT');
  addD('opened_at', 'TEXT');
  addD('bounced_at', 'TEXT');

  const scols = new Set(db.prepare(`PRAGMA table_info(suggested_companies)`).all().map((r) => r.name));
  if (!scols.has('attempt_count')) {
    db.exec(`ALTER TABLE suggested_companies ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0`);
  }

  autoApplyPendingVendorUpdatesOnce();
}

/** One-time / idempotent: apply queued field suggestions where the tracker field is still empty. */
function autoApplyPendingVendorUpdatesOnce() {
  const flag = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='_migration_auto_apply_pending'`).get();
  if (flag) return;
  const fields = new Set([
    'phone',
    'email',
    'website',
    'address',
    'contact_person',
    'years_in_business',
  ]);
  const rows = db.prepare(`SELECT * FROM pending_vendor_updates WHERE status = 'pending'`).all();
  for (const p of rows) {
    if (!fields.has(p.field_name)) continue;
    const v = getVendor(p.vendor_id);
    if (!v) continue;
    if ((v[p.field_name] || '').trim()) {
      setPendingVendorFieldStatus(p.id, 'rejected');
      continue;
    }
    const val = String(p.new_value ?? p.proposed_value ?? '').trim();
    if (!val) continue;
    updateVendor(p.vendor_id, { [p.field_name]: val });
    setPendingVendorFieldStatus(p.id, 'approved');
    logAgentActivity({
      activity_type: 'auto_fill',
      vendor_id: p.vendor_id,
      summary: `Auto-applied ${p.field_name} (legacy queue)`,
      detail: { source_url: p.source_url },
    });
  }
  db.exec(`CREATE TABLE IF NOT EXISTS _migration_auto_apply_pending (done INTEGER)`);
  db.exec(`INSERT INTO _migration_auto_apply_pending (done) VALUES (1)`);
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
    if (/^(re:|fw:)?\s*.+/i.test(first) && rest.length > 20) return { subject: first.replace(/^subject:\s*/i, '').trim(), body: rest };
  }
  return { subject: '', body: t };
}

export function normalizeNameDedupe(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\b(inc|llc|l\.l\.c\.|corp|corporation|company|co\.)\b\.?/gi, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .slice(0, 120);
}

export function insertAgentRun(runType = 'research') {
  const r = db
    .prepare(
      `INSERT INTO agent_runs (run_type, status, started_at, summary) VALUES (?, 'running', datetime('now'), '{}')`
    )
    .run(runType);
  return r.lastInsertRowid;
}

/** @deprecated alias */
export function insertBackgroundAgentRun() {
  return insertAgentRun('research');
}

export function completeAgentRun(id, status, summary, errorMessage = '') {
  const sum = { ...(summary || {}) };
  if (errorMessage) sum._errorMessage = errorMessage;
  db.prepare(`UPDATE agent_runs SET finished_at = datetime('now'), status = ?, summary = ? WHERE id = ?`).run(
    status,
    JSON.stringify(sum),
    id
  );
}

export function completeBackgroundAgentRun(id, status, summary, errorMessage = '') {
  completeAgentRun(id, status, summary, errorMessage);
}

export function listAgentRuns(limit = 20) {
  const lim = Math.min(Math.max(Number(limit) || 20, 1), 100);
  return db
    .prepare(`SELECT * FROM agent_runs ORDER BY id DESC LIMIT ?`)
    .all(lim)
    .map((row) => {
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

export function listBackgroundAgentRuns(limit) {
  return listAgentRuns(limit);
}

function safeJson(s, fallback) {
  try {
    return JSON.parse(s || '{}');
  } catch {
    return fallback;
  }
}

/** Replace any prior pending row for same vendor+field, then insert (latest research wins). */
export function upsertPendingVendorFieldUpdate({
  run_id: _run_id,
  vendor_id,
  field_name,
  proposed_value,
  source_url,
  source_title: _source_title,
  confidence_score,
}) {
  const v = getVendor(vendor_id);
  const oldVal = v ? String(v[field_name] || '') : '';
  db.prepare(
    `DELETE FROM pending_vendor_updates WHERE vendor_id = ? AND field_name = ? AND status = 'pending'`
  ).run(vendor_id, field_name);
  const r = db
    .prepare(
      `INSERT INTO pending_vendor_updates (vendor_id, field_name, old_value, new_value, source_url, confidence_score, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', datetime('now'))`
    )
    .run(
      vendor_id,
      field_name,
      oldVal,
      proposed_value || '',
      source_url || '',
      confidence_score != null ? Number(confidence_score) : null
    );
  return getPendingVendorFieldUpdate(r.lastInsertRowid);
}

export function listPendingVendorFieldUpdates({ status = 'pending' } = {}) {
  return db
    .prepare(
      `SELECT p.id, p.vendor_id, p.field_name, p.old_value, p.new_value, p.new_value AS proposed_value,
              p.source_url, p.confidence_score, p.status, p.created_at,
              v.name AS vendor_name
       FROM pending_vendor_updates p
       JOIN vendors v ON v.id = p.vendor_id
       WHERE p.status = ?
       ORDER BY p.created_at DESC`
    )
    .all(status);
}

export function getPendingVendorFieldUpdate(id) {
  const row = db
    .prepare(
      `SELECT p.id, p.vendor_id, p.field_name, p.old_value, p.new_value, p.new_value AS proposed_value,
              p.source_url, p.confidence_score, p.status, p.created_at,
              v.name AS vendor_name
       FROM pending_vendor_updates p
       JOIN vendors v ON v.id = p.vendor_id WHERE p.id = ?`
    )
    .get(id);
  return row || null;
}

export function setPendingVendorFieldStatus(id, status) {
  db.prepare(`UPDATE pending_vendor_updates SET status = ? WHERE id = ? AND status = 'pending'`).run(status, id);
  return getPendingVendorFieldUpdate(id);
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
    (s.tailored_email || '').trim() ||
    [draft?.subject, draft?.body].filter(Boolean).join('\n\n').trim();
  const reason = String(s.reason_qualified || '');
  const tenureBlock = reason.split('\n\n')[0] || '';
  return {
    ...s,
    tenure_evidence_summary: tenureBlock || s.online_notes || '',
    outreach_email_draft: outreach,
    evidence_urls: urlsFromReasonText(s.reason_qualified),
  };
}

export function insertPendingNewProspect(row) {
  const evidenceUrls = Array.isArray(row.evidence_urls)
    ? row.evidence_urls
    : safeJson(row.evidence_urls, []);
  const firstUrl =
    (evidenceUrls[0] && evidenceUrls[0].url) || row.website || row.source_url || '';
  const reasonParts = [row.tenure_evidence_summary, row.online_notes].filter(Boolean);
  for (const u of evidenceUrls.slice(0, 8)) {
    if (u?.url) reasonParts.push(`${u.title || 'Source'}: ${u.url}`);
  }
  const r = db
    .prepare(
      `INSERT INTO suggested_companies (
        name, category, phone, email, website, address, city, years_in_business, source_url,
        reason_qualified, confidence_score, tailored_email, dedupe_key, prospect_subtype, contact_person, online_notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
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
      row.outreach_email_draft || '',
      row.dedupe_key,
      row.prospect_subtype || '',
      row.contact_person || '',
      row.online_notes || ''
    );
  const sid = r.lastInsertRowid;
  const draftText = (row.outreach_email_draft || '').trim();
  if (draftText) {
    const { subject, body } = splitEmailSubjectBody(draftText);
    db.prepare(
      `INSERT INTO email_drafts (vendor_id, suggested_company_id, subject, body, status, created_at) VALUES (NULL, ?, ?, ?, 'draft', datetime('now'))`
    ).run(sid, subject, body);
  }
  return getPendingNewProspect(sid);
}

/** @param {{ status?: string }} opts — omit status or use 'all' for every row */
export function listSuggestedCompanies({ status } = {}) {
  let sql = `SELECT s.*, d.subject AS draft_subject, d.body AS draft_body, d.id AS draft_id
     FROM suggested_companies s
     LEFT JOIN email_drafts d ON d.id = (
       SELECT MAX(id) FROM email_drafts ed WHERE ed.suggested_company_id = s.id
     )
     WHERE 1=1`;
  const params = [];
  if (status != null && status !== '' && status !== 'all') {
    sql += ' AND s.status = ?';
    params.push(status);
  }
  sql += ' ORDER BY s.created_at DESC';
  const rows = db.prepare(sql).all(...params);
  return rows.map((row) => {
    const { draft_subject, draft_body, draft_id, ...s } = row;
    return mapSuggestedCompanyRow(s, { subject: draft_subject, body: draft_body });
  });
}

export function listPendingNewProspects({ status = 'pending' } = {}) {
  return listSuggestedCompanies({ status });
}

export function listEmailDrafts({ status, limit = 200 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 200, 1), 500);
  let sql = `SELECT d.*, s.name AS suggested_company_name, v.name AS vendor_name
    FROM email_drafts d
    LEFT JOIN suggested_companies s ON s.id = d.suggested_company_id
    LEFT JOIN vendors v ON v.id = d.vendor_id
    WHERE 1=1`;
  const params = [];
  if (status) {
    sql += ' AND d.status = ?';
    params.push(status);
  }
  sql += ' ORDER BY d.id DESC LIMIT ?';
  params.push(lim);
  return db.prepare(sql).all(...params);
}

export function getEmailDraft(id) {
  return db
    .prepare(
      `SELECT d.*, v.name AS vendor_name, v.category, v.email AS vendor_email, v.contact_person
       FROM email_drafts d
       LEFT JOIN vendors v ON v.id = d.vendor_id
       WHERE d.id = ?`
    )
    .get(id);
}

export function vendorHasPendingOutreachDraft(vendorId) {
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM email_drafts WHERE vendor_id = ? AND suggested_company_id IS NULL AND status IN ('draft','pending_kevin') LIMIT 1`
      )
      .get(vendorId)
  );
}

export function listEmailsReadyToSend() {
  return db
    .prepare(
      `SELECT d.*, v.name AS company_name, v.category, v.email AS vendor_email, v.contact_person,
        substr(COALESCE(d.subject,''), 1, 120) AS subject_preview
       FROM email_drafts d
       INNER JOIN vendors v ON v.id = d.vendor_id
       WHERE d.vendor_id IS NOT NULL
       AND (d.status = 'pending_kevin' OR d.status = 'draft')
       AND d.suggested_company_id IS NULL
       AND TRIM(COALESCE(d.body,'')) != ''
       AND TRIM(COALESCE(v.email,'')) != ''
       ORDER BY datetime(COALESCE(d.created_at, '1970-01-01')) DESC`
    )
    .all();
}

function collectContactGaps(v) {
  const missing = [];
  if (!(v.email || '').trim()) missing.push('email address');
  if (!(v.contact_person || '').trim()) missing.push('contact name');
  if (!(v.phone || '').trim()) missing.push('phone');
  return missing;
}

/** Vendors still missing contact info — for directed Serp “contact email” pass. */
export function listBlockedVendorIdsForAgent() {
  return db
    .prepare(
      `SELECT id FROM vendors
       WHERE status = 'not_sent'
       AND (
         TRIM(COALESCE(email,'')) = ''
         OR TRIM(COALESCE(contact_person,'')) = ''
         OR TRIM(COALESCE(phone,'')) = ''
       )
       ORDER BY id ASC`
    )
    .all()
    .map((r) => r.id);
}

export function listBlockedCompaniesForReport() {
  const rows = db
    .prepare(
      `SELECT * FROM vendors
       WHERE status = 'not_sent'
       AND (
         TRIM(COALESCE(email,'')) = ''
         OR TRIM(COALESCE(contact_person,'')) = ''
         OR TRIM(COALESCE(phone,'')) = ''
       )
       ORDER BY datetime(created_at) ASC`
    )
    .all();
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

export function listOpenIssuesForReport({ limit = 25 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const issues = [];
  const stuck = db
    .prepare(
      `SELECT id, name, category, agent_enrichment_status, research_miss_streak FROM vendors
       WHERE status = 'not_sent' AND COALESCE(research_miss_streak,0) >= 3
       LIMIT 10`
    )
    .all();
  for (const v of stuck) {
    issues.push({
      kind: 'enrichment_exhausted',
      vendor_id: v.id,
      title: `Research capped: ${v.name}`,
      detail: 'No new fields from Places/Serp after 3 attempts this week.',
    });
  }
  const prospects = db
    .prepare(
      `SELECT id, name, category FROM suggested_companies WHERE status = 'pending' ORDER BY id DESC LIMIT 8`
    )
    .all();
  for (const p of prospects) {
    issues.push({
      kind: 'prospect_confirm',
      suggested_company_id: p.id,
      title: `Confirm new company: ${p.name}`,
      detail: `Category: ${p.category}`,
    });
  }
  const failed = db
    .prepare(
      `SELECT d.*, v.name AS vendor_name FROM email_drafts d
       LEFT JOIN vendors v ON v.id = d.vendor_id
       WHERE d.status = 'failed' ORDER BY d.id DESC LIMIT 6`
    )
    .all();
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

export function getAgentReportSummary() {
  const totalCompanies = db.prepare(`SELECT COUNT(*) AS n FROM vendors`).get().n;
  const newCompaniesThisMonth = db
    .prepare(
      `SELECT COUNT(*) AS n FROM vendors
       WHERE strftime('%Y-%m', COALESCE(created_at, '')) = strftime('%Y-%m', 'now', 'localtime')`
    )
    .get().n;
  const emailsSentThisMonth = db
    .prepare(
      `SELECT COUNT(*) AS n FROM vendors WHERE date_sent IS NOT NULL
       AND strftime('%Y-%m', COALESCE(date_sent, '')) = strftime('%Y-%m', 'now', 'localtime')`
    )
    .get().n;
  const vendorApprovals = db.prepare(`SELECT COUNT(*) AS n FROM vendors WHERE status = 'approved'`).get().n;
  const companiesBlocked = db
    .prepare(
      `SELECT COUNT(*) AS n FROM vendors WHERE status = 'not_sent' AND (
        TRIM(COALESCE(email,'')) = ''
        OR TRIM(COALESCE(contact_person,'')) = ''
        OR TRIM(COALESCE(phone,'')) = ''
      )`
    )
    .get().n;
  const emailsAwaitingApproval = db
    .prepare(
      `SELECT COUNT(*) AS n FROM email_drafts d
       INNER JOIN vendors v ON v.id = d.vendor_id
       WHERE d.vendor_id IS NOT NULL
       AND (d.status = 'pending_kevin' OR d.status = 'draft')
       AND d.suggested_company_id IS NULL
       AND TRIM(COALESCE(d.body,'')) != ''
       AND TRIM(COALESCE(v.email,'')) != ''`
    )
    .get().n;
  return {
    totalCompanies,
    newCompaniesThisMonth,
    emailsSentThisMonth,
    vendorApprovals,
    companiesBlocked,
    emailsAwaitingApproval,
  };
}

export function upsertVendorOutreachDraft(vendorId, subject, body, { draft_type = 'outreach' } = {}) {
  db.prepare(
    `DELETE FROM email_drafts WHERE vendor_id = ? AND suggested_company_id IS NULL AND draft_type = ? AND status IN ('draft','pending_kevin')`
  ).run(vendorId, draft_type);
  const r = db
    .prepare(
      `INSERT INTO email_drafts (vendor_id, suggested_company_id, subject, body, status, draft_type, created_at)
       VALUES (?, NULL, ?, ?, 'draft', ?, datetime('now'))`
    )
    .run(vendorId, subject || '', body || '', draft_type);
  return db.prepare(`SELECT * FROM email_drafts WHERE id = ?`).get(r.lastInsertRowid);
}

export function finalizeEmailDraftSent(draftId, vendorId, { subject, body } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const next = addDaysIso(today, 30);
  db.prepare(
    `UPDATE email_drafts SET subject = COALESCE(?, subject), body = COALESCE(?, body), status = 'sent', sent_at = datetime('now') WHERE id = ?`
  ).run(subject || null, body || null, draftId);
  db.prepare(
    `UPDATE vendors SET status = 'sent', date_sent = ?, next_followup_date = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(today, next, vendorId);
  logAgentActivity({
    activity_type: 'email_sent',
    vendor_id: vendorId,
    summary: `Outreach email sent`,
    detail: { draftId, subject },
  });
  const v = getVendor(vendorId);
  if (v) {
    const sub = (subject || '').trim();
    if (sub) {
      const cur = db.prepare(`SELECT best_subject_line FROM agent_learning WHERE category = ?`).get(v.category);
      const parts = String(cur?.best_subject_line || '')
        .split('|')
        .map((s) => s.trim())
        .filter(Boolean);
      parts.push(sub);
      const next = parts.slice(-6).join(' | ');
      db.prepare(`UPDATE agent_learning SET best_subject_line = ? WHERE category = ?`).run(next, v.category);
    }
    refreshAgentLearningForCategory(v.category);
  }
  return v;
}

export function finalizeFollowupEmailSent(draftId, vendorId, { subject, body } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const next = addDaysIso(today, 30);
  db.prepare(
    `UPDATE email_drafts SET subject = COALESCE(?, subject), body = COALESCE(?, body), status = 'sent', sent_at = datetime('now'), draft_type = 'follow_up' WHERE id = ?`
  ).run(subject || null, body || null, draftId);
  const v0 = getVendor(vendorId);
  const note = `[${today}] Follow-up email sent via CRM (draft #${draftId}).`;
  const newNotes = v0?.notes ? `${v0.notes}\n${note}` : note;
  db.prepare(
    `UPDATE vendors SET next_followup_date = ?, notes = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(next, newNotes, vendorId);
  logAgentActivity({
    activity_type: 'followup_email_sent',
    vendor_id: vendorId,
    summary: 'Follow-up email sent',
    detail: { draftId, subject },
  });
  const v = getVendor(vendorId);
  if (v) refreshAgentLearningForCategory(v.category);
  return v;
}

export function markEmailDraftFailed(draftId, errMsg = '') {
  db.prepare(`UPDATE email_drafts SET status = 'failed', bounced_at = datetime('now') WHERE id = ?`).run(draftId);
  logAgentActivity({
    activity_type: 'email_failed',
    summary: errMsg || 'SMTP send failed',
    detail: { draftId },
  });
}

export function vendorsAddedSince(isoDate) {
  return db
    .prepare(`SELECT * FROM vendors WHERE datetime(created_at) >= datetime(?) ORDER BY id DESC LIMIT 50`)
    .all(isoDate);
}

export function getPendingNewProspect(id) {
  const s = db.prepare(`SELECT * FROM suggested_companies WHERE id = ?`).get(id);
  if (!s) return null;
  const draft = db
    .prepare(
      `SELECT * FROM email_drafts WHERE suggested_company_id = ? AND status = 'draft' ORDER BY id DESC LIMIT 1`
    )
    .get(id);
  return mapSuggestedCompanyRow(s, draft);
}

export function setPendingNewProspectStatus(id, status) {
  db.prepare(`UPDATE suggested_companies SET status = ? WHERE id = ? AND status = 'pending'`).run(status, id);
  db.prepare(`UPDATE email_drafts SET status = ? WHERE suggested_company_id = ? AND status = 'draft'`).run(
    status === 'rejected' ? 'void' : 'used',
    id
  );
  return getPendingNewProspect(id);
}

export function vendorNameExistsLoose(name) {
  const n = normalizeNameDedupe(name);
  if (!n) return false;
  const rows = db.prepare(`SELECT id, name FROM vendors`).all();
  for (const r of rows) {
    if (normalizeNameDedupe(r.name) === n) return true;
  }
  return false;
}

export function pendingProspectDedupeExists(dedupeKey) {
  const ex = db
    .prepare(`SELECT id FROM suggested_companies WHERE dedupe_key = ? AND status = 'pending'`)
    .get(dedupeKey);
  return Boolean(ex);
}

export function insertVendor({
  name,
  contact_person = '',
  email = '',
  phone = '',
  category,
  notes = '',
  website = '',
  years_in_business = '',
  address = '',
}) {
  const r = db
    .prepare(
      `INSERT INTO vendors (
        name, contact_person, email, phone, category, status,
        date_sent, next_followup_date, notes, letter_version_used,
        website, years_in_business, address, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'not_sent', NULL, NULL, ?, '', ?, ?, ?, datetime('now'), datetime('now'))`
    )
    .run(
      name,
      contact_person || '',
      email || '',
      phone || '',
      category,
      notes || '',
      website || '',
      years_in_business || '',
      address || ''
    );
  return getVendor(r.lastInsertRowid);
}

const PENDING_VENDOR_FIELDS = new Set([
  'phone',
  'email',
  'website',
  'address',
  'contact_person',
  'years_in_business',
]);

/** Apply a single research field directly to the vendor (no approval queue). */
export function applyVendorFieldIfEmpty(vendorId, field_name, proposed_value, meta = {}) {
  const v = getVendor(vendorId);
  if (!v || !PENDING_VENDOR_FIELDS.has(field_name)) return false;
  if ((v[field_name] || '').trim()) return false;
  const val = String(proposed_value || '').trim();
  if (!val) return false;
  updateVendor(vendorId, { [field_name]: val });
  logAgentActivity({
    activity_type: 'auto_fill',
    vendor_id: vendorId,
    summary: `Filled ${field_name}`,
    detail: meta || {},
  });
  return true;
}

export function approvePendingVendorFieldUpdate(id) {
  const row = getPendingVendorFieldUpdate(id);
  if (!row || row.status !== 'pending') return { error: 'Not found or already reviewed' };
  if (!PENDING_VENDOR_FIELDS.has(row.field_name)) return { error: 'Invalid field' };
  const v = getVendor(row.vendor_id);
  const cur = String(v[row.field_name] || '').trim();
  if (cur) {
    return {
      error:
        'That field already has a value in the tracker. Reject this suggestion or update the vendor manually.',
      conflict: true,
    };
  }
  updateVendor(row.vendor_id, { [row.field_name]: row.new_value ?? row.proposed_value });
  setPendingVendorFieldStatus(id, 'approved');
  return { ok: true, vendor: getVendor(row.vendor_id) };
}

export function rejectPendingVendorFieldUpdate(id) {
  const row = getPendingVendorFieldUpdate(id);
  if (!row || row.status !== 'pending') return { error: 'Not found or already reviewed' };
  setPendingVendorFieldStatus(id, 'rejected');
  return { ok: true };
}

export function approvePendingNewProspect(id) {
  const row = getPendingNewProspect(id);
  if (!row || row.status !== 'pending') return { error: 'Not found or already reviewed' };
  if (vendorNameExistsLoose(row.name)) {
    setPendingNewProspectStatus(id, 'rejected');
    return { error: 'A vendor with a similar name already exists in the tracker.' };
  }
  const noteParts = [row.online_notes, row.reason_qualified, row.tenure_evidence_summary].filter(Boolean);
  if (row.prospect_subtype) noteParts.push(`Research focus: ${row.prospect_subtype}`);
  insertVendor({
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
  setPendingNewProspectStatus(id, 'approved');
  return { ok: true };
}

export function rejectPendingNewProspect(id) {
  const row = getPendingNewProspect(id);
  if (!row || row.status !== 'pending') return { error: 'Not found or already reviewed' };
  setPendingNewProspectStatus(id, 'rejected');
  return { ok: true };
}
