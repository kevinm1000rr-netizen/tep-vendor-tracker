import { useState } from 'react';
import { api } from '../api';

export default function MonthlyReview() {
  const [loading, setLoading] = useState(false);
  const [text, setText] = useState('');
  const [meta, setMeta] = useState(null);
  const [err, setErr] = useState('');

  const run = async () => {
    setLoading(true);
    setErr('');
    try {
      const res = await api.monthlyReview();
      setText(res.text);
      setMeta(res.snapshotMeta);
    } catch (e) {
      setErr(e.message);
      setText('');
    } finally {
      setLoading(false);
    }
  };

  const copy = () => {
    if (text) navigator.clipboard.writeText(text);
  };

  const downloadTxt = () => {
    if (!text) return;
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tep-monthly-review-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <h1 className="page-title">Monthly strategic review</h1>
      <p className="sub">AI summary of the tracker: priorities, follow-ups, and outreach angles for the month.</p>
      <div className="toolbar no-print">
        <button type="button" className="danger monthly-btn" disabled={loading} onClick={run}>
          {loading ? 'Working…' : 'Run monthly strategic review'}
        </button>
        <button type="button" disabled={!text} onClick={copy}>
          Copy report
        </button>
        <button type="button" disabled={!text} onClick={downloadTxt}>
          Download .txt
        </button>
        <button type="button" disabled={!text} onClick={() => window.print()}>
          Print / Save PDF
        </button>
      </div>
      {err && <p style={{ color: 'var(--danger)' }}>{err}</p>}
      {meta && (
        <p className="sub">
          Snapshot: {meta.vendorCount} companies · {new Date(meta.at).toLocaleString()}
        </p>
      )}
      {text && (
        <div id="print-report" className="panel">
          <h3 className="no-print">Report</h3>
          <pre className="output-pre">{text}</pre>
        </div>
      )}
    </>
  );
}
