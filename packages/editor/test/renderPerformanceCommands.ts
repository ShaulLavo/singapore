import type {} from '@vitest/browser-playwright'
import type { BrowserCommand, BrowserCommandContext } from 'vitest/node'

export type RenderTraceAction =
  | { readonly kind: 'type'; readonly text: string }
  | { readonly kind: 'scroll'; readonly selector: string; readonly top: number }
  | { readonly kind: 'idle'; readonly frames: number }

export type RenderTraceMetrics = {
  readonly layoutCount: number
  readonly maxDirtyLayoutObjects: number
  readonly maxTotalLayoutObjects: number
  readonly styleRecalcCount: number
  readonly maxStyleRecalcElements: number
  readonly paintCount: number
}

type TimelineTraceEvent = {
  readonly name?: unknown
  readonly ph?: unknown
  readonly args?: {
    readonly elementCount?: unknown
    readonly beginData?: {
      readonly dirtyObjects?: unknown
      readonly totalObjects?: unknown
    }
  }
}

type MutableRenderTraceMetrics = {
  layoutCount: number
  maxDirtyLayoutObjects: number
  maxTotalLayoutObjects: number
  styleRecalcCount: number
  maxStyleRecalcElements: number
  paintCount: number
}

function recordLayoutEvent(metrics: MutableRenderTraceMetrics, event: TimelineTraceEvent): void {
  metrics.layoutCount += 1
  const dirty = event.args?.beginData?.dirtyObjects
  const total = event.args?.beginData?.totalObjects
  if (typeof dirty === 'number' && dirty > metrics.maxDirtyLayoutObjects)
    metrics.maxDirtyLayoutObjects = dirty
  if (typeof total === 'number' && total > metrics.maxTotalLayoutObjects)
    metrics.maxTotalLayoutObjects = total
}

function recordTimelineEvent(metrics: MutableRenderTraceMetrics, event: TimelineTraceEvent): void {
  if (event.ph !== 'X') return
  if (event.name === 'Layout') {
    recordLayoutEvent(metrics, event)
    return
  }
  if (event.name === 'UpdateLayoutTree') {
    metrics.styleRecalcCount += 1
    const count = event.args?.elementCount
    if (typeof count === 'number' && count > metrics.maxStyleRecalcElements)
      metrics.maxStyleRecalcElements = count
    return
  }
  if (event.name === 'Paint') metrics.paintCount += 1
}

function summarizeTimelineEvents(events: readonly TimelineTraceEvent[]): RenderTraceMetrics {
  const metrics: MutableRenderTraceMetrics = {
    layoutCount: 0,
    maxDirtyLayoutObjects: 0,
    maxTotalLayoutObjects: 0,
    styleRecalcCount: 0,
    maxStyleRecalcElements: 0,
    paintCount: 0,
  }
  for (const event of events) recordTimelineEvent(metrics, event)
  return metrics
}

async function waitPageFrames(page: BrowserCommandContext['page'], count: number): Promise<void> {
  await page.evaluate(async (frames: number) => {
    for (let index = 0; index < frames; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    }
  }, count)
}

async function runRenderTraceAction(
  iframe: BrowserCommandContext['iframe'],
  page: BrowserCommandContext['page'],
  action: RenderTraceAction,
): Promise<void> {
  if (action.kind === 'type') {
    await page.keyboard.type(action.text)
    await waitPageFrames(page, 2)
    return
  }
  if (action.kind === 'scroll') {
    await iframe.locator(action.selector).evaluate((element: Element, top: number) => {
      element.scrollTop = top
    }, action.top)
    await waitPageFrames(page, 2)
    return
  }
  await waitPageFrames(page, action.frames)
}

function isTimelineTraceEvent(value: unknown): value is TimelineTraceEvent {
  return value !== null && typeof value === 'object'
}

export const proofCompositorLayerCount: BrowserCommand<[], number> = async ({ page }) => {
  const cdp = await page.context().newCDPSession(page)
  const nextLayerCount = () =>
    new Promise<number>((resolve) => {
      const handle = (event: { readonly layers?: readonly unknown[] }) => {
        if (!Array.isArray(event.layers)) return
        cdp.off('LayerTree.layerTreeDidChange', handle)
        resolve(event.layers.length)
      }
      cdp.on('LayerTree.layerTreeDidChange', handle)
    })
  try {
    await cdp.send('LayerTree.enable')
    // Toggle an offscreen layer so Chromium commits a fresh LayerTree snapshot even when idle,
    // then read the snapshot emitted immediately after removing the probe.
    const added = nextLayerCount()
    await page.evaluate(() => {
      const probe = document.createElement('div')
      probe.id = '__singapore-layer-probe'
      probe.style.cssText =
        'position:fixed;left:-10px;top:-10px;width:1px;height:1px;will-change:transform;pointer-events:none'
      document.body.append(probe)
    })
    await added
    const cleaned = nextLayerCount()
    await page.evaluate(() => {
      document.getElementById('__singapore-layer-probe')?.remove()
    })
    return await cleaned
  } finally {
    await cdp.detach()
  }
}

export const proofRenderTrace: BrowserCommand<
  [action: RenderTraceAction],
  RenderTraceMetrics
> = async ({ iframe, page }, action) => {
  const cdp = await page.context().newCDPSession(page)
  const events: TimelineTraceEvent[] = []
  cdp.on('Tracing.dataCollected', (event) => {
    if (!Array.isArray(event.value)) return
    for (const entry of event.value) {
      if (isTimelineTraceEvent(entry)) events.push(entry)
    }
  })
  const completed = new Promise<void>((resolve) => {
    cdp.once('Tracing.tracingComplete', () => resolve())
  })
  try {
    await cdp.send('Tracing.start', { categories: 'devtools.timeline' })
    await runRenderTraceAction(iframe, page, action)
    await cdp.send('Tracing.end')
    await completed
    return summarizeTimelineEvents(events)
  } finally {
    await cdp.detach()
  }
}
