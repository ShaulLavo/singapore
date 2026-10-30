// Scale probe: pastes a few thousand lines into an editor, by default one that grows to its
// content inside a scrolling page (`--scroll-mode virtualized` for a fixed-height editor), then scrolls fast and selects all, recording a Chromium trace for each
// phase. Run after building @singapore-editor/core and @singapore-editor/gutters:
//
//   node packages/editor/bench/contentModeProbe.mjs --lines 6000 [--output result.json]
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { chromium, firefox, webkit } from '@playwright/test'
import { build } from 'vite'
import { loadCorePackage } from '../../../examples/stress/core-package.mjs'

const { values } = parseArgs({
  options: {
    lines: { type: 'string', default: '6000' },
    output: { type: 'string' },
    trace: { type: 'string' },
    wrap: { type: 'boolean', default: true },
    gutter: { type: 'boolean', default: true },
    syntax: { type: 'boolean', default: false },
    'scroll-mode': { type: 'string', default: 'content' },
    'row-positioning': { type: 'string' },
    css: { type: 'string', default: '' },
    dpr: { type: 'string', default: '2' },
    profile: { type: 'string' },
    browser: { type: 'string', default: 'chromium' },
    // Build core from TypeScript source instead of dist, so CPU profiles carry real function names.
    source: { type: 'boolean', default: false },
    'phase-timeout': { type: 'string', default: '120000' },
  },
})
const lineCount = Number(values.lines)
const phaseTimeout = Number(values['phase-timeout'])
assert.ok(Number.isSafeInteger(lineCount) && lineCount > 0)

