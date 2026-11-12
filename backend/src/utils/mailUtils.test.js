import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mappedFolderUsable, resolveTrashFolder, resolveAllTrashPaths, resolveAllDraftsPaths, resolveArchiveFolder, resolveSentFolder, isAllMailFolder, resolveSpamFolder, getDeleteStrategy } from './mailUtils.js';

vi.mock('../services/db.js', () => ({
  query: vi.fn(),
}));

const { query } = await import('../services/db.js');

beforeEach(() => {
  query.mockClear();
});

describe('mappedFolderUsable', () => {
  it('returns null for a falsy path without querying the DB', async () => {
    expect(await mappedFolderUsable(1, null)).toBeNull();
    expect(await mappedFolderUsable(1, undefined)).toBeNull();
    expect(await mappedFolderUsable(1, '')).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it('returns the path when a selectable (no_select = false) folder row exists', async () => {
    query.mockResolvedValue({ rows: [{ '?column?': 1 }] });
    const result = await mappedFolderUsable(1, 'INBOX.Sent');
    expect(result).toBe('INBOX.Sent');
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0][0]).toContain('no_select = false');
    expect(query.mock.calls[0][1]).toEqual([1, 'INBOX.Sent']);
  });

  it('returns null when the folder is missing or non-selectable (no matching row)', async () => {
    query.mockResolvedValue({ rows: [] });
    expect(await mappedFolderUsable(1, '[Gmail]')).toBeNull();
  });
});

describe('resolveTrashFolder', () => {
  it('returns folder_mappings.trash when it points at a selectable folder', async () => {
    query.mockResolvedValue({ rows: [{ '?column?': 1 }] }); // mappedFolderUsable finds it
    const result = await resolveTrashFolder(1, { trash: 'INBOX.Trash' });
    expect(result).toBe('INBOX.Trash');
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0][0]).toContain('no_select = false');
  });

  it('ignores a mapping at a non-selectable folder and falls back to detection', async () => {
    query
      .mockResolvedValueOnce({ rows: [] })                         // mappedFolderUsable: not selectable
      .mockResolvedValueOnce({ rows: [{ path: 'INBOX.Trash' }] }); // \Trash detection
    const result = await resolveTrashFolder(1, { trash: '[Gmail]' });
    expect(result).toBe('INBOX.Trash');
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('falls back to special_use=\\Trash folder when no mapping is set', async () => {
    query.mockResolvedValue({ rows: [{ path: 'INBOX.Trash' }] });
    const result = await resolveTrashFolder(1, null);
    expect(result).toBe('INBOX.Trash');
    expect(query).toHaveBeenCalledOnce();
  });

  it('falls back to name heuristic when no special_use match exists', async () => {
    query.mockResolvedValue({ rows: [{ path: 'Deleted Messages' }] });
    const result = await resolveTrashFolder(2, {});
    expect(result).toBe('Deleted Messages');
  });

  it('returns null when no trash folder is found', async () => {
    query.mockResolvedValue({ rows: [] });
    const result = await resolveTrashFolder(3, undefined);
    expect(result).toBeNull();
  });
});

// Evaluates a folders lookup against `folders` rows the way Postgres would, so the tests below pin
// which folders count as Trash or Drafts rather than the SQL that picks them. It knows only the
// conditions the Trash and Drafts resolvers use, before and after this change, and throws on
// anything else, so a rewritten query cannot pass by being misread.
const FOLDER_CONDITIONS = [
  [/special_use = '(\\\w+)'/y, ([, flag]) => f => f.special_use === flag],
  [/lower\(name\) LIKE '%(\w+)%'/y, ([, word]) => f => f.name.toLowerCase().includes(word)],
  [/lower\(name\) IN \(([^)]*)\)/y, ([, list]) => f => list.split(', ').includes(`'${f.name.toLowerCase()}'`)],
  [/path = name/y, () => f => f.path === f.name],
  [/upper\(path\) = \('INBOX' \|\| delimiter \|\| upper\(name\)\)/y,
    () => f => f.delimiter !== null && f.path.toUpperCase() === `INBOX${f.delimiter}${f.name}`.toUpperCase()],
];

