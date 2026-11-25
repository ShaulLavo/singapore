import { EditorDisposableStore, MutableEditorDisposable } from '../editor/disposables'
import type { EditorDisposable } from '../editor/disposables'
import {
  clearGlyphAdvancesCache,
  glyphAdvancesCacheKey,
  invalidateGlyphAdvancesKey,
} from './glyphAdvances'

export type BrowserTextMetrics = {
  readonly rowHeight: number
  readonly characterWidth: number
}

/** Glyphs a whitespace marker can be drawn with: U+00B7 middle dot, U+2E31 word separator dot. */
export type WhitespaceDotGlyph = '·' | '⸱'

type WatchedSize = {
  readonly width: number
  readonly height: number
}

// The measured record carries more than callers may hand in as an override, so it stays internal.
type MeasuredTextMetrics = BrowserTextMetrics & {
  readonly whitespaceDotGlyph: WhitespaceDotGlyph
  readonly monospace: boolean
  readonly watchedSize: WatchedSize
}

const DEFAULT_ROW_HEIGHT = 24
const DEFAULT_CHARACTER_WIDTH = 8
const PROBE_LENGTH = 16
const PROBE_TEXT = 'm'.repeat(PROBE_LENGTH)
const SPACE_PROBE_TEXT = ' '.repeat(PROBE_LENGTH)
// U+00B7 leads: it is present in every font we are likely to be configured with, so it is the
// answer whenever the comparison cannot be made.
const DEFAULT_WHITESPACE_DOT_GLYPH: WhitespaceDotGlyph = '·'
const WHITESPACE_DOT_GLYPHS: readonly WhitespaceDotGlyph[] = [DEFAULT_WHITESPACE_DOT_GLYPH, '⸱']
// Monaco's set of narrow, wide and punctuation glyphs and digits, in the regular face only: rows
// never draw bold or italic, because `::highlight()` cannot set font properties.
const MONOSPACE_PROBE_GLYPHS = ['i', 'l', '|', '/', '-', '_', '%', 'W', '0', '1']
const MONOSPACE_PROBE_TEXTS = MONOSPACE_PROBE_GLYPHS.map((glyph) => glyph.repeat(PROBE_LENGTH))
// One of every measured glyph: its box moves when any advance or the line box does.
const WATCHED_PROBE_TEXT = `m ${MONOSPACE_PROBE_GLYPHS.join('')}`
// Layout reports 1/64 px; over the 16-glyph probe that bounds one advance to about 0.001 px.
const MONOSPACE_EPSILON = 0.002
// `getBoundingClientRect` and ResizeObserver `borderBoxSize` can differ by sub-pixel rounding.
const WATCHED_SIZE_EPSILON = 0.05
const NO_INVALIDATION: EditorDisposable = { dispose: () => {} }
let metricsCache = new WeakMap<Document, Map<string, MeasuredTextMetrics>>()
const unmeasuredElements = new WeakSet<HTMLElement>()

export function measureBrowserTextMetrics(element: HTMLElement): BrowserTextMetrics {
  return measureTextMetrics(element)
}

/**
 * A whitespace marker is painted over the column its space occupies, so the glyph to draw it with
 * is whichever candidate the font gives an advance nearest that space — a wider one leans into the
 * next column and shifts every glyph after it along the line.
 */
export function measureWhitespaceDotGlyph(element: HTMLElement): WhitespaceDotGlyph {
  return measureTextMetrics(element).whitespaceDotGlyph
}

/**
 * The metrics, and whether every probed glyph, space included, advances by the measured character
 * width. When it does not, column arithmetic lands clicks and carets on the wrong character.
 */
export function measureBrowserTextFace(
  element: HTMLElement,
): BrowserTextMetrics & { readonly monospace: boolean } {
  return measureTextMetrics(element)
}

/**
 * Drops the cache and re-measures when a reading goes stale without an error: the face the element
 * draws with changes (a font setting, a late web font, a size) or the display scaling does. Either
 * leaves every column position in the editor wrong for the rest of the session.
 */
