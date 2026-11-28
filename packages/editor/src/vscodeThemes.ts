import type { EditorSyntaxThemeColor, EditorTheme } from './theme'

export type VscodeThemeColorMode = 'dark' | 'light'

export type VscodeThemeTokenSetting = {
  readonly name?: string
  readonly scope?: string | readonly string[]
  readonly settings?: {
    readonly foreground?: string
    readonly background?: string
    readonly fontStyle?: string
  }
}

export type VscodeThemeLike = {
  readonly bg?: string
  readonly fg?: string
  readonly colors?: Readonly<Record<string, string | undefined>>
  readonly tokenColors?: readonly VscodeThemeTokenSetting[]
  readonly settings?: readonly VscodeThemeTokenSetting[]
  readonly type?: VscodeThemeColorMode
}

export type VscodeThemeRegistration = VscodeThemeLike & {
  readonly name?: string
  readonly displayName?: string
  readonly type?: VscodeThemeColorMode
}

export type VscodeThemeDefinition = {
  readonly id: string
  readonly label: string
  readonly shikiName: string
  readonly type: VscodeThemeColorMode
}

export type EditorVscodeSyntaxScopeMapping = {
  readonly key: EditorSyntaxThemeColor
  readonly scopes: readonly string[]
}

export const EDITOR_VSCODE_SYNTAX_SCOPE_MAPPINGS = [
  {
    key: 'attribute',
    scopes: ['entity.other.attribute-name', 'meta.attribute', 'support.type.property-name'],
  },
  {
    key: 'bracket',
    scopes: ['punctuation.section', 'punctuation.definition', 'meta.brace'],
  },
  {
    key: 'comment',
    scopes: ['comment'],
  },
  {
    key: 'constant',
    scopes: [
      'constant.language',
      'constant.character',
      'constant.other',
      'variable.other.constant',
    ],
  },
  {
    key: 'function',
    scopes: ['entity.name.function', 'support.function', 'meta.function-call'],
  },
  {
    key: 'keyword',
    scopes: ['keyword', 'storage.modifier', 'storage.type', 'storage'],
  },
  {
    key: 'keywordDeclaration',
    scopes: ['keyword.declaration', 'storage.type', 'storage', 'keyword.operator.new'],
  },
  {
    key: 'keywordImport',
    scopes: [
      'keyword.control.import',
      'keyword.control.from',
      'keyword.operator.expression.import',
    ],
  },
  {
    key: 'namespace',
    scopes: ['entity.name.namespace', 'entity.name.module', 'support.module'],
  },
  {
    key: 'number',
    scopes: ['constant.numeric'],
  },
  {
    // The scope VS Code maps the `parameter` semantic type onto. Without a rule of its own a
    // parameter falls through to the theme's variable colour, which is what it looks like anyway.
    key: 'parameter',
    scopes: ['variable.parameter', 'meta.parameter', 'meta.function.parameters'],
  },
  {
    key: 'property',
    scopes: [
      'meta.property-name',
      'variable.other.property',
      'variable.argument.css',
      'meta.object-literal.key',
      'support.type.property-name',
    ],
  },
  {
    key: 'string',
    scopes: ['string', 'string.quoted'],
  },
  {
    key: 'type',
    scopes: [
      'support.type',
      'support.class',
      'entity.name.tag',
      'entity.name.type',
      'entity.name.class',
    ],
  },
  {
    key: 'typeDefinition',
    scopes: ['entity.name.type.class', 'entity.name.class', 'entity.name.type'],
  },
  {
    key: 'typeParameter',
    scopes: ['entity.name.type.type-parameter', 'meta.type.parameters'],
  },
  {
    key: 'variable',
    scopes: ['variable.other', 'variable.parameter', 'identifier'],
  },
  {
    key: 'variableBuiltin',
    scopes: ['variable.language', 'support.variable', 'support.constant'],
  },
] satisfies readonly EditorVscodeSyntaxScopeMapping[]

