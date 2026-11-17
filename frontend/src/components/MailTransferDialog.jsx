import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import { folderDisplayName, folderDisplayNameForPath } from '../utils/folderDisplay.js';
import { downloadExport, importProgressFraction, runFileImport } from '../utils/mailTransfer.js';

const PROGRESS_EVENT = 'plimail:mail_import_progress';

const button = (primary, disabled) => ({
  padding: '7px 16px', borderRadius: 7, fontSize: 13, fontWeight: primary ? 500 : 400,
  cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.55 : 1,
  border: primary ? 'none' : '1px solid var(--border-subtle)',
  background: primary ? 'var(--accent)' : 'transparent',
  color: primary ? 'var(--accent-text)' : 'var(--text-secondary)',
});
const field = {
  width: '100%', boxSizing: 'border-box', padding: '7px 9px', borderRadius: 7, fontSize: 13,
  border: '1px solid var(--border-subtle)', background: 'var(--bg-tertiary)', color: 'var(--text-primary)',
};
const label = { display: 'block', margin: '0 0 6px', fontSize: 12, color: 'var(--text-secondary)' };

function newImportId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Export or import a folder as .mbox / .eml (the Sidebar's folder menu). The export is a download the
// browser streams to disk; the import sends the files and shows how far the server is and, at the
// end, what was added, what was skipped and why each failure failed.
export default function MailTransferDialog({ mode, accountId, folderPath, onClose }) {
  const { t } = useTranslation();
  const accounts = useStore(s => s.accounts);
  const folders = useStore(s => s.folders[accountId]);
  const mappings = accounts.find(a => a.id === accountId)?.folder_mappings;
  const folderName = folderDisplayNameForPath(folderPath, t, mappings, folders);
  const isImport = mode === 'import';

  const [format, setFormat] = useState('mbox');
  const [files, setFiles] = useState([]);
  const [destination, setDestination] = useState(folderPath);
  const [markSeen, setMarkSeen] = useState(true);
  const [phase, setPhase] = useState('form'); // form | running | done
  const [progress, setProgress] = useState({ fileIndex: 0, fileCount: 0, imported: 0, duplicates: 0, failed: 0, bytesRead: 0, totalBytes: null });
  const [report, setReport] = useState(null);
  const importId = useRef(newImportId());
  const fileInput = useRef(null);

  useEffect(() => {
    if (!isImport) return undefined;
    const onProgress = (e) => {
      const d = e.detail;
      if (d?.importId !== importId.current) return;
      setProgress(p => ({ ...p, imported: d.imported, duplicates: d.duplicates, failed: d.failed, bytesRead: d.bytesRead, totalBytes: d.totalBytes }));
    };
    window.addEventListener(PROGRESS_EVENT, onProgress);
    return () => window.removeEventListener(PROGRESS_EVENT, onProgress);
  }, [isImport]);

  const options = useMemo(() => (folders || [])
    .filter(f => !(f.flags || []).includes('\\Noselect'))
    .map(f => ({ path: f.path, name: folderDisplayName(f, t, mappings, folders) })), [folders, t, mappings]);

  const startImport = async () => {
    setPhase('running');
    // Counts of the files already finished are added to the live ones of the file in flight.
    const result = await runFileImport(files, {
      accountId, folder: destination, markSeen, importId: importId.current,
      send: api.importMail,
      unsupportedReason: t('mailTransfer.unsupportedFile'),
      onFile: (fileIndex, fileCount) => setProgress(p => ({ ...p, fileIndex, fileCount, bytesRead: 0, totalBytes: null })),
    });
    setReport(result);
    setPhase('done');
  };

  const abortedText = report?.aborted && ({
    too_large: t('mailTransfer.abortedTooLarge'),
    imap_unavailable: t('mailTransfer.abortedImap'),
    cancelled: t('mailTransfer.abortedCancelled'),
  }[report.aborted] || t('mailTransfer.abortedError', { reason: report.abortReason || '' }));

  const fraction = importProgressFraction(progress);
  const titleId = 'mail-transfer-title';

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9000, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
      onClick={() => { if (phase !== 'running') onClose(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={e => e.stopPropagation()} style={{
        background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)', borderRadius: 12,
        padding: '22px 24px 20px', maxWidth: 440, width: '100%', maxHeight: '90vh', overflowY: 'auto', boxShadow: 'var(--shadow-modal)',
      }}>
        <h2 id={titleId} style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 600, color: 'var(--text-primary)' }}>
          {isImport ? t('mailTransfer.importTitle', { name: folderName }) : t('mailTransfer.exportTitle', { name: folderName })}
        </h2>

        {!isImport && (
          <>
            <p style={{ margin: '0 0 14px', fontSize: 13, lineHeight: 1.5, color: 'var(--text-secondary)' }}>{t('mailTransfer.exportIntro')}</p>
            {[['mbox', 'mailTransfer.formatMbox', 'mailTransfer.formatMboxHint'], ['zip', 'mailTransfer.formatZip', 'mailTransfer.formatZipHint']].map(([value, labelKey, hintKey]) => (
              <label key={value} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '8px 0', cursor: 'pointer' }}>
                <input type="radio" name="mail-transfer-format" checked={format === value} onChange={() => setFormat(value)} style={{ marginTop: 3 }} />
                <span>
                  <span style={{ display: 'block', fontSize: 13, color: 'var(--text-primary)' }}>{t(labelKey)}</span>
                  <span style={{ display: 'block', fontSize: 12, color: 'var(--text-tertiary)' }}>{t(hintKey)}</span>
                </span>
              </label>
            ))}
            {phase === 'running' && (
              <p role="status" style={{ margin: '12px 0 0', fontSize: 13, lineHeight: 1.5, color: 'var(--text-secondary)' }}>{t('mailTransfer.exportStarted')}</p>
            )}
          </>
        )}

        {isImport && phase === 'form' && (
          <>
            <p style={{ margin: '0 0 14px', fontSize: 13, lineHeight: 1.5, color: 'var(--text-secondary)' }}>{t('mailTransfer.importIntro')}</p>
            <input ref={fileInput} type="file" multiple accept=".mbox,.mbx,.eml,message/rfc822" style={{ display: 'none' }}
              onChange={e => setFiles(Array.from(e.target.files || []))} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
              <button type="button" className="btn-press" style={button(false, false)} onClick={() => fileInput.current?.click()}>{t('mailTransfer.chooseFiles')}</button>
              <span style={{ fontSize: 12, color: 'var(--text-tertiary)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {files.length === 0 ? t('mailTransfer.noFiles') : files.length === 1 ? files[0].name : t('mailTransfer.filesChosen', { count: files.length })}
              </span>
            </div>
            <label htmlFor="mail-transfer-destination" style={label}>{t('mailTransfer.destination')}</label>
            <select id="mail-transfer-destination" value={destination} onChange={e => setDestination(e.target.value)} style={{ ...field, marginBottom: 14 }}>
              {options.length === 0 && <option value={folderPath}>{folderName}</option>}
              {options.map(o => <option key={o.path} value={o.path}>{o.name}</option>)}
            </select>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, color: 'var(--text-primary)', cursor: 'pointer' }}>
              <input type="checkbox" checked={markSeen} onChange={e => setMarkSeen(e.target.checked)} />
              {t('mailTransfer.markRead')}
            </label>
          </>
        )}

        {isImport && phase === 'running' && (
          <div style={{ margin: '14px 0 4px' }}>
            <div role="progressbar" aria-label={t('mailTransfer.importing')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)}
              style={{ height: 8, borderRadius: 4, background: 'var(--bg-tertiary)', overflow: 'hidden' }}>
              <div style={{ width: `${Math.round(fraction * 100)}%`, height: '100%', background: 'var(--accent)', transition: 'width 0.3s' }} />
            </div>
            {progress.fileCount > 1 && (
              <p style={{ margin: '10px 0 0', fontSize: 12, color: 'var(--text-tertiary)' }}>
                {t('mailTransfer.fileOf', { current: Math.min(progress.fileIndex + 1, progress.fileCount), total: progress.fileCount })}
              </p>
            )}
            <p role="status" style={{ margin: '10px 0 0', fontSize: 13, color: 'var(--text-secondary)' }}>
              {t('mailTransfer.liveCounts', { imported: progress.imported, duplicates: progress.duplicates, failed: progress.failed })}
            </p>
          </div>
        )}

        {isImport && phase === 'done' && report && (
          <div style={{ marginTop: 10 }}>
            <p style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{t('mailTransfer.reportTitle')}</p>
            {[['mailTransfer.reportImported', report.imported, 'var(--green)'], ['mailTransfer.reportDuplicates', report.duplicates, 'var(--text-secondary)'], ['mailTransfer.reportFailed', report.failed, report.failed ? 'var(--red)' : 'var(--text-secondary)']].map(([key, value, color]) => (
              <div key={key} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '3px 0', color: 'var(--text-primary)' }}>
                <span>{t(key)}</span><span style={{ color, fontWeight: 600 }}>{value}</span>
              </div>
            ))}
            {abortedText && <p role="alert" style={{ margin: '10px 0 0', fontSize: 13, color: 'var(--red)', lineHeight: 1.5 }}>{abortedText}</p>}
            {report.failures.length > 0 && (
              <>
                <p style={{ margin: '12px 0 6px', fontSize: 12, color: 'var(--text-secondary)' }}>{t('mailTransfer.failuresTitle')}</p>
                <ul style={{ margin: 0, padding: 0, listStyle: 'none', maxHeight: 180, overflowY: 'auto', border: '1px solid var(--border-subtle)', borderRadius: 7 }}>
                  {report.failures.map((f, i) => (
                    <li key={i} style={{ padding: '6px 9px', fontSize: 12, borderTop: i ? '1px solid var(--border-subtle)' : 'none', color: 'var(--text-primary)', wordBreak: 'break-word' }}>
                      <span style={{ fontWeight: 600 }}>{f.label}</span>
                      <span style={{ color: 'var(--text-secondary)' }}>{' — '}{f.reason}</span>
                    </li>
                  ))}
                </ul>
                {report.failuresTruncated > 0 && (
                  <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--text-tertiary)' }}>{t('mailTransfer.failuresMore', { count: report.failuresTruncated })}</p>
                )}
              </>
            )}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
          {phase === 'running' && isImport ? null : (
            <button type="button" className="btn-press" style={button(false, false)} onClick={onClose}>
              {phase === 'done' || (!isImport && phase === 'running') ? t('mailTransfer.close') : t('common.cancel')}
            </button>
          )}
          {!isImport && phase === 'form' && (
            <button type="button" className="btn-press" style={button(true, false)}
              onClick={() => { downloadExport(accountId, folderPath, format); setPhase('running'); }}>{t('mailTransfer.exportStart')}</button>
          )}
          {isImport && phase === 'form' && (
            <button type="button" className="btn-press" disabled={files.length === 0} style={button(true, files.length === 0)} onClick={startImport}>{t('mailTransfer.importStart')}</button>
          )}
        </div>
      </div>
    </div>
  );
}
