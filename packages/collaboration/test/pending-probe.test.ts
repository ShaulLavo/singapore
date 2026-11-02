import { expect, test, vi } from 'vitest'
import { TextbufferEngine } from '@singapore-editor/collab'
import { CollaborationDocument } from '../src/document'
import { MergeReview } from '../src/review'
import type { MergeReviewSyntax } from '../src/merge-review'

const syntax: MergeReviewSyntax = async (snapshot, ranges) =>
  ranges.map(() => [
    {
      startIndex: 0,
      endIndex: snapshot.length,
      type: 'line',
      languageId: 'text',
      signature: null,
      hasErrors: false,
      parent: null,
    },
  ])

type Probe = { readonly calls: number; readonly units: number }

function documentPair(text: string) {
  const options = { document: 'doc', epoch: 'epoch', text }
  const a = new CollaborationDocument({ ...options, peer: 'alice' })
  const b = new CollaborationDocument({ ...options, peer: 'bob' })
  const tasks: (() => void)[] = []
  const review = new MergeReview(a, 'alice', { syntax }, () => {}, (run) => {
    tasks.push(run)
    return () => {}
  })
  return {
    a,
    b,
    review,
    tasks,
    async flush() {
      for (const task of tasks.splice(0)) task()
      await review.idle()
    },
  }
}

async function measure(
  size: number,
  path: 'confirmed' | 'queued' | 'current',
): Promise<Probe> {
  const f = documentPair('x'.repeat(size))
  const left = f.a.participant.local({ offset: size - 1, deleteCount: 1, text: 'a' })
  const right = f.b.participant.local({ offset: size - 1, deleteCount: 1, text: 'b' })
  if (path !== 'confirmed') {
    f.a.sequenceBatch([{ edit: left }, { edit: right }])
    if (path === 'current') await f.flush()
  }
  const original = TextbufferEngine.prototype.text
  let calls = 0
  let units = 0
  const spy = vi.spyOn(TextbufferEngine.prototype, 'text').mockImplementation(function () {
    const text = original.call(this)
    calls++
    units += text.length
    return text
  })
  try {
    if (path === 'confirmed') {
      f.a.sequence(right)
    } else {
      if (path === 'queued') {
        f.a.participant.local({ offset: size, deleteCount: 0, text: 'p' })
        await f.flush()
      } else {
        await f.flush()
        const mark = f.review.marks[0]!
        f.a.participant.local({ offset: size, deleteCount: 0, text: 'p' })
        expect(f.review.versions(mark)).toBeNull()
      }
    }
    const result = { calls, units }
    console.log(JSON.stringify({ size, path, ...result }))
    return result
  } finally {
    spy.mockRestore()
    f.review.dispose()
  }
}

for (const size of [100_000, 1_000_000]) {
  for (const path of ['confirmed', 'queued', 'current'] as const) {
    test(`baseline ${path} pending guard reads ${size} units`, async () => {
      const result = await measure(size, path)
      expect(result.calls).toBeGreaterThan(0)
      expect(result.units).toBeGreaterThanOrEqual(size)
    })
  }
}
