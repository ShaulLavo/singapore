import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createVitest,
  parseCLI,
  type TestProject,
  type TestSpecification,
} from '../../packages/editor/node_modules/vitest/dist/node.js'
import {
  configurations,
  deferredConfigurations,
  fileRestrictions,
  scheduledStress,
  specialProjects,
  type Engine,
  type Policy,
} from './test-project-manifest.ts'

interface Project {
  directory: string
  config: string
  name: string
  engine: Engine
  policy: Policy
  files: string[]
}
type Invocation = Omit<Project, 'policy'> & { owner: string }
export interface Coverage {
  projects: Project[]
  invocations: Invocation[]
  errors: string[]
  workflow: string
}
interface Workspace {
  directory: string
  name: string
  scripts: Record<string, string>
}
interface Command {
  directory: string
  args: string[]
  owner: string
}
const root = fileURLToPath(new URL('../..', import.meta.url))
const discoveries = new Map<string, Promise<Omit<Project, 'policy'>[]>>()

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected an object')
  return Object.fromEntries(Object.entries(value))
}
function strings(value: unknown): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(record(value))) {
    if (typeof item !== 'string') throw new Error(`Expected string for ${key}`)
    result[key] = item
  }
  return result
}
function read(file: string): string {
  return readFileSync(resolve(root, file), 'utf8')
}
function workspaces(): Workspace[] {
  const directories = ['packages', 'examples']
    .flatMap((base) => readdirSync(resolve(root, base)).map((name) => `${base}/${name}`))
    .concat(['site'])
  return directories
    .filter((directory) => existsSync(resolve(root, directory, 'package.json')))
    .map((directory) => {
      const json = record(JSON.parse(read(`${directory}/package.json`)))
      if (typeof json.name !== 'string') throw new Error(`Unnamed workspace ${directory}`)
      return { directory, name: json.name, scripts: strings(json.scripts) }
    })
}
function tokens(command: string): string[] {
  if (/[;|`\n]/.test(command)) throw new Error(`Unsupported test command: ${command}`)
  return Array.from(command.matchAll(/'[^']*'|"[^"]*"|[^\s]+/g), ([token]) =>
    token.replace(/^['"]|['"]$/g, ''),
  )
}
function expand(
  workspace: Workspace,
  script: string,
  owner: string,
  seen: readonly string[] = [],
): Command[] {
  if (seen.includes(script))
    throw new Error(`Recursive test script: ${workspace.directory}/${script}`)
  const source = workspace.scripts[script]
  if (!source) throw new Error(`Missing script: ${workspace.directory}/${script}`)
  return source.split(' && ').flatMap((part) => {
    const args = tokens(part)
    if (args[0] === 'bun' && args[1] === 'run')
      return expand(workspace, args[2], `${owner} -> ${script}`, seen.concat([script]))
    const offset = args[0] === 'bun' && args[1] === '--bun' ? 2 : 0
    if (args[offset] === 'vitest' && args[offset + 1] === 'run')
      return [
        {
          directory: workspace.directory,
          args: args.slice(offset + 2),
          owner: `${owner} -> ${script}`,
        },
      ]
    if (script === 'bidi:check' && part === 'bun scripts/generateBidiClass.mjs --check') return []
    throw new Error(`Unsupported test script: ${workspace.directory}/${script}: ${part}`)
  })
}
function selectedWorkspaces(args: string[], all: Workspace[]): Workspace[] {
  if (args.some((arg) => arg !== '--' && arg !== '--concurrency=1' && !arg.startsWith('--filter=')))
    throw new Error(`Unsupported Turbo test arguments: ${args.join(' ')}`)
  const filters = args.filter((arg) => arg.startsWith('--filter=')).map((arg) => arg.slice(9))
  if (!filters.length) throw new Error('CI test group must explicitly select workspaces')
  for (const filter of filters) {
    if (!all.some((workspace) => workspace.name === filter.replace(/^!/, '')))
      throw new Error(`Unknown workspace filter: ${filter}`)
  }
  const positive = filters.filter((filter) => !filter.startsWith('!'))
  const selected = all.filter(
    (workspace) =>
      (!positive.length || positive.includes(workspace.name)) &&
      !filters.includes(`!${workspace.name}`),
  )
  if (!selected.length) throw new Error('Empty CI workspace selection')
  if (selected.length > 1 && !args.includes('--concurrency=1'))
    throw new Error('CI package groups must use --concurrency=1')
  return selected
}
function workflowCommands(source: string, all: Workspace[]): Command[] {
  const jobs = record(record(Bun.YAML.parse(source)).jobs)
  return Object.entries(jobs).flatMap(([job, value]) => {
    const steps = record(value).steps
    if (!Array.isArray(steps)) throw new Error(`Missing steps in ${job}`)
    return steps.flatMap((value, index) => stepCommands(record(value), `${job}/${index}`, all))
  })
}
function stepCommands(step: Record<string, unknown>, owner: string, all: Workspace[]): Command[] {
  if (typeof step.run !== 'string') return []
  return step.run
    .trim()
    .split('\n')
    .flatMap((line) => {
      if (
        !/\bbun run (?:test(?::browser)?(?: |$)|--cwd \S+ test(?::(?:browser|editor|server))?(?: |$))/.test(
          line,
        )
      )
        return ignoreSetupCommand(line)
      if (step.if && step.if !== '${{ !cancelled() }}')
        throw new Error(`Conditional test selection: ${owner}`)
      if (step['working-directory']) throw new Error(`Unsupported test working-directory: ${owner}`)
      const args = tokens(line)
      if (args[2] === '--cwd') return directCommand(args, owner, all)
      const script = args[2]
      const rootScripts = strings(record(JSON.parse(read('package.json'))).scripts)
      if (rootScripts[script] !== `turbo ${script}`)
        throw new Error(`Root ${script} must route through turbo ${script}`)
      return selectedWorkspaces(args.slice(3), all).flatMap((workspace) =>
        expand(workspace, script, owner),
      )
    })
}
function ignoreSetupCommand(line: string): Command[] {
  const testCommand = /\bvitest\b|\bbun test\b|\bbun run (?:--cwd \S+ )?test[^ ]*/.test(line)
  if (testCommand && line.trim() !== 'bun run test:ci')
    throw new Error(`Unsupported CI test command: ${line}`)
  return []
}
function directCommand(args: string[], owner: string, all: Workspace[]): Command[] {
  const workspace = all.find((workspace) => workspace.directory === args[3])
  if (!workspace || args.length !== 5)
    throw new Error(`Unsupported direct test selection: ${args.join(' ')}`)
  return expand(workspace, args[4], owner)
}
function engine(value: string | undefined): Engine {
  if (value === undefined) return 'node'
  if (value === 'chromium' || value === 'firefox' || value === 'webkit') return value
  throw new Error(`Unknown browser engine: ${value}`)
}
async function discover(directory: string, args: string[]): Promise<Omit<Project, 'policy'>[]> {
  const key = JSON.stringify([directory, args])
  const previous = discoveries.get(key)
  if (previous) return previous
  const pending = discoverFresh(directory, args)
  discoveries.set(key, pending)
  return pending
}
async function discoverFresh(
  directory: string,
  args: string[],
): Promise<Omit<Project, 'policy'>[]> {
  const { options, filter } = parseCLI(['vitest', 'run'].concat(args))
  const config =
    typeof options.config === 'string'
      ? options.config
      : existsSync(resolve(root, directory, 'vitest.config.ts'))
        ? 'vitest.config.ts'
        : ''
  const vitest = await createVitest({
    ...options,
    root: resolve(root, directory),
    config: config || false,
    watch: false,
  })
  try {
    const specifications = await vitest.globTestSpecifications(filter)
    return vitest.projects.map((project) =>
      describeProject(project, directory, config, specifications),
    )
  } finally {
    await vitest.close()
  }
}
function describeProject(
  project: TestProject,
  directory: string,
  config: string,
  specifications: TestSpecification[],
): Omit<Project, 'policy'> {
  return {
    directory,
    config,
    name: project.name,
    engine: engine(project.config.browser?.enabled ? project.config.browser.name : undefined),
    files: specifications
      .filter((spec) => spec.project === project)
      .map((spec) => relative(resolve(root, directory), spec.moduleId))
      .sort(),
  }
}
function projectKey(project: Omit<Project, 'policy' | 'files'>): string {
  return `${project.directory}/${project.config}:${project.name || 'default'}:${project.engine}`
}
function checkFileRestrictions(projects: Project[]): string[] {
  return fileRestrictions.flatMap((rule) => {
    const files = Array.from(
      new Bun.Glob(rule.pattern).scanSync({ cwd: resolve(root, rule.directory), onlyFiles: true }),
    ).sort()
    const selected = projects
      .filter((project) => project.directory === rule.directory && project.engine === rule.engine)
      .flatMap((project) => project.files)
      .sort()
    if (JSON.stringify(files) === JSON.stringify(selected)) return []
    return [
      `Changed file/engine restriction ${rule.directory}/${rule.engine}: expected ${files.join(', ')}, found ${selected.join(', ')}`,
    ]
  })
}
async function inventory(): Promise<{ projects: Project[]; errors: string[] }> {
  const projects: Project[] = []
  const errors: string[] = []
  for (const config of configurations) {
    const args = (config.config ? ['--config', config.config] : []).concat(config.args ?? [])
    const discovered = await discover(config.directory, args)
    const expected = config.projects.map(([name, engine]) =>
      projectKey({ ...config, name, engine }),
    )
    admitConfiguration(config, discovered, expected, projects, errors)
  }
  return {
    projects: classifyNativeProfile(projects),
    errors: errors.concat(checkFileRestrictions(projects)),
  }
}
function admitConfiguration(
  config: (typeof configurations)[number],
  discovered: Omit<Project, 'policy'>[],
  expected: string[],
  projects: Project[],
  errors: string[],
): void {
  for (const project of discovered) {
    if (!expected.includes(projectKey(project)))
      errors.push(`Undeclared project ${projectKey(project)}`)
    const policy = specialProjects[`${project.directory}/${project.name}`] ??
      config.policy ?? { kind: 'required' }
    projects.push({ ...project, policy })
  }
  for (const key of expected) {
    if (!discovered.some((project) => projectKey(project) === key))
      errors.push(`Missing configured project ${key}`)
  }
}
function classifyNativeProfile(projects: Project[]): Project[] {
  return projects.flatMap((project) => {
    if (project.directory !== 'packages/tree-sitter' || project.engine !== 'chromium')
      return [project]
    const diagnostic = 'test/native-profile.browser.test.ts'
    return [
      { ...project, files: project.files.filter((file) => file !== diagnostic) },
      {
        ...project,
        files: [diagnostic],
        policy: {
          kind: 'diagnostic',
          owner: 'manual native-profile',
          reason: 'Five-run native parser timing diagnostic, not ordinary correctness.',
        },
      },
    ]
  })
}
function unclassifiedConfigurations(
  directory: string,
  configs: string[],
  declared: readonly { directory: string; config: string }[],
): string[] {
  return configs
    .filter(
      (config) => !declared.some((item) => item.directory === directory && item.config === config),
    )
    .map((config) => `Unclassified configuration ${directory}/${config}`)
}
function checkDispositions(all: Workspace[]): string[] {
  const declared = configurations.concat(
    deferredConfigurations.map((config) => ({ ...config, projects: [] })),
  )
  const errors: string[] = []
  for (const workspace of all) {
    const configs = readdirSync(resolve(root, workspace.directory)).filter((name) =>
      /^vitest.*\.config\.ts$/.test(name),
    )
    errors.push(...unclassifiedConfigurations(workspace.directory, configs, declared))
  }
  for (const config of deferredConfigurations) {
    const workspace = all.find((workspace) => workspace.directory === config.directory)
    if (
      !existsSync(resolve(root, config.directory, config.config)) ||
      !workspace?.scripts[config.script]?.includes(config.config)
    )
      errors.push(`Missing diagnostic owner ${config.directory}/${config.script}`)
  }
  const collaboration = read('.github/workflows/collaboration.yml')
  for (const kind of ['browser', 'editor', 'server']) {
    if (!collaboration.includes(`run: bun run --cwd packages/collaboration test:${kind}`))
      errors.push(`Missing scheduled owner collaboration/test:${kind}`)
    const workspace = all.find((item) => item.directory === 'packages/collaboration')
    if (!workspace?.scripts[`test:${kind}`]?.includes(`vitest.${kind}.config.ts`))
      errors.push(`Changed scheduled project collaboration/test:${kind}`)
  }
  for (const schedule of scheduledStress) {
    const source = read(`.github/workflows/${schedule.file}`)
    const events = record(record(Bun.YAML.parse(source)).on)
    if (
      !events.schedule ||
      !('workflow_dispatch' in events) ||
      'pull_request' in events ||
      'push' in events
    )
      errors.push(`Changed schedule-only admission ${schedule.file}`)
    errors.push(
      ...schedule.flags
        .filter((flag) => !source.includes(flag))
        .map((flag) => `Missing long-run control ${schedule.file}/${flag}`),
    )
  }
  return errors
}
export async function readCoverage(
  overrides: { workflow?: string; scripts?: Record<string, Record<string, string>> } = {},
): Promise<Coverage> {
  const workflow = overrides.workflow ?? read('.github/workflows/ci.yml')
  const all = workspaces().map((workspace) => ({
    ...workspace,
    scripts: { ...workspace.scripts, ...overrides.scripts?.[workspace.directory] },
  }))
  const { projects, errors } = await inventory()
  const invocations: Invocation[] = []
  for (const command of workflowCommands(workflow, all)) {
    const selection = await discover(command.directory, command.args)
    for (const project of selection) invocations.push({ ...project, owner: command.owner })
  }
  return { projects, invocations, errors: errors.concat(checkDispositions(all)), workflow }
}
export function checkCoverage(coverage: Coverage): string[] {
  const errors = coverage.errors.slice()
  for (const invocation of coverage.invocations)
    checkInvocation(invocation, coverage.projects, errors)
  for (const project of coverage.projects) {
    if (!project.files.length) errors.push(`empty project ${projectKey(project)}`)
    for (const file of project.files) checkFile(project, file, coverage.invocations, errors)
  }
  return errors
}
function checkInvocation(invocation: Invocation, inventory: Project[], errors: string[]): void {
  if (!invocation.files.length)
    errors.push(`empty invocation ${invocation.owner}/${projectKey(invocation)}`)
  const projects = inventory.filter((project) => projectKey(project) === projectKey(invocation))
  if (!projects.length) errors.push(`unknown project ${projectKey(invocation)}`)
  for (const file of invocation.files) {
    if (!projects.some((project) => project.files.includes(file)))
      errors.push(`unknown file/engine selection ${projectKey(invocation)}/${file}`)
  }
}
export function describeCoverage(coverage: Coverage): string {
  return coverage.projects
    .map((project) => {
      const policy =
        project.policy.kind === 'required'
          ? 'ordinary CI'
          : `${project.policy.owner}: ${project.policy.reason}`
      const details =
        project.directory === 'packages/typescript-lsp' ||
        project.directory === 'packages/tree-sitter'
          ? `\n  ${project.files.join('\n  ')}`
          : ''
      return `${project.policy.kind.padEnd(10)} ${projectKey(project)}: ${project.files.length} files, ${policy}${details}`
    })
    .join('\n')
}
function checkFile(
  project: Project,
  file: string,
  invocations: Invocation[],
  errors: string[],
): void {
  const owners = invocations.filter(
    (invocation) =>
      projectKey(invocation) === projectKey(project) && invocation.files.includes(file),
  )
  if (project.policy.kind !== 'required') {
    if (owners.length)
      errors.push(`${projectKey(project)}/${file} is not ordinary CI: ${project.policy.reason}`)
    return
  }
  if (!owners.length) errors.push(`unowned ${projectKey(project)}/${file}`)
  if (owners.length > 1)
    errors.push(
      `${owners.length} owners for ${projectKey(project)}/${file}: ${owners.map((owner) => owner.owner).join(', ')}`,
    )
}

if (import.meta.main) {
  const coverage = await readCoverage()
  console.log(describeCoverage(coverage))
  const errors = checkCoverage(coverage)
  if (errors.length) {
    console.error(errors.join('\n'))
    process.exitCode = 1
  } else console.log('CI test ownership: every required project/file has exactly one owner')
}