export const VSCODE_THEMES = [
  { id: 'andromeeda', label: 'Andromeeda', shikiName: 'andromeeda', type: 'dark' },
  { id: 'aurora-x', label: 'Aurora X', shikiName: 'aurora-x', type: 'dark' },
  { id: 'ayu-dark', label: 'Ayu Dark', shikiName: 'ayu-dark', type: 'dark' },
  { id: 'ayu-light', label: 'Ayu Light', shikiName: 'ayu-light', type: 'light' },
  { id: 'ayu-mirage', label: 'Ayu Mirage', shikiName: 'ayu-mirage', type: 'dark' },
  {
    id: 'catppuccin-frappe',
    label: 'Catppuccin Frappé',
    shikiName: 'catppuccin-frappe',
    type: 'dark',
  },
  {
    id: 'catppuccin-latte',
    label: 'Catppuccin Latte',
    shikiName: 'catppuccin-latte',
    type: 'light',
  },
  {
    id: 'catppuccin-macchiato',
    label: 'Catppuccin Macchiato',
    shikiName: 'catppuccin-macchiato',
    type: 'dark',
  },
  {
    id: 'catppuccin-mocha',
    label: 'Catppuccin Mocha',
    shikiName: 'catppuccin-mocha',
    type: 'dark',
  },
  { id: 'dark-plus', label: 'Dark Plus', shikiName: 'dark-plus', type: 'dark' },
  { id: 'dracula', label: 'Dracula Theme', shikiName: 'dracula', type: 'dark' },
  { id: 'dracula-soft', label: 'Dracula Theme Soft', shikiName: 'dracula-soft', type: 'dark' },
  { id: 'everforest-dark', label: 'Everforest Dark', shikiName: 'everforest-dark', type: 'dark' },
  {
    id: 'everforest-light',
    label: 'Everforest Light',
    shikiName: 'everforest-light',
    type: 'light',
  },
  { id: 'github-dark', label: 'GitHub Dark', shikiName: 'github-dark', type: 'dark' },
  {
    id: 'github-dark-default',
    label: 'GitHub Dark Default',
    shikiName: 'github-dark-default',
    type: 'dark',
  },
  {
    id: 'github-dark-dimmed',
    label: 'GitHub Dark Dimmed',
    shikiName: 'github-dark-dimmed',
    type: 'dark',
  },
  {
    id: 'github-dark-high-contrast',
    label: 'GitHub Dark High Contrast',
    shikiName: 'github-dark-high-contrast',
    type: 'dark',
  },
  { id: 'github-light', label: 'GitHub Light', shikiName: 'github-light', type: 'light' },
  {
    id: 'github-light-default',
    label: 'GitHub Light Default',
    shikiName: 'github-light-default',
    type: 'light',
  },
  {
    id: 'github-light-high-contrast',
    label: 'GitHub Light High Contrast',
    shikiName: 'github-light-high-contrast',
    type: 'light',
  },
  {
    id: 'gruvbox-dark-hard',
    label: 'Gruvbox Dark Hard',
    shikiName: 'gruvbox-dark-hard',
    type: 'dark',
  },
  {
    id: 'gruvbox-dark-medium',
    label: 'Gruvbox Dark Medium',
    shikiName: 'gruvbox-dark-medium',
    type: 'dark',
  },
  {
    id: 'gruvbox-dark-soft',
    label: 'Gruvbox Dark Soft',
    shikiName: 'gruvbox-dark-soft',
    type: 'dark',
  },
  {
    id: 'gruvbox-light-hard',
    label: 'Gruvbox Light Hard',
    shikiName: 'gruvbox-light-hard',
    type: 'light',
  },
  {
    id: 'gruvbox-light-medium',
    label: 'Gruvbox Light Medium',
    shikiName: 'gruvbox-light-medium',
    type: 'light',
  },
  {
    id: 'gruvbox-light-soft',
    label: 'Gruvbox Light Soft',
    shikiName: 'gruvbox-light-soft',
    type: 'light',
  },
  { id: 'horizon', label: 'Horizon', shikiName: 'horizon', type: 'dark' },
  { id: 'horizon-bright', label: 'Horizon Bright', shikiName: 'horizon-bright', type: 'light' },
  { id: 'houston', label: 'Houston', shikiName: 'houston', type: 'dark' },
  { id: 'kanagawa-dragon', label: 'Kanagawa Dragon', shikiName: 'kanagawa-dragon', type: 'dark' },
  { id: 'kanagawa-lotus', label: 'Kanagawa Lotus', shikiName: 'kanagawa-lotus', type: 'light' },
  { id: 'kanagawa-wave', label: 'Kanagawa Wave', shikiName: 'kanagawa-wave', type: 'dark' },
  { id: 'laserwave', label: 'LaserWave', shikiName: 'laserwave', type: 'dark' },
  { id: 'light-plus', label: 'Light Plus', shikiName: 'light-plus', type: 'light' },
  { id: 'material-theme', label: 'Material Theme', shikiName: 'material-theme', type: 'dark' },
  {
    id: 'material-theme-darker',
    label: 'Material Theme Darker',
    shikiName: 'material-theme-darker',
    type: 'dark',
  },
  {
    id: 'material-theme-lighter',
    label: 'Material Theme Lighter',
    shikiName: 'material-theme-lighter',
    type: 'light',
  },
  {
    id: 'material-theme-ocean',
    label: 'Material Theme Ocean',
    shikiName: 'material-theme-ocean',
    type: 'dark',
  },
  {
    id: 'material-theme-palenight',
    label: 'Material Theme Palenight',
    shikiName: 'material-theme-palenight',
    type: 'dark',
  },
  { id: 'min-dark', label: 'Min Dark', shikiName: 'min-dark', type: 'dark' },
  { id: 'min-light', label: 'Min Light', shikiName: 'min-light', type: 'light' },
  { id: 'monokai', label: 'Monokai', shikiName: 'monokai', type: 'dark' },
  { id: 'night-owl', label: 'Night Owl', shikiName: 'night-owl', type: 'dark' },
  { id: 'night-owl-light', label: 'Night Owl Light', shikiName: 'night-owl-light', type: 'light' },
  { id: 'nord', label: 'Nord', shikiName: 'nord', type: 'dark' },
  { id: 'one-dark-pro', label: 'One Dark Pro', shikiName: 'one-dark-pro', type: 'dark' },
  { id: 'one-light', label: 'One Light', shikiName: 'one-light', type: 'light' },
  { id: 'plastic', label: 'Plastic', shikiName: 'plastic', type: 'dark' },
  { id: 'poimandres', label: 'Poimandres', shikiName: 'poimandres', type: 'dark' },
  { id: 'red', label: 'Red', shikiName: 'red', type: 'dark' },
  { id: 'rose-pine', label: 'Rosé Pine', shikiName: 'rose-pine', type: 'dark' },
  { id: 'rose-pine-dawn', label: 'Rosé Pine Dawn', shikiName: 'rose-pine-dawn', type: 'light' },
  { id: 'rose-pine-moon', label: 'Rosé Pine Moon', shikiName: 'rose-pine-moon', type: 'dark' },
  { id: 'slack-dark', label: 'Slack Dark', shikiName: 'slack-dark', type: 'dark' },
  { id: 'slack-ochin', label: 'Slack Ochin', shikiName: 'slack-ochin', type: 'light' },
  { id: 'snazzy-light', label: 'Snazzy Light', shikiName: 'snazzy-light', type: 'light' },
  { id: 'solarized-dark', label: 'Solarized Dark', shikiName: 'solarized-dark', type: 'dark' },
  { id: 'solarized-light', label: 'Solarized Light', shikiName: 'solarized-light', type: 'light' },
  { id: 'synthwave-84', label: "Synthwave '84", shikiName: 'synthwave-84', type: 'dark' },
  { id: 'tokyo-night', label: 'Tokyo Night', shikiName: 'tokyo-night', type: 'dark' },
  { id: 'vesper', label: 'Vesper', shikiName: 'vesper', type: 'dark' },
  { id: 'vitesse-black', label: 'Vitesse Black', shikiName: 'vitesse-black', type: 'dark' },
  { id: 'vitesse-dark', label: 'Vitesse Dark', shikiName: 'vitesse-dark', type: 'dark' },
  { id: 'vitesse-light', label: 'Vitesse Light', shikiName: 'vitesse-light', type: 'light' },
] satisfies readonly VscodeThemeDefinition[]

