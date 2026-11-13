import { describe, it, expect, vi } from 'vitest';
vi.mock('./db.js', () => ({ query: vi.fn() }));
import sharp from 'sharp';
import {
  MAX_UPLOAD_BYTES, MAX_WIDTH, inlineSignatureImages, prepareSignatureImage, findSignatureImage,
} from './signatureImages.js';
import { embedInlineDataImages } from '../utils/inlineImages.js';

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const png = (width, height, channels = 4) => sharp({ create: { width, height, channels, background: { r: 10, g: 120, b: 200, alpha: 1 } } }).png().toBuffer();

describe('prepareSignatureImage', () => {
  it('scales a wide image down to the signature width, keeping its proportions', async () => {
    const out = await prepareSignatureImage(await png(1800, 300));
    expect(out).toMatchObject({ type: 'image/png', width: MAX_WIDTH, height: 100 });
    expect((await sharp(out.bytes).metadata()).width).toBe(MAX_WIDTH);
  });

  it('keeps a small image at its size', async () => {
    expect(await prepareSignatureImage(await png(120, 40))).toMatchObject({ type: 'image/png', width: 120, height: 40 });
  });

  it('turns WebP into a type every mail app shows', async () => {
    const opaque = await sharp({ create: { width: 50, height: 20, channels: 3, background: '#336699' } }).webp().toBuffer();
    expect((await prepareSignatureImage(opaque)).type).toBe('image/jpeg');
    const clear = await sharp({ create: { width: 50, height: 20, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.5 } } }).webp().toBuffer();
    expect((await prepareSignatureImage(clear)).type).toBe('image/png');
  });

  it('drops a photo\'s metadata', async () => {
    const jpeg = await sharp({ create: { width: 40, height: 40, channels: 3, background: '#808080' } })
      .withMetadata({ exif: { IFD0: { Copyright: 'secret place' } } }).jpeg().toBuffer();
    expect(jpeg.includes('secret place')).toBe(true);
    const out = await prepareSignatureImage(jpeg);
    expect(out.type).toBe('image/jpeg');
    expect(out.bytes.includes('secret place')).toBe(false);
  });

  it('refuses what is not a PNG, JPEG, GIF or WebP image, whatever it is called', async () => {
    await expect(prepareSignatureImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).rejects.toMatchObject({ status: 415 });
    await expect(prepareSignatureImage(Buffer.from('BM\0\0\0\0\0\0\0\0'))).rejects.toMatchObject({ status: 415 });
    await expect(prepareSignatureImage(Buffer.alloc(0))).rejects.toMatchObject({ status: 400 });
  });

  it('refuses a file over the upload limit, and an image whose bytes do not decode', async () => {
    await expect(prepareSignatureImage(Buffer.concat([await png(10, 10), Buffer.alloc(MAX_UPLOAD_BYTES)]))).rejects.toMatchObject({ status: 413 });
    await expect(prepareSignatureImage(Buffer.from('\x89PNG\r\n\x1a\nnot really', 'latin1'))).rejects.toMatchObject({ status: 400 });
  });
});

describe('findSignatureImage', () => {
  it('asks for the image of this user only, and never queries for an id that is not one', async () => {
    const queryFn = vi.fn(async () => ({ rows: [] }));
    expect(await findSignatureImage('user-2', ID, { queryFn })).toBeNull();
    expect(queryFn).toHaveBeenCalledWith(expect.stringContaining('user_id = $2'), [ID, 'user-2']);
    queryFn.mockClear();
    expect(await findSignatureImage('user-2', '../x', { queryFn })).toBeNull();
    expect(queryFn).not.toHaveBeenCalled();
  });
});

describe('inlineSignatureImages', () => {
  const bytes = Buffer.from('\x89PNG\r\n\x1a\nfake', 'latin1');
  const queryFn = vi.fn(async (_sql, [ids, userId]) => ({
    rows: userId === 'user-1' && ids.includes(ID) ? [{ id: ID, content_type: 'image/png', data: bytes }] : [],
  }));

  it('puts the owner\'s image in as a data: URI, which then goes out as a cid: part', async () => {
    const html = await inlineSignatureImages(`<p>Me</p><img src="/api/signature-images/${ID}" width="120" />`, 'user-1', { queryFn });
    expect(html).toBe(`<p>Me</p><img src="data:image/png;base64,${bytes.toString('base64')}" width="120" />`);
    expect(queryFn).toHaveBeenLastCalledWith(expect.stringContaining('user_id = $2'), [[ID], 'user-1']);
    const embedded = embedInlineDataImages(html);
    expect(embedded.html).toMatch(/<img src="cid:[^"]+" width="120" \/>/);
    expect(embedded.attachments[0]).toMatchObject({ contentType: 'image/png', contentDisposition: 'inline', content: bytes });
  });

  it('leaves out an image of another user, or one that is gone, rather than referring to this server', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const html = await inlineSignatureImages(`<img src="/api/signature-images/${ID}"><img src="/api/signature-images/${OTHER}">`, 'user-2', { queryFn });
    expect(html).toBe('');
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('leaves other HTML alone without querying', async () => {
    queryFn.mockClear();
    const html = '<img src="https://example.com/logo.png"><p>/api/signature-images/ in text</p>';
    expect(await inlineSignatureImages(html, 'user-1', { queryFn })).toBe(html);
    expect(await inlineSignatureImages(null, 'user-1', { queryFn })).toBeNull();
    expect(queryFn).not.toHaveBeenCalled();
  });
});
