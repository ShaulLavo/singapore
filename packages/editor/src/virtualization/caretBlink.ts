const BLINK_PHASE_MS = 500

/**
 * Blinks the caret layer from a timer instead of an infinite CSS animation. A running animation
 * recalculates style on every frame the page produces, and Chromium then revisits every
 * registered CSS highlight range: a 6,000-line highlighted document scrolled at about 45 ms a frame
 * instead of 16.7, and every editor on the page kept its animation running, focused or not. The
 * timer touches the DOM once per phase, and only while focus is inside the editor. An unfocused
 * caret stays solid.
 */
export class CaretBlink {
  private timer: number | null = null
  private caretShown = false

  constructor(
    private readonly layer: HTMLElement,
    private readonly focusRoot: HTMLElement,
  ) {
    focusRoot.addEventListener('focusin', this.restart)
    focusRoot.addEventListener('focusout', this.handleFocusOut)
  }

  /** The caret was painted at its current position; it starts a fresh visible phase. */
  show(): void {
    this.caretShown = true
    this.restart()
  }

  hide(): void {
    this.caretShown = false
    this.stop()
  }

  dispose(): void {
    this.hide()
    this.focusRoot.removeEventListener('focusin', this.restart)
    this.focusRoot.removeEventListener('focusout', this.handleFocusOut)
  }

  private readonly restart = (): void => {
    this.stop()
    if (!this.caretShown || !this.focusRoot.matches(':focus-within')) return
    const window = this.layer.ownerDocument.defaultView
    if (!window) return
    // @justification The caret blink is wall-clock, not frame work: a frame-driven or CSS blink
    // recalculates style every frame. It runs only while the editor holds focus, one handle per
    // view, cleared on blur, caret hide, and dispose.
    this.timer = window.setInterval(this.toggle, BLINK_PHASE_MS)
  }

  private readonly handleFocusOut = (event: FocusEvent): void => {
    if (event.relatedTarget instanceof Node && this.focusRoot.contains(event.relatedTarget)) return
    this.stop()
  }

  private readonly toggle = (): void => {
    const layer = this.layer
    if (layer.dataset.editorCaretBlink === 'off') delete layer.dataset.editorCaretBlink
    else layer.dataset.editorCaretBlink = 'off'
  }

  private stop(): void {
    if (this.timer !== null) this.layer.ownerDocument.defaultView?.clearInterval(this.timer)
    this.timer = null
    if (this.layer.dataset.editorCaretBlink !== undefined)
      delete this.layer.dataset.editorCaretBlink
  }
}
