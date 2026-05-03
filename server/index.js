import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import {
  initDatabase,
  listVendors,
  getVendor,
  updateVendor,
  markSent,
  logFollowup,
  getStats,
  listOverdue,
  exportVendorsCsvRows,
  listFollowupLogs,
  runAgent,
  listAgentTasks,
  getTodaysPriorityActions,
  getAgentTask,
  updateAgentTask,
  listAwaitingApproval,
  listBackgroundAgentRuns,
  listPendingVendorFieldUpdates,
  listPendingNewProspects,
  approvePendingVendorFieldUpdate,
  rejectPendingVendorFieldUpdate,
  approvePendingNewProspect,
  rejectPendingNewProspect,
  listSuggestedCompanies,
  listEmailDrafts,
  getAgentReportSummary,
  listEmailsReadyToSend,
  listBlockedCompaniesForReport,
  listOpenIssuesForReport,
  getEmailDraft,
  finalizeEmailDraftSent,
  finalizeFollowupEmailSent,
  markEmailDraftFailed,
  listAgentActivity,
  vendorsAddedSince,
} from './db.js';
import {
  getApiKey,
  saveApiKey,
  getModel,
  maskKey,
  getGooglePlacesApiKey,
  getSerpApiKey,
  saveGooglePlacesApiKey,
  saveSerpApiKey,
  getAgentAutoRun,
  isSmtpConfigured,
  getSmtpHost,
  getSmtpPort,
  getSmtpUser,
  getSmtpFromName,
  saveSmtpSettings,
  getSmtpPassMasked,
  OUTBOUND_FROM_EMAIL,
} from './config.js';
import {
  generateVendorLetter,
  generateFollowUpEmail,
  generateCallScript,
  monthlyStrategicReview,
  generateTaskRecommendation,
  suggestNewVendors,
} from './ai.js';
import { ROOT } from './paths.js';
import { runResearchAgent, runResearchAndOutreachAgent, startResearchAgentScheduler } from './researchAgent.js';
import { sendTransactionalEmail } from './mailer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(ROOT, 'dist');

initDatabase();

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const PORT = Number(process.env.PORT || 3000);

function snapshotForAi() {
  const vendors = listVendors();
  const stats = getStats();
  const alerts = listOverdue();
  const byCat = {};
  for (const row of stats.byCategory) {
    const cat = row.category;
    const vs = vendors.filter((v) => v.category === cat);
    const touched = vs.filter((v) => v.status !== 'not_sent').length;
    const wins = vs.filter((v) => v.status === 'responded' || v.status === 'approved').length;
    byCat[cat] = {
      total: vs.length,
      outreachStarted: touched,
      responsesOrApproved: wins,
      winRate:
        touched > 0 ? Math.round((wins / touched) * 1000) / 10 : null,
    };
  }
  return {
    generatedAt: new Date().toISOString(),
    stats,
    overdueFollowups: alerts,
    vendors,
    categorySummary: byCat,
  };
}

function csvEscape(val) {
  if (val == null) return '';
  const s = String(val);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/vendors', (req, res) => {
  const { category, status } = req.query;
  res.json(listVendors({ category, status }));
});

app.get('/api/vendors/:id', (req, res) => {
  const v = getVendor(Number(req.params.id));
  if (!v) return res.status(404).json({ error: 'Not found' });
  res.json(v);
});

app.patch('/api/vendors/:id', (req, res) => {
  const id = Number(req.params.id);
  const v = updateVendor(id, req.body);
  if (!v) return res.status(404).json({ error: 'Not found' });
  res.json(v);
});

app.post('/api/vendors/:id/mark-sent', (req, res) => {
  const id = Number(req.params.id);
  const v = markSent(id, { letter_version_used: req.body?.letter_version_used });
  if (!v) return res.status(404).json({ error: 'Not found' });
  res.json(v);
});

app.post('/api/vendors/:id/log-followup', (req, res) => {
  const id = Number(req.params.id);
  const v = logFollowup(id, req.body?.note || '');
  if (!v) return res.status(404).json({ error: 'Not found' });
  res.json(v);
});

app.get('/api/stats', (_req, res) => {
  res.json(getStats());
});

app.get('/api/alerts', (_req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const rows = listOverdue().map((v) => {
    const d = v.daysUntilFollowup;
    let level = 'ok';
    if (d < -30) level = 'critical';
    else if ((d >= -30 && d < 0) || (d >= 0 && d <= 7)) level = 'warn';
    return { ...v, alertLevel: level, today };
  });
  res.json(rows);
});

