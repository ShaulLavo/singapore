import assert from 'node:assert/strict'
import { chromium } from '@playwright/test'
import { preview } from 'vite'

const server = await preview({
  configFile: false,
  preview: { host: '127.0.0.1', port: 0, open: false },
})
let browser
try {
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('requestfailed', (request) => errors.push(`${request.url()}: ${request.failure()?.errorText}`))
  page.on('response', (response) => {
    if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`)
  })
  const address = server.httpServer.address()
  assert(address && typeof address === 'object', 'Preview must bind a loopback port')
  await page.goto(`http://127.0.0.1:${address.port}`)
  await page.waitForFunction(() => ['passed', 'failed'].includes(document.body.dataset.status), { timeout: 120_000 })
  const result = await page.locator('body').textContent()
  assert.equal(await page.locator('body').getAttribute('data-status'), 'passed', result)
  assert.deepEqual(errors, [], 'Browser requests and execution must succeed')
  console.log(result)
} finally {
  await browser?.close()
  await new Promise((resolve, reject) => server.httpServer.close((error) => error ? reject(error) : resolve()))
}
