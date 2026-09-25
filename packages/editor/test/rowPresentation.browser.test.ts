import { expect, it } from 'vitest'
import '../src/style.css'
import { Editor } from '../src/editor'
import type { EditorViewContributionContext } from '../src/plugins'

it('invalidates a row presentation before replacing its text and when disposed', () => {
  const host = document.createElement('div')
  host.style.cssText = 'display:flex;width:400px;height:180px'
  document.body.append(host)
  let context: EditorViewContributionContext | null = null
  const editor = new Editor(host, {
    plugins: [
      {
        name: 'presentation-test',
        activate: (api) =>
          api.registerViewContribution({
            createContribution: (view) => {
              context = view
              return { update() {}, dispose() {} }
            },
          }),
      },
    ],
  })
  const view = (): EditorViewContributionContext => {
    if (!context) throw new Error('No view')
    return context
  }
  editor.setText('first')
  const handle = view().getRowPresentation(0)!
  let textAtInvalidation = ''
  let reentrant: unknown = 'not-called'
  handle.signal.addEventListener('abort', () => {
    textAtInvalidation = handle.element.textContent ?? ''
    reentrant = view().getRowPresentation(0)
  })
  editor.setText(Array.from({ length: 1000 }, (_, index) => `second ${index}`).join('\n'))
  expect(handle.signal.aborted).toBe(true)
  expect(reentrant).toBeNull()
  expect(textAtInvalidation).toContain('first')
  const scrolling = view().getRowPresentation(0)!
  let beforeRecycle = ''
  scrolling.signal.addEventListener('abort', () => {
    beforeRecycle = scrolling.element.textContent ?? ''
  })
  editor.setScrollPosition({ top: 12000 })
  expect(scrolling.signal.aborted).toBe(true)
  expect(beforeRecycle).toContain('second 0')
  const visible = view().getSnapshot().visibleRows[0]!
  const next = view().getRowPresentation(visible.index)!
  editor.dispose()
  expect(next.signal.aborted).toBe(true)
  host.remove()
})
