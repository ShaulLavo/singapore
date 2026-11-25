import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '../src/editor'
import {
  clearBrowserTextMetricsCache,
  measureBrowserTextMetrics,
  measureWhitespaceDotGlyph,
} from '../src/virtualization/browserMetrics'
import type { EditorPlugin, EditorViewSnapshot } from '../src/public/extensions'
import { setHighlightRegistry } from '../src/public/testing'

const highlightsMap = new Map<string, Highlight>()
const mockRegistry = {
  set: (name: string, highlight: Highlight) => {
    highlightsMap.set(name, highlight)
  },
  delete: (name: string) => highlightsMap.delete(name),
}

class MockHighlight extends Set<Range> {}

const PROBE_CLASS = 'editor-virtualized-metric-probe'
const ROW_HEIGHT = 24

let advanceOf: (character: string) => number
let probeHeight = ROW_HEIGHT
let onProbeRect: (() => void) | null = null
let originalGetBoundingClientRect: () => DOMRect
let container: HTMLElement
let editor: Editor | null = null
let snapshots: EditorViewSnapshot[] = []

function probeRect(width: number): DOMRect {
  return {
    x: 0,
    y: 0,
    width,
    height: probeHeight,
    top: 0,
    right: width,
    bottom: probeHeight,
    left: 0,
    toJSON: () => ({}),
  } as DOMRect
}

function stubProbeMeasurement(): void {
  originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect
  HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect(this: HTMLElement) {
    if (!this.classList.contains(PROBE_CLASS)) return originalGetBoundingClientRect.call(this)

    onProbeRect?.()
    const text = this.textContent ?? ''
    let width = 0
    for (const character of text) width += advanceOf(character)
    return probeRect(width)
  }
}

/**
 * A box read is answered out of the layout the browser is currently holding, and every node put
 * into or taken out of the tree throws that layout away — so reads that follow one another with
 * nothing touching the tree in between are all served by a single one.
 */
function countLayoutsDuring(measure: () => void): number {
  const originalAppendChild = Node.prototype.appendChild
  const originalRemove = Element.prototype.remove
  let layouts = 0
  let stale = true

  Node.prototype.appendChild = function appendChild<T extends Node>(this: Node, node: T): T {
    stale = true
    return originalAppendChild.call(this, node) as T
  }
  Element.prototype.remove = function remove(this: Element): void {
    stale = true
    originalRemove.call(this)
  }
  onProbeRect = () => {
    if (stale) layouts += 1
    stale = false
  }

  try {
    measure()
  } finally {
    Node.prototype.appendChild = originalAppendChild
    Element.prototype.remove = originalRemove
    onProbeRect = null
  }

  return layouts
}

function createSnapshotPlugin(): EditorPlugin {
  return {
    activate: (context) =>
      context.registerViewContribution({
        createContribution: () => ({
          update: (snapshot) => {
            snapshots.push(snapshot)
          },
          dispose: () => {},
        }),
      }),
  }
}

function createUpdateHookPlugin(onUpdate: () => void): EditorPlugin {
  return {
    activate: (context) =>
      context.registerViewContribution({
        createContribution: () => ({
          update: () => onUpdate(),
          dispose: () => {},
        }),
      }),
  }
}

function mountEditor(): Editor {
  editor = new Editor(container, {
    defaultText: 'mmmmmmmmmm',
    plugins: [createSnapshotPlugin()],
  })
  return editor
}

function editorRootIn(host: HTMLElement): HTMLElement {
  return host.querySelector('.editor-virtualized') as HTMLElement
}

function measuredRowHeight(root: HTMLElement): string {
  return root.style.getPropertyValue('--editor-row-height')
}

