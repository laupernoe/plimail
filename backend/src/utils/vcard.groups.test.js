import { describe, it, expect } from 'vitest';
import { parseVCard, generateVCard, generateGroupVCard } from './vcard.js';

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';

describe('group vCards (RFC 6350 KIND:group)', () => {
  it('round-trips a group: name, uid and members come back as written', () => {
    const card = generateGroupVCard({ uid: 'g-1', name: 'Team, A; B', memberUids: [U1, U2] });
    expect(card).toContain('KIND:group');
    expect(card).toContain(`MEMBER:urn:uuid:${U1}`);
    const parsed = parseVCard(card);
    expect(parsed.kind).toBe('group');
    expect(parsed.uid).toBe('g-1');
    expect(parsed.displayName).toBe('Team, A; B');
    expect(parsed.members).toEqual([U1, U2]);
  });

  it('writes a member whose uid is not a UUID so it reads back unchanged', () => {
    const card = generateGroupVCard({ uid: 'g-2', name: 'Odd', memberUids: ['abc@host'] });
    expect(parseVCard(card).members).toEqual(['abc@host']);
  });

  it('reads the Apple form (X-ADDRESSBOOKSERVER-*) the same way', () => {
    const card = [
      'BEGIN:VCARD', 'VERSION:3.0', 'UID:g-3', 'FN:Family',
      'X-ADDRESSBOOKSERVER-KIND:group',
      `X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:${U1}`,
      'END:VCARD', '',
    ].join('\r\n');
    const parsed = parseVCard(card);
    expect(parsed.kind).toBe('group');
    expect(parsed.members).toEqual([U1]);
  });

  it('a plain contact is not a group and has no members', () => {
    const parsed = parseVCard(generateVCard({ uid: 'c1', displayName: 'Ann', emails: [{ value: 'ann@example.com', type: 'other' }] }));
    expect(parsed.kind).toBe('individual');
    expect(parsed.members).toEqual([]);
    expect(parsed.categories).toEqual([]);
  });
});

describe('CATEGORIES', () => {
  it('reads comma-separated categories, including repeated lines and escaped commas', () => {
    const card = 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:c1\r\nFN:Ann\r\nCATEGORIES:Work,Friends\r\nCATEGORIES:Club\\, East\r\nEND:VCARD\r\n';
    expect(parseVCard(card).categories).toEqual(['Work', 'Friends', 'Club, East']);
  });

  it('writes categories back so editing a contact does not drop them', () => {
    const card = generateVCard({ uid: 'c1', displayName: 'Ann', categories: ['Work', 'Club, East'] });
    expect(parseVCard(card).categories).toEqual(['Work', 'Club, East']);
  });
});
