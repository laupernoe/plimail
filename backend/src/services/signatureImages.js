// Images uploaded into a signature (migration 0091). The signature HTML refers to one by its route,
// /api/signature-images/<id>, which only its owner can load. Every message built from a signature
// (a send, a held or scheduled send, a draft saved to IMAP) gets the image's bytes in its place as a
// data: URI, which embedInlineDataImages then turns into an inline cid: part, so recipients see the
// image without loading anything from this server.
import sharp from 'sharp';
import { query } from './db.js';
import { sniffImageType } from '../utils/inlineImages.js';
import { MAX_INPUT_PIXELS } from './imageShrink.js';
import { SIGNATURE_IMAGE_PATH, SIGNATURE_IMAGE_SRC_RE, isSignatureImageId } from '../utils/signatureImagePath.js';

// What the browser may send. A phone photo of a few megabytes is fine: it is scaled down here.
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
// What is kept, after scaling: it travels in every message the signature goes out with.
export const MAX_STORED_BYTES = 1024 * 1024;
// Wider than any signature shows an image, and enough for a high-density screen at 300 px.
export const MAX_WIDTH = 600;
export const SIGNATURE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

export class SignatureImageError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// The bytes to keep for an uploaded file: { bytes, type, width, height }. The type comes from the
// file's own bytes, not from what the browser said. PNG and JPEG are re-encoded, which drops their
// metadata (a phone photo's location) and applies the EXIF rotation; WebP becomes PNG or JPEG,
// because Outlook and older mail apps show no WebP. An animated GIF is kept as it is.
export async function prepareSignatureImage(bytes, { sharpImpl = sharp } = {}) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw new SignatureImageError(400, 'No image was uploaded');
  if (bytes.length > MAX_UPLOAD_BYTES) throw new SignatureImageError(413, 'The image may be at most 5 MB');
  const type = sniffImageType(bytes);
  if (!SIGNATURE_IMAGE_TYPES.includes(type)) throw new SignatureImageError(415, 'Use a PNG, JPEG, GIF or WebP image');

  let meta;
  try {
    meta = await sharpImpl(bytes, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  } catch {
    throw new SignatureImageError(400, 'The image could not be read');
  }
  let out;
  if (type === 'image/gif') {
    out = { bytes, type, width: meta.width, height: meta.pageHeight || meta.height };
  } else {
    const format = type === 'image/jpeg' || (type === 'image/webp' && !meta.hasAlpha) ? 'jpeg' : 'png';
    try {
      const pipeline = sharpImpl(bytes, { limitInputPixels: MAX_INPUT_PIXELS })
        .rotate()
        .resize({ width: MAX_WIDTH, withoutEnlargement: true });
      const { data, info } = await (format === 'jpeg' ? pipeline.jpeg({ quality: 85 }) : pipeline.png({ compressionLevel: 9 }))
        .toBuffer({ resolveWithObject: true });
      out = { bytes: data, type: `image/${format}`, width: info.width, height: info.height };
    } catch {
      throw new SignatureImageError(400, 'The image could not be read');
    }
  }
  if (!(out.width > 0 && out.height > 0)) throw new SignatureImageError(400, 'The image could not be read');
  if (out.bytes.length > MAX_STORED_BYTES) throw new SignatureImageError(413, 'The image is still over 1 MB once scaled down; use a smaller one');
  return out;
}

// What one user may keep. Images left out of every signature are deleted after a week
// (deleteUnreferencedSignatureImages), so the cap is reached only by images still in use.
export const MAX_IMAGES_PER_USER = 50;
export const MAX_TOTAL_BYTES_PER_USER = 20 * 1024 * 1024;
export const SIGNATURE_IMAGE_QUOTA_CODE = 'signature_image_quota';

// Refused with 409 once the user's images would pass either cap. The check and the insert are
// one statement, so a burst of uploads cannot each see room for itself.
export async function saveSignatureImage(userId, image, { queryFn = query } = {}) {
  const { rows } = await queryFn(
    `INSERT INTO signature_images (user_id, content_type, data, width, height)
     SELECT $1, $2, $3, $4, $5
      WHERE (SELECT COUNT(*) FROM signature_images WHERE user_id = $1) < $6
        AND (SELECT COALESCE(SUM(octet_length(data)), 0) FROM signature_images WHERE user_id = $1) + octet_length($3::bytea) <= $7
     RETURNING id`,
    [userId, image.type, image.bytes, image.width, image.height, MAX_IMAGES_PER_USER, MAX_TOTAL_BYTES_PER_USER],
  );
  if (!rows.length) {
    throw Object.assign(new SignatureImageError(409,
      `You have reached the limit of ${MAX_IMAGES_PER_USER} signature images or ${MAX_TOTAL_BYTES_PER_USER / 1024 / 1024} MB. `
      + 'Images no signature uses any more are removed after a week.'), { code: SIGNATURE_IMAGE_QUOTA_CODE });
  }
  const id = rows[0].id;
  return { id, url: SIGNATURE_IMAGE_PATH + id, width: image.width, height: image.height };
}

