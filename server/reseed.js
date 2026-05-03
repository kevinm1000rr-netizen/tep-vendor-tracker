/**
 * Deletes vendor_tracker.db so the next server start seeds a fresh database.
 * Run: node server/reseed.js
 */
import fs from 'fs';
import path from 'path';
import { DB_PATH } from './paths.js';

const dir = path.dirname(DB_PATH);
const extra = [path.join(dir, 'vendor_tracker.db-shm'), path.join(dir, 'vendor_tracker.db-wal')];
if (fs.existsSync(DB_PATH)) {
  fs.unlinkSync(DB_PATH);
  console.log('Removed', DB_PATH);
} else {
  console.log('No existing DB at', DB_PATH);
}
for (const p of extra) {
  if (fs.existsSync(p)) {
    fs.unlinkSync(p);
    console.log('Removed', p);
  }
}
console.log('Start the app again to create a new DB with the current seed list.');
