import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import AgentReport from './pages/AgentReport';
import Tracker from './pages/Tracker';
import MonthlyReview from './pages/MonthlyReview';
import Settings from './pages/Settings';
import AgentTasks from './pages/AgentTasks';
import AgentReview from './pages/AgentReview';
import PermitLeads from './pages/PermitLeads';

export default function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<AgentReport />} />
        <Route path="/tracker" element={<Tracker />} />
        <Route path="/agent-tasks" element={<AgentTasks />} />
        <Route path="/agent-review" element={<AgentReview />} />
        <Route path="/permits" element={<PermitLeads />} />
        <Route path="/monthly" element={<MonthlyReview />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
