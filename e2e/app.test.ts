// The page as a whole, in a real Firefox: modals, backups and the notifications they end with.
// The tests build on each other, in this order, and end with everything deleted.

import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { By, Key } from 'selenium-webdriver'
import type { WebElement } from 'selenium-webdriver'
import firefox from 'selenium-webdriver/firefox.js'
import * as z from 'zod/mini'
import { installFireDial, NEWTAB, startFirefox, until as untilIn } from './firefox.ts'

const OCEAN = 'rgb(29, 78, 216)'

const server = createServer((request, response) => {
  response.setHeader('content-type', 'text/html')
  response.end(`<!doctype html><title>Page ${request.url ?? ''}</title><p id="text">hello</p>`)
}).listen(0, '127.0.0.1')

const folder = mkdtempSync(join(tmpdir(), 'firedial-e2e-'))
const downloads = join(folder, 'downloads')

let driver: firefox.Driver
let base = ''

const js = <T>(code: string, ...args: unknown[]): Promise<T> => driver.executeScript<T>(code, ...args)
const press = (...keys: string[]): Promise<void> =>
  driver
    .actions()
    .sendKeys(...keys)
    .perform()
const until = (what: string, check: () => Promise<boolean>): Promise<void> => untilIn(driver, what, check)
const click = (selector: string): Promise<void> => js('document.querySelector(arguments[0]).click()', selector)
const text = (selector: string): Promise<string> => js('return document.querySelector(arguments[0]).textContent', selector)
const sparkCount = (): Promise<number> => js("return document.querySelectorAll('#sparks .Spark[data-id]').length")
const canUndo = (): Promise<boolean> => js("return !document.querySelector('#undo').disabled")
const openDialogs = (): Promise<string[]> => js("return [...document.querySelectorAll('dialog[open]')].map((dialog) => dialog.getAttribute('aria-label'))")
const stored = <T>(key: string): Promise<T> =>
  driver.executeAsyncScript<T>('const [key, done] = arguments; browser.storage.local.get(key).then((found) => done(found[key]))', key)
const saved = (): string[] => {
  try {
    return readdirSync(downloads)
      .filter((name) => !name.endsWith('.part')) // still downloading
      .sort()
  } catch {
    return []
  }
}

async function inNotification(selector: string): Promise<WebElement> {
  await until('a notification', () => js("return document.querySelector('#firedial-toasts') !== null"))
  const root = await driver.findElement(By.css('#firedial-toasts > :last-child')).getShadowRoot()
  return root.findElement(By.css(selector))
}

const notification = async (): Promise<string> => (await inNotification('span')).getText()

const noNotification = (): Promise<boolean> => js("return document.querySelector('#firedial-toasts') === null")

async function notifications(): Promise<string[]> {
  await until('a notification', () => js("return document.querySelector('#firedial-toasts') !== null"))
  const hosts = await driver.findElements(By.css('#firedial-toasts > *'))
  return Promise.all(hosts.map(async (host) => (await (await host.getShadowRoot()).findElement(By.css('span'))).getText()))
}

const home = async (): Promise<void> => {
  await driver.get(NEWTAB)
  await until('the page', () => js("return document.querySelector('#sparks .AddSpark') !== null"))
}

async function addSpark(path: string): Promise<void> {
  const before = await sparkCount()
  await driver.findElement(By.css('#sparks .AddSpark')).click()
  await press(`${base}/${path}`, Key.ENTER)
  await until('the spark', async () => (await sparkCount()) === before + 1)
}

async function addView(name: string): Promise<void> {
  await click('#newGroup')
  await press(name, Key.ENTER)
  await until('the view', async () => (await text('.Group--active .Name')) === name)
}

// The question a view's delete asks: the view only, or its sparks too.
async function answerDelete(choice: 'view' | 'sparks'): Promise<void> {
  await until('the question', async () => (await openDialogs()).some((label) => label.startsWith('Delete ')))
  await click(`#deleteViewModal [value="${choice}"]`)
}

const edit = (): Promise<void> => click('#editToggle')

const viewNames = (): Promise<string[]> => js("return [...document.querySelectorAll('.Group .NameInput')].map((input) => input.value)")
const marked = (): Promise<number> => js("return document.querySelectorAll('.Group--marked').length")

// A real mouse box from one view row to another; from a little to the side, off the active row's name.
async function sweep(from: number, to = from): Promise<void> {
  const points = await js<number[]>(
    `
    const rows = document.querySelectorAll('.Group')
    const [start, end] = [rows[arguments[0]], rows[arguments[1]]].map((row) => row.getBoundingClientRect())
    return [start.right - 3, start.top + 3, end.right - 3, end.bottom - 3].map(Math.round)`,
    from,
    to
  )
  const [x = 0, y = 0, endX = 0, endY = 0] = points
  await driver
    .actions()
    .move({ x, y })
    .press()
    .move({ x: x - 6, y: y + 6 })
    .move({ x: endX - 6, y: endY })
    .release()
    .perform()
}

// Firefox's real dragging can't be driven from here, so the page gets its events.
const dropOnTrash = (selector: string): Promise<void> =>
  js(
    `
  const dataTransfer = new DataTransfer()
  const [item, trash] = [document.querySelector(arguments[0]), document.querySelector('#trash')]
  item.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer }))
  trash.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }))
  trash.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }))
  item.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }))`,
    selector
  )

async function about(): Promise<void> {
  await click('[data-action="about"]')
  await until('About', async () => (await openDialogs()).join() === 'FireDial')
}

async function confirmFromAbout(action: string): Promise<void> {
  await about()
  await click(`[data-action="${action}"]`)
  await driver.findElement(By.css('.Confirm input')).click()
  await driver.findElement(By.css('dialog[open] .Button--primary')).click()
}

async function importFile(content: unknown): Promise<void> {
  const file = join(folder, 'import.json')
  writeFileSync(file, JSON.stringify(content))
  await driver.findElement(By.id('importFile')).sendKeys(file)
  await until('the import to end', () => js("return !document.querySelector('#importDone').hidden"))
}

before(async () => {
  await new Promise((resolve) => server.once('listening', resolve))
  const address: string | AddressInfo | null = server.address()
  assert.ok(address !== null && typeof address === 'object')
  base = `http://127.0.0.1:${address.port}`
  driver = startFirefox({
    'browser.download.dir': downloads,
    'browser.download.folderList': 2,
    'browser.download.useDownloadDir': true,
    'browser.download.alwaysOpenPanel': false
  })
  await installFireDial(driver)
  await driver.manage().window().setRect({ width: 1400, height: 900 })
  await home()
  await addSpark('one')
  await addSpark('two')
})

after(async () => {
  await driver.quit()
  server.close()
  rmSync(folder, { recursive: true, force: true })
})

