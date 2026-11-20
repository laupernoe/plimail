// A textarea does not grow with its text on its own, so a quoted plain-text
// original sat in a fixed ~120px box however large the composer was. Size it to
// its content and let the composer body scroll instead of nesting a scrollbox.
export function fitTextarea(el, minHeight = 0) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${Math.max(el.scrollHeight, minHeight)}px`;
}