app.get('/api/followup-logs/:vendorId', (req, res) => {
  res.json(listFollowupLogs(Number(req.params.vendorId)));
});

app.post('/api/agent-tasks/run', (_req, res) => {
  try {
    const summary = runAgent();
    res.json(summary);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Run agent failed' });
  }
});

app.get('/api/agent-tasks', (req, res) => {
  const { status } = req.query;
  res.json(listAgentTasks({ status: status || undefined }));
});

app.get('/api/agent-tasks/today-priority', (req, res) => {
  const limit = req.query.limit ? Number(req.query.limit) : 12;
  res.json(getTodaysPriorityActions(limit));
});

app.get('/api/agent-tasks/awaiting-approval', (req, res) => {
  const limit = req.query.limit ? Number(req.query.limit) : 20;
  res.json(listAwaitingApproval(limit));
});

app.patch('/api/agent-tasks/:id', (req, res) => {
  const id = Number(req.params.id);
  const task = getAgentTask(id);
  if (!task) return res.status(404).json({ error: 'Not found' });
  const body = req.body || {};
  const { status, ai_recommendation } = body;
  const patch = {};
  if (status === 'pending' || status === 'done' || status === 'skipped') patch.status = status;
  if (ai_recommendation !== undefined) patch.ai_recommendation = ai_recommendation;
  if ('approved_by_kevin' in body) patch.approved_by_kevin = Boolean(body.approved_by_kevin);
  const updated = updateAgentTask(id, patch);
  res.json(updated);
});

app.post('/api/agent-tasks/:id/recommendation', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const task = getAgentTask(id);
    if (!task) return res.status(404).json({ error: 'Not found' });
    const vendor = task.vendor_id ? getVendor(task.vendor_id) : null;
    const text = await generateTaskRecommendation(task, vendor);
    const updated = updateAgentTask(id, { ai_recommendation: text });
    res.json({ task: updated, text });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'AI error' });
  }
});

app.post('/api/ai/letter/:id', async (req, res) => {
  try {
    const v = getVendor(Number(req.params.id));
    if (!v) return res.status(404).json({ error: 'Not found' });
    const text = await generateVendorLetter(v);
    res.json({ text });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'AI error' });
  }
});

app.post('/api/ai/follow-up/:id', async (req, res) => {
  try {
    const v = getVendor(Number(req.params.id));
    if (!v) return res.status(404).json({ error: 'Not found' });
    let days = 0;
    if (v.date_sent) {
      const a = new Date(v.date_sent + 'T12:00:00Z');
      const b = new Date();
      days = Math.max(0, Math.round((b - a) / 86400000));
    }
    const text = await generateFollowUpEmail(v, days);
    res.json({ text });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'AI error' });
  }
});

app.post('/api/ai/call-script/:id', async (req, res) => {
  try {
    const v = getVendor(Number(req.params.id));
    if (!v) return res.status(404).json({ error: 'Not found' });
    const text = await generateCallScript(v);
    res.json({ text });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'AI error' });
  }
});

app.post('/api/ai/suggest-new-vendors', async (_req, res) => {
  try {
    const vendors = listVendors();
    const text = await suggestNewVendors(vendors);
    res.json({ text });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'AI error' });
  }
});

app.post('/api/ai/monthly-review', async (_req, res) => {
  try {
    const snap = snapshotForAi();
    const text = await monthlyStrategicReview(snap);
    res.json({ text, snapshotMeta: { vendorCount: snap.vendors.length, at: snap.generatedAt } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'AI error' });
  }
});

app.post('/api/agent/run-now', (_req, res) => {
  res.json({ ok: true, message: 'Research agent started in the background.' });
  runResearchAgent({ discovery: true }).catch((e) => console.error('[research-agent]', e));
});

