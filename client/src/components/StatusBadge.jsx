const CODES = {
  new: 'NW',
  not_sent: 'NS',
  sent: 'ST',
  responded: 'RS',
  approved: 'AP',
};

const LABELS = {
  new: 'New',
  not_sent: 'Not sent',
  sent: 'Sent',
  responded: 'Responded',
  approved: 'Approved',
};

export default function StatusBadge({ status }) {
  const code = CODES[status] || status;
  const label = LABELS[status] || status;
  return (
    <span className={`badge badge-pill-code ${status}`} title={label} aria-label={label}>
      {code}
    </span>
  );
}