export function observeBrowserTextMetricsInvalidation(
  element: HTMLElement,
  onInvalidated: () => void,
): EditorDisposable {
  const view = element.ownerDocument.defaultView
  if (!view) return NO_INVALIDATION

  const source = invalidationSources.get(view) ?? createInvalidationSource(view)
  source.listeners.add(onInvalidated)
  const face = source.faces?.watch(element, onInvalidated) ?? NO_INVALIDATION
  return {
    dispose: () => {
      face.dispose()
      if (!source.listeners.delete(onInvalidated)) return
      if (source.listeners.size > 0) return

      invalidationSources.delete(view)
      source.dispose()
    },
  }
}

export function clearBrowserTextMetricsCache(): void {
  metricsCache = new WeakMap<Document, Map<string, MeasuredTextMetrics>>()
  clearGlyphAdvancesCache()
}

function measureTextMetrics(element: HTMLElement): MeasuredTextMetrics {
  const cacheKey = browserTextMetricsCacheKey(element)
  const cached = cacheKey ? cachedBrowserTextMetrics(element.ownerDocument, cacheKey) : null
  if (cached) return cached

  const document = element.ownerDocument
  const probe = appendProbe(element, PROBE_TEXT)
  const spaceProbe = appendProbe(element, SPACE_PROBE_TEXT)
  const watchedProbe = appendProbe(element, WATCHED_PROBE_TEXT)
  const dotProbes = WHITESPACE_DOT_GLYPHS.map((glyph) =>
    appendProbe(element, glyph.repeat(PROBE_LENGTH)),
  )
  const monospaceProbes = MONOSPACE_PROBE_TEXTS.map((text) => appendProbe(element, text))

  // Every probe is attached before the first read, so the whole set costs one layout.
  const rect = probe.getBoundingClientRect()
  const watchedRect = watchedProbe.getBoundingClientRect()
  const style = readComputedStyle(probe)
  const spaceWidth = measuredAdvance(spaceProbe)
  const dotWidths = dotProbes.map(measuredAdvance)
  const monospaceWidths = [spaceWidth].concat(monospaceProbes.map(measuredAdvance))
  for (const attached of [probe, spaceProbe, watchedProbe].concat(dotProbes, monospaceProbes)) {
    attached.remove()
  }

  const metrics: MeasuredTextMetrics = {
    rowHeight: measuredRowHeight(rect, style),
    characterWidth: measuredCharacterWidth(rect),
    whitespaceDotGlyph: nearestWhitespaceDotGlyph(spaceWidth, dotWidths),
    monospace: advancesAgree(rect.width / PROBE_LENGTH, monospaceWidths),
    watchedSize: { width: watchedRect.width, height: watchedRect.height },
  }
  // A hidden probe reports zero geometry; its fallback must not become a shared font measurement.
  if (cacheKey && rect.width > 0 && rect.height > 0) {
    unmeasuredElements.delete(element)
    cacheBrowserTextMetrics(document, cacheKey, metrics)
  } else {
    unmeasuredElements.add(element)
  }
  return metrics
}

function appendProbe(element: HTMLElement, text: string): HTMLSpanElement {
  const probe = element.ownerDocument.createElement('span')
  probe.className = 'editor-virtualized-metric-probe'
  probe.textContent = text
  element.appendChild(probe)
  return probe
}

// An unmeasurable probe (hidden host, no layout engine) proves nothing, so it keeps the fast path.
function advancesAgree(characterWidth: number, widths: readonly (number | null)[]): boolean {
  if (!Number.isFinite(characterWidth) || characterWidth <= 0) return true
  for (const width of widths) {
    if (width === null) continue
    if (Math.abs(width - characterWidth) > MONOSPACE_EPSILON) return false
  }
  return true
}

function measuredAdvance(probe: HTMLElement): number | null {
  const width = probe.getBoundingClientRect().width
  if (!Number.isFinite(width) || width <= 0) return null
  return width / PROBE_LENGTH
}

