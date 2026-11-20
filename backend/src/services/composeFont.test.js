import { describe, it, expect } from 'vitest';
import { normalizeComposeFont, normalizeFontFamily, normalizeFontSize, wrapComposeFont } from './composeFont.js';
import { sanitizeEmail } from './emailSanitizer.js';

describe('compose font', () => {
  it('accepts the stacks the composer offers, with double quotes made single', () => {
    expect(normalizeFontFamily('Arial, Helvetica, sans-serif')).toBe('Arial, Helvetica, sans-serif');
    expect(normalizeFontFamily('"Trebuchet MS", Helvetica, sans-serif')).toBe("'Trebuchet MS', Helvetica, sans-serif");
    expect(normalizeFontFamily('')).toBe('');
    expect(normalizeFontFamily(undefined)).toBe('');
  });

  it('refuses a family that could leave the style attribute or carry CSS', () => {
    for (const bad of ['Arial;color:red', 'Arial" onload="x', 'url(x)', 'Arial<script>', 42, '  ,  ', 'a'.repeat(201)]) {
      expect(normalizeFontFamily(bad)).toBeUndefined();
    }
  });

  it('takes sizes from 8px to 72px only', () => {
    expect(normalizeFontSize('11px')).toBe('11px');
    expect(normalizeFontSize('')).toBe('');
    for (const bad of ['7px', '73px', '11pt', '11', 11, '1e1px', '11px;x']) expect(normalizeFontSize(bad)).toBeUndefined();
  });

  it('is null when nothing is set and undefined when malformed', () => {
    expect(normalizeComposeFont(undefined)).toBeNull();
    expect(normalizeComposeFont({ family: '', size: '' })).toBeNull();
    expect(normalizeComposeFont({ size: '11px' })).toEqual({ size: '11px' });
    expect(normalizeComposeFont('Arial')).toBeUndefined();
    expect(normalizeComposeFont({ family: 'x;y' })).toBeUndefined();
  });

  it('wraps only when a font is set', () => {
    expect(wrapComposeFont('<p>Hi</p>', null)).toBe('<p>Hi</p>');
    expect(wrapComposeFont('<p>Hi</p>', { family: "'Trebuchet MS', sans-serif", size: '11px' }))
      .toBe(`<div style="font-family:'Trebuchet MS', sans-serif;font-size:11px"><p>Hi</p></div>`);
  });

  it('survives the sanitizer, so the Sent copy shows it too', () => {
    const html = wrapComposeFont('<p>Hi</p>', normalizeComposeFont({ family: '"Times New Roman", Times, serif', size: '13px' }));
    const out = sanitizeEmail(html);
    expect(out).toMatch(/font-family:\s*'Times New Roman', Times, serif/);
    expect(out).toMatch(/font-size:\s*13px/);
  });
});
