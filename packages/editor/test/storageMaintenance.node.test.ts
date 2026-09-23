import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bufferStorageIdentity } from '@singapore-editor/textbuffer/internal/buffers'
import {
  createPieceTableSnapshot,
  deleteFromPieceTable,
  insertIntoPieceTable,
  materializePieceTableFullText,
} from '@singapore-editor/textbuffer'
import { TextStorageMaintenance } from '../src/textStorageMaintenance'
import {
  acquireDocumentMutationLease,
  commitPreparedDocumentTransaction,
  createEditorBufferSession,
  createEditorTextBuffer,
  prepareDocumentTransaction,
  releaseDocumentMutationLease,
  releaseDocumentTransactionReceipt,
  reverseDocumentTransaction,
} from '../src/documentSession'

const payload = 'x'.repeat(16384)
const subscriptions: (() => void)[] = []
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  for (const unsubscribe of subscriptions.splice(0)) unsubscribe()
  vi.clearAllTimers()
  vi.useRealTimers()
})

function fixture() {
  const buffer = createEditorTextBuffer('abc')
  const session = createEditorBufferSession(buffer)
  subscriptions.push(buffer.subscribe(() => {}))
  for (let cycle = 0; cycle < 130; cycle++) {
    session.applyEdits([{ from: 1, to: 1, text: payload }])
    session.applyEdits([{ from: 1, to: 1 + payload.length, text: '' }])
  }
  session.applyEdits([{ from: 1, to: 1, text: '!' }])
  return { buffer, session }
}