const repository = resolve(import.meta.dirname, '../../..')
const core = await loadCorePackage(resolve(import.meta.dirname, '..'))
const gutters = resolve(repository, 'packages/gutters/dist')
const coreAliases = values.source
  ? core.aliases.map(({ find, replacement }) => ({
      find,
      replacement: replacement.replace(/\/dist\//, '/src/').replace(/\.js$/, '.ts'),
    }))
  : core.aliases
const packages = resolve(repository, 'packages')
const aliases = coreAliases.concat([
  {
    find: '@singapore-editor/tree-sitter-languages',
    replacement: join(packages, 'tree-sitter-languages/dist/index.js'),
  },
  {
    find: '@singapore-editor/tree-sitter',
    replacement: join(packages, 'tree-sitter/dist/index.js'),
  },
  {
    find: '@singapore-editor/gutters/line-gutter.css',
    replacement: join(gutters, 'lineGutter.css'),
  },
  { find: '@singapore-editor/gutters/line-gutter', replacement: join(gutters, 'lineGutter.js') },
])

const text = await sourceText(lineCount)
const directory = await mkdtemp('/tmp/sg-content-')
const entry = resolve(import.meta.dirname, 'contentModePage.mjs')
await writeFile(
  join(directory, 'index.html'),
  '<!doctype html><html><head><style>body{margin:0;background:white;color:black}</style></head><body><script type="module" src="/entry.mjs"></script></body></html>',
)
await writeFile(
  join(directory, 'entry.mjs'),
  `import { bridge } from ${JSON.stringify(entry)}\nObject.assign(globalThis, { __probe: bridge })\n`,
)
await build({
  root: directory,
  configFile: false,
  logLevel: 'warn',
  resolve: { alias: aliases },
  build: {
    outDir: join(directory, 'dist'),
    minify: false,
    rollupOptions: { input: join(directory, 'index.html') },
  },
})

// localhost is a secure context, which the clipboard needs, in every engine.
const server = createServer(async (request, response) => {
  const { pathname } = new URL(request.url, 'http://localhost')
  const path = join(directory, 'dist', pathname === '/' ? 'index.html' : pathname)
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
  try {
    const body = await readFile(path)
    response.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' })
    response.end(body)
  } catch {
    response.writeHead(404).end()
  }
})
await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
const origin = `http://localhost:${server.address().port}/`
const engines = { chromium, firefox, webkit }
const engine = engines[values.browser]
assert.ok(engine, `Unknown browser ${values.browser}`)
// Traces and CPU profiles need the Chrome DevTools Protocol; other engines report wall and frame times.
const tracing = values.browser === 'chromium'
const browser = await engine.launch({
  headless: true,
  env: { ...process.env, TMPDIR: directory },
})
try {
  const context = await browser.newContext({
    viewport: { width: 1200, height: 900 },
    deviceScaleFactor: Number(values.dpr),
  })
  if (tracing) await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const page = await context.newPage()
  page.on('pageerror', (error) => console.error('pageerror', error))
  await page.goto(origin)
  await page.waitForFunction(() => globalThis.__probe)
  await page.evaluate((options) => globalThis.__probe.mount(options), {
    gutter: values.gutter,
    wrap: values.wrap,
    scrollMode: values['scroll-mode'],
    rowPositioning: values['row-positioning'],
    css: values.css,
    syntax: values.syntax,
  })
  // Wheel scrolling happens under the pointer, which makes the browser hit-test after each scroll.
  await page.mouse.move(600, 450)

  const cdp = tracing ? await context.newCDPSession(page) : null
  const events = []
  cdp?.on('Tracing.dataCollected', ({ value }) => events.push(...value))
  await cdp?.send('Tracing.start', {
    traceConfig: {
      includedCategories: [
        'devtools.timeline',
        'disabled-by-default-devtools.timeline',
        'blink.user_timing',
        'v8',
        'blink.console',
      ],
    },
    transferMode: 'ReportEvents',
  })

  const phases = {}
  const run = async (name, action) => {
    const profiling = tracing && values.profile === name
    if (profiling) {
      await cdp.send('Profiler.enable')
      await cdp.send('Profiler.setSamplingInterval', { interval: 200 })
      await cdp.send('Profiler.start')
    }
    await page.evaluate((mark) => performance.mark(mark), `probe:${name}:start`)
    const started = Date.now()
    const detail = await Promise.race([
      action(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${name} exceeded ${phaseTimeout}ms`)), phaseTimeout),
      ),
    ])
    const wallMs = Date.now() - started
    await page.evaluate((mark) => performance.mark(mark), `probe:${name}:end`)
    if (profiling) printProfile((await cdp.send('Profiler.stop')).profile)
    phases[name] = { wallMs, ...detail }
    if (name !== 'selectAll') console.log(name, JSON.stringify(detail))
  }

  await page.evaluate(() => globalThis.__probe.focus())
  // Chromium pastes through the real clipboard; other engines' automation cannot reach it, so they
  // receive the same text as a native insertion.
  if (tracing) await page.evaluate((value) => navigator.clipboard.writeText(value), text)
  await run('paste', async () => {
    if (tracing) await page.keyboard.press('Control+V')
    else await page.keyboard.insertText(text)
    await page.evaluate(() => globalThis.__probe.frames(2))
    return {
      textLength: await page.evaluate(() => globalThis.__probe.textLength()),
      mountedRows: await page.evaluate(() => globalThis.__probe.mountedRows()),
      domNodes: await page.evaluate(() => globalThis.__probe.domNodes()),
      documentHeight: await page.evaluate(() => globalThis.__probe.documentHeight()),
    }
  })
  if (values.syntax) {
    // Highlights arrive from a worker after the paste; wait until they are painted and settled.
    await page.waitForFunction(
      async () => {
        const probe = globalThis.__probe
        const before = probe.highlightRanges()
        await probe.frames(10)
        return before > 0 && probe.highlightRanges() === before
      },
      null,
      { timeout: 60_000, polling: 100 },
    )
    await page.evaluate(() => globalThis.__probe.frames(10))
    phases.paste.highlightRanges = await page.evaluate(() => globalThis.__probe.highlightRanges())
  }
  assert.ok(phases.paste.textLength >= text.length, 'Paste did not land')

  await run('scroll', () =>
    page.evaluate(() => globalThis.__probe.scroll({ framesCount: 120, step: 600 })),
  )
  await run('selectAll', async () => {
    await page.evaluate(() => globalThis.__probe.focus())
    await page.keyboard.press('Control+A')
    await page.evaluate(() => globalThis.__probe.frames(2))
    return { selection: await page.evaluate(() => globalThis.__probe.selection()) }
  })
  await run('scrollSelected', () =>
    page.evaluate(() => globalThis.__probe.scroll({ framesCount: 120, step: 600 })),
  )
  await run('collapse', async () => {
    await page.keyboard.press('ArrowRight')
    await page.evaluate(() => globalThis.__probe.frames(2))
    return {}
  })
  // A line inserted at the top moves every row below it.
  await page.keyboard.press('Control+Home')
  await page.evaluate(() => globalThis.__probe.frames(2))
  await run('typeTop', async () => {
    const keystrokes = []
    for (let index = 0; index < 10; index += 1) {
      const started = Date.now()
      await page.keyboard.press(index % 2 === 0 ? 'Enter' : 'x')
      await page.evaluate(() => globalThis.__probe.frames(1))
      keystrokes.push(Date.now() - started)
    }
    keystrokes.sort((a, b) => a - b)
    return { keystrokeMedianMs: keystrokes[5], keystrokeMaxMs: keystrokes.at(-1) }
  })

  let analysis = {}
  if (cdp) {
    const done = new Promise((resolveDone) => cdp.once('Tracing.tracingComplete', resolveDone))
    await cdp.send('Tracing.end')
    await done
    analysis = analyze(events)
  }
  for (const [name, summary] of Object.entries(analysis)) Object.assign(phases[name], summary)
  const result = {
    capturedAt: new Date().toISOString(),
    browser: browser.version(),
    engine: values.browser,
    lines: lineCount,
    characters: text.length,
    configuration: {
      wrap: values.wrap,
      gutter: values.gutter,
      syntax: values.syntax,
      scrollMode: values['scroll-mode'],
      rowPositioning: values['row-positioning'] ?? 'transform',
      css: values.css,
      dpr: Number(values.dpr),
    },
    phases,
  }
  for (const [name, phase] of Object.entries(phases)) {
    const cost = ['RunTask', 'Layout', 'UpdateLayoutTree', 'PrePaint', 'Paint', 'FunctionCall']
      .map((key) => `${key}=${phase[key]?.ms ?? '-'}ms/${phase[key]?.count ?? '-'}`)
      .join(' ')
    console.log(`${name.padEnd(15)} wall=${phase.wallMs}ms forced=${phase.forcedLayouts} ${cost}`)
    for (const { count, stack } of phase.forcedLayoutStacks ?? [])
      console.log(`    ${count}x ${stack}`)
  }
  if (values.output) await writeFile(resolve(values.output), JSON.stringify(result, null, 2) + '\n')
  if (values.trace) await writeFile(resolve(values.trace), JSON.stringify({ traceEvents: events }))
} finally {
  await browser.close()
  server.close()
  await rm(directory, { recursive: true, force: true })
}

// Real TypeScript from this repository, so wrapping and token density look like a code paste.
async function sourceText(count) {
  const files = [
    'packages/editor/src/virtualization/virtualizedTextViewRows.ts',
    'packages/editor/src/virtualization/virtualizedTextViewGeometry.ts',
    'packages/editor/src/editor/Editor.ts',
  ]
  let lines = []
  for (const file of files) {
    lines = lines.concat((await readFile(resolve(repository, file), 'utf8')).split('\n'))
    if (lines.length >= count) break
  }
  assert.ok(lines.length >= count, `Need ${count} source lines`)
  return lines.slice(0, count).join('\n')
}

function printProfile(profile) {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]))
  const parents = new Map()
  for (const node of profile.nodes)
    for (const child of node.children ?? []) parents.set(child, node.id)
  const self = new Map()
  const total = new Map()
  const deltas = profile.timeDeltas
  for (let index = 0; index < profile.samples.length; index += 1) {
    const time = deltas[index + 1] ?? 0
    const leaf = nodes.get(profile.samples[index])
    const name = frameName(leaf.callFrame)
    self.set(name, (self.get(name) ?? 0) + time)
    const seen = new Set()
    for (let id = leaf.id; id !== undefined; id = parents.get(id)) {
      const frame = frameName(nodes.get(id).callFrame)
      if (seen.has(frame)) continue
      seen.add(frame)
      total.set(frame, (total.get(frame) ?? 0) + time)
    }
  }
  const top = (map) =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, Number(process.env.PROBE_PROFILE_ROWS ?? 25))
      .map(([name, us]) => `    ${(us / 1000).toFixed(1).padStart(8)}ms ${name}`)
      .join('\n')
  console.log(`profile self:\n${top(self)}\nprofile total:\n${top(total)}`)
}

function frameName(frame) {
  const file = frame.url.split('/').at(-1)
  return `${frame.functionName || '(anonymous)'} ${file}:${frame.lineNumber + 1}`
}

function analyze(events) {
  const marks = new Map()
  for (const event of events) {
    if (event.cat === 'blink.user_timing' && event.name.startsWith('probe:'))
      marks.set(event.name, event.ts)
  }
  const threads = new Map()
  for (const event of events) {
    if (event.ph === 'M' && event.name === 'thread_name' && event.args.name === 'CrRendererMain')
      threads.set(`${event.pid}:${event.tid}`, 0)
  }
  for (const event of events) {
    const key = `${event.pid}:${event.tid}`
    if (threads.has(key)) threads.set(key, threads.get(key) + 1)
  }
  const main = [...threads.entries()].sort((a, b) => b[1] - a[1])[0][0]
  const mainEvents = events
    .filter((event) => `${event.pid}:${event.tid}` === main && event.ph === 'X')
    .sort((a, b) => a.ts - b.ts)
  const names = [
    'RunTask',
    'Layout',
    'UpdateLayoutTree',
    'PrePaint',
    'Paint',
    'Layerize',
    'Commit',
    'FunctionCall',
    'MajorGC',
    'MinorGC',
  ]
  const result = {}
  for (const [mark, start] of marks) {
    if (!mark.endsWith(':start')) continue
    const phase = mark.slice('probe:'.length, -':start'.length)
    const end = marks.get(`probe:${phase}:end`)
    const summary = {}
    for (const name of names) {
      let total = 0
      let count = 0
      let coveredUntil = -1
      for (const event of mainEvents) {
        if (event.name !== name || event.ts < start || event.ts > end) continue
        if (event.ts < coveredUntil) continue
        coveredUntil = event.ts + (event.dur ?? 0)
        total += event.dur ?? 0
        count += 1
      }
      summary[name] = { ms: Math.round(total / 100) / 10, count }
    }
    const forced = mainEvents.filter(
      (event) =>
        event.name === 'Layout' &&
        event.ts >= start &&
        event.ts <= end &&
        event.args?.beginData?.stackTrace?.length,
    )
    const stacks = new Map()
    for (const event of forced) {
      const key = event.args.beginData.stackTrace
        .slice(0, 6)
        .map((frame) => frame.functionName || '(anonymous)')
        .join(' <- ')
      stacks.set(key, (stacks.get(key) ?? 0) + 1)
    }
    summary.forcedLayouts = forced.length
    summary.forcedLayoutStacks = [...stacks.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([stack, count]) => ({ count, stack }))
    result[phase] = summary
  }
  return result
}
