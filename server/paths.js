import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Project root (parent of /server) */
export const ROOT = path.resolve(__dirname, '..');

/**
 * SQLite file path. Override with `SQLITE_DB_PATH` for Railway (mount a volume at e.g.
 * `/data` and set `SQLITE_DB_PATH=/data/vendor_tracker.db` so the DB survives redeploys).
 * Relative paths are resolved under `ROOT`.
 */
function resolveSqliteDbPath() {
  const raw = (process.env.SQLITE_DB_PATH || '').trim();
  if (!raw) return path.join(ROOT, 'vendor_tracker.db');
  return path.isAbsolute(raw) ? raw : path.join(ROOT, raw);
}

export const DB_PATH = resolveSqliteDbPath();
