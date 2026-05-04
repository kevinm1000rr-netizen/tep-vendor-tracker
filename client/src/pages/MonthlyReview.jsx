import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';

function localCalendarYmd() {
  const t = new Date();
  const y = t.getFullYear();
  const m = String(t.getMonth() + 1).padStart(2, '0');
  const d = String(t.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatUsd(n) {
  if (n == null || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(
    n
  );
}

function activityLabel(type) {
  const m = {
    discovery_register: 'Discovery · new company',
    draft_created: 'Draft · outreach email',
    outreach_manual_research: 'Outreach · manual research needed',
    email_sent: 'Send · outreach email',
    followup_email_sent: 'Send · follow-up email',
    email_failed: 'Email · failed',
    auto_fill: 'Enrich · field filled',
    enrich: 'Enrich · vendor',
    vendor_responded: 'CRM · responded',
  };
  return m[type] || type;
}

function formatActivityTime(createdAt) {
  const raw = String(createdAt || '').replace('T', ' ');
  const t = raw.slice(11, 16);
  return t || raw.slice(0, 16);
}

export default function MonthlyReview() {
  const [view, setView] = useState('daily');
  const [loading, setLoading] = useState(true);
  const [dash, setDash] = useState(null);
  const [dashErr, setDashErr] = useState('');
  const [reportLoading, setReportLoading] = useState(false);
  const [reportText, setReportText] = useState('');
  const [reportMeta, setReportMeta] = useState(null);
  const [reportErr, setReportErr] = useState('');

  const loadDashboard = useCallback(async () => {
    setDashErr('');
    setLoading(true);
    try {
      const d = await api.reviewDashboard(localCalendarYmd());
      setDash(d);
    } catch (e) {
      setDashErr(e.message);
      setDash(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDashboard();
  }, [loadDashboard]);

  const runMonthlyAi = async () => {
    setReportLoading(true);
    setReportErr('');
    try {
      const res = await api.monthlyReview();
      setReportText(res.text);
      setReportMeta(res.snapshotMeta);
    } catch (e) {
      setReportErr(e.message);
      setReportText('');
    } finally {
      setReportLoading(false);
    }
  };

  const copyReport = () => {
    if (reportText) navigator.clipboard.writeText(reportText);
  };

  const downloadTxt = () => {
    if (!reportText) return;
    const blob = new Blob([reportText], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tep-monthly-review-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const chartMax =
    dash?.chart30?.length > 0
      ? Math.max(1, ...dash.chart30.map((r) => r.discoveries + r.drafts + r.sends))
      : 1;

  return (
    <>
      <h1 className="page-title">Progress &amp; review</h1>
      <p className="sub">
        Daily pipeline first, then monthly rollups. Dashboard uses your browser’s local calendar day (
        {localCalendarYmd()}).
      </p>

      <div className="review-view-toggle no-print">
        <button type="button" className={view === 'daily' ? 'active' : ''} onClick={() => setView('daily')}>
          Daily view
        </button>
        <button type="button" className={view === 'monthly' ? 'active' : ''} onClick={() => setView('monthly')}>
          Monthly view
        </button>
        <button type="button" className="ghost" onClick={loadDashboard} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh data'}
        </button>
      </div>

      {dashErr && <p style={{ color: 'var(--danger)' }}>{dashErr}</p>}

      {view === 'daily' && (
        <>
          {loading && !dash ? (
            <p className="sub">Loading dashboard…</p>
          ) : dash ? (
            <>
              <div className="review-daily-grid">
                <div className="panel review-stat">
                  <div className="review-stat-label">New companies (agent)</div>
                  <div className="review-stat-value">{dash.daily.newCompaniesAgentToday}</div>
                  <div className="review-stat-hint">Auto-registered from discovery today</div>
                </div>
                <div className="panel review-stat">
                  <div className="review-stat-label">New vendor rows today</div>
                  <div className="review-stat-value">{dash.daily.newVendorRowsToday}</div>
                  <div className="review-stat-hint">Includes manual CRM adds</div>
                </div>
                <div className="panel review-stat">
                  <div className="review-stat-label">Emails drafted today</div>
                  <div className="review-stat-value">{dash.daily.draftsCreatedToday}</div>
                  <div className="review-stat-hint">Agent draft_created events</div>
                </div>
                <div className="panel review-stat">
                  <div className="review-stat-label">Emails sent today</div>
                  <div className="review-stat-value">{dash.daily.emailsSentToday}</div>
                  <div className="review-stat-hint">Outreach + follow-up sends logged</div>
                </div>
                <div className="panel review-stat">
                  <div className="review-stat-label">Responded today</div>
                  <div className="review-stat-value">{dash.daily.respondedToday}</div>
                  <div className="review-stat-hint">Status → Responded (first timestamp)</div>
                </div>
                <div className="panel review-stat">
                  <div className="review-stat-label">Partnerships this month</div>
                  <div className="review-stat-value">{dash.daily.partnershipsThisMonth}</div>
                  <div className="review-stat-hint">Approved with date in {dash.monthKey}</div>
                </div>
              </div>

              <h2 className="review-section-title">Agent activity · {dash.day}</h2>
              <p className="sub">Each hour shows everything the agent (and CRM sends) logged.</p>
              <div className="review-timeline">
                {dash.timelineByHour.map((slot) => (
                  <div key={slot.hour} className="review-hour-row">
                    <div className="review-hour-label">{slot.label}</div>
                    <div className="review-hour-body">
                      {slot.activities.length === 0 ? (
                        <span className="review-hour-empty">—</span>
                      ) : (
                        <ul className="review-hour-list">
                          {slot.activities.map((a, i) => (
                            <li key={`${slot.hour}-${i}-${a.created_at}`}>
                              <span className="review-time">{formatActivityTime(a.created_at)}</span>
                              <span className="review-type">{activityLabel(a.activity_type)}</span>
                              {a.vendor_name ? <span className="review-vendor"> · {a.vendor_name}</span> : null}
                              <span className="review-summary"> — {a.summary}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : null}
        </>
      )}

      {view === 'monthly' && (
        <>
          {loading && !dash ? (
            <p className="sub">Loading…</p>
          ) : dash ? (
            <>
              <div className="review-monthly-grid">
                <div className="panel review-stat">
                  <div className="review-stat-label">Contacted this month</div>
                  <div className="review-stat-value">{dash.monthly.contactedThisMonth}</div>
                  <div className="review-stat-hint">First outreach logged ({dash.monthKey})</div>
                </div>
                <div className="panel review-stat">
                  <div className="review-stat-label">Response rate</div>
                  <div className="review-stat-value">
                    {dash.monthly.responseRatePct != null ? `${dash.monthly.responseRatePct}%` : '—'}
                  </div>
                  <div className="review-stat-hint">
                    Responded or approved among companies contacted this month
                  </div>
                </div>
                <div className="panel review-stat">
                  <div className="review-stat-label">Partnerships established</div>
                  <div className="review-stat-value">{dash.monthly.partnershipsEstablishedThisMonth}</div>
                  <div className="review-stat-hint">Approved this month (stamped)</div>
                </div>
                <div className="panel review-stat">
                  <div className="review-stat-label">Est. revenue potential</div>
                  <div className="review-stat-value">{formatUsd(dash.monthly.estimatedRevenuePotentialMonthly)}</div>
                  <div className="review-stat-hint">{dash.monthly.estimatedRevenueNote}</div>
                </div>
              </div>

              <h2 className="review-section-title">Outreach momentum · last 30 days</h2>
              <p className="sub">Stacked bar height = discoveries + drafts + sends per day.</p>
              <div className="review-chart-wrap panel">
                <div className="review-chart" aria-label="Daily outreach activity last 30 days">
                  {dash.chart30.map((row) => {
                    const total = row.discoveries + row.drafts + row.sends;
                    const h = Math.round((total / chartMax) * 120);
                    const md = row.date.slice(5);
                    const t = total > 0 ? total : 1;
                    return (
                      <div key={row.date} className="review-chart-col" title={`${row.date}: ${total} events`}>
                        <div className="review-chart-stack" style={{ height: `${Math.max(h, 2)}px` }}>
                          {total > 0 ? (
                            <>
                              <div
                                className="review-bar discoveries"
                                style={{ flex: row.discoveries / t }}
                              />
                              <div className="review-bar drafts" style={{ flex: row.drafts / t }} />
                              <div className="review-bar sends" style={{ flex: row.sends / t }} />
                            </>
                          ) : (
                            <div className="review-bar empty" />
                          )}
                        </div>
                        <div className="review-chart-x">{md}</div>
                      </div>
                    );
                  })}
                </div>
                <div className="review-chart-legend">
                  <span>
                    <i className="swatch discoveries" /> Discoveries
                  </span>
                  <span>
                    <i className="swatch drafts" /> Drafts
                  </span>
                  <span>
                    <i className="swatch sends" /> Sends
                  </span>
                </div>
              </div>

              <h2 className="review-section-title">AI monthly strategic review</h2>
              <p className="sub">Narrative priorities and checklist — separate from the metrics above.</p>
              <div className="toolbar no-print">
                <button type="button" className="danger monthly-btn" disabled={reportLoading} onClick={runMonthlyAi}>
                  {reportLoading ? 'Working…' : 'Run monthly strategic review'}
                </button>
                <button type="button" disabled={!reportText} onClick={copyReport}>
                  Copy report
                </button>
                <button type="button" disabled={!reportText} onClick={downloadTxt}>
                  Download .txt
                </button>
                <button type="button" disabled={!reportText} onClick={() => window.print()}>
                  Print / Save PDF
                </button>
              </div>
              {reportErr && <p style={{ color: 'var(--danger)' }}>{reportErr}</p>}
              {reportMeta && (
                <p className="sub">
                  Snapshot: {reportMeta.vendorCount} companies · {new Date(reportMeta.at).toLocaleString()}
                </p>
              )}
              {reportText && (
                <div id="print-report" className="panel">
                  <h3 className="no-print">Report</h3>
                  <pre className="output-pre">{reportText}</pre>
                </div>
              )}
            </>
          ) : null}
        </>
      )}
    </>
  );
}
