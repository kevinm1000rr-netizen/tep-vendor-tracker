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
  approvePendingVendorFieldUpdate,
  rejectPendingVendorFieldUpdate,
  approvePendingNewProspect,
  rejectPendingNewProspect,
  listSuggestedCompanies,
  listEmailDrafts,
  getAgentReportSummary,
  getReviewDashboard,
  listEmailsReadyToSend,
  listBlockedCompaniesForReport,
  listOpenIssuesForReport,
  getEmailDraft,
  finalizeEmailDraftSent,
  finalizeFollowupEmailSent,
  markEmailDraftFailed,
  listAgentActivity,
  vendorsAddedSince,
  importVendorsFromMappedRows,
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
  getLiveAgentIntervalMinutes,
  isSmtpConfigured,
  getSmtpHost,
  getSmtpPort,
  getSmtpUser,
  getSmtpFromName,
  saveSmtpSettings,
  getSmtpPassMasked,
  OUTBOUND_FROM_EMAIL,
  isTepConfigFilePresent,
} from './config.js';
import {
  generateVendorLetter,
  generateFollowUpEmail,
  generateCallScript,
  monthlyStrategicReview,
  generateTaskRecommendation,
  suggestNewVendors,
  isManualResearchLetterOutput,
  getManualResearchLetterReason,
} from './ai.js';
import { buildOutreachResearchBrief } from './outreachResearch.js';
import { ROOT } from './paths.js';
import { runResearchAgent, startResearchAgentScheduler, startLiveAgentLoop } from './researchAgent.js';
import { sendTransactionalEmail } from './mailer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(ROOT, 'dist');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const PORT = Number(process.env.PORT || 3000);

