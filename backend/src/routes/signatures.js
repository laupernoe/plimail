import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import {
  SignatureLibraryError, assignSignature, createSignature, deleteSignature, listSignatures, updateSignature,
} from '../services/signatureLibrary.js';

const router = Router();
router.use(requireAuth);

function fail(res, err, what) {
  if (err instanceof SignatureLibraryError) return res.status(err.status).json({ error: err.message });
  console.error(`Signature ${what} error:`, err);
  return res.status(500).json({ error: `Failed to ${what} signature` });
}

// GET /api/signatures
router.get('/', async (req, res) => {
  try {
    res.json(await listSignatures(req.session.userId));
  } catch (err) {
    fail(res, err, 'list');
  }
});

// POST /api/signatures { name, html }
router.post('/', async (req, res) => {
  try {
    res.status(201).json(await createSignature(req.session.userId, { name: req.body?.name, html: req.body?.html }));
  } catch (err) {
    fail(res, err, 'create');
  }
});

// PUT /api/signatures/assignment { accountId, aliasId?, signatureId } : signatureId null assigns
// none. Above /:id so "assignment" is not read as an id.
router.put('/assignment', async (req, res) => {
  const { accountId, aliasId = null, signatureId = null } = req.body || {};
  try {
    res.json(await assignSignature(req.session.userId, { accountId, aliasId, signatureId }));
  } catch (err) {
    fail(res, err, 'assign');
  }
});

// PUT /api/signatures/:id { name?, html? }
router.put('/:id', async (req, res) => {
  try {
    res.json(await updateSignature(req.session.userId, req.params.id, { name: req.body?.name, html: req.body?.html }));
  } catch (err) {
    fail(res, err, 'update');
  }
});

// DELETE /api/signatures/:id
router.delete('/:id', async (req, res) => {
  try {
    await deleteSignature(req.session.userId, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    fail(res, err, 'delete');
  }
});

export default router;
