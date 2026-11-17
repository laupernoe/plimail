// Contact groups: a named set of the user's contacts. Every function takes the user id and puts
// it in the SQL, so a group or contact of another user is never read or changed. Deleting a group
// removes its memberships only; no statement here deletes from contacts.
//
// Groups sync over CardDAV as KIND:group cards (routes/carddav.js builds them with the helpers at
// the bottom). Groups with source = 'category' mirror the CATEGORIES of cards a client pushed and
// are read-only here.
import crypto from 'crypto';
import { query } from './db.js';
import { generateGroupVCard } from '../utils/vcard.js';

export const MAX_GROUP_NAME = 100;

export class GroupError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function cleanGroupName(name) {
  const trimmed = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '';
  if (!trimmed) throw new GroupError(400, 'A group name is required');
  if (trimmed.length > MAX_GROUP_NAME) throw new GroupError(400, 'Group name too long');
  return trimmed;
}

async function personalBookId(userId) {
  const r = await query(
    `INSERT INTO address_books (user_id, name) VALUES ($1, 'Personal')
     ON CONFLICT (user_id, name) DO UPDATE SET updated_at = NOW()
     RETURNING id`,
    [userId]
  );
  return r.rows[0].id;
}

export async function bumpBook(bookId) {
  await query('UPDATE address_books SET sync_token = gen_random_uuid()::text, updated_at = NOW() WHERE id = $1', [bookId]);
}

// A local group the user owns, for a change. Category groups are read-only.
async function ownedGroup(userId, groupId, { writable = false } = {}) {
  const r = await query(
    'SELECT id, address_book_id, name, source FROM contact_groups WHERE id = $1 AND user_id = $2',
    [groupId, userId]
  );
  const group = r.rows[0];
  if (!group) throw new GroupError(404, 'Group not found');
  if (writable && group.source !== 'local') throw new GroupError(403, 'This group comes from the address book and is read-only');
  return group;
}

function uniqueNameError(err) {
  return err.code === '23505' ? new GroupError(409, 'A group with that name already exists') : err;
}

export async function listGroups(userId) {
  const r = await query(
    `SELECT g.id, g.name, g.source, g.created_at, g.updated_at,
            (SELECT COUNT(*) FROM contact_group_members m WHERE m.group_id = g.id)::int AS member_count
     FROM contact_groups g
     WHERE g.user_id = $1
     ORDER BY lower(g.name)`,
    [userId]
  );
  return r.rows;
}

export async function getGroup(userId, groupId) {
  const group = await ownedGroup(userId, groupId);
  const members = await query(
    `SELECT c.id, c.display_name, c.primary_email, (c.photo_data IS NOT NULL) AS has_contact_photo
     FROM contact_group_members m
     JOIN contacts c ON c.id = m.contact_id
     WHERE m.group_id = $1
     ORDER BY lower(coalesce(c.display_name, c.primary_email, ''))`,
    [group.id]
  );
  return { id: group.id, name: group.name, source: group.source, members: members.rows };
}

export async function createGroup(userId, name) {
  const clean = cleanGroupName(name);
  const bookId = await personalBookId(userId);
  try {
    const r = await query(
      `INSERT INTO contact_groups (user_id, address_book_id, uid, name)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, source, created_at, updated_at`,
      [userId, bookId, crypto.randomUUID(), clean]
    );
    await bumpBook(bookId);
    return { ...r.rows[0], member_count: 0 };
  } catch (err) {
    throw uniqueNameError(err);
  }
}

export async function renameGroup(userId, groupId, name) {
  const clean = cleanGroupName(name);
  const group = await ownedGroup(userId, groupId, { writable: true });
  try {
    const r = await query(
      `UPDATE contact_groups SET name = $1, updated_at = NOW()
       WHERE id = $2 AND user_id = $3
       RETURNING id, name, source, created_at, updated_at`,
      [clean, group.id, userId]
    );
    await bumpBook(group.address_book_id);
    return r.rows[0];
  } catch (err) {
    throw uniqueNameError(err);
  }
}

