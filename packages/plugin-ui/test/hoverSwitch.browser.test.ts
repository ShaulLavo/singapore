import { Editor } from '@singapore-editor/core/editor'
import type { EditorPlugin, EditorViewContributionContext } from '@singapore-editor/core/extensions'
import { afterEach, expect, it, vi } from 'vitest'
import { commands } from 'vitest/browser'

import type { HoverPart, HoverRequest } from '../src/hoverParticipant'
import { EDITOR_HOVER_PARTICIPANT } from '../src/hoverToken'
import { HOVER_REQUEST_DEBOUNCE_MS, TOOLTIP_HIDE_DELAY_MS } from '../src/tooltip'

declare module 'vitest/browser' {
  interface BrowserCommands {
    movePointer(x: number, y: number, steps?: number): Promise<void>
  }
}

const SAMPLE_LINES = [
  '',
  '',
  '',
  '',
  '',
  '',
  'const upperToken = 123',
  'const alphaToken = betaToken + gammaToken',
  'const lowerToken = 456',
]
const SAMPLE_TEXT = SAMPLE_LINES.join('\n')

let dispose: () => void = () => undefined

afterEach(() => {
  dispose()
  dispose = () => undefined
  document.body.replaceChildren()
})

it('opens Token B hover when moving horizontally from Token A underneath a wide tooltip', async () => {
  const harness = await mountEditor()
  const alpha = harness.tokenRect('alphaToken')
  const beta = harness.tokenRect('betaToken')

  await commands.movePointer(centerX(alpha), centerY(alpha))
  await waitForHoverText('token:alphaToken')

  const popupRect = hoverDialog().getBoundingClientRect()
  expect(popupRect.bottom).toBeLessThanOrEqual(alpha.top)
  expect(popupRect.right).toBeGreaterThan(beta.left)

  await commands.movePointer(centerX(beta), centerY(beta), 6)
  await waitForHoverText('token:betaToken')
})

it('opens the closer token hover when moving up into the gap between anchor and tooltip and stopping', async () => {
  const harness = await mountEditor()
  const alpha = harness.tokenRect('alphaToken')
  const alphaRow = harness.rowBounds('alphaToken')
  const upper = harness.tokenRect('upperToken')

  await commands.movePointer(centerX(alpha), centerY(alpha))
  await waitForHoverText('token:alphaToken')

  const popupRect = hoverDialog().getBoundingClientRect()
  expect(popupRect.bottom).toBeLessThan(alphaRow.top)
  // Stay in the part of the 8px gap that lands on upperToken's row (independent of font leading).
  const gapY = (popupRect.bottom + alphaRow.top) / 2
  expect(gapY).toBeGreaterThan(popupRect.bottom)
  expect(gapY).toBeLessThan(alphaRow.top)
  expect(harness.rowAtPoint(centerX(upper), gapY)?.displayRow).toBe(
    harness.rowBounds('upperToken').displayRow,
  )

  await commands.movePointer(centerX(upper), gapY, 3)
  await waitForHoverText('token:upperToken')
})

it('opens Token B hover when moving diagonally closer to the tooltip onto Token B and stopping', async () => {
  const harness = await mountEditor()
  const alpha = harness.tokenRect('alphaToken')
  const beta = harness.tokenRect('betaToken')

  await commands.movePointer(alpha.right - 2, alpha.bottom - 1)
  await waitForHoverText('token:alphaToken')

  const popupRect = hoverDialog().getBoundingClientRect()
  expect(popupRect.bottom).toBeLessThanOrEqual(alpha.top)
  expect(popupRect.right).toBeGreaterThan(beta.left)

  // Move diagonally up-right from the bottom-right of alphaToken to the top-left of betaToken.
  await commands.movePointer(beta.left + 4, beta.top + 1, 4)
  await waitForHoverText('token:betaToken')
})

