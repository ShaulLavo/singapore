import { expect, test } from 'vitest'
import '../src/style.css'
import { Editor } from '../src/editor/Editor'
import type { EditorViewContributionContext, EditorViewSnapshot } from '../src/plugins'
import { clearBrowserTextMetricsCache } from '../src/virtualization/browserMetrics'
import { glyphAdvancesFor } from '../src/virtualization/glyphAdvances'

const monoFontUrl = new URL('./fixtures/fonts/jetbrains-mono.woff2', import.meta.url).href
const serifFontUrl = new URL('./fixtures/fonts/source-serif-4.woff2', import.meta.url).href

const frames = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  )

function mountEditor(
  update?: (context: EditorViewContributionContext, snapshot: EditorViewSnapshot) => void,
) {
  const host = document.createElement('div')
  host.style.cssText = 'display:flex;width:640px;height:240px;--editor-font-size:13px'
  document.body.append(host)
  const seen: { snapshot: EditorViewSnapshot | null } = { snapshot: null }
  const editor = new Editor(host, {
    plugins: [
      {
        name: 'font-layout-probe',
        activate: (context) =>
          context.registerViewContribution({
            createContribution: (contributionContext) => ({
              update: (snapshot) => {
                seen.snapshot = snapshot
                update?.(contributionContext, snapshot)
              },
              dispose: () => {},
            }),
          }),
      },
    ],
  })
  editor.setText('abcdefghij\nklmnopqrst')
  const scroll = host.querySelector<HTMLElement>('.editor-virtualized')!
  return {
    host,
    editor,
    scroll,
    metrics: () => seen.snapshot!.metrics,
    dispose: () => {
      editor.dispose()
      host.remove()
    },
  }
}

function changeFaceAfterFrame(host: HTMLElement, size: number): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      host.style.setProperty('--editor-font-size', `${size}px`)
      const channel = new MessageChannel()
      channel.port1.onmessage = () => {
        channel.port1.close()
        channel.port2.close()
        resolve()
      }
      channel.port2.postMessage(null)
    })
  })
}

test('a host CSS face change updates metrics and hit tests before that frame paints', async () => {
  const { host, editor, scroll, metrics, dispose } = mountEditor()
  try {
    await frames()
    const before = metrics().characterWidth
    expect(before).toBeGreaterThan(0)
    await changeFaceAfterFrame(host, 26)

    expect(getComputedStyle(scroll).fontSize).toBe('26px')
    expect(metrics().characterWidth).toBeCloseTo(before * 2, 1)
    const row = scroll.querySelector<HTMLElement>('[data-editor-virtual-row="0"]')!
    const text = Array.from(row.childNodes).find((node) => node.nodeType === Node.TEXT_NODE)!
    const glyph = document.createRange()
    glyph.setStart(text, 5)
    glyph.setEnd(text, 6)
    const rect = glyph.getBoundingClientRect()
    expect(editor.textOffsetFromPoint(rect.left + 1, rect.top + rect.height / 2)).toBe(5)
  } finally {
    dispose()
  }
})

test('font invalidation can resize an observed ancestor without dropping its resize notification', async () => {
  const errors: string[] = []
  const onError = (event: ErrorEvent) => errors.push(event.message)
  window.addEventListener('error', onError)
  const { host, scroll, metrics, dispose } = mountEditor((context, snapshot) => {
    context.reserveOverlayWidth('right', Math.ceil(snapshot.metrics.characterWidth * 10))
  })
  let contentWidth = 0
  const viewport = new ResizeObserver(([entry]) => {
    contentWidth = entry!.contentRect.width
  })
  viewport.observe(scroll)
  try {
    await frames()
    await expect.poll(() => contentWidth).toBeLessThan(640)
    const initialWidth = contentWidth
    const initialCharacterWidth = metrics().characterWidth
    expect(errors).toEqual([])

    host.style.setProperty('--editor-font-size', '26px')
    await frames()
    await expect.poll(() => contentWidth).toBeLessThan(initialWidth)
    expect(metrics().characterWidth).toBeCloseTo(initialCharacterWidth * 2, 1)
    expect(contentWidth).toBeCloseTo(640 - Number.parseFloat(scroll.style.paddingRight), 3)
    expect(errors).toEqual([])
  } finally {
    viewport.disconnect()
    window.removeEventListener('error', onError)
    dispose()
  }
})

