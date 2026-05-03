import fs from 'fs';
import dotenv from 'dotenv';
import { CONFIG_PATH } from './paths.js';

dotenv.config();

function readFileConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

/** Env wins over local config file */
export function getApiKey() {
  const fromEnv = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (fromEnv) return fromEnv;
  const file = readFileConfig();
  return (file.anthropicApiKey || '').trim();
}

export function saveApiKey(key) {
  const data = readFileConfig();
  data.anthropicApiKey = key;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), 'utf8');
}

/** Env wins over `.tep-config.json` (reserved for future Places / SerpAPI enrichment). */
export function getGooglePlacesApiKey() {
  const fromEnv = (process.env.GOOGLE_PLACES_API_KEY || '').trim();
  if (fromEnv) return fromEnv;
  return (readFileConfig().googlePlacesApiKey || '').trim();
}

export function getSerpApiKey() {
  const fromEnv = (process.env.SERPAPI_API_KEY || '').trim();
  if (fromEnv) return fromEnv;
  return (readFileConfig().serpApiKey || '').trim();
}

function writeFileConfig(data) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), 'utf8');
}

export function saveGooglePlacesApiKey(key) {
  const data = readFileConfig();
  const v = (key || '').trim();
  if (v) data.googlePlacesApiKey = v;
  else delete data.googlePlacesApiKey;
  writeFileConfig(data);
}

export function saveSerpApiKey(key) {
  const data = readFileConfig();
  const v = (key || '').trim();
  if (v) data.serpApiKey = v;
  else delete data.serpApiKey;
  writeFileConfig(data);
}

export function getModel() {
  return (
    process.env.ANTHROPIC_MODEL?.trim() ||
    readFileConfig().anthropicModel?.trim() ||
    'claude-sonnet-4-6'
  );
}

/**
 * Whether to register the scheduled Research & Outreach agent (daily cron).
 * True when unset (backward compatible). Set AGENT_AUTO_RUN=false or 0 to disable.
 */
export function getAgentAutoRun() {
  const v = (process.env.AGENT_AUTO_RUN ?? '').trim().toLowerCase();
  if (!v) return true;
  if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

export function maskKey(key) {
  if (!key || key.length < 8) return '';
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/** All app-sent mail uses this From address (GoDaddy mailbox). */
export const OUTBOUND_FROM_EMAIL = 'kevin@triexpressplumbing.com';

/** GoDaddy / secureserver default outgoing relay */
const DEFAULT_SMTP_HOST = 'smtpout.secureserver.net';
const DEFAULT_SMTP_PORT = 465;

/** SMTP: env wins over `.tep-config.json` */
export function getSmtpHost() {
  return (process.env.SMTP_HOST || readFileConfig().smtpHost || DEFAULT_SMTP_HOST).trim();
}

export function getSmtpPort() {
  const p = Number(process.env.SMTP_PORT || readFileConfig().smtpPort || DEFAULT_SMTP_PORT);
  return Number.isFinite(p) && p > 0 ? p : DEFAULT_SMTP_PORT;
}

export function getSmtpUser() {
  return (process.env.SMTP_USER || readFileConfig().smtpUser || '').trim();
}

export function getSmtpPass() {
  return (process.env.SMTP_PASS || readFileConfig().smtpPass || '').trim();
}

export function getSmtpFromName() {
  return (
    (process.env.SMTP_FROM_NAME || readFileConfig().smtpFromName || 'Kevin | Tri Express Plumbing').trim()
  );
}

/** Envelope From / Reply identity for Nodemailer — always Tri Express Kevin address. */
export function getKevinFromEmail() {
  return OUTBOUND_FROM_EMAIL;
}

export function isSmtpConfigured() {
  return Boolean(getSmtpHost() && getSmtpUser() && getSmtpPass() && getKevinFromEmail());
}

export function getSmtpPassMasked() {
  const p = getSmtpPass();
  return p ? maskKey(p) : '';
}

export function saveSmtpSettings({ smtpHost, smtpPort, smtpUser, smtpPass, smtpFromName, smtpFromEmail }) {
  const data = readFileConfig();
  if (smtpHost !== undefined) {
    const h = String(smtpHost || '').trim();
    if (h) data.smtpHost = h;
    else delete data.smtpHost;
  }
  if (smtpPort !== undefined) {
    const n = Number(smtpPort);
    if (Number.isFinite(n) && n > 0) data.smtpPort = n;
    else delete data.smtpPort;
  }
  if (smtpUser !== undefined) {
    const u = String(smtpUser || '').trim();
    if (u) data.smtpUser = u;
    else delete data.smtpUser;
  }
  if (smtpPass !== undefined) {
    const p = String(smtpPass || '').trim();
    if (p) data.smtpPass = p;
    else delete data.smtpPass;
  }
  if (smtpFromName !== undefined) {
    const f = String(smtpFromName || '').trim();
    if (f) data.smtpFromName = f;
    else delete data.smtpFromName;
  }
  if (smtpFromEmail !== undefined) {
    const e = String(smtpFromEmail || '').trim();
    if (e) data.smtpFromEmail = e;
    else delete data.smtpFromEmail;
  }
  writeFileConfig(data);
}
