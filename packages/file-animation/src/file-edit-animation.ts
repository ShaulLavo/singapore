import type {
  EditorContributionChange,
  EditorPlugin,
  EditorViewContribution,
  EditorViewContributionContext,
  EditorViewContributionUpdateKind,
  EditorViewSnapshot,
} from '@singapore-editor/core/extensions'
import { TextMeasurer, canvasFont, renderedTabColumns } from './measure'
import { buildFrame, frameMoved, recolorFrame, type MorphFrame } from './morph-frame'
import { matchPieces } from './morph-match'
import { MorphRun, restingPieces, springEasing, type MorphTiming } from './morph-run'
import { RowCover } from './row-cover'
import { RowMoves, rowMoves } from './row-moves'
import { drawableRows, reducedMotion, supportsLinearEasing, type TextOffsetRange } from './motion'
import './style.css'

export type FileEditAnimationPluginOptions = {
  /** Length of one morph in milliseconds. Defaults to `520`. */
  readonly durationMs?: number
  /** Spring overshoot of moving text, from `0` (none) to `0.5`. Defaults to `0.18`. */
  readonly bounce?: number
  /** Safety cap on pieces drawn; a larger viewport skips the morph. Defaults to `2500`. */
  readonly maxPieces?: number
}

const ACTIVE_CLASS = 'editor-morph-active'

const TEXT_CHANGES = new Set(['edit', 'undo', 'redo', 'checkout', 'reconcile'])

/**
 * Text changes animate from the old text to the new: text that survives the
 * change slides to its new place, removed text fades out, and new text streams
 * in. Every change morphs except keyboard text input, so typing stays instant.
 * Including this plugin turns the effect on.
 */
export function createFileEditAnimationPlugin(
  options: FileEditAnimationPluginOptions = {},
): EditorPlugin {
  const resolved = {
    durationMs: positive(options.durationMs, 520),
    bounce: Math.min(0.5, Math.max(0, options.bounce ?? 0.18)),
    maxPieces: positive(options.maxPieces, 2500),
  }
  return {
    name: 'editor.fileEditAnimation',
    activate: (context) =>
      context.registerViewContribution({
        createContribution: (viewContext) =>
          new FileEditAnimationViewContribution(viewContext, resolved),
      }),
  }
}

type ResolvedEditAnimationOptions = {
  readonly durationMs: number
  readonly bounce: number
  readonly maxPieces: number
}

type EditFrame = Pick<EditorViewSnapshot, 'documentId' | 'textVersion' | 'visibleRows' | 'tokens'>

function editFrame(snapshot: EditorViewSnapshot): EditFrame | null {
  const { documentId, textVersion, visibleRows, tokens } = snapshot
  let capturedRows: EditorViewSnapshot['visibleRows'][number][] | null = null
  for (const [index, row] of visibleRows.entries()) {
    const text = row.text
    // A horizontally windowed row cannot be replayed as a whole line.
    if (typeof text !== 'string') return null
    if (row.chunks.every((chunk) => typeof chunk.text === 'string')) continue
    capturedRows ??= visibleRows.slice()
    capturedRows[index] = {
      ...row,
      chunks: row.chunks.map((chunk) => ({
        ...chunk,
        // Only mounted text is needed, never the source-backed RangeText reader.
        text:
          typeof chunk.text === 'string'
            ? chunk.text
            : text.slice(chunk.rowLocalStart, chunk.rowLocalEnd),
      })),
    }
  }
  return { documentId, textVersion, visibleRows: capturedRows ?? visibleRows, tokens }
}

class FileEditAnimationViewContribution implements EditorViewContribution {
  public readonly inputs = ['content', 'tokens', 'viewport', 'layout', 'selection'] as const
  private latest: EditFrame | null = null
  /** Mounted paint before `latest`'s text, without its complete document source. */
  private before: EditFrame | null = null
  /** Text painted as something other than its source (chips, hidden markup), for each snapshot. */
  private latestReplaced: readonly TextOffsetRange[] = []
  private beforeReplaced: readonly TextOffsetRange[] = []
  private moves: RowMoves | null = null
  private measurer: TextMeasurer | null = null
  private run: MorphRun | null = null
  /** The snapshot the running morph settles on, and the rows its overlay covers. */
  private runSnapshot: EditorViewSnapshot | null = null
  private runRows: ReadonlySet<number> = new Set()
  private readonly cover: RowCover
  private timing: MorphTiming | null = null

  public constructor(
    private readonly context: EditorViewContributionContext,
    private readonly options: ResolvedEditAnimationOptions,
  ) {
    // Added to an editor that already shows a document, the first change still needs its before.
    this.cover = new RowCover(context)
    if (context.hasDocument()) this.latest = editFrame(context.getSnapshot())
    this.latestReplaced = context.getInlineReplacementRanges()
  }

  public update(
    snapshot: EditorViewSnapshot,
    kind: EditorViewContributionUpdateKind,
    change?: EditorContributionChange | null,
  ): void {
    if (kind === 'document' || kind === 'clear') {
      this.finish()
      this.before = null
      this.beforeReplaced = []
      this.latest = kind === 'clear' ? null : editFrame(snapshot)
      this.latestReplaced = kind === 'clear' ? [] : this.context.getInlineReplacementRanges()
      return
    }
    // One pass can deliver the new text under several kinds, `viewport` before `content`.
    if (!this.latest || this.latest.textVersion !== snapshot.textVersion) {
      this.before = this.latest
      this.beforeReplaced = this.latestReplaced
    }
    this.latest = editFrame(snapshot)
    // Read while each snapshot is current: once the text changes, the old replacements are gone.
    if (kind !== 'viewport') this.latestReplaced = this.context.getInlineReplacementRanges()
    const previous = this.before
    if (kind === 'layout') this.measurer = null
    if (kind !== 'content' || (change && !TEXT_CHANGES.has(change.kind))) {
      this.keepCovering(snapshot, kind)
      return
    }
    if (!previous || previous.textVersion === snapshot.textVersion) return
    if (!this.shouldMorph(previous, snapshot, change ?? null)) {
      this.finish()
      return
    }
    this.morph(previous, snapshot)
  }

