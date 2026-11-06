import assert from 'node:assert/strict'
import { readFile, mkdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { chromium } from 'playwright-core'
import { lock, modelAt, modelViews, root } from '../tooling/model.mjs'

const types = { '.css': 'text/css', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml' }

test('built site shows its source scope and opens all seven real diagrams', { timeout: 45000 }, async () => {
  const dist = resolve(root, 'dist')
  const output = join(root, '.runtime/browser')
  await mkdir(output, { recursive: true })
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://127.0.0.1').pathname
    const target = resolve(dist, '.' + (path.endsWith('/') ? path + 'index.html' : path))
    if (!target.startsWith(dist + '/')) {
      response.writeHead(403).end()
      return
    }
    try {
      const body = await readFile(target)
      response.writeHead(200, { 'Content-Type': types[extname(target)] ?? 'application/octet-stream' }).end(body)
    } catch {
      response.writeHead(404).end()
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let browser
  try {
    browser = await chromium.launch()
    const page = await browser.newPage({ viewport: { width: 1365, height: 900 }, colorScheme: 'light' })
    const origin = 'http://127.0.0.1:' + server.address().port
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    const landing = await page.goto(origin)
    assert.equal(landing.status(), 200)
    assert.equal(await page.locator('html').getAttribute('lang'), 'de-CH')
    assert.equal(await page.getByRole('heading', { level: 1, name: 'Dateninfrastruktur' }).count(), 1)
    assert(await page.getByText('Lokales Compose-System', { exact: true }).isVisible())
    assert(await page.getByText('Ausgewählte Laufzeitnachweise stehen aus.', { exact: false }).isVisible())
    assert(await page.getByText('Remote-SHAs wurden noch nicht verglichen.', { exact: false }).isVisible())
    assert.equal(await page.getByText(lock.workspace, { exact: true }).count(), 1)
    assert.equal(await page.locator('section[aria-labelledby="views"] li a').count(), 7)
    assert(await page.getByText('Rollen und die Grenze des lokal untersuchten Systems.', { exact: true }).isVisible())
    assert.equal(await page.getByText('[object Object]', { exact: true }).count(), 0)
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    await page.screenshot({ path: join(output, 'overview.png'), fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    await page.setViewportSize({ width: 1365, height: 900 })
    const views = modelViews(await modelAt())
    for (const view of views) {
      await page.goto(origin)
      const link = page.getByRole('link', { name: new RegExp(view.id + ' ' + view.title) })
      assert(await link.isVisible())
      await link.click()
      await page.getByText(view.title, { exact: true }).first().waitFor({ timeout: 5000 })
      assert(page.url().endsWith('/' + view.id))
      if (view.id === 'V02' || view.id === 'V07') {
        for (const service of ['Gateway', 'Datei-Origin', 'PostgreSQL', 'Superset']) {
          assert(await page.getByText(service, { exact: true }).first().isVisible(), view.id + ': ' + service)
        }
        await page.screenshot({ path: join(output, view.id === 'V02' ? 'containers.png' : 'deployment.png') })
      }
    }
    assert.deepEqual(errors, [])
    console.log('DOM and Chromium: local scope, evidence status, hashes and all seven native LikeC4 routes')
  } finally {
    await browser?.close()
    await new Promise(resolve => server.close(resolve))
  }
})