function nearestWhitespaceDotGlyph(
  spaceWidth: number | null,
  dotWidths: readonly (number | null)[],
): WhitespaceDotGlyph {
  let nearest: WhitespaceDotGlyph = DEFAULT_WHITESPACE_DOT_GLYPH
  if (spaceWidth === null) return nearest

  // A font missing one of the glyphs still reports an advance, for whatever face the browser
  // substituted — comparing against the space is what tells the two cases apart.
  let nearestDistance = Number.POSITIVE_INFINITY
  for (const [index, glyph] of WHITESPACE_DOT_GLYPHS.entries()) {
    const width = dotWidths[index]
    if (width === null || width === undefined) continue

    const distance = Math.abs(width - spaceWidth)
    if (distance >= nearestDistance) continue

    nearest = glyph
    nearestDistance = distance
  }

  return nearest
}

function measuredRowHeight(rect: DOMRect, style: CSSStyleDeclaration | undefined): number {
  const lineHeight = cssPixels(style, 'lineHeight')
  if (lineHeight !== null && lineHeight > 0) return lineHeight
  if (Number.isFinite(rect.height) && rect.height > 0) return rect.height

  const fontSize = cssPixels(style, 'fontSize')
  if (fontSize !== null && fontSize > 0) return Math.ceil(fontSize * 1.5)
  return DEFAULT_ROW_HEIGHT
}

function measuredCharacterWidth(rect: DOMRect): number {
  if (!Number.isFinite(rect.width) || rect.width <= 0) return DEFAULT_CHARACTER_WIDTH
  return Math.max(1, rect.width / PROBE_TEXT.length)
}

function readComputedStyle(element: HTMLElement): CSSStyleDeclaration | undefined {
  try {
    return element.ownerDocument.defaultView?.getComputedStyle(element)
  } catch {
    return undefined
  }
}

function cssPixels(
  style: CSSStyleDeclaration | undefined,
  property: 'fontSize' | 'lineHeight',
): number | null {
  try {
    return parseCssPixels(style?.[property])
  } catch {
    return null
  }
}

function parseCssPixels(value: string | undefined): number | null {
  if (!value || value === 'normal') return null

  const pixels = Number.parseFloat(value)
  if (!Number.isFinite(pixels)) return null
  return pixels
}

function cachedBrowserTextMetrics(document: Document, key: string): MeasuredTextMetrics | null {
  return metricsCache.get(document)?.get(key) ?? null
}

function cacheBrowserTextMetrics(
  document: Document,
  key: string,
  metrics: MeasuredTextMetrics,
): void {
  const cache = metricsCache.get(document) ?? new Map<string, MeasuredTextMetrics>()
  cache.set(key, metrics)
  metricsCache.set(document, cache)
}

function browserTextMetricsCacheKey(element: HTMLElement): string | null {
  const style = readComputedStyle(element)
  if (!style) return null

  return [
    // Glyph advances are snapped to the physical pixel grid, so one CSS font measures differently
    // once the display scaling changes — same styles, different reading.
    element.ownerDocument.defaultView?.devicePixelRatio ?? 1,
    style.fontFamily,
    style.fontSize,
    style.fontStyle,
    style.fontStretch,
    style.fontVariant,
    style.fontWeight,
    style.letterSpacing,
    style.lineHeight,
    style.textTransform,
    style.whiteSpace,
  ].join('\n')
}

type BrowserTextMetricsInvalidationSource = {
  readonly listeners: Set<() => void>
  readonly faces: FaceObserver | null
  dispose(): void
}

type FaceObserver = {
  watch(element: HTMLElement, onChange: () => void): EditorDisposable
  dispose(): void
}

type WatchedFace = {
  readonly element: HTMLElement
  size: string | null
  cacheKey: string | null
  glyphKey: string | null
  baseline: WatchedSize | null
  wasUnmeasured: boolean
  fontsLoading: boolean
  readonly onChange: () => void
}

type StaleFaceChange = {
  readonly probe: Element
  readonly face: WatchedFace
  readonly invalidateMetricsKey: string | null
  readonly invalidateGlyphKey: string | null
}

