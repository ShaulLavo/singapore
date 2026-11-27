import { createStringTextSnapshot } from '@singapore-editor/core/document'
import { describe, expect, it } from 'vitest'

import { hoverTargetRange, hoverTargetRangeInSource } from '../src/offsetRange'

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
})