// SQL's AND binds tighter than its OR, as JS's && does ||.
function folderCondition(text) {
  let at = 0;
  const take = (re) => { re.lastIndex = at; const m = re.exec(text); if (m) at = re.lastIndex; return m; };
  const fail = () => { throw new Error(`unrecognised condition at "${text.slice(at)}" in: ${text}`); };
  const term = () => {
    if (take(/\(/y)) { const inner = anyOf(); return take(/\)/y) ? inner : fail(); }
    for (const [re, build] of FOLDER_CONDITIONS) { const m = take(re); if (m) return build(m); }
    return fail();
  };
  const allOf = () => { let t = term(); while (take(/ AND /y)) { const [a, b] = [t, term()]; t = f => a(f) && b(f); } return t; };
  const anyOf = () => { let t = allOf(); while (take(/ OR /y)) { const [a, b] = [t, allOf()]; t = f => a(f) || b(f); } return t; };
  const test = anyOf();
  return at === text.length ? test : fail();
}

function selectFolders(rawSql, folders) {
  const sql = rawSql.replace(/\s+/g, ' ').trim();
  const [, where, first, limit] = sql.match(
    /^SELECT path FROM folders WHERE account_id = \$1 AND (.+?)(?: ORDER BY \(CASE WHEN (.+) THEN 0 ELSE 1 END\))?(?: LIMIT (\d+))?$/
  ) ?? [];
  if (!where) throw new Error(`unrecognised query: ${sql}`);
  let rows = folders.filter(folderCondition(where));
  if (first) {
    const isFirst = folderCondition(first);
    rows = [...rows.filter(isFirst), ...rows.filter(f => !isFirst(f))];
  }
  return rows.slice(0, limit ? Number(limit) : undefined).map(({ path }) => ({ path }));
}

const answerFrom = (folders) => query.mockImplementation(async (sql) => ({ rows: selectFolders(sql, folders) }));

// A folders row as syncFolders stores it: `name` is the last segment of the path.
const folder = (path, special_use = null, delimiter = '/') => ({ path, name: path.split(delimiter).pop(), delimiter, special_use });

// Delete expunges mail in any folder these sets hold instead of moving it to Trash, so a user's
// own folder must never land in one.
describe('Trash and Drafts folders found by name', () => {
  afterEach(() => {
    query.mockReset();
  });

  it('counts a second Trash at the top level, but not user folders like "Deleted clients" or "Old Account/Trash"', async () => {
    answerFrom([
      folder('INBOX'), folder('Trash'), folder('Deleted Messages', '\\Trash'),
      folder('Deleted clients'), folder('Trash talk'), folder('Projects/Undeleted'),
      folder('Old Account/Trash'), folder('Imported/Deleted Items'),
    ]);
    expect(await resolveTrashFolder(1, null)).toBe('Deleted Messages');
    expect(await resolveAllTrashPaths(1, null)).toEqual(new Set(['Trash', 'Deleted Messages']));
  });

  it('counts a second Drafts under INBOX, but not user folders like "Blog drafts" or "Clients/Drafts"', async () => {
    answerFrom([
      folder('INBOX'), folder('Drafts', '\\Drafts'), folder('INBOX/Drafts'),
      folder('Blog drafts'), folder('Draft Contracts'), folder('Clients/Old Drafts'), folder('Clients/Drafts'),
    ]);
    expect(await resolveAllDraftsPaths(1, null)).toEqual(new Set(['Drafts', 'INBOX/Drafts']));
  });

  it('counts stock names directly under INBOX on a server that keeps every folder there', async () => {
    answerFrom([
      folder('INBOX', null, '.'), folder('INBOX.Trash', '\\Trash', '.'), folder('INBOX.Deleted Messages', null, '.'),
      folder('INBOX.Drafts', '\\Drafts', '.'), folder('INBOX.Clients.Trash', null, '.'), folder('INBOX.Clients.Drafts', null, '.'),
    ]);
    expect(await resolveAllTrashPaths(1, null)).toEqual(new Set(['INBOX.Trash', 'INBOX.Deleted Messages']));
    expect(await resolveAllDraftsPaths(1, null)).toEqual(new Set(['INBOX.Drafts']));
  });

  it('never picks a user folder as the Trash destination', async () => {
    answerFrom([folder('INBOX'), folder('Deleted clients'), folder('Old Account/Trash')]);
    expect(await resolveTrashFolder(1, null)).toBeNull();
    expect(await resolveAllTrashPaths(1, null)).toEqual(new Set());
  });
});

