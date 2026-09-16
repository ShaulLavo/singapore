import { afterEach, describe, expect, it, vi } from 'vitest'

import { createTooltipController } from '../src/tooltip'

describe('tooltip content', () => {
  afterEach(() => document.body.replaceChildren())

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
    const related = section?.querySelector<HTMLAnchorElement>('a[role="button"]')
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