// Deletes the group and, through the foreign key, its memberships. Never the contacts.
export async function deleteGroup(userId, groupId) {
  const group = await ownedGroup(userId, groupId, { writable: true });
  await query('DELETE FROM contact_groups WHERE id = $1 AND user_id = $2', [group.id, userId]);
  await bumpBook(group.address_book_id);
}

export async function addMembers(userId, groupId, contactIds) {
  if (!Array.isArray(contactIds) || !contactIds.length || contactIds.length > 1000) {
    throw new GroupError(400, 'contactIds must be a non-empty array');
  }
  const group = await ownedGroup(userId, groupId, { writable: true });
  // Only the user's own contacts are inserted: ids of anyone else's simply match no row.
  await query(
    `INSERT INTO contact_group_members (group_id, contact_id)
     SELECT $1, c.id FROM contacts c WHERE c.id = ANY($2::uuid[]) AND c.user_id = $3
     ON CONFLICT DO NOTHING`,
    [group.id, contactIds.map(String), userId]
  );
  await query('UPDATE contact_groups SET updated_at = NOW() WHERE id = $1 AND user_id = $2', [group.id, userId]);
  await bumpBook(group.address_book_id);
}

export async function removeMember(userId, groupId, contactId) {
  const group = await ownedGroup(userId, groupId, { writable: true });
  await query('DELETE FROM contact_group_members WHERE group_id = $1 AND contact_id = $2', [group.id, contactId]);
  await query('UPDATE contact_groups SET updated_at = NOW() WHERE id = $1 AND user_id = $2', [group.id, userId]);
  await bumpBook(group.address_book_id);
}

// Composer autocomplete: groups whose name matches, with the members that have an address.
export async function suggestGroups(userId, q) {
  const r = await query(
    `SELECT g.id, g.name,
            COALESCE(json_agg(json_build_object('name', c.display_name, 'email', c.primary_email)
                              ORDER BY lower(coalesce(c.display_name, c.primary_email)))
                     FILTER (WHERE c.primary_email IS NOT NULL AND c.primary_email <> ''), '[]'::json) AS members
     FROM contact_groups g
     LEFT JOIN contact_group_members m ON m.group_id = g.id
     LEFT JOIN contacts c ON c.id = m.contact_id AND c.user_id = g.user_id
     WHERE g.user_id = $1 AND g.name ILIKE $2
     GROUP BY g.id
     ORDER BY lower(g.name)
     LIMIT 5`,
    [userId, `%${q.replace(/[\\%_]/g, '\\$&')}%`]
  );
  return r.rows;
}

// ── CardDAV ──────────────────────────────────────────────────────────────────

function cardFor(group, memberUids) {
  const vcard = generateGroupVCard({ uid: group.uid, name: group.name, memberUids });
  return { uid: group.uid, vcard, etag: crypto.createHash('md5').update(vcard).digest('hex') };
}

// The local groups of an address book as cards. Category groups are left out: their members
// already carry the category on their own cards.
export async function groupCards(bookId) {
  const r = await query(
    `SELECT g.uid, g.name,
            COALESCE(array_agg(c.uid ORDER BY c.uid) FILTER (WHERE c.uid IS NOT NULL), '{}') AS member_uids
     FROM contact_groups g
     LEFT JOIN contact_group_members m ON m.group_id = g.id
     LEFT JOIN contacts c ON c.id = m.contact_id
     WHERE g.address_book_id = $1 AND g.source = 'local'
     GROUP BY g.id
     ORDER BY g.uid`,
    [bookId]
  );
  return r.rows.map(row => cardFor(row, row.member_uids));
}

export async function groupCard(bookId, uid) {
  return (await groupCards(bookId)).find(card => card.uid === uid) || null;
}

