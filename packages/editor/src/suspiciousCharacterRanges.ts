import type { TextContent } from './textContent'
import type { TextOffsetRange } from './textRanges'
import {
  provideSuspiciousCharacterData,
  type ResolvedSuspiciousCharactersOptions,
  scanSuspiciousCharacters,
  type SuspiciousCharacterRange,
} from './unicodeHighlight'
import * as suspiciousCharacterData from './unicodeHighlightData'

/**
 * Every suspicious character in `text`, or in the slice of it `range` names.
 *
 * The range exists because a row of a long line mounts only the columns on screen, and a column
 * that is not mounted has no geometry a marker could be drawn against. Word context is still read
 * from the whole text: the word a character sits in is what decides whether it is worth reporting,
 * and that word does not stop at the edge of the viewport.
 *
 * Importing this brings the code point tables along. The editor itself loads them on its first row
 * of text that is not plain ASCII, so an editor that never calls this does not download them.
 */
export function suspiciousCharacterRanges(
  text: TextContent,
  options: ResolvedSuspiciousCharactersOptions,
  range?: TextOffsetRange,
): readonly SuspiciousCharacterRange[] {
  provideSuspiciousCharacterData(suspiciousCharacterData)
  return scanSuspiciousCharacters(text, options, range)
}
