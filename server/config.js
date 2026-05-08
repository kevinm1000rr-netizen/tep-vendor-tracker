import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { ROOT } from './paths.js';

// Project-root `.env` first (works when cwd is not the repo), then cwd `.env`. Host env wins (dotenv default).
dotenv.config({ path: path.join(ROOT, '.env') });
dotenv.config();

function getConfigPath() {
  const o = (process.env.TEP_CONFIG_PATH || '').trim();
  if (o) return path.isAbsolute(o) ? o : path.join(ROOT, o);
  return path.join(ROOT, '.tep-config.json');
}

function readFileConfig() {
  try {
    return JSON.parse(fs.readFileSync(getConfigPath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeFileConfig(data) {
  fs.writeFileSync(getConfigPath(), JSON.stringify(data, null, 2), 'utf8');
}

function pickAnthropicFromFile(file) {
  if (!file || typeof file !== 'object') return '';
  const v =
    file.anthropicApiKey ?? file.ANTHROPIC_API_KEY ?? file.anthropic_api_key ?? file.ANTHROPIC_KEY ?? '';
  return String(v).trim();
}

function pickSerpFromFile(file) {
  if (!file || typeof file !== 'object') return '';
  const v =
    file.serpApiKey ??
    file.SERPAPI_API_KEY ??
    file.serpapi_api_key ??
    file.serpapiKey ??
    file.SERP_API_KEY ??
    '';
  return String(v).trim();
}

function pickGooglePlacesFromFile(file) {
  if (!file || typeof file !== 'object') return '';
  const v =
    file.googlePlacesApiKey ?? file.GOOGLE_PLACES_API_KEY ?? file.google_places_api_key ?? '';
  return String(v).trim();
}

/** @returns {boolean} Whether the resolved config file exists on disk */
export function isTepConfigFilePresent() {
  try {
    fs.accessSync(getConfigPath(), fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** Env wins over local config file */
export function getApiKey() {
  const fromEnv = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (fromEnv) return fromEnv;
  return pickAnthropicFromFile(readFileConfig());
}

export function saveApiKey(key) {
  const data = readFileConfig();
  data.anthropicApiKey = key;
  writeFileConfig(data);
}

/** Env wins over `.tep-config.json`. Discovery uses Text Search + Details with this key (`GOOGLE_PLACES_API_KEY`). */
export function getGooglePlacesApiKey() {
  const fromEnv = (process.env.GOOGLE_PLACES_API_KEY || '').trim();
  if (fromEnv) return fromEnv;
  return pickGooglePlacesFromFile(readFileConfig());
}

export function getSerpApiKey() {
  const fromEnv = (
    process.env.SERPAPI_API_KEY ||
    process.env.SERPAPI_KEY ||
    process.env.SERP_API_KEY ||
    ''
  )
    .trim();
  if (fromEnv) return fromEnv;
  return pickSerpFromFile(readFileConfig());
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
  const file = readFileConfig();
  return (
    process.env.ANTHROPIC_MODEL?.trim() ||
    file.anthropicModel?.trim() ||
    file.ANTHROPIC_MODEL?.trim() ||
    'claude-sonnet-4-5'
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

/**
 * Live agent: repeat enrich + discovery + drafts on a timer (minutes).
 * Set LIVE_AGENT_INTERVAL_MINUTES=30 (5–180). If unset, LIVE_AGENT_MODE=true defaults to 30.
 * 0 or off = no interval (only daily cron when AGENT_AUTO_RUN is true).
 */
export function getLiveAgentIntervalMinutes() {
  const raw = (process.env.LIVE_AGENT_INTERVAL_MINUTES ?? '').trim();
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.min(Math.max(n, 5), 180);
    return 0;
  }
  const flag = (process.env.LIVE_AGENT_MODE ?? '').trim().toLowerCase();
  if (flag === 'true' || flag === '1' || flag === 'on' || flag === 'yes') return 30;
  return 0;
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

function pickTwilioSidFromFile(file) {
  if (!file || typeof file !== 'object') return '';
  return String(file.twilioSid ?? file.TWILIO_ACCOUNT_SID ?? '').trim();
}

function pickTwilioTokenFromFile(file) {
  if (!file || typeof file !== 'object') return '';
  return String(file.twilioAuthToken ?? file.TWILIO_AUTH_TOKEN ?? '').trim();
}

function pickTwilioFromPhoneFromFile(file) {
  if (!file || typeof file !== 'object') return '';
  return String(file.twilioFromPhone ?? file.TWILIO_FROM_PHONE ?? '').trim();
}

function pickAlertPhoneFromFile(file) {
  if (!file || typeof file !== 'object') return '';
  return String(file.alertPhone ?? file.ALERT_PHONE ?? '').trim();
}

export function getTwilioAccountSid() {
  const fromEnv = (process.env.TWILIO_ACCOUNT_SID || '').trim();
  if (fromEnv) return fromEnv;
  return pickTwilioSidFromFile(readFileConfig());
}

export function getTwilioAuthToken() {
  const fromEnv = (process.env.TWILIO_AUTH_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  return pickTwilioTokenFromFile(readFileConfig());
}

export function getTwilioFromPhone() {
  const fromEnv = (process.env.TWILIO_FROM_NUMBER || process.env.TWILIO_FROM_PHONE || '').trim();
  if (fromEnv) return fromEnv;
  return pickTwilioFromPhoneFromFile(readFileConfig());
}

export function getTwilioFromNumber() {
  return getTwilioFromPhone();
}

/**
 * Twilio Messaging Service SID (starts with `MG…`). Required when sending from a 10DLC
 * pool or while A2P registration is still pending — Twilio will use the service's sender
 * pool instead of a single FROM number, which avoids error 30034 (unregistered number).
 */
export function getTwilioMessagingServiceSid() {
  const fromEnv = (process.env.TWILIO_MESSAGING_SERVICE_SID || '').trim();
  if (fromEnv) return fromEnv;
  const cfg = readFileConfig();
  return (cfg.twilioMessagingServiceSid || '').trim();
}

export function getAlertPhone() {
  const fromEnv = (process.env.ALERT_PHONE || '').trim();
  if (fromEnv) return fromEnv;
  return pickAlertPhoneFromFile(readFileConfig());
}

/** Accela Construct API (developer.accela.com) — OAuth client credentials, shared across agencies the app is provisioned for. */
export function getAccelaClientId() {
  return (process.env.ACCELA_CLIENT_ID || readFileConfig().accelaClientId || '').trim();
}

export function getAccelaClientSecret() {
  return (process.env.ACCELA_CLIENT_SECRET || readFileConfig().accelaClientSecret || '').trim();
}

/** e.g. PRODUCTION or SUPPLIER (per Accela app registration). */
export function getAccelaEnvironment() {
  return (
    process.env.ACCELA_ENVIRONMENT?.trim() ||
    readFileConfig().accelaEnvironment?.trim() ||
    'PRODUCTION'
  );
}

export function isAccelaApiConfigured() {
  return Boolean(getAccelaClientId() && getAccelaClientSecret());
}

/** SMS destination for AI estimate lead alerts (E.164). Defaults to Tri Express business line. */
export function getEstimateSmsTo() {
  return (process.env.ESTIMATE_SMS_TO || '+16198436692').trim();
}

/** CRM URL shown in owner notifications. Override with CRM_LEADS_URL (e.g. https://your-app.up.railway.app/permits). */
export function getCrmLeadsUrl() {
  return (process.env.CRM_LEADS_URL || 'http://localhost:5173/permits').trim();
}

/**
 * Minimum permit lead score (1–10) we keep in the pipeline. Anything below is rejected
 * by the permit agent on ingest and any existing rows below this threshold are purged at
 * startup. Override with `PERMIT_LEAD_MIN_SCORE` (e.g. `5` to be more permissive). Default 7.
 */
export const DEFAULT_PERMIT_LEAD_MIN_SCORE = 7;
export function getPermitLeadMinScore() {
  const raw = Number(process.env.PERMIT_LEAD_MIN_SCORE);
  if (!Number.isFinite(raw)) return DEFAULT_PERMIT_LEAD_MIN_SCORE;
  return Math.max(1, Math.min(10, Math.round(raw)));
}