it('keeps the tooltip open when moving straight from Token A across the gap into the tooltip', async () => {
  const harness = await mountEditor()
  const alpha = harness.tokenRect('alphaToken')

  await commands.movePointer(centerX(alpha), centerY(alpha))
  await waitForHoverText('token:alphaToken')

  const popupRect = hoverDialog().getBoundingClientRect()
  expect(popupRect.bottom).toBeLessThanOrEqual(alpha.top)

  await commands.movePointer(centerX(alpha), popupRect.bottom - 10, 6)
  await wait(HOVER_REQUEST_DEBOUNCE_MS + TOOLTIP_HIDE_DELAY_MS + 100)

  const dialog = hoverDialog()
  expect(dialog.hidden).toBe(false)
  expect(dialog.textContent).toContain('token:alphaToken')
})

it('keeps the tooltip open along a wide diagonal path through the gap into the tooltip', async () => {
  const harness = await mountEditor()
  const alpha = harness.tokenRect('alphaToken')
  const alphaRow = harness.rowBounds('alphaToken')
  const startX = centerX(alpha)
  const startY = centerY(alpha)

  await commands.movePointer(startX, startY)
  await waitForHoverText('token:alphaToken')

  const popupRect = hoverDialog().getBoundingClientRect()
  expect(popupRect.bottom).toBeLessThan(alphaRow.top)
  expect(popupRect.right).toBeGreaterThan(startX + 80)

  const gapY = (popupRect.bottom + alphaRow.top) / 2
  // Move diagonally (+46 px right, up into the gap above alphaToken's row), then continue into the tooltip.
  await commands.movePointer(startX + 46, gapY, 3)
  expect(hoverDialog().hidden).toBe(false)
  await commands.movePointer(startX + 64, popupRect.bottom - 10, 3)
  await wait(HOVER_REQUEST_DEBOUNCE_MS + TOOLTIP_HIDE_DELAY_MS + 100)

  const dialog = hoverDialog()
  expect(dialog.hidden).toBe(false)
  expect(dialog.textContent).toContain('token:alphaToken')
})

it('keeps the tooltip open during slow continuous movement through the gap exceeding the settle delay', async () => {
  const harness = await mountEditor()
  const alpha = harness.tokenRect('alphaToken')
  const alphaRow = harness.rowBounds('alphaToken')
  const x = centerX(alpha)

  await commands.movePointer(x, centerY(alpha))
  await waitForHoverText('token:alphaToken')

  const popupRect = hoverDialog().getBoundingClientRect()
  expect(popupRect.bottom).toBeLessThan(alphaRow.top)

  // Step across every integer pixel strictly inside the gap above alphaToken's row,
  // spending more than TOOLTIP_HIDE_DELAY_MS in transit before entering the tooltip.
  const ys = gapIntegerYs(popupRect.bottom, alphaRow.top)
  expect(ys.length).toBeGreaterThanOrEqual(2)
  const stepDelayMs = Math.ceil((TOOLTIP_HIDE_DELAY_MS + 90) / ys.length)
  for (const y of ys) {
    await commands.movePointer(x, y)
    await wait(stepDelayMs)
  }
  await commands.movePointer(x, popupRect.bottom - 4)

  await wait(HOVER_REQUEST_DEBOUNCE_MS + 100)
  const dialog = hoverDialog()
  expect(dialog.hidden).toBe(false)
  expect(dialog.textContent).toContain('token:alphaToken')
})

