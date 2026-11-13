import express, { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { consume } from '../services/rateLimiter.js';
import {
  MAX_UPLOAD_BYTES, SignatureImageError, findSignatureImage, prepareSignatureImage, saveSignatureImage,
} from '../services/signatureImages.js';

// Served from MailFlow's own origin, so never as anything but an image, as contact photos are.
const IMAGE_SAFETY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; sandbox",
  'Cross-Origin-Resource-Policy': 'same-origin',
};

// The file itself is the body, sent with its own image type. The global JSON parser leaves such a
// body alone, so only this route reads it, and only once the user is known.
const rawImage = express.raw({ type: 'image/*', limit: MAX_UPLOAD_BYTES });

const router = Router();
router.use(requireAuth);

router.post('/', async (req, res, next) => {
  const limit = await consume(`signature-image-upload:${req.session.userId}`, 30, 60_000);
  if (limit.limited) {
    res.set('Retry-After', String(Math.max(1, Math.ceil(limit.resetMs / 1000))));
    return res.status(429).json({ error: 'Too many uploads. Try again in a minute.' });
  }
  rawImage(req, res, (err) => {
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'The image may be at most 5 MB' });
    if (err) return next(err);
    upload(req, res).catch(next);
  });
});

async function upload(req, res) {
  if (!Buffer.isBuffer(req.body)) return res.status(415).json({ error: 'Use a PNG, JPEG, GIF or WebP image' });
  try {
    const image = await prepareSignatureImage(req.body);
    res.status(201).json(await saveSignatureImage(req.session.userId, image));
  } catch (err) {
    if (err instanceof SignatureImageError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
}

router.get('/:id', async (req, res) => {
  const image = await findSignatureImage(req.session.userId, req.params.id);
  if (!image) return res.status(404).end();
  // An image never changes once uploaded: a new upload is a new id.
  res.set('Cache-Control', 'private, max-age=31536000, immutable');
  res.set(IMAGE_SAFETY_HEADERS);
  res.set('Content-Type', image.content_type);
  res.send(Buffer.from(image.data));
});

export default router;
