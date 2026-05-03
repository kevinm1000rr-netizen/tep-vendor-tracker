import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Project root (parent of /server) */
export const ROOT = path.resolve(__dirname, '..');

export const DB_PATH = path.join(ROOT, 'vendor_tracker.db');

export const CONFIG_PATH = path.join(ROOT, '.tep-config.json');
