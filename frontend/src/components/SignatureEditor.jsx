import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { pasteWithoutPageColors } from '../utils/contentEditablePaste.js';
import { api } from '../utils/api.js';

// What the server takes (routes/signatureImages.js): it scales the image to 600 px wide at most.
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
// The widths an image is shown at in the signature; full is the image's own (at most 600 px).
const IMAGE_SIZES = [
  { key: 'signatureEditor.imageSmall', width: 120 },
  { key: 'signatureEditor.imageMedium', width: 240 },
  { key: 'signatureEditor.imageFull', width: null },
];
// Marks the image the size bar acts on. Only the editor shows it; it never reaches the signature.
const SELECTED = 'data-signature-selected';

const BTN = {
  background: 'none', border: 'none', borderRadius: 4,
  color: 'var(--text-secondary)', cursor: 'pointer',
  padding: '3px 7px', fontSize: 13, lineHeight: 1,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
};

function ToolBtn({ onClick, title, active, disabled, children }) {
  const [hov, setHov] = useState(false);
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active === undefined ? undefined : Boolean(active)}
      disabled={disabled}
      onMouseDown={e => { e.preventDefault(); if (!disabled) onClick(); }}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        ...BTN,
        background: active || (hov && !disabled) ? 'var(--bg-hover)' : 'none',
        color: active ? 'var(--accent)' : 'var(--text-secondary)',
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? 'default' : 'pointer',
      }}
    >
      {children}
    </button>
  );
}

function Sep() {
  return <div style={{ width: 1, height: 16, background: 'var(--border)', margin: '0 3px', flexShrink: 0 }} />;
}

