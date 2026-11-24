import { afterEach, expect, it } from 'vitest'
import { Editor } from '../src/editor/Editor'
import { createDocumentSession } from '../src/public/document'
import '../src/style.css'

type Restore = () => void

const restores: Restore[] = []

afterEach(() => {
  for (const restore of restores.splice(0)) restore()
})

// Counts the reads that force style or layout while an editor that does not hold focus opens.
function countLayoutReads(): { readonly count: () => number; readonly stop: Restore } {
  let reads = 0
  const elementRect = Element.prototype.getBoundingClientRect
  const rangeRect = Range.prototype.getBoundingClientRect
  const rangeRects = Range.prototype.getClientRects
  const computedStyle = window.getComputedStyle
  Element.prototype.getBoundingClientRect = function (this: Element) {
    reads += 1
    return elementRect.call(this)
  }
  Range.prototype.getBoundingClientRect = function (this: Range) {
    reads += 1
    return rangeRect.call(this)
  }
  Range.prototype.getClientRects = function (this: Range) {
    reads += 1
    return rangeRects.call(this)
  }
  window.getComputedStyle = (element, pseudo) => {
    reads += 1
    return computedStyle.call(window, element, pseudo)
  }
  const stop = () => {
    Element.prototype.getBoundingClientRect = elementRect
    Range.prototype.getBoundingClientRect = rangeRect
    Range.prototype.getClientRects = rangeRects
    window.getComputedStyle = computedStyle
  }
  restores.push(stop)
  return { count: () => reads, stop }
}

function mountEditor() {
  const host = document.createElement('div')
  host.style.cssText = 'display:flex;width:400px;height:180px'
  document.body.append(host)
  const editor = new Editor(host)
  restores.push(() => {
    editor.dispose()
    host.remove()
  })
  return { editor, host }
}

const visibleCarets = (host: HTMLElement) =>
  host.querySelectorAll('.editor-virtualized-caret:not([hidden])')

const caretTransform = (host: HTMLElement) =>
  host.querySelector<HTMLElement>('.editor-virtualized-caret')?.style.transform ?? ''

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve))

it('opens a document in an unfocused editor without reading layout, and draws the caret on focus', async () => {
  const { editor, host } = mountEditor()
  editor.setText('warm up')
  await nextFrame()
  const warmCaret = caretTransform(host)
  const session = createDocumentSession('const alpha = 1\nconst beta = 2\n')
  session.setSelection(6)

  const reads = countLayoutReads()
  editor.attachSession(session)
  const openReads = reads.count()
  reads.stop()

  expect(openReads).toBe(0)
  expect(caretTransform(host)).toBe(warmCaret)

  editor.focus()

  expect(visibleCarets(host)).toHaveLength(1)
  expect(caretTransform(host)).not.toBe(warmCaret)
})

it('renders a scroll that leaves an unfocused caret off screen in one frame', async () => {
  const { editor, host } = mountEditor()
  editor.setText(Array.from({ length: 2000 }, (_value, index) => `line ${index}`).join('\n'))
  editor.setSelection(0)
  await nextFrame()
  await nextFrame()
  const scroller = host.querySelector<HTMLElement>('.editor-virtualized')!
  const requestFrame = window.requestAnimationFrame
  const cancelFrame = window.cancelAnimationFrame
  const frame = () => new Promise((resolve) => requestFrame.call(window, resolve))
  // Frames the editor has asked for and that have not run yet.
  const pending = new Set<number>()
  window.requestAnimationFrame = (callback) => {
    const id = requestFrame.call(window, (time) => {
      pending.delete(id)
      callback(time)
    })
    pending.add(id)
    return id
  }
  window.cancelAnimationFrame = (id) => {
    pending.delete(id)
    cancelFrame.call(window, id)
  }
  restores.push(() => {
    window.requestAnimationFrame = requestFrame
    window.cancelAnimationFrame = cancelFrame
  })
  // Read right after the render that recycles the rows has written them.
  let pendingAfterRender: number | null = null
  const observer = new MutationObserver(() => {
    pendingAfterRender ??= pending.size
  })
  observer.observe(scroller, { subtree: true, childList: true, characterData: true })
  restores.push(() => observer.disconnect())

  scroller.scrollTop = 20_000
  await frame()
  await frame()
  await frame()

  const rows = Array.from(
    host.querySelectorAll('.editor-virtualized-row'),
    (row) => row.textContent,
  )
  expect(rows).not.toContain('line 0')
  expect(rows.length).toBeGreaterThan(0)
  expect(visibleCarets(host)).toHaveLength(0)
  expect(pendingAfterRender).toBe(0)
})

it('draws an unfocused editor caret in the next frame', async () => {
  const { editor, host } = mountEditor()
  const session = createDocumentSession('alpha\nbeta\n')
  session.setSelection(2)
  editor.attachSession(session)

  await expect.poll(() => visibleCarets(host).length).toBe(1)
})
