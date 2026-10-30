import { Editor } from '@singapore-editor/core/editor'
import '@singapore-editor/core/style.css'
import { createLineGutterPlugin } from '@singapore-editor/gutters/line-gutter'
import '@singapore-editor/gutters/line-gutter.css'
import { createTreeSitterLanguagePlugin } from '@singapore-editor/tree-sitter'
import { TYPESCRIPT_TREE_SITTER_LANGUAGE } from '@singapore-editor/tree-sitter-languages'

let editor = null

function frames(count = 2) {
  return new Promise((resolve) => {
    const step = (left) => (left === 0 ? resolve() : requestAnimationFrame(() => step(left - 1)))
    step(count)
  })
}

// Mirrors the documentation site's live example: an editor that grows to its content inside a
// page that scrolls, with word wrap, a line gutter and, with `syntax`, tree-sitter TypeScript.
let scroller = null

async function mount({ gutter, wrap, scrollMode, rowPositioning, css, syntax }) {
  editor?.dispose()
  document.body.replaceChildren()
  const header = document.createElement('div')
  header.style.cssText = 'height:300px'
  header.textContent = 'Header'
  const host = document.createElement('div')
  host.id = 'editor'
  host.style.cssText =
    scrollMode === 'content'
      ? 'position:relative;width:900px'
      : 'position:relative;width:900px;height:800px;display:flex;overflow:hidden'
  const footer = document.createElement('div')
  footer.style.cssText = 'height:300px'
  const style = document.createElement('style')
  style.textContent = css ?? ''
  document.body.append(style, header, host, footer)
  editor = new Editor(host, {
    scrollMode,
    rowPositioning,
    wordWrap: wrap,
    wordWrapBreak: 'word',
    fontFamily: 'monospace',
    fontSize: 14,
    lineHeight: 22,
    tabSize: 2,
    gutterScroll: scrollMode === 'content' ? 'content' : undefined,
    plugins: (gutter ? [createLineGutterPlugin({ minWidth: 36 })] : []).concat(
      syntax ? [createTreeSitterLanguagePlugin([TYPESCRIPT_TREE_SITTER_LANGUAGE])] : [],
    ),
  })
  editor.setText('const start = 1\n', syntax ? { languageId: 'typescript' } : {})
  await frames(3)
  scroller = scrollMode === 'content' ? window : host.querySelector('[data-editor-scroll-mode]')
  if (!scroller) throw new Error('No editor scroll element')
}

function mountedRows() {
  return document.querySelectorAll('#editor .editor-virtualized-row').length
}

function domNodes() {
  return document.getElementsByTagName('*').length
}

async function scroll({ framesCount, step }) {
  const deltas = []
  let last = performance.now()
  scroller.scrollTo(0, 0)
  await frames(2)
  last = performance.now()
  for (let frame = 0; frame < framesCount; frame += 1) {
    scroller.scrollBy(0, step)
    await new Promise(requestAnimationFrame)
    const now = performance.now()
    deltas.push(now - last)
    last = now
  }
  deltas.sort((a, b) => a - b)
  const sum = deltas.reduce((total, delta) => total + delta, 0)
  return {
    frames: deltas.length,
    meanMs: sum / deltas.length,
    p50Ms: deltas[Math.floor(deltas.length * 0.5)],
    p95Ms: deltas[Math.floor(deltas.length * 0.95)],
    maxMs: deltas.at(-1),
  }
}

export const bridge = {
  mount,
  get editor() {
    return editor
  },
  frames,
  mountedRows,
  domNodes,
  scroll,
  focus() {
    document.querySelector('#editor textarea')?.focus()
  },
  textLength() {
    return editor.materializeFullText().length
  },
  selection() {
    return editor.getSelections()[0] ?? null
  },
  highlightRanges() {
    let count = 0
    for (const highlight of CSS.highlights.values()) count += highlight.size
    return count
  },
  documentHeight() {
    return document.documentElement.scrollHeight
  },
}
