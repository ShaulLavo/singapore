import { nowMs } from '../editor/timing'

/** Present on the caret layer during the hidden half of a blink. */
export const CARET_BLINK_OFF_ATTRIBUTE = 'data-editor-caret-blink-off'

const HALF_PERIOD_MS = 500
/** Ten seconds of blinking, then a solid caret until the carets change again: GTK's default. */
const BLINK_DURATION_MS = 10_000

/**
 * The caret blinks by toggling one attribute on its layer twice a second.
 *
 * A CSS animation drew the same blink, but Chromium restyles an animated element in every frame it
 * renders, and any restyle makes it re-validate every CSS highlight in the document and repaint
 * each highlighted row. With a caret on screen, every frame of a scroll or of typing repainted all
 * mounted rows and took a frame longer to show. Two restyles a second cost nothing measurable.
 *
 * A blink ends ten seconds after the carets last changed and leaves them drawn, so a page left open
 * is not woken twice a second forever. The deadline is a time, not a count of callbacks: a
 * throttled or suspended page that runs one late callback ends the blink rather than resuming it.
 */
export class CaretBlink {
  private timer: ReturnType<typeof setTimeout> | null = null
  private deadline = 0
  /** Where the drawn carets were at the last update; null when none was drawn. */
  #drawn: string | null = null
  #restartRequested = false

  public constructor(
    private readonly layer: HTMLElement,
    private readonly now: () => number = nowMs,
  ) {}

  /** The text changed: the next update starts a fresh blink even if no caret moved. */
  public requestRestart(): void {
    this.#restartRequested = true
  }

  /**
   * The carets as just drawn: a key naming every drawn caret's position, or null when none is.
   * A new key — a caret moved, appeared or came back into view — or a requested restart shows the
   * carets solid and blinks from there; the same key keeps the phase, and an ended blink ended.
   */
  public update(drawn: string | null): void {
    if (drawn === null) {
      this.#drawn = null
      this.stop()
      return
    }
    const changed = drawn !== this.#drawn || this.#restartRequested
    this.#drawn = drawn
    this.#restartRequested = false
    if (changed) this.#restart()
  }

  /** No caret is on screen, or the view is gone: nothing to blink, and no timer left. */
  public stop(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.layer.removeAttribute(CARET_BLINK_OFF_ATTRIBUTE)
  }

  #restart(): void {
    this.stop()
    this.deadline = this.now() + BLINK_DURATION_MS
    this.schedule()
  }

  private schedule(): void {
    // @justification The blink's own clock, ended by a time deadline; stop() clears it, and the
    // view stops it on disposal.
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.now() >= this.deadline) {
        this.layer.removeAttribute(CARET_BLINK_OFF_ATTRIBUTE)
        return
      }
      this.layer.toggleAttribute(CARET_BLINK_OFF_ATTRIBUTE)
      this.schedule()
    }, HALF_PERIOD_MS)
  }
}
