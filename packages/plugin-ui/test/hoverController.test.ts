import { createStringTextSnapshot } from '@singapore-editor/core/document'
import type {
  EditorViewContributionContext,
  EditorViewSnapshot,
} from '@singapore-editor/core/extensions'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestViewContributionContext } from '@singapore-editor/core/testing'

import { createHoverController } from '../src/hoverController'
import type { EditorHoverParticipant, HoverPart } from '../src/hoverParticipant'
import {
  HOVER_ASYNC_DISPATCH_DELAY_MS,
  HOVER_LOADING_DELAY_MS,
  HOVER_REQUEST_DEBOUNCE_MS,
  TOOLTIP_HIDE_DELAY_MS,
} from '../src/tooltip'

const TEXT = 'const value = 1'

describe('one hover per view', () => {
  afterEach(() => {
    vi.useRealTimers()
    document.body.replaceChildren()
  })

  it('paints every participant in one surface, lowest ordinal first', async () => {
    vi.useFakeTimers()
    const server: EditorHoverParticipant = {
      computeAsync: async (request, emit) => {
        emit([{ ordinal: 1, range: request.anchor.range, markdown: 'from the server' }])
      },
    }
    const characters: EditorHoverParticipant = {
      computeSync: (request) => [
        {
          ordinal: 5,
          range: request.anchor.range,
          markdown: 'about the character',
          actions: [{ label: 'Adjust settings', run: () => undefined }],
        },
      ],
    }
    const harness = mount([characters, server])

    harness.pointerMove()
    await vi.advanceTimersByTimeAsync(HOVER_REQUEST_DEBOUNCE_MS)

    expect(document.querySelectorAll('.editor-test-hover').length).toBe(1)
    expect(partTexts()).toEqual(['from the server', 'about the character'])
    expect(document.querySelector('.editor-test-hover-action')?.textContent).toBe('Adjust settings')
    harness.dispose()
  })

  it('runs every participant on the same clock', async () => {
    vi.useFakeTimers()
    const asyncStarted = vi.fn()
    const syncAsked = vi.fn()
    const server: EditorHoverParticipant = {
      computeAsync: async (request, emit) => {
        asyncStarted()
        emit([{ ordinal: 1, range: request.anchor.range, markdown: 'server' }])
      },
    }
    const marker: EditorHoverParticipant = {
      computeSync: (request) => {
        syncAsked()
        return [{ ordinal: 2, range: request.anchor.range, markdown: 'marker' }]
      },
    }
    const harness = mount([server, marker])

    harness.pointerMove()
    await vi.advanceTimersByTimeAsync(HOVER_ASYNC_DISPATCH_DELAY_MS - 1)
    expect(asyncStarted).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(asyncStarted).toHaveBeenCalledOnce()
    expect(syncAsked).not.toHaveBeenCalled()
    expect(tooltip().hidden).toBe(true)

    await vi.advanceTimersByTimeAsync(HOVER_REQUEST_DEBOUNCE_MS - HOVER_ASYNC_DISPATCH_DELAY_MS)
    expect(syncAsked).toHaveBeenCalledOnce()
    expect(tooltip().hidden).toBe(false)
    expect(partTexts()).toEqual(['server', 'marker'])
    harness.dispose()
  })

  it('shows a loading row only while an async participant is still working', async () => {
    vi.useFakeTimers()
    let finish!: () => void
    const slow: EditorHoverParticipant = {
      computeAsync: (request, emit) =>
        new Promise<void>((resolve) => {
          finish = () => {
            emit([{ ordinal: 1, range: request.anchor.range, markdown: 'late' }])
            resolve()
          }
        }),
    }
    const harness = mount([slow])

    harness.pointerMove()
    await vi.advanceTimersByTimeAsync(HOVER_LOADING_DELAY_MS - 1)
    expect(tooltip().hidden).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(tooltip().textContent).toContain('Loading…')

    finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(tooltip().textContent).not.toContain('Loading…')
    expect(partTexts()).toEqual(['late'])
    harness.dispose()
  })

  it('aborts the participants the moment the pointer moves to another word', async () => {
    vi.useFakeTimers()
    const aborted: boolean[] = []
    const server: EditorHoverParticipant = {
      computeAsync: (request) =>
        new Promise<void>((resolve) => {
          request.signal.addEventListener('abort', () => {
            aborted.push(true)
            resolve()
          })
        }),
    }
    const harness = mount([server])

    harness.pointerMove(6)
    await vi.advanceTimersByTimeAsync(HOVER_ASYNC_DISPATCH_DELAY_MS)
    harness.pointerMove(14)
    expect(aborted).toEqual([true])
    harness.dispose()
  })

  it('shows nothing when no participant has anything to say', async () => {
    vi.useFakeTimers()
    const harness = mount([{ computeSync: () => [] }])

    harness.pointerMove()
    await vi.advanceTimersByTimeAsync(HOVER_REQUEST_DEBOUNCE_MS)
    expect(tooltip().hidden).toBe(true)
    harness.dispose()
  })

  it('summons the hover from the keyboard at once and focuses it', () => {
    const harness = mount([
      { computeSync: (request) => [part(request.anchor.range, 'keyboard answer')] },
    ])

    expect(harness.controller.showAtOffset(6, { focus: true })).toBe(true)
    expect(partTexts()).toEqual(['keyboard answer'])
    expect((document.activeElement as HTMLElement | null)?.dataset.hoverPartIndex).toBe('0')
    harness.dispose()
  })

  it('opens a new hover when moving horizontally to another token under a wide tooltip', async () => {
    vi.useFakeTimers()
    const harness = mountGeometry({
      text: 'const alpha = beta + gamma',
      tooltipRect: new DOMRect(12, 132, 400, 60),
      tokens: [
        { name: 'alpha', rect: new DOMRect(60, 200, 40, 18) },
        { name: 'beta', rect: new DOMRect(130, 200, 40, 18) },
      ],
    })

    harness.moveTo(80, 209)
    await vi.advanceTimersByTimeAsync(HOVER_REQUEST_DEBOUNCE_MS)
    expect(partTexts()).toEqual(['hover:alpha'])

    harness.moveTo(150, 209)
    expect(tooltip().hidden).toBe(true)
    await vi.advanceTimersByTimeAsync(HOVER_REQUEST_DEBOUNCE_MS)
    expect(tooltip().hidden).toBe(false)
    expect(partTexts()).toEqual(['hover:beta'])
    harness.dispose()
  })

  it('switches to another token inside a wider diagnostic anchor when moving horizontally', async () => {
    vi.useFakeTimers()
    const text = 'const alpha = beta + gamma'
    const alphaStart = text.indexOf('alpha')
    const betaEnd = text.indexOf('beta') + 'beta'.length
    const harness = mountGeometry({
      text,
      tooltipRect: new DOMRect(12, 132, 400, 60),
      tokens: [
        { name: 'alpha', rect: new DOMRect(60, 200, 40, 18) },
        { name: 'beta', rect: new DOMRect(130, 200, 40, 18) },
      ],
      wideDiagnostic: {
        range: { start: alphaStart, end: betaEnd },
        rect: new DOMRect(60, 200, 110, 18),
      },
    })

    harness.moveTo(80, 209)
    await vi.advanceTimersByTimeAsync(HOVER_REQUEST_DEBOUNCE_MS)
    expect(partTexts()).toEqual(['hover:alpha'])

    harness.moveTo(150, 209)
    await vi.advanceTimersByTimeAsync(HOVER_REQUEST_DEBOUNCE_MS)
    expect(partTexts()).toEqual(['hover:beta'])
    harness.dispose()
  })

  it('opens a new hover when pausing on a token inside the corridor between anchor and tooltip', async () => {
    vi.useFakeTimers()
    const harness = mountGeometry({
      text: 'const upper = 1\nconst alpha = beta',
      tooltipRect: new DOMRect(12, 132, 400, 60),
      tokens: [
        { name: 'upper', rect: new DOMRect(60, 182, 40, 18) },
        { name: 'alpha', rect: new DOMRect(60, 200, 40, 18) },
      ],
    })

    harness.moveTo(80, 209)
    await vi.advanceTimersByTimeAsync(HOVER_REQUEST_DEBOUNCE_MS)
    expect(partTexts()).toEqual(['hover:alpha'])

    // Move straight up into the 8px gap (bottom of line above) and stop on `upper`.
    harness.moveTo(80, 196)
    expect(tooltip().hidden).toBe(false)
    expect(partTexts()).toEqual(['hover:alpha'])

    await vi.advanceTimersByTimeAsync(HOVER_REQUEST_DEBOUNCE_MS - 1)
    expect(partTexts()).toEqual(['hover:alpha'])

    await vi.advanceTimersByTimeAsync(1)
    expect(tooltip().hidden).toBe(false)
    expect(partTexts()).toEqual(['hover:upper'])
    harness.dispose()
  })

  it('keeps the original tooltip open when crossing the gap into the tooltip', async () => {
    vi.useFakeTimers()
    const harness = mountGeometry({
      text: 'const upper = 1\nconst alpha = beta',
      tooltipRect: new DOMRect(12, 132, 400, 60),
      tokens: [
        { name: 'upper', rect: new DOMRect(60, 182, 40, 18) },
        { name: 'alpha', rect: new DOMRect(60, 200, 40, 18) },
      ],
    })

    harness.moveTo(80, 209)
    await vi.advanceTimersByTimeAsync(HOVER_REQUEST_DEBOUNCE_MS)
    expect(partTexts()).toEqual(['hover:alpha'])

    harness.moveTo(80, 196)
    expect(tooltip().hidden).toBe(false)

    harness.enterTooltip()
    await vi.advanceTimersByTimeAsync(HOVER_REQUEST_DEBOUNCE_MS + TOOLTIP_HIDE_DELAY_MS)
    expect(tooltip().hidden).toBe(false)
    expect(partTexts()).toEqual(['hover:alpha'])
    harness.dispose()
  })

  it('keeps the original tooltip open during slow continuous movement toward it lasting longer than the settle delay', async () => {
    vi.useFakeTimers()
    const harness = mountGeometry({
      text: 'const upper = 1\nconst alpha = beta',
      tooltipRect: new DOMRect(12, 132, 400, 60),
      tokens: [
        { name: 'upper', rect: new DOMRect(60, 182, 40, 18) },
        { name: 'alpha', rect: new DOMRect(60, 200, 40, 18) },
      ],
    })

    harness.moveTo(80, 209)
    await vi.advanceTimersByTimeAsync(HOVER_REQUEST_DEBOUNCE_MS)
    expect(partTexts()).toEqual(['hover:alpha'])

    // Move 1 px every 50 ms across the 8 px gap (400 ms total > 300 ms settle delay).
    for (let y = 199; y >= 192; y -= 1) {
      harness.moveTo(80, y)
      await vi.advanceTimersByTimeAsync(50)
    }
    expect(tooltip().hidden).toBe(false)
    expect(partTexts()).toEqual(['hover:alpha'])

    harness.enterTooltip()
    await vi.advanceTimersByTimeAsync(HOVER_REQUEST_DEBOUNCE_MS + TOOLTIP_HIDE_DELAY_MS)
    expect(tooltip().hidden).toBe(false)
    expect(partTexts()).toEqual(['hover:alpha'])
    harness.dispose()
  })

  it('does not postpone corridor settle when wiggling sideways at constant distance over a token', async () => {
    vi.useFakeTimers()
    const harness = mountGeometry({
      text: 'const upper = 1\nconst alpha = beta',
      tooltipRect: new DOMRect(12, 132, 400, 60),
      tokens: [
        { name: 'upper', rect: new DOMRect(60, 182, 40, 18) },
        { name: 'alpha', rect: new DOMRect(60, 200, 40, 18) },
      ],
    })

    harness.moveTo(80, 209)
    await vi.advanceTimersByTimeAsync(HOVER_REQUEST_DEBOUNCE_MS)
    expect(partTexts()).toEqual(['hover:alpha'])

    harness.moveTo(80, 196)
    await vi.advanceTimersByTimeAsync(150)
    harness.moveTo(82, 196)
    await vi.advanceTimersByTimeAsync(150)
    expect(tooltip().hidden).toBe(false)
    expect(partTexts()).toEqual(['hover:upper'])
    harness.dispose()
  })

  it('hides the tooltip if the pointer stops over trailing blank space even when caret hit-test clamps', async () => {
    vi.useFakeTimers()
    const harness = mountGeometry({
      text: 'let upper\nconst alpha = beta',
      tooltipRect: new DOMRect(12, 132, 400, 60),
      tokens: [
        { name: 'upper', rect: new DOMRect(40, 182, 40, 18) },
        { name: 'alpha', rect: new DOMRect(60, 200, 40, 18) },
      ],
      trailingRows: [{ top: 182, bottom: 200, textRight: 80, clampedOffset: 9 }],
    })

    harness.moveTo(80, 209)
    await vi.advanceTimersByTimeAsync(HOVER_REQUEST_DEBOUNCE_MS)
    expect(partTexts()).toEqual(['hover:alpha'])

    // Stop 6 px past the end of `let upper` in the corridor: caret hit-test clamps to `upper`,
    // while rowAtPoint reports trailing blank space.
    harness.moveTo(86, 196)
    expect(tooltip().hidden).toBe(false)

    await vi.advanceTimersByTimeAsync(HOVER_REQUEST_DEBOUNCE_MS)
    expect(tooltip().hidden).toBe(true)
    harness.dispose()
  })

  it('keeps the tooltip visible and calls the provider once when moving within a non-ASCII identifier', async () => {
    vi.useFakeTimers()
    const text = 'const 变量名 = 1'
    const start = text.indexOf('变量名')
    const end = start + '变量名'.length
    const element = document.createElement('div')
    element.getBoundingClientRect = () => new DOMRect(0, 0, 900, 700)
    document.body.append(element)
    const snapshot = {
      documentId: 'index.ts',
      languageId: 'typescript',
      textSnapshot: createStringTextSnapshot(text),
      textVersion: 1,
      tokens: [],
      selections: [{ anchorOffset: 0, headOffset: 0, startOffset: 0, endOffset: 0 }],
    } as unknown as EditorViewSnapshot
    const computeSync = vi.fn(
      (request: {
        readonly anchor: { readonly range: { readonly start: number; readonly end: number } }
      }) => [
        part(
          { start, end },
          `hover:${text.slice(request.anchor.range.start, request.anchor.range.end)}`,
        ),
      ],
    )
    const context = createTestViewContributionContext({
      container: element,
      scrollElement: element,
      contentElement: element,
      hasDocument: () => true,
      getSnapshot: () => snapshot,
      getProviders: (() => [{ computeSync }]) as EditorViewContributionContext['getProviders'],
      focusEditor: vi.fn(),
      rowAtPoint: (clientX) => {
        const charOffset = clientX < 76 ? start : start + 2
        return {
          bufferRow: 0,
          displayRow: 0,
          source: 'document',
          region: 'text',
          offset: charOffset,
        }
      },
      markerAtPoint: () => null,
      textOffsetFromPoint: (clientX) => (clientX < 76 ? start : start + 2),
      getRangeClientRect: (rangeStart, rangeEnd) => {
        if (rangeStart === start && rangeEnd === end) return new DOMRect(60, 200, 48, 18)
        return new DOMRect(60 + (rangeStart - start) * 16, 200, (rangeEnd - rangeStart) * 16, 18)
      },
    })
    const controller = createHoverController({ context, classNamespace: 'test' })
    tooltip().getBoundingClientRect = () => new DOMRect(12, 132, 400, 60)

    element.dispatchEvent(
      new PointerEvent('pointermove', { buttons: 0, clientX: 68, clientY: 209 }),
    )
    await vi.advanceTimersByTimeAsync(HOVER_REQUEST_DEBOUNCE_MS)
    expect(tooltip().hidden).toBe(false)
    expect(partTexts()).toEqual(['hover:变量名'])
    expect(computeSync).toHaveBeenCalledTimes(1)

    element.dispatchEvent(
      new PointerEvent('pointermove', { buttons: 0, clientX: 100, clientY: 209 }),
    )
    await vi.advanceTimersByTimeAsync(HOVER_REQUEST_DEBOUNCE_MS)
    expect(tooltip().hidden).toBe(false)
    expect(partTexts()).toEqual(['hover:变量名'])
    expect(computeSync).toHaveBeenCalledTimes(1)
    controller.dispose()
  })

  it('opens hover for a painted end-of-line marker even when rowAtPoint classifies the point as trailing', async () => {
    vi.useFakeTimers()
    const text = 'const end\u200b'
    const zwspOffset = text.indexOf('\u200b')
    const element = document.createElement('div')
    element.getBoundingClientRect = () => new DOMRect(0, 0, 900, 700)
    document.body.append(element)
    const snapshot = {
      documentId: 'index.ts',
      languageId: 'typescript',
      textSnapshot: createStringTextSnapshot(text),
      textVersion: 1,
      tokens: [],
      selections: [{ anchorOffset: 0, headOffset: 0, startOffset: 0, endOffset: 0 }],
    } as unknown as EditorViewSnapshot
    const participant: EditorHoverParticipant = {
      computeSync: (request) => {
        if (request.anchor.offset !== zwspOffset) return []
        return [part({ start: zwspOffset, end: zwspOffset + 1 }, 'zero-width space')]
      },
    }
    const context = createTestViewContributionContext({
      container: element,
      scrollElement: element,
      contentElement: element,
      hasDocument: () => true,
      getSnapshot: () => snapshot,
      getProviders: (() => [participant]) as EditorViewContributionContext['getProviders'],
      focusEditor: vi.fn(),
      rowAtPoint: () => ({
        bufferRow: 0,
        displayRow: 0,
        source: 'document',
        region: 'trailing',
        offset: null,
      }),
      markerAtPoint: (clientX) =>
        clientX >= 90 && clientX <= 96 ? { kind: 'invisible', offset: zwspOffset } : null,
      textOffsetFromPoint: () => zwspOffset,
      getRangeClientRect: () => new DOMRect(90, 200, 6, 18),
    })
    const controller = createHoverController({ context, classNamespace: 'test' })
    tooltip().getBoundingClientRect = () => new DOMRect(12, 132, 200, 60)

    element.dispatchEvent(
      new PointerEvent('pointermove', { buttons: 0, clientX: 93, clientY: 209 }),
    )
    await vi.advanceTimersByTimeAsync(HOVER_REQUEST_DEBOUNCE_MS)
    expect(tooltip().hidden).toBe(false)
    expect(partTexts()).toEqual(['zero-width space'])

    element.dispatchEvent(
      new PointerEvent('pointermove', { buttons: 0, clientX: 110, clientY: 209 }),
    )
    await vi.advanceTimersByTimeAsync(TOOLTIP_HIDE_DELAY_MS)
    expect(tooltip().hidden).toBe(true)
    controller.dispose()
  })

  it('refreshes the hide timer during slow approach across an outside-editor gap above row 0', async () => {
    vi.useFakeTimers()
    const harness = mountGeometry({
      text: 'const topRow = 1',
      tooltipRect: new DOMRect(12, 52, 300, 60),
      tokens: [{ name: 'topRow', rect: new DOMRect(60, 120, 48, 18) }],
    })

    harness.moveTo(80, 129)
    await vi.advanceTimersByTimeAsync(HOVER_REQUEST_DEBOUNCE_MS)
    expect(partTexts()).toEqual(['hover:topRow'])

    // Pointer leaves the editor into the 8 px gap above row 0 (y = 119..112), moving 1 px / 50 ms.
    const editor = document.body.firstElementChild as HTMLElement
    editor.dispatchEvent(new PointerEvent('pointerleave', { relatedTarget: document.body }))
    for (let y = 119; y >= 112; y -= 1) {
      document.dispatchEvent(
        new PointerEvent('pointermove', { buttons: 0, clientX: 80, clientY: y }),
      )
      await vi.advanceTimersByTimeAsync(50)
    }
    expect(tooltip().hidden).toBe(false)
    expect(partTexts()).toEqual(['hover:topRow'])

    tooltip().dispatchEvent(new PointerEvent('pointerenter'))
    await vi.advanceTimersByTimeAsync(TOOLTIP_HIDE_DELAY_MS + 100)
    expect(tooltip().hidden).toBe(false)
    harness.dispose()
  })

  it('switches cleanly in both directions between an identifier and its adjacent end-of-line marker', async () => {
    vi.useFakeTimers()
    const text = 'const alpha\u200b'
    const alphaStart = text.indexOf('alpha')
    const alphaEnd = alphaStart + 'alpha'.length
    const zwspOffset = text.indexOf('\u200b')
    const element = document.createElement('div')
    element.getBoundingClientRect = () => new DOMRect(0, 0, 900, 700)
    document.body.append(element)
    const snapshot = {
      documentId: 'index.ts',
      languageId: 'typescript',
      textSnapshot: createStringTextSnapshot(text),
      textVersion: 1,
      tokens: [],
      selections: [{ anchorOffset: 0, headOffset: 0, startOffset: 0, endOffset: 0 }],
    } as unknown as EditorViewSnapshot
    const participant: EditorHoverParticipant = {
      computeSync: (request) => {
        if (request.anchor.offset === zwspOffset) {
          return [part({ start: zwspOffset, end: zwspOffset + 1 }, 'hover:zwsp')]
        }
        if (request.anchor.offset >= alphaStart && request.anchor.offset < alphaEnd) {
          return [part({ start: alphaStart, end: alphaEnd }, 'hover:alpha')]
        }
        return []
      },
    }
    const context = createTestViewContributionContext({
      container: element,
      scrollElement: element,
      contentElement: element,
      hasDocument: () => true,
      getSnapshot: () => snapshot,
      getProviders: (() => [participant]) as EditorViewContributionContext['getProviders'],
      focusEditor: vi.fn(),
      rowAtPoint: (clientX) => {
        if (clientX >= 50 && clientX <= 90) {
          return {
            bufferRow: 0,
            displayRow: 0,
            source: 'document',
            region: 'text',
            offset: alphaStart + 1,
          }
        }
        return { bufferRow: 0, displayRow: 0, source: 'document', region: 'trailing', offset: null }
      },
      markerAtPoint: (clientX) =>
        clientX >= 90 && clientX <= 96 ? { kind: 'invisible', offset: zwspOffset } : null,
      textOffsetFromPoint: (clientX) => (clientX >= 90 ? zwspOffset : alphaStart + 1),
      getRangeClientRect: (start, end) => {
        if (start === alphaStart && end === alphaEnd) return new DOMRect(50, 200, 40, 18)
        if (start === zwspOffset && end === zwspOffset + 1) return new DOMRect(90, 200, 0, 18)
        return null
      },
    })
    const controller = createHoverController({ context, classNamespace: 'test' })
    tooltip().getBoundingClientRect = () => new DOMRect(12, 132, 240, 60)

    element.dispatchEvent(
      new PointerEvent('pointermove', { buttons: 0, clientX: 70, clientY: 209 }),
    )
    await vi.advanceTimersByTimeAsync(HOVER_REQUEST_DEBOUNCE_MS)
    expect(partTexts()).toEqual(['hover:alpha'])

    // Move from `alpha` onto the adjacent zero-width marker.
    element.dispatchEvent(
      new PointerEvent('pointermove', { buttons: 0, clientX: 93, clientY: 209 }),
    )
    await vi.advanceTimersByTimeAsync(HOVER_REQUEST_DEBOUNCE_MS)
    expect(partTexts()).toEqual(['hover:zwsp'])

    // Move from the zero-width marker back onto `alpha`.
    element.dispatchEvent(
      new PointerEvent('pointermove', { buttons: 0, clientX: 70, clientY: 209 }),
    )
    await vi.advanceTimersByTimeAsync(HOVER_REQUEST_DEBOUNCE_MS)
    expect(partTexts()).toEqual(['hover:alpha'])
    controller.dispose()
  })

  it('does not restart an active hide timer when turning away outside the editor', async () => {
    vi.useFakeTimers()
    const harness = mountGeometry({
      text: 'const topRow = 1',
      tooltipRect: new DOMRect(12, 52, 300, 60),
      tokens: [{ name: 'topRow', rect: new DOMRect(60, 120, 48, 18) }],
    })

    harness.moveTo(80, 129)
    await vi.advanceTimersByTimeAsync(HOVER_REQUEST_DEBOUNCE_MS)
    expect(partTexts()).toEqual(['hover:topRow'])

    const editor = document.body.firstElementChild as HTMLElement
    editor.dispatchEvent(new PointerEvent('pointerleave', { relatedTarget: document.body }))
    await vi.advanceTimersByTimeAsync(TOOLTIP_HIDE_DELAY_MS - 50)
    expect(tooltip().hidden).toBe(false)

    // Turning far away outside the editor must keep the original 50 ms remaining deadline.
    document.dispatchEvent(
      new PointerEvent('pointermove', { buttons: 0, clientX: 500, clientY: 500 }),
    )
    await vi.advanceTimersByTimeAsync(50)
    expect(tooltip().hidden).toBe(true)
    harness.dispose()
  })

  it('keeps the full identifier target across a painted astral Unicode character inside the identifier', async () => {
    vi.useFakeTimers()
    const text = 'const a𝐚bc = 1'
    const identStart = text.indexOf('a𝐚bc')
    const identEnd = identStart + 'a𝐚bc'.length
    const boldOffset = text.indexOf('𝐚')
    const bOffset = text.indexOf('b')
    const element = document.createElement('div')
    element.getBoundingClientRect = () => new DOMRect(0, 0, 900, 700)
    document.body.append(element)
    const snapshot = {
      documentId: 'index.ts',
      languageId: 'typescript',
      textSnapshot: createStringTextSnapshot(text),
      textVersion: 1,
      tokens: [],
      selections: [{ anchorOffset: 0, headOffset: 0, startOffset: 0, endOffset: 0 }],
    } as unknown as EditorViewSnapshot
    const computeSync = vi.fn(
      (request: {
        readonly anchor: { readonly range: { readonly start: number; readonly end: number } }
      }) => [
        part(
          request.anchor.range,
          `hover:${text.slice(request.anchor.range.start, request.anchor.range.end)}`,
        ),
      ],
    )
    const context = createTestViewContributionContext({
      container: element,
      scrollElement: element,
      contentElement: element,
      hasDocument: () => true,
      getSnapshot: () => snapshot,
      getProviders: (() => [{ computeSync }]) as EditorViewContributionContext['getProviders'],
      focusEditor: vi.fn(),
      rowAtPoint: (clientX) => ({
        bufferRow: 0,
        displayRow: 0,
        source: 'document',
        region: 'text',
        offset: clientX < 80 ? boldOffset : bOffset,
      }),
      markerAtPoint: (clientX) =>
        clientX >= 68 && clientX < 80 ? { kind: 'ambiguous', offset: boldOffset } : null,
      textOffsetFromPoint: (clientX) => (clientX < 80 ? boldOffset : bOffset),
      getRangeClientRect: (start, end) => {
        if (start === identStart && end === identEnd) return new DOMRect(60, 200, 48, 18)
        return new DOMRect(60, 200, 12, 18)
      },
    })
    const controller = createHoverController({ context, classNamespace: 'test' })
    tooltip().getBoundingClientRect = () => new DOMRect(12, 132, 300, 60)

    element.dispatchEvent(
      new PointerEvent('pointermove', { buttons: 0, clientX: 72, clientY: 209 }),
    )
    await vi.advanceTimersByTimeAsync(HOVER_REQUEST_DEBOUNCE_MS)
    expect(tooltip().hidden).toBe(false)
    expect(partTexts()).toEqual(['hover:a𝐚bc'])
    expect(computeSync).toHaveBeenCalledTimes(1)

    element.dispatchEvent(
      new PointerEvent('pointermove', { buttons: 0, clientX: 88, clientY: 209 }),
    )
    await vi.advanceTimersByTimeAsync(HOVER_REQUEST_DEBOUNCE_MS)
    expect(tooltip().hidden).toBe(false)
    expect(partTexts()).toEqual(['hover:a𝐚bc'])
    expect(computeSync).toHaveBeenCalledTimes(1)
    controller.dispose()
  })

  it('keeps a visible loading hover alive when briefly crossing blank space and returning before hide', async () => {
    vi.useFakeTimers()
    let finish!: () => void
    const aborted: boolean[] = []
    const slow: EditorHoverParticipant = {
      computeAsync: (request, emit) =>
        new Promise<void>((resolve) => {
          request.signal.addEventListener('abort', () => {
            aborted.push(true)
            resolve()
          })
          finish = () => {
            emit([part(request.anchor.range, 'resolved answer')])
            resolve()
          }
        }),
    }
    const text = 'const alpha = 1'
    const alphaStart = text.indexOf('alpha')
    const element = document.createElement('div')
    element.getBoundingClientRect = () => new DOMRect(0, 0, 900, 700)
    document.body.append(element)
    const snapshot = {
      documentId: 'index.ts',
      languageId: 'typescript',
      textSnapshot: createStringTextSnapshot(text),
      textVersion: 1,
      tokens: [],
      selections: [{ anchorOffset: 0, headOffset: 0, startOffset: 0, endOffset: 0 }],
    } as unknown as EditorViewSnapshot
    const context = createTestViewContributionContext({
      container: element,
      scrollElement: element,
      contentElement: element,
      hasDocument: () => true,
      getSnapshot: () => snapshot,
      getProviders: (() => [slow]) as EditorViewContributionContext['getProviders'],
      focusEditor: vi.fn(),
      rowAtPoint: (clientX) => {
        if (clientX >= 60 && clientX <= 100) {
          return {
            bufferRow: 0,
            displayRow: 0,
            source: 'document',
            region: 'text',
            offset: alphaStart + 1,
          }
        }
        return { bufferRow: 0, displayRow: 0, source: 'document', region: 'trailing', offset: null }
      },
      markerAtPoint: () => null,
      textOffsetFromPoint: () => alphaStart + 1,
      getRangeClientRect: () => new DOMRect(60, 200, 40, 18),
    })
    const controller = createHoverController({ context, classNamespace: 'test' })
    tooltip().getBoundingClientRect = () => new DOMRect(12, 132, 300, 60)

    element.dispatchEvent(
      new PointerEvent('pointermove', { buttons: 0, clientX: 80, clientY: 209 }),
    )
    await vi.advanceTimersByTimeAsync(HOVER_LOADING_DELAY_MS)
    expect(tooltip().textContent).toContain('Loading…')

    // Move into trailing blank space, then return to the anchor within the 300 ms hide grace.
    element.dispatchEvent(
      new PointerEvent('pointermove', { buttons: 0, clientX: 160, clientY: 209 }),
    )
    await vi.advanceTimersByTimeAsync(100)
    element.dispatchEvent(
      new PointerEvent('pointermove', { buttons: 0, clientX: 80, clientY: 209 }),
    )
    expect(aborted).toEqual([])

    finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(tooltip().hidden).toBe(false)
    expect(tooltip().textContent).not.toContain('Loading…')
    expect(partTexts()).toEqual(['resolved answer'])
    controller.dispose()
  })

  it('does not let an async update make a zero-width marker tooltip stick over trailing whitespace', async () => {
    vi.useFakeTimers()
    let emitAsync!: () => void
    const text = 'const end\u200b'
    const zwspOffset = text.indexOf('\u200b')
    const element = document.createElement('div')
    element.getBoundingClientRect = () => new DOMRect(0, 0, 900, 700)
    document.body.append(element)
    const snapshot = {
      documentId: 'index.ts',
      languageId: 'typescript',
      textSnapshot: createStringTextSnapshot(text),
      textVersion: 1,
      tokens: [],
      selections: [{ anchorOffset: 0, headOffset: 0, startOffset: 0, endOffset: 0 }],
    } as unknown as EditorViewSnapshot
    const syncParticipant: EditorHoverParticipant = {
      computeSync: (request) =>
        request.anchor.offset === zwspOffset
          ? [part({ start: zwspOffset, end: zwspOffset + 1 }, 'zero-width space')]
          : [],
    }
    const asyncParticipant: EditorHoverParticipant = {
      computeAsync: (request, emit) =>
        new Promise<void>((resolve) => {
          request.signal.addEventListener('abort', () => resolve())
          emitAsync = () => {
            emit([
              {
                ordinal: 2,
                range: { start: zwspOffset, end: zwspOffset + 1 },
                markdown: 'async detail',
              },
            ])
            resolve()
          }
        }),
    }
    const context = createTestViewContributionContext({
      container: element,
      scrollElement: element,
      contentElement: element,
      hasDocument: () => true,
      getSnapshot: () => snapshot,
      getProviders: (() => [
        syncParticipant,
        asyncParticipant,
      ]) as EditorViewContributionContext['getProviders'],
      focusEditor: vi.fn(),
      rowAtPoint: () => ({
        bufferRow: 0,
        displayRow: 0,
        source: 'document',
        region: 'trailing',
        offset: null,
      }),
      markerAtPoint: (clientX, clientY) =>
        clientX >= 90 && clientX < 92 && clientY >= 200 && clientY <= 218
          ? { kind: 'invisible', offset: zwspOffset }
          : null,
      textOffsetFromPoint: () => zwspOffset,
      getRangeClientRect: () => new DOMRect(90, 200, 0, 18),
    })
    const controller = createHoverController({ context, classNamespace: 'test' })
    tooltip().getBoundingClientRect = () => new DOMRect(12, 132, 240, 60)

    // Hover the 2 px painted marker until the sync part paints.
    element.dispatchEvent(
      new PointerEvent('pointermove', { buttons: 0, clientX: 91, clientY: 209 }),
    )
    await vi.advanceTimersByTimeAsync(HOVER_REQUEST_DEBOUNCE_MS)
    expect(tooltip().hidden).toBe(false)
    expect(partTexts()).toEqual(['zero-width space'])

    // Leave 80 px into trailing whitespace; async provider then emits a second part.
    element.dispatchEvent(
      new PointerEvent('pointermove', { buttons: 0, clientX: 171, clientY: 209 }),
    )
    await vi.advanceTimersByTimeAsync(100)
    emitAsync()
    await vi.advanceTimersByTimeAsync(0)
    expect(partTexts()).toEqual(['zero-width space', 'async detail'])

    // Moving further in trailing whitespace must not cancel or reset the pending hide timer.
    element.dispatchEvent(
      new PointerEvent('pointermove', { buttons: 0, clientX: 170, clientY: 209 }),
    )
    await vi.advanceTimersByTimeAsync(TOOLTIP_HIDE_DELAY_MS - 100)
    expect(tooltip().hidden).toBe(true)
    controller.dispose()
  })
})