  // Between changes: keep repainted rows hidden and the overlay coloured, or settle when the rows
  // moved under it (new metrics, a rewrap). Newer text waits for its `content` update to retarget.
  private keepCovering(snapshot: EditorViewSnapshot, kind: EditorViewContributionUpdateKind): void {
    const started = this.runSnapshot
    if (!this.run || !started) return
    if (snapshot.textVersion !== started.textVersion) {
      // A text change that is not a morph (a save sync) repaints rows the overlay no longer matches.
      if (kind === 'content') this.finish()
      return
    }
    if (frameMoved(started, snapshot, this.runRows)) {
      this.finish()
      return
    }
    this.cover.refresh(snapshot)
    if (kind === 'tokens') this.run.recolor(recolorFrame(this.run.targetFrame, snapshot.tokens))
  }

  public dispose(): void {
    this.finish()
    this.latest = null
    this.before = null
    this.latestReplaced = []
    this.beforeReplaced = []
  }

  private shouldMorph(
    previous: EditFrame,
    snapshot: EditorViewSnapshot,
    change: EditorContributionChange | null,
  ): boolean {
    if (reducedMotion(this.context)) return false
    if (previous.documentId !== snapshot.documentId) return false
    // `setContent` on an editor without a session re-renders the whole text with no change record.
    // Typed text shows at once: a keystroke settles any morph instead of joining it.
    return !change?.typing
  }

  // Rows painted as their source text morph on the overlay. The rest (rendered Markdown, chips)
  // stay real and move as whole rows, because the overlay cannot draw what they show.
  private morph(previous: EditFrame, snapshot: EditorViewSnapshot): void {
    const drawn = drawableRows(snapshot, this.latestReplaced)
    const real = new Set(Array.from(snapshot.visibleRows, (row) => row.index))
    for (const index of drawn) real.delete(index)
    const { moves, taken } = rowMoves(previous, snapshot, real)
    const rows = this.cover.collect(snapshot, drawn)
    const measurer = this.ensureMeasurer(snapshot, rows[0]?.presentation.element)
    const next = buildFrame(snapshot, measurer, this.options.maxPieces, undefined, (row) =>
      drawn.has(row.index),
    )
    const from = this.run ? this.run.visualPieces() : this.restingFrom(previous, measurer, taken)
    if (!next || !from) {
      for (const row of rows) row.presentation.dispose()
      this.finish()
      return
    }
    const pairs = matchPieces(from, next.pieces)

    this.run?.cancel()
    this.moves?.cancel()
    const timing = this.ensureTiming()
    this.run = new MorphRun(this.context.contentElement, next, from, pairs, timing, () =>
      this.settleOverlay(),
    )
    this.moves = new RowMoves(this.context, moves, timing)
    this.context.scrollElement.classList.add(ACTIVE_CLASS)
    this.runSnapshot = snapshot
    this.runRows = drawn
    this.cover.cover(rows)
    this.context.log({
      level: 'info',
      action: 'morph.start',
      pieceCount: next.pieces.length,
      movedCount: pairs.reduce((count, old) => count + (old >= 0 ? 1 : 0), 0),
      fromCount: from.length,
    })
  }

  private restingFrom(previous: EditFrame, measurer: TextMeasurer, moving: ReadonlySet<number>) {
    const drawn = drawableRows(previous, this.beforeReplaced)
    const frame: MorphFrame | null = buildFrame(
      previous,
      measurer,
      this.options.maxPieces,
      undefined,
      (row) => drawn.has(row.index) && !moving.has(row.index),
    )
    return frame ? restingPieces(frame) : null
  }

  private finish(): void {
    this.moves?.cancel()
    this.moves = null
    this.settleOverlay()
  }

  /** Drops the overlay; rows still moving on their own finish their motion. */
  private settleOverlay(): void {
    this.context.scrollElement.classList.remove(ACTIVE_CLASS)
    this.cover.showAll()
    this.runSnapshot = null
    this.runRows = new Set()
    this.run?.cancel()
    this.run = null
  }

  private ensureMeasurer(snapshot: EditorViewSnapshot, row: Element | undefined): TextMeasurer {
    const fontSource = row ?? this.context.contentElement
    const font = canvasFont(fontSource)
    const tabColumns = renderedTabColumns(this.context.scrollElement, snapshot.tabSize)
    if (this.measurer?.font === font && this.measurer.tabColumns === tabColumns)
      return this.measurer
    this.measurer = new TextMeasurer(
      this.context.scrollElement.ownerDocument,
      font,
      snapshot.metrics.characterWidth,
      tabColumns,
    )
    return this.measurer
  }

  private ensureTiming(): MorphTiming {
    this.timing ??= {
      durationMs: this.options.durationMs,
      moveEasing: springEasing(this.options.bounce, supportsLinearEasing(this.context)),
    }
    return this.timing
  }
}

function positive(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback
  return value
}
