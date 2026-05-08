/**
 * Database entry: PostgreSQL when DATABASE_URL is set, otherwise local SQLite (better-sqlite3).
 */
import * as sqlite from './db.sqlite.js';
import * as pg from './db.postgres.js';

const usePg = Boolean(process.env.DATABASE_URL?.trim());

export async function initDatabase() {
  if (usePg) return pg.initDatabase();
  sqlite.initDatabase();
}

export async function closePool() {
  if (usePg) return pg.closePool();
}

export function getDb() {
  if (usePg) throw new Error('getDb() is only available in SQLite mode (unset DATABASE_URL).');
  return sqlite.getDb();
}

async function callDb(fn, ...args) {
  if (usePg) return pg[fn](...args);
  return Promise.resolve(sqlite[fn](...args));
}

export const listVendors = (...a) => callDb('listVendors', ...a);
export const getVendor = (...a) => callDb('getVendor', ...a);
export const deleteVendor = (...a) => callDb('deleteVendor', ...a);
export const getAgentLearningForCategory = (...a) => callDb('getAgentLearningForCategory', ...a);
export const logAgentActivity = (...a) => callDb('logAgentActivity', ...a);
export const listAgentActivity = (...a) => callDb('listAgentActivity', ...a);
export const updateVendor = (...a) => callDb('updateVendor', ...a);
export const markSent = (...a) => callDb('markSent', ...a);
export const logFollowup = (...a) => callDb('logFollowup', ...a);
export const listFollowupLogs = (...a) => callDb('listFollowupLogs', ...a);
export const getStats = (...a) => callDb('getStats', ...a);
export const listOverdue = (...a) => callDb('listOverdue', ...a);
export const listMonthlyAlerts = (...a) => callDb('listMonthlyAlerts', ...a);
export const exportVendorsCsvRows = (...a) => callDb('exportVendorsCsvRows', ...a);
export const insertAgentTask = (...a) => callDb('insertAgentTask', ...a);
export const listAgentTasks = (...a) => callDb('listAgentTasks', ...a);
export const getAgentTask = (...a) => callDb('getAgentTask', ...a);
export const getTodaysPriorityActions = (...a) => callDb('getTodaysPriorityActions', ...a);
export const listAwaitingApproval = (...a) => callDb('listAwaitingApproval', ...a);
export const updateAgentTask = (...a) => callDb('updateAgentTask', ...a);
export const runAgent = (...a) => callDb('runAgent', ...a);
export const normalizeNameDedupe = (...a) => (usePg ? pg.normalizeNameDedupe(...a) : sqlite.normalizeNameDedupe(...a));
export const insertAgentRun = (...a) => callDb('insertAgentRun', ...a);
export const insertBackgroundAgentRun = (...a) => callDb('insertBackgroundAgentRun', ...a);
export const completeAgentRun = (...a) => callDb('completeAgentRun', ...a);
export const completeBackgroundAgentRun = (...a) => callDb('completeBackgroundAgentRun', ...a);
export const listAgentRuns = (...a) => callDb('listAgentRuns', ...a);
export const listBackgroundAgentRuns = (...a) => callDb('listBackgroundAgentRuns', ...a);
export const upsertPendingVendorFieldUpdate = (...a) => callDb('upsertPendingVendorFieldUpdate', ...a);
export const listPendingVendorFieldUpdates = (...a) => callDb('listPendingVendorFieldUpdates', ...a);
export const getPendingVendorFieldUpdate = (...a) => callDb('getPendingVendorFieldUpdate', ...a);
export const setPendingVendorFieldStatus = (...a) => callDb('setPendingVendorFieldStatus', ...a);
export const insertPendingNewProspect = (...a) => callDb('insertPendingNewProspect', ...a);
export const listSuggestedCompanies = (...a) => callDb('listSuggestedCompanies', ...a);
export const listPendingNewProspects = (...a) => callDb('listPendingNewProspects', ...a);
export const listEmailDrafts = (...a) => callDb('listEmailDrafts', ...a);
export const getEmailDraft = (...a) => callDb('getEmailDraft', ...a);
export const vendorHasPendingOutreachDraft = (...a) => callDb('vendorHasPendingOutreachDraft', ...a);
export const listEmailsReadyToSend = (...a) => callDb('listEmailsReadyToSend', ...a);
export const listBlockedVendorIdsForAgent = (...a) => callDb('listBlockedVendorIdsForAgent', ...a);
export const listBlockedCompaniesForReport = (...a) => callDb('listBlockedCompaniesForReport', ...a);
export const listOpenIssuesForReport = (...a) => callDb('listOpenIssuesForReport', ...a);
export const getAgentReportSummary = (...a) => callDb('getAgentReportSummary', ...a);
export const listSentEmailsForReport = (...a) => callDb('listSentEmailsForReport', ...a);
export const getReviewDashboard = (...a) => callDb('getReviewDashboard', ...a);
export const upsertVendorOutreachDraft = (...a) => callDb('upsertVendorOutreachDraft', ...a);
export const finalizeEmailDraftSent = (...a) => callDb('finalizeEmailDraftSent', ...a);
export const finalizeFollowupEmailSent = (...a) => callDb('finalizeFollowupEmailSent', ...a);
export const markEmailDraftFailed = (...a) => callDb('markEmailDraftFailed', ...a);
export const vendorsAddedSince = (...a) => callDb('vendorsAddedSince', ...a);
export const getPendingNewProspect = (...a) => callDb('getPendingNewProspect', ...a);
export const setPendingNewProspectStatus = (...a) => callDb('setPendingNewProspectStatus', ...a);
export const vendorNameExistsLoose = (...a) => callDb('vendorNameExistsLoose', ...a);
export const pendingProspectDedupeExists = (...a) => callDb('pendingProspectDedupeExists', ...a);
export const insertVendor = (...a) => callDb('insertVendor', ...a);
export const importVendorsFromMappedRows = (...a) => callDb('importVendorsFromMappedRows', ...a);
export const applyVendorFieldIfEmpty = (...a) => callDb('applyVendorFieldIfEmpty', ...a);
export const approvePendingVendorFieldUpdate = (...a) => callDb('approvePendingVendorFieldUpdate', ...a);
export const rejectPendingVendorFieldUpdate = (...a) => callDb('rejectPendingVendorFieldUpdate', ...a);
export const approvePendingNewProspect = (...a) => callDb('approvePendingNewProspect', ...a);
export const rejectPendingNewProspect = (...a) => callDb('rejectPendingNewProspect', ...a);
export const listPermitLeads = (...a) => callDb('listPermitLeads', ...a);
export const getPermitLead = (...a) => callDb('getPermitLead', ...a);
export const getPermitLeadByPermitNumber = (...a) => callDb('getPermitLeadByPermitNumber', ...a);
export const getPermitLeadBySourceAndPermitNumber = (...a) => callDb('getPermitLeadBySourceAndPermitNumber', ...a);
export const insertPermitLead = (...a) => callDb('insertPermitLead', ...a);
export const updatePermitLead = (...a) => callDb('updatePermitLead', ...a);
export const listPermitAgentRuns = (...a) => callDb('listPermitAgentRuns', ...a);
export const insertPermitAgentRun = (...a) => callDb('insertPermitAgentRun', ...a);
export const getPermitLeadStats = (...a) => callDb('getPermitLeadStats', ...a);
export const updatePermitLearningSnapshot = (...a) => callDb('updatePermitLearningSnapshot', ...a);
export const wasSmsSentToday = (...a) => callDb('wasSmsSentToday', ...a);
export const markSmsSent = (...a) => callDb('markSmsSent', ...a);
export const insertEmailDraftRecord = (...a) => callDb('insertEmailDraftRecord', ...a);
export const getPermitAgentReportStats = (...a) => callDb('getPermitAgentReportStats', ...a);
export const listHotPermitLeads = (...a) => callDb('listHotPermitLeads', ...a);
export const insertCustomerLead = (...a) => callDb('insertCustomerLead', ...a);
