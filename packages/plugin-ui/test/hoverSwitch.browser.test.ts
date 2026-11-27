import { Editor } from '@singapore-editor/core/editor'
import type { EditorPlugin, EditorViewContributionContext } from '@singapore-editor/core/extensions'
import { afterEach, expect, it, vi } from 'vitest'
import { commands } from 'vitest/browser'

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
  const upper = harness.tokenRect('upperToken')

  await commands.movePointer(centerX(alpha), centerY(alpha))
  await waitForHoverText('token:alphaToken')

  const popupRect = hoverDialog().getBoundingClientRect()
  expect(popupRect.bottom).toBeLessThanOrEqual(alpha.top)
  // The 8px gap between the open tooltip and alphaToken overlaps the bottom of upperToken's row.
  const gapY = (popupRect.bottom + alpha.top) / 2
  expect(gapY).toBeGreaterThan(popupRect.bottom)
  expect(gapY).toBeLessThan(alpha.top)

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

async function mountEditor() {
  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;left:40px;top:40px;width:900px;height:500px'
  document.body.append(host)

  let viewContext: EditorViewContributionContext | null = null
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
                const { start, end } = request.anchor.range
                const word = request.snapshot.textSnapshot.readRange(start, end)
                if (!word.endsWith('Token')) return []
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
    defaultText: SAMPLE_TEXT,
    theme: { type: 'dark' },
    folding: false,
    plugins: [testPlugin],
  })
  dispose = () => editor.dispose()

  const alphaStart = SAMPLE_TEXT.indexOf('alphaToken')
  await vi.waitFor(
    () => {
      expect(viewContext).not.toBeNull()
      expect(
        viewContext!.getRangeClientRect(alphaStart, alphaStart + 'alphaToken'.length),
      ).not.toBeNull()
      expect(document.querySelector('.editor-plugin-hover')).not.toBeNull()
    },
    { timeout: 3000, interval: 25 },
  )
  // Wait for the editor's initial ResizeObserver layout pass to settle before driving the pointer.
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  )

  return {
    tokenRect: (word: string): DOMRect => {
      if (!viewContext) throw new Error('missing view context')
      const start = SAMPLE_TEXT.indexOf(word)
      if (start < 0) throw new Error(`missing token ${word}`)
      const rect = viewContext.getRangeClientRect(start, start + word.length)
      if (!rect) throw new Error(`missing rect for ${word}`)
      return rect
    },
  }
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