test('all seven modals are built the same', async () => {
  await home()
  const heads = await js<string[]>(`
    return [...document.querySelectorAll('dialog')].map((dialog) => {
      const flame = dialog.querySelector('.Modal__head .Modal__title use')?.getAttribute('href')
      return [dialog.className, flame, dialog.querySelectorAll('.Modal__head').length].join()
    })`)
  assert.deepEqual(heads, [
    'Modal Modal--steady,#i-flame,1',
    'Modal Modal--hero,#i-flame,1',
    'Modal Modal--steady,#i-flame,1',
    'Modal Modal--steady,#i-flame,1',
    ...Array.from({ length: 3 }, () => 'Modal,#i-flame,1')
  ])
  await edit()
  await about()
  const about_ = await js<number>("return document.querySelector('#aboutModal').getBoundingClientRect().width")
  await click('#aboutModal .Modal__close')
  await js("document.querySelector('#sparks .EditSpark').click()")
  await until('Edit', async () => (await openDialogs()).join() === 'Edit')
  assert.equal(await js("return document.querySelector('#sparkModal').getBoundingClientRect().width"), about_)
  await press(Key.ESCAPE)
})

test('the sidebar is called Settings, with an icon and a title per section', async () => {
  await home()
  await edit()
  const labels = await js<string[]>("return [...document.querySelectorAll('.Options .Setting > label')].map((label) => label.textContent)")
  assert.deepEqual(labels, ['Counts', 'Titles', 'Layout', 'Columns', 'Spacing', 'Chips', 'All and Unlabeled', 'Colors'])
  assert.equal(await text('.Options h2'), 'Settings')
  assert.deepEqual(
    await js(
      "return [...document.querySelectorAll('.Options .Section__head')].map((head) => `${head.textContent} ${head.querySelector('use').getAttribute('href')}`)"
    ),
    ['Color #i-droplet', 'Views #i-sidebar', 'Sparks #i-grid', 'Labels #i-tag', 'Backup #i-archive']
  )
  assert.equal(await js("return document.querySelector('#editToggle use').getAttribute('href')"), '#i-edit')
  assert.equal(await js("return document.querySelector('.Options').getBoundingClientRect().width"), 360)
  const done = await js<number[]>(`
    const [toggle, line] = ['#editToggle', '.Options header'].map((selector) => document.querySelector(selector).getBoundingClientRect())
    return [toggle.top, innerWidth - toggle.right, line.bottom - 1 - toggle.bottom].map(Math.round)`)
  assert.deepEqual(done, [11, 11, 11])
  const count = await js<number[]>(`
    const [row, number] = ['.Group', '.Group small'].map((selector) => document.querySelector(selector).getBoundingClientRect())
    return [number.top - row.top, row.bottom - number.bottom, row.right - number.right].map(Math.round)`)
  assert.deepEqual(count, [14, 14, 14])
  assert.equal(await js("const { scrollWidth, clientWidth } = document.querySelector('.Options__body'); return scrollWidth - clientWidth"), 0)
  const bottoms = await js<number[]>(
    "return ['.Options', '[data-action=\"about\"]'].map((selector) => document.querySelector(selector).getBoundingClientRect().bottom)"
  )
  assert.ok((bottoms[0] ?? 0) - (bottoms[1] ?? 0) < 16, 'About sits at the bottom')
  await edit()
  assert.equal(await js("return document.querySelector('#undo').checkVisibility()"), false)
})

test('the first group, sparks and setting start on one line, the logo sits level with the search bar', async () => {
  await home()
  await edit()
  const tops = await js<number[]>(
    "return ['.Group', '#sparks .Spark', '[data-setting=\"theme\"]'].map((selector) => Math.round(document.querySelector(selector).getBoundingClientRect().top))"
  )
  assert.deepEqual(tops, [140, 140, 140])
  const middles = await js<number[]>(`
    return ['.Logo', '.Logo svg', '.Search'].map((selector) => {
      const { top, bottom } = document.querySelector(selector).getBoundingClientRect()
      return Math.round((top + bottom) / 2)
    })`)
  assert.deepEqual(middles, [70, 70, 70])
  const room = await js<number[]>(`
    const [search, sparks] = ['.Search', '#sparks'].map((selector) => document.querySelector(selector).getBoundingClientRect())
    return [search.top, sparks.top - search.bottom].map(Math.round)`)
  assert.deepEqual(room, [46, 46])
  await edit()
})

test('the search bar stays clear of the Edit button in a narrow window', async () => {
  await home()
  await driver.manage().window().setRect({ width: 900, height: 900 })
  await until('the narrow page', () => js('return innerWidth < 1000'))
  const gap = await js<number>(
    "return document.querySelector('#editToggle').getBoundingClientRect().left - document.querySelector('.Search').getBoundingClientRect().right"
  )
  await driver.manage().window().setRect({ width: 1400, height: 900 })
  assert.ok(gap > 0, `${gap}`)
})

test('in the slim layout, the search box fills its place, so its suggestions line up with it', async () => {
  await home()
  await driver.manage().window().setRect({ width: 640, height: 600 })
  await until('the slim page', () => js("return getComputedStyle(document.querySelector('#groupPick')).display !== 'none'"))
  const edges = await js<string[]>(
    "return ['.SearchWrap', '.Search'].map((selector) => { const { left, right, top } = document.querySelector(selector).getBoundingClientRect(); return [left, right, top].join() })"
  )
  await driver.manage().window().setRect({ width: 1400, height: 900 })
  assert.equal(edges[0], edges[1])
})

test('the page is set in Onest, from the extension', async () => {
  await home()
  await until('the font', () => js("return [...document.fonts].some((face) => face.family === 'Onest' && face.status === 'loaded')"))
  const families = await js<string[]>(
    "return ['body', '#search', '#editToggle'].map((selector) => getComputedStyle(document.querySelector(selector)).fontFamily)"
  )
  for (const family of families) assert.match(family, /^Onest,/)
})

test('Delete, Done, Undo and Export have one shape', async () => {
  await home()
  await edit()
  const shapes = await js<string[]>(`
    return ['#trash', '#editToggle', '#history', '[data-action="export"]'].map((selector) => {
      const node = document.querySelector(selector)
      return [getComputedStyle(node).borderTopLeftRadius, node.getBoundingClientRect().height].join()
    })`)
  assert.deepEqual(
    shapes,
    Array.from({ length: 4 }, () => '12px,40')
  )
  await edit()
})