describe('browser text metrics', () => {
  beforeEach(() => {
    highlightsMap.clear()
    // @ts-expect-error — polyfilling Highlight constructor for tests
    globalThis.Highlight = MockHighlight
    setHighlightRegistry(mockRegistry)
    snapshots = []
    advanceOf = () => 8
    probeHeight = ROW_HEIGHT
    stubProbeMeasurement()
    clearBrowserTextMetricsCache()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    editor?.dispose()
    editor = null
    container.remove()
    HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect
    clearBrowserTextMetricsCache()
    setHighlightRegistry(undefined)
  })

  it('stops at the editor an earlier listener tore down', () => {
    const queries: MediaQueryList[] = []
    const originalMatchMedia = window.matchMedia.bind(window)
    const matchMedia = vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => {
      const list = originalMatchMedia(query)
      queries.push(list)
      return list
    })
    let disposeSecond: (() => void) | null = null
    editor = new Editor(container, {
      defaultText: 'mmmmmmmmmm',
      plugins: [createUpdateHookPlugin(() => disposeSecond?.())],
    })
    const secondHost = document.createElement('div')
    document.body.appendChild(secondHost)
    const second = new Editor(secondHost, { defaultText: 'mmmmmmmmmm' })
    const secondRoot = editorRootIn(secondHost)
    disposeSecond = () => second.dispose()

    probeHeight = 30
    queries[0]?.dispatchEvent(new Event('change'))
    matchMedia.mockRestore()
    secondHost.remove()

    expect(measuredRowHeight(editorRootIn(container))).toBe('30px')
    expect(measuredRowHeight(secondRoot)).toBe(`${ROW_HEIGHT}px`)
  })

  it('re-measures when the display pixel ratio changes', () => {
    const first = measureBrowserTextMetrics(container)

    advanceOf = () => 12
    const cached = measureBrowserTextMetrics(container)
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 })
    const rescaled = measureBrowserTextMetrics(container)
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 })

    expect(first.characterWidth).toBe(8)
    expect(cached.characterWidth).toBe(8)
    expect(rescaled.characterWidth).toBe(12)
  })

  it('re-arms the resolution query against the ratio it moved to', () => {
    const queries: MediaQueryList[] = []
    const originalMatchMedia = window.matchMedia.bind(window)
    const matchMedia = vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => {
      const list = originalMatchMedia(query)
      queries.push(list)
      return list
    })
    mountEditor()

    advanceOf = () => 12
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 3 })
    queries[0]?.dispatchEvent(new Event('change'))
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 })
    matchMedia.mockRestore()

    expect(queries.map((query) => query.media)).toEqual([
      '(resolution: 1dppx)',
      '(resolution: 3dppx)',
    ])
    expect(snapshots.at(-1)?.metrics.characterWidth).toBe(12)
  })

  it('reads every probe out of one layout', () => {
    const layouts = countLayoutsDuring(() => measureBrowserTextMetrics(container))

    expect(layouts).toBe(1)
  })

  it('picks the whitespace dot whose advance matches the space', () => {
    advanceOf = (character) => (character === '·' ? 5 : 8)
    expect(measureWhitespaceDotGlyph(container)).toBe('⸱')

    clearBrowserTextMetricsCache()
    advanceOf = (character) => (character === '⸱' ? 5 : 8)

    expect(measureWhitespaceDotGlyph(container)).toBe('·')
  })

  it('measures at most once on mount with an explicit theme and reuses cache on a second mount', () => {
    const firstLayouts = countLayoutsDuring(() => {
      editor = new Editor(container, {
        defaultText: 'const x = 1',
        theme: { type: 'dark' },
      })
    })
    expect(firstLayouts).toBe(1)

    const secondHost = document.createElement('div')
    document.body.appendChild(secondHost)
    const mounted: Editor[] = []
    try {
      const secondLayouts = countLayoutsDuring(() => {
        mounted.push(
          new Editor(secondHost, {
            defaultText: 'const y = 2',
            theme: { type: 'dark' },
          }),
        )
      })
      expect(secondLayouts).toBe(0)
    } finally {
      for (const instance of mounted) instance.dispose()
      secondHost.remove()
    }
  })

  it('keeps the cache warm on the first ResizeObserver tick and scopes invalidation per font key', () => {
    const observers: Array<{
      readonly callback: ResizeObserverCallback
      readonly targets: Set<Element>
    }> = []
    const originalResizeObserver = globalThis.ResizeObserver
    globalThis.ResizeObserver = class MockResizeObserver implements ResizeObserver {
      private readonly entry: {
        readonly callback: ResizeObserverCallback
        readonly targets: Set<Element>
      }
      constructor(callback: ResizeObserverCallback) {
        this.entry = { callback, targets: new Set() }
        observers.push(this.entry)
      }
      observe(target: Element): void {
        this.entry.targets.add(target)
      }
      unobserve(target: Element): void {
        this.entry.targets.delete(target)
      }
      disconnect(): void {
        this.entry.targets.clear()
      }
    } as typeof ResizeObserver

    const secondHost = document.createElement('div')
    container.style.fontSize = '13px'
    secondHost.style.fontSize = '18px'
    document.body.appendChild(secondHost)
    let second: Editor | null = null
    try {
      editor = new Editor(container, { defaultText: 'first', fontSize: 13 })
      second = new Editor(secondHost, { defaultText: 'second', fontSize: 18 })
      const faceObserver = observers.find((candidate) =>
        Array.from(candidate.targets).some((target) => target.getRootNode() instanceof ShadowRoot),
      )!
      expect(faceObserver).toBeDefined()
      expect(faceObserver.targets.size).toBe(2)
      const [probe1, probe2] = Array.from(faceObserver.targets)
      const root1 = editorRootIn(container)
      const root2 = editorRootIn(secondHost)

      // Initial watched probe width = 12 chars * 8px = 96px, height = ROW_HEIGHT (24px).
      const makeEntry = (target: Element, inlineSize: number, blockSize: number) =>
        ({
          target,
          borderBoxSize: [{ inlineSize, blockSize }],
          contentBoxSize: [{ inlineSize, blockSize }],
          devicePixelContentBoxSize: [{ inlineSize, blockSize }],
          contentRect: probeRect(inlineSize),
        }) as unknown as ResizeObserverEntry

      // Mutate stubbed advances after mount: if the first ResizeObserver tick wiped the cache,
      // re-reading metrics would observe 12 instead of the cached 8.
      advanceOf = () => 12
      probeHeight = 30
      faceObserver.callback(
        [makeEntry(probe1!, 96, ROW_HEIGHT), makeEntry(probe2!, 96, ROW_HEIGHT)],
        {} as ResizeObserver,
      )
      expect(measureBrowserTextMetrics(root1).characterWidth).toBe(8)
      expect(measureBrowserTextMetrics(root2).characterWidth).toBe(8)
      expect(measuredRowHeight(root1)).toBe(`${ROW_HEIGHT}px`)
      expect(measuredRowHeight(root2)).toBe(`${ROW_HEIGHT}px`)

      // Now simulate a late font load affecting only editor 2 (18px): its probe resizes.
      faceObserver.callback([makeEntry(probe2!, 144, 30)], {} as ResizeObserver)
      expect(measureBrowserTextMetrics(root2).characterWidth).toBe(12)
      expect(measuredRowHeight(root2)).toBe('30px')
      // Editor 1's 13px font key must stay cached and untouched.
      expect(measureBrowserTextMetrics(root1).characterWidth).toBe(8)
      expect(measuredRowHeight(root1)).toBe(`${ROW_HEIGHT}px`)
    } finally {
      second?.dispose()
      secondHost.remove()
      globalThis.ResizeObserver = originalResizeObserver
    }
  })

  it('re-measures when an editor mounted while hidden becomes visible', () => {
    const observers: Array<{
      readonly callback: ResizeObserverCallback
      readonly targets: Set<Element>
    }> = []
    const originalResizeObserver = globalThis.ResizeObserver
    globalThis.ResizeObserver = class MockResizeObserver implements ResizeObserver {
      private readonly entry: {
        readonly callback: ResizeObserverCallback
        readonly targets: Set<Element>
      }
      constructor(callback: ResizeObserverCallback) {
        this.entry = { callback, targets: new Set() }
        observers.push(this.entry)
      }
      observe(target: Element): void {
        this.entry.targets.add(target)
      }
      unobserve(target: Element): void {
        this.entry.targets.delete(target)
      }
      disconnect(): void {
        this.entry.targets.clear()
      }
    } as typeof ResizeObserver

    try {
      // Simulate a display:none container returning 0x0 geometry during mount.
      advanceOf = () => 0
      probeHeight = 0
      editor = new Editor(container, { defaultText: 'hidden' })
      const root = editorRootIn(container)
      expect(measuredRowHeight(root)).toBe(`${ROW_HEIGHT}px`)

      const faceObserver = observers.find((candidate) =>
        Array.from(candidate.targets).some((target) => target.getRootNode() instanceof ShadowRoot),
      )!
      expect(faceObserver).toBeDefined()
      const [probe] = Array.from(faceObserver.targets)
      // Container becomes visible with a 30px line height and 10px character width.
      advanceOf = () => 10
      probeHeight = 30
      faceObserver.callback(
        [
          {
            target: probe!,
            borderBoxSize: [{ inlineSize: 120, blockSize: 30 }],
            contentBoxSize: [{ inlineSize: 120, blockSize: 30 }],
            devicePixelContentBoxSize: [{ inlineSize: 120, blockSize: 30 }],
            contentRect: probeRect(120),
          } as unknown as ResizeObserverEntry,
        ],
        {} as ResizeObserver,
      )
      expect(measuredRowHeight(root)).toBe('30px')
      expect(measureBrowserTextMetrics(root).characterWidth).toBe(10)
    } finally {
      globalThis.ResizeObserver = originalResizeObserver
    }
  })
})