test('disposing an editor cancels its pending overlay reservation', async () => {
  const { host, scroll, metrics, dispose } = mountEditor((context, snapshot) => {
    context.reserveOverlayWidth('right', Math.ceil(snapshot.metrics.characterWidth * 10))
  })
  const request = window.requestAnimationFrame
  const cancel = window.cancelAnimationFrame
  const pending = new Set<number>()
  const cancelled = new Set<number>()
  try {
    await frames()
    const before = metrics().characterWidth
    const paddingBefore = scroll.style.paddingRight
    window.requestAnimationFrame = (callback) => {
      const handle = request.call(window, (time) => {
        pending.delete(handle)
        callback(time)
      })
      pending.add(handle)
      return handle
    }
    window.cancelAnimationFrame = (handle) => {
      pending.delete(handle)
      cancelled.add(handle)
      cancel.call(window, handle)
    }
    await changeFaceAfterFrame(host, 26)
    expect(metrics().characterWidth).toBeCloseTo(before * 2, 1)
    expect(scroll.style.paddingRight).toBe(paddingBefore)
    const reservations = Array.from(pending)
    expect(reservations.length).toBeGreaterThan(0)

    dispose()

    expect(pending.size).toBe(0)
    for (const handle of reservations) expect(cancelled.has(handle)).toBe(true)
    const disposedPadding = scroll.style.paddingRight
    await frames()
    expect(scroll.style.paddingRight).toBe(disposedPadding)
  } finally {
    dispose()
    window.requestAnimationFrame = request
    window.cancelAnimationFrame = cancel
  }
})

test('mounting a second editor does not wipe cached glyph advances or re-run forced probe layouts', async () => {
  clearBrowserTextMetricsCache()
  const first = mountEditor()
  let second: ReturnType<typeof mountEditor> | null = null
  const originalAppendChild = Node.prototype.appendChild
  let measurementProbesAfterMount = 0
  try {
    await frames()
    const cachedGlyphs = glyphAdvancesFor(first.scroll)
    expect(cachedGlyphs).not.toBeNull()

    // Count measurement probes (non-empty textContent, unlike the empty watched-probe shadow host).
    Node.prototype.appendChild = function appendChild<T extends Node>(this: Node, node: T): T {
      if (
        node instanceof HTMLElement &&
        node.classList.contains('editor-virtualized-metric-probe') &&
        (node.textContent?.length ?? 0) > 0
      ) {
        measurementProbesAfterMount += 1
      }
      return originalAppendChild.call(this, node) as T
    }

    second = mountEditor()
    await frames()

    expect(measurementProbesAfterMount).toBe(0)
    expect(glyphAdvancesFor(first.scroll)).toBe(cachedGlyphs)
  } finally {
    Node.prototype.appendChild = originalAppendChild
    second?.dispose()
    first.dispose()
    clearBrowserTextMetricsCache()
  }
})