test('the spark modal has sections like the sidebar, and says Add for a new spark', async () => {
  await home()
  await driver
    .actions()
    .contextClick(driver.findElement(By.id('main')))
    .perform()
  await js("[...document.querySelectorAll('.ContextMenu__item')].find((item) => item.textContent === 'New spark').click()")
  await until('Add spark', async () => (await openDialogs()).join() === 'Add spark')
  const buttons = (): Promise<string[]> =>
    js("return [...document.querySelectorAll('#sparkModal .Modal__actions button')].filter((button) => !button.hidden).map((button) => button.textContent)")
  assert.deepEqual(await buttons(), ['Cancel', 'Add'])
  assert.deepEqual(
    await js(
      "return [...document.querySelectorAll('#sparkModal .Section__head')].map((head) => `${head.textContent} ${head.querySelector('use').getAttribute('href')}`)"
    ),
    ['Preview #i-image', 'Spark #i-grid', 'Labels #i-tag']
  )
  assert.deepEqual(
    await js(
      "return [...document.querySelectorAll('#sparkModal .Field')].map((field) => [field.textContent, field.querySelector('input').placeholder].join())"
    ),
    [',Title', ',URL']
  )
  assert.equal(await text('[data-action="clear-thumb"]'), 'Clear')
  const edges = await js<string[]>(`
    return ['.Drop', '[data-action="upload"]', '.Field .Input'].map((selector) => {
      const { left, right } = document.querySelector('#sparkModal ' + selector).getBoundingClientRect()
      return selector === '[data-action="upload"]' ? left : [left, right].join()
    })`)
  assert.equal(edges[0], edges[2])
  assert.equal(String(edges[0]).split(',')[0], String(edges[1]))
  await press(Key.ESCAPE)
  await edit()
  await js("document.querySelector('#sparks .EditSpark').click()")
  await until('Edit', async () => (await openDialogs()).join() === 'Edit')
  assert.deepEqual(await buttons(), ['Cancel', 'Save'])
  const apart = await js<number[]>(`
    const [above, actions, dialog] = ['#sparkModal .Modal__body', '#sparkModal .Modal__actions', '#sparkModal'].map((selector) => document.querySelector(selector).getBoundingClientRect())
    return [actions.top - above.bottom, dialog.bottom - actions.bottom].map(Math.round)`)
  assert.deepEqual(apart, [32, 25], 'the buttons apart from what scrolls, and in sight at the bottom')
  await press(Key.ESCAPE)
  await edit()
})

test('in Edit, the group sidebar is resized by dragging its edge or with the arrow keys', async () => {
  await home()
  const width = (): Promise<number> => js("return document.querySelector('.Rail').getBoundingClientRect().width")
  const handle = (): Promise<number[]> =>
    js(
      "const box = document.querySelector('#railResize').getBoundingClientRect(); return [Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2), box.width]"
    )
  const drag = async (by: number): Promise<void> => {
    const [x = 0, y = 0] = await handle()
    await driver
      .actions()
      .move({ x, y })
      .press()
      .move({ x: x + by / 2, y })
      .move({ x: x + by, y })
      .release()
      .perform()
  }
  assert.equal(await width(), 236)
  assert.equal((await handle())[2], 0, 'no handle outside Edit')
  assert.equal(await js("return document.querySelector('#groupWidth')"), null, 'no Width slider')
  await edit()
  await drag(60)
  await until('the wider rail', async () => (await width()) === 296)
  await until('the setting', async () => (await stored<{ groupWidth: number }>('prefs')).groupWidth === 296)
  await drag(-200)
  await until('the narrowest rail', async () => (await width()) === 180)
  const [x = 0] = await handle()
  const top = await js<number>("return Math.round(document.querySelector('.Group').getBoundingClientRect().y + 10)")
  await driver
    .actions()
    .move({ x, y: top })
    .press()
    .move({ x: x - 100, y: top + 60 })
    .move({ x: x - 150, y: top + 120 })
    .release()
    .perform()
  assert.equal(await marked(), 0, 'dragging the edge selects no groups')
  assert.ok(
    await js(
      "const [logo, head] = ['.Logo', '.RailHead'].map((selector) => document.querySelector(selector).getBoundingClientRect()); return logo.right <= head.right - 8"
    ),
    'the logo fits'
  )
  await js("document.querySelector('#railResize').focus()")
  await driver.actions().keyDown(Key.SHIFT).sendKeys(Key.ARROW_RIGHT).keyUp(Key.SHIFT).perform()
  await until('50px more', async () => (await width()) === 230)
  await until('the setting', async () => (await stored<{ groupWidth: number }>('prefs')).groupWidth === 230)
  await home()
  assert.equal(await width(), 230)
  await edit()
  await js("document.querySelector('#railResize').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))")
  await until('the default width', async () => (await width()) === 236)
  await edit()
})

test('About ends with the version, the address and the licenses, and warns in the selected color', async () => {
  await home()
  await edit()
  await about()
  const lines = await js<string[]>("return [...document.querySelector('.Modal__foot').children].map((line) => line.textContent)")
  assert.match(lines[0] ?? '', /^FireDial 20\d\d\.\d{1,2}\.\d{1,2}\.\d{1,4}$/)
  assert.equal(lines[1], 'github.com/sebastianstucke87/FireDial')
  assert.equal(lines[2], 'Licenses')
  const license = await driver.executeAsyncScript<string>(
    'const done = arguments[0]; fetch(document.querySelector(\'.Modal__foot a[href="LICENSES.txt"]\').href).then((response) => response.text()).then(done)'
  )
  assert.match(
    license,
    /^FireDial\n\nMIT License\n\nCopyright \(c\) 2026 Sebastian Stucke[\s\S]*\n\nzod\n\nMIT License\n\nCopyright \(c\) 2025 Colin McDonnell[\s\S]*\n\nOnest font\n\nCopyright 2021 The Onest Project Authors[\s\S]*SIL OPEN FONT LICENSE/
  )
  const warnings = await js<string[]>(
    "return [...document.querySelectorAll('.Button--warn')].map((button) => `${button.textContent} ${button.querySelector('use').getAttribute('href')}`)"
  )
  assert.deepEqual(warnings, ['Import #i-alert', 'Delete all #i-alert', 'Start over #i-alert', 'View and sparks #i-alert'])
  assert.ok(
    await js("return [...document.querySelectorAll('#aboutModal .Button--warn')].every((button) => button.getBoundingClientRect().height === 40)"),
    'each label on one line'
  )
  assert.deepEqual(
    await js(
      "return [...new Set([...document.querySelectorAll('#aboutModal .Buttons:has([data-action=ask-start-over]) .Button')].flatMap((button) => { const box = button.getBoundingClientRect(); return [`top ${Math.round(box.top)}`, `width ${Math.round(box.width)}`] }))].length"
    ),
    2,
    'the resets in one row, all as wide'
  )
  assert.ok(
    await js("return [...document.querySelectorAll('#aboutModal .Buttons .Button')].every((button) => button.scrollWidth <= button.clientWidth)"),
    'every label fits its button'
  )
  assert.equal(
    await js("return new Set([...document.querySelectorAll('#aboutModal .Keys dd')].map((dd) => Math.round(dd.getBoundingClientRect().left))).size"),
    1,
    'the descriptions of both hotkey lists line up'
  )
  assert.ok(
    await js("return [...document.querySelectorAll('#aboutModal .Keys dt')].every((dt) => dt.scrollWidth <= dt.clientWidth)"),
    'every key fits its column'
  )
  assert.deepEqual(
    await js(
      "return [...document.querySelectorAll('#aboutModal .Section__head')].map((head) => `${head.textContent} ${head.querySelector('use').getAttribute('href')}`)"
    ),
    ['Hotkeys #i-keyboard', 'Hotkeys in Edit #i-edit', 'Import #i-archive', 'Resets #i-undo']
  )
  assert.ok(await js("return document.querySelector('#aboutModal .Divider').nextElementSibling.matches('.Modal__foot')"))
  await press(Key.ESCAPE)
  await click('[data-setting="theme"] [data-value="dark"]')
  await click('[data-setting="color"] [data-value="ocean"]')
  await until('the color', () => js("return document.documentElement.dataset.color === 'ocean'"))
  await until('the mark', async () => (await js<string>("return getComputedStyle(document.querySelector('.Button--warn')).borderTopColor")) === OCEAN)
  assert.equal(await js("return getComputedStyle(document.querySelector('.Button--warn .icon')).color"), OCEAN)
  await click('[data-setting="theme"] [data-value="system"]')
  await click('[data-setting="color"] [data-value="firedial"]')
  await until('the color again', () => js("return document.documentElement.dataset.color === 'firedial'"))
})

