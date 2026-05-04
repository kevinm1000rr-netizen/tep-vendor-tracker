import { NavLink } from 'react-router-dom';
import { useEffect, useState } from 'react';

const THEME_KEY = 'tep-theme';

function readStoredTheme() {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export default function Layout({ children }) {
  const [theme, setTheme] = useState(readStoredTheme);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme === 'dark' ? 'dark' : 'light');
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="sidebar-title">Tri Express Plumbing</div>
          <div className="sidebar-sub">Vendor CRM</div>
        </div>
        <nav>
          <NavLink end className={({ isActive }) => (isActive ? 'active' : '')} to="/">
            📊 Agent Report
          </NavLink>
          <NavLink className={({ isActive }) => (isActive ? 'active' : '')} to="/tracker">
            📋 Tracker
          </NavLink>
          <NavLink className={({ isActive }) => (isActive ? 'active' : '')} to="/agent-tasks">
            ✅ Activity Log
          </NavLink>
          <NavLink className={({ isActive }) => (isActive ? 'active' : '')} to="/agent-review">
            🔍 Agent Review
          </NavLink>
          <NavLink className={({ isActive }) => (isActive ? 'active' : '')} to="/monthly">
            📈 Review
          </NavLink>
          <NavLink className={({ isActive }) => (isActive ? 'active' : '')} to="/settings">
            ⚙️ Settings
          </NavLink>
        </nav>
        <div className="sidebar-footer">
          <button type="button" className="sidebar-theme" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
            {theme === 'dark' ? 'Light mode' : 'Dark mode'}
          </button>
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