const invalidationSources = new WeakMap<Window, BrowserTextMetricsInvalidationSource>()

function createInvalidationSource(view: Window): BrowserTextMetricsInvalidationSource {
  const listeners = new Set<() => void>()
  const registrations = new EditorDisposableStore()
  const invalidate = () => {
    clearBrowserTextMetricsCache()
    // The live set, not a copy: a listener that tears down another editor must not be followed by
    // a notification to the editor it just disposed.
    for (const listener of listeners) listener()
  }

  registrations.add(observeDevicePixelRatio(view, invalidate))
  const faces = createFaceObserver()
  const source = {
    listeners,
    faces,
    dispose: () => {
      listeners.clear()
      faces?.dispose()
      registrations.dispose()
    },
  }
  invalidationSources.set(view, source)
  return source
}

/**
 * Watches a sample of the measured glyphs in each editor instead of guessing at causes: a host may
 * change the font through any stylesheet or variable, and nothing announces a system face. One
 * observer serves the window, and invalidation is scoped to the affected font key so mounting or
 * restyling one editor leaves every other editor's cached metrics and glyph advances intact.
 */
function createFaceObserver(): FaceObserver | null {
  if (typeof ResizeObserver === 'undefined') return null

  const watched = new Map<Element, WatchedFace>()
  const observer = new ResizeObserver((entries) => {
    const stale: StaleFaceChange[] = []
    for (const entry of entries) {
      const change = staleFace(watched.get(entry.target), entry)
      if (change) stale.push(change)
    }
    if (stale.length === 0) return

    invalidateChangedFaces(stale)
    // Checked again at the call: a listener can dispose another editor before its turn comes.
    for (const { probe, face } of stale) {
      if (watched.get(probe) === face) face.onChange()
    }
  })
  return {
    watch: (element, onChange) => {
      const { host, probe } = appendWatchedProbe(element)
      const document = element.ownerDocument
      const cacheKey = browserTextMetricsCacheKey(element)
      const glyphKey = glyphAdvancesCacheKey(element)
      const wasUnmeasured = unmeasuredElements.has(element)
      const baseline =
        wasUnmeasured || !cacheKey
          ? null
          : (cachedBrowserTextMetrics(document, cacheKey)?.watchedSize ?? null)
      const fontsLoading = document.fonts?.status === 'loading'
      watched.set(probe, {
        element,
        size: null,
        cacheKey,
        glyphKey,
        baseline,
        wasUnmeasured,
        fontsLoading,
        onChange,
      })
      observer.observe(probe)
      return {
        dispose: () => {
          observer.unobserve(probe)
          watched.delete(probe)
          host.remove()
        },
      }
    },
    dispose: () => observer.disconnect(),
  }
}

function invalidateChangedFaces(changes: readonly StaleFaceChange[]): void {
  const invalidatedMetrics = new Set<string>()
  const invalidatedGlyphs = new Set<string>()
  for (const { face, invalidateMetricsKey, invalidateGlyphKey } of changes) {
    const document = face.element.ownerDocument
    if (invalidateMetricsKey && !invalidatedMetrics.has(invalidateMetricsKey)) {
      invalidatedMetrics.add(invalidateMetricsKey)
      metricsCache.get(document)?.delete(invalidateMetricsKey)
    }
    if (invalidateGlyphKey && !invalidatedGlyphs.has(invalidateGlyphKey)) {
      invalidatedGlyphs.add(invalidateGlyphKey)
      invalidateGlyphAdvancesKey(document, invalidateGlyphKey)
    }
  }
}

function watchedSizeMatches(box: ResizeObserverSize, expected: WatchedSize): boolean {
  return (
    Math.abs(box.inlineSize - expected.width) <= WATCHED_SIZE_EPSILON &&
    Math.abs(box.blockSize - expected.height) <= WATCHED_SIZE_EPSILON
  )
}

