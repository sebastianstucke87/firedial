// FireDial in a real Chrome: what differs from Firefox, and the core of the page. Chrome's own
// context menu can't be driven from here, so the menu is checked for its entries only.

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { By, Key } from 'selenium-webdriver'
import type chrome from 'selenium-webdriver/chrome.js'
import * as z from 'zod/mini'

import { startChrome, until as untilIn } from './chrome.ts'

const server = createServer((request, response) => {
  response.setHeader('content-type', 'text/html')
  response.end(`<!doctype html><title>Page ${request.url ?? ''}</title><p id="text">hello</p>`)
}).listen(0, '127.0.0.1')

let driver: chrome.Driver
let newtab = ''
let downloads = ''
let quit = (): Promise<void> => Promise.resolve()
let base = ''

const js = <T>(code: string, ...args: unknown[]): Promise<T> => driver.executeScript<T>(code, ...args)
const run = <T>(code: string, ...args: unknown[]): Promise<T> => driver.executeAsyncScript<T>(`const done = arguments[arguments.length - 1]; ${code}`, ...args)
const until = (what: string, check: () => Promise<boolean>): Promise<void> => untilIn(driver, what, check)
const press = (...keys: string[]): Promise<void> =>
  driver
    .actions()
    .sendKeys(...keys)
    .perform()
const click = (selector: string): Promise<void> => js('document.querySelector(arguments[0]).click()', selector)
const sparkTitles = (): Promise<string[]> => js("return [...document.querySelectorAll('#sparks .Spark[data-id] .Title')].map((title) => title.textContent)")
const sparkCount = async (): Promise<number> => (await sparkTitles()).length

// FireDial's folder in Other bookmarks: its bookmarks' titles, without the data ones.
const bookmarked = (): Promise<string[]> =>
  run(`browser.bookmarks.getChildren('2').then(async (nodes) => {
    const root = nodes.find((node) => node.title === 'FireDial' && !node.url)
    const children = root ? await browser.bookmarks.getChildren(root.id) : []
    done(children.filter((node) => !node.url.startsWith('https://firedial.invalid/')).map((node) => node.title))
  })`)

const home = async (): Promise<void> => {
  await driver.get(newtab)
  await until('the page', () => js("return document.querySelector('#sparks .AddSpark') !== null"))
}

async function addSpark(path: string): Promise<void> {
  const before = await sparkCount()
  await driver.findElement(By.css('#sparks .AddSpark')).click()
  await press(`${base}/${path}`, Key.ENTER)
  await until('the spark', async () => (await sparkCount()) === before + 1)
}

before(async () => {
  await new Promise((resolve) => server.once('listening', resolve))
  const address: string | AddressInfo | null = server.address()
  assert.ok(address !== null && typeof address === 'object')
  base = `http://127.0.0.1:${address.port}`
  ;({ driver, newtab, downloads, quit } = await startChrome({ hosts: `127.0.0.1:${address.port}` }))
  await driver.manage().window().setRect({ width: 1400, height: 900 })
  await home()
})

after(async () => {
  await quit()
  server.close()
})

test('a fresh install in Chrome starts with the defaults, and they are bookmarks in Other bookmarks', async () => {
  const fresh = await startChrome({ defaults: true })
  try {
    const titles = z
      .object({ sparks: z.array(z.object({ title: z.string() })) })
      .parse(JSON.parse(readFileSync('src/defaults.json', 'utf8')))
      .sparks.map((spark) => spark.title)
    await fresh.driver.get(fresh.newtab)
    const shown = (): Promise<number> => fresh.driver.executeScript("return document.querySelectorAll('#sparks .Spark[data-id]').length")
    await untilIn(fresh.driver, 'the defaults', async () => (await shown()) === titles.length)
    const marks = (): Promise<string[]> =>
      fresh.driver.executeAsyncScript(`const done = arguments[0]; browser.bookmarks.getChildren('2').then(async (nodes) => {
        const root = nodes.find((node) => node.title === 'FireDial')
        done(root ? (await browser.bookmarks.getChildren(root.id)).filter((node) => !node.url.startsWith('https://firedial.invalid/')).map((node) => node.title) : [])
      })`)
    await untilIn(fresh.driver, 'the bookmarks', async () => (await marks()).length === titles.length)
    assert.deepEqual(await marks(), titles)
  } finally {
    await fresh.quit()
  }
})

test('a spark added in FireDial is a bookmark, and a bookmark edited in Chrome changes the spark', async () => {
  await addSpark('one')
  await addSpark('two')
  await until('the bookmarks', async () => (await bookmarked()).length === 2)
  assert.deepEqual(await bookmarked(), await sparkTitles())
  await run(`browser.bookmarks.getChildren('2').then(async (nodes) => {
    const root = nodes.find((node) => node.title === 'FireDial')
    const [one] = await browser.bookmarks.getChildren(root.id)
    await browser.bookmarks.update(one.id, { title: 'Renamed in Chrome' })
    done()
  })`)
  await until('the rename', async () => (await sparkTitles()).includes('Renamed in Chrome'))
})

test("Chrome's context menu has Add to FireDial with New View and Remove", async () => {
  const exists = (id: string): Promise<boolean> => run('browser.menus.update(arguments[0], {}).then(() => done(true), () => done(false))', id)
  await until('the menu', () => exists('add-root'))
  assert.equal(await exists('add-to-new-view'), true)
  assert.equal(await exists('remove-from-firedial'), true)
  assert.equal(await exists('no-such-entry'), false)
})

test('About shows the full version and offers Chrome bookmarks', async () => {
  await home()
  await click('#editToggle')
  await click('[data-action="about"]')
  assert.match(await js<string>("return document.querySelector('#aboutVersion').textContent"), /^FireDial 20\d\d\.\d{1,2}\.\d{1,2}\.\d{1,6}$/)
  assert.equal(await js<string>('return document.querySelector(\'[data-action="import-bookmarks"]\').textContent'), 'Chrome bookmarks')
})

test('Export saves the backup through Chrome', async () => {
  await home()
  await click('#editToggle')
  await click('[data-action="export"]')
  const saved = (): string[] => {
    try {
      return readdirSync(downloads).filter((name) => name.endsWith('.json'))
    } catch {
      return []
    }
  }
  await until('the file', () => Promise.resolve(saved().length === 1))
  const [file] = saved()
  assert.match(file ?? '', /^firedial_\d{4}-\d{2}-\d{2}_\d{6}\.json$/)
  const backup = z.object({ sparks: z.array(z.unknown()) }).parse(JSON.parse(readFileSync(join(downloads, file ?? ''), 'utf8')))
  assert.equal(backup.sparks.length, 2)
})

test("the search bar searches with Chrome's default engine", async () => {
  await home()
  await driver.findElement(By.id('search')).click()
  await press('firedial cats', Key.ENTER)
  await until('the search', async () => (await driver.getCurrentUrl()).includes('firedial+cats'))
})
