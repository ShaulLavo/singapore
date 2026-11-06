export type Engine = 'node' | 'chromium' | 'firefox' | 'webkit'
export type Policy =
  | { kind: 'required' }
  | { kind: 'scheduled' | 'diagnostic'; owner: string; reason: string }

export interface Configuration {
  directory: string
  config: string
  projects: readonly (readonly [name: string, engine: Engine])[]
  args?: readonly string[]
  policy?: Policy
}

const node = [['', 'node']] satisfies Configuration['projects']
const browser = [['chromium', 'chromium']] satisfies Configuration['projects']
const domBrowser = [
  ['dom', 'node'],
  ['browser (chromium)', 'chromium'],
] satisfies Configuration['projects']
const engines = [
  ['chromium', 'chromium'],
  ['firefox', 'firefox'],
  ['webkit', 'webkit'],
] satisfies Configuration['projects']
const ordinary = (
  directory: string,
  projects: Configuration['projects'] = node,
): Configuration => ({ directory, config: 'vitest.config.ts', projects })

const defaultConfigurations: Configuration[] = [
  'diff',
  'file-animation',
  'gutters',
  'lsp',
  'lsp-plugin',
  'panes',
  'solid',
  'textbuffer',
]
  .map((name) => ordinary(`packages/${name}`))
  .concat(
    ['find', 'plugin-ui', 'react', 'scope-lines'].map((name) =>
      ordinary(`packages/${name}`, domBrowser),
    ),
  )

export const configurations: readonly Configuration[] = defaultConfigurations.concat(
  [
    { directory: 'packages/paged', config: '', projects: node },
    { directory: 'packages/tree-sitter-languages', config: '', projects: node },
    { directory: 'examples/stress', config: '', projects: node },
    ordinary('site'),
    { ...ordinary('examples/app', browser), args: ['--browser.enabled', '--browser.headless'] },
    ordinary('packages/markdown', [
      ['node', 'node'],
      ['dom', 'node'],
    ]),
    ordinary('packages/collab', [
      ['reference', 'node'],
      ['textbuffer', 'node'],
    ]),
    ordinary('packages/collaboration', [['node', 'node']]),
    ordinary('packages/editor', [
      ['node', 'node'],
      ['dom', 'node'],
      ['browser (chromium)', 'chromium'],
      ['scroll-firefox', 'firefox'],
      ['scroll-webkit', 'webkit'],
      ['content-layout-chromium', 'chromium'],
      ['content-layout-firefox', 'firefox'],
      ['content-layout-webkit', 'webkit'],
      ['content-layout-iphone', 'webkit'],
      ['wrap-layout-chromium', 'chromium'],
      ['wrap-layout-firefox', 'firefox'],
      ['wrap-layout-iphone-webkit', 'webkit'],
      ['paint-origin-chromium', 'chromium'],
      ['paint-origin-firefox', 'firefox'],
      ['paint-origin-webkit', 'webkit'],
      ['highlight-paint-chromium', 'chromium'],
      ['highlight-paint-firefox', 'firefox'],
      ['highlight-paint-webkit', 'webkit'],
    ]),
    ordinary('packages/highlighting', [
      ['node', 'node'],
      ['browser (chromium)', 'chromium'],
      ['engines-firefox', 'firefox'],
      ['engines-webkit', 'webkit'],
    ]),
    ordinary('packages/spellcheck', [
      ['node', 'node'],
      ['dom', 'node'],
      ['browser (chromium)', 'chromium'],
      ['typing-cost (chromium)', 'chromium'],
      ['engines-chromium', 'chromium'],
      ['engines-firefox', 'firefox'],
      ['engines-webkit', 'webkit'],
    ]),
    ordinary('packages/minimap'),
    {
      ...ordinary('packages/minimap', browser),
      args: ['--browser.enabled', '--browser.headless', '.browser.test.ts'],
    },
    { ...ordinary('packages/tree-sitter'), args: ['--exclude', '**/*.browser.test.ts'] },
    {
      ...ordinary('packages/tree-sitter', browser),
      args: ['--browser.enabled', '--browser.headless', '.browser.test.ts'],
    },
    ordinary('packages/typescript-lsp'),
    { directory: 'packages/typescript-lsp', config: 'vitest.browser.config.ts', projects: engines },
  ],
  ['browser', 'editor', 'server'].map((kind): Configuration => ({
    directory: 'packages/collaboration',
    config: `vitest.${kind}.config.ts`,
    projects: kind === 'server' ? node : browser,
    policy: {
      kind: 'scheduled',
      owner: `.github/workflows/collaboration.yml#test:${kind}`,
      reason:
        'Native WebRTC, broker and editor-session qualification runs on schedule or dispatch.',
    },
  })),
)

export const deferredConfigurations = [
  {
    directory: 'packages/editor',
    config: 'vitest.snapshot.config.ts',
    script: 'bench:paint',
    reason: 'Full-document capture and first-frame costs are dedicated qualification.',
  },
  {
    directory: 'packages/tree-sitter',
    config: 'vitest.memory.config.ts',
    script: 'test:memory:browser',
    reason: 'Cross-engine memory qualification is a dedicated cost run.',
  },
  {
    directory: 'packages/collaboration',
    config: 'vitest.cost.config.ts',
    script: 'bench:merge-review',
    reason: 'Merge-review cost experiment.',
  },
  {
    directory: 'packages/collaboration',
    config: 'vitest.review-cost.config.ts',
    script: 'bench:review-runtime',
    reason: 'Browser review-runtime cost experiment.',
  },
  {
    directory: 'site',
    config: 'vitest.browser.config.ts',
    script: 'test:browser',
    reason: 'Deployed-site review runs separately from ordinary package tests.',
  },
] satisfies readonly { directory: string; config: string; script: string; reason: string }[]

export const specialProjects: Readonly<Record<string, Policy>> = {
  'packages/spellcheck/typing-cost (chromium)': {
    kind: 'diagnostic',
    owner: 'bench:typing',
    reason: 'Typing cost is measured separately from correctness.',
  },
  'packages/highlighting/engines-firefox': {
    kind: 'diagnostic',
    owner: 'test:engines',
    reason: 'Additional engine qualification is explicitly opt-in.',
  },
  'packages/highlighting/engines-webkit': {
    kind: 'diagnostic',
    owner: 'test:engines',
    reason: 'Additional engine qualification is explicitly opt-in.',
  },
}

export const scheduledStress = [
  {
    file: 'collaboration.yml',
    flags: ['COLLABORATION_LONG_RUN', "inputs.long_run && '1' || '0'", '10,000'],
  },
  {
    file: 'collab-stress.yml',
    flags: ['COLLAB_STRESS', 'COLLAB_STRESS_SHARED', 'COLLAB_STRESS_SHARD', '10,000'],
  },
]

export const fileRestrictions = [
  {
    directory: 'packages/typescript-lsp',
    engine: 'chromium',
    pattern: 'test/**/*.browser.test.ts',
  },
  {
    directory: 'packages/typescript-lsp',
    engine: 'firefox',
    pattern: 'test/parity.browser.test.ts',
  },
  {
    directory: 'packages/typescript-lsp',
    engine: 'webkit',
    pattern: 'test/parity.browser.test.ts',
  },
  { directory: 'packages/tree-sitter', engine: 'chromium', pattern: 'test/**/*.browser.test.ts' },
] satisfies readonly { directory: string; engine: Engine; pattern: string }[]
