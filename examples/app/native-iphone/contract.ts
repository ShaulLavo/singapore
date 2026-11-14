export const apiCase = 'simple-editor-api'
export const keysCase = 'webdriver-four-keys'
export const caseIds = [apiCase, keysCase]
export const initialText = 'alpha\nbravo\ncharlie'
export const editedText = 'alpha\nSafari\ncharlie'

export const keySteps = [
  { key: 'ArrowRight', text: initialText, offset: 9 },
  { key: 'Home', text: initialText, offset: 6 },
  { key: 'ArrowUp', text: initialText, offset: 0 },
  { key: 'Enter', text: `\n${initialText}`, offset: 1 },
] as const

export function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

export function record(value: unknown): Record<string, unknown> {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), 'Expected object')
  return Object.fromEntries(Object.entries(value))
}

export function checkCleanup(value: unknown): void {
  const cleanup = record(value)
  check(cleanup.inputs === 0 && cleanup.rows === 0 && cleanup.hosts === 0, 'Editor DOM remains')
  check(cleanup.listeners === 0, 'Workload listeners remain')
}

export function checkApi(value: unknown): void {
  const result = record(value)
  check(result.channel === 'api', 'API case must identify browser evaluation')
  check(result.initial === initialText && result.painted === true, 'Initial text did not paint')
  check(result.selected === 'bravo', 'API selection did not resolve selected text')
  check(result.edited === editedText && result.editPainted === true, 'API edit did not paint')
  check(result.undone === initialText && result.redone === editedText, 'API undo or redo failed')
  const reveal = record(result.reveal)
  check(typeof reveal.top === 'number' && reveal.top > 0, 'API reveal did not scroll')
  check(reveal.visible === true && reveal.offset === reveal.length, 'API reveal missed the caret')
  checkCleanup(result.cleanup)
}

export function checkKeySnapshot(value: unknown, step: (typeof keySteps)[number]): void {
  const snapshot = record(value)
  check(snapshot.text === step.text, `${step.key} text effect differs`)
  check(
    snapshot.anchor === step.offset && snapshot.head === step.offset,
    `${step.key} caret differs`,
  )
  check(snapshot.focused === true, `${step.key} lost editor input focus`)
  const events = snapshot.events
  check(Array.isArray(events) && events.length === 2, `${step.key} needs both key edges`)
  for (const [index, value] of events.entries()) {
    const event = record(value)
    check(event.type === (index === 0 ? 'keydown' : 'keyup'), `${step.key} edge order differs`)
    check(event.key === step.key && event.trusted === true, `${step.key} needs trusted key edges`)
    check(event.targetIsInput === true, `${step.key} targeted another element`)
  }
}

export function checkCaseResult(id: string, value: unknown): void {
  const result = record(value)
  const body = record(result.body)
  const teardown = record(result.teardown)
  check(body.status === 'pass' && teardown.status === 'pass', 'Case or teardown failed')
  checkCleanup(teardown.result)
  if (id === apiCase) return checkApi(body.result)
  check(id === keysCase, 'Unknown case')
  const keys = record(body.result)
  check(keys.channel === 'webdriver-keys', 'Key case must identify WebDriver input')
  check(Array.isArray(keys.steps) && keys.steps.length === keySteps.length, 'Missing key results')
  for (const [index, step] of keySteps.entries()) checkKeySnapshot(keys.steps[index], step)
}
