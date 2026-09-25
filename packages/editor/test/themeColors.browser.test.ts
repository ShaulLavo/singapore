import { expect, it } from 'vitest'
import { Editor } from '../src/editor/Editor'
import '../../diff/src/theme'
import '../src/style.css'
import '../../diff/src/style.css'

it('inherits diff colors into recycled row elements and switches selection colors on blur', () => {
  const host = document.createElement('div')
  host.style.cssText = 'display:flex;width:400px;height:180px'
  document.body.append(host)
  const editor = new Editor(host, {
    defaultText: 'colored row',
    theme: {
      selectionColor: '#123456',
      inactiveSelectionColor: '#234567',
      colors: { 'diff.added.bg': '#abcdef' },
    },
  })
  try {
    const row = host.querySelector<HTMLElement>('.editor-virtualized-row')!
    row.classList.add('editor-diff-row', 'editor-diff-row-addition')
    expect(getComputedStyle(row).backgroundColor).toBe('rgb(171, 205, 239)')
    const selection = document.createElement('div')
    selection.className = 'editor-virtualized-selection-range'
    row.append(selection)
    editor.focus()
    expect(getComputedStyle(selection).backgroundColor).toBe('rgb(18, 52, 86)')
    const active = document.activeElement
    if (active instanceof HTMLElement) active.blur()
    expect(getComputedStyle(selection).backgroundColor).toBe('rgb(35, 69, 103)')
    editor.setTheme({ colors: { 'diff.added.bg': '#fedcba' } })
    expect(getComputedStyle(row).backgroundColor).toBe('rgb(254, 220, 186)')
  } finally {
    editor.dispose()
    host.remove()
  }
})