type PositionedToken = {
  readonly name: string
  readonly rect: DOMRect
}

type TrailingRow = {
  readonly top: number
  readonly bottom: number
  readonly textRight: number
  readonly clampedOffset: number
}

function mountGeometry(options: {
  readonly text: string
  readonly tooltipRect: DOMRect
  readonly tokens: readonly PositionedToken[]
  readonly trailingRows?: readonly TrailingRow[]
  readonly wideDiagnostic?: {
    readonly range: { readonly start: number; readonly end: number }
    readonly rect: DOMRect
  }
}) {
  const element = document.createElement('div')
  element.getBoundingClientRect = () => new DOMRect(0, 0, 900, 700)
  document.body.append(element)
  const ranges = options.tokens.map((token) => {
    const start = options.text.indexOf(token.name)
    if (start < 0) throw new Error(`missing token ${token.name}`)
    return { ...token, start, end: start + token.name.length }
  })
  const snapshot = {
    documentId: 'index.ts',
    languageId: 'typescript',
    textSnapshot: createStringTextSnapshot(options.text),
    textVersion: 1,
    tokens: [],
    selections: [{ anchorOffset: 0, headOffset: 0, startOffset: 0, endOffset: 0 }],
  } as unknown as EditorViewSnapshot
  const participant: EditorHoverParticipant = {
    computeSync: (request) => {
      const token = ranges.find(
        (candidate) =>
          request.anchor.offset >= candidate.start && request.anchor.offset <= candidate.end,
      )
      if (!token) return []
      const parts: HoverPart[] = [
        part({ start: token.start, end: token.end }, `hover:${token.name}`),
      ]
      if (options.wideDiagnostic && token.name === 'alpha') {
        parts.push({
          ordinal: 2,
          range: options.wideDiagnostic.range,
          notes: [{ text: 'wide diagnostic' }],
        })
      }
      return parts
    },
  }
  const hitTokenAt = (clientX: number, clientY: number) =>
    ranges.find(
      (token) =>
        clientX >= token.rect.left &&
        clientX <= token.rect.right &&
        clientY >= token.rect.top &&
        clientY <= token.rect.bottom,
    )
  const hitTrailingAt = (clientX: number, clientY: number) =>
    (options.trailingRows ?? []).find(
      (row) => clientY >= row.top && clientY <= row.bottom && clientX > row.textRight,
    )
  const context = createTestViewContributionContext({
    container: element,
    scrollElement: element,
    contentElement: element,
    hasDocument: () => true,
    getSnapshot: () => snapshot,
    getProviders: (() => [participant]) as EditorViewContributionContext['getProviders'],
    focusEditor: vi.fn(),
    rowAtPoint: (clientX, clientY) => {
      const hit = hitTokenAt(clientX, clientY)
      if (hit) {
        return {
          bufferRow: 0,
          displayRow: 0,
          source: 'document',
          region: 'text',
          offset: hit.start + 1,
        }
      }
      if (hitTrailingAt(clientX, clientY)) {
        return { bufferRow: 0, displayRow: 0, source: 'document', region: 'trailing', offset: null }
      }
      return null
    },
    markerAtPoint: () => null,
    textOffsetFromPoint: (clientX, clientY) => {
      const hit = hitTokenAt(clientX, clientY)
      if (hit) return hit.start + 1
      const trailing = hitTrailingAt(clientX, clientY)
      return trailing ? trailing.clampedOffset : null
    },
    getRangeClientRect: (start, end) => {
      if (
        options.wideDiagnostic &&
        start === options.wideDiagnostic.range.start &&
        end === options.wideDiagnostic.range.end
      ) {
        return options.wideDiagnostic.rect
      }
      const hit = ranges.find((token) => token.start === start && token.end === end)
      return hit?.rect ?? null
    },
  })
  const controller = createHoverController({ context, classNamespace: 'test' })
  tooltip().getBoundingClientRect = () => options.tooltipRect
  return {
    controller,
    moveTo: (clientX: number, clientY: number) => {
      element.dispatchEvent(new PointerEvent('pointermove', { buttons: 0, clientX, clientY }))
    },
    enterTooltip: () => {
      const popup = tooltip()
      element.dispatchEvent(new PointerEvent('pointerleave', { relatedTarget: popup }))
      popup.dispatchEvent(new PointerEvent('pointerenter'))
    },
    dispose: () => controller.dispose(),
  }
}