describe('resolveArchiveFolder', () => {
  it('returns folder_mappings.archive when it points at a selectable folder', async () => {
    query.mockResolvedValue({ rows: [{ '?column?': 1 }] });
    const result = await resolveArchiveFolder(1, { archive: 'INBOX.Archive' });
    expect(result).toBe('INBOX.Archive');
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0][0]).toContain('no_select = false');
  });

  it('falls back to special_use=\\Archive folder when no mapping is set', async () => {
    query.mockResolvedValue({ rows: [{ path: 'Archive' }] });
    const result = await resolveArchiveFolder(1, null);
    expect(result).toBe('Archive');
    expect(query).toHaveBeenCalledOnce();
  });

  it('falls back to name heuristic when no special_use match exists', async () => {
    query.mockResolvedValue({ rows: [{ path: 'INBOX.archive-2024' }] });
    const result = await resolveArchiveFolder(2, {});
    expect(result).toBe('INBOX.archive-2024');
  });

  it('falls back to special_use=\\All (Gmail All Mail) when nothing else matches', async () => {
    query.mockResolvedValue({ rows: [{ path: '[Gmail]/All Mail' }] });
    const result = await resolveArchiveFolder(4, {});
    expect(result).toBe('[Gmail]/All Mail');
  });

  it('returns null when no archive folder is found', async () => {
    query.mockResolvedValue({ rows: [] });
    const result = await resolveArchiveFolder(3, undefined);
    expect(result).toBeNull();
  });

  it('uses ORDER BY to prefer special_use=\\Archive, then name match, then \\All last', async () => {
    query.mockResolvedValue({ rows: [] });
    await resolveArchiveFolder(1, null);
    const sql = query.mock.calls[0][0];
    expect(sql).toContain("WHEN special_use = '\\Archive' THEN 0");
    expect(sql).toContain("WHEN lower(name) LIKE '%archive%' THEN 1");
  });
});

describe('isAllMailFolder', () => {
  it('returns false without querying the DB when path is falsy', async () => {
    const result = await isAllMailFolder(1, null);
    expect(result).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });

  it('returns true when the folder row has special_use = \\All', async () => {
    query.mockResolvedValue({ rows: [{ '?column?': 1 }] });
    const result = await isAllMailFolder(1, '[Gmail]/All Mail');
    expect(result).toBe(true);
    expect(query).toHaveBeenCalledOnce();
  });

  it('returns false when no matching \\All row exists', async () => {
    query.mockResolvedValue({ rows: [] });
    const result = await isAllMailFolder(1, 'Archive');
    expect(result).toBe(false);
  });
});

