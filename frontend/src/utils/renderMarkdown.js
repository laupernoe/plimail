import { marked } from 'marked';
import DOMPurify from 'dompurify';

// AI operation outputs are markdown; render them to sanitized HTML for display (#215).
// The text is model-generated and can be steered by email content (prompt injection),
// so it is treated as UNTRUSTED: the parsed HTML always goes through DOMPurify with a
// tight tag/attribute allow-list, and any raw HTML the model emits is neutralised.
marked.setOptions({
  gfm: true,     // tables, strikethrough, autolinks
  breaks: true,  // single newlines -> <br>, so plain-text (non-markdown) output keeps its line breaks
});

// Tags a markdown document can legitimately produce. Deliberately excludes <img>,
// <script>, <style>, <iframe>, and form elements, and <a>: a link written by the model, which
// the mail it read can steer, would sit in the app's own box looking like the app's advice.
const ALLOWED_TAGS = [
  'p', 'br', 'hr', 'strong', 'em', 'del', 's', 'code', 'pre', 'blockquote',
  'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
];

// Where a link really goes, shown when its text does not already say it.
export function linkTarget(href) {
  let url;
  try { url = new URL(href); } catch { return ''; }
  if (url.protocol === 'http:' || url.protocol === 'https:') return url.hostname;
  if (url.protocol === 'mailto:') return decodeURIComponent(url.pathname);
  return '';
}

// A link becomes its text, followed by its real domain unless the text is the address itself (an
// autolink). DOMPurify then drops the <a> and keeps what is inside. Registered per call and
// removed in finally so it never affects other DOMPurify sanitizes (e.g. the email renderer).
function unlink(node, data) {
  if (data.tagName !== 'a') return;
  const href = (node.getAttribute('href') || '').trim();
  const text = (node.textContent || '').trim();
  const target = linkTarget(href);
  const autolink = text === href || `http://${text}` === href || `mailto:${text}` === href;
  if (!target || autolink) return;
  node.parentNode?.insertBefore(node.ownerDocument.createTextNode(` (${target})`), node.nextSibling);
}

export function renderMarkdown(text) {
  const html = marked.parse(text || '', { async: false });
  DOMPurify.addHook('uponSanitizeElement', unlink);
  try {
    return DOMPurify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR: [] });
  } finally {
    DOMPurify.removeHook('uponSanitizeElement');
  }
}