// A client PUT a KIND:group card: create or update the local group and replace its members with
// the contacts of this user whose uid the card names. Returns 'created' | 'updated' | 'conflict'.
export async function applyGroupCard(userId, bookId, uid, parsed) {
  const name = cleanGroupName(parsed.displayName);
  const existing = await query(
    'SELECT id, source FROM contact_groups WHERE address_book_id = $1 AND uid = $2 AND user_id = $3',
    [bookId, uid, userId]
  );
  let groupId;
  let outcome;
  try {
    if (existing.rows.length) {
      if (existing.rows[0].source !== 'local') return 'conflict';
      groupId = existing.rows[0].id;
      await query('UPDATE contact_groups SET name = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3', [name, groupId, userId]);
      outcome = 'updated';
    } else {
      const r = await query(
        'INSERT INTO contact_groups (user_id, address_book_id, uid, name) VALUES ($1, $2, $3, $4) RETURNING id',
        [userId, bookId, uid, name]
      );
      groupId = r.rows[0].id;
      outcome = 'created';
    }
  } catch (err) {
    if (err.code === '23505') return 'conflict';
    throw err;
  }
  await query('DELETE FROM contact_group_members WHERE group_id = $1', [groupId]);
  if (parsed.members.length) {
    await query(
      `INSERT INTO contact_group_members (group_id, contact_id)
       SELECT $1, c.id FROM contacts c WHERE c.user_id = $2 AND c.address_book_id = $3 AND c.uid = ANY($4::text[])
       ON CONFLICT DO NOTHING`,
      [groupId, userId, bookId, parsed.members]
    );
  }
  return outcome;
}

// Returns true when a local group with this uid existed and was deleted (its contacts stay).
export async function deleteGroupByUid(userId, bookId, uid) {
  const r = await query(
    `DELETE FROM contact_groups WHERE address_book_id = $1 AND uid = $2 AND user_id = $3 AND source = 'local' RETURNING id`,
    [bookId, uid, userId]
  );
  return r.rows.length > 0;
}

// Make the contact's category groups equal to the CATEGORIES of the card just stored: create the
// missing groups (read-only), add the contact, and drop it from category groups it left. A
// category that matches a local group's name only adds to nothing; it never touches the local group.
export async function syncContactCategories(userId, bookId, contactId, categories) {
  const names = [...new Set(categories.map(c => c.trim()).filter(Boolean).filter(c => c.length <= MAX_GROUP_NAME))];
  if (names.length) {
    await query(
      `INSERT INTO contact_groups (user_id, address_book_id, uid, name, source)
       SELECT $1, $2, gen_random_uuid()::text, n, 'category' FROM unnest($3::text[]) AS n
       ON CONFLICT DO NOTHING`,
      [userId, bookId, names]
    );
    await query(
      `INSERT INTO contact_group_members (group_id, contact_id)
       SELECT g.id, $1 FROM contact_groups g
       WHERE g.user_id = $2 AND g.source = 'category' AND lower(g.name) = ANY($3::text[])
       ON CONFLICT DO NOTHING`,
      [contactId, userId, names.map(n => n.toLowerCase())]
    );
  }
  await query(
    `DELETE FROM contact_group_members m USING contact_groups g
     WHERE m.contact_id = $1 AND g.id = m.group_id AND g.user_id = $2 AND g.source = 'category'
       AND NOT (lower(g.name) = ANY($3::text[]))`,
    [contactId, userId, names.map(n => n.toLowerCase())]
  );
  // A category group nobody belongs to any more has nothing left to show.
  await query(
    `DELETE FROM contact_groups g
     WHERE g.user_id = $1 AND g.source = 'category'
       AND NOT EXISTS (SELECT 1 FROM contact_group_members m WHERE m.group_id = g.id)`,
    [userId]
  );
}

export async function categoryNames(userId, contactId) {
  const r = await query(
    `SELECT g.name FROM contact_groups g
     JOIN contact_group_members m ON m.group_id = g.id
     WHERE m.contact_id = $1 AND g.user_id = $2 AND g.source = 'category'
     ORDER BY lower(g.name)`,
    [contactId, userId]
  );
  return r.rows.map(row => row.name);
}