async function snapshotForAi() {
  const vendors = await listVendors();
  const stats = await getStats();
  const alerts = await listOverdue();
  const byCat = {};
  for (const row of stats.byCategory) {
    const cat = row.category;
    const vs = vendors.filter((v) => v.category === cat);
    const touched = vs.filter((v) => v.status !== 'not_sent' && v.status !== 'new').length;
    const wins = vs.filter((v) => v.status === 'responded' || v.status === 'approved').length;
    byCat[cat] = {
      total: vs.length,
      outreachStarted: touched,
      responsesOrApproved: wins,
      winRate: touched > 0 ? Math.round((wins / touched) * 1000) / 10 : null,
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

app.get('/api/vendors', async (req, res) => {
  try {
    const { category, status } = req.query;
    res.json(await listVendors({ category, status }));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Failed' });
  }
});

app.get('/api/vendors/:id', async (req, res) => {
  try {
    const v = await getVendor(Number(req.params.id));
    if (!v) return res.status(404).json({ error: 'Not found' });
    res.json(v);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Failed' });
  }
});

app.patch('/api/vendors/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const v = await updateVendor(id, req.body);
    if (!v) return res.status(404).json({ error: 'Not found' });
    res.json(v);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Failed' });
  }
});

app.post('/api/vendors/import-preview', async (req, res) => {
  try {
    const csvText = String(req.body?.csv ?? '');
    const matrix = parseCsvRows(csvText);
    const { headers, fieldByCol, dataRows, errors: headerErrors } = analyzeCsvTable(matrix);
    const errs = [...headerErrors];
    const preview = [];
    for (let i = 0; i < dataRows.length; i += 1) {
      const cells = dataRows[i];
      const rec = rowToImportRecord(cells, fieldByCol);
      if (!rec.name) errs.push({ row: i + 2, error: 'Missing company name (mapped column empty)' });
      preview.push({
        rowNumber: i + 2,
        name: rec.name,
        phone: rec.phone,
        website: rec.website,
        address: rec.address,
        category: rec.category,
        specialty_portfolio: rec.specialty_portfolio,
        notes: rec.notes,
      });
    }
    res.json({
      ok: headerErrors.length === 0,
      headers,
      rowCount: preview.length,
      preview: preview.slice(0, 150),
      previewTruncated: preview.length > 150,
      errors: errs,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Preview failed' });
  }
});

app.post('/api/vendors/import-commit', async (req, res) => {
  try {
    const csvText = String(req.body?.csv ?? '');
    const matrix = parseCsvRows(csvText);
    const { fieldByCol, dataRows, errors: headerErrors } = analyzeCsvTable(matrix);
    if (headerErrors.length) {
      return res.status(400).json({ error: 'Fix CSV headers before importing.', details: headerErrors });
    }
    const max = 2000;
    const slice = dataRows.slice(0, max);
    const normalized = slice
      .map((cells) => {
        const rec = rowToImportRecord(cells, fieldByCol);
        const cat = String(rec.category || '').trim();
        const category = ['restoration', 'property_mgmt', 'hoa', 'contractor'].includes(cat) ? cat : 'contractor';
        return {
          name: rec.name.trim(),
          phone: rec.phone,
          website: rec.website,
          address: rec.address,
          category,
          notes: rec.notes,
        };
      })
      .filter((r) => r.name);
    const result = await importVendorsFromMappedRows(normalized);
    res.json({ ...result, truncated: dataRows.length > max, totalRowsInFile: dataRows.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Import failed' });
  }
});

app.post('/api/vendors/:id/mark-sent', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const v = await markSent(id, { letter_version_used: req.body?.letter_version_used });
    if (!v) return res.status(404).json({ error: 'Not found' });
    res.json(v);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Failed' });
  }
});

app.post('/api/vendors/:id/log-followup', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const v = await logFollowup(id, req.body?.note || '');
    if (!v) return res.status(404).json({ error: 'Not found' });
    res.json(v);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Failed' });
  }
});

app.get('/api/stats', async (_req, res) => {
  try {
    res.json(await getStats());
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Failed' });
  }
});

app.get('/api/review-dashboard', async (req, res) => {
  try {
    const date = typeof req.query.date === 'string' ? req.query.date.trim() : '';
    res.json(await getReviewDashboard({ date }));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Failed' });
  }
});

app.get('/api/alerts', async (_req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const overdue = await listOverdue();
    const rows = overdue.map((v) => {
      const d = v.daysUntilFollowup;
      let level = 'ok';
      if (d < -30) level = 'critical';
      else if ((d >= -30 && d < 0) || (d >= 0 && d <= 7)) level = 'warn';
      return { ...v, alertLevel: level, today };
    });
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Failed' });
  }
});

app.get('/api/followup-logs/:vendorId', async (req, res) => {
  try {
    res.json(await listFollowupLogs(Number(req.params.vendorId)));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Failed' });
  }
});

app.post('/api/agent-tasks/run', async (_req, res) => {
  try {
    const summary = await runAgent();
    res.json(summary);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Run agent failed' });
  }
});

app.get('/api/agent-tasks', async (req, res) => {
  try {
    const { status } = req.query;
    res.json(await listAgentTasks({ status: status || undefined }));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Failed' });
  }
});

app.get('/api/agent-tasks/today-priority', async (req, res) => {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : 12;
    res.json(await getTodaysPriorityActions(limit));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Failed' });
  }
});

app.get('/api/agent-tasks/awaiting-approval', async (req, res) => {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : 20;
    res.json(await listAwaitingApproval(limit));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Failed' });
  }
});

app.patch('/api/agent-tasks/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const task = await getAgentTask(id);
    if (!task) return res.status(404).json({ error: 'Not found' });
    const body = req.body || {};
    const { status, ai_recommendation } = body;
    const patch = {};
    if (status === 'pending' || status === 'done' || status === 'skipped') patch.status = status;
    if (ai_recommendation !== undefined) patch.ai_recommendation = ai_recommendation;
    if ('approved_by_kevin' in body) patch.approved_by_kevin = Boolean(body.approved_by_kevin);
    const updated = await updateAgentTask(id, patch);
    res.json(updated);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Failed' });
  }
});

