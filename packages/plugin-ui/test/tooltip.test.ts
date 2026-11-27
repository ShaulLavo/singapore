import { afterEach, describe, expect, it, vi } from 'vitest'

import { createTooltipController } from '../src/tooltip'

describe('tooltip content', () => {
  afterEach(() => document.body.replaceChildren())

  it('keeps each note action beside its own diagnostic and tracks an async action', async () => {
    const controller = tooltipController()
    let resolve!: () => void
    const first = vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done
        }),
    )
    const second = vi.fn()
    controller.show({
      ...showOptions(),
      parts: [
        {
          notes: [
            { text: 'First diagnostic', actions: [{ label: 'Investigate', run: first }] },
            { text: 'Second diagnostic', actions: [{ label: 'Investigate', run: second }] },
          ],
        },
      ],
    })
    const sections = document.querySelectorAll('.editor-test-hover-notes')
    const firstButton = sections[0]?.querySelector<HTMLButtonElement>(
      '.editor-test-hover-action button',
    )
    const secondButton = sections[1]?.querySelector<HTMLButtonElement>(
      '.editor-test-hover-action button',
    )
    expect(firstButton).toBeTruthy()
    expect(secondButton).toBeTruthy()
    firstButton!.click()
    firstButton!.click()
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
    expect(firstButton!.getAttribute('aria-disabled')).toBe('true')
    expect(firstButton!.getAttribute('aria-busy')).toBe('true')
    resolve()
    await vi.waitFor(() => expect(firstButton!.hasAttribute('aria-disabled')).toBe(false))
    secondButton!.click()
    expect(second).toHaveBeenCalledOnce()
    controller.dispose()
  })

  it('keeps pending and failed note actions across progressive hover rendering', async () => {
    const controller = tooltipController()
    let reject!: (error: Error) => void
    const run = vi.fn(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail
        }),
    )
    const notes = [{ text: 'Warning', actions: [{ label: 'Inspect', run }] }]
    controller.show({ ...showOptions(), parts: [{ notes }] })
    document.querySelector<HTMLButtonElement>('.editor-test-hover-action button')!.click()
    controller.show({
      ...showOptions(),
      parts: [{ notes }, { markdown: 'semantic hover arrived' }],
    })
    const current = document.querySelector<HTMLButtonElement>('.editor-test-hover-action button')!
    current.click()
    expect(run).toHaveBeenCalledTimes(1)
    reject(new Error('Action failed'))
    await vi.waitFor(() =>
      expect(document.querySelector('[role="status"]')?.textContent).toBe('Action failed'),
    )
    controller.dispose()
  })

  it('keeps a pending action focusable for Escape and a progressive update', () => {
    const controller = tooltipController()
    const notes = [
      {
        text: 'Warning',
        actions: [{ label: 'Inspect', run: () => new Promise<void>(() => undefined) }],
      },
    ]
    controller.show({ ...showOptions(), focus: true, parts: [{ notes }] })
    const button = document.querySelector<HTMLButtonElement>('.editor-test-hover-action button')!
    button.focus()
    button.click()
    expect(button.disabled).toBe(false)
    expect(button.getAttribute('aria-disabled')).toBe('true')
    controller.show({ ...showOptions(), parts: [{ notes }, { markdown: 'semantic' }] })
    expect(document.activeElement).toBe(button)
    controller.dispose()
  })

  it('shows a failed action and allows retry without replacing its note', async () => {
    const controller = tooltipController()
    const run = vi.fn().mockRejectedValueOnce(new Error('Try again')).mockResolvedValue(undefined)
    controller.show({
      ...showOptions(),
      parts: [{ notes: [{ text: 'Warning', actions: [{ label: 'Inspect', run }] }] }],
    })
    const button = document.querySelector<HTMLButtonElement>('.editor-test-hover-action button')!
    button.click()
    await vi.waitFor(() =>
      expect(document.querySelector('[role="status"]')?.textContent).toBe('Try again'),
    )
    expect(button.disabled).toBe(false)
    button.click()
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
    expect(document.querySelector('[role="status"]')?.textContent).toBe('')
    expect(document.querySelector('.editor-test-hover-notes')?.textContent).toContain('Warning')
    controller.dispose()
  })

  it('runs actions and drops them when the hover is replaced', () => {
    const controller = tooltipController()
    const run = vi.fn()
    controller.show({ ...showOptions(), parts: [{ actions: [{ label: 'Adjust settings', run }] }] })
    const button = document.querySelector<HTMLButtonElement>('.editor-test-hover-action button')
    expect(button?.textContent).toBe('Adjust settings')
    button?.click()
    expect(run).toHaveBeenCalledOnce()
    controller.show(showOptions())
    expect(document.querySelector('.editor-test-hover-action')).toBeNull()
    controller.dispose()
  })

  it('renders notes as marker rows and prefers the bottom placement for them', () => {
    const controller = tooltipController()
    controller.show({
      ...showOptions(),
      preferredPlacement: undefined,
      parts: [{ notes: [{ text: 'Looks like a hyphen' }] }],
    })
    const section = document.querySelector<HTMLElement>('.editor-test-hover-notes')
    expect(section?.getAttribute('aria-label')).toBe('Looks like a hyphen')
    expect(section?.querySelector('span')?.textContent).toBe('Looks like a hyphen')
    expect(document.querySelector('.editor-test-hover')?.getAttribute('data-editor-popup')).toBe('')
    controller.dispose()
  })

  it('lays a note out like a VS Code marker: lines kept, source and code after, related below', () => {
    const controller = tooltipController()
    const open = vi.fn()
    controller.show({
      ...showOptions(),
      parts: [
        {
          notes: [
            {
              text: 'Expected expression to be used\nhelp: Consider removing it',
              source: 'oxc',
              code: 'no-unused-expressions',
              codeHref: 'https://oxc.rs/docs/guide/usage/linter/rules/eslint/no-unused-expressions',
              related: [{ label: 'other.ts(4, 2): ', text: 'first declared here', open }],
            },
          ],
        },
      ],
    })
    const section = document.querySelector<HTMLElement>('.editor-test-hover-notes')
    const message = section?.querySelector<HTMLElement>('div > div > span')
    expect(message?.style.whiteSpace).toBe('pre-wrap')
    expect(message?.textContent).toContain('\nhelp:')
    const code = section?.querySelector<HTMLAnchorElement>('a[href]')
    expect(code?.textContent).toBe('(no-unused-expressions)')
    expect(code?.previousSibling?.textContent).toBe('oxc')
    const related = section?.querySelector<HTMLButtonElement>('button[type="button"]')
    expect(related?.textContent).toBe('other.ts(4, 2): ')
    related?.click()
    expect(open).toHaveBeenCalledOnce()
    expect(section?.getAttribute('aria-label')).toBe(
      'Expected expression to be used\nhelp: Consider removing it oxc(no-unused-expressions)\nother.ts(4, 2): first declared here',
    )
    controller.dispose()
  })

  it('renders parts in the order given, whatever their kind', () => {
    const controller = tooltipController()
    controller.show({
      ...showOptions(),
      hoverText: null,
      parts: [{ notes: [{ text: 'first' }] }, { markdown: 'then the type' }],
    })
    const body = document.querySelector('.editor-test-hover-body')
    const kinds = Array.from(body?.children ?? [], (child) => child.className)
    expect(kinds).toEqual(['editor-test-hover-notes', 'editor-test-hover-part'])
    controller.dispose()
  })

  it('carries every syntax colour from the editor, so hover code matches the document', () => {
    const controller = tooltipController()
    const editor = document.body.firstElementChild as HTMLElement
    editor.style.setProperty('--editor-syntax-keyword-declaration', '#a78bfa')
    editor.style.setProperty('--editor-syntax-function', '#fecdd3')
    editor.style.setProperty('--editor-syntax-type-parameter', '#7dd3fc')

    controller.show(showOptions())

    const tooltip = document.querySelector<HTMLElement>('.editor-test-hover')!
    expect(tooltip.style.getPropertyValue('--editor-syntax-keyword-declaration')).toBe('#a78bfa')
    expect(tooltip.style.getPropertyValue('--editor-syntax-function')).toBe('#fecdd3')
    expect(tooltip.style.getPropertyValue('--editor-syntax-type-parameter')).toBe('#7dd3fc')
    controller.dispose()
  })
})