export function editorThemeFromVscodeTheme(registration: VscodeThemeRegistration): EditorTheme {
  const backgroundColor = registration.bg ?? registration.colors?.['editor.background']
  const foregroundColor = registration.fg ?? registration.colors?.['editor.foreground']
  const syntax = editorSyntaxThemeFromVscodeTheme(registration)

  return {
    ...(registration.type ? { type: registration.type } : {}),
    backgroundColor,
    foregroundColor,
    gutterBackgroundColor: registration.colors?.['editorGutter.background'] ?? backgroundColor,
    gutterForegroundColor: registration.colors?.['editorLineNumber.foreground'],
    caretColor: registration.colors?.['editorCursor.foreground'] ?? foregroundColor,
    minimapBackgroundColor: backgroundColor,
    ...(syntax ? { syntax } : {}),
  }
}

function editorSyntaxThemeFromVscodeTheme(
  theme: VscodeThemeLike,
): NonNullable<EditorTheme['syntax']> | undefined {
  const syntax: NonNullable<EditorTheme['syntax']> = {}
  for (const mapping of EDITOR_VSCODE_SYNTAX_SCOPE_MAPPINGS) {
    const color = themeColorForScopes(theme, mapping.scopes)
    if (color !== undefined) syntax[mapping.key] = color
  }
  const bracketColor = theme.fg ?? theme.colors?.['editor.foreground']
  if (syntax.bracket === undefined && bracketColor !== undefined) syntax.bracket = bracketColor
  if (Object.keys(syntax).length === 0) return undefined
  return syntax
}

