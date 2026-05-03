/** Full DDL for PostgreSQL (parity with migrated SQLite schema). */
export const PG_SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS vendors (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  contact_person TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL CHECK (category IN ('restoration','property_mgmt','hoa','contractor')),
  status TEXT NOT NULL DEFAULT 'not_sent' CHECK (status IN ('not_sent','sent','responded','approved')),
  date_sent TEXT,
  next_followup_date TEXT,
  notes TEXT NOT NULL DEFAULT '',
  letter_version_used TEXT NOT NULL DEFAULT '',
  website TEXT NOT NULL DEFAULT '',
  years_in_business TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  updated_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  agent_enrichment_status TEXT NOT NULL DEFAULT 'searching',
  research_miss_streak INTEGER NOT NULL DEFAULT 0,
  research_week_id TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_vendors_category ON vendors(category);
CREATE INDEX IF NOT EXISTS idx_vendors_status ON vendors(status);

CREATE TABLE IF NOT EXISTS followup_logs (
  id SERIAL PRIMARY KEY,
  vendor_id INTEGER NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  logged_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_followup_vendor ON followup_logs(vendor_id);

CREATE TABLE IF NOT EXISTS agent_tasks (
  id SERIAL PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  vendor_id INTEGER REFERENCES vendors(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  priority TEXT NOT NULL CHECK (priority IN ('high','medium','low')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','skipped')),
  due_date TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  ai_recommendation TEXT NOT NULL DEFAULT '',
  approved_by_kevin INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_status ON agent_tasks(status);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_vendor ON agent_tasks(vendor_id);

CREATE TABLE IF NOT EXISTS agent_runs (
  id SERIAL PRIMARY KEY,
  run_type TEXT,
  status TEXT,
  started_at TEXT,
  finished_at TEXT,
  summary TEXT
);

CREATE TABLE IF NOT EXISTS pending_vendor_updates (
  id SERIAL PRIMARY KEY,
  vendor_id INTEGER NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  field_name TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  source_url TEXT,
  confidence_score DOUBLE PRECISION,
  status TEXT DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);
CREATE INDEX IF NOT EXISTS idx_pending_vendor_updates_vendor ON pending_vendor_updates(vendor_id);
CREATE INDEX IF NOT EXISTS idx_pending_vendor_updates_status ON pending_vendor_updates(status);

CREATE TABLE IF NOT EXISTS suggested_companies (
  id SERIAL PRIMARY KEY,
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
  confidence_score DOUBLE PRECISION,
  tailored_email TEXT,
  status TEXT DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  dedupe_key TEXT,
  prospect_subtype TEXT NOT NULL DEFAULT '',
  contact_person TEXT NOT NULL DEFAULT '',
  online_notes TEXT NOT NULL DEFAULT '',
  attempt_count INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_suggested_companies_dedupe
  ON suggested_companies(dedupe_key) WHERE dedupe_key IS NOT NULL AND dedupe_key <> '';
CREATE INDEX IF NOT EXISTS idx_suggested_companies_status ON suggested_companies(status);

CREATE TABLE IF NOT EXISTS email_drafts (
  id SERIAL PRIMARY KEY,
  vendor_id INTEGER REFERENCES vendors(id) ON DELETE SET NULL,
  suggested_company_id INTEGER REFERENCES suggested_companies(id) ON DELETE CASCADE,
  subject TEXT,
  body TEXT,
  status TEXT DEFAULT 'draft',
  created_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  draft_type TEXT NOT NULL DEFAULT 'outreach',
  sent_at TEXT,
  opened_at TEXT,
  bounced_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_email_drafts_suggested ON email_drafts(suggested_company_id);

CREATE TABLE IF NOT EXISTS agent_learning (
  category TEXT PRIMARY KEY CHECK (category IN ('restoration','property_mgmt','hoa','contractor')),
  response_rate DOUBLE PRECISION NOT NULL DEFAULT 0,
  best_day_to_send TEXT NOT NULL DEFAULT '',
  best_subject_line TEXT NOT NULL DEFAULT '',
  avg_days_to_response INTEGER NOT NULL DEFAULT 0,
  sent_count INTEGER NOT NULL DEFAULT 0,
  responded_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);

CREATE TABLE IF NOT EXISTS agent_activity (
  id SERIAL PRIMARY KEY,
  activity_type TEXT NOT NULL,
  vendor_id INTEGER REFERENCES vendors(id) ON DELETE SET NULL,
  summary TEXT NOT NULL DEFAULT '',
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);
CREATE INDEX IF NOT EXISTS idx_agent_activity_at ON agent_activity(created_at);

CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
