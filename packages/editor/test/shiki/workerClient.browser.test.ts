import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createDocumentTextSnapshot,
  createPieceTableSnapshot,
  type DocumentSessionChange,
} from '../../src'

import {
  createShikiWorkerOwner,
  type ShikiResolvedRegistrations,
  type ShikiWorkerOwner,
} from '../../src/shiki'

const createChange = (
  text: string,
  ...edits: readonly { from: number; to: number; text: string }[]
) =>
  ((snapshot = createPieceTableSnapshot(text)) => ({
    kind: 'edit',
    edits,
    transaction: null,
    textSnapshot: createDocumentTextSnapshot(snapshot, text),
    snapshot,
    selections: { selections: [], normalized: true },
    timings: [],
    canUndo: false,
    canRedo: false,
    isDirty: true,
    logicalRevisionCount: 1,
    logicalRevisionScope: null,
  }))() satisfies DocumentSessionChange

describe.skipIf(typeof Worker === 'undefined')('Shiki worker highlighter', () => {
  let workerOwner: ShikiWorkerOwner

  /** What a session opened directly on `text` reports, to compare a spliced answer against. */
  async function fullTokens(text: string) {
    const fresh = workerOwner.createSession({
      documentId: 'fresh.ts',
      languageId: 'typescript',
      lang: 'typescript',
      theme: 'github-dark',
      registrations: resolveRegistrations(),
      fullText: text,
      snapshot: createPieceTableSnapshot(text),
    })
    const result = await fresh!.refresh(createPieceTableSnapshot(text), text)
    fresh!.dispose()
    return result.tokens.toTokens()
  }

  beforeEach(() => {
    workerOwner = createShikiWorkerOwner()
  })

  afterEach(async () => {
    await workerOwner.dispose()
  })

  it('recolors the same worker document and keeps subsequent edits incremental', async () => {
    const dark = await resolveRegistrations()
    const lightTheme = (await import('@shikijs/themes/github-light')).default
    const light = { ...dark, themeRegistration: { ...lightTheme, name: 'github-light' } }
    let selected = { theme: 'github-dark', registrations: dark }
    const text = 'const value = `hello ${42}`;'
    const snapshot = createPieceTableSnapshot(text)
    const session = workerOwner.createSession({
      documentId: 'recolor.ts',
      lang: 'typescript',
      languageId: 'typescript',
      snapshot,
      fullText: text,
      ...selected,
      resolveTheme: () => selected,
    })!
    const requests = vi.spyOn(workerOwner, 'request')
    const initial = (await session.refresh(snapshot)).tokens.toTokens()
    selected = { theme: 'github-light', registrations: light }
    const recolored = (await session.refresh(snapshot)).tokens.toTokens()
    expect(recolored).not.toEqual(initial)
    const editedText = text.replace('42', 'value')
    const edited = await session.applyChange(
      createChange(editedText, {
        from: text.indexOf('42'),
        to: text.indexOf('42') + 2,
        text: 'value',
      }),
    )
    expect(requests.mock.calls.map(([payload]) => payload.type)).toEqual([
      'open',
      'recolor',
      'edit',
    ])
    const fresh = workerOwner.createSession({
      documentId: 'fresh-light.ts',
      lang: 'typescript',
      languageId: 'typescript',
      snapshot: createPieceTableSnapshot(editedText),
      fullText: editedText,
      ...selected,
    })!
    expect(edited.tokens.toTokens()).toEqual(
      (await fresh.refresh(createPieceTableSnapshot(editedText))).tokens.toTokens(),
    )
    selected = { theme: 'github-dark', registrations: dark }
    await session.refresh(createPieceTableSnapshot(editedText))
    expect(requests.mock.calls.at(-1)?.[0].type).toBe('recolor')
    session.dispose()
    fresh.dispose()
  })

  it('tokenizes code through the real browser Worker', async () => {
    const text = 'const value = 1;'
    const session = workerOwner.createSession({
      documentId: 'file.ts',
      languageId: 'typescript',
      lang: 'typescript',
      theme: 'github-dark',
      registrations: resolveRegistrations(),
      fullText: text,
      snapshot: createPieceTableSnapshot(text),
    })

    expect(session).not.toBeNull()

    const result = await session!.refresh(createPieceTableSnapshot(text), text)

    expect(result.tokens.length).toBeGreaterThan(0)
    expect(
      result.tokens.toTokens().every((token) => token.start >= 0 && token.end <= text.length),
    ).toBe(true)
    session!.dispose()
  })

  it('loads theme colors without a highlighter session', async () => {
    const theme = await workerOwner.loadTheme({
      theme: 'github-dark',
      registrations: resolveRegistrations(),
    })

    expect(theme?.backgroundColor).toBeTruthy()
    expect(theme?.foregroundColor).toBeTruthy()
  })

  it('updates tokens after an incremental edit', async () => {
    const initialText = 'const a = 1;'
    const nextText = 'const answer = 1;'
    const session = workerOwner.createSession({
      documentId: 'file.ts',
      languageId: 'typescript',
      lang: 'typescript',
      theme: 'github-dark',
      registrations: resolveRegistrations(),
      fullText: initialText,
      snapshot: createPieceTableSnapshot(initialText),
    })

    expect(session).not.toBeNull()

    await session!.refresh(createPieceTableSnapshot(initialText), initialText)
    const result = await session!.applyChange(
      createChange(nextText, { from: 6, to: 7, text: 'answer' }),
    )

    expect(result.tokens.length).toBeGreaterThan(0)
    expect(result.tokens.toTokens().some((token) => token.end > initialText.length)).toBe(true)
    // The edit answered with its own lines only; spliced in, they equal a full tokenization.
    expect(result.tokens.toTokens()).toEqual(await fullTokens(nextText))
    session!.dispose()
  })

  it('diffs from cached worker text when earlier UI edits were skipped', async () => {
    const initialText = 'const a = 1;'
    const nextText = 'const answer = 1;'
    const session = workerOwner.createSession({
      documentId: 'file.ts',
      languageId: 'typescript',
      lang: 'typescript',
      theme: 'github-dark',
      registrations: resolveRegistrations(),
      fullText: initialText,
      snapshot: createPieceTableSnapshot(initialText),
    })

    expect(session).not.toBeNull()

    await session!.refresh(createPieceTableSnapshot(initialText), initialText)
    const result = await session!.applyChange(
      createChange(nextText, { from: 11, to: 11, text: 'r' }),
    )

    expect(result.tokens.toTokens().some((token) => token.start === 6 && token.end === 12)).toBe(
      true,
    )
    session!.dispose()
  })

  it('applies a multi-edit change as one batch of incremental edits', async () => {
    const initialText = 'const a = 1;\nconst b = 2;'
    const nextText = 'const answer = 1;\nconst basis = 2;'
    const session = workerOwner.createSession({
      documentId: 'file.ts',
      languageId: 'typescript',
      lang: 'typescript',
      theme: 'github-dark',
      registrations: resolveRegistrations(),
      fullText: initialText,
      snapshot: createPieceTableSnapshot(initialText),
    })

    expect(session).not.toBeNull()

    await session!.refresh(createPieceTableSnapshot(initialText), initialText)
    const result = await session!.applyChange(
      createChange(
        nextText,
        { from: 6, to: 7, text: 'answer' },
        { from: 19, to: 20, text: 'basis' },
      ),
    )

    expect(result.tokens.toTokens().some((token) => token.start === 6 && token.end === 12)).toBe(
      true,
    )
    expect(result.tokens.toTokens().some((token) => token.start === 24 && token.end === 29)).toBe(
      true,
    )
    expect(result.tokens.toTokens()).toEqual(await fullTokens(nextText))
    session!.dispose()
  })

  it('disposes document tokenizer state', async () => {
    const text = 'const value = 1;'
    const session = workerOwner.createSession({
      documentId: 'file.ts',
      languageId: 'typescript',
      lang: 'typescript',
      theme: 'github-dark',
      registrations: resolveRegistrations(),
      fullText: text,
      snapshot: createPieceTableSnapshot(text),
    })

    expect(session).not.toBeNull()

    await session!.refresh(createPieceTableSnapshot(text), text)
    session!.dispose()

    const nextText = 'const nextValue = 1;'
    const nextSession = workerOwner.createSession({
      documentId: 'file.ts',
      languageId: 'typescript',
      lang: 'typescript',
      theme: 'github-dark',
      registrations: resolveRegistrations(),
      fullText: nextText,
      snapshot: createPieceTableSnapshot(nextText),
    })

    expect(nextSession).not.toBeNull()

    const next = await nextSession!.refresh(createPieceTableSnapshot(nextText), nextText)

    expect(next.tokens.length).toBeGreaterThan(0)
    nextSession!.dispose()
  })

  it('isolates equal logical documents by runtime session', async () => {
    const firstText = 'const first = 1;'
    const secondText = 'const second = 2;'
    const first = workerOwner.createSession({
      documentId: 'shared.ts',
      runtimeSessionId: 'runtime-shiki-first',
      languageId: 'typescript',
      lang: 'typescript',
      theme: 'github-dark',
      registrations: resolveRegistrations(),
      fullText: firstText,
      snapshot: createPieceTableSnapshot(firstText),
    })
    const second = workerOwner.createSession({
      documentId: 'shared.ts',
      runtimeSessionId: 'runtime-shiki-second',
      languageId: 'typescript',
      lang: 'typescript',
      theme: 'github-dark',
      registrations: resolveRegistrations(),
      fullText: secondText,
      snapshot: createPieceTableSnapshot(secondText),
    })

    expect(first).not.toBeNull()
    expect(second).not.toBeNull()

    await Promise.all([
      first!.refresh(createPieceTableSnapshot(firstText), firstText),
      second!.refresh(createPieceTableSnapshot(secondText), secondText),
    ])
    first!.dispose()
    await workerOwner.awaitRuntimeSessionIdle('runtime-shiki-first')

    const nextText = 'const secondValue = 2;'
    const result = await second!.applyChange(
      createChange(nextText, { from: 6, to: 12, text: 'secondValue' }),
    )

    expect(result.tokens.toTokens().some((token) => token.end > secondText.length)).toBe(true)
    second!.dispose()
  })
})

async function resolveRegistrations(): Promise<ShikiResolvedRegistrations> {
  const [language, theme] = await Promise.all([
    import('@shikijs/langs/typescript'),
    import('@shikijs/themes/github-dark'),
  ])
  return {
    languageRegistrations: language.default,
    themeRegistration: {
      ...theme.default,
      name: theme.default.name ?? 'github-dark',
    },
    themeRegistrations: [],
  }
}