test('late web font load invalidates only the affected font key and preserves other editors caches', async () => {
  clearBrowserTextMetricsCache()
  const family = 'Scoped Invalidation Mono'
  const fallbackFamily = 'Scoped Invalidation Serif'
  const fallback = new FontFace(fallbackFamily, `url(${serifFontUrl})`)
  document.fonts.add(await fallback.load())
  let loaded: FontFace | undefined

  const first = mountEditor()
  const secondHost = document.createElement('div')
  secondHost.style.cssText = 'display:flex;width:640px;height:240px'
  document.body.append(secondHost)
  const second = new Editor(secondHost, {
    fontFamily: `"${family}", "${fallbackFamily}"`,
    fontSize: 14,
  })
  second.setText('WWWWWWWWWW')
  const secondScroll = secondHost.querySelector<HTMLElement>('.editor-virtualized')!
  try {
    await frames()
    const firstGlyphsBefore = glyphAdvancesFor(first.scroll)
    const secondGlyphsBefore = glyphAdvancesFor(secondScroll)
    expect(firstGlyphsBefore).not.toBeNull()
    expect(secondGlyphsBefore).not.toBeNull()
    const beforeAdvanceW = secondGlyphsBefore!.advance(87)

    loaded = new FontFace(family, `url(${monoFontUrl})`)
    document.fonts.add(await loaded.load())

    await expect.poll(() => glyphAdvancesFor(secondScroll)).not.toBe(secondGlyphsBefore)
    expect(glyphAdvancesFor(secondScroll)!.advance(87)).toBeLessThan(beforeAdvanceW - 1)
    // Editor 1 uses a different font key, so its cached GlyphAdvances must stay intact.
    expect(glyphAdvancesFor(first.scroll)).toBe(firstGlyphsBefore)
  } finally {
    second.dispose()
    secondHost.remove()
    first.dispose()
    if (loaded) document.fonts.delete(loaded)
    document.fonts.delete(fallback)
    clearBrowserTextMetricsCache()
  }
})

test('mounting an editor with a theme measures probes once and not again on the first frame', async () => {
  clearBrowserTextMetricsCache()
  const host = document.createElement('div')
  host.style.cssText = 'display:flex;width:640px;height:240px;--editor-font-size:15px'
  document.body.append(host)
  const originalAppendChild = Node.prototype.appendChild
  let measurementProbes = 0
  Node.prototype.appendChild = function appendChild<T extends Node>(this: Node, node: T): T {
    if (
      node instanceof HTMLElement &&
      node.classList.contains('editor-virtualized-metric-probe') &&
      (node.textContent?.length ?? 0) > 0
    ) {
      measurementProbes += 1
    }
    return originalAppendChild.call(this, node) as T
  }
  let themed: Editor | null = null
  try {
    themed = new Editor(host, {
      defaultText: 'const answer = 42',
      lineHeight: 20,
      theme: { type: 'dark' },
    })
    const afterMountProbes = measurementProbes
    // One measurement batch (15 spans: m, space, watched, 2 dots, 10 monospace glyphs).
    expect(afterMountProbes).toBe(15)
    await frames()
    expect(measurementProbes).toBe(afterMountProbes)
  } finally {
    Node.prototype.appendChild = originalAppendChild
    themed?.dispose()
    host.remove()
    clearBrowserTextMetricsCache()
  }
})

test('styled row rewraps when a pre-loaded FontFace is added before its first ResizeObserver tick', async () => {
  clearBrowserTextMetricsCache()
  const family = 'Styled Preloaded Mono'
  const fallbackFamily = 'Styled Preloaded Serif'
  const fallback = new FontFace(fallbackFamily, `url(${serifFontUrl})`)
  document.fonts.add(await fallback.load())
  // Pre-load the replacement face before adding it to document.fonts, so document.fonts.status
  // stays 'loaded' when the face is registered in the same task as the row decoration.
  const preloaded = new FontFace(family, `url(${monoFontUrl})`)
  await preloaded.load()

  const sheet = document.createElement('style')
  sheet.textContent = `.editor-virtualized-row.styled-preloaded-row { font-family: "${family}", "${fallbackFamily}"; font-size: 20px; }`
  document.head.append(sheet)

  const host = document.createElement('div')
  host.style.cssText = 'display:flex;width:230px;height:260px'
  document.body.append(host)
  const editor = new Editor(host, {
    fontFamily: 'monospace',
    fontSize: 13,
    lineHeight: 24,
    wordWrap: true,
  })
  const baseScroll = host.querySelector<HTMLElement>('.editor-virtualized')!
  try {
    editor.setText('W'.repeat(80))
    await frames()
    const baseGlyphsBefore = glyphAdvancesFor(baseScroll)
    // Decorate row 0 (creating styledRowFace + caching fallback glyph advances) and register the
    // already-loaded FontFace in the exact same task before the first ResizeObserver tick fires.
    editor.setRowDecorations(new Map([[0, { className: 'styled-preloaded-row' }]]))
    const segmentsBefore = host.querySelectorAll('[data-editor-virtual-row]').length
    expect(segmentsBefore).toBeGreaterThan(5)
    document.fonts.add(preloaded)

    await expect
      .poll(() => host.querySelectorAll('[data-editor-virtual-row]').length)
      .toBeLessThan(segmentsBefore)
    // Base editor's font cache must remain intact despite the styled row invalidation.
    expect(glyphAdvancesFor(baseScroll)).toBe(baseGlyphsBefore)
  } finally {
    editor.dispose()
    host.remove()
    sheet.remove()
    document.fonts.delete(preloaded)
    document.fonts.delete(fallback)
    clearBrowserTextMetricsCache()
  }
})