test("Esc closes a modal and nothing else, and the page's menu has no Edit", async () => {
  await home()
  await edit()
  await about()
  await press(Key.ESCAPE)
  await until('About to close', async () => (await openDialogs()).length === 0)
  assert.ok(await js("return document.body.classList.contains('editing')"))
  await driver
    .actions()
    .contextClick(driver.findElement(By.id('main')))
    .perform()
  const entries = (): Promise<string[]> => js("return [...document.querySelectorAll('.ContextMenu__item')].map((item) => item.textContent)")
  assert.deepEqual(await entries(), ['New spark', 'New view', 'Done'])
  await js("[...document.querySelectorAll('.ContextMenu__item')].find((item) => item.textContent === 'Done').click()")
  assert.ok(await js("return !document.body.classList.contains('editing')"), 'Done leaves Edit')
  await driver
    .actions()
    .contextClick(driver.findElement(By.id('main')))
    .perform()
  assert.deepEqual(await entries(), ['New spark', 'New view', 'Edit'])
  await js("[...document.querySelectorAll('.ContextMenu__item')].find((item) => item.textContent === 'Edit').click()")
  assert.ok(await js("return document.body.classList.contains('editing')"), 'Edit opens Edit')
  await edit()
})

test('a question replaces About instead of covering it, and Cancel brings it back', async () => {
  await home()
  await edit()
  await about()
  await click('[data-action="ask-delete-everything"]')
  assert.deepEqual(await openDialogs(), ['Delete all'])
  assert.equal(await js("return document.querySelector('dialog[open] .Modal__actions').firstElementChild.textContent"), 'Cancel')
  await click('dialog[open] [data-close].Button')
  await until('About again', async () => (await openDialogs()).join() === 'FireDial')
  await click('[data-action="ask-reset-settings"]')
  assert.deepEqual(await openDialogs(), ['Reset settings'])
  await press(Key.ESCAPE)
  await until('About again', async () => (await openDialogs()).join() === 'FireDial')
})

test('Esc takes back what was typed in place', async () => {
  await home()
  await driver.findElement(By.css('#sparks .AddSpark')).click()
  await press('example.com', Key.ESCAPE)
  await until('the plus again', () => js("return document.querySelector('.AddSpark input') === null"))
  assert.equal(await sparkCount(), 2)
  await click('#newGroup')
  assert.equal(await js("return document.querySelector('.NewGroupInput').placeholder"), 'Name view')
  await press('Nothing', Key.ESCAPE)
  await until('the button again', () => js("return document.querySelector('#newGroup') !== null"))
  assert.equal(await js("return document.querySelectorAll('.Group').length"), 2)
  await edit()
  await driver.findElement(By.css('.Group .NameInput')).click()
  await press('Renamed', Key.ESCAPE)
  assert.equal(await js("return document.querySelector('.Group .NameInput').value"), 'All')
  assert.equal((await stored<{ title: string }[]>('views'))[0]?.title, 'All')
})

test('Reset settings leaves the sparks, and needs no notification: it shows', async () => {
  await home()
  await edit()
  await click('[data-setting="color"] [data-value="ocean"]')
  await until('the color', () => js("return document.documentElement.dataset.color === 'ocean'"))
  await confirmFromAbout('ask-reset-settings')
  await until('the color back', () => js("return document.documentElement.dataset.color === 'firedial'"))
  assert.equal(await sparkCount(), 2)
  assert.ok(await noNotification())
})

test('Export names the file and says where it went', async () => {
  await home()
  await edit()
  await click('[data-action="export"]')
  const message = await notification()
  const place = await js<number[]>(`
    const [stack, options, history] = ['#firedial-toasts', '.Options', '#history'].map((selector) => document.querySelector(selector).getBoundingClientRect())
    const main = document.querySelector('#main')
    return [options.left - stack.right - (main.offsetWidth - main.clientWidth), history.top - stack.bottom].map(Math.round)`)
  assert.deepEqual(place, [24, 12], 'clear of the scrollbar gutter')
  const [file] = saved()
  assert.match(file ?? '', /^firedial_\d{4}-\d{2}-\d{2}_\d{6}\.json$/)
  assert.equal(message, 'Backup exported')
  const backup: unknown = JSON.parse(readFileSync(join(downloads, file ?? ''), 'utf8'))
  assert.ok(typeof backup === 'object' && backup !== null && 'sparks' in backup && Array.isArray(backup.sparks) && backup.sparks.length === 2)
})

test('a drop on a view adds the sparks there too, and says so', async () => {
  await home()
  await addView('Elsewhere')
  await js("document.querySelector('.Group').click()")
  await until('two sparks', async () => (await sparkCount()) === 2)
  await edit()
  await js(`
    const dataTransfer = new DataTransfer()
    const [tile, view] = [document.querySelector('#sparks .Spark[data-id]'), document.querySelectorAll('.Group')[2]]
    tile.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer }))
    view.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }))
    view.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }))`)
  assert.equal(await notification(), 'Added 1 spark to Elsewhere')
  assert.equal(await sparkCount(), 2, 'still in All')
  await js("document.querySelectorAll('.Group')[2].click()")
  await until('one spark in Elsewhere', async () => (await sparkCount()) === 1)
  await js("document.querySelector('#sparks .EditSpark').click()")
  await until('Edit', async () => (await openDialogs()).join() === 'Edit')
  assert.deepEqual(await js("return [...document.querySelectorAll('#sparkLabels .Chip')].map((chip) => chip.textContent)"), ['Elsewhere'])
  await press(Key.ESCAPE)
  await edit()
})

test('what the context menu does out of sight gets a notification', async () => {
  await home()
  await js("document.querySelectorAll('.Group')[2].click()")
  await until('one spark', async () => (await sparkCount()) === 1)
  const menu = async (selector: string, label: string): Promise<void> => {
    await driver
      .actions()
      .contextClick(driver.findElement(By.css(selector)))
      .perform()
    await js("[...document.querySelectorAll('.ContextMenu__item')].find((item) => item.textContent === arguments[0]).click()", label)
  }
  await menu('#sparks .Spark[data-id]', 'Copy URL')
  assert.equal(await notification(), 'URL copied')
  await menu('.Group:nth-child(3)', 'Open all')
  await until('the tab', async () => (await driver.getAllWindowHandles()).length === 2)
  assert.equal(await notification(), 'Opened 1 tab')
  const [current, ...opened] = await driver.getAllWindowHandles()
  assert.ok(current)
  for (const handle of opened) {
    await driver.switchTo().window(handle)
    await driver.close()
  }
  await driver.switchTo().window(current)
  await menu('.Group:nth-child(3)', 'Delete')
  await answerDelete('view')
  await until('the view to go', () => js("return document.querySelectorAll('.Group').length === 2"))
  assert.equal(await sparkCount(), 2, 'its spark stays')
})

