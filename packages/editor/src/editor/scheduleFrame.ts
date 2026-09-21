import { nowMs } from './timing'

export type ScheduledFrame = { cancel(): void }

export function scheduleFrame(
  callback: FrameRequestCallback,
  target: Pick<Window, 'requestAnimationFrame' | 'cancelAnimationFrame'> = globalThis,
): ScheduledFrame {
  if (typeof target.requestAnimationFrame === 'function') {
    const handle = target.requestAnimationFrame(callback)
    return { cancel: () => target.cancelAnimationFrame(handle) }
  }
  const handle = setTimeout(() => callback(nowMs()), 0)
  return { cancel: () => clearTimeout(handle) }
}