function part(range: HoverPart['range'], markdown: string): HoverPart {
  return { ordinal: 1, range, markdown }
}

function mount(participants: readonly EditorHoverParticipant[]) {
  const element = document.createElement('div')
  element.getBoundingClientRect = () => new DOMRect(0, 0, 900, 700)
  document.body.append(element)
  let pointerOffset = 6
  const snapshot = {
    documentId: 'index.ts',
    languageId: 'typescript',
    textSnapshot: createStringTextSnapshot(TEXT),
    textVersion: 1,
    tokens: [],
    selections: [{ anchorOffset: 6, headOffset: 6, startOffset: 6, endOffset: 6 }],
  } as unknown as EditorViewSnapshot
  const context = createTestViewContributionContext({
    container: element,
    scrollElement: element,
    contentElement: element,
    hasDocument: () => true,
    getSnapshot: () => snapshot,
    getProviders: (() => participants) as EditorViewContributionContext['getProviders'],
    focusEditor: vi.fn(),
    markerAtPoint: () => null,
    textOffsetFromPoint: () => pointerOffset,
    getRangeClientRect: () => new DOMRect(10, 20, 40, 18),
  })
  const controller = createHoverController({ context, classNamespace: 'test' })
  return {
    controller,
    pointerMove: (offset = 6) => {
      pointerOffset = offset
      element.dispatchEvent(
        new PointerEvent('pointermove', { buttons: 0, clientX: 40, clientY: 60 }),
      )
    },
    dispose: () => controller.dispose(),
  }
}

function tooltip(): HTMLElement {
  const element = document.querySelector<HTMLElement>('.editor-test-hover')
  if (!element) throw new Error('missing tooltip')
  return element
}

function partTexts(): readonly string[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-hover-part-index]'), (item) =>
    (item.textContent ?? '').trim(),
  )
}
