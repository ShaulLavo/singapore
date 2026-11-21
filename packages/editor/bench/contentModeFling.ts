import { Editor } from '../src/editor/Editor'
import type { EditorToken } from '../src/tokens'
import '../src/style.css'

const rowHeight = 22
const rowCount = 6000
const host = document.querySelector<HTMLElement>('#editor')!
const status = document.querySelector<HTMLOutputElement>('#fling')!
const tokens: EditorToken[] = []
let offset = 0
const text = Array.from({ length: rowCount }, (_, index) => {
  const line = `const row${index} = ${index}; // Page-scroll probe`
  tokens.push({ start: offset, end: offset + 5, style: { color: '#a12583' } })
  tokens.push({
    start: offset + line.indexOf('//'),
    end: offset + line.length,
    style: { color: '#397634' },
  })
  offset += line.length + 1
  return line
}).join('\n')
const editor = new Editor(host, { height: 'content', lineHeight: rowHeight, wordWrap: true })
editor.setText(text, { tokens })

const results = { distance: 0, samples: 0, missingFrames: 0, peakMounted: 0 }
let previousScrollY = -1

function sample() {
  const scrollY = window.scrollY
  if (results.samples === 0 || previousScrollY !== scrollY) {
    previousScrollY = scrollY
    recordCoverage(scrollY)
  }
  requestAnimationFrame(sample)
}

function recordCoverage(scrollY: number): void {
  const viewport = window.visualViewport
  const box = host.getBoundingClientRect()
  const top = Math.max(0, (viewport?.offsetTop ?? 0) - box.top)
  const bottom = Math.min(
    box.height,
    (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight) - box.top,
  )
  const mounted = new Set(
    Array.from(host.querySelectorAll<HTMLElement>('[data-editor-virtual-row]'), (row) =>
      Number(row.dataset.editorVirtualRow),
    ),
  )
  if (!mounted.size || bottom <= top) {
    if (bottom > top && results.samples) results.missingFrames++
    return
  }

  results.distance = Math.max(results.distance, Math.round(scrollY))
  results.samples++
  results.peakMounted = Math.max(results.peakMounted, mounted.size)
  for (let index = Math.floor(top / rowHeight); index < Math.ceil(bottom / rowHeight); index++) {
    if (mounted.has(index)) continue
    results.missingFrames++
    break
  }
  status.dataset.results = JSON.stringify(results)
  status.textContent = `${results.distance}px, ${results.samples} samples, ${results.missingFrames} gaps, ${results.peakMounted} rows`
}

requestAnimationFrame(sample)
