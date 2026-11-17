// Sizes shared by the toolbars on a desktop, so a button is the same size wherever it sits. A phone
// keeps its own 44 px touch targets (MessageActions' TOUCH_TARGET). The font size setting scales
// the whole app (MailApp), these included.

// An icon-only button: its whole box is clickable.
export const HIT = 36;
// The main action of a context, drawn with a text label beside its icon (Reply, Send).
export const HIT_PRIMARY = 40;
// A toolbar icon.
export const ICON = 18;
// An icon inside a dense row, such as a message row's hover actions.
export const ICON_SMALL = 16;
// The space between two buttons of one toolbar.
export const TOOLBAR_GAP = 4;
// How wide a message toolbar must be to draw its main actions' labels; narrower, icons alone.
export const TOOLBAR_TEXT_MIN = 560;
export const RADIUS = 8;

// The box of an icon-only button. Spread it first and override what differs.
export const iconButtonBox = {
  width: HIT, height: HIT, minWidth: HIT, padding: 0, boxSizing: 'border-box', flexShrink: 0,
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: RADIUS,
};
