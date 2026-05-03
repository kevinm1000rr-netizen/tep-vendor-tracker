import { Fragment, useCallback, useEffect, useState } from 'react';
import { api, downloadCsv } from '../api';
import StatusBadge from '../components/StatusBadge';
import { categoryBadgeShort, daysSince, LETTER_VERSION_TAG } from '../lib/labels';

const emptyEdit = {
  name: '',
  contact_person: '',
  email: '',
  phone: '',
  website: '',
  years_in_business: '',
  address: '',
  category: 'restoration',
  status: 'not_sent',
  notes: '',
};

export default function Tracker() {
  const [tab, setTab] = useState('all');
  const [vendors, setVendors] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [filterCat, setFilterCat] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [expanded, setExpanded] = useState(null);
  /** After opening a row: which field to focus (inline forms, no modals). */
  const [editFocus, setEditFocus] = useState(null);
  const [edit, setEdit] = useState(emptyEdit);
  const [followNote, setFollowNote] = useState('');
  const [aiLetter, setAiLetter] = useState('');
  const [aiFollow, setAiFollow] = useState('');
  const [aiCall, setAiCall] = useState('');
  const [loadingAi, setLoadingAi] = useState('');
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    setErr('');
    try {
      const q = {};
      if (filterCat) q.category = filterCat;
      if (filterStatus) q.status = filterStatus;
      const [v, a] = await Promise.all([api.vendors(q), api.alerts()]);
      setVendors(v);
      setAlerts(a);
    } catch (e) {
      setErr(e.message);
    }
  }, [filterCat, filterStatus]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    setExpanded(null);
    setEditFocus(null);
  }, [tab]);

  useEffect(() => {
    if (!expanded || !editFocus) return;
    const idMap = {
      notes: `vendor-notes-${expanded}`,
      contact: `vendor-contact-${expanded}`,
      follow: `follow-note-${expanded}`,
    };
    const id = idMap[editFocus];
    const t = setTimeout(() => document.getElementById(id)?.focus(), 0);
    return () => clearTimeout(t);
  }, [expanded, editFocus]);

  const closePanel = () => {
    setExpanded(null);
    setEditFocus(null);
  };

  const openEdit = (v, focus = 'contact') => {
    setExpanded(v.id);
    setEditFocus(focus);
    setEdit({
      name: v.name,
      contact_person: v.contact_person || '',
      email: v.email || '',
      phone: v.phone || '',
      website: v.website || '',
      years_in_business: v.years_in_business || '',
      address: v.address || '',
      category: v.category,
      status: v.status,
      notes: v.notes || '',
    });
    setFollowNote('');
    setAiLetter('');
    setAiFollow('');
    setAiCall('');
  };

  const saveEdit = async () => {
    if (!expanded) return;
    await api.patchVendor(expanded, edit);
    await load();
  };

  const markSent = async () => {
    if (!expanded) return;
    await api.markSent(expanded, LETTER_VERSION_TAG);
    await load();
    setAiLetter('');
  };

  const logFollow = async () => {
    if (!expanded) return;
    await api.logFollowup(expanded, followNote);
    setFollowNote('');
    await load();
  };

  const genLetter = async () => {
    if (!expanded) return;
    setLoadingAi('letter');
    setErr('');
    try {
      const r = await api.generateLetter(expanded);
      setAiLetter(r.text);
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoadingAi('');
    }
  };

  const genFollow = async () => {
    if (!expanded) return;
    setLoadingAi('follow');
    setErr('');
    try {
      const r = await api.generateFollowUp(expanded);
      setAiFollow(r.text);
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoadingAi('');
    }
  };

  const genCall = async () => {
    if (!expanded) return;
    setLoadingAi('call');
    setErr('');
    try {
      const r = await api.generateCallScript(expanded);
      setAiCall(r.text);
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoadingAi('');
    }
  };

  const copy = (t) => {
    if (t) navigator.clipboard.writeText(t);
  };

  const printLetter = () => {
    window.print();
  };

  const showFollowUpBtn = (v) =>
    v.status === 'sent' && v.date_sent && daysSince(v.date_sent) >= 30;

  const rows = tab === 'alerts' ? alerts : vendors;

  return (
    <>
      <h1 className="page-title">Vendor tracker</h1>
      <p className="sub">
        {vendors.length} companies · filters apply to the table · Monthly alerts tab shows due follow-ups.
      </p>
      {err && <p style={{ color: 'var(--danger)' }}>{err}</p>}

      <div className="tabs">
        <button type="button" className={tab === 'all' ? 'active' : ''} onClick={() => setTab('all')}>
          All companies
        </button>
        <button type="button" className={tab === 'alerts' ? 'active' : ''} onClick={() => setTab('alerts')}>
          Monthly alerts
        </button>
      </div>

      {tab === 'all' && (
        <div className="tracker-filters no-print">
          <select value={filterCat} onChange={(e) => setFilterCat(e.target.value)}>
            <option value="">All categories</option>
            <option value="restoration">Restoration</option>
            <option value="property_mgmt">Property management</option>
            <option value="hoa">HOA</option>
            <option value="contractor">ADU / Contractor</option>
          </select>
          <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
            <option value="">All statuses</option>
            <option value="not_sent">Not sent</option>
            <option value="sent">Sent</option>
            <option value="responded">Responded</option>
            <option value="approved">Approved</option>
          </select>
          <button type="button" onClick={() => downloadCsv()}>
            Export CSV
          </button>
        </div>
      )}

      <div style={{ overflowX: 'auto' }}>
        <table className="table-compact tracker-table">
          <thead>
            <tr>
              <th>Company</th>
              <th>Category</th>
              <th>Status</th>
              <th>Contact / phone</th>
              <th>Next follow-up</th>
              <th className="no-print">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((v) => (
              <Fragment key={v.id}>
                <tr className={tab === 'alerts' ? `alert-row ${v.alertLevel || ''}` : ''}>
                  <td>{v.name}</td>
                  <td>
                    {v.category && ['restoration', 'property_mgmt', 'hoa', 'contractor'].includes(v.category) ? (
                      <span className={`cat-pill cat-pill--${v.category}`}>{categoryBadgeShort(v.category)}</span>
                    ) : (
                      <span className="cat-pill cat-pill--none">—</span>
                    )}
                  </td>
                  <td>
                    <StatusBadge status={v.status} />
                  </td>
                  <td>
                    {v.contact_person && <div>{v.contact_person}</div>}
                    {v.phone && <div>{v.phone}</div>}
                    {!v.contact_person && !v.phone && '—'}
                  </td>
                  <td>{v.next_followup_date || '—'}</td>
                  <td className="no-print">
                    <div className="row-actions">
                      {expanded === v.id ? (
                        <button type="button" className="btn-icon" onClick={closePanel} title="Close" aria-label="Close">
                          ✕
                        </button>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="btn-icon"
                            onClick={() => openEdit(v, 'contact')}
                            title="Edit contact"
                            aria-label="Edit contact"
                          >
                            ✏️
                          </button>
                          <button
                            type="button"
                            className="btn-icon"
                            onClick={() => openEdit(v, 'notes')}
                            title="Notes"
                            aria-label="Notes"
                          >
                            📝
                          </button>
                          <button
                            type="button"
                            className="btn-icon"
                            onClick={() => api.markSent(v.id, LETTER_VERSION_TAG).then(load)}
                            title="Mark sent"
                            aria-label="Mark sent"
                          >
                            📤
                          </button>
                          <button
                            type="button"
                            className="btn-icon"
                            onClick={() => {
                              openEdit(v, 'follow');
                              setFollowNote('');
                            }}
                            title="Log follow-up"
                            aria-label="Log follow-up"
                          >
                            📞
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
                {expanded === v.id && (
                  <tr key={`${v.id}-detail`} className="no-print">
                    <td colSpan={6} style={{ background: 'var(--surface)', borderBottom: '2px solid var(--border)' }}>
                      <div className="panel" style={{ margin: 0 }}>
                        <h3>Edit contact & notes</h3>
                        <div
                          style={{
                            display: 'grid',
                            gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
                            gap: '0.5rem',
                          }}
                        >
                          <label>
                            Company name
                            <input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
                          </label>
                          <label>
                            Contact person
                            <input
                              id={`vendor-contact-${v.id}`}
                              value={edit.contact_person}
                              onChange={(e) => setEdit({ ...edit, contact_person: e.target.value })}
                            />
                          </label>
                          <label>
                            Email
                            <input
                              type="email"
                              value={edit.email}
                              onChange={(e) => setEdit({ ...edit, email: e.target.value })}
                            />
                          </label>
                          <label>
                            Phone
                            <input value={edit.phone} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} />
                          </label>
                          <label>
                            Category
                            <select
                              value={edit.category}
                              onChange={(e) => setEdit({ ...edit, category: e.target.value })}
                            >
                              <option value="restoration">Restoration</option>
                              <option value="property_mgmt">Property management</option>
                              <option value="hoa">HOA</option>
                              <option value="contractor">ADU / Contractor</option>
                            </select>
                          </label>
                          <label>
                            Status
                            <select value={edit.status} onChange={(e) => setEdit({ ...edit, status: e.target.value })}>
                              <option value="not_sent">Not sent</option>
                              <option value="sent">Sent</option>
                              <option value="responded">Responded</option>
                              <option value="approved">Approved</option>
                            </select>
                          </label>
                        </div>
                        <h3 style={{ marginTop: '0.75rem' }}>Business profile</h3>
                        <div
                          style={{
                            display: 'grid',
                            gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
                            gap: '0.5rem',
                          }}
                        >
                          <label>
                            Website
                            <input
                              type="url"
                              placeholder="https://"
                              value={edit.website}
                              onChange={(e) => setEdit({ ...edit, website: e.target.value })}
                            />
                          </label>
                          <label>
                            Years in business
                            <input
                              placeholder="e.g. 15 or 40+"
                              value={edit.years_in_business}
                              onChange={(e) => setEdit({ ...edit, years_in_business: e.target.value })}
                            />
                          </label>
                          <label style={{ gridColumn: '1 / -1' }}>
                            Address / city
                            <input
                              placeholder="City or full address"
                              value={edit.address}
                              onChange={(e) => setEdit({ ...edit, address: e.target.value })}
                            />
                          </label>
                        </div>
                        <label style={{ display: 'block', marginTop: '0.5rem' }}>
                          Notes
                          <textarea
                            id={`vendor-notes-${v.id}`}
                            rows={3}
                            value={edit.notes}
                            onChange={(e) => setEdit({ ...edit, notes: e.target.value })}
                          />
                        </label>
                        <div className="toolbar" style={{ marginTop: '0.5rem' }}>
                          <button type="button" className="primary" onClick={saveEdit}>
                            Save changes
                          </button>
                        </div>

                        <h3 style={{ marginTop: '1rem' }}>Log follow-up attempt</h3>
                        <textarea
                          id={`follow-note-${v.id}`}
                          rows={2}
                          placeholder="e.g. Left voicemail — asked for vendor coordinator."
                          value={followNote}
                          onChange={(e) => setFollowNote(e.target.value)}
                        />
                        <div className="toolbar">
                          <button type="button" className="primary" onClick={logFollow}>
                            Log follow-up
                          </button>
                        </div>

                        <h3 style={{ marginTop: '1rem' }}>AI outputs</h3>
                        <div className="toolbar">
                          <button type="button" disabled={loadingAi === 'letter'} onClick={genLetter}>
                            {loadingAi === 'letter' ? '…' : 'Generate letter'}
                          </button>
                          {showFollowUpBtn(v) && (
                            <button type="button" disabled={loadingAi === 'follow'} onClick={genFollow}>
                              {loadingAi === 'follow' ? '…' : 'Generate follow-up email'}
                            </button>
                          )}
                          <button type="button" disabled={loadingAi === 'call'} onClick={genCall}>
                            {loadingAi === 'call' ? '…' : 'Generate call script'}
                          </button>
                          <button type="button" onClick={markSent}>
                            Mark sent (today + 30-day reminder)
                          </button>
                        </div>
                        {aiLetter && (
                          <div className="panel" style={{ marginTop: '0.75rem' }} id="letter-print">
                            <div className="toolbar">
                              <button type="button" onClick={() => copy(aiLetter)}>
                                Copy letter
                              </button>
                              <button type="button" onClick={printLetter}>
                                Print / PDF
                              </button>
                            </div>
                            <pre className="output-pre">{aiLetter}</pre>
                          </div>
                        )}
                        {aiFollow && (
                          <div className="panel" style={{ marginTop: '0.75rem' }}>
                            <div className="toolbar">
                              <button type="button" onClick={() => copy(aiFollow)}>
                                Copy follow-up
                              </button>
                            </div>
                            <pre className="output-pre">{aiFollow}</pre>
                          </div>
                        )}
                        {aiCall && (
                          <div className="panel" style={{ marginTop: '0.75rem' }}>
                            <div className="toolbar">
                              <button type="button" onClick={() => copy(aiCall)}>
                                Copy script
                              </button>
                            </div>
                            <pre className="output-pre">{aiCall}</pre>
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && <p className="sub">Nothing to show with current filters.</p>}
    </>
  );
}
