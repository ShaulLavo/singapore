import { Editor } from '@singapore-editor/core/editor'
import { afterEach, expect, test } from 'vitest'
import { createStickyScrollPlugin } from '../src/stickyScroll'
import '@singapore-editor/core/style.css'

const rowHeight = 20
const cleanup: (() => void)[] = []

afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose()
})

test.each(['container', 'page', 'capped'] as const)(
  'pins the stack to the visible top of a %s editor',
  async (layout) => {
    const parent = document.createElement('div')
    parent.style.cssText = 'height:240px;width:400px;overflow:auto;border:2px solid'
    const host = parent.appendChild(document.createElement('div'))
    if (layout === 'container') host.style.height = '240px'
    document.body.append(parent)
    const editor = new Editor(host, {
      height: layout === 'container' ? 'container' : 'content',
      maxHeight: layout === 'capped' ? 240 : undefined,
      lineHeight: rowHeight,
      plugins: [createStickyScrollPlugin()],
    })
    cleanup.push(() => {
      editor.dispose()
      parent.remove()
    })
    editor.setText('function outer() {\n  if (ready) {\n' + '    work()\n'.repeat(90) + '  }\n}')
    const scrollport = host.querySelector<HTMLElement>('.editor-virtualized')!
    const scrollOwner = layout === 'page' ? parent : scrollport
    const top = () => scrollOwner.getBoundingClientRect().top + scrollOwner.clientTop
    await expect.poll(() => scrollOwner.scrollHeight).toBeGreaterThan(1000)
    scrollOwner.scrollTop = 600

    await expect.poll(() => stickyBounds(host)?.top).toBeCloseTo(top(), 0)
    expect(stickyBounds(host)?.height).toBe(2 * rowHeight)
    scrollOwner.scrollTop = 680
    await expect.poll(() => stickyBounds(host)?.top).toBeCloseTo(top(), 0)
  },
)

function stickyBounds(host: HTMLElement): DOMRect | undefined {
  return host
    .querySelector<HTMLElement>('.editor-sticky-scroll:not([hidden]) .editor-sticky-scroll-lines')
    ?.getBoundingClientRect()
}