describe('automatic buffer storage maintenance', () => {
  it('reclaims partial chunks while a prepared transaction and its lease retain identity', async () => {
    const buffer = createEditorTextBuffer('prefix suffix')
    const session = createEditorBufferSession(buffer)
    for (let cycle = 0; cycle < 300; cycle++) {
      session.applyEdits([{ from: 7, to: 7, text: 'x'.repeat(1024) }])
      session.applyEdits([{ from: 71, to: 1031, text: '' }])
    }
    const text = buffer.materializeFullText()
    const before = buffer.getSnapshot()
    const prepared = prepareDocumentTransaction(
      buffer,
      [{ from: 0, to: 6, text: 'PREFIX' }],
      1,
      null,
    )
    const acquired = acquireDocumentMutationLease(buffer, buffer.getRevision(), before, 'partial')
    if (acquired.status !== 'acquired') throw new RangeError('expected lease')
    await vi.runAllTimersAsync()
    expect(buffer.getSnapshot()).toBe(before)
    expect(buffer.getStorageMaintenanceStats().codeUnits).toBeGreaterThan(100_000)
    expect(buffer.materializeFullText()).toBe(text)
    const target = { buffer, sourceView: null, mutationLease: acquired.lease }
    const committed = commitPreparedDocumentTransaction(target, prepared, {
      history: { kind: 'external-barrier', groupId: 'partial' },
    })
    if (committed.status !== 'committed') throw new RangeError('expected commit')
    expect(buffer.materializeFullText()).toBe('PREFIX' + text.slice(6))
    const reversed = reverseDocumentTransaction(target, committed.receipt)
    if (reversed.status !== 'reversed') throw new RangeError('expected reversal')
    expect(buffer.materializeFullText()).toBe(text)
    releaseDocumentTransactionReceipt(target, reversed.receipt)
    releaseDocumentMutationLease(buffer, acquired.lease)
  })

  it('reclaims original-only storage after save/history release while an external snapshot stays readable', async () => {
    const original = 'prefix\n' + 'obsolete\n'.repeat(20_000) + 'suffix'
    const buffer = createEditorTextBuffer(original)
    const session = createEditorBufferSession(buffer)
    const external = buffer.getSnapshot()
    session.applyEdits([{ from: 7, to: original.length - 6, text: '' }])
    await vi.runAllTimersAsync()
    expect(buffer.getStorageMaintenanceStats().codeUnits).toBe(0)
    buffer.clearHistory()
    buffer.markClean()
    const snapshot = buffer.getSnapshot()
    const revision = buffer.getRevision()
    await vi.runAllTimersAsync()
    expect(buffer.getStorageMaintenanceStats().codeUnits).toBe(180_000)
    expect(buffer.getSnapshot()).toBe(snapshot)
    expect(buffer.getRevision()).toBe(revision)
    expect(buffer.isDirty()).toBe(false)
    expect(buffer.materializeFullText()).toBe('prefix\nsuffix')
    expect(materializePieceTableFullText(external)).toBe(original)
    session.applyEdits([{ from: 7, to: 7, text: 'new\n' }])
    expect(buffer.materializeFullText()).toBe('prefix\nnew\nsuffix')
  })

  it('reclaims storage without changing identity, dirty state, revision, or sending changes', async () => {
    const { buffer } = fixture()
    buffer.markClean()
    const snapshot = buffer.getSnapshot()
    const text = buffer.getTextSnapshot()
    const storage = snapshot.buffers
    const revision = buffer.getRevision()
    const changes = vi.fn()
    subscriptions.push(buffer.subscribe(changes))
    await vi.runAllTimersAsync()
    expect(buffer.getStorageMaintenanceStats().chunks).toBeGreaterThan(0)
    expect(snapshot.buffers).not.toBe(storage)
    expect(buffer.getSnapshot()).toBe(snapshot)
    expect(buffer.getTextSnapshot()).toBe(text)
    expect(buffer.getRevision()).toBe(revision)
    expect(buffer.isDirty()).toBe(false)
    expect(changes).not.toHaveBeenCalled()
    expect(buffer.materializeFullText()).toBe('a!bc')
  })

  it('keeps prepared transactions and receipt reversal valid across publication', async () => {
    const { buffer } = fixture()
    buffer.markClean()
    const before = buffer.getSnapshot()
    const storage = before.buffers
    const prepared = prepareDocumentTransaction(buffer, [{ from: 0, to: 1, text: 'A' }], 1, null)
    const acquired = acquireDocumentMutationLease(
      buffer,
      buffer.getRevision(),
      before,
      'maintenance',
    )
    if (acquired.status !== 'acquired') throw new RangeError('expected lease')
    await vi.runAllTimersAsync()
    expect(before.buffers).not.toBe(storage)
    const target = { buffer, sourceView: null, mutationLease: acquired.lease }
    const committed = commitPreparedDocumentTransaction(target, prepared, {
      history: { kind: 'external-barrier', groupId: 'maintenance' },
    })
    if (committed.status !== 'committed') throw new RangeError('expected commit')
    expect(buffer.materializeFullText()).toBe('A!bc')
    buffer.markClean()
    await vi.runAllTimersAsync()
    const reversed = reverseDocumentTransaction(target, committed.receipt)
    if (reversed.status !== 'reversed') throw new RangeError('expected reversal')
    expect(buffer.materializeFullText()).toBe('a!bc')
    releaseDocumentTransactionReceipt(target, reversed.receipt)
    releaseDocumentMutationLease(buffer, acquired.lease)
    buffer.undo()
    expect(buffer.materializeFullText()).toBe('abc')
    buffer.redo()
    expect(buffer.materializeFullText()).toBe('a!bc')
  })

  it('shares reclaimed history storage and preserves every undo and redo', async () => {
    const { buffer } = fixture()
    await vi.runAllTimersAsync()
    const storage = bufferStorageIdentity(buffer.getSnapshot().buffers)
    const undone: string[] = []
    while (buffer.canUndo()) {
      undone.push(buffer.materializeFullText())
      buffer.undo()
      expect(bufferStorageIdentity(buffer.getSnapshot().buffers)).toBe(storage)
      expect(['abc', 'a' + payload + 'bc']).toContain(buffer.materializeFullText())
    }
    expect(undone.length).toBeGreaterThan(100)
    while (buffer.canRedo()) {
      buffer.redo()
      expect(buffer.materializeFullText()).toBe(undone.pop())
    }
    expect(undone).toEqual([])
  })

  it('cancels between slices when editing resumes and completes with fresh contents', async () => {
    const { buffer, session } = fixture()
    await vi.advanceTimersByTimeAsync(301)
    expect(buffer.getStorageMaintenanceStats().completed).toBe(0)
    session.applyEdits([{ from: 0, to: 0, text: 'new ' }])
    expect(buffer.getStorageMaintenanceStats().cancelled).toBeGreaterThan(0)
    await vi.runAllTimersAsync()
    expect(buffer.getStorageMaintenanceStats().completed).toBe(1)
    expect(buffer.materializeFullText()).toBe('new a!bc')
  })

  it('suspends on the last detach and resumes when a view attaches again', async () => {
    const { buffer } = fixture()
    const second = buffer.subscribe(() => {})
    subscriptions.pop()!()
    second()
    await vi.runAllTimersAsync()
    expect(buffer.getStorageMaintenanceStats().completed).toBe(0)
    subscriptions.push(buffer.subscribe(() => {}))
    await vi.runAllTimersAsync()
    expect(buffer.getStorageMaintenanceStats().completed).toBe(1)
    expect(buffer.getStorageMaintenanceStats().chunks).toBeGreaterThan(0)
  })

  it('reclaims again when a prepared commit lands on the unreclaimed log', async () => {
    const { buffer } = fixture()
    const prepared = prepareDocumentTransaction(buffer, [{ from: 0, to: 1, text: 'A' }], 1, null)
    await vi.runAllTimersAsync()
    const first = buffer.getStorageMaintenanceStats()
    expect(first.completed).toBe(1)
    const committed = commitPreparedDocumentTransaction({ buffer, sourceView: null }, prepared, {
      history: { kind: 'external-barrier', groupId: 'maintenance' },
    })
    if (committed.status !== 'committed') throw new RangeError('expected commit')
    await vi.runAllTimersAsync()
    const second = buffer.getStorageMaintenanceStats()
    expect(second.completed).toBe(2)
    expect(second.chunks).toBeGreaterThan(first.chunks)
    expect(buffer.materializeFullText()).toBe('A!bc')
  })

  it('reclaims text that only cleared history still showed', async () => {
    const { buffer } = fixture()
    await vi.runAllTimersAsync()
    const first = buffer.getStorageMaintenanceStats()
    buffer.clearHistory()
    await vi.runAllTimersAsync()
    const second = buffer.getStorageMaintenanceStats()
    expect(second.completed).toBe(2)
    expect(second.chunks).toBeGreaterThan(first.chunks)
    expect(buffer.materializeFullText()).toBe('a!bc')
  })

  it('reclaims a retained log even when the current log is too small to reclaim', async () => {
    const small = insertIntoPieceTable(createPieceTableSnapshot('abc'), 1, 'z')
    let large = createPieceTableSnapshot('abc')
    for (let cycle = 0; cycle < 4; cycle++) {
      large = insertIntoPieceTable(large, 1, payload)
      large = deleteFromPieceTable(large, 1, payload.length)
    }
    large = insertIntoPieceTable(large, 1, '!')
    const maintenance = new TextStorageMaintenance(() => [small, large])
    maintenance.request(0, true)
    await vi.runAllTimersAsync()
    expect(maintenance.getStats().chunks).toBeGreaterThan(0)
  })

  // Publication swaps storage inside the snapshot because a copied snapshot is a stale one.
  it('requires snapshot identity for lease acquisition, even with an identical root', () => {
    const buffer = createEditorTextBuffer('abc')
    const snapshot = buffer.getSnapshot()
    expect(acquireDocumentMutationLease(buffer, 0, { ...snapshot }, 'stale')).toEqual({
      status: 'stale',
    })
    expect(acquireDocumentMutationLease(buffer, 0, snapshot, 'current').status).toBe('acquired')
  })
})