export default function SignatureEditor({ value, onChange }) {
  const { t } = useTranslation();
  const { addNotification } = useStore();
  const editorRef = useRef(null);
  const fileInputRef = useRef(null);
  const [showSource, setShowSource] = useState(false);
  const [sourceVal, setSourceVal] = useState('');

  // Seed the contenteditable on first mount only
  useEffect(() => {
    if (editorRef.current) {
      editorRef.current.innerHTML = value || '';
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const [uploading, setUploading] = useState(0);
  const [selectedImg, setSelectedImg] = useState(null);
  const [, setImgVersion] = useState(0);

  // The editor's HTML without the editor's own marks.
  const currentHtml = () => {
    const editor = editorRef.current;
    if (!editor) return '';
    if (!editor.querySelector(`[${SELECTED}]`)) return editor.innerHTML;
    const copy = editor.cloneNode(true);
    copy.querySelectorAll(`[${SELECTED}]`).forEach(el => el.removeAttribute(SELECTED));
    return copy.innerHTML;
  };
  const emit = () => onChange(currentHtml());

  // onMouseDown + e.preventDefault() keeps focus in the contenteditable so
  // execCommand acts on the current selection rather than on nothing.
  const exec = (cmd, val) => {
    document.execCommand(cmd, false, val ?? null);
    editorRef.current?.focus();
    emit();
  };

  const insertLink = () => {
    const saved = saveSelection();
    const url = window.prompt(t('signatureEditor.linkPrompt'));
    restoreSelection(saved);
    if (url) exec('createLink', url.match(/^https?:\/\//) ? url : 'https://' + url);
  };

  const insertImageFromUrl = () => {
    const url = window.prompt(t('signatureEditor.imageUrlPrompt'));
    if (url) exec('insertImage', url);
  };

  const selectImage = (img) => {
    editorRef.current?.querySelectorAll(`[${SELECTED}]`).forEach(el => { if (el !== img) el.removeAttribute(SELECTED); });
    if (img) img.setAttribute(SELECTED, '');
    setSelectedImg(img);
  };

  // Uploads each image file and puts it where the caret was (or at `range`), shown at the medium
  // size. Returns false when there is no image among the files, so a paste or drop of anything
  // else is left to the browser.
  const insertImageFiles = (files, range = saveSelection()) => {
    const images = [...(files || [])].filter(f => f.type?.startsWith('image/'));
    if (!images.length) return false;
    for (const file of images) {
      if (!IMAGE_TYPES.includes(file.type)) {
        addNotification({ type: 'error', title: t('signatureEditor.imageWrongType.title'), body: t('signatureEditor.imageWrongType.body') });
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        addNotification({ type: 'error', title: t('signatureEditor.imageTooLarge.title'), body: t('signatureEditor.imageTooLarge.body') });
        continue;
      }
      setUploading(n => n + 1);
      api.uploadSignatureImage(file).then(({ url, width }) => {
        const editor = editorRef.current;
        if (!editor) return;
        if (!/^\/api\/signature-images\/[0-9a-f-]+$/i.test(String(url))) throw new Error('Unexpected upload answer');
        editor.focus();
        if (range && editor.contains(range.commonAncestorContainer)) restoreSelection(range);
        else placeCaretAtEnd(editor);
        const shown = Math.min(Number(width) || IMAGE_SIZES[1].width, IMAGE_SIZES[1].width);
        document.execCommand('insertHTML', false, `<img src="${url}" alt="" width="${shown}">`);
        emit();
      }).catch(err => {
        addNotification({ type: 'error', title: t('signatureEditor.imageUploadFailed'), body: err.message });
      }).finally(() => setUploading(n => n - 1));
    }
    return true;
  };

  const handleFileUpload = (e) => {
    insertImageFiles(e.target.files);
    e.target.value = '';
  };

  const handlePaste = (e) => {
    if (e.clipboardData?.files?.length && insertImageFiles(e.clipboardData.files)) {
      e.preventDefault();
      return;
    }
    pasteWithoutPageColors(e);
  };

  const handleDrop = (e) => {
    const files = e.dataTransfer?.files;
    if (!files?.length) return;
    const at = document.caretRangeFromPoint?.(e.clientX, e.clientY) || null;
    if (insertImageFiles(files, at)) e.preventDefault();
  };

  const handleEditorClick = (e) => {
    selectImage(e.target?.tagName === 'IMG' ? e.target : null);
  };

  const handleEditorKeyDown = (e) => {
    if (selectedImg && (e.key === 'Backspace' || e.key === 'Delete')) {
      e.preventDefault();
      removeSelectedImage();
    }
  };

  const handleEditorInput = () => {
    if (selectedImg && !editorRef.current?.contains(selectedImg)) setSelectedImg(null);
    emit();
  };

  const setImageWidth = (width) => {
    if (!selectedImg) return;
    // Firefox's resize handles leave a width and height in the style; the attribute is what counts.
    selectedImg.style.removeProperty('width');
    selectedImg.style.removeProperty('height');
    if (!selectedImg.getAttribute('style')) selectedImg.removeAttribute('style');
    selectedImg.removeAttribute('height');
    if (width) selectedImg.setAttribute('width', String(width));
    else selectedImg.removeAttribute('width');
    setImgVersion(v => v + 1);
    emit();
  };

  const removeSelectedImage = () => {
    if (!selectedImg) return;
    selectedImg.remove();
    setSelectedImg(null);
    editorRef.current?.focus();
    emit();
  };

  const selectedWidth = selectedImg ? Number(selectedImg.getAttribute('width')) || null : undefined;

  const toggleSource = () => {
    if (!showSource) {
      // Visual → Source: capture current HTML
      const html = currentHtml();
      setSelectedImg(null);
      setSourceVal(html);
      setShowSource(true);
    } else {
      // Source → Visual: push raw HTML back into editor
      setShowSource(false);
      // Use a microtask so the div is back in the DOM before we write to it
      setTimeout(() => {
        if (editorRef.current) {
          editorRef.current.innerHTML = sourceVal;
          onChange(sourceVal);
        }
      }, 0);
    }
  };

  const handleSourceChange = (e) => {
    setSourceVal(e.target.value);
    onChange(e.target.value);
  };

  return (
    <div style={{
      border: '1px solid var(--border)', borderRadius: 8,
      overflow: 'hidden', background: 'var(--bg-tertiary)',
    }}>
      {/* Toolbar */}
      <div style={{
        display: 'flex', alignItems: 'center',
        padding: '5px 8px', borderBottom: '1px solid var(--border-subtle)',
        flexWrap: 'wrap', gap: 2,
      }}>
        <ToolBtn title={t('signatureEditor.bold')} onClick={() => exec('bold')}>
          <strong style={{ fontSize: 13 }}>B</strong>
        </ToolBtn>
        <ToolBtn title={t('signatureEditor.italic')} onClick={() => exec('italic')}>
          <em style={{ fontSize: 13 }}>I</em>
        </ToolBtn>
        <ToolBtn title={t('signatureEditor.underline')} onClick={() => exec('underline')}>
          <span style={{ textDecoration: 'underline', fontSize: 13 }}>U</span>
        </ToolBtn>
        <ToolBtn title={t('signatureEditor.strikethrough')} onClick={() => exec('strikeThrough')}>
          <span style={{ textDecoration: 'line-through', fontSize: 13 }}>S</span>
        </ToolBtn>

        <Sep />

        {/* Text color */}
        <label
          title={t('signatureEditor.textColor')}
          onMouseDown={e => e.preventDefault()}
          style={{ ...BTN, cursor: 'pointer', position: 'relative', padding: '3px 7px' }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M9 3L5 21"/><path d="M15 3L19 21"/><path d="M5.5 12h13"/>
          </svg>
          <input
            type="color"
            defaultValue="#000000"
            onChange={e => exec('foreColor', e.target.value)}
            style={{ opacity: 0, position: 'absolute', width: 0, height: 0 }}
          />
        </label>

        <Sep />

        <ToolBtn title={t('signatureEditor.link')} onClick={insertLink}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/>
            <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/>
          </svg>
        </ToolBtn>

        <ToolBtn title={t('signatureEditor.imageUrl')} onClick={insertImageFromUrl}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/>
            <polyline points="21 15 16 10 5 21"/>
          </svg>
        </ToolBtn>

        <ToolBtn
          title={uploading ? t('signatureEditor.imageUploading') : t('signatureEditor.imageUpload')}
          disabled={showSource || uploading > 0}
          onClick={() => fileInputRef.current?.click()}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
        </ToolBtn>
        <input ref={fileInputRef} type="file" accept={IMAGE_TYPES.join(',')} multiple
          style={{ display: 'none' }} onChange={handleFileUpload} />

        <Sep />

        <ToolBtn title={showSource ? t('signatureEditor.visualMode') : t('signatureEditor.sourceMode')} active={showSource} onClick={toggleSource}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
          </svg>
        </ToolBtn>
      </div>

      {/* The image clicked in the editor: its size, or take it out */}
      {selectedImg && !showSource && (
        <div
          role="toolbar"
          aria-label={t('signatureEditor.imageSize')}
          style={{
            display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap',
            padding: '4px 8px', borderBottom: '1px solid var(--border-subtle)',
            fontSize: 12, color: 'var(--text-secondary)',
          }}
        >
          <span style={{ marginRight: 6 }}>{t('signatureEditor.imageSize')}</span>
          {IMAGE_SIZES.map(size => (
            <ToolBtn key={size.key} title={t(size.key)}
              active={selectedWidth === size.width}
              onClick={() => setImageWidth(size.width)}>
              <span style={{ fontSize: 12 }}>{t(size.key)}</span>
            </ToolBtn>
          ))}
          <div style={{ flex: 1 }} />
          <ToolBtn title={t('signatureEditor.imageRemove')} onClick={removeSelectedImage}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 5 }}>
              <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/>
            </svg>
            <span style={{ fontSize: 12 }}>{t('signatureEditor.imageRemove')}</span>
          </ToolBtn>
        </div>
      )}

      {/* Editor area */}
      {showSource ? (
        <textarea
          value={sourceVal}
          onChange={handleSourceChange}
          spellCheck={false}
          style={{
            display: 'block', width: '100%', minHeight: 120,
            padding: '10px 12px', background: 'transparent',
            border: 'none', outline: 'none',
            color: 'var(--text-primary)', fontFamily: 'monospace',
            fontSize: 12, lineHeight: 1.6, resize: 'vertical',
            boxSizing: 'border-box',
          }}
        />
      ) : (
        <div
          ref={editorRef}
          contentEditable
          suppressContentEditableWarning
          className="signature-editor"
          onInput={handleEditorInput}
          onPaste={handlePaste}
          onDrop={handleDrop}
          onClick={handleEditorClick}
          onKeyDown={handleEditorKeyDown}
          style={{
            minHeight: 100, padding: '10px 12px',
            color: 'var(--text-primary)', fontSize: 13,
            lineHeight: 1.6, outline: 'none',
          }}
        />
      )}
    </div>
  );
}

// Save/restore selection so link prompt doesn't lose cursor position
function saveSelection() {
  const sel = window.getSelection();
  if (!sel?.rangeCount) return null;
  return sel.getRangeAt(0).cloneRange();
}

function restoreSelection(range) {
  if (!range) return;
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function placeCaretAtEnd(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  restoreSelection(range);
}
