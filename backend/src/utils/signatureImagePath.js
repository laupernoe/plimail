// The path a signature shows an uploaded image at (routes/signatureImages.js). Kept apart from
// services/signatureImages.js so the sanitizer can recognise it without loading sharp or the db.
export const SIGNATURE_IMAGE_PATH = '/api/signature-images/';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export const SIGNATURE_IMAGE_SRC_RE = new RegExp(`^/api/signature-images/(${UUID})$`, 'i');
export const isSignatureImageId = (id) => new RegExp(`^${UUID}$`, 'i').test(String(id || ''));