test('styled row rewraps with updated glyph widths after switching fonts while its replacement loads', async () => {
  clearBrowserTextMetricsCache()
  const family = 'Styled Switch Mono'
  const fallbackFamily = 'Styled Switch Serif'
  const fallback = new FontFace(fallbackFamily, `url(${serifFontUrl})`)
  document.fonts.add(await fallback.load())
  const preloaded = new FontFace(family, `url(${monoFontUrl})`)
  await preloaded.load()

  const sheet = document.createElement('style')
  const ruleA = `.editor-virtualized-row.styled-switch-row { font-family: "${family}", "${fallbackFamily}"; font-size: 20px; }`
  const ruleB = `.editor-virtualized-row.styled-switch-row { font-family: monospace; font-size: 16px; }`
  sheet.textContent = ruleA
  document.head.append(sheet)

  const host = document.createElement('div')
  host.style.cssText = 'display:flex;width:230px;height:260px'
  document.body.append(host)
  const editor = new Editor(host, {
    fontFamily: 'monospace',
    fontSize: 13,
    lineHeight: 24,
    wordWrap: true,
  })
  const baseScroll = host.querySelector<HTMLElement>('.editor-virtualized')!
  try {
    editor.setText('W'.repeat(80))
    editor.setRowDecorations(new Map([[0, { className: 'styled-switch-row' }]]))
    await frames()
    const baseGlyphsBefore = glyphAdvancesFor(baseScroll)
    const styledRowBefore = host.querySelector<HTMLElement>(
      '[data-editor-virtual-row].styled-switch-row',
    )!
    const fallbackAdvanceW = glyphAdvancesFor(styledRowBefore)!.advance(87)
    const fallbackSegments = host.querySelectorAll('[data-editor-virtual-row]').length
    expect(fallbackSegments).toBeGreaterThan(5)

    // Switch the styled row away from font A to font B, settle ResizeObserver, then add the
    // preloaded replacement for A while A is unobserved, and switch back to A.
    sheet.textContent = ruleB
    await frames()
    document.fonts.add(preloaded)
    sheet.textContent = ruleA
    await frames()

    const styledRowAfter = host.querySelector<HTMLElement>(
      '[data-editor-virtual-row].styled-switch-row',
    )!
    await expect
      .poll(() => glyphAdvancesFor(styledRowAfter)!.advance(87))
      .toBeLessThan(fallbackAdvanceW - 1)
    await expect
      .poll(() => host.querySelectorAll('[data-editor-virtual-row]').length)
      .toBeLessThan(fallbackSegments)
    expect(glyphAdvancesFor(baseScroll)).toBe(baseGlyphsBefore)
  } finally {
    editor.dispose()
    host.remove()
    sheet.remove()
    document.fonts.delete(preloaded)
    document.fonts.delete(fallback)
    clearBrowserTextMetricsCache()
  }
})