app.post('/api/agent-tasks/:id/recommendation', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const task = await getAgentTask(id);
    if (!task) return res.status(404).json({ error: 'Not found' });
    const vendor = task.vendor_id ? await getVendor(task.vendor_id) : null;
    const text = await generateTaskRecommendation(task, vendor);
    const updated = await updateAgentTask(id, { ai_recommendation: text });
    res.json({ task: updated, text });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'AI error' });
  }
});

app.post('/api/ai/letter/:id', async (req, res) => {
  try {
    const v = await getVendor(Number(req.params.id));
    if (!v) return res.status(404).json({ error: 'Not found' });
    const brief = await buildOutreachResearchBrief(v, {
      googlePlacesKey: getGooglePlacesApiKey(),
      serpKey: getSerpApiKey(),
    });
    const text = await generateVendorLetter(v, '', brief);
    const raw = String(text || '').trim();
    if (isManualResearchLetterOutput(raw)) {
      return res.json({
        manualResearch: true,
        reason: getManualResearchLetterReason(raw),
        text: '',
      });
    }
    res.json({ manualResearch: false, text: raw });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'AI error' });
  }
});

app.post('/api/ai/follow-up/:id', async (req, res) => {
  try {
    const v = await getVendor(Number(req.params.id));
    if (!v) return res.status(404).json({ error: 'Not found' });
    let days = 0;
    if (v.date_sent) {
      const a = new Date(v.date_sent + 'T12:00:00Z');
      const b = new Date();
      days = Math.max(0, Math.round((b - a) / 86400000));
    }
    const brief = await buildOutreachResearchBrief(v, {
      googlePlacesKey: getGooglePlacesApiKey(),
      serpKey: getSerpApiKey(),
    });
    const text = await generateFollowUpEmail(v, days, brief);
    const raw = String(text || '').trim();
    if (isManualResearchLetterOutput(raw)) {
      return res.json({
        manualResearch: true,
        reason: getManualResearchLetterReason(raw),
        text: '',
      });
    }
    res.json({ manualResearch: false, text: raw });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'AI error' });
  }
});

app.post('/api/ai/call-script/:id', async (req, res) => {
  try {
    const v = await getVendor(Number(req.params.id));
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
    const vendors = await listVendors();
    const text = await suggestNewVendors(vendors);
    res.json({ text });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'AI error' });
  }
});