it('hides the tooltip instead of opening a token hover when pausing in trailing blank space in the corridor', async () => {
  const text = [
    '',
    '',
    '',
    '',
    '',
    '',
    'let upperToken',
    'const alphaToken = betaToken + gammaToken',
    'const lowerToken = 456',
  ].join('\n')
  const harness = await mountEditor(text)
  const alpha = harness.tokenRect('alphaToken')
  const alphaRow = harness.rowBounds('alphaToken')
  const upper = harness.tokenRect('upperToken')

  await commands.movePointer(centerX(alpha), centerY(alpha))
  await waitForHoverText('token:alphaToken')

  const popupRect = hoverDialog().getBoundingClientRect()
  expect(popupRect.bottom).toBeLessThan(alphaRow.top)
  const gapY = (popupRect.bottom + alphaRow.top) / 2
  expect(harness.rowAtPoint(upper.right + 6, gapY)).toMatchObject({
    displayRow: harness.rowBounds('upperToken').displayRow,
    region: 'trailing',
  })

  // Stop 6 px past the end of `let upperToken` (trailing blank space inside the corridor).
  await commands.movePointer(upper.right + 6, gapY, 3)
  await vi.waitFor(
    () => {
      expect(hoverDialog().hidden).toBe(true)
    },
    { timeout: 3000, interval: 25 },
  )
})

it('keeps the tooltip visible when moving across characters inside a non-ASCII identifier', async () => {
  const text = ['', '', '', '', '', '', 'const 变量名 = 1'].join('\n')
  const harness = await mountEditor(text, (word) => word === '变量名')
  const identifier = harness.tokenRect('变量名')

  await commands.movePointer(identifier.left + 4, centerY(identifier))
  await waitForHoverText('token:变量名')
  expect(harness.computeCount()).toBe(1)

  await commands.movePointer(identifier.right - 4, centerY(identifier), 3)
  await wait(HOVER_REQUEST_DEBOUNCE_MS + 100)

  const dialog = hoverDialog()
  expect(dialog.hidden).toBe(false)
  expect(dialog.textContent).toContain('token:变量名')
  expect(harness.computeCount()).toBe(1)
})

it('switches cleanly between an identifier, its adjacent end-of-line zero-width marker, and trailing blank space', async () => {
  const text = ['', '', '', '', '', '', 'const endMarker\u200b'].join('\n')
  const markerStart = text.indexOf('endMarker')
  const markerEnd = markerStart + 'endMarker'.length
  const zwspOffset = text.indexOf('\u200b')
  const harness = await mountEditor(text, undefined, (request) => {
    if (request.anchor.offset === zwspOffset) {
      return [
        {
          ordinal: 1,
          range: { start: zwspOffset, end: zwspOffset + 1 },
          markdown: 'invisible zero-width space',
        },
      ]
    }
    if (request.anchor.offset >= markerStart && request.anchor.offset < markerEnd) {
      return [
        {
          ordinal: 1,
          range: { start: markerStart, end: markerEnd },
          markdown: 'identifier:endMarker',
        },
      ]
    }
    return []
  })

  const identifierRect = harness.tokenRect('endMarker')
  const marker = document.querySelector<HTMLElement>(
    `[data-editor-hidden-character-offset="${zwspOffset}"]`,
  )
  expect(marker).not.toBeNull()
  const markerRect = marker!.getBoundingClientRect()

  // Identifier -> adjacent zero-width marker -> back to identifier -> marker -> trailing blank space.
  await commands.movePointer(centerX(identifierRect), centerY(identifierRect))
  await waitForHoverText('identifier:endMarker')

  await commands.movePointer(centerX(markerRect), centerY(markerRect), 4)
  await waitForHoverText('invisible zero-width space')

  await commands.movePointer(centerX(identifierRect), centerY(identifierRect), 4)
  await waitForHoverText('identifier:endMarker')

  await commands.movePointer(centerX(markerRect), centerY(markerRect), 4)
  await waitForHoverText('invisible zero-width space')

  await commands.movePointer(markerRect.right + 10, centerY(markerRect), 3)
  await vi.waitFor(
    () => {
      expect(hoverDialog().hidden).toBe(true)
    },
    { timeout: 3000, interval: 25 },
  )
  expect(harness.computeCount()).toBeGreaterThanOrEqual(4)
})

