import assert from 'node:assert/strict'
import { chromium } from '@playwright/test'
import { preview } from 'vite'

let server
let browser
let interrupted = false
function interrupt() {
  interrupted = true
  void browser?.close()
}
process.once('SIGINT', interrupt)
process.once('SIGTERM', interrupt)
try {
  server = await preview({
    configFile: false,
    preview: { host: '127.0.0.1', port: 0, open: false },
  })
  browser = await chromium.launch({ headless: true })
  assert(!interrupted, 'Release browser qualification interrupted')
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('requestfailed', (request) =>
    errors.push(`${request.url()}: ${request.failure()?.errorText}`),
  )
  page.on('response', (response) => {
    if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`)
  })
  const address = server.httpServer.address()
  assert(address && typeof address === 'object', 'Preview must bind a loopback port')
  await page.goto(`http://127.0.0.1:${address.port}`)
  await page.waitForFunction(
    () => ['passed', 'failed'].includes(document.body.dataset.status),
    undefined,
    { timeout: 120_000 },
  )
  const result = await page.locator('body').textContent()
  assert.equal(await page.locator('body').getAttribute('data-status'), 'passed', result)
  assert.deepEqual(errors, [], 'Browser requests and execution must succeed')
  console.log(result)
} finally {
  process.off('SIGINT', interrupt)
  process.off('SIGTERM', interrupt)
  try {
    await browser?.close()
  } finally {
    await closeServer()
  }
}

async function closeServer() {
  if (!server) return
  await new Promise((resolve, reject) =>
    server.httpServer.close((error) => (error ? reject(error) : resolve())),
  )
}
