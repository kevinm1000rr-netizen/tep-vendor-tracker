import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
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
  const [aiResearchHint, setAiResearchHint] = useState('');
  const [loadingAi, setLoadingAi] = useState('');
  const [err, setErr] = useState('');
  const [impCsv, setImpCsv] = useState('');
  const [impPreview, setImpPreview] = useState(null);
  const [impBusy, setImpBusy] = useState('');
  const [impMsg, setImpMsg] = useState('');
  const csvFileRef = useRef(null);

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
    setAiResearchHint('');
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
    setAiResearchHint('');
    try {
      const r = await api.generateLetter(expanded);
      if (r.manualResearch) {
        setAiLetter('');
        setAiResearchHint(
          r.reason ||
            'Not enough verifiable company-specific facts. Add website, address, or notes; configure Google Places and SerpApi in Settings, then try again.'
        );
      } else {
        setAiLetter(r.text || '');
      }
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
    setAiResearchHint('');
    try {
      const r = await api.generateFollowUp(expanded);
      if (r.manualResearch) {
        setAiFollow('');
        setAiResearchHint(
          r.reason ||
            'Not enough verifiable company-specific facts for a personalized follow-up. Enrich the record and try again.'
        );
      } else {
        setAiFollow(r.text || '');
      }
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

  const onCsvFile = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    const t = await f.text();
    setImpCsv(t);
    setImpPreview(null);
    setImpMsg('');
    setImpBusy('preview');
    try {
      const r = await api.importVendorsPreview(t);
      setImpPreview(r);
    } catch (ex) {
      setImpMsg(ex.message);
    } finally {
      setImpBusy('');
    }
  };

  const clearCsvImport = () => {
    setImpCsv('');
    setImpPreview(null);
    setImpMsg('');
    setImpBusy('');
  };

  const runImportCommit = async () => {
    if (!impCsv.trim() || !impPreview?.ok || !impPreview.rowCount) return;
    const ok = window.confirm(
      `Import all ${impPreview.rowCount} row(s) into the database?\n\nEach will be saved as status New, source manual_import (duplicate company names are skipped).`
    );
    if (!ok) return;
    setImpBusy('commit');
    setImpMsg('');
    try {
      const r = await api.importVendorsCommit(impCsv);
      const skipped = r.skipped?.length ?? 0;
      const errN = r.errors?.length ?? 0;
      setImpMsg(
        `Import finished: ${r.insertedCount} added, ${skipped} skipped (duplicate name), ${errN} row errors.` +
          (r.truncated ? ` Only the first 2000 data rows were processed (${r.totalRowsInFile} in file).` : '')
      );
      setImpPreview(null);
      setImpCsv('');
      await load();
    } catch (ex) {
      setImpMsg(ex.message);
    } finally {
      setImpBusy('');
    }
  };

  const rows = tab === 'alerts' ? alerts : vendors;

  return (
    <>
      <input
        ref={csvFileRef}
        type="file"
        accept=".csv,text/csv"
        style={{ display: 'none' }}
        aria-hidden
        onChange={onCsvFile}
      />
      <div className="tracker-page-head no-print">
        <div>
          <h1 className="page-title">Vendor tracker</h1>
          <p className="sub" style={{ marginBottom: 0 }}>
            {vendors.length} companies · filters apply to the table · Monthly alerts tab shows due follow-ups.
          </p>
        </div>
        <button type="button" className="primary tracker-import-csv-btn" onClick={() => csvFileRef.current?.click()}>
          Import CSV
        </button>
      </div>
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
            <option value="new">New</option>
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

      {(impCsv.trim() || impPreview || impBusy === 'preview') && (
        <div className="panel tracker-import no-print" style={{ marginBottom: '1rem' }}>
          <div className="tracker-import-panel-head">
            <h2 style={{ margin: 0, fontSize: '1rem' }}>CSV import preview</h2>
            <div className="toolbar" style={{ margin: 0 }}>
              <button type="button" onClick={() => csvFileRef.current?.click()} disabled={!!impBusy}>
                Choose different file
              </button>
              <button type="button" className="ghost" onClick={clearCsvImport} disabled={!!impBusy}>
                Clear
              </button>
              <button
                type="button"
                className="primary"
                disabled={!impCsv.trim() || !impPreview?.ok || !impPreview.rowCount || !!impBusy}
                onClick={runImportCommit}
              >
                {impBusy === 'commit' ? 'Importing…' : 'Import all'}
              </button>
            </div>
          </div>
          <p className="sub" style={{ marginTop: '0.35rem' }}>
            Headers (case-insensitive): Company or Name, Phone, Website, Service Area or Area (→ address), Notes,
            Specialty or Portfolio (category hint + notes). Rows are saved as status New, source manual_import.
          </p>
          {impCsv && (
            <p className="sub" style={{ margin: '0.25rem 0' }}>
              {impBusy === 'preview' ? (
                'Parsing CSV…'
              ) : (
                <>
                  Loaded {impCsv.length.toLocaleString()} characters — {impPreview?.rowCount ?? 0} data row(s) in file
                  {impPreview?.previewTruncated ? ` (preview shows first ${impPreview.preview?.length ?? 0} rows)` : ''}.
                </>
              )}
            </p>
          )}
          {impMsg && (
            <p style={{ margin: '0.5rem 0', color: impMsg.startsWith('Import finished:') ? 'var(--text)' : 'var(--danger)' }}>
              {impMsg}
            </p>
          )}
          {impPreview?.errors?.length > 0 && (
            <div style={{ marginTop: '0.5rem' }}>
              <strong>Issues</strong>
              <ul style={{ margin: '0.25rem 0', paddingLeft: '1.25rem' }}>
                {impPreview.errors.map((x, i) => (
                  <li key={i}>
                    {typeof x === 'string' ? x : `Row ${x.row}: ${x.error}`}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {impPreview && !impBusy && impPreview.rowCount === 0 && (
            <p className="sub" style={{ marginTop: '0.5rem' }}>
              No data rows to import. Add at least one non-empty row below the header.
            </p>
          )}
          {impPreview?.preview?.length > 0 && (
            <div style={{ marginTop: '0.75rem', overflowX: 'auto' }}>
              <strong>Preview</strong> {impPreview.previewTruncated ? `(first ${impPreview.preview.length} rows)` : ''}
              <table className="table-compact" style={{ marginTop: '0.35rem', fontSize: '12px' }}>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Name</th>
                    <th>Category</th>
                    <th>Phone</th>
                    <th>Website</th>
                    <th>Service area</th>
                    <th>Specialty / portfolio</th>
                    <th>Notes (trimmed)</th>
                  </tr>
                </thead>
                <tbody>
                  {impPreview.preview.map((r) => (
                    <tr key={r.rowNumber}>
                      <td>{r.rowNumber}</td>
                      <td>{r.name || '—'}</td>
                      <td>{r.category}</td>
                      <td>{r.phone || '—'}</td>
                      <td>{r.website || '—'}</td>
                      <td>{r.address || '—'}</td>
                      <td style={{ maxWidth: '160px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {(r.specialty_portfolio || '').slice(0, 80)}
                        {(r.specialty_portfolio || '').length > 80 ? '…' : ''}
                      </td>
                      <td style={{ maxWidth: '280px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {(r.notes || '').slice(0, 120)}
                        {(r.notes || '').length > 120 ? '…' : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
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
                              <option value="new">New</option>
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
                        {aiResearchHint && (
                          <p className="panel" style={{ marginTop: '0.5rem', color: 'var(--warning, #b45309)' }}>
                            <strong>Manual research:</strong> {aiResearchHint}
                          </p>
                        )}
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
