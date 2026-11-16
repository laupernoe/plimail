// The type a blob: URL for an attachment is made with. The sender chose the attachment's declared
// type, and a blob: URL with text/html or image/svg+xml opened in a tab runs as a page of this
// origin, so anything but a plain raster image is a download, whatever it claims to be.
const SAFE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export function attachmentBlobType(mimeType) {
  const type = String(mimeType ?? '').split(';')[0].trim().toLowerCase();
  return SAFE_IMAGE_TYPES.has(type) ? type : 'application/octet-stream';
}