test("All and Unlabeled can't be deleted, only renamed", async () => {
  await home()
  await driver
    .actions()
    .contextClick(driver.findElement(By.css('.Group')))
    .perform()
  assert.deepEqual(await js("return [...document.querySelectorAll('.ContextMenu__item')].map((item) => item.textContent)"), ['Open all', 'Rename'])
  await press(Key.ESCAPE)
  await edit()
})

test('at the end of a long group, the last row clears the bars by the same 20 px they keep from the edge', async () => {
  await home()
  await edit()
  await driver.manage().window().setRect({ width: 1400, height: 400 })
  await js(`
    const sparks = document.querySelector('#sparks')
    sparks.style.gridTemplateColumns = '1fr' // a long group, whatever this one holds
    sparks.style.rowGap = '300px'
    const main = document.querySelector('#main')
    main.scrollTop = main.scrollHeight
    dispatchEvent(new Event('resize'))`)
  const place = await js<number[]>(`
    const [tile, bars, content, history] = ['#sparks > :last-child', '#trash', '.Content', '#history'].map((selector) => document.querySelector(selector).getBoundingClientRect())
    return [bars.top - tile.bottom, content.bottom - bars.bottom, history.right - tile.right].map(Math.round)`)
  await driver.manage().window().setRect({ width: 1400, height: 900 })
  assert.deepEqual(place, [20, 20, 0])
  await edit()
})

test('the columns follow the window: a wide one fits more', async () => {
  await home()
  await edit()
  const limit = (): Promise<string> => js("return document.querySelector('#columns').max")
  const columns = (): Promise<number> => js("return getComputedStyle(document.querySelector('#sparks')).gridTemplateColumns.split(' ').length")
  await until('the limit', async () => (await limit()) === '4')
  await driver.manage().window().setRect({ width: 2600, height: 900 })
  await until('the wide limit', async () => (await limit()) === '8')
  await js(`
    const input = document.querySelector('#columns')
    input.value = 8
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))`)
  await until('eight columns', async () => (await columns()) === 8)
  await edit()
  await until('eight columns out of Edit too', async () => (await columns()) === 8)
  await driver.manage().window().setRect({ width: 1400, height: 900 })
  await until('four columns again', async () => (await columns()) === 4)
  assert.equal((await stored<{ columns: number }>('prefs')).columns, 8)
})

test('Import asks first, then opens the file picker with the click still counting', async () => {
  await home()
  await edit()
  await js(`
    document.querySelector('#importFile').addEventListener('click', (event) => {
      event.preventDefault() // no real file dialog in the test
      window.pickerAllowed = navigator.userActivation.isActive
    })`)
  await click('[data-action="import"]')
  assert.deepEqual(await openDialogs(), ['Import'])
  await click('dialog[open] [data-close].Button')
  await until('the question to close', async () => (await openDialogs()).length === 0)
  assert.equal(await js('return window.pickerAllowed'), null)
  await click('[data-action="import"]')
  await driver.findElement(By.css('.Confirm input')).click()
  await driver.findElement(By.css('dialog[open] .Button--primary')).click()
  await until('the picker', () => js('return window.pickerAllowed !== undefined'))
  assert.equal(await js('return window.pickerAllowed'), true)
})

test('Import saves a backup first, stays in the selected color, sums up and leaves nothing to undo', async () => {
  await home()
  await edit()
  await click('[data-setting="color"] [data-value="ocean"]')
  await until('the color', () => js("return document.documentElement.dataset.color === 'ocean'"))
  assert.ok(await canUndo())
  const before = saved()
  await importFile({
    format: 'firedial',
    prefs: { color: 'teal' },
    views: [
      { kind: 'normal', title: 'A', order: [0] },
      { kind: 'normal', title: 'B', sort: 'manual', order: [2, 1] }
    ],
    sparks: [
      { id: 0, title: 'a', url: `${base}/a`, labels: ['A'] },
      { id: 1, title: 'b', url: `${base}/b`, labels: ['B'] },
      { id: 2, title: 'c', url: `${base}/c`, labels: ['B'] }
    ]
  })
  const file = saved().find((name) => !before.includes(name))
  assert.match(file ?? '', /^firedial_\d{4}-\d{2}-\d{2}_\d{6}_autobackup\.json$/)
  assert.deepEqual(await openDialogs(), ['Import complete'])
  assert.equal(await text('#importDetail'), 'Imported 2 views with 3 sparks')
  assert.equal(await text('#importDone'), 'Done')
  const colors = await js<string[]>(`
    const modal = document.querySelector('#importModal')
    return [getComputedStyle(modal.querySelector('.Modal__title .icon')).color, getComputedStyle(modal.querySelector('#importDone')).borderTopColor]`)
  assert.deepEqual(colors, [OCEAN, OCEAN])
  await click('#importDone')
  await until('the imported color', () => js("return document.documentElement.dataset.color === 'teal'"))
  await until('the sparks', async () => (await sparkCount()) === 3)
  assert.equal(await canUndo(), false)
  await js("document.querySelectorAll('.Group')[3].click()")
  await until(
    'B in its own order',
    async () =>
      (await js<string[]>("return [...document.querySelectorAll('#sparks .Spark[data-id] .Title')].map((title) => title.textContent)")).join() === 'c,b'
  )
})

test('a file without sparks changes nothing, and a broken one says so', async () => {
  await home()
  await edit()
  const before = saved()
  await importFile({ format: 'firedial', views: [{ kind: 'normal', title: 'Empty' }], sparks: [] })
  assert.deepEqual(await openDialogs(), ['Import failed'])
  assert.match(await text('#importDetail'), /no sparks/)
  assert.equal(await text('#importDone'), 'Close')
  await click('#importDone')
  await home()
  assert.deepEqual(saved(), before)
  assert.equal((await stored<unknown[]>('sparks')).length, 3)
})

test('Delete everything saves a backup first, then takes the bookmarks along', async () => {
  await home()
  await edit()
  const before = saved()
  await confirmFromAbout('ask-delete-everything')
  await until('everything gone', async () => (await stored<unknown[]>('sparks')).length === 0)
  assert.deepEqual(await notifications(), ['Backup saved'])
  const file = saved().find((name) => !before.includes(name))
  assert.match(file ?? '', /_autobackup(\(\d+\))?\.json$/) // (1): the same second as the last one
  const backup: unknown = JSON.parse(readFileSync(join(downloads, file ?? ''), 'utf8'))
  assert.ok(typeof backup === 'object' && backup !== null && 'sparks' in backup && Array.isArray(backup.sparks) && backup.sparks.length === 3)
  assert.equal((await stored<unknown[]>('sparks')).length, 0)
  const bookmarks = (): Promise<number> =>
    driver.executeAsyncScript(`
    const done = arguments[arguments.length - 1]
    browser.bookmarks.search({ title: 'FireDial' }).then(async ([root]) => done(root ? (await browser.bookmarks.getSubTree(root.id))[0].children.flatMap((node) => node.children ?? [node]).filter((node) => node.url && !node.url.startsWith('https://firedial.invalid/')).length : 0))`)
  await until('the bookmarks to go', async () => (await bookmarks()) === 0)
  await edit()
  assert.equal(await canUndo(), false)
  await edit()
})

