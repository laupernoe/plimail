import { describe, expect, it } from 'vitest';
import { detectInviteParts, MAX_INVITE_PART_BYTES } from './inviteParts.js';

describe('detectInviteParts', () => {
  it('finds the text/calendar part of an iMIP message before the .ics beside it', () => {
    const structure = { type: 'multipart/mixed', childNodes: [
      { type: 'multipart/alternative', childNodes: [
        { part: '1.1', type: 'text/plain', size: 100 },
        { part: '1.2', type: 'text/html', size: 200 },
      ] },
      { part: '2', type: 'application/ics', encoding: 'base64', size: 900, disposition: 'attachment' },
      { part: '1.3', type: 'text/calendar', encoding: 'quoted-printable', parameters: { charset: 'UTF-8', method: 'request' }, size: 800 },
    ] };
    expect(detectInviteParts(structure)).toEqual([
      { part: '1.3', type: 'text/calendar', encoding: 'quoted-printable', charset: 'utf-8', method: 'REQUEST' },
      { part: '2', type: 'application/ics', encoding: 'base64', charset: 'utf-8', method: null },
    ]);
  });

  it('reads a calendar-only body as part 1', () => {
    expect(detectInviteParts({ type: 'text/calendar', size: 10 })).toEqual([
      { part: '1', type: 'text/calendar', encoding: '7bit', charset: 'utf-8', method: null },
    ]);
  });

  it('finds nothing in ordinary mail, or in a calendar export too big to be an invitation', () => {
    expect(detectInviteParts({ type: 'multipart/alternative', childNodes: [{ part: '1', type: 'text/plain' }] })).toBeNull();
    expect(detectInviteParts({ type: 'multipart/mixed', childNodes: [{ part: '2', type: 'text/calendar', size: MAX_INVITE_PART_BYTES + 1 }] })).toBeNull();
    expect(detectInviteParts(null)).toBeNull();
  });
});
