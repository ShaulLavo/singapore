import { Editor } from '@singapore-editor/core/editor'
import { check, checkCleanup, editedText, initialText } from './contract'

type KeyEdge = {
  type: string
  key: string
  trusted: boolean
  targetIsInput: boolean
}

async function painted(): Promise<void> {
  await document.fonts.ready
  await new Promise(requestAnimationFrame)
  await new Promise(requestAnimationFrame)
}

export function installWorkload() {
  let mounted: { editor: Editor; host: HTMLElement } | null = null
  const events: KeyEdge[] = []
  const listeners = new AbortController()
  const observe = (event: KeyboardEvent) => {
    events.push({
      type: event.type,
      key: event.key,
      trusted: event.isTrusted,
      targetIsInput: event.target === mounted?.host.querySelector('.editor-virtualized-input'),
    })
  }
  document.addEventListener('keydown', observe, { capture: true, signal: listeners.signal })
  document.addEventListener('keyup', observe, { capture: true, signal: listeners.signal })

  function dispose() {
    try {
      mounted?.editor.dispose()
      check(!mounted?.host.querySelector('.editor-virtualized-input'), 'Dispose left an input')
      check(!mounted?.host.querySelector('.editor-virtualized-row'), 'Dispose left mounted rows')
    } finally {
      mounted?.host.remove()
      mounted = null
      listeners.abort()
    }
    const cleanup = {
      inputs: document.querySelectorAll('.editor-virtualized-input').length,
      rows: document.querySelectorAll('.editor-virtualized-row').length,
      hosts: document.querySelectorAll('[data-singapore-test]').length,
      listeners: listeners.signal.aborted ? 0 : 2,
    }
    checkCleanup(cleanup)
    return cleanup
  }

  function mount() {
    check(mounted === null, 'An editor is already mounted')
    const host = document.createElement('main')
    host.dataset.singaporeTest = ''
    host.style.cssText = 'position:relative;display:flex;height:240px;width:100%;'
    document.body.append(host)
    const editor = new Editor(host)
    mounted = { host, editor }
    return mounted
  }

  async function api() {
    const { editor, host } = mount()
    try {
      editor.setText(initialText)
      await painted()
      const initial = editor.materializeFullText()
      const initiallyPainted = host.textContent?.includes('alpha') === true
      editor.setSelection(6, 11)
      const selection = editor.getSelections()[0]
      check(selection, 'Missing API selection')
      const selected = initial.slice(selection.anchorOffset, selection.headOffset)
      editor.edit({ from: 6, to: 11, text: 'Safari' })
      await painted()
      const edited = editor.materializeFullText()
      const editPainted = host.textContent?.includes('Safari') === true
      check(editor.dispatchCommand('undo'), 'API undo was not handled')
      const undone = editor.materializeFullText()
      check(editor.dispatchCommand('redo'), 'API redo was not handled')
      const redone = editor.materializeFullText()
      check(redone === editedText, 'API redo text differs')
      const text = Array.from({ length: 200 }, (_, index) => `native-reveal-${index}`).join('\n')
      editor.setText(text)
      editor.setSelection(text.length, text.length, { reveal: true })
      await painted()
      const target = Array.from(host.querySelectorAll('.editor-virtualized-row')).find((row) =>
        row.textContent?.includes('native-reveal-199'),
      )
      const bounds = target?.getBoundingClientRect()
      const viewport = host.getBoundingClientRect()
      const reveal = {
        top: editor.getScrollPosition().top,
        offset: editor.getSelections()[0]?.headOffset,
        length: text.length,
        visible: !!bounds && bounds.top >= viewport.top && bounds.bottom <= viewport.bottom,
      }
      return {
        channel: 'api',
        initial,
        painted: initiallyPainted,
        selected,
        edited,
        editPainted,
        undone,
        redone,
        reveal,
        cleanup: dispose(),
      }
    } finally {
      dispose()
    }
  }

  async function setupKeys(): Promise<void> {
    const { editor } = mount()
    editor.setText(initialText)
    editor.setSelection(8)
    editor.focus()
    await painted()
    events.length = 0
  }

  function snapshot() {
    check(mounted, 'Key editor is not mounted')
    const selection = mounted.editor.getSelections()[0]
    return {
      text: mounted.editor.materializeFullText(),
      anchor: selection?.anchorOffset,
      head: selection?.headOffset,
      focused: document.activeElement === mounted.host.querySelector('.editor-virtualized-input'),
      events: events.slice(),
    }
  }

  return { api, setupKeys, snapshot, clearEvents: () => (events.length = 0), dispose }
}