test('Start over saves a backup, then brings back the sparks, views and settings FireDial comes with', async () => {
  const defaults = z
    .object({ views: z.array(z.object({ title: z.string() })), sparks: z.array(z.object({ title: z.string() })) })
    .parse(JSON.parse(readFileSync('src/defaults.json', 'utf8')))
  await home()
  await edit()
  await click('[data-setting="counts"] [data-value="off"]')
  await until('the setting', () => js("return document.documentElement.dataset.counts === 'off'"))
  const before = saved().length
  await confirmFromAbout('ask-start-over')
  await until('the defaults', async () => (await stored<unknown[]>('sparks')).length === defaults.sparks.length)
  assert.deepEqual(await notifications(), ['Backup saved'])
  await until('the backup', () => Promise.resolve(saved().length === before + 1))
  assert.deepEqual(
    (await stored<{ title: string }[]>('views')).map((view) => view.title),
    defaults.views.map((view) => view.title)
  )
  assert.equal((await stored<unknown[]>('sparks')).length, defaults.sparks.length)
  assert.equal((await stored<{ showCounts: boolean }>('prefs')).showCounts, true)
  assert.ok(await js("return !document.body.classList.contains('editing')"), 'out of Edit')
  await edit()
  assert.equal(await canUndo(), false)
  const backups = saved().length
  await confirmFromAbout('ask-delete-everything')
  await notification()
  await until('the backup', () => Promise.resolve(saved().length === backups + 1)) // before the next test counts them
  const left = (): Promise<number> =>
    driver.executeAsyncScript(`
    const done = arguments[arguments.length - 1]
    browser.bookmarks.search({ title: 'FireDial' }).then(async ([root]) => done(root ? (await browser.bookmarks.getSubTree(root.id))[0].children.flatMap((node) => node.children ?? [node]).filter((node) => node.url && !node.url.startsWith('https://firedial.invalid/')).length : 0))`)
  await until('the bookmarks to go', async () => (await left()) === 0 && (await stored<unknown[]>('sparks')).length === 0) // still syncing the ones it brought back
  await edit()
})

test('a fresh FireDial has nothing to back up, until something changed', async () => {
  await home()
  await edit()
  const before = saved()
  await importFile({ format: 'firedial', views: [{ kind: 'normal', title: 'A' }], sparks: [{ id: 0, title: 'a', url: `${base}/a`, labels: ['A'] }] })
  assert.deepEqual(await openDialogs(), ['Import complete'])
  await click('#importDone')
  assert.deepEqual(saved(), before)
  await confirmFromAbout('ask-delete-everything')
  assert.deepEqual(await notifications(), ['Backup saved'])
  await until('the backup', () => Promise.resolve(saved().length === before.length + 1))
  await home()
  await edit()
  await confirmFromAbout('ask-delete-everything')
  await until('the question gone', async () => (await openDialogs()).length === 0)
  assert.ok(await noNotification(), 'no backup')
  assert.equal(saved().length, before.length + 1)
  await home()
  await edit()
  await click('[data-setting="counts"] [data-value="off"]')
  await until('the setting', () => js("return document.documentElement.dataset.counts === 'off'"))
  await confirmFromAbout('ask-delete-everything')
  assert.deepEqual(await notifications(), ['Backup saved'])
})

test('another open tab has nothing left to undo either', async () => {
  await home()
  await edit()
  await click('[data-setting="counts"] [data-value="off"]')
  await until('the step', canUndo)
  const first = await driver.getWindowHandle()
  await driver.switchTo().newWindow('tab')
  await home()
  await edit()
  await confirmFromAbout('ask-delete-everything')
  await notification()
  await driver.close()
  await driver.switchTo().window(first)
  await until('the other tab to follow', async () => !(await canUndo()))
  await edit()
})

test("Delete counts what's selected", async () => {
  await home()
  await addSpark('first')
  await addSpark('second')
  await edit()
  await js("document.querySelector('#sparks .Spark[data-id]').click()")
  assert.equal(await text('#trash'), 'Delete 1')
  assert.equal(await js("return getComputedStyle(document.querySelector('.Spark--selected'), '::before').content"), 'none')
  const bars = await js<number[]>(`
    const [delete_, history, sparks] = ['#trash', '#history', '.Content'].map((selector) => document.querySelector(selector).getBoundingClientRect())
    const main = document.querySelector('#main')
    return [delete_.height - history.height, delete_.top - history.top, delete_.left - sparks.left, sparks.right - history.right - (main.offsetWidth - main.clientWidth)].map(Math.round)`)
  assert.deepEqual(bars, [0, 0, 24, 24], 'clear of the scrollbar gutter')
  assert.equal(await js("return getComputedStyle(document.querySelector('#trash')).borderTopStyle"), 'solid')
  const inner = await js<(number | string)[]>(`
    const [history, undo, setting] = ['#history', '#undo', '[data-setting="counts"] button'].map((selector) => document.querySelector(selector))
    const [outer, button, other] = [history, undo, setting].map((node) => node.getBoundingClientRect())
    return [button.top - outer.top, button.height, getComputedStyle(undo).borderTopWidth, setting.parentElement.getBoundingClientRect().top - other.top + (button.top - outer.top), other.height, getComputedStyle(setting).borderTopWidth]`)
  assert.deepEqual(inner, [3, 34, '0px', 0, 34, '0px'])
  assert.deepEqual(await js("return [...document.querySelectorAll('#history button')].map((button) => button.textContent)"), ['Undo', 'Redo'])
  await js("document.querySelectorAll('#sparks .Spark[data-id]')[1].click()")
  assert.equal(await text('#trash'), 'Delete 2')
  await click('#trash')
  await until('the sparks to go', async () => (await sparkCount()) === 0)
  await edit()
})

test('a box marks views like sparks, and a click on a view still shows it', async () => {
  await home()
  await addView('Keep')
  await addSpark('kept')
  await addView('Gone')
  await addSpark('gone')
  await addSpark('gone-too')
  await js("document.querySelector('.Group').click()")
  await edit()
  assert.equal(await js("return document.querySelectorAll('.GroupDelete').length"), 0)
  const gone = (await viewNames()).indexOf('Gone')
  await sweep(gone)
  assert.equal(await marked(), 1)
  assert.equal(await js("return document.querySelector('.Group--active .NameInput').value"), (await viewNames())[0])
  assert.equal(await text('#trash'), 'Delete 1')
  await click('#undo')
  assert.equal(await marked(), 0)
  await click('#redo')
  assert.equal(await marked(), 1)
  await press(Key.ESCAPE)
  assert.equal(await marked(), 0)
  assert.ok(await js("return document.body.classList.contains('editing')"))
  await sweep(gone)
  await js("document.querySelectorAll('.Group')[arguments[0]].click()", 1)
  assert.equal(await marked(), 1, "showing a view keeps what's marked")
  await press(Key.ESCAPE)
  await js("document.querySelector('.Group').click()")
  await edit()
})

