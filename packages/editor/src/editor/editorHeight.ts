export type EditorHeight = 'container' | 'content'

export type EditorSizing = {
  readonly height: EditorHeight
  readonly maxHeight?: number
}

export function editorSizing(
  height: unknown,
  maxHeight?: unknown,
  scrollMode?: unknown,
): EditorSizing {
  const content = height === 'content' || (height === undefined && scrollMode === 'content')
  if (!content) return { height: 'container' }
  return typeof maxHeight === 'number' && Number.isFinite(maxHeight) && maxHeight > 0
    ? { height: 'content', maxHeight }
    : { height: 'content' }
}
