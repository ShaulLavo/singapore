import {
  EDITOR_VSCODE_SYNTAX_SCOPE_MAPPINGS,
  effectiveEditorTheme,
  type EditorTheme,
  type VscodeThemeRegistration,
  type VscodeThemeTokenSetting,
} from '@singapore-editor/core/rendering'

/** Theme data for a highlight: an Editor palette or an imported VS Code theme. */
export type HighlightTheme =
  | { readonly format: 'editor'; readonly definition: EditorTheme; readonly name?: string }
  | { readonly format: 'vscode'; readonly definition: VscodeThemeRegistration }

export type ResolvedHighlightTheme = {
  /** Changes whenever the theme's content changes, not only its name. */
  readonly revision: string
  readonly registration: VscodeThemeRegistration
}

/**
 * Read from the theme's content on every call: a caller may reuse one theme object after changing
 * it, and a revision remembered by identity would keep the old colours.
 */
export function resolveHighlightTheme(theme: HighlightTheme): ResolvedHighlightTheme {
  const registration = themeRegistration(theme)
  // A palette's contributed colors never reach the TextMate conversion, so its revision hashes
  // the palette itself.
  const content = theme.format === 'editor' ? theme.definition : registration
  return { revision: revisionName(registration.name ?? 'editor', content), registration }
}

/** A worker theme name that changes whenever `content` does. */
export function revisionName(name: string, content: unknown): string {
  return `${name}@${contentHash(JSON.stringify(content))}`
}

/** A normalized registration with owned arrays and no undefined color entries. */
export function workerThemeRegistration(
  registration: VscodeThemeRegistration,
  name = registration.name,
): VscodeThemeRegistration {
  if (!name) throw new Error('Highlight themes require a name')

  return {
    ...registration,
    name,
    colors: definedColors(registration.colors),
    settings: registration.settings?.map(copyThemeSetting),
    tokenColors: registration.tokenColors?.map(copyThemeSetting),
  }
}

function themeRegistration(theme: HighlightTheme): VscodeThemeRegistration {
  if (theme.format === 'vscode') return workerThemeRegistration(theme.definition)

  const name = theme.name ?? 'editor'
  const type = theme.definition.type === 'light' ? 'light' : 'dark'
  const palette = effectiveEditorTheme(theme.definition)
  return workerThemeRegistration(editorThemeToVscodeRegistration(palette, name, type), name)
}

function editorThemeToVscodeRegistration(
  theme: EditorTheme,
  name: string,
  type: 'light' | 'dark',
): VscodeThemeRegistration {
  const colors: Record<string, string> = {}
  if (theme.backgroundColor) colors['editor.background'] = theme.backgroundColor
  if (theme.foregroundColor) colors['editor.foreground'] = theme.foregroundColor
  if (theme.caretColor) colors['editorCursor.foreground'] = theme.caretColor
  if (theme.selectionColor) colors['editor.selectionBackground'] = theme.selectionColor

  const tokenColors: VscodeThemeTokenSetting[] = []
  const syntax = theme.syntax
  if (syntax) {
    for (const { key, scopes } of EDITOR_VSCODE_SYNTAX_SCOPE_MAPPINGS) {
      const color = syntax[key]
      if (!color) continue
      tokenColors.push({ scope: [...scopes], settings: { foreground: color } })
    }
  }

  return {
    name,
    type,
    bg: theme.backgroundColor,
    fg: theme.foregroundColor,
    colors,
    tokenColors,
  }
}

function copyThemeSetting(setting: VscodeThemeTokenSetting): VscodeThemeTokenSetting {
  return {
    ...setting,
    scope: typeof setting.scope === 'string' ? setting.scope : setting.scope?.slice(),
    settings: setting.settings ? { ...setting.settings } : undefined,
  }
}

function definedColors(source: VscodeThemeRegistration['colors']): Record<string, string> {
  const colors: Record<string, string> = {}
  for (const [name, color] of Object.entries(source ?? {})) {
    if (color === undefined) continue
    colors[name] = color
  }
  return colors
}

// FNV-1a: a revision tag, not a security boundary.
function contentHash(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}
