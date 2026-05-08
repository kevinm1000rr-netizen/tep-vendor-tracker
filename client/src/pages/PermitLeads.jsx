import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, downloadPermitCsv } from '../api';

const FOCUS_CITIES = [
  'Carlsbad',
  'Chula Vista',
  'Coronado',
  'Del Mar',
  'Encinitas',
  'Imperial Beach',
  'La Jolla',
  'Mission Beach',
  'Mission Valley',
  'Pacific Beach',
  'Point Loma',
  'Solana Beach',
];

/** Permit issuing jurisdiction (data source), aligned with server registry. */
const CANONICAL_SOURCE_JURISDICTIONS = [
  'San Diego',
  'Chula Vista',
  'National City',
  'El Cajon',
  'La Mesa',
  'Poway',
  'Santee',
  'Escondido',
  'San Marcos',
  'Coronado',
  'Del Mar',
  'Solana Beach',
];
const CANONICAL_SOURCE_LOWER = new Set(CANONICAL_SOURCE_JURISDICTIONS.map((c) => c.toLowerCase()));

function sourceCityBadgeClass(label) {
  const raw = String(label || 'San Diego').trim();
  const slug = raw.toLowerCase().replace(/\s+/g, '-');
  const known = CANONICAL_SOURCE_LOWER.has(raw.toLowerCase());
  return known ? `permit-source-badge permit-src--${slug}` : 'permit-source-badge permit-src--other';
}

function scoreClass(score) {
  const n = Number(score) || 0;
  if (n >= 8) return 'permit-hot';
  if (n >= 5) return 'permit-warm';
  return 'permit-cold';
}

const VIEW_TABS = [
  { id: 'pipeline', label: 'Pipeline', countKey: 'pipelineCount', hint: 'Active leads (excludes Don\u2019t Pursue + Deleted)' },
  { id: 'pursue', label: 'Pursuing', countKey: 'pursueCount', hint: 'Marked Pursue + already worked' },
  { id: 'pass', label: "Don't Pursue", countKey: 'passCount', hint: 'Passed leads (hidden from Pipeline)' },
  { id: 'deleted', label: 'Deleted', countKey: 'deletedCount', hint: 'Soft-deleted leads (Restore to bring back)' },
  { id: 'all', label: 'All', countKey: null, hint: 'Every lead, no status filter' },
];

