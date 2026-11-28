import {
  editorThemeFromVscodeTheme,
  type EditorTheme,
  type VscodeThemeLike,
} from '@singapore-editor/core/rendering'

export type ShikiThemeLike = VscodeThemeLike

export function editorThemeFromShikiTheme(theme: ShikiThemeLike): EditorTheme {
  return editorThemeFromVscodeTheme(theme)
}
