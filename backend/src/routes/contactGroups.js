import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import {
  GroupError, listGroups, getGroup, createGroup, renameGroup, deleteGroup,
  addMembers, removeMember, suggestGroups,
} from '../services/contactGroups.js';

const router = Router();
router.use(requireAuth);

function fail(res, err, what) {
  if (err instanceof GroupError) return res.status(err.status).json({ error: err.message });
  // An id that is not a UUID cannot be anyone's group.
  if (err.code === '22P02') return res.status(404).json({ error: 'Group not found' });
  console.error(`Contact group ${what} error:`, err);
  return res.status(500).json({ error: `Failed to ${what} group` });
}

// GET /api/contact-groups
router.get('/', async (req, res) => {
  try {
    res.json({ groups: await listGroups(req.session.userId) });
  } catch (err) {
    fail(res, err, 'list');
  }
});

// GET /api/contact-groups/suggest?q= : groups for the composer's recipient autocomplete.
// Above /:id so "suggest" is not read as an id.
router.get('/suggest', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (q.length < 2) return res.json({ groups: [] });
  if (q.length > 100) return res.status(400).json({ error: 'Query too long' });
  try {
    res.json({ groups: await suggestGroups(req.session.userId, q) });
  } catch (err) {
    fail(res, err, 'suggest');
  }
});

// GET /api/contact-groups/:id
router.get('/:id', async (req, res) => {
  try {
    res.json(await getGroup(req.session.userId, req.params.id));
  } catch (err) {
    fail(res, err, 'fetch');
  }
});

// POST /api/contact-groups { name }
router.post('/', async (req, res) => {
  try {
    res.status(201).json(await createGroup(req.session.userId, req.body?.name));
  } catch (err) {
    fail(res, err, 'create');
  }
});

// PATCH /api/contact-groups/:id { name }
router.patch('/:id', async (req, res) => {
  try {
    res.json(await renameGroup(req.session.userId, req.params.id, req.body?.name));
  } catch (err) {
    fail(res, err, 'rename');
  }
});

// DELETE /api/contact-groups/:id : removes the group and its memberships, never its contacts.
router.delete('/:id', async (req, res) => {
  try {
    await deleteGroup(req.session.userId, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    fail(res, err, 'delete');
  }
});

// POST /api/contact-groups/:id/members { contactIds: [...] }
router.post('/:id/members', async (req, res) => {
  try {
    await addMembers(req.session.userId, req.params.id, req.body?.contactIds);
    res.json(await getGroup(req.session.userId, req.params.id));
  } catch (err) {
    fail(res, err, 'update');
  }
});

// DELETE /api/contact-groups/:id/members/:contactId
router.delete('/:id/members/:contactId', async (req, res) => {
  try {
    await removeMember(req.session.userId, req.params.id, req.params.contactId);
    res.json({ ok: true });
  } catch (err) {
    fail(res, err, 'update');
  }
});

export default router;
