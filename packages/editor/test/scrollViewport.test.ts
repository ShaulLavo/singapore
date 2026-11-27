import { expect, it, vi } from 'vitest'
import { ScrollViewport } from '../src/virtualization/scrollViewport'

it('retries unmeasurable geometry and caches only a successfully measured native cap', () => {
  const nativeDocument = document.implementation.createHTMLDocument()
  const viewport = new ScrollViewport(nativeDocument.createElement('div'))
  const rectSpy = vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockReturnValue(new DOMRect(0, 0, 256, 0))
  try {
    expect(viewport.maxScrollHeight).toBeUndefined()
    expect(viewport.maxScrollHeight).toBeUndefined()
    expect(rectSpy).toHaveBeenCalledTimes(4)
    expect(nativeDocument.body.children).toHaveLength(0)
    rectSpy.mockReturnValue(new DOMRect(0, 0, 256, 256))
    expect(viewport.maxScrollHeight).toBe(16_000_000)
    expect(rectSpy).toHaveBeenCalledTimes(6)
    rectSpy.mockClear()
    expect(viewport.maxScrollHeight).toBe(16_000_000)
    expect(rectSpy).not.toHaveBeenCalled()
    expect(nativeDocument.body.children).toHaveLength(0)
  } finally {
    rectSpy.mockRestore()
  }
})

it('writes --editor-gutter-scroll-left only when the gutter scroll offset changes', () => {
  const scrollElement = document.createElement('div')
  const viewport = new ScrollViewport(scrollElement)
  const setPropertySpy = vi.spyOn(scrollElement.style, 'setProperty')

  viewport.setScrollPosition(0, 0)
  viewport.setScrollPosition(0, 120)
  viewport.setScrollPosition(48, 240)
  expect(setPropertySpy).not.toHaveBeenCalledWith('--editor-gutter-scroll-left', expect.any(String))

  viewport.gutterScroll = 'content'
  viewport.setScrollPosition(48, 240)
  viewport.setScrollPosition(48, 360)
  expect(setPropertySpy).toHaveBeenCalledTimes(1)
  expect(setPropertySpy).toHaveBeenLastCalledWith('--editor-gutter-scroll-left', '48px')

  viewport.gutterScroll = 'fixed'
  viewport.setScrollPosition(48, 480)
  expect(setPropertySpy).toHaveBeenCalledTimes(2)
  expect(setPropertySpy).toHaveBeenLastCalledWith('--editor-gutter-scroll-left', '0px')

  viewport.dispose()
})