/**
 * A face whose box moved since it was last seen, or whose first observed box disagrees with what
 * was measured at mount (for example, a web font that finished loading before the first frame, or
 * a hidden editor that was just shown). When the first frame matches the mount measurement, the
 * observer seeds `face.size` without invalidating caches or forcing a re-measure.
 */
function staleFace(
  face: WatchedFace | undefined,
  entry: ResizeObserverEntry,
): StaleFaceChange | null {
  const box = entry.borderBoxSize[0]
  if (!face || !box || box.inlineSize <= 0) return null

  const size = `${box.inlineSize}x${box.blockSize}`
  if (face.size === size) return null

  const firstObservation = face.size === null
  face.size = size
  const document = face.element.ownerDocument
  const currentCacheKey = browserTextMetricsCacheKey(face.element)
  const currentGlyphKey = glyphAdvancesCacheKey(face.element)
  const styleChanged = currentCacheKey !== face.cacheKey || currentGlyphKey !== face.glyphKey
  face.cacheKey = currentCacheKey
  face.glyphKey = currentGlyphKey

  const cachedForCurrent = currentCacheKey
    ? cachedBrowserTextMetrics(document, currentCacheKey)
    : null
  const currentCacheStale =
    cachedForCurrent !== null && !watchedSizeMatches(box, cachedForCurrent.watchedSize)

  if (firstObservation) {
    const wasUnmeasured = face.wasUnmeasured
    const baseline = face.baseline
    const fontsLoading = face.fontsLoading
    face.wasUnmeasured = false
    face.baseline = null
    face.fontsLoading = false
    unmeasuredElements.delete(face.element)

    if (wasUnmeasured || styleChanged) {
      return {
        probe: entry.target,
        face,
        invalidateMetricsKey: currentCacheStale ? currentCacheKey : null,
        invalidateGlyphKey: currentCacheStale ? currentGlyphKey : null,
      }
    }
    if (baseline !== null) {
      if (watchedSizeMatches(box, baseline)) return null
      return {
        probe: entry.target,
        face,
        invalidateMetricsKey: currentCacheKey,
        invalidateGlyphKey: currentGlyphKey,
      }
    }
    if (!fontsLoading) return null
    return {
      probe: entry.target,
      face,
      invalidateMetricsKey: currentCacheKey,
      invalidateGlyphKey: currentGlyphKey,
    }
  }

  // Same CSS style with a different box size means a web or system font changed under this key.
  if (!styleChanged) {
    return {
      probe: entry.target,
      face,
      invalidateMetricsKey: currentCacheKey,
      invalidateGlyphKey: currentGlyphKey,
    }
  }

  return {
    probe: entry.target,
    face,
    invalidateMetricsKey: currentCacheStale ? currentCacheKey : null,
    invalidateGlyphKey: currentCacheStale ? currentGlyphKey : null,
  }
}

// A shadow root inherits the font but keeps the sample out of the editor's own text content.
function appendWatchedProbe(element: HTMLElement): { host: HTMLElement; probe: HTMLElement } {
  const host = appendProbe(element, '')
  host.setAttribute('aria-hidden', 'true')
  const probe = element.ownerDocument.createElement('span')
  probe.textContent = WATCHED_PROBE_TEXT
  // Observers see no inline box.
  probe.style.display = 'inline-block'
  host.attachShadow({ mode: 'open' }).append(probe)
  return { host, probe }
}

function observeDevicePixelRatio(view: Window, invalidate: () => void): EditorDisposable {
  if (typeof view.matchMedia !== 'function') return NO_INVALIDATION

  const armed = new MutableEditorDisposable()
  // A resolution query only ever matches the ratio it was built from, so it reports the move away
  // from that ratio once and then goes quiet — every change has to re-arm against the new one.
  const arm = () => {
    const query = view.matchMedia(`(resolution: ${view.devicePixelRatio}dppx)`)
    const onChange = () => {
      arm()
      invalidate()
    }

    query.addEventListener('change', onChange)
    armed.value = { dispose: () => query.removeEventListener('change', onChange) }
  }

  arm()
  return armed
}
