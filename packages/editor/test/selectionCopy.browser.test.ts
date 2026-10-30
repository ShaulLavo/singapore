import { afterEach, expect, it } from 'vitest'
import { Editor } from '../src/editor/Editor'
import { decodePaintSnapshot, installPaintSnapshotCopy, mountPaintSnapshot } from '../src/paint'
import { createLineGutterPlugin } from '../../gutters/src/lineGutter'
import '../src/style.css'
import '../../gutters/src/lineGutter.css'

// A page selection that runs through an editor or a document snapshot: the browser alone would join
// their absolutely positioned rows into one line and the editor alone would drop the page text.

const cleanups: (() => void)[] = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  document.getSelection()?.removeAllRanges()
})

const TEXT = 'first line\nsecond line'

function page() {
  const section = document.createElement('section')
  section.style.cssText = 'font: 16px serif; width: 600px'
  const heading = document.createElement('h2')
  heading.textContent = 'Title'
  const host = document.createElement('div')
  host.style.cssText = 'position: relative; width: 480px'
  const after = document.createElement('p')
  after.textContent = 'After'
  section.append(heading, host, after)
  document.body.append(section)
  cleanups.push(() => section.remove())
  return { heading, host, after }
}

function mountEditor(host: HTMLElement, text = TEXT) {
  const editor = new Editor(host, {
    scrollMode: 'content',
    wordWrap: true,
    fontFamily: 'monospace',
    fontSize: 14,
    lineHeight: 22,
    plugins: [createLineGutterPlugin()],
  })
  cleanups.push(() => editor.dispose())
  editor.setText(text)
  return editor
}

async function frames() {
  await document.fonts.ready
  for (let index = 0; index < 3; index++) await new Promise(requestAnimationFrame)
}

/** The first text node under `root` holding `text`, with the offset of `text` in it. */
function textPoint(root: Element, text: string): [Text, number] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const index = (node as Text).data.indexOf(text)
    if (index >= 0) return [node as Text, index]
  }
  throw new Error(`No text node holds ${JSON.stringify(text)}`)
}

/** Fires copy where the browser would and returns what a handler wrote, or null for native copy. */
function copy(target: Element): string | null {
  const event = new ClipboardEvent('copy', {
    clipboardData: new DataTransfer(),
    bubbles: true,
    cancelable: true,
  })
  // Firefox empties a script-made clipboard once dispatch ends, so read it while the event runs.
  let written: string | null = null
  const read = (copied: Event) => {
    if (copied.defaultPrevented)
      written = (copied as ClipboardEvent).clipboardData!.getData('text/plain')
  }
  window.addEventListener('copy', read)
  try {
    target.dispatchEvent(event)
  } finally {
    window.removeEventListener('copy', read)
  }
  return written
}

it('copies a heading and the start of an editor row together', async () => {
  const { heading, host } = page()
  mountEditor(host)
  await frames()

  const [node, offset] = textPoint(host, 'first line')
  document.getSelection()!.setBaseAndExtent(heading.firstChild!, 0, node, offset + 'first'.length)

  expect(copy(heading)).toMatch(/^Title\n+first$/)
})

it('copies every editor line when a page selection runs through the editor', async () => {
  const { heading, host, after } = page()
  mountEditor(host)
  await frames()

  document.getSelection()!.setBaseAndExtent(heading.firstChild!, 0, after.firstChild!, 5)

  expect(copy(heading)).toMatch(/^Title\n+first line\nsecond line\n+After$/)
})

it('copies a selection that starts in the editor and ends in the page', async () => {
  const { host, after } = page()
  mountEditor(host)
  await frames()

  const [node, offset] = textPoint(host, 'second line')
  document.getSelection()!.setBaseAndExtent(node, offset, after.firstChild!, 5)

  // The browser targets the editor row, so the editor's own handler must step aside.
  expect(copy(node.parentElement!)).toMatch(/^second line\n+After$/)
})

it('leaves a selection inside one editor to that editor', async () => {
  const { host } = page()
  const editor = mountEditor(host)
  await frames()

  editor.setSelection(6, 17)
  editor.focus()

  expect(copy(document.activeElement!)).toBe('line\nsecond')
})

it('extends a page selection into the editor on shift-click', async () => {
  const { heading, host } = page()
  mountEditor(host)
  await frames()

  document.getSelection()!.collapse(heading.firstChild!, 0)
  const [node, offset] = textPoint(host, 'second line')
  const range = document.createRange()
  range.setStart(node, offset + 'second'.length)
  const point = range.getBoundingClientRect()
  // Inside the left half of the space after "second", which hit-tests to the boundary before it.
  const x = point.left + 2
  const target = document.elementFromPoint(x, point.top + point.height / 2)!
  const press = new MouseEvent('mousedown', {
    bubbles: true,
    cancelable: true,
    button: 0,
    detail: 1,
    shiftKey: true,
    clientX: x,
    clientY: point.top + point.height / 2,
  })
  target.dispatchEvent(press)

  const selection = document.getSelection()!
  expect(press.defaultPrevented).toBe(true)
  expect(heading.contains(selection.anchorNode)).toBe(true)
  expect(host.contains(selection.focusNode)).toBe(true)
  expect(copy(heading)).toMatch(/^Title\n+first line\nsecond$/)
})

it('copies snapshot rows with a line break only where a source line ends', async () => {
  const { heading, host, after } = page()
  const long = 'a wrapped line that is long enough to need several rows at this width'
  const editor = mountEditor(host, `${long}\nlast`)
  await frames()
  const saved = editor.captureSnapshot({ scope: 'document' })
  expect(saved.status, JSON.stringify(saved)).toBe('ready')
  if (saved.status !== 'ready') return
  editor.dispose()

  const snapshot = mountPaintSnapshot(host, decodePaintSnapshot(saved.paint)!, { width: 240 })!
  cleanups.push(() => snapshot.dispose())
  cleanups.push(installPaintSnapshotCopy(document))
  expect(snapshot.rowCount).toBeGreaterThan(2)

  document.getSelection()!.setBaseAndExtent(heading.firstChild!, 0, after.firstChild!, 5)

  expect(copy(heading)).toMatch(new RegExp(`^Title\\n+${long}\\nlast\\n+After$`))
})
