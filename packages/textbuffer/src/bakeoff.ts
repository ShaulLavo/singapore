// Bake-off switches, read once at module load. Removed when E040 picks a scheme.
type Env = { process?: { env?: Record<string, string | undefined> } }
const env = (globalThis as Env).process?.env ?? {}

// 'avl', or 'wb' with TEXTBUFFER_ALPHA in (2/11, 1 - 1/sqrt(2)].
export const BALANCE: string = env.TEXTBUFFER_BALANCE ?? 'avl'
export const ALPHA = Number(env.TEXTBUFFER_ALPHA ?? '0.29')
// 'split' edits through split and join; 'direct' edits in one descent.
export const EDITS: string = env.TEXTBUFFER_EDITS ?? 'direct'
