-- Contact groups. A group belongs to one address book and holds contacts by reference, so
-- deleting a group (or a membership) never touches a contact; deleting a contact only drops
-- its memberships. source = 'local' groups are edited here and synced over CardDAV as
-- KIND:group cards; source = 'category' groups mirror the CATEGORIES of vCards a client pushed
-- and are read-only.
CREATE TABLE IF NOT EXISTS contact_groups (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  address_book_id UUID        NOT NULL REFERENCES address_books(id) ON DELETE CASCADE,
  uid             TEXT        NOT NULL,
  name            TEXT        NOT NULL,
  source          TEXT        NOT NULL DEFAULT 'local' CHECK (source IN ('local', 'category')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (address_book_id, uid)
);

CREATE UNIQUE INDEX IF NOT EXISTS contact_groups_user_name_idx
  ON contact_groups (user_id, lower(name));

CREATE TABLE IF NOT EXISTS contact_group_members (
  group_id   UUID NOT NULL REFERENCES contact_groups(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, contact_id)
);

CREATE INDEX IF NOT EXISTS contact_group_members_contact_idx
  ON contact_group_members (contact_id);
