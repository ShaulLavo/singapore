/** Present on the caret layer during the hidden half of a blink. */
export const CARET_BLINK_OFF_ATTRIBUTE = 'data-editor-caret-blink-off'

const HALF_PERIOD_MS = 500
/** Ten seconds of blinking, then a solid caret until it is drawn again: GTK's default. */
const MAX_HALF_PERIODS = 20

/**
 * The caret blinks by toggling one attribute on its layer twice a second.
 *
 * A CSS animation drew the same blink, but Chromium restyles an animated element in every frame it
 * renders, and any restyle makes it re-validate every CSS highlight in the document and repaint
 * each highlighted row. With a caret on screen, every frame of a scroll or of typing repainted all
 * mounted rows and took a frame longer to show. Two restyles a second cost nothing measurable.
 *
 * An idle caret stops blinking after ten seconds and stays drawn, so a page left open is not woken
 * twice a second forever. The next move or edit starts the blink again, and so does a caret that
 * leaves the screen and comes back.
 */
export class CaretBlink {
  private timer: ReturnType<typeof setTimeout> | null = null
  private halfPeriods = 0

  public constructor(private readonly layer: HTMLElement) {}

  /** Shows the caret solid from now, so it does not vanish mid-keystroke, and blinks from there. */
  public restart(): void {
    this.stop()
    this.schedule()
  }
  /** Keeps a running blink in its phase; starts one when none is running and none has run out. */
  public run(): void {
    if (this.timer === null && this.halfPeriods < MAX_HALF_PERIODS) this.schedule()
  }

  /** No caret is on screen: nothing to blink, and no timer left waking the page. */
  public stop(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.halfPeriods = 0
    this.layer.removeAttribute(CARET_BLINK_OFF_ATTRIBUTE)
  }

  private schedule(): void {
    // @justification The blink's own clock, bounded to MAX_HALF_PERIODS; stop() clears it, and the
    // view stops it on disposal.
    this.timer = setTimeout(() => {
      this.timer = null
      this.halfPeriods += 1
      if (this.halfPeriods >= MAX_HALF_PERIODS) {
        this.layer.removeAttribute(CARET_BLINK_OFF_ATTRIBUTE)
        return
      }
      this.layer.toggleAttribute(CARET_BLINK_OFF_ATTRIBUTE)
      this.schedule()
    }, HALF_PERIOD_MS)
  }
}