it('switches cleanly between an inline zero-width marker and the adjacent identifiers on both sides', async () => {
  const text = ['', '', '', '', '', '', 'alpha\u200bbeta'].join('\n')
  const alphaStart = text.indexOf('alpha')
  const alphaEnd = alphaStart + 'alpha'.length
  const zwspOffset = text.indexOf('\u200b')
  const betaStart = text.indexOf('beta')
  const betaEnd = betaStart + 'beta'.length
  const harness = await mountEditor(text, undefined, (request) => {
    if (request.anchor.offset === zwspOffset) {
      return [
        {
          ordinal: 1,
          range: { start: zwspOffset, end: zwspOffset + 1 },
          markdown: 'inline zero-width space',
        },
      ]
    }
    if (request.anchor.offset >= alphaStart && request.anchor.offset < alphaEnd) {
      return [
        {
          ordinal: 1,
          range: { start: alphaStart, end: alphaEnd },
          markdown: 'identifier:alpha',
        },
      ]
    }
    if (request.anchor.offset >= betaStart && request.anchor.offset < betaEnd) {
      return [
        {
          ordinal: 1,
          range: { start: betaStart, end: betaEnd },
          markdown: 'identifier:beta',
        },
      ]
    }
    return []
  })

  const alphaRect = harness.tokenRect('alpha')
  const betaRect = harness.tokenRect('beta')
  const marker = document.querySelector<HTMLElement>(
    `[data-editor-hidden-character-offset="${zwspOffset}"]`,
  )
  expect(marker).not.toBeNull()
  const markerRect = marker!.getBoundingClientRect()

  // Marker -> beta -> back to marker (overlapping beta's left edge) -> alpha -> back to marker.
  await commands.movePointer(centerX(markerRect), centerY(markerRect))
  await waitForHoverText('inline zero-width space')

  await commands.movePointer(betaRect.right - 4, centerY(betaRect), 4)
  await waitForHoverText('identifier:beta')

  await commands.movePointer(centerX(markerRect), centerY(markerRect), 4)
  await waitForHoverText('inline zero-width space')

  await commands.movePointer(alphaRect.left + 4, centerY(alphaRect), 4)
  await waitForHoverText('identifier:alpha')

  await commands.movePointer(centerX(markerRect), centerY(markerRect), 4)
  await waitForHoverText('inline zero-width space')
})

it('keeps the tooltip open during slow continuous movement across a gap above the first visible row', async () => {
  const text = 'const topRowToken = 1\nconst nextRow = 2'
  const harness = await mountEditor(text, undefined, undefined, { top: 180 })
  const token = harness.tokenRect('topRowToken')
  const tokenRow = harness.rowBounds('topRowToken')
  const x = centerX(token)

  await commands.movePointer(x, centerY(token))
  await waitForHoverText('token:topRowToken')

  const popupRect = hoverDialog().getBoundingClientRect()
  expect(popupRect.bottom).toBeLessThan(tokenRow.top)

  // Spend > TOOLTIP_HIDE_DELAY_MS moving across the gap outside the scroll element into the tooltip.
  const ys = gapIntegerYs(popupRect.bottom, tokenRow.top)
  expect(ys.length).toBeGreaterThanOrEqual(2)
  const stepDelayMs = Math.ceil((TOOLTIP_HIDE_DELAY_MS + 90) / ys.length)
  for (const y of ys) {
    await commands.movePointer(x, y)
    await wait(stepDelayMs)
  }
  await commands.movePointer(x, popupRect.bottom - 4)

  await wait(HOVER_REQUEST_DEBOUNCE_MS + 100)
  const dialog = hoverDialog()
  expect(dialog.hidden).toBe(false)
  expect(dialog.textContent).toContain('token:topRowToken')
})