describe('resolveSpamFolder', () => {
  it('returns folder_mappings.spam when it points at a selectable folder', async () => {
    query.mockResolvedValue({ rows: [{ '?column?': 1 }] });
    const result = await resolveSpamFolder(1, { spam: '[Gmail]/Spam' });
    expect(result).toBe('[Gmail]/Spam');
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0][0]).toContain('no_select = false');
  });

  it('falls back to special_use=\\Junk folder when no mapping is set', async () => {
    query.mockResolvedValue({ rows: [{ path: 'Junk' }] });
    const result = await resolveSpamFolder(1, null);
    expect(result).toBe('Junk');
    expect(query).toHaveBeenCalledOnce();
  });

  it('falls back to multilingual name heuristic when no special_use match exists', async () => {
    query.mockResolvedValue({ rows: [{ path: 'Spamverdacht' }] });
    const result = await resolveSpamFolder(2, {});
    expect(result).toBe('Spamverdacht');
  });

  it('matches Outlook-style "Junk Email" folder name', async () => {
    query.mockResolvedValue({ rows: [{ path: 'Junk Email' }] });
    const result = await resolveSpamFolder(3, {});
    expect(result).toBe('Junk Email');
  });

  it('matches Italian "Posta indesiderata" folder name', async () => {
    query.mockResolvedValue({ rows: [{ path: 'Posta indesiderata' }] });
    const result = await resolveSpamFolder(4, {});
    expect(result).toBe('Posta indesiderata');
  });

  it('returns null when no spam folder is found', async () => {
    query.mockResolvedValue({ rows: [] });
    const result = await resolveSpamFolder(5, undefined);
    expect(result).toBeNull();
  });

  it('uses ORDER BY to prefer special_use match over name heuristic', async () => {
    query.mockResolvedValue({ rows: [] });
    await resolveSpamFolder(1, null);
    const sql = query.mock.calls[0][0];
    expect(sql).toContain("CASE WHEN special_use = '\\Junk' THEN 0 ELSE 1 END");
  });
});

describe('resolveSentFolder', () => {
  it('returns folder_mappings.sent when it points at a selectable folder', async () => {
    query.mockResolvedValue({ rows: [{ '?column?': 1 }] });
    const result = await resolveSentFolder(1, { sent: '[Gmail]/Odeslaná pošta' });
    expect(result).toBe('[Gmail]/Odeslaná pošta');
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0][0]).toContain('no_select = false');
  });

  it('ignores a mapping at the non-selectable [Gmail] parent and falls back to \\Sent (#386)', async () => {
    query
      .mockResolvedValueOnce({ rows: [] })                                     // [Gmail] not selectable
      .mockResolvedValueOnce({ rows: [{ path: '[Gmail]/Odeslaná pošta' }] });  // \Sent detection
    const result = await resolveSentFolder(1, { sent: '[Gmail]' });
    expect(result).toBe('[Gmail]/Odeslaná pošta');
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][0]).toContain("special_use = '\\Sent'");
  });

  it('falls back to \\Sent detection when no mapping is set (no validation query)', async () => {
    query.mockResolvedValue({ rows: [{ path: 'Sent' }] });
    const result = await resolveSentFolder(1, null);
    expect(result).toBe('Sent');
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0][0]).toContain("special_use = '\\Sent'");
  });

  it('returns null when no Sent folder can be resolved', async () => {
    query.mockResolvedValue({ rows: [] });
    expect(await resolveSentFolder(1, {})).toBeNull();
  });
});

describe('getDeleteStrategy', () => {
  it('returns no_trash when no Trash folder is configured', () => {
    expect(getDeleteStrategy('INBOX', null)).toEqual({ action: 'no_trash' });
    expect(getDeleteStrategy('INBOX', undefined)).toEqual({ action: 'no_trash' });
  });

  it('returns expunge when message is already in the Trash folder', () => {
    expect(getDeleteStrategy('INBOX/Trash', 'INBOX/Trash')).toEqual({ action: 'expunge' });
  });

  it('returns move when message is in a normal folder and Trash exists', () => {
    expect(getDeleteStrategy('INBOX', 'INBOX/Trash')).toEqual({ action: 'move', destination: 'INBOX/Trash' });
  });

  it('returns move for whatever trash path it is given (it does no DB validation itself)', () => {
    // getDeleteStrategy trusts the already-resolved path. resolveTrashFolder now validates the
    // mapping (see mappedFolderUsable), but if a stale-yet-selectable path still reaches here,
    // getDeleteStrategy returns 'move' and the IMAP call surfaces any failure to the caller.
    expect(getDeleteStrategy('INBOX', 'INBOX/OldTrash')).toEqual({ action: 'move', destination: 'INBOX/OldTrash' });
  });
});
