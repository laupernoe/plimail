import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachmentBlobType } from './attachmentBlobType.js';

test('keeps a raster image type and makes everything else a download', () => {
  assert.equal(attachmentBlobType('image/png'), 'image/png');
  assert.equal(attachmentBlobType('IMAGE/JPEG; name="a.jpg"'), 'image/jpeg');
  assert.equal(attachmentBlobType('image/webp'), 'image/webp');
  for (const type of ['text/html', 'image/svg+xml', 'application/xhtml+xml', 'text/xml', 'application/pdf', '', undefined]) {
    assert.equal(attachmentBlobType(type), 'application/octet-stream');
  }
});