app.get('/api/agent/report', (_req, res) => {
  try {
    res.json({
      summary: getAgentReportSummary(),
      emailsReady: listEmailsReadyToSend(),
      blocked: listBlockedCompaniesForReport(),
      openIssues: listOpenIssuesForReport({ limit: 25 }),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Report failed' });
  }
});

app.post('/api/email/send', async (req, res) => {
  try {
    const { vendorId, draftId, subject, body, toEmail, toName } = req.body || {};
    const vid = Number(vendorId);
    const did = draftId != null ? Number(draftId) : NaN;
    if (!vid || !Number.isFinite(did) || !subject || !body || !toEmail) {
      return res.status(400).json({ error: 'vendorId, draftId, subject, body, and toEmail are required' });
    }
    const v = getVendor(vid);
    if (!v) return res.status(404).json({ error: 'Vendor not found' });
    const draft = getEmailDraft(did);
    if (!draft || Number(draft.vendor_id) !== vid) {
      return res.status(400).json({ error: 'Draft not found for this vendor' });
    }
    const text = String(body);
    const subj = String(subject);
    const info = await sendTransactionalEmail({
      to: String(toEmail).trim(),
      toName: toName ? String(toName).trim() : v.contact_person || '',
      subject: subj,
      text,
    });
    finalizeEmailDraftSent(did, vid, { subject: subj, body: text });
    res.json({ success: true, messageId: info.messageId });
  } catch (e) {
    console.error(e);
    const did = req.body?.draftId != null ? Number(req.body.draftId) : null;
    if (did) {
      try {
        markEmailDraftFailed(did, e.message || String(e));
      } catch {
        /* ignore */
      }
    }
    res.status(500).json({ error: e.message || 'Send failed' });
  }
});

app.post('/api/email/send-followup', async (req, res) => {
  try {
    const { vendorId, draftId, subject, body, toEmail, toName } = req.body || {};
    const vid = Number(vendorId);
    const did = draftId != null ? Number(draftId) : null;
    if (!vid || !subject || !body || !toEmail) {
      return res.status(400).json({ error: 'vendorId, subject, body, and toEmail are required' });
    }
    const v = getVendor(vid);
    if (!v) return res.status(404).json({ error: 'Vendor not found' });
    if (!did) return res.status(400).json({ error: 'draftId is required for follow-up send' });
    const draft = getEmailDraft(did);
    if (!draft || Number(draft.vendor_id) !== vid) {
      return res.status(404).json({ error: 'Draft not found' });
    }
    const text = String(body);
    const subj = String(subject);
    const info = await sendTransactionalEmail({
      to: String(toEmail).trim(),
      toName: toName ? String(toName).trim() : v.contact_person || '',
      subject: subj,
      text,
    });
    finalizeFollowupEmailSent(did, vid, { subject: subj, body: text });
    res.json({ success: true, messageId: info.messageId });
  } catch (e) {
    console.error(e);
    const did = req.body?.draftId != null ? Number(req.body.draftId) : null;
    if (did) {
      try {
        markEmailDraftFailed(did, e.message || String(e));
      } catch {
        /* ignore */
      }
    }
    res.status(500).json({ error: e.message || 'Send failed' });
  }
});

app.post('/api/email/test', async (_req, res) => {
  try {
    const to = getSmtpUser();
    if (!to) {
      return res.status(400).json({ error: 'Set SMTP_USER in .env or Settings (GoDaddy mailbox login, usually kevin@triexpressplumbing.com).' });
    }
    const info = await sendTransactionalEmail({
      to,
      toName: '',
      subject: 'Tri Express Plumbing — SMTP test',
      text: `This is a test message from the TEP Vendor CRM.\n\nSent to SMTP_USER (${to}) to confirm relay auth. Outbound From is always ${OUTBOUND_FROM_EMAIL}.`,
    });
    res.json({ success: true, messageId: info.messageId, sentTo: to });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Test send failed' });
  }
});

app.get('/api/agent/runs', (req, res) => {
  const limit = req.query.limit ? Number(req.query.limit) : 25;
  res.json(listBackgroundAgentRuns(limit));
});

app.get('/api/agent/pending-updates', (_req, res) => {
  res.json(listPendingVendorFieldUpdates({ status: 'pending' }));
});

app.post('/api/agent/pending-updates/:id/approve', (req, res) => {
  const id = Number(req.params.id);
  const r = approvePendingVendorFieldUpdate(id);
  if (r.error) return res.status(r.conflict ? 409 : 400).json(r);
  res.json(r);
});

app.post('/api/agent/pending-updates/:id/reject', (req, res) => {
  const id = Number(req.params.id);
  const r = rejectPendingVendorFieldUpdate(id);
  if (r.error) return res.status(400).json(r);
  res.json(r);
});

app.get('/api/agent/suggested-companies', (req, res) => {
  const st = req.query.status != null ? String(req.query.status) : 'pending';
  const rows =
    st === 'all' ? listSuggestedCompanies({}) : listSuggestedCompanies({ status: st });
  res.json(rows);
});

app.post('/api/agent/suggested-companies/:id/approve', (req, res) => {
  const id = Number(req.params.id);
  const r = approvePendingNewProspect(id);
  if (r.error) return res.status(400).json(r);
  res.json(r);
});

app.post('/api/agent/suggested-companies/:id/reject', (req, res) => {
  const id = Number(req.params.id);
  const r = rejectPendingNewProspect(id);
  if (r.error) return res.status(400).json(r);
  res.json(r);
});

app.get('/api/agent/activity', (req, res) => {
  const limit = req.query.limit ? Number(req.query.limit) : 150;
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  res.json({
    activity: listAgentActivity(limit),
    runs: listBackgroundAgentRuns(40),
    vendorsThisWeek: vendorsAddedSince(weekAgo),
    drafts: listEmailDrafts({ limit: 80 }),
  });
});

app.get('/api/agent/email-drafts', (req, res) => {
  const status = req.query.status ? String(req.query.status) : undefined;
  const limit = req.query.limit ? Number(req.query.limit) : 200;
  res.json(listEmailDrafts({ status, limit }));
});

app.get('/api/export/csv', (_req, res) => {
  const rows = exportVendorsCsvRows();
  const cols = [
    'id',
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
    'created_at',
    'updated_at',
  ];
  const lines = [cols.join(',')];
  for (const r of rows) {
    lines.push(cols.map((c) => csvEscape(r[c])).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="vendor_tracker_export.csv"');
  res.send(lines.join('\n'));
});

app.get('/api/settings', (_req, res) => {
  const key = getApiKey();
  const g = getGooglePlacesApiKey();
  const s = getSerpApiKey();
  res.json({
    hasApiKey: Boolean(key),
    maskedKey: maskKey(key),
    model: getModel(),
    hasGooglePlacesKey: Boolean(g),
    maskedGooglePlacesKey: maskKey(g),
    hasSerpApiKey: Boolean(s),
    maskedSerpApiKey: maskKey(s),
    smtpConfigured: isSmtpConfigured(),
    smtpHost: getSmtpHost(),
    smtpPort: getSmtpPort(),
    smtpUser: getSmtpUser(),
    smtpFromEmail: OUTBOUND_FROM_EMAIL,
    outboundFromEmail: OUTBOUND_FROM_EMAIL,
    smtpFromName: getSmtpFromName(),
    maskedSmtpPass: getSmtpPassMasked(),
  });
});

app.post('/api/settings', (req, res) => {
  if (req.body?.clear) {
    saveApiKey('');
  } else {
    const k = (req.body?.anthropicApiKey || '').trim();
    if (k) saveApiKey(k);
  }
  if ('googlePlacesApiKey' in (req.body || {})) {
    saveGooglePlacesApiKey(req.body.googlePlacesApiKey ?? '');
  }
  if ('serpApiKey' in (req.body || {})) {
    saveSerpApiKey(req.body.serpApiKey ?? '');
  }
  const b = req.body || {};
  if ('smtpHost' in b || 'smtpPort' in b || 'smtpUser' in b || 'smtpPass' in b || 'smtpFromName' in b) {
    saveSmtpSettings({
      smtpHost: b.smtpHost,
      smtpPort: b.smtpPort,
      smtpUser: b.smtpUser,
      smtpPass: b.smtpPass,
      smtpFromName: b.smtpFromName,
    });
  }
  const key = getApiKey();
  const g = getGooglePlacesApiKey();
  const s = getSerpApiKey();
  res.json({
    ok: true,
    hasApiKey: Boolean(key),
    maskedKey: maskKey(key),
    model: getModel(),
    hasGooglePlacesKey: Boolean(g),
    maskedGooglePlacesKey: maskKey(g),
    hasSerpApiKey: Boolean(s),
    maskedSerpApiKey: maskKey(s),
    smtpConfigured: isSmtpConfigured(),
    smtpHost: getSmtpHost(),
    smtpPort: getSmtpPort(),
    smtpUser: getSmtpUser(),
    smtpFromEmail: OUTBOUND_FROM_EMAIL,
    outboundFromEmail: OUTBOUND_FROM_EMAIL,
    smtpFromName: getSmtpFromName(),
    maskedSmtpPass: getSmtpPassMasked(),
  });
});

if (fs.existsSync(DIST)) {
  app.use(express.static(DIST));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(DIST, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`TEP Vendor Tracker API http://127.0.0.1:${PORT}`);
  if (fs.existsSync(DIST)) {
    console.log(`Serving SPA from ${DIST}`);
  } else {
    console.log('Dev: Vite on port 3000 proxies /api here. Run: npm run dev');
  }
  if (getAgentAutoRun()) {
    startResearchAgentScheduler();
    console.log(
      'Research & Outreach agent: cron daily at 06:00 server time (Agent Review); POST /api/agent/run-now to run manually.'
    );
  } else {
    console.log(
      'Research & Outreach agent: AGENT_AUTO_RUN=false — scheduled cron disabled; use POST /api/agent/run-now or Agent Review.'
    );
  }
});
