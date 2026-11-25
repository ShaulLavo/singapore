import type { DocumentSessionChange } from '../documentSession'
import type { EditorViewContributionUpdateKind } from '../plugins'
import type { SelectionAffinity } from '../selections'
import type { EditorSetSelectionOptions } from './selectionReveal'

export type SessionChangeOptions = {
  readonly syncDomSelection?: boolean
  readonly revealOffset?: number
  /** Present only when revealOffset names the active caret rather than an arbitrary document point. */
  readonly revealAffinity?: SelectionAffinity
  readonly revealBlock?: EditorSetSelectionOptions['revealBlock']
  /** The change is keyboard text input, which contributions keep instant. */
  readonly typing?: boolean
}

export function viewContributionKindForChange(
  change: DocumentSessionChange,
): EditorViewContributionUpdateKind {
  if (change.kind === 'selection') return 'selection'
  return 'content'
}

export function indentTimingName(direction: 'indent' | 'outdent'): string {
  return direction === 'indent' ? 'input.indent' : 'input.outdent'
}

export function removeArrayItem<T>(items: T[], item: T): void {
  const index = items.indexOf(item)
  if (index === -1) return

  items.splice(index, 1)
}

export function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`
}
