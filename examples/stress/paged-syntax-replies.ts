type SliceReplyControl = {
  holdNext(): void
  status(): string | null
  release(): void
}

declare global {
  var __pagedSliceReplies: SliceReplyControl
}

export function installPagedSyntaxReplyControl(): void {
  let armed = false
  let expected: { readonly worker: Worker; readonly id: number } | null = null
  let reply: { readonly status: string; deliver(): void } | null = null

  globalThis.Worker = class extends Worker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options)
      this.addEventListener('message', (event: MessageEvent<SliceReply>) => {
        const message = event.data
        if (expected?.worker !== this || message.id !== expected.id) return
        event.stopImmediatePropagation()
        expected = null
        reply = {
          status: message.result?.sliceStatus ?? 'error',
          deliver: () => this.dispatchEvent(new MessageEvent('message', { data: message })),
        }
      })
    }

    override postMessage(message: unknown, transfer?: Transferable[] | StructuredSerializeOptions) {
      if (armed && isHighlightRequest(message)) {
        armed = false
        expected = { worker: this, id: message.id }
      }
      if (Array.isArray(transfer)) super.postMessage(message, transfer)
      else super.postMessage(message, transfer)
    }
  }

  globalThis.__pagedSliceReplies = {
    holdNext() {
      if (armed || expected || reply) throw new Error('A slice reply is already held')
      armed = true
    },
    status: () => reply?.status ?? null,
    release() {
      const held = reply
      if (!held) throw new Error('No slice reply is held')
      reply = null
      held.deliver()
    },
  }

  function isHighlightRequest(message: unknown): message is { readonly id: number } {
    if (!message || typeof message !== 'object' || !('id' in message) || !('payload' in message))
      return false
    const payload = message.payload
    return (
      typeof message.id === 'number' &&
      !!payload &&
      typeof payload === 'object' &&
      'type' in payload &&
      payload.type === 'highlightSlice'
    )
  }

  type SliceReply = { readonly id: number; readonly result?: { readonly sliceStatus?: string } }
}
