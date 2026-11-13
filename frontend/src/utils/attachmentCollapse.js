// A long attachment list collapses to its first few chips (#653). Anything the risk check
// flags stays visible regardless, so a dangerous file is never hidden behind the toggle.

export const COLLAPSE_THRESHOLD = 4;
export const COLLAPSED_VISIBLE = 3;

export const isCollapsible = (list) => list.length > COLLAPSE_THRESHOLD;

// The attachments to render. `isRisky(att)` is true for blocked or warned files.
export function visibleAttachments(list, expanded, isRisky) {
  if (expanded || !isCollapsible(list)) return list;
  return list.filter((att, i) => i < COLLAPSED_VISIBLE || isRisky(att));
}
