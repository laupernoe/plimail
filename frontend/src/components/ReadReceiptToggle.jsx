import { useTranslation } from 'react-i18next';

// "Request a read receipt" in the composer (Disposition-Notification-To). `sheet` is the row in
// the phone's option sheet; otherwise it is the small control of the desktop footer.
export default function ReadReceiptToggle({ checked, onChange, sheet = false }) {
  const { t } = useTranslation();
  return (
    <label
      title={t('compose.readReceiptHint')}
      style={sheet
        ? { display: 'flex', alignItems: 'center', gap: 10, width: '100%', boxSizing: 'border-box', padding: '16px 20px', fontSize: 16, color: 'var(--text-primary)', borderBottom: '1px solid var(--border-subtle)', cursor: 'pointer' }
        : { display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: checked ? 'var(--accent)' : 'var(--text-secondary)', cursor: 'pointer', whiteSpace: 'nowrap', padding: '2px 4px' }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        style={{ margin: 0, accentColor: 'var(--accent)' }}
      />
      {t('compose.readReceipt')}
    </label>
  );
}
