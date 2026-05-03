/**
 * When PostgreSQL has no vendors, import from local vendor_tracker.db (if present).
 */
import fs from 'fs';
import Database from 'better-sqlite3';
import { DB_PATH } from './paths.js';

const TRUNCATE_SQL = `
TRUNCATE TABLE
  email_drafts,
  suggested_companies,
  pending_vendor_updates,
  agent_activity,
  agent_runs,
  followup_logs,
  agent_tasks,
  vendors,
  agent_learning
RESTART IDENTITY CASCADE;
`;

/** FK-safe insert order */
const COPY_ORDER = [
  'agent_learning',
  'vendors',
  'followup_logs',
  'agent_tasks',
  'agent_activity',
  'agent_runs',
  'pending_vendor_updates',
  'suggested_companies',
  'email_drafts',
];

function placeholders(n) {
  return Array.from({ length: n }, (_, i) => `$${i + 1}`).join(', ');
}

async function pgColumns(pool, table) {
  const { rows } = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
    [table]
  );
  return new Set(rows.map((r) => r.column_name));
}

export async function migrateSqliteToPostgres(pool) {
  if (!fs.existsSync(DB_PATH)) {
    console.log('[migrate] No SQLite file at', DB_PATH, '— skip.');
    return false;
  }
  const { rows: c } = await pool.query('SELECT COUNT(*)::int AS n FROM vendors');
  if ((c[0]?.n || 0) > 0) {
    console.log('[migrate] PostgreSQL already has vendors — skip SQLite import.');
    return false;
  }

  const sqlite = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  try {
    await pool.query(TRUNCATE_SQL);

    for (const table of COPY_ORDER) {
      const ex = sqlite.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(table);
      if (!ex) continue;
      const pragma = sqlite.prepare(`PRAGMA table_info(${table})`).all();
      if (!pragma.length) continue;
      const pgCols = await pgColumns(pool, table);
      const names = pragma.map((p) => p.name).filter((n) => pgCols.has(n));
      if (!names.length) continue;
      const rows = sqlite.prepare(`SELECT * FROM ${table}`).all();
      if (!rows.length) continue;
      const insertSql = `INSERT INTO ${table} (${names.join(', ')}) VALUES (${placeholders(names.length)})`;
      for (const row of rows) {
        const vals = names.map((n) => row[n] ?? null);
        await pool.query(insertSql, vals);
      }
      console.log(`[migrate] Imported ${rows.length} rows → ${table}`);
    }

    await pool.query(
      `SELECT setval(pg_get_serial_sequence('vendors', 'id'), COALESCE((SELECT MAX(id) FROM vendors), 1))`
    );
    for (const t of [
      'followup_logs',
      'agent_tasks',
      'agent_activity',
      'agent_runs',
      'pending_vendor_updates',
      'suggested_companies',
      'email_drafts',
    ]) {
      try {
        await pool.query(
          `SELECT setval(pg_get_serial_sequence('${t}', 'id'), COALESCE((SELECT MAX(id) FROM ${t}), 1))`
        );
      } catch {
        /* ignore */
      }
    }
    console.log('[migrate] SQLite → PostgreSQL import finished.');
    return true;
  } finally {
    sqlite.close();
  }
}