describe('tooltip pointer retention', () => {
  afterEach(() => document.body.replaceChildren())

  it('drops retention immediately when sliding horizontally underneath a wide top tooltip', () => {
    const controller = tooltipController()
    const element = document.querySelector<HTMLElement>('.editor-test-hover')!
    element.getBoundingClientRect = () => new DOMRect(12, 132, 400, 60)
    const anchor = new DOMRect(60, 200, 40, 18)
    controller.show({ ...showOptions(), anchor, pointer: { clientX: 80, clientY: 209 } })

    expect(controller.pointerRetention(80, 209)).toBe('anchor')
    expect(controller.pointerRetention(140, 209)).toBe('none')
    expect(controller.shouldKeepForPointer(210, 209)).toBe(false)
    controller.dispose()
  })

  it('drops retention when moving horizontally underneath a wide bottom tooltip', () => {
    const controller = tooltipController()
    const element = document.querySelector<HTMLElement>('.editor-test-hover')!
    element.getBoundingClientRect = () => new DOMRect(12, 126, 400, 60)
    const anchor = new DOMRect(60, 100, 40, 18)
    controller.show({
      ...showOptions(),
      anchor,
      preferredPlacement: 'bottom',
      pointer: { clientX: 80, clientY: 109 },
    })

    expect(controller.pointerRetention(80, 109)).toBe('anchor')
    expect(controller.pointerRetention(150, 109)).toBe('none')
    controller.dispose()
  })

  it('keeps a diagonal corridor toward a wide tooltip and drops points outside the wedge', () => {
    const controller = tooltipController()
    const element = document.querySelector<HTMLElement>('.editor-test-hover')!
    element.getBoundingClientRect = () => new DOMRect(12, 132, 600, 60)
    const anchor = new DOMRect(60, 200, 40, 18)
    controller.show({ ...showOptions(), anchor })

    expect(controller.pointerRetention(95, 209)).toBe('anchor')
    // Diagonal move (+46 px right, -12.5 px up) into the gap approaches the tooltip.
    expect(controller.pointerRetention(141, 196.5)).toBe('approaching')
    // Lateral jitter at the same distance stays in the corridor without reporting new progress.
    expect(controller.pointerRetention(143, 196.5)).toBe('corridor')
    // Stepping outside the safe triangle toward a distant token drops retention immediately.
    expect(controller.pointerRetention(95, 209)).toBe('anchor')
    expect(controller.pointerRetention(230, 205)).toBe('none')
    controller.dispose()
  })

  it('keeps an approaching corridor when traveling straight or diagonally across the gap into the tooltip', () => {
    const controller = tooltipController()
    const element = document.querySelector<HTMLElement>('.editor-test-hover')!
    element.getBoundingClientRect = () => new DOMRect(12, 132, 400, 60)
    const anchor = new DOMRect(60, 200, 40, 18)
    controller.show({ ...showOptions(), anchor, pointer: { clientX: 80, clientY: 209 } })

    // First frame jumps straight from anchor into the 8px gap toward the tooltip.
    expect(controller.pointerRetention(80, 196)).toBe('approaching')
    expect(controller.pointerRetention(88, 193)).toBe('approaching')
    expect(controller.pointerRetention(92, 188)).toBe('locked')
    controller.dispose()
  })

  it('drops retention after turning away midway through the corridor', () => {
    const controller = tooltipController()
    const element = document.querySelector<HTMLElement>('.editor-test-hover')!
    element.getBoundingClientRect = () => new DOMRect(12, 132, 400, 60)
    const anchor = new DOMRect(60, 200, 40, 18)
    controller.show({ ...showOptions(), anchor })

    expect(controller.pointerRetention(80, 209)).toBe('anchor')
    expect(controller.pointerRetention(80, 196)).toBe('approaching')
    expect(controller.pointerRetention(150, 204)).toBe('none')
    expect(controller.pointerRetention(80, 194)).toBe('none')
    controller.dispose()
  })

  it('uses pointerAnchor when the visual anchor spans wider than the hovered token', () => {
    const controller = tooltipController()
    const element = document.querySelector<HTMLElement>('.editor-test-hover')!
    element.getBoundingClientRect = () => new DOMRect(12, 132, 400, 60)
    const diagnosticAnchor = new DOMRect(60, 200, 240, 18)
    const tokenAnchor = new DOMRect(60, 200, 40, 18)
    controller.show({
      ...showOptions(),
      anchor: diagnosticAnchor,
      pointerAnchor: tokenAnchor,
      pointer: { clientX: 80, clientY: 209 },
    })

    expect(controller.pointerRetention(80, 209)).toBe('anchor')
    expect(controller.pointerRetention(150, 209)).toBe('none')
    controller.dispose()
  })

  it('allows a 4px border grace after leaving the tooltip, then releases immediately beyond it', () => {
    const controller = tooltipController()
    const element = document.querySelector<HTMLElement>('.editor-test-hover')!
    element.getBoundingClientRect = () => new DOMRect(12, 132, 400, 60)
    const anchor = new DOMRect(60, 200, 40, 18)
    controller.show({ ...showOptions(), anchor })

    expect(controller.pointerRetention(120, 160)).toBe('locked')
    expect(controller.pointerRetention(120, 196)).toBe('corridor')
    expect(controller.pointerRetention(120, 204)).toBe('none')
    controller.dispose()
  })

  it('stays locked while keyboard-focused or dragging a resize sash regardless of pointer position', () => {
    const controller = tooltipController()
    const element = document.querySelector<HTMLElement>('.editor-test-hover')!
    element.getBoundingClientRect = () => new DOMRect(12, 132, 400, 60)
    controller.show({ ...showOptions(), anchor: new DOMRect(60, 200, 40, 18), focus: true })

    expect(controller.pointerRetention(500, 500)).toBe('locked')

    ;(document.activeElement as HTMLElement | null)?.blur()
    expect(controller.pointerRetention(500, 500)).toBe('none')

    const rightSash = element.querySelector<HTMLElement>('.editor-test-hover-resize-right')!
    rightSash.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 412, clientY: 160 }),
    )
    expect(controller.pointerRetention(500, 500)).toBe('locked')

    document.dispatchEvent(new PointerEvent('pointerup'))
    expect(controller.pointerRetention(500, 500)).toBe('none')
    controller.dispose()
  })
})

function tooltipController() {
  const editor = document.createElement('div')
  editor.getBoundingClientRect = () => new DOMRect(0, 0, 900, 700)
  document.body.append(editor)
  return createTooltipController({
    document,
    themeSource: editor,
    reentryElement: editor,
    classNamespace: 'test',
  })
}

function showOptions() {
  return {
    anchor: new DOMRect(100, 400, 20, 20),
    hoverText: 'hover text',
    theme: null,
    preferredPlacement: 'top' as const,
  }
}
