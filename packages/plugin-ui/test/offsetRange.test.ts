import { createStringTextSnapshot } from '@singapore-editor/core/document'
import { describe, expect, it } from 'vitest'

import {
  hoverTargetRange,
  hoverTargetRangeInSource,
  markerTargetRangeInSource,
} from '../src/offsetRange'

describe('hoverTargetRangeInSource', () => {
  it('answers every offset as the whole-string search does', () => {
    const longName = 'x'.repeat(700)
    const text = `const a = 1\n\n  ${longName}.b()\n$tail_\n`
    const source = createStringTextSnapshot(text)

    for (let offset = 0; offset <= text.length; offset += 1) {
      expect(hoverTargetRangeInSource(source, offset), `offset ${offset}`).toEqual(
        hoverTargetRange(text, offset),
      )
    }
  })

  it('answers an empty document', () => {
    expect(hoverTargetRangeInSource(createStringTextSnapshot(''), 0)).toEqual(
      hoverTargetRange('', 0),
    )
  })

  it('recognizes Unicode identifiers including CJK, accented letters, and astral code points', () => {
    const text = 'const 变量名 = café + 𠀀名'
    const source = createStringTextSnapshot(text)

    const cjkStart = text.indexOf('变量名')
    const cjkEnd = cjkStart + '变量名'.length
    for (let offset = cjkStart; offset <= cjkEnd; offset += 1) {
      expect(hoverTargetRangeInSource(source, offset)).toEqual({ start: cjkStart, end: cjkEnd })
    }

    const cafeStart = text.indexOf('café')
    const cafeEnd = cafeStart + 'café'.length
    for (let offset = cafeStart; offset <= cafeEnd; offset += 1) {
      expect(hoverTargetRangeInSource(source, offset)).toEqual({ start: cafeStart, end: cafeEnd })
    }

    const astralStart = text.indexOf('𠀀名')
    const astralEnd = astralStart + '𠀀名'.length
    for (let offset = astralStart; offset <= astralEnd; offset += 1) {
      expect(hoverTargetRangeInSource(source, offset)).toEqual({
        start: astralStart,
        end: astralEnd,
      })
    }
  })

  it('keeps full identifiers for visible identifier markers and exact code point spans for non-identifier markers', () => {
    const identText = 'const a𝐚bc = 1'
    const identStart = identText.indexOf('a𝐚bc')
    const boldOffset = identText.indexOf('𝐚')
    expect(markerTargetRangeInSource(createStringTextSnapshot(identText), boldOffset)).toEqual({
      start: identStart,
      end: identStart + 'a𝐚bc'.length,
    })

    const zwspText = 'const alpha\u200b'
    const zwspOffset = zwspText.indexOf('\u200b')
    expect(markerTargetRangeInSource(createStringTextSnapshot(zwspText), zwspOffset)).toEqual({
      start: zwspOffset,
      end: zwspOffset + 1,
    })

    const astralInvisibleText = 'const alpha\u{E0001}'
    const tagOffset = astralInvisibleText.indexOf('\u{E0001}')
    expect(
      markerTargetRangeInSource(createStringTextSnapshot(astralInvisibleText), tagOffset),
    ).toEqual({
      start: tagOffset,
      end: tagOffset + 2,
    })

    const ambiguousPunctuation = 'alpha—'
    const dashOffset = ambiguousPunctuation.indexOf('—')
    expect(
      markerTargetRangeInSource(createStringTextSnapshot(ambiguousPunctuation), dashOffset),
    ).toEqual({
      start: dashOffset,
      end: dashOffset + 1,
    })
  })
})
