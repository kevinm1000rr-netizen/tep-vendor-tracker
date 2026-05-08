import { useEffect, useState } from 'react';
import { api } from '../api';

export default function Settings() {
  const [key, setKey] = useState('');
  const [masked, setMasked] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const [model, setModel] = useState('');
  const [googleKey, setGoogleKey] = useState('');
  const [serpKey, setSerpKey] = useState('');
  const [hasGoogle, setHasGoogle] = useState(false);
  const [maskedGoogle, setMaskedGoogle] = useState('');
  const [hasSerp, setHasSerp] = useState(false);
  const [maskedSerp, setMaskedSerp] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [smtpHost, setSmtpHost] = useState('smtpout.secureserver.net');
  const [smtpPort, setSmtpPort] = useState('465');
  const [smtpUser, setSmtpUser] = useState('');
  const [smtpPass, setSmtpPass] = useState('');
  const [smtpFromName, setSmtpFromName] = useState('Kevin | Tri Express Plumbing');
  const [smtpConfigured, setSmtpConfigured] = useState(false);
  const [maskedSmtp, setMaskedSmtp] = useState('');
  const [showSmtpPass, setShowSmtpPass] = useState(false);

  const load = async () => {
    try {
      setErr('');
      const s = await api.settings();
      setHasKey(s.hasApiKey);
      setMasked(s.maskedKey || '');
      setModel(s.model || '');
      setHasGoogle(s.hasGooglePlacesKey);
      setMaskedGoogle(s.maskedGooglePlacesKey || '');
      setHasSerp(s.hasSerpApiKey);
      setMaskedSerp(s.maskedSerpApiKey || '');
      setSmtpConfigured(Boolean(s.smtpConfigured));
      setSmtpHost(s.smtpHost || 'smtpout.secureserver.net');
      setSmtpPort(String(s.smtpPort || 465));
      setSmtpUser(s.smtpUser || '');
      setSmtpFromName(s.smtpFromName || 'Kevin | Tri Express Plumbing');
      setMaskedSmtp(s.maskedSmtpPass || '');
    } catch (e) {
      setErr(e.message);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const save = async (e) => {
    e.preventDefault();
    setMsg('');
    setErr('');
    try {
      await api.saveSettings({ anthropicApiKey: key });
      setKey('');
      setMsg('Saved.');
      await load();
    } catch (e2) {
      setErr(e2.message);
    }
  };

  const clearKey = async () => {
    setErr('');
    try {
      await api.saveSettings({ clear: true });
      setMsg('API key cleared from app config (env variable still applies if set).');
      await load();
    } catch (e) {
      setErr(e.message);
    }
  };

  const saveGooglePlaces = async () => {
    setMsg('');
    setErr('');
    try {
      await api.saveSettings({ googlePlacesApiKey: googleKey });
      setGoogleKey('');
      setMsg('Google Places key saved (empty clears from .tep-config.json only).');
      await load();
    } catch (e) {
      setErr(e.message);
    }
  };

  const saveSerp = async () => {
    setMsg('');
    setErr('');
    try {
      await api.saveSettings({ serpApiKey: serpKey });
      setSerpKey('');
      setMsg('SerpAPI key saved (empty clears from .tep-config.json only).');
      await load();
    } catch (e) {
      setErr(e.message);
    }
  };

  const saveSmtp = async () => {
    setMsg('');
    setErr('');
    try {
      const body = {
        smtpHost,
        smtpPort: Number(smtpPort) || 465,
        smtpUser,
        smtpFromName,
      };
      if (smtpPass.trim()) body.smtpPass = smtpPass.trim();
      await api.saveSettings(body);
      setSmtpPass('');
      setMsg('Email / SMTP settings saved.');
      await load();
    } catch (e) {
      setErr(e.message);
    }
  };

  const testSmtp = async () => {
    setMsg('');
    setErr('');
    try {
      const r = await api.testSmtp();
      setMsg(
        `Test email sent to ${r.sentTo || smtpUser || 'SMTP_USER'} (login mailbox). From: kevin@triexpressplumbing.com`
      );
    } catch (e) {
      setErr(e.message);
    }
  };

  const testSms = async () => {
    setMsg('');
    setErr('');
    try {
      await api.testSms();
      setMsg('Test SMS sent (or skipped if already sent today) to ALERT_PHONE.');
    } catch (e) {
      setErr(e.message);
    }
  };

  return (
    <>
      <h1 className="page-title">Settings</h1>
      <p className="sub">
        Keys in <code>.env</code> (project root) or saved here to <code>.tep-config.json</code>; environment variables
        win over the file. You can also put <code>ANTHROPIC_API_KEY</code> / <code>SERPAPI_API_KEY</code> directly in
        the JSON. Optional: set <code>TEP_CONFIG_PATH</code> to a custom config file path (absolute or relative to the
        project root).
      </p>
      {err && <p style={{ color: 'var(--danger)' }}>{err}</p>}
      {msg && <p style={{ color: 'var(--ok)' }}>{msg}</p>}
      <form className="panel" onSubmit={save} style={{ maxWidth: 480 }}>
        <h3>Anthropic API key</h3>
        <p className="sub" style={{ marginTop: 0 }}>
          {hasKey ? (
            <>
              Saved: <strong>{masked || '••••••••'}</strong>
            </>
          ) : (
            'Not in local config.'
          )}
        </p>
        <label htmlFor="apikey">Paste API key</label>
        <input
          id="apikey"
          type="password"
          autoComplete="off"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="sk-ant-api03-…"
          style={{ marginBottom: '0.75rem' }}
        />
        <div className="toolbar" style={{ marginTop: 8 }}>
          <button type="submit" className="primary">
            Save key
          </button>
          <button type="button" onClick={clearKey}>
            Clear saved key
          </button>
        </div>
      </form>
      <div className="panel" style={{ maxWidth: 480 }}>
        <h3>Model</h3>
        <p className="sub" style={{ margin: 0 }}>
          Active: <code>{model}</code> · override with <code>ANTHROPIC_MODEL</code>
        </p>
      </div>

      <div className="panel" style={{ maxWidth: 560 }}>
        <h3>Email configuration (SMTP)</h3>
        <p className="sub" style={{ marginTop: 0 }}>
          GoDaddy relay (<code>smtpout.secureserver.net</code>). All outreach sends as{' '}
          <strong>kevin@triexpressplumbing.com</strong>. Status:{' '}
          {smtpConfigured ? (
            <strong style={{ color: 'var(--ok)' }}>Ready</strong>
          ) : (
            <span>Not fully configured</span>
          )}
          {maskedSmtp ? (
            <>
              {' '}
              · Password on file: <strong>{maskedSmtp}</strong>
            </>
          ) : null}
        </p>
        <p className="sub" style={{ marginTop: 0 }}>
          Use your GoDaddy mailbox password (or email password). Port <strong>465</strong> is SSL; use <strong>587</strong>{' '}
          if your account uses STARTTLS instead.
        </p>
        <label htmlFor="smtp-host">SMTP host</label>
        <input id="smtp-host" value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} autoComplete="off" />
        <label htmlFor="smtp-port">SMTP port</label>
        <input id="smtp-port" value={smtpPort} onChange={(e) => setSmtpPort(e.target.value)} autoComplete="off" />
        <label htmlFor="smtp-user">SMTP_USER (GoDaddy login — test email goes here)</label>
        <input id="smtp-user" value={smtpUser} onChange={(e) => setSmtpUser(e.target.value)} autoComplete="username" />
        <p className="sub" style={{ margin: '0.25rem 0 0' }}>
          From address (fixed): <code>kevin@triexpressplumbing.com</code>
        </p>
        <label htmlFor="smtp-from-name">SMTP_FROM_NAME (display name)</label>
        <input id="smtp-from-name" value={smtpFromName} onChange={(e) => setSmtpFromName(e.target.value)} />
        <label htmlFor="smtp-pass">SMTP_PASS</label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            id="smtp-pass"
            type={showSmtpPass ? 'text' : 'password'}
            value={smtpPass}
            onChange={(e) => setSmtpPass(e.target.value)}
            placeholder="Paste new app password to update"
            autoComplete="new-password"
            style={{ flex: 1 }}
          />
          <button type="button" onClick={() => setShowSmtpPass((v) => !v)}>
            {showSmtpPass ? 'Hide' : 'Show'}
          </button>
        </div>
        <div className="toolbar" style={{ marginTop: '0.75rem' }}>
          <button type="button" className="primary" onClick={saveSmtp}>
            Save email settings
          </button>
          <button type="button" onClick={testSmtp} disabled={!smtpConfigured}>
            Test email
          </button>
          <button type="button" onClick={testSms}>
            Test SMS
          </button>
        </div>
      </div>

      <div className="panel" style={{ maxWidth: 480 }}>
        <h3>Optional: Google Places &amp; SerpAPI</h3>
        <p className="sub" style={{ marginTop: 0 }}>
          For Agent Review research and prospect discovery. Cron: <code>AGENT_AUTO_RUN=true</code> (default) for daily 06:00;
          <code>false</code> disables auto runs.
        </p>
        <p className="sub" style={{ marginTop: 0 }}>
          Google Places:{' '}
          {hasGoogle ? (
            <strong>{maskedGoogle || '••••'}</strong>
          ) : (
            <span>not set</span>
          )}
          <br />
          SerpAPI: {hasSerp ? <strong>{maskedSerp || '••••'}</strong> : <span>not set</span>}
        </p>
        <label htmlFor="gplaces">GOOGLE_PLACES_API_KEY</label>
        <input
          id="gplaces"
          type="password"
          autoComplete="off"
          value={googleKey}
          onChange={(e) => setGoogleKey(e.target.value)}
          placeholder="AIza…"
          style={{ marginBottom: '0.5rem' }}
        />
        <div className="toolbar" style={{ marginBottom: '1rem' }}>
          <button type="button" className="primary" onClick={saveGooglePlaces}>
            Save Google Places key
          </button>
        </div>
        <label htmlFor="serp">SERPAPI_API_KEY</label>
        <input
          id="serp"
          type="password"
          autoComplete="off"
          value={serpKey}
          onChange={(e) => setSerpKey(e.target.value)}
          placeholder="SerpAPI secret"
          style={{ marginBottom: '0.5rem' }}
        />
        <div className="toolbar">
          <button type="button" className="primary" onClick={saveSerp}>
            Save SerpAPI key
          </button>
        </div>
        <p className="sub" style={{ margin: '0.75rem 0 0' }}>
          Empty save clears from <code>.tep-config.json</code> only.
        </p>
      </div>
    </>
  );
}
