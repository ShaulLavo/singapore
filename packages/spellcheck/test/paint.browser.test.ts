import { afterEach, expect, it } from 'vitest'
import { createSpellcheckPlugin } from '../src/plugin'
import { disposeEditors, mountEditor, redInk, rowPixels, spellingInk, until } from './browserEditor'
import { FakeChecker } from './fakeChecker'

afterEach(disposeEditors)

it('draws a wavy line in the spelling colour under a misspelled word, over its syntax colour', async () => {
  const checker = new FakeChecker(['befor'])
  const { host, editor, feature } = mountEditor([createSpellcheckPlugin({ service: checker })])
  const text = 'MMM befor'
  editor.setText(text, { tokens: [{ start: 0, end: text.length, style: { color: '#ff0000' } }] })
  await until(() => checker.checks.length > 0)
  const control = await rowPixels(host.id)
  expect(spellingInk(control)).toBe(0)
  expect(redInk(control)).toBeGreaterThan(20)

  await checker.answerAll()
  await until(() => feature().issueAt(6) !== null)
  await new Promise((resolve) => requestAnimationFrame(resolve))
  const painted = await rowPixels(host.id)

  expect(spellingInk(painted)).toBeGreaterThan(20)
  expect(redInk(painted)).toBeGreaterThan(redInk(control) * 0.9)
})
