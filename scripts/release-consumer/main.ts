const worker = new Worker(new URL('./grammar.worker.ts', import.meta.url), { type: 'module' })
worker.onmessage = (event: MessageEvent<{ passed: boolean; detail: string }>) => {
  document.body.textContent = event.data.detail
  document.body.dataset.status = event.data.passed ? 'passed' : 'failed'
  worker.terminate()
}
worker.onerror = (event) => {
  document.body.textContent = event.message
  document.body.dataset.status = 'failed'
  worker.terminate()
}