type ScopeColorMatch = {
  readonly color: string
  readonly order: number
  readonly score: number
}

function themeColorForScopes(
  theme: VscodeThemeLike,
  targetScopes: readonly string[],
): string | undefined {
  const settings = theme.tokenColors ?? theme.settings ?? []
  let bestMatch: ScopeColorMatch | null = null
  for (let index = 0; index < settings.length; index += 1) {
    const match = settingColorMatch(settings[index], targetScopes, index)
    if (!match) continue
    if (!isBetterScopeColorMatch(match, bestMatch)) continue
    bestMatch = match
  }
  return bestMatch?.color
}

function settingColorMatch(
  setting: VscodeThemeTokenSetting | undefined,
  targetScopes: readonly string[],
  order: number,
): ScopeColorMatch | null {
  const color = setting?.settings?.foreground
  if (!color) return null
  const score = settingScopeMatchScore(setting, targetScopes)
  if (score === 0) return null
  return { color, order, score }
}

function settingScopeMatchScore(
  setting: VscodeThemeTokenSetting,
  targetScopes: readonly string[],
): number {
  let bestScore = 0
  for (const scope of normalizedSettingScopes(setting.scope)) {
    bestScore = Math.max(bestScore, scopeMatchScore(scope, targetScopes))
  }
  return bestScore
}

function normalizedSettingScopes(scope: string | readonly string[] | undefined): readonly string[] {
  if (scope === undefined) return []
  if (typeof scope === 'string') return splitScopeList(scope)
  return scope.flatMap(splitScopeList)
}

function splitScopeList(scope: string): string[] {
  return scope
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

function scopeMatchScore(scope: string, targetScopes: readonly string[]): number {
  let bestScore = 0
  for (let index = 0; index < targetScopes.length; index += 1) {
    bestScore = Math.max(bestScore, scopeTargetMatchScore(scope, targetScopes[index]!, index))
  }
  return bestScore
}

function scopeTargetMatchScore(scope: string, target: string, targetIndex: number): number {
  const targetPriority = Math.max(0, 20 - targetIndex)
  if (scope === target) return 300 + targetPriority + scopeDepth(scope)
  if (target.startsWith(`${scope}.`)) return 100 + targetPriority + scopeDepth(scope)
  return 0
}

function scopeDepth(scope: string): number {
  return scope.split('.').length
}

function isBetterScopeColorMatch(
  candidate: ScopeColorMatch,
  current: ScopeColorMatch | null,
): boolean {
  if (!current) return true
  if (candidate.score !== current.score) return candidate.score > current.score
  return candidate.order > current.order
}