// The image if `userId` owns it, else null: another user's id answers as one that does not exist.
export async function findSignatureImage(userId, id, { queryFn = query } = {}) {
  if (!isSignatureImageId(id)) return null;
  const { rows } = await queryFn(
    'SELECT content_type, data FROM signature_images WHERE id = $1 AND user_id = $2',
    [id, userId],
  );
  return rows[0] || null;
}

const IMG_TAG_RE = /<img\b[^>]*>/gi;
const SRC_ATTR_RE = /(\ssrc\s*=\s*)(["'])([^"']*)\2/i;

// `html` with every <img> that shows one of the user's signature images given that image's bytes
// as a data: URI. An image that is not theirs, or no longer exists, is left out, with a warning:
// the message must not carry a reference only this server could answer.
export async function inlineSignatureImages(html, userId, { queryFn = query } = {}) {
  if (!html || !html.includes(SIGNATURE_IMAGE_PATH)) return html;
  const ids = new Set();
  for (const tag of html.match(IMG_TAG_RE) || []) {
    const src = tag.match(SRC_ATTR_RE)?.[3];
    const id = src?.match(SIGNATURE_IMAGE_SRC_RE)?.[1];
    if (id) ids.add(id.toLowerCase());
  }
  if (!ids.size) return html;
  const { rows } = await queryFn(
    'SELECT id, content_type, data FROM signature_images WHERE id = ANY($1::uuid[]) AND user_id = $2',
    [[...ids], userId],
  );
  const dataUris = new Map(rows.map(r => [String(r.id).toLowerCase(), `data:${r.content_type};base64,${Buffer.from(r.data).toString('base64')}`]));
  return html.replace(IMG_TAG_RE, (tag) => {
    const m = tag.match(SRC_ATTR_RE);
    const id = m?.[3].match(SIGNATURE_IMAGE_SRC_RE)?.[1]?.toLowerCase();
    if (!id) return tag;
    const uri = dataUris.get(id);
    if (!uri) {
      console.warn(`Signature image ${id} is missing for user ${userId}; left out of the message`);
      return '';
    }
    return tag.replace(SRC_ATTR_RE, `$1"${uri}"`);
  });
}

// An image is kept while any signature, of any account or alias or in the signature library,
// still names its id, and for a week after upload, which covers one inserted in an editor and not
// saved yet. A user with a scheduled send not yet settled keeps all theirs: its signature is in an
// encrypted payload, put in only when it goes out, and losing an image from it would go
// unnoticed. Drafts on IMAP already carry the bytes. Matching the bare id anywhere in the HTML errs towards keeping.
export const UNREFERENCED_GRACE = '7 days';
const CLEANUP_MS = 6 * 60 * 60 * 1000;
let cleanupTimer = null;

export async function deleteUnreferencedSignatureImages({ queryFn = query } = {}) {
  const { rowCount } = await queryFn(
    `DELETE FROM signature_images si
      WHERE si.created_at < NOW() - $1::interval
        AND NOT EXISTS (SELECT 1 FROM email_accounts a WHERE strpos(lower(a.signature), si.id::text) > 0)
        AND NOT EXISTS (SELECT 1 FROM account_aliases al WHERE strpos(lower(al.signature), si.id::text) > 0)
        AND NOT EXISTS (SELECT 1 FROM signatures s WHERE strpos(lower(s.html), si.id::text) > 0)
        AND NOT EXISTS (SELECT 1 FROM scheduled_messages sm
                         WHERE sm.user_id = si.user_id AND sm.status NOT IN ('sent', 'cancelled'))`,
    [UNREFERENCED_GRACE],
  );
  return rowCount || 0;
}

function cleanUp() {
  deleteUnreferencedSignatureImages()
    .then((n) => { if (n) console.log(`Signature images: deleted ${n} no signature uses`); })
    .catch(err => console.warn('Signature images: cleanup failed:', err.message));
}

export function startSignatureImageCleanup() {
  if (cleanupTimer) return;
  cleanUp();
  cleanupTimer = setInterval(cleanUp, CLEANUP_MS);
  cleanupTimer.unref?.();
}