async function mountEditor(
  text = SAMPLE_TEXT,
  matchesWord: (word: string) => boolean = (word) => word.endsWith('Token'),
  customCompute?: (request: HoverRequest) => readonly HoverPart[],
  position: { readonly top?: number } = {},
) {
  const host = document.createElement('div')
  host.style.cssText = `position:fixed;left:40px;top:${position.top ?? 40}px;width:900px;height:500px`
  document.body.append(host)

  let viewContext: EditorViewContributionContext | null = null
  let computeCount = 0
  const testPlugin: EditorPlugin = {
    name: 'test.hoverSwitch',
    activate: (plugin) =>
      plugin.registerViewContribution({
        createContribution: (context) => {
          viewContext = context
          const registration = context.registerProvider(
            EDITOR_HOVER_PARTICIPANT,
            { language: '*' },
            {
              computeSync: (request) => {
                computeCount += 1
                if (customCompute) return customCompute(request)
                const { start, end } = request.anchor.range
                const word = request.snapshot.textSnapshot.readRange(start, end)
                if (!matchesWord(word)) return []
                return [
                  {
                    ordinal: 1,
                    range: request.anchor.range,
                    markdown: `\`\`\`ts\n// wide tooltip body so it spans horizontally over neighbouring tokens on the line\nconst info = "token:${word}"\n\`\`\``,
                  },
                ]
              },
            },
          )
          return {
            update: () => undefined,
            dispose: () => {
              registration.dispose()
              viewContext = null
            },
          }
        },
      }),
  }

  const editor = new Editor(host, {
    defaultText: text,
    theme: { type: 'dark' },
    folding: false,
    plugins: [testPlugin],
  })
  dispose = () => editor.dispose()

  const firstVisible = text.search(/\S/)
  await vi.waitFor(
    () => {
      expect(viewContext).not.toBeNull()
      expect(viewContext!.getRangeClientRect(firstVisible, firstVisible + 1)).not.toBeNull()
      expect(document.querySelector('.editor-plugin-hover')).not.toBeNull()
    },
    { timeout: 3000, interval: 25 },
  )
  // Wait for the editor's initial ResizeObserver layout pass to settle before driving the pointer.
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  )

  const tokenRect = (word: string): DOMRect => {
    if (!viewContext) throw new Error('missing view context')
    const start = text.indexOf(word)
    if (start < 0) throw new Error(`missing token ${word}`)
    const rect = viewContext.getRangeClientRect(start, start + word.length)
    if (!rect) throw new Error(`missing rect for ${word}`)
    return rect
  }

  const rowBounds = (
    word: string,
  ): { readonly top: number; readonly bottom: number; readonly displayRow: number } => {
    if (!viewContext) throw new Error('missing view context')
    const rect = tokenRect(word)
    const hit = viewContext.rowAtPoint(centerX(rect), centerY(rect))
    if (!hit) throw new Error(`missing row for ${word}`)
    const { rowHeight } = viewContext.getSnapshot().metrics
    const top =
      viewContext.scrollElement.getBoundingClientRect().top +
      hit.displayRow * rowHeight -
      viewContext.scrollElement.scrollTop
    return { top, bottom: top + rowHeight, displayRow: hit.displayRow }
  }

  return {
    computeCount: () => computeCount,
    tokenRect,
    rowBounds,
    rowAtPoint: (clientX: number, clientY: number) => {
      if (!viewContext) throw new Error('missing view context')
      return viewContext.rowAtPoint(clientX, clientY)
    },
  }
}

function gapIntegerYs(popupBottom: number, rowTop: number): readonly number[] {
  const startY = Math.ceil(rowTop) - 1
  const endY = Math.floor(popupBottom) + 1
  const ys: number[] = []
  for (let y = startY; y >= endY; y -= 1) {
    ys.push(y)
  }
  return ys
}

function hoverDialog(): HTMLElement {
  const element = document.querySelector<HTMLElement>('.editor-plugin-hover')
  if (!element) throw new Error('missing hover dialog')
  return element
}

function centerX(rect: DOMRect): number {
  return rect.left + rect.width / 2
}

function centerY(rect: DOMRect): number {
  return rect.top + rect.height / 2
}

async function waitForHoverText(expected: string): Promise<void> {
  await vi.waitFor(
    () => {
      const dialog = hoverDialog()
      expect(dialog.hidden).toBe(false)
      expect(dialog.textContent).toContain(expected)
    },
    { timeout: 3000, interval: 25 },
  )
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
