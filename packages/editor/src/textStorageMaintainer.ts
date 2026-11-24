import type { PieceTableSnapshot } from '@singapore-editor/textbuffer'
import {
  compactTombstones,
  type TombstoneCompactionResult,
} from '@singapore-editor/textbuffer/internal/compaction'
import {
  reclaimSnapshotStorage,
  type TextReclamationResult,
} from '@singapore-editor/textbuffer/internal/reclamation'

export type StorageMaintenanceResult = TextReclamationResult & TombstoneCompactionResult

// Only the current tree is compacted: history keeps the trees it recorded and
// lets them go as it moves on, while every later state is edited from this one.
export function* maintainStorage(
  current: PieceTableSnapshot,
  snapshots: () => Iterable<PieceTableSnapshot>,
): Generator<void, StorageMaintenanceResult> {
  const compaction = yield* compactTombstones(current)
  const reclamation = yield* reclaimSnapshotStorage(snapshots())
  return { ...reclamation, ...compaction }
}
