import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';

function formatSummary(s) {
  if (!s || typeof s !== 'object') return '';
  const parts = [];
  if (s.vendorFieldUpdates != null) parts.push(`${s.vendorFieldUpdates} field updates`);
  if (s.vendorsAutoRegistered != null && s.vendorsAutoRegistered > 0) {
    parts.push(`${s.vendorsAutoRegistered} vendors added`);
  } else if (s.newProspects != null) parts.push(`${s.newProspects} prospects`);
  if (s.outreachDraftsCreated != null) parts.push(`${s.outreachDraftsCreated} drafts`);
  if (s.skippedNoSearchKeys) parts.push('no search keys');
  if (s.discoverySkippedNoPlacesApi) parts.push('no Google Places key for discovery');
  return parts.join(' · ') || '—';
}

export default function AgentActivityLog() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    setErr('');
    try {
      const d = await api.agentActivity(120);
      setData(d);
    } catch (e) {
      setErr(e.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <>
      <h1 className="page-title">Agent activity log</h1>
      <p className="sub">
        Silent background runs, auto-filled fields, and drafted emails. Approvals only happen on the{' '}
        <Link to="/">Agent report</Link> when you send mail.
      </p>
      {err && <p style={{ color: 'var(--danger)' }}>{err}</p>}

      <div className="toolbar no-print">
        <Link to="/" className="btn-primary">
          Agent report
        </Link>
        <Link to="/agent-review" className="btn-secondary">
          Agent review
        </Link>
        <button type="button" onClick={load}>
          Refresh
        </button>
      </div>

      <div className="panel">
        <h3>Recent agent runs</h3>
        {!data?.runs?.length ? (
          <p className="sub" style={{ margin: 0 }}>
            No runs yet.
          </p>
        ) : (
          <table className="table-compact">
            <thead>
              <tr>
                <th>ID</th>
                <th>Started</th>
                <th>Status</th>
                <th>Results</th>
              </tr>
            </thead>
            <tbody>
              {data.runs.map((r) => (
                <tr key={r.id}>
                  <td>{r.id}</td>
                  <td>{r.started_at}</td>
                  <td>{r.status}</td>
                  <td style={{ fontSize: '0.85rem' }}>{formatSummary(r.summary)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel">
        <h3>Companies added this week</h3>
        {!data?.vendorsThisWeek?.length ? (
          <p className="sub" style={{ margin: 0 }}>
            None.
          </p>
        ) : (
          <table className="table-compact">
            <thead>
              <tr>
                <th>Name</th>
                <th>Category</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {data.vendorsThisWeek.map((v) => (
                <tr key={v.id}>
                  <td>{v.name}</td>
                  <td>{v.category}</td>
                  <td>{v.created_at}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel">
        <h3>Auto-fill &amp; agent notes</h3>
        {!data?.activity?.length ? (
          <p className="sub" style={{ margin: 0 }}>
            No activity rows yet.
          </p>
        ) : (
          <table className="table-compact">
            <thead>
              <tr>
                <th>When</th>
                <th>Type</th>
                <th>Vendor</th>
                <th>Summary</th>
              </tr>
            </thead>
            <tbody>
              {data.activity.map((a) => (
                <tr key={a.id}>
                  <td>{a.created_at}</td>
                  <td>{a.activity_type}</td>
                  <td>{a.vendor_name || '—'}</td>
                  <td>{a.summary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel">
        <h3>Email drafts (recent)</h3>
        {!data?.drafts?.length ? (
          <p className="sub" style={{ margin: 0 }}>
            None.
          </p>
        ) : (
          <table className="table-compact">
            <thead>
              <tr>
                <th>ID</th>
                <th>Status</th>
                <th>Vendor</th>
                <th>Subject</th>
              </tr>
            </thead>
            <tbody>
              {data.drafts.slice(0, 40).map((d) => (
                <tr key={d.id}>
                  <td>{d.id}</td>
                  <td>{d.status}</td>
                  <td>{d.vendor_name || d.suggested_company_name || '—'}</td>
                  <td style={{ maxWidth: 260 }}>{d.subject || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