app.post('/api/ai/monthly-review', async (_req, res) => {
  try {
    const snap = await snapshotForAi();
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

app.get('/api/agent/report', async (_req, res) => {
  try {
    res.json({
      summary: await getAgentReportSummary(),
      emailsReady: await listEmailsReadyToSend(),
      blocked: await listBlockedCompaniesForReport(),
      openIssues: await listOpenIssuesForReport({ limit: 25 }),
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
    const v = await getVendor(vid);
    if (!v) return res.status(404).json({ error: 'Vendor not found' });
    const draft = await getEmailDraft(did);
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
    await finalizeEmailDraftSent(did, vid, { subject: subj, body: text });
    res.json({ success: true, messageId: info.messageId });
  } catch (e) {
    console.error(e);
    const did = req.body?.draftId != null ? Number(req.body.draftId) : null;
    if (did) {
      try {
        await markEmailDraftFailed(did, e.message || String(e));
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
    const v = await getVendor(vid);
    if (!v) return res.status(404).json({ error: 'Vendor not found' });
    if (!did) return res.status(400).json({ error: 'draftId is required for follow-up send' });
    const draft = await getEmailDraft(did);
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
    await finalizeFollowupEmailSent(did, vid, { subject: subj, body: text });
    res.json({ success: true, messageId: info.messageId });
  } catch (e) {
    console.error(e);
    const did = req.body?.draftId != null ? Number(req.body.draftId) : null;
    if (did) {
      try {
        await markEmailDraftFailed(did, e.message || String(e));
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
      return res.status(400).json({
        error:
          'Set SMTP_USER in .env or Settings (GoDaddy mailbox login, usually kevin@triexpressplumbing.com).',
      });
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

app.get('/api/agent/runs', async (req, res) => {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : 25;
    res.json(await listBackgroundAgentRuns(limit));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Failed' });
  }
});

app.get('/api/agent/pending-updates', async (_req, res) => {
  try {
    res.json(await listPendingVendorFieldUpdates({ status: 'pending' }));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Failed' });
  }
});

app.post('/api/agent/pending-updates/:id/approve', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const r = await approvePendingVendorFieldUpdate(id);
    if (r.error) return res.status(r.conflict ? 409 : 400).json(r);
    res.json(r);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Failed' });
  }
});

app.post('/api/agent/pending-updates/:id/reject', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const r = await rejectPendingVendorFieldUpdate(id);
    if (r.error) return res.status(400).json(r);
    res.json(r);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Failed' });
  }
});

app.get('/api/agent/suggested-companies', async (req, res) => {
  try {
    const st = req.query.status != null ? String(req.query.status) : 'pending';
    const rows = st === 'all' ? await listSuggestedCompanies({}) : await listSuggestedCompanies({ status: st });
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Failed' });
  }
});

app.post('/api/agent/suggested-companies/:id/approve', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const r = await approvePendingNewProspect(id);
    if (r.error) return res.status(400).json(r);
    res.json(r);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Failed' });
  }
});

app.post('/api/agent/suggested-companies/:id/reject', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const r = await rejectPendingNewProspect(id);
    if (r.error) return res.status(400).json(r);
    res.json(r);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Failed' });
  }
});

app.get('/api/agent/activity', async (req, res) => {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : 150;
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    res.json({
      activity: await listAgentActivity(limit),
      runs: await listBackgroundAgentRuns(40),
      vendorsThisWeek: await vendorsAddedSince(weekAgo),
      drafts: await listEmailDrafts({ limit: 80 }),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Failed' });
  }
});

app.get('/api/agent/email-drafts', async (req, res) => {
  try {
    const status = req.query.status ? String(req.query.status) : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : 200;
    res.json(await listEmailDrafts({ status, limit }));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Failed' });
  }
});

app.get('/api/export/csv', async (_req, res) => {
  try {
    const rows = await exportVendorsCsvRows();
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
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Failed' });
  }
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
    tepConfigFilePresent: isTepConfigFilePresent(),
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
    tepConfigFilePresent: isTepConfigFilePresent(),
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

async function start() {
  await initDatabase();
  app.listen(PORT, () => {
    console.log(`TEP Vendor Tracker API http://127.0.0.1:${PORT}`);
    if (process.env.DATABASE_URL) {
      console.log('[db] Using PostgreSQL (DATABASE_URL)');
    } else {
      console.log('[db] Using SQLite vendor_tracker.db');
    }
    if (fs.existsSync(DIST)) {
      console.log(`Serving SPA from ${DIST}`);
    } else {
      console.log('Dev: Vite on port 3000 proxies /api here. Run: npm run dev');
    }
    if (getAgentAutoRun()) {
      startResearchAgentScheduler();
      console.log(
        'Research & Outreach agent: cron daily at 06:00 server time; POST /api/agent/run-now to run manually.'
      );
    } else {
      console.log(
        'Research & Outreach agent: AGENT_AUTO_RUN=false — daily cron disabled; use POST /api/agent/run-now or Agent Review.'
      );
    }
    startLiveAgentLoop();
    const liveMins = getLiveAgentIntervalMinutes();
    if (liveMins > 0) {
      console.log(
        `Live discovery agent: every ${liveMins} min (LIVE_AGENT_INTERVAL_MINUTES or LIVE_AGENT_MODE=true). Auto-adds 10+ year San Diego vendors + partnership drafts.`
      );
    }
  });
}

start().catch((err) => {
  console.error('[startup]', err);
  process.exit(1);
});