test('Del and the bar delete marked views after asking, and All and Unlabeled stay', async () => {
  await home()
  await js("document.querySelector('.Group').click()")
  await edit()
  const all = await viewNames()
  const gone = all.indexOf('Gone')
  const sparks = await sparkCount()
  await sweep(gone)
  await js("document.querySelector('#sparks .Spark[data-id]').click()")
  assert.equal(await text('#trash'), 'Delete 2')
  await click('#trash')
  await answerDelete('view')
  await until('the view to go', async () => (await viewNames()).length === all.length - 1)
  await until('the spark to go', async () => (await sparkCount()) === sparks - 1)
  await click('#undo')
  await until('the view to return', async () => (await viewNames()).length === all.length)
  await until('the marks to clear', async () => (await marked()) === 0)
  await sweep(gone)
  await press(Key.DELETE)
  await answerDelete('sparks')
  await until('the view and its sparks to go', async () => (await viewNames()).length === all.length - 1 && (await sparkCount()) === sparks - 2)
  await click('#undo')
  await until('the view to return', async () => (await viewNames()).length === all.length)
  await sweep(0, all.length - 1)
  assert.equal(await marked(), all.length)
  await click('#trash')
  await answerDelete('view')
  await until('All and Unlabeled alone', async () => (await viewNames()).join() === 'All,Unlabeled')
  await click('#undo')
  await until('the views to return', async () => (await viewNames()).length === all.length)
  await edit()
})

test("the trash takes one spark, a selection, one view or all that's marked", async () => {
  await home()
  await js("document.querySelector('.Group').click()")
  await edit()
  const place = await js<number[]>(`
    const [trash, content] = ['#trash', '.Content'].map((selector) => document.querySelector(selector).getBoundingClientRect())
    return [trash.left - content.left, content.bottom - trash.bottom].map(Math.round)`)
  assert.deepEqual(place, [24, 20])
  assert.equal(await text('#trash'), 'Delete')
  assert.equal(await js("return getComputedStyle(document.querySelector('#trash')).borderTopStyle"), 'dashed')
  await js("document.querySelector('.Group .Handle').dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: new DataTransfer() }))")
  assert.equal(await text('#trash'), 'Drop to delete')
  await js("document.dispatchEvent(new DragEvent('dragend', { bubbles: true }))")
  assert.equal(await text('#trash'), 'Delete')
  const all = await viewNames()
  const show = async (name: string, sparks: number): Promise<void> => {
    await js("document.querySelectorAll('.Group')[arguments[0]].click()", (await viewNames()).indexOf(name))
    await until('the sparks', async () => (await sparkCount()) === sparks)
  }
  await show('Gone', 2)
  await dropOnTrash('#sparks .Spark[data-id]')
  await until('one spark to go', async () => (await sparkCount()) === 1)
  assert.equal(await js("return document.body.classList.contains('dragging')"), false)
  await click('#undo')
  await until('the spark to return', async () => (await sparkCount()) === 2)
  await driver.actions().keyDown(Key.CONTROL).sendKeys('a').keyUp(Key.CONTROL).perform()
  await dropOnTrash('#sparks .Spark[data-id]')
  await until('the selection to go', async () => (await sparkCount()) === 0)
  await click('#undo')
  await until('the selection to return', async () => (await sparkCount()) === 2)
  await show('Keep', 1)
  await dropOnTrash('#groups .Group:last-child .Handle')
  await answerDelete('view')
  await until('the unmarked view to go', async () => (await viewNames()).length === all.length - 1)
  await click('#undo')
  await until('the view to return', async () => (await viewNames()).length === all.length)
  await js("document.querySelector('.Group').click()")
  await sweep((await viewNames()).indexOf('Keep'), (await viewNames()).indexOf('Gone'))
  assert.equal(await marked(), 2)
  await dropOnTrash('#groups .Group:last-child .Handle')
  await answerDelete('view')
  await until('both views to go', async () => (await viewNames()).length === all.length - 2)
  await click('#undo')
  await until('both to return', async () => (await viewNames()).length === all.length)
  await click('[data-action="trash"]')
  assert.equal(await notification(), 'Drag sparks or views here to delete them')
  await edit()
})

test('a selection lost by a misclick comes back with Undo, and Redo takes it away again', async () => {
  await home()
  await addView('Misclick')
  await addSpark('third')
  await addSpark('fourth')
  await edit()
  const stepsBefore = (await stored<{ cursor: number }>('history')).cursor
  await driver.actions().keyDown(Key.CONTROL).sendKeys('a').keyUp(Key.CONTROL).perform()
  assert.equal(await text('#trash'), 'Delete 2')
  await press(Key.ESCAPE)
  assert.equal(await text('#trash'), 'Delete')
  await click('#undo')
  assert.equal(await text('#trash'), 'Delete 2')
  await click('#redo')
  assert.equal(await text('#trash'), 'Delete')
  await click('#undo')
  await click('#undo')
  assert.equal(await text('#trash'), 'Delete')
  assert.equal((await stored<{ cursor: number }>('history')).cursor, stepsBefore)
  await click('#undo')
  await until('the real undo', async () => (await sparkCount()) === 1)
  await edit()
})

test('Edit stays in one place, open or closed', async () => {
  await home()
  const place = (): Promise<number[]> => js("const { left, top } = document.querySelector('#editToggle').getBoundingClientRect(); return [left, top]")
  const before = await place()
  await edit()
  await until('Done', async () => (await text('#editToggle')) === 'Done')
  assert.deepEqual(await place(), before)
  await edit()
})

test('the search bar and its list are one shape, like the dropdown', async () => {
  await home()
  await press('/', 'one')
  await until('the list', () => js("return !document.querySelector('#suggest').hidden"))
  const box = await js<(number | string)[]>(`
    const [bar, list] = [document.querySelector('.Search'), document.querySelector('#suggest')]
    const [a, b] = [bar.getBoundingClientRect(), list.getBoundingClientRect()]
    return [b.top - a.bottom, b.left - a.left, b.width - a.width, getComputedStyle(bar).borderBottomLeftRadius, getComputedStyle(list).borderTopWidth]`)
  assert.deepEqual(box, [-2, 0, 0, '0px', '0px'])
  await press(Key.ESCAPE)
})

test("in Edit the spark's pen is a strip along its right side, in every layout", async () => {
  await home()
  await addSpark('strip')
  await edit()
  for (const layout of ['wide', 'tiles', 'square', 'list']) {
    await click(`[data-setting="layout"] [data-value="${layout}"]`)
    await until('the layout', () => js('return document.documentElement.dataset.layout === arguments[0]', layout))
    const box = await js<number[]>(`
      const tile = document.querySelector('#sparks .Spark[data-id]')
      const [outer, strip, text] = [tile, tile.querySelector('.EditSpark'), tile.querySelector('.Text')].map((node) => node.getBoundingClientRect())
      return [outer.right - strip.right, outer.top - strip.top, outer.bottom - strip.bottom, strip.left >= text.right ? 1 : 0].map(Math.round)`)
    assert.deepEqual(box, [0, 0, 0, 1], layout)
  }
  await click('[data-setting="layout"] [data-value="wide"]')
})

