import { EditorDisposableStore, MutableEditorDisposable } from '../editor/disposables'
import type { EditorDisposable } from '../plugins'

export type BrowserTextMetrics = {
  readonly rowHeight: number
  readonly characterWidth: number
}

/** Glyphs a whitespace marker can be drawn with: U+00B7 middle dot, U+2E31 word separator dot. */
export type WhitespaceDotGlyph = '·' | '⸱'

// The measured record carries more than callers may hand in as an override, so it stays internal.
type MeasuredTextMetrics = BrowserTextMetrics & {
  readonly whitespaceDotGlyph: WhitespaceDotGlyph
  readonly monospace: boolean
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
// Monaco's set: narrow, wide and punctuation glyphs, digits, in every style a theme may paint a
// token with. A font whose bold or italic advance differs still breaks column arithmetic there.
const MONOSPACE_PROBE_GLYPHS = ['i', 'l', '|', '/', '-', '_', '%', 'W', '0', '1']
const MONOSPACE_PROBE_TEXTS = MONOSPACE_PROBE_GLYPHS.map((glyph) => glyph.repeat(PROBE_LENGTH))
// One of every measured glyph: its box moves when any advance or the line box does.
const WATCHED_PROBE_TEXT = `m ${MONOSPACE_PROBE_GLYPHS.join('')}`
const MONOSPACE_PROBE_STYLES = ['regular', 'bold', 'italic'] as const
// Layout reports 1/64 px; over the 16-glyph probe that bounds one advance to about 0.001 px.
const MONOSPACE_EPSILON = 0.002
const NO_INVALIDATION: EditorDisposable = { dispose: () => {} }
let metricsCache = new WeakMap<Document, Map<string, MeasuredTextMetrics>>()

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
 * Whether every probed glyph, space included, advances by the measured character width. When it
 * does not, column arithmetic lands clicks and carets on the wrong character.
 */
export function measureMonospaceAdvances(element: HTMLElement): boolean {
  return measureTextMetrics(element).monospace
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
  const face = observeRenderedFace(element, () => {
    clearBrowserTextMetricsCache()
    onInvalidated()
  })
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

/**
 * Watches a sample of the measured glyphs in each probed style instead of guessing at causes: the
 * host may change the font through any stylesheet or variable, and nothing announces a system face.
 * A hidden element reports no size, which says nothing about the font, so it is skipped; showing it
 * again re-measures through the view's reveal path.
 */
function observeRenderedFace(element: HTMLElement, onChange: () => void): EditorDisposable {
  if (typeof ResizeObserver === 'undefined') return NO_INVALIDATION

  // A shadow root inherits the font but keeps the sample out of the editor's own text content.
  const host = appendProbe(element, '')
  host.setAttribute('aria-hidden', 'true')
  const shadow = host.attachShadow({ mode: 'open' })
  const probes = MONOSPACE_PROBE_STYLES.map((probeStyle) => {
    const probe = element.ownerDocument.createElement('span')
    probe.textContent = WATCHED_PROBE_TEXT
    // Observers see no inline box, and a plain block would stretch to its widest sibling.
    probe.style.cssText = 'display: block; width: max-content'
    shadow.append(styledProbe(probe, probeStyle))
    return probe
  })
  const sizes = new Map<Element, string>()
  const observer = new ResizeObserver((entries) => {
    let changed = false
    for (const entry of entries) {
      const box = entry.borderBoxSize[0]
      if (!box || box.inlineSize <= 0) continue

      const size = `${box.inlineSize}x${box.blockSize}`
      const previous = sizes.get(entry.target)
      sizes.set(entry.target, size)
      if (previous !== undefined && previous !== size) changed = true
    }
    if (changed) onChange()
  })
  for (const probe of probes) observer.observe(probe)
  return {
    dispose: () => {
      observer.disconnect()
      host.remove()
    },
  }
}

export function clearBrowserTextMetricsCache(): void {
  metricsCache = new WeakMap<Document, Map<string, MeasuredTextMetrics>>()
}

function measureTextMetrics(element: HTMLElement): MeasuredTextMetrics {
  const cacheKey = browserTextMetricsCacheKey(element)
  const cached = cacheKey ? cachedBrowserTextMetrics(element.ownerDocument, cacheKey) : null
  if (cached) return cached

  const document = element.ownerDocument
  const probe = appendProbe(element, PROBE_TEXT)
  const spaceProbe = appendProbe(element, SPACE_PROBE_TEXT)
  const dotProbes = WHITESPACE_DOT_GLYPHS.map((glyph) =>
    appendProbe(element, glyph.repeat(PROBE_LENGTH)),
  )
  const monospaceProbes = MONOSPACE_PROBE_STYLES.flatMap((probeStyle) =>
    MONOSPACE_PROBE_TEXTS.map((text) => styledProbe(appendProbe(element, text), probeStyle)),
  )

  // Every probe is attached before the first read, so the whole set costs one layout.
  const rect = probe.getBoundingClientRect()
  const style = readComputedStyle(probe)
  const spaceWidth = measuredAdvance(spaceProbe)
  const dotWidths = dotProbes.map(measuredAdvance)
  const monospaceWidths = [spaceWidth, ...monospaceProbes.map(measuredAdvance)]
  for (const attached of [probe, spaceProbe, ...dotProbes, ...monospaceProbes]) attached.remove()

  const metrics = {
    rowHeight: measuredRowHeight(rect, style),
    characterWidth: measuredCharacterWidth(rect),
    whitespaceDotGlyph: nearestWhitespaceDotGlyph(spaceWidth, dotWidths),
    monospace: advancesAgree(rect.width / PROBE_LENGTH, monospaceWidths),
  }
  // A hidden probe reports zero geometry; its fallback must not become a shared font measurement.
  if (cacheKey && rect.width > 0 && rect.height > 0) {
    cacheBrowserTextMetrics(document, cacheKey, metrics)
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

function styledProbe(
  probe: HTMLSpanElement,
  style: (typeof MONOSPACE_PROBE_STYLES)[number],
): HTMLSpanElement {
  if (style === 'bold') probe.style.fontWeight = 'bold'
  if (style === 'italic') probe.style.fontStyle = 'italic'
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
  dispose(): void
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
  const source = {
    listeners,
    dispose: () => {
      listeners.clear()
      registrations.dispose()
    },
  }
  invalidationSources.set(view, source)
  return source
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
