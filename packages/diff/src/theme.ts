import { registerEditorColor } from '@singapore-editor/core/rendering'

const colors = {
  added: '#5ecc71',
  deleted: '#ff6762',
  modified: '#69b1ff',
  'added.bg': 'color-mix(in srgb, var(--editor-background, #1e1e1e) 78%, var(--editor-diff-added))',
  'deleted.bg':
    'color-mix(in srgb, var(--editor-background, #1e1e1e) 78%, var(--editor-diff-deleted))',
  'hunk.bg':
    'color-mix(in srgb, var(--editor-background, #1e1e1e) 84%, var(--editor-diff-modified))',
  'placeholder.bg': 'color-mix(in srgb, var(--editor-background, #1e1e1e) 92%, #ffffff)',
  border: '#3f3f46',
  'split.handle': '#71717a',
  muted: '#a1a1aa',
  'hunk.foreground': '#9cdcfe',
}

for (const [id, fallback] of Object.entries(colors)) registerEditorColor(`diff.${id}`, fallback)
