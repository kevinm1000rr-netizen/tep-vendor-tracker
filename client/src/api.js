/** Default API base: local dev uses Vite proxy / separate API port; production uses same origin. */
function defaultApiBase() {
  if (typeof window === 'undefined') return '/api';
  const h = window.location.hostname;
  if (/^(localhost|127\.0\.0\.1)$/i.test(h)) {
    return 'http://127.0.0.1:3099/api';
  }
  return `${window.location.origin}/api`;
}

const BASE = String(import.meta.env.VITE_API_BASE_URL || defaultApiBase())
  .trim()
  .replace(/\/+$/, '');

async function req(path, options = {}) {
  const r = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  if (!r.ok) {
    let err = r.statusText;
    try {
      const j = await r.json();
      err = j.error || err;
    } catch {
      /* ignore */
    }
    throw new Error(err);
  }
  if (r.status === 204) return null;
  const ct = r.headers.get('content-type');
  if (ct && ct.includes('application/json')) return r.json();
  return r.text();
}

export const api = {
  vendors: (q) => req(`/vendors${q ? `?${new URLSearchParams(q)}` : ''}`),
  vendor: (id) => req(`/vendors/${id}`),
  patchVendor: (id, body) =>
    req(`/vendors/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteVendor: (id) => req(`/vendors/${id}`, { method: 'DELETE' }),
  importVendorsPreview: (csv) =>
    req('/vendors/import-preview', { method: 'POST', body: JSON.stringify({ csv }) }),
  importVendorsCommit: (csv) =>
    req('/vendors/import-commit', { method: 'POST', body: JSON.stringify({ csv }) }),
  markSent: (id, letterVersion) =>
    req(`/vendors/${id}/mark-sent`, {
      method: 'POST',
      body: JSON.stringify({ letter_version_used: letterVersion }),
    }),
  logFollowup: (id, note) =>
    req(`/vendors/${id}/log-followup`, {
      method: 'POST',
      body: JSON.stringify({ note }),
    }),
  stats: () => req('/stats'),
  reviewDashboard: (date) => {
    const q = date ? `?date=${encodeURIComponent(date)}` : '';
    return req(`/review-dashboard${q}`);
  },
  alerts: () => req('/alerts'),
  followupLogs: (vendorId) => req(`/followup-logs/${vendorId}`),
  generateLetter: (id) => req(`/ai/letter/${id}`, { method: 'POST' }),
  generateFollowUp: (id) => req(`/ai/follow-up/${id}`, { method: 'POST' }),
  generateCallScript: (id) => req(`/ai/call-script/${id}`, { method: 'POST' }),
  monthlyReview: () => req('/ai/monthly-review', { method: 'POST' }),
  suggestNewVendors: () => req('/ai/suggest-new-vendors', { method: 'POST' }),
  settings: () => req('/settings'),
  saveSettings: (body) =>
    req('/settings', { method: 'POST', body: JSON.stringify(body) }),
  runAgent: () => req('/agent-tasks/run', { method: 'POST' }),
  agentTasks: (q = {}) => {
    const qs = new URLSearchParams();
    if (q.status) qs.set('status', q.status);
    const s = qs.toString();
    return req(`/agent-tasks${s ? `?${s}` : ''}`);
  },
  todayPriority: (limit) =>
    req(`/agent-tasks/today-priority${limit ? `?limit=${limit}` : ''}`),
  awaitingApproval: (limit) =>
    req(`/agent-tasks/awaiting-approval${limit ? `?limit=${limit}` : ''}`),
  patchAgentTask: (id, body) =>
    req(`/agent-tasks/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  agentTaskRecommendation: (id) =>
    req(`/agent-tasks/${id}/recommendation`, { method: 'POST' }),
  agentRunNow: () => req('/agent/run-now', { method: 'POST' }),
  agentRuns: (limit) => req(`/agent/runs${limit ? `?limit=${limit}` : ''}`),
  agentPendingUpdates: () => req('/agent/pending-updates'),
  agentApprovePendingUpdate: (id) =>
    req(`/agent/pending-updates/${id}/approve`, { method: 'POST' }),
  agentRejectPendingUpdate: (id) =>
    req(`/agent/pending-updates/${id}/reject`, { method: 'POST' }),
  agentSuggestedCompanies: (status) =>
    req(`/agent/suggested-companies${status != null ? `?status=${encodeURIComponent(status)}` : ''}`),
  agentApproveSuggestedCompany: (id) =>
    req(`/agent/suggested-companies/${id}/approve`, { method: 'POST' }),
  agentRejectSuggestedCompany: (id) =>
    req(`/agent/suggested-companies/${id}/reject`, { method: 'POST' }),
  agentEmailDrafts: (q = {}) => {
    const qs = new URLSearchParams();
    if (q.status) qs.set('status', q.status);
    if (q.limit) qs.set('limit', String(q.limit));
    const s = qs.toString();
    return req(`/agent/email-drafts${s ? `?${s}` : ''}`);
  },
  agentReport: () => req('/agent/report'),
  listSentEmailsForReport: (limit) => {
    const qs = new URLSearchParams();
    if (limit != null && Number.isFinite(Number(limit))) qs.set('limit', String(limit));
    const s = qs.toString();
    return req(`/agent/sent-emails${s ? `?${s}` : ''}`);
  },
  agentActivity: (limit) => req(`/agent/activity${limit ? `?limit=${limit}` : ''}`),
  sendEmail: (body) => req('/email/send', { method: 'POST', body: JSON.stringify(body) }),
  sendFollowupEmail: (body) => req('/email/send-followup', { method: 'POST', body: JSON.stringify(body) }),
  testSmtp: () => req('/email/test', { method: 'POST', body: '{}' }),
  testSms: () => req('/sms/test', { method: 'POST', body: '{}' }),
  permitLeads: (q = {}) => {
    const qs = new URLSearchParams();
    if (q.permit_type) qs.set('permit_type', q.permit_type);
    if (q.city) qs.set('city', q.city);
    if (q.source_city) qs.set('source_city', q.source_city);
    if (q.status) qs.set('status', q.status);
    if (q.view) qs.set('view', q.view);
    if (q.minScore != null) qs.set('minScore', String(q.minScore));
    if (q.search) qs.set('search', q.search);
    const s = qs.toString();
    return req(`/permits/leads${s ? `?${s}` : ''}`);
  },
  permitSources: () => req('/permits/sources'),
  permitLead: (id) => req(`/permits/leads/${id}`),
  patchPermitLead: (id, body) => req(`/permits/leads/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  permitRunNow: () => req('/permits/run-now', { method: 'POST' }),
  permitRuns: (limit) => req(`/permits/runs${limit ? `?limit=${limit}` : ''}`),
  sendPermitLeadEmail: (id, body = {}) =>
    req(`/permits/leads/${id}/send-email`, { method: 'POST', body: JSON.stringify(body) }),
  regeneratePermitLeadEmail: (id) =>
    req(`/permits/leads/${id}/regenerate-email`, { method: 'POST', body: '{}' }),
  permitLeadCallScript: (id) => req(`/permits/leads/${id}/call-script`, { method: 'POST', body: '{}' }),
};

export function downloadCsv() {
  window.open(`${BASE}/export/csv`, '_blank');
}

export function downloadPermitCsv() {
  window.open(`${BASE}/permits/export/csv`, '_blank');
}
