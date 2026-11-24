/** Replace `start` to `end` of the previous text with `text`. */
export type InputWindowEdit = {
  readonly start: number
  readonly end: number
  readonly text: string
}

/** Characters compared to find where the shifted window lines up again. */
const ALIGN_PROBE = 24
/** How far a trimmed end may slide in one update and still be patched. */
const MAX_SHIFT = 256

/**
 * The few replacements that turn the hidden input's previous window into the next one.
 *
 * Writing a textarea's `value` rebuilds every line inside it (a text node and a break per line) and
 * restyles them, about a millisecond for a typical window in Chromium. A keystroke changes the
 * window in at most three places: the typed text, and the two trimmed ends sliding with the caret.
 * Those small edits can be applied in place instead. Returns them last-first, so each one's offsets
 * are still those of the previous text when it is applied, or null when the windows differ by more
 * than `maxChanged` characters or the alignment is not found.
 */
export function inputWindowEdits(
  previous: string,
  next: string,
  maxChanged = 256,
): readonly InputWindowEdit[] | null {
  if (previous === next) return []

  const head = alignHead(previous, next)
  const tail = alignTail(previous, next, head)
  const middle = middleEdit(previous, next, head, tail)
  const edits = [tail.edit, middle, head.edit].filter(isChange)
  let changed = 0
  for (const edit of edits) changed += edit.end - edit.start + edit.text.length
  if (changed > maxChanged) return null
  return applyInputWindowEdits(previous, edits) === next ? edits : null
}

/**
 * Moves a focused textarea's value to `next` through editing commands, which touch only the lines
 * they change. Reports whether the element now holds `next`; when it does not, the caller writes
 * the value outright. The commands raise `input` events (and `beforeinput` in WebKit), so the caller
 * must be ignoring its own writes, and they add to the element's undo history, so native history
 * input must be turned away (`historyUndo` / `historyRedo`).
 *
 * Not in WebKit, where an editing command costs as much as rewriting the value: see
 * browser-quirks.md#webkit-textarea-editing-commands-cost-a-value-write.
 */
export function patchTextareaValue(input: HTMLTextAreaElement, next: string): boolean {
  const document = input.ownerDocument
  // Editing commands act on the focused element; a shadow root reports its own.
  const root = input.getRootNode() as Document | ShadowRoot
  if (root.activeElement !== input || !editingCommandsPay(document)) return false
  const edits = inputWindowEdits(input.value, next)
  if (!edits) return false
  for (const edit of edits) {
    input.setSelectionRange(edit.start, edit.end)
    const applied =
      edit.text.length > 0
        ? document.execCommand('insertText', false, edit.text)
        : document.execCommand('delete')
    if (!applied) return false
  }
  return input.value === next
}

const editingCommandsPayByDocument = new WeakMap<Document, boolean>()

function editingCommandsPay(document: Document): boolean {
  const known = editingCommandsPayByDocument.get(document)
  if (known !== undefined) return known
  // Selects WebKit, not the cost: see the quirk entry named above.
  const webKit = document.defaultView?.CSS.supports('-webkit-nbsp-mode', 'space') ?? true
  const pays = typeof document.execCommand === 'function' && !webKit
  editingCommandsPayByDocument.set(document, pays)
  return pays
}

export function applyInputWindowEdits(text: string, edits: readonly InputWindowEdit[]): string {
  let result = text
  for (const edit of edits)
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end)
  return result
}

type Alignment = {
  /** Where the shared text starts (head) or ends (tail) in the previous window. */
  readonly previous: number
  /** The same point in the next window. */
  readonly next: number
  readonly edit: InputWindowEdit | null
}

function alignHead(previous: string, next: string): Alignment {
  const aligned = { previous: 0, next: 0, edit: null }
  if (commonPrefixLength(previous, next) >= ALIGN_PROBE) return aligned
  if (previous.length < ALIGN_PROBE || next.length < ALIGN_PROBE) return aligned

  // Code repeats itself, so a probe can also match a later line: the smaller shift is the real one.
  const dropped = shiftWithin(previous.indexOf(next.slice(0, ALIGN_PROBE), 1))
  const added = shiftWithin(next.indexOf(previous.slice(0, ALIGN_PROBE), 1))
  if (dropped <= added && dropped <= MAX_SHIFT)
    return { previous: dropped, next: 0, edit: { start: 0, end: dropped, text: '' } }
  if (added <= MAX_SHIFT)
    return { previous: 0, next: added, edit: { start: 0, end: 0, text: next.slice(0, added) } }
  return aligned
}

function alignTail(previous: string, next: string, head: Alignment): Alignment {
  const aligned = { previous: previous.length, next: next.length, edit: null }
  const previousRest = previous.length - head.previous
  const nextRest = next.length - head.next
  if (commonSuffixLength(previous, next, Math.min(previousRest, nextRest)) >= ALIGN_PROBE)
    return aligned
  if (previousRest < ALIGN_PROBE || nextRest < ALIGN_PROBE) return aligned

  const droppedAt = previous.lastIndexOf(
    next.slice(-ALIGN_PROBE),
    previous.length - ALIGN_PROBE - 1,
  )
  const dropped =
    droppedAt >= head.previous ? shiftWithin(previous.length - (droppedAt + ALIGN_PROBE)) : Infinity
  const addedAt = next.lastIndexOf(previous.slice(-ALIGN_PROBE), next.length - ALIGN_PROBE - 1)
  const added = addedAt >= head.next ? shiftWithin(next.length - (addedAt + ALIGN_PROBE)) : Infinity
  if (dropped <= added && dropped <= MAX_SHIFT) {
    const start = previous.length - dropped
    return { previous: start, next: next.length, edit: { start, end: previous.length, text: '' } }
  }

  if (added <= MAX_SHIFT) {
    const end = previous.length
    return {
      previous: end,
      next: next.length - added,
      edit: { start: end, end, text: next.slice(next.length - added) },
    }
  }
  return aligned
}

function middleEdit(
  previous: string,
  next: string,
  head: Alignment,
  tail: Alignment,
): InputWindowEdit | null {
  const previousMiddle = previous.slice(head.previous, tail.previous)
  const nextMiddle = next.slice(head.next, tail.next)
  let prefix = commonPrefixLength(previousMiddle, nextMiddle)
  // Never cut between the halves of a surrogate pair: a text control may not keep a lone half.
  if (prefix > 0 && isHighSurrogate(nextMiddle.charCodeAt(prefix - 1))) prefix -= 1
  let suffix = commonSuffixLength(
    previousMiddle,
    nextMiddle,
    Math.min(previousMiddle.length, nextMiddle.length) - prefix,
  )
  if (suffix > 0 && isLowSurrogate(nextMiddle.charCodeAt(nextMiddle.length - suffix))) suffix -= 1
  return {
    start: head.previous + prefix,
    end: tail.previous - suffix,
    text: nextMiddle.slice(prefix, nextMiddle.length - suffix),
  }
}

/** A positive shift, or Infinity for a probe that was not found (or found in place). */
const shiftWithin = (shift: number): number => (shift > 0 ? shift : Infinity)

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff

function isChange(edit: InputWindowEdit | null): edit is InputWindowEdit {
  return edit !== null && (edit.start !== edit.end || edit.text.length > 0)
}

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length)
  let index = 0
  while (index < limit && left.charCodeAt(index) === right.charCodeAt(index)) index += 1
  return index
}

function commonSuffixLength(left: string, right: string, limit: number): number {
  let length = 0
  while (
    length < limit &&
    left.charCodeAt(left.length - 1 - length) === right.charCodeAt(right.length - 1 - length)
  )
    length += 1
  return length
}