export default function PermitLeads() {
  const [rows, setRows] = useState([]);
  const [stats, setStats] = useState(null);
  const [runs, setRuns] = useState([]);
  const [view, setView] = useState('pipeline');
  const [filters, setFilters] = useState({
    permit_type: '',
    city: '',
    source_city: '',
    status: '',
    minScore: '',
    search: '',
  });
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [selected, setSelected] = useState(null);
  const [callScript, setCallScript] = useState('');
  const [showRuns, setShowRuns] = useState(false);
  const [agentState, setAgentState] = useState({ running: false, message: '' });

  const load = useCallback(async () => {
    setErr('');
    const q = {
      permit_type: filters.permit_type,
      status: filters.status,
      view,
      search: filters.search,
      city: filters.city === 'other' ? '' : filters.city || undefined,
      source_city: filters.source_city === 'other' ? '' : filters.source_city || undefined,
      minScore: filters.minScore ? Number(filters.minScore) : undefined,
    };
    const [leadData, runData] = await Promise.all([api.permitLeads(q), api.permitRuns(30)]);
    setRows(Array.isArray(leadData?.rows) ? leadData.rows : []);
    setStats(leadData?.stats || null);
    setRuns(Array.isArray(runData) ? runData : []);
  }, [filters, view]);

  useEffect(() => {
    load().catch((e) => setErr(e.message || 'Load failed'));
  }, [load]);

  useEffect(() => {
    if (!selected) return undefined;
    const onKeyDown = (e) => {
      if (e.key === 'Escape') setSelected(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selected]);

  const cityOptions = useMemo(() => {
    const set = new Set(rows.map((r) => r.city).filter(Boolean));
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [rows]);

  const filteredRows = useMemo(() => {
    let list = rows;
    if (filters.city === 'other') {
      list = list.filter((r) => {
        const c = String(r.city || '').trim();
        return c && !FOCUS_CITIES.includes(c);
      });
    }
    if (filters.source_city === 'other') {
      list = list.filter((r) => {
        const s = String(r.source_city || 'San Diego').trim().toLowerCase();
        return s && !CANONICAL_SOURCE_LOWER.has(s);
      });
    }
    return list;
  }, [rows, filters.city, filters.source_city]);

  const openLead = async (id) => {
    setErr('');
    try {
      const lead = await api.permitLead(id);
      setSelected(lead);
      setCallScript('');
    } catch (e) {
      setErr(e.message || 'Failed to load lead');
    }
  };

  const patchSelected = async (patch) => {
    if (!selected) return;
    const next = await api.patchPermitLead(selected.id, patch);
    setSelected(next);
    await load();
  };

  return (
    <>
      <h1 className="page-title">Permit Leads</h1>
      <p className="sub">
        County-wide permit intelligence (City of San Diego automated; other jurisdictions wired next). Scoring,
        outreach drafts, and pipeline tracking.
      </p>
      {err ? <p style={{ color: 'var(--danger)' }}>{err}</p> : null}

      <div className="dash-stats-row">
        <div className="dash-stat dash-stat--red">
          <div className="dash-stat-num">{stats?.newToday ?? 0}</div>
          <div className="dash-stat-lbl">New Leads Today</div>
        </div>
        <div className="dash-stat dash-stat--blue">
          <div className="dash-stat-num">{stats?.activeTotal ?? 0}</div>
          <div className="dash-stat-lbl">Total Active Leads</div>
        </div>
        <div className="dash-stat dash-stat--purple">
          <div className="dash-stat-num">{stats?.contactedMonth ?? 0}</div>
          <div className="dash-stat-lbl">Contacted This Month</div>
        </div>
        <div className="dash-stat dash-stat--green">
          <div className="dash-stat-num">{stats?.converted ?? 0}</div>
          <div className="dash-stat-lbl">Converted to Vendor</div>
        </div>
      </div>

      <div className="panel" style={{ marginTop: 0 }}>
        <div className="toolbar" style={{ flexWrap: 'wrap', gap: '0.4rem', marginBottom: '0.6rem' }}>
          {VIEW_TABS.map((tab) => {
            const active = view === tab.id;
            const count = tab.countKey ? stats?.[tab.countKey] : null;
            return (
              <button
                key={tab.id}
                type="button"
                className={active ? 'primary' : ''}
                title={tab.hint}
                onClick={() => setView(tab.id)}
                style={{ fontWeight: active ? 600 : 400 }}
              >
                {tab.label}
                {count != null ? ` (${count})` : ''}
              </button>
            );
          })}
        </div>
        <div className="toolbar">
          <select value={filters.permit_type} onChange={(e) => setFilters({ ...filters, permit_type: e.target.value })}>
            <option value="">All permit types</option>
            <option value="ADU">ADU</option>
            <option value="New Construction">New Construction</option>
            <option value="Remodel">Remodel</option>
            <option value="Addition">Addition</option>
          </select>
          <select
            value={filters.source_city}
            onChange={(e) => setFilters({ ...filters, source_city: e.target.value })}
            title="Issuing jurisdiction (data source)"
          >
            <option value="">All source cities</option>
            {CANONICAL_SOURCE_JURISDICTIONS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
            <option value="other">Other source</option>
          </select>
          <select value={filters.city} onChange={(e) => setFilters({ ...filters, city: e.target.value })}>
            <option value="">All site cities</option>
            {FOCUS_CITIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
            <option value="other">Other site</option>
            {cityOptions
              .filter((c) => !FOCUS_CITIES.includes(c))
              .slice(0, 12)
              .map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
          </select>
          <select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
            <option value="">Status (within tab)</option>
            <option value="new">new</option>
            <option value="pursuing">pursuing</option>
            <option value="contacted">contacted</option>
            <option value="responded">responded</option>
            <option value="converted">converted</option>
            <option value="not_interested">not_interested</option>
            <option value="deleted">deleted</option>
          </select>
          <select value={filters.minScore} onChange={(e) => setFilters({ ...filters, minScore: e.target.value })}>
            <option value="">All scores</option>
            <option value="8">8+</option>
            <option value="5">5+</option>
            <option value="1">1+</option>
          </select>
          <input
            placeholder="Search contractor or address"
            value={filters.search}
            onChange={(e) => setFilters({ ...filters, search: e.target.value })}
          />
          <button
            type="button"
            className="primary"
            disabled={busy === 'run'}
            onClick={async () => {
              setBusy('run');
              setAgentState({ running: true, message: 'Permit agent is running…' });
              try {
                const out = await api.permitRunNow();
                setAgentState({
                  running: false,
                  message:
                    out?.summary ||
                    out?.message ||
                    'Run complete.',
                });
                await load();
              } catch (e) {
                const msg = String(e.message || 'Run failed');
                if (/not found|cannot post/i.test(msg)) {
                  setErr('Permit endpoint not found on current backend process. Restart app to load latest server routes.');
                } else {
                  setErr(msg);
                }
                setAgentState({ running: false, message: 'Run failed.' });
              } finally {
                setBusy('');
              }
            }}
          >
            {busy === 'run' ? 'Running…' : 'Run Agent Now'}
          </button>
          <button type="button" onClick={downloadPermitCsv}>
            Export CSV
          </button>
        </div>
        <p className="sub" style={{ margin: 0 }}>
          Agent status:{' '}
          <strong>{agentState.running ? 'Running' : 'Idle'}</strong>
          {agentState.message ? ` · ${agentState.message}` : ''}
          {!agentState.running && runs[0]?.created_at ? ` · Last run ${String(runs[0].created_at).slice(0, 19)}` : ''}
        </p>
      </div>

      <div className="panel">
        <table className="table-compact">
          <thead>
            <tr>
              <th>Lead Score</th>
              <th>Source City</th>
              <th>Contractor Name</th>
              <th>Permit Type</th>
              <th>Address/City</th>
              <th>Project Value</th>
              <th>Date Submitted</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((r) => (
              <tr key={r.id} onClick={() => openLead(r.id)} style={{ cursor: 'pointer' }}>
                <td>
                  <span className={`badge ${scoreClass(r.lead_score)}`}>{r.lead_score}/10</span>
                </td>
                <td>
                  <span className={sourceCityBadgeClass(r.source_city)} title="Issuing jurisdiction">
                    {r.source_city || 'San Diego'}
                  </span>
                </td>
                <td>{r.contractor_name || '—'}</td>
                <td>
                  <span className="badge">{r.permit_type}</span>
                </td>
                <td>
                  {r.address}
                  <br />
                  <span className="sub">{r.city}</span>
                </td>
                <td>{Number(r.project_value || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })}</td>
                <td>{r.date_submitted || '—'}</td>
                <td>
                  <span className="badge">{r.status}</span>
                </td>
                <td>
                  <div className="row-actions">
                    <button type="button" onClick={() => openLead(r.id)}>
                      View
                    </button>
                    {r.status === 'deleted' ? (
                      <button
                        type="button"
                        title="Restore from Deleted"
                        onClick={(e) => {
                          e.stopPropagation();
                          api.patchPermitLead(r.id, { status: 'new' }).then(load);
                        }}
                      >
                        Restore
                      </button>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            api.sendPermitLeadEmail(r.id).then(load);
                          }}
                        >
                          Send Email
                        </button>
                        {r.status !== 'pursuing' && r.status !== 'contacted' && r.status !== 'responded' && r.status !== 'converted' ? (
                          <button
                            type="button"
                            title="Mark as a lead Tri Express will pursue"
                            onClick={(e) => {
                              e.stopPropagation();
                              api.patchPermitLead(r.id, { status: 'pursuing' }).then(load);
                            }}
                          >
                            Pursue
                          </button>
                        ) : null}
                        {r.status !== 'not_interested' ? (
                          <button
                            type="button"
                            title="Don\u2019t pursue (hidden from Pipeline)"
                            onClick={(e) => {
                              e.stopPropagation();
                              api.patchPermitLead(r.id, { status: 'not_interested' }).then(load);
                            }}
                          >
                            Pass
                          </button>
                        ) : (
                          <button
                            type="button"
                            title="Restore to Pipeline"
                            onClick={(e) => {
                              e.stopPropagation();
                              api.patchPermitLead(r.id, { status: 'new' }).then(load);
                            }}
                          >
                            Restore
                          </button>
                        )}
                        <button
                          type="button"
                          title="Soft-delete (move to Deleted tab)"
                          onClick={(e) => {
                            e.stopPropagation();
                            api.patchPermitLead(r.id, { status: 'deleted' }).then(load);
                          }}
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selected ? (
        <div className="permit-drawer-backdrop" onClick={() => setSelected(null)}>
          <aside className="permit-drawer-panel" onClick={(e) => e.stopPropagation()}>
            <div className="toolbar" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ margin: 0 }}>Lead Detail</h3>
              <div className="toolbar" style={{ gap: '0.5rem' }}>
                <span className="sub" style={{ fontSize: 12 }}>
                  Press Esc to close
                </span>
                <button type="button" onClick={() => setSelected(null)}>
                  Close
                </button>
              </div>
            </div>
            <p className="sub">
              <span className={sourceCityBadgeClass(selected.source_city)} style={{ marginRight: 8 }}>
                {selected.source_city || 'San Diego'}
              </span>
              Permit #{selected.permit_number} · {selected.permit_type} · site: {selected.city}
            </p>
            <div className="toolbar">
              <select value={selected.status} onChange={(e) => patchSelected({ status: e.target.value })}>
                <option value="new">new</option>
                <option value="pursuing">pursuing</option>
                <option value="contacted">contacted</option>
                <option value="responded">responded</option>
                <option value="converted">converted</option>
                <option value="not_interested">not_interested (Don&rsquo;t Pursue)</option>
                <option value="deleted">deleted</option>
              </select>
            </div>
            <p>
              <strong>Contractor:</strong> {selected.contractor_name || '—'}<br />
              <strong>License:</strong> {selected.contractor_license || '—'}<br />
              <strong>Phone:</strong> {selected.contractor_phone || '—'}<br />
              <strong>Email:</strong> {selected.contractor_email || '—'}
            </p>
            <label>
              AI Email Draft
              <textarea
                rows={8}
                value={selected.email_draft || ''}
                onChange={(e) => setSelected({ ...selected, email_draft: e.target.value })}
              />
            </label>
            <div className="toolbar">
              <button
                type="button"
                className="primary"
                onClick={() =>
                  api.sendPermitLeadEmail(selected.id, { email_draft: selected.email_draft }).then(
                    openLead.bind(null, selected.id)
                  )
                }
              >
                Send Email
              </button>
              <button
                type="button"
                onClick={() => api.regeneratePermitLeadEmail(selected.id).then(openLead.bind(null, selected.id))}
              >
                Regenerate Email
              </button>
              <button
                type="button"
                onClick={async () => {
                  const out = await api.permitLeadCallScript(selected.id);
                  setCallScript(out.text || '');
                }}
              >
                Call Script
              </button>
              <button
                type="button"
                onClick={() =>
                  patchSelected({ notes: selected.notes || '', email_draft: selected.email_draft || '' })
                }
              >
                Save
              </button>
            </div>
            <label>
              Notes / Activity Log
              <textarea
                rows={5}
                value={selected.notes || ''}
                onChange={(e) => setSelected({ ...selected, notes: e.target.value })}
              />
            </label>
            {callScript ? <pre className="output-pre" style={{ marginTop: '0.75rem' }}>{callScript}</pre> : null}
          </aside>
        </div>
      ) : null}

      <div className="panel">
        <div className="toolbar" style={{ justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>Agent Run History</h3>
          <button type="button" onClick={() => setShowRuns((v) => !v)}>
            {showRuns ? 'Hide' : 'Show'}
          </button>
        </div>
        {showRuns ? (
          <table className="table-compact">
            <thead>
              <tr>
                <th>Date</th>
                <th>Permits Found</th>
                <th>New Leads</th>
                <th>Leads Contacted</th>
                <th>Summary</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td>{r.run_date || r.created_at}</td>
                  <td>{r.permits_found}</td>
                  <td>{r.new_leads_added}</td>
                  <td>{r.leads_contacted}</td>
                  <td>{r.summary || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="sub" style={{ margin: 0 }}>Collapsed. Click Show to view last 30 runs.</p>
        )}
      </div>
    </>
  );
}
