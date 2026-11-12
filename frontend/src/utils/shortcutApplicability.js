import { selectedPickerMessage } from './labelPicker.js';
import { topOpenMessageWindow } from './messageHotkeys.js';

const SELECTED_ACTIONS = new Set([
  'markUnread', 'forward', 'replyAllFromSelection', 'unsubscribe',
  'loadRemoteImages', 'openLabelPicker', 'reply', 'replyAll',
  'toggleStar', 'printMessage', 'toggleRead', 'selectMessage',
]);

const WINDOW_ACTIONS = new Set([
  'reply', 'replyAll', 'forward', 'replyAllFromSelection', 'toggleStar',
  'printMessage', 'markUnread', 'openLabelPicker',
]);

// The mail list and pane stay mounted (display: none) under the calendar and
// contacts pages, so these would otherwise act on a message the user cannot see.
const MAIL_VIEW_ACTIONS = new Set([
  ...SELECTED_ACTIONS, 'archive', 'delete', 'nextMessage', 'prevMessage', 'openMessage',
]);

export function canRunSelectedAction(action, state) {
  if ((state?.showCalendar || state?.showContacts) && MAIL_VIEW_ACTIONS.has(action)) {
    // A pop-out message window is still visible over those pages.
    if (!(WINDOW_ACTIONS.has(action) && topOpenMessageWindow(state))) return false;
  }
  if (!SELECTED_ACTIONS.has(action)) return true;
  if (!state?.selectedMessageId && !WINDOW_ACTIONS.has(action)) return false;
  return Boolean(selectedPickerMessage(state));
}

export function canHandlePaneShortcut(windowMessageId, state) {
  if (windowMessageId == null) return Boolean(state?.selectedMessageId);
  return topOpenMessageWindow(state)?.messageId === windowMessageId;
}