// Everything with text on it that's too faint, with opacity counted in. Disabled controls don't need to pass.
const FAINT_TEXT = `
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const paint = canvas.getContext('2d', { willReadFrequently: true })
  const paintOver = (color, alpha = 1) => {
    paint.globalAlpha = alpha
    paint.fillStyle = color
    paint.fillRect(0, 0, 1, 1)
    return [...paint.getImageData(0, 0, 1, 1).data].slice(0, 3)
  }
  const channel = (value) => (value / 255 <= 0.04045 ? value / 255 / 12.92 : ((value / 255 + 0.055) / 1.055) ** 2.4)
  const luminance = ([red, green, blue]) => 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue)
  const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05)
  const chain = (node) => (node.parentElement ? [...chain(node.parentElement), node] : [node])
  const hasText = (node) => [...node.childNodes].some((child) => child.nodeType === Node.TEXT_NODE && child.textContent.trim()) || (node.matches('input:not([type=range], [type=checkbox], [type=file])') && node.value)
  const faint = []
  for (const node of document.querySelectorAll('body *')) {
    if (!hasText(node) || !node.checkVisibility({ visibilityProperty: true }) || node.closest(':disabled, .Thumb, script, style')) continue
    const parents = chain(node)
    paintOver('#ffffff')
    let background = []
    for (const parent of parents) background = paintOver(getComputedStyle(parent).backgroundColor)
    const opacity = parents.reduce((total, parent) => total * Number(getComputedStyle(parent).opacity), 1)
    const text = paintOver(getComputedStyle(node).color, opacity)
    const ratio = contrast(text, background)
    if (ratio < 4.5) faint.push(node.tagName + '.' + node.className + ' "' + (node.textContent || node.value).trim().slice(0, 20) + '" ' + ratio.toFixed(2))
  }
  return faint`

test('text reads on every color, in light and dark, with nothing and something marked', async () => {
  await home()
  await addSpark('readable')
  await addView('Another')
  await addSpark('readable-too')
  await edit()
  const custom = (hex: string): Promise<void> =>
    js(
      `
    const input = document.querySelector('#customColor')
    input.value = arguments[0]
    input.dispatchEvent(new Event('change', { bubbles: true }))`,
      hex
    )
  const trash = driver.findElement(By.id('trash'))
  const colors = ['firedial', 'rose', 'berry', 'violet', 'ocean', 'teal', 'forest', '#ffffff', '#000000', '#ffff00', '#777777', '#3f3f46', '#00ffff', '#ff0000']
  const faint: string[] = []
  for (const theme of ['light', 'dark']) {
    await click(`[data-setting="theme"] [data-value="${theme}"]`)
    await until('the theme', () => js('return document.documentElement.dataset.theme === arguments[0]', theme))
    for (const color of colors) {
      if (color.startsWith('#')) await custom(color)
      else await click(`[data-setting="color"] [data-value="${color}"]`)
      await until(
        'the color',
        async () =>
          (await js<string>("return document.documentElement.style.getPropertyValue('--custom')")) === color ||
          (await js<string>('return document.documentElement.dataset.color')) === color
      )
      await driver.sleep(30)
      await driver.actions().move({ origin: trash }).perform()
      assert.ok(await js("return document.querySelector('#trash').matches(':hover')"))
      const looked = async (state: string): Promise<void> => {
        for (const line of await js<string[]>(FAINT_TEXT)) faint.push(`${theme} ${color} ${state}: ${line}`)
      }
      await looked('hovering Delete')
      await js("document.querySelector('#sparks .Spark[data-id]').click()")
      await looked('selected')
      await press(Key.ESCAPE)
      await click('[data-action="about"]')
      await looked('About')
      await press(Key.ESCAPE)
      const logo = await js<string>("return getComputedStyle(document.querySelector('.Logo svg')).color")
      assert.notEqual(logo, await js<string>("return getComputedStyle(document.querySelector('.Options')).backgroundColor"), `${theme} ${color}`)
    }
  }
  assert.deepEqual(faint, [])
  await click('[data-setting="theme"] [data-value="system"]')
  await click('[data-setting="color"] [data-value="firedial"]')
  await edit()
})

test('the tab shows the flame', async () => {
  await home()
  await driver.setContext(firefox.Context.CHROME)
  await until('the icon', () => js('return Boolean(gBrowser.selectedTab.image)'))
  const image = await js<string>('return gBrowser.selectedTab.image')
  await driver.setContext(firefox.Context.CONTENT)
  assert.match(image, /svg/) // Firefox hands it on as data
})

test("Firefox's menu lists New View, Remove, a line, then the views, and adds a spark", async () => {
  await driver.get(`${base}/page`)
  await driver
    .actions()
    .contextClick(driver.findElement(By.id('text')))
    .perform()
  await driver.sleep(500)
  await driver.setContext(firefox.Context.CHROME)
  const entries = await js<string[]>(`
    const root = [...document.querySelectorAll('#contentAreaContextMenu > menu')].find((node) => node.label === 'Add to FireDial')
    return [...root.menupopup.children].map((node) => node.localName === 'menuseparator' ? '---' : node.label)`)
  assert.deepEqual(entries.slice(0, 3), ['New View', 'Remove from FireDial', '---'])
  assert.ok(!entries.includes('All') && entries.includes('Unlabeled'), entries.join())
  await js(`
    const item = [...document.querySelectorAll('#contentAreaContextMenu [id*="firedial"]')].find((node) => node.id.endsWith('add-to-new-view'))
    item.doCommand()
    document.getElementById('contentAreaContextMenu').hidePopup()`)
  await driver.setContext(firefox.Context.CONTENT)
  assert.match(await notification(), /^Added to /)
  const before = await driver.getAllWindowHandles()
  await (await inNotification('span')).click()
  await until('the new tab', async () => (await driver.getAllWindowHandles()).length === before.length + 1)
  const opened = (await driver.getAllWindowHandles()).find((handle) => !before.includes(handle))
  assert.ok(opened)
  await driver.switchTo().window(opened)
  await until('the spark', () => js("return document.querySelector('.Spark--reveal') !== null"))
})

test('About shows FireDial as big as the logo, centered, and Undo and Redo stand apart', async () => {
  await home()
  await edit()
  await about()
  const [title, logo, centered] = await js<[string, string, boolean]>(`
    const title = document.querySelector('#aboutModal .Modal__title')
    const head = title.parentElement.getBoundingClientRect()
    const box = title.getBoundingClientRect()
    return [getComputedStyle(title).fontSize, getComputedStyle(document.querySelector('.Logo')).fontSize, Math.abs(box.left + box.width / 2 - (head.left + head.width / 2)) < 1]`)
  assert.equal(title, logo)
  assert.ok(centered, 'centered')
  await press(Key.ESCAPE)
  await edit()
  assert.equal(await js("return getComputedStyle(document.querySelector('#history')).columnGap"), '3px')
})
