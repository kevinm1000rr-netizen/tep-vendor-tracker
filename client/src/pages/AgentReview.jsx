import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { categoryLabel } from '../lib/labels';

export default function AgentReview() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [rowBusy, setRowBusy] = useState(null);

  const load = useCallback(async () => {
    setErr('');
    try {
      const [runs, pendingProspects, emailDrafts] = await Promise.all([
        api.agentRuns(25),
        api.agentSuggestedCompanies('pending'),
        api.agentEmailDrafts({ limit: 100 }),
      ]);
      setData({ runs, pendingFieldUpdates: [], pendingProspects, emailDrafts });
    } catch (e) {
      setErr(e.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const runNow = async () => {
    setBusy(true);
    setErr('');
    try {
      await api.agentRunNow();
      await load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const actProspect = async (id, action) => {
    const key = `p-${id}-${action}`;
    setRowBusy(key);
    setErr('');
    try {
      if (action === 'approve') await api.agentApproveSuggestedCompany(id);
      else await api.agentRejectSuggestedCompany(id);
      await load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setRowBusy(null);
    }
  };

  const fields = data?.pendingFieldUpdates || [];
  const prospects = data?.pendingProspects || [];
  const runs = data?.runs || [];
  const emailDrafts = data?.emailDrafts || [];

  return (
    <>
      <h1 className="page-title">Agent Review</h1>
      <p className="sub">
        Run or monitor the research agent. New companies need your confirmation; vendor fields are filled automatically.
        Approve outbound email on the Agent report.
      </p>
      {err && <p style={{ color: 'var(--danger)' }}>{err}</p>}

      <div className="toolbar no-print">
        <button type="button" className="primary" disabled={busy} onClick={runNow}>
          {busy ? 'Starting…' : 'Run research agent now'}
        </button>
        <button type="button" onClick={load} disabled={busy}>
          Refresh
        </button>
        <Link to="/tracker" className="btn-secondary">
          Tracker
        </Link>
        <Link to="/settings" className="btn-secondary">
          API keys
        </Link>
      </div>

      <div className="panel">
        <h3>Vendor field updates</h3>
        <p className="sub" style={{ margin: 0 }}>
          The background agent now <strong>writes verified fields directly</strong> to the tracker. Legacy queued rows
          (if any) were auto-applied on upgrade. Nothing here requires approval.
        </p>
        {fields.length > 0 ? (
          <p className="sub" style={{ margin: '0.5rem 0 0' }}>
            {fields.length} legacy row(s) still marked pending — you can ignore them or clear from the database.
          </p>
        ) : null}
      </div>

      <div className="panel">
        <h3>New companies (pending)</h3>
        {prospects.length === 0 ? (
          <p className="sub" style={{ margin: 0 }}>
            None pending. Discovery needs SerpApi + Anthropic keys in Settings.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {prospects.map((p) => (
              <div key={p.id} className="panel" style={{ margin: 0, padding: '0.75rem' }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'baseline' }}>
                  <strong>{p.name}</strong>
                  <span className="badge">{categoryLabel(p.category)}</span>
                  {p.prospect_subtype ? (
                    <span className="badge priority-medium">{p.prospect_subtype}</span>
                  ) : null}
                </div>
                <p className="sub" style={{ margin: '0.35rem 0' }}>
                  {[p.phone, p.email, p.website, p.address].filter(Boolean).join(' · ') || '—'}
                </p>
                {p.tenure_evidence_summary ? (
                  <p style={{ fontSize: '0.9rem', margin: '0.25rem 0' }}>
                    <strong>Tenure evidence:</strong> {p.tenure_evidence_summary}
                  </p>
                ) : null}
                {Array.isArray(p.evidence_urls) && p.evidence_urls.length > 0 ? (
                  <ul style={{ margin: '0.25rem 0', paddingLeft: '1.25rem', fontSize: '0.85rem' }}>
                    {p.evidence_urls.slice(0, 8).map((u, i) => (
                      <li key={i}>
                        <a href={u.url} target="_blank" rel="noreferrer">
                          {u.title || u.url}
                        </a>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {p.outreach_email_draft ? (
                  <div style={{ marginTop: '0.5rem' }}>
                    <strong>Draft email</strong>
                    <pre className="output-pre" style={{ marginTop: '0.35rem', whiteSpace: 'pre-wrap', fontSize: '0.85rem' }}>
                      {p.outreach_email_draft}
                    </pre>
                  </div>
                ) : null}
                <div className="toolbar no-print" style={{ marginTop: '0.5rem' }}>
                  <button
                    type="button"
                    className="primary"
                    disabled={rowBusy === `p-${p.id}-approve`}
                    onClick={() => actProspect(p.id, 'approve')}
                  >
                    Approve → add to Tracker
                  </button>
                  <button
                    type="button"
                    disabled={rowBusy === `p-${p.id}-reject`}
                    onClick={() => actProspect(p.id, 'reject')}
                  >
                    Reject
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="panel">
        <h3>Email drafts</h3>
        {emailDrafts.length === 0 ? (
          <p className="sub" style={{ margin: 0 }}>
            No drafts yet.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Status</th>
                <th>Company / vendor</th>
                <th>Subject</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {emailDrafts.map((d) => (
                <tr key={d.id}>
                  <td>{d.id}</td>
                  <td>{d.status}</td>
                  <td>{d.suggested_company_name || d.vendor_name || '—'}</td>
                  <td style={{ maxWidth: 240, fontSize: '0.85rem' }}>{d.subject || '—'}</td>
                  <td>{d.created_at}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel">
        <h3>Recent agent runs</h3>
        {runs.length === 0 ? (
          <p className="sub" style={{ margin: 0 }}>
            No runs logged yet.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Started</th>
                <th>Status</th>
                <th>Summary</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td>{r.id}</td>
                  <td>{r.started_at}</td>
                  <td>{r.status}</td>
                  <td style={{ maxWidth: 360, fontSize: '0.85rem' }}>
                    {r.summary
                      ? `${r.summary.vendorFieldUpdates ?? 0} field updates · ${r.summary.newProspects ?? 0} prospects`
                      : '—'}
                    {r.summary?.skippedNoSearchKeys ? ' · no search keys' : ''}
                    {r.summary?.discoverySkippedNoSerpApi ? ' · discovery needs SerpApi' : ''}
                    {r.summary?.skippedNoAiKeyForDiscovery ? ' · discovery needs Anthropic key' : ''}
                  </td>
                  <td style={{ color: r.error_message ? 'var(--danger)' : undefined, fontSize: '0.85rem' }}>
                    {r.error_message || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
