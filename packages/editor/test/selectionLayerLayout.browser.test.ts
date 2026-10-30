import { afterEach, expect, it } from 'vitest'
import { Editor } from '../src/editor/Editor'
import '../src/style.css'

// Painting a selection must not interleave layout reads with selection-layer writes. Each write
// dirties layout, so a read after it forces a fresh synchronous layout: one per mounted row, which
// in content mode is every row of the document. Selecting all of a 6,000-line paste took minutes.

type Access = 'read' | 'write'

const mounted: { editor: Editor; host: HTMLElement }[] = []
const restores: (() => void)[] = []

afterEach(() => {
  for (const restore of restores.splice(0)) restore()
  for (const { editor, host } of mounted.splice(0)) {
    editor.dispose()
    host.remove()
  }
})

function mount(scrollMode: 'content' | 'virtualized'): Editor {
  const host = document.createElement('div')
  host.style.cssText =
    scrollMode === 'content'
      ? 'position:relative;width:600px'
      : 'position:relative;width:600px;height:400px;display:flex;overflow:hidden'
  document.body.append(host)
  const editor = new Editor(host, {
    scrollMode,
    wordWrap: true,
    fontFamily: 'monospace',
    fontSize: 14,
    lineHeight: 20,
  })
  mounted.push({ editor, host })
  editor.setText(
    Array.from(
      { length: 120 },
      (_, line) => `const value${line} = compute(${line}, 'some text to fill the row')`,
    ).join('\n'),
  )
  return editor
}

function patch<T extends object, K extends keyof T>(
  target: T,
  key: K,
  wrap: (value: T[K]) => T[K],
) {
  const descriptor = Object.getOwnPropertyDescriptor(target, key)!
  const next = { ...descriptor }
  if (descriptor.get) next.get = wrap(descriptor.get as T[K]) as () => unknown
  else next.value = wrap(descriptor.value)
  Object.defineProperty(target, key, next)
  restores.push(() => Object.defineProperty(target, key, descriptor))
}

function recordLayoutAccess(): Access[] {
  const log: Access[] = []
  const read = <F extends (...args: never[]) => unknown>(original: F) =>
    function (this: unknown, ...args: Parameters<F>) {
      log.push('read')
      return original.apply(this, args)
    } as unknown as F
  patch(HTMLElement.prototype, 'offsetWidth', read as never)
  patch(Element.prototype, 'getBoundingClientRect', read)
  patch(Element.prototype, 'getClientRects', read)
  patch(Range.prototype, 'getBoundingClientRect', read)
  patch(Range.prototype, 'getClientRects', read)
  patch(
    Element.prototype,
    'replaceChildren',
    (original) =>
      function (this: Element, ...nodes: (Node | string)[]) {
        if (this.classList.contains('editor-virtualized-selection-layer')) log.push('write')
        return original.apply(this, nodes)
      },
  )
  return log
}

const frames = async () => {
  for (let index = 0; index < 3; index++)
    await new Promise((resolve) => requestAnimationFrame(resolve))
}

it.each(['content', 'virtualized'] as const)(
  'paints a %s-mode selection without reading layout between selection-layer writes',
  async (scrollMode) => {
    const editor = mount(scrollMode)
    await frames()

    const log = recordLayoutAccess()
    editor.dispatchCommand('selectAll')

    const first = log.indexOf('write')
    const last = log.lastIndexOf('write')
    expect(log.filter((access) => access === 'write').length).toBeGreaterThan(10)
    expect(log.slice(first, last + 1)).not.toContain('read')
  },
)

// A live Range stays registered with its document until it is collected, and every DOM mutation
// updates every registered range. One range per row painted made each later node removal cost
// about 0.4 ms on a 6,000-row selection, until garbage collection ran.
it.each(['content', 'virtualized'] as const)(
  'paints a %s-mode selection without creating a Range per row',
  async (scrollMode) => {
    const editor = mount(scrollMode)
    await frames()
    let created = 0
    patch(
      Document.prototype,
      'createRange',
      (original) =>
        function (this: Document) {
          created += 1
          return original.call(this)
        },
    )

    editor.dispatchCommand('selectAll')

    const painted = document.querySelectorAll('.editor-virtualized-selection-range').length
    expect(painted).toBeGreaterThan(10)
    expect(created).toBeLessThan(painted / 4)
  },
)
