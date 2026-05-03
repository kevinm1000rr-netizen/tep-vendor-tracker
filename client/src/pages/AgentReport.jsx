import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { categoryBadgeShort } from '../lib/labels';

function StatCard({ label, value, accent }) {
  return (
    <div
      className="dash-stat"
      style={{
        borderLeft: `4px solid ${accent}`,
      }}
    >
      <div className="dash-stat-num">{value}</div>
      <div className="dash-stat-lbl">{label}</div>
    </div>
  );
}

function EmailSendModal({ draft, vendor, settings, onClose, onSent }) {
  const [to, setTo] = useState(vendor?.vendor_email || vendor?.email || '');
  const [toName, setToName] = useState(vendor?.contact_person || '');
  const [subject, setSubject] = useState(draft?.subject || '');
  const [body, setBody] = useState(draft?.body || '');
  const [editMode, setEditMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const fromEmail = settings?.outboundFromEmail || settings?.smtpFromEmail || 'kevin@triexpressplumbing.com';
  const fromName = settings?.smtpFromName || 'Kevin | Tri Express Plumbing';

  const send = async () => {
    setBusy(true);
    setErr('');
    try {
      await api.sendEmail({
        vendorId: vendor.id,
        draftId: draft.id,
        subject,
        body,
        toEmail: to,
        toName,
      });
      onSent(vendor?.name || 'Company');
      onClose();
    } catch (e) {
      setErr(e.message || 'Send failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="email-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="email-modal-title" className="page-title" style={{ fontSize: '1.15rem' }}>
          Review &amp; send
        </h2>
        <p className="sub" style={{ marginBottom: '0.75rem' }}>
          {vendor?.name}
        </p>
        {err && <p style={{ color: 'var(--danger)', marginTop: 0 }}>{err}</p>}
        <label>
          To
          <input value={to} onChange={(e) => setTo(e.target.value)} disabled={busy} />
        </label>
        <label>
          To name (optional)
          <input value={toName} onChange={(e) => setToName(e.target.value)} disabled={busy} />
        </label>
        <label>
          From
          <input value={`${fromName} <${fromEmail || 'configure in Settings'}>`} readOnly disabled />
        </label>
        <label>
          Subject
          <input value={subject} onChange={(e) => setSubject(e.target.value)} disabled={busy || !editMode} readOnly={!editMode} />
        </label>
        <label>
          Body
          <textarea rows={14} value={body} onChange={(e) => setBody(e.target.value)} disabled={busy && !editMode} readOnly={!editMode} />
        </label>
        <div className="toolbar no-print" style={{ marginTop: '12px' }}>
          {!editMode ? (
            <>
              <button type="button" className="primary" disabled={busy || !fromEmail} onClick={send}>
                {busy ? 'Sending…' : 'Approve & Send'}
              </button>
              <button type="button" disabled={busy} onClick={() => setEditMode(true)}>
                Edit first
              </button>
              <button type="button" className="ghost" disabled={busy} onClick={onClose}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <button type="button" className="primary" disabled={busy || !fromEmail} onClick={send}>
                {busy ? 'Sending…' : 'Send'}
              </button>
              <button type="button" disabled={busy} onClick={() => setEditMode(false)}>
                Cancel edit
              </button>
            </>
          )}
        </div>
        {!settings?.smtpConfigured ? (
          <p className="sub" style={{ marginBottom: 0 }}>
            Configure SMTP in <Link to="/settings">Settings</Link> before sending.
          </p>
        ) : null}
      </div>
    </div>
  );
}

export default function AgentReport() {
  const [data, setData] = useState(null);
  const [settings, setSettings] = useState(null);
  const [err, setErr] = useState('');
  const [modal, setModal] = useState(null);
  const [toast, setToast] = useState(null);

  const load = useCallback(async () => {
    setErr('');
    try {
      const [rep, s] = await Promise.all([api.agentReport(), api.settings()]);
      setData(rep);
      setSettings(s);
    } catch (e) {
      setErr(e.message || 'Failed to load report');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(t);
  }, [toast]);

  const s = data?.summary;

  return (
    <>
      {toast ? (
        <div
          className="toast-notice"
          role="status"
          style={{
            position: 'fixed',
            bottom: 24,
            right: 24,
            zIndex: 9999,
            padding: '12px 18px',
            borderRadius: 8,
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
            fontSize: 14,
            fontWeight: 600,
            color: 'var(--text)',
          }}
        >
          {toast}
        </div>
      ) : null}
      <h1 className="page-title">Agent report</h1>
      <p className="sub">Background agent enriches records and drafts outreach; you only approve outbound email.</p>
      {err && <p style={{ color: 'var(--danger)' }}>{err}</p>}

      {s && (
        <div
          className="dash-stats-row"
          style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', marginBottom: '24px' }}
        >
          <StatCard label="Companies in database" value={s.totalCompanies} accent="#2563eb" />
          <StatCard label="New this month" value={s.newCompaniesThisMonth} accent="#7c3aed" />
          <StatCard label="Emails sent (month)" value={s.emailsSentThisMonth} accent="#0d9488" />
          <StatCard label="Vendor approvals" value={s.vendorApprovals} accent="#16a34a" />
          <StatCard label="Blocked (missing info)" value={s.companiesBlocked} accent="#ea580c" />
          <StatCard label="Emails awaiting you" value={s.emailsAwaitingApproval} accent="#dc2626" />
        </div>
      )}

      <div className="panel">
        <h3>Emails ready to send</h3>
        {!data?.emailsReady?.length ? (
          <p className="sub" style={{ margin: 0 }}>
            No drafts queued. The research agent creates outreach when a vendor has an email and is still{' '}
            <code>not_sent</code>. Run the agent from <Link to="/agent-review">Agent review</Link>.
          </p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="table-compact">
              <thead>
                <tr>
                  <th>Company</th>
                  <th>Category</th>
                  <th>Email</th>
                  <th>Subject preview</th>
                  <th>Drafted</th>
                  <th className="no-print"> </th>
                </tr>
              </thead>
              <tbody>
                {data.emailsReady.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <strong>{row.company_name}</strong>
                    </td>
                    <td>
                      <span className={`cat-pill cat-pill--${row.category}`}>{categoryBadgeShort(row.category)}</span>
                    </td>
                    <td>{row.vendor_email}</td>
                    <td style={{ maxWidth: 220 }}>{row.subject_preview || row.subject || '—'}</td>
                    <td>{row.created_at?.slice(0, 10) || '—'}</td>
                    <td className="no-print">
                      <button
                        type="button"
                        className="success"
                        onClick={() =>
                          setModal({
                            draft: row,
                            vendor: {
                              id: row.vendor_id,
                              name: row.company_name,
                              vendor_email: row.vendor_email,
                              contact_person: row.contact_person,
                            },
                          })
                        }
                      >
                        Review &amp; Send
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel">
        <h3>Blocked companies</h3>
        <p className="sub" style={{ marginTop: 0 }}>
          Missing contact fields — the agent keeps searching. Add details anytime.
        </p>
        {!data?.blocked?.length ? (
          <p className="sub" style={{ margin: 0 }}>No blocked companies.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="table-compact">
              <thead>
                <tr>
                  <th>Company</th>
                  <th>What&apos;s missing</th>
                  <th>Days in system</th>
                  <th>Agent status</th>
                  <th className="no-print"> </th>
                </tr>
              </thead>
              <tbody>
                {data.blocked.map((b) => (
                  <tr key={b.id}>
                    <td>{b.name}</td>
                    <td>{(b.missingLabels || []).join(', ') || '—'}</td>
                    <td>{b.daysInSystem}</td>
                    <td>{b.agentStatus}</td>
                    <td className="no-print">
                      <Link to="/tracker" className="btn-secondary">
                        Add info
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel">
        <h3>Open issues</h3>
        <p className="sub" style={{ marginTop: 0 }}>Only items the agent cannot finish alone.</p>
        {!data?.openIssues?.length ? (
          <p className="sub" style={{ margin: 0 }}>No open issues.</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: '1.1rem' }}>
            {data.openIssues.map((issue, i) => (
              <li key={`${issue.kind}-${i}`} style={{ marginBottom: '0.5rem' }}>
                <strong>{issue.title}</strong>
                <div className="sub" style={{ margin: '0.15rem 0 0' }}>
                  {issue.detail}
                </div>
                {issue.kind === 'prospect_confirm' && issue.suggested_company_id ? (
                  <div className="toolbar" style={{ marginTop: '0.35rem' }}>
                    <button
                      type="button"
                      className="primary"
                      onClick={async () => {
                        try {
                          await api.agentApproveSuggestedCompany(issue.suggested_company_id);
                          await load();
                        } catch (e) {
                          setErr(e.message);
                        }
                      }}
                    >
                      Approve add
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await api.agentRejectSuggestedCompany(issue.suggested_company_id);
                          await load();
                        } catch (e) {
                          setErr(e.message);
                        }
                      }}
                    >
                      Dismiss
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="toolbar no-print">
        <Link to="/tracker" className="btn-primary">
          Open tracker
        </Link>
        <Link to="/agent-review" className="btn-secondary">
          Agent review
        </Link>
        <Link to="/agent-tasks" className="btn-secondary">
          Activity log
        </Link>
      </div>

      {modal ? (
        <EmailSendModal
          draft={modal.draft}
          vendor={modal.vendor}
          settings={settings}
          onClose={() => setModal(null)}
          onSent={(name) => {
            setToast(`Email sent to ${name} ✓`);
            load();
          }}
        />
      ) : null}
    </>
  );
}
