// The small buttons of the OpenPGP settings and reader, as Settings' other sections draw them.
export const button = (kind = 'plain', busy = false) => ({
  padding: '5px 11px', fontSize: 12.5, fontWeight: 500, borderRadius: 6, cursor: busy ? 'default' : 'pointer',
  background: kind === 'primary' ? 'var(--accent)' : kind === 'danger' ? 'var(--red)' : 'var(--bg-tertiary)',
  color: kind === 'primary' ? 'var(--accent-text)' : kind === 'danger' ? '#fff' : 'var(--text-primary)',
  border: kind === 'plain' ? '1px solid var(--border)' : 'none',
  opacity: busy ? 0.6 : 1,
});
