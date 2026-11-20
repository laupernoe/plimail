import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { composeFontPayload, composeFontVars, knownFontFamily, knownFontSize, wrapComposeFont, DEFAULT_FONT_GROUPS } from './composeFont.js';
import { securePayloadFrom } from './secureSend.js';

const TREBUCHET = '"Trebuchet MS", Helvetica, sans-serif';

describe('default writing font', () => {
  it('sends nothing on Default, so the message is built exactly as before', () => {
    assert.equal(composeFontPayload('', ''), undefined);
    assert.equal(composeFontPayload('Wingdings', '99px'), undefined);
    assert.deepEqual(composeFontPayload('Arial, Helvetica, sans-serif', '11px'), { family: 'Arial, Helvetica, sans-serif', size: '11px' });
    assert.deepEqual(composeFontPayload('', '12px'), { size: '12px' });
  });

  it('knows a stack back from the server, which stores its double quotes as single ones', () => {
    assert.equal(knownFontFamily("'Trebuchet MS', Helvetica, sans-serif"), TREBUCHET);
    assert.equal(knownFontFamily(TREBUCHET), TREBUCHET);
    assert.equal(knownFontFamily('Comic'), '');
    assert.equal(knownFontSize('11px'), '11px');
    assert.equal(knownFontSize('11'), '');
  });

  it('offers the usual email fonts and none of the display faces', () => {
    const labels = DEFAULT_FONT_GROUPS.flatMap(g => g.fonts.map(f => f.label));
    for (const name of ['Arial', 'Helvetica', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Georgia', 'Times New Roman', 'Courier New', 'Calibri']) {
      assert.ok(labels.includes(name), name);
    }
    assert.ok(!labels.includes('Impact'));
  });

  it('gives the editor CSS variables only for what is set', () => {
    assert.deepEqual(composeFontVars('', ''), {});
    assert.deepEqual(composeFontVars(TREBUCHET, '11px'), { '--compose-font-family': TREBUCHET, '--compose-font-size': '11px' });
  });

  it('wraps a browser-built message as the server does, the quote outside', () => {
    assert.equal(wrapComposeFont('<p>x</p>', undefined), '<p>x</p>');
    const { html } = securePayloadFrom({ bodyIsHtml: true, body: '<p>Hi</p>', editedSignature: '<i>S</i>', quotedBodyHtml: '<blockquote>q</blockquote>', composeFont: { family: TREBUCHET, size: '11px' } });
    assert.equal(html, `<div style="font-family:'Trebuchet MS', Helvetica, sans-serif;font-size:11px"><p>Hi</p><div style="margin-top:16px;color:#555;font-size:13px"><i>S</i></div></div><blockquote>q</blockquote>`);
    assert.equal(securePayloadFrom({ bodyIsHtml: true, body: '<p>Hi</p>' }).html, '<p>Hi</p>');
  });
});
