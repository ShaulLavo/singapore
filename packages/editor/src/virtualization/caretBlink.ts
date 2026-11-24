/** Present on the caret layer during the hidden half of a blink. */
export const CARET_BLINK_OFF_ATTRIBUTE = 'data-editor-caret-blink-off'

const HALF_PERIOD_MS = 500

/**
 * The caret blinks by toggling one attribute on its layer twice a second.
 *
 * A CSS animation drew the same blink, but Chromium restyles an animated element in every frame it
 * renders, and any restyle makes it re-validate every CSS highlight in the document and repaint
 * each highlighted row. With a caret on screen, every frame of a scroll or of typing repainted all
 * mounted rows and took a frame longer to show. Two restyles a second cost nothing measurable.
 */
export class CaretBlink {
  private timer: ReturnType<typeof setTimeout> | null = null

  public constructor(private readonly layer: HTMLElement) {}

  /** Shows the caret solid from now, so it does not vanish mid-keystroke, and blinks from there. */
  public restart(): void {
    this.stop()
    this.schedule()
  }

  /** Keeps a running blink in its phase; starts one when none is running. */
  public run(): void {
    if (this.timer === null) this.schedule()
  }

  /** No caret is on screen: nothing to blink, and no timer left waking the page. */
  public stop(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.layer.removeAttribute(CARET_BLINK_OFF_ATTRIBUTE)
  }

  private schedule(): void {
    // @justification The blink's own clock; stop() clears it, and the view stops it on disposal.
    this.timer = setTimeout(() => {
      this.layer.toggleAttribute(CARET_BLINK_OFF_ATTRIBUTE)
      this.schedule()
    }, HALF_PERIOD_MS)
  }
}
