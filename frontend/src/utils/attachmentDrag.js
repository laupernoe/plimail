// Dragging an attachment out of the app onto the desktop or a file manager.
//
// Chromium (Chrome, Edge, the installed PWA) reads a non-standard `DownloadURL` drag type,
// "mime:filename:url", and downloads `url` under `filename` where the drag is dropped. Firefox
// and Safari ignore it, so the chips are only made draggable where it is understood: elsewhere a
// drag would carry only a link, which behind the session cookie is no use to whatever receives it.
//
// Chromium splits the value at its first two colons and does not unescape the name, so a colon in
// the name would cut it short and push the rest into the URL. The URL is everything after the
// second colon, so its own colons are fine.

export function supportsDownloadUrlDrag(nav = globalThis.navigator) {
  // navigator.userAgentData exists only in Chromium-based browsers.
  return !!nav?.userAgentData?.brands?.some(b => /Chromium|Google Chrome|Microsoft Edge/.test(b.brand));
}

export function dragFilename(name) {
  const cleaned = String(name ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[:/\\]/g, '_')
    .trim()
    .replace(/^\.+/, '');
  return cleaned || 'attachment';
}

function dragMime(type) {
  return typeof type === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(type) ? type : 'application/octet-stream';
}

export function downloadUrlData({ type, filename, url }) {
  return `${dragMime(type)}:${dragFilename(filename)}:${url}`;
}

// Fills a dragstart's DataTransfer. `url` must be absolute (Chromium rejects a relative one).
// text/plain gives a text field the link. text/uri-list is left out on purpose: on Windows
// Chromium turns a dragged URL into a virtual ".url" shortcut file of its own, which a desktop
// drop could take instead of the download. `link: false` keeps the URL off the drag entirely, for
// a blob: URL that means nothing outside this page.
export function setAttachmentDragData(dataTransfer, { type, filename, url, link = true }) {
  dataTransfer.effectAllowed = 'copy';
  dataTransfer.setData('DownloadURL', downloadUrlData({ type, filename, url }));
  if (link) dataTransfer.setData('text/plain', url);
}

export function attachmentDownloadUrl(messageId, part, base) {
  return new URL(`/api/mail/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(part)}`, base).href;
}
