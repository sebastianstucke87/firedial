import assert from 'node:assert/strict'
import { test } from 'node:test'

import { adapt, BROWSER_NAME, IS_CHROME, searchEngines, searchWeb, versionOf } from './browser.ts'

const api = (base: string, more: Record<string, unknown> = {}): { runtime: { getURL(path: string): string } } & Record<string, unknown> => ({
  runtime: { getURL: (path: string) => `${base}${path}` },
  ...more
})

test('Firefox keeps its browser.*, though it has chrome.* too', () => {
  const firefox = api('moz-extension://uuid/')
  const scope = { browser: firefox, chrome: firefox }
  assert.equal(adapt(scope), false)
  assert.equal(scope.browser, firefox)
})

interface Scope {
  browser?: ReturnType<typeof api> | undefined
  chrome?: ReturnType<typeof api> | undefined
}

test('without either, nothing changes', () => {
  const scope: Scope = {}
  assert.equal(adapt(scope), false)
  assert.equal(scope.browser, undefined)
})

for (const [kind, scopeOf] of [
  ['only chrome.*', (chrome: ReturnType<typeof api>): Scope => ({ chrome })],
  ['browser.* too', (chrome: ReturnType<typeof api>): Scope => ({ browser: chrome, chrome })]
] as const) {
  test(`Chrome with ${kind}: browser.* is chrome.*, with contextMenus as menus`, () => {
    const contextMenus = { name: 'contextMenus' }
    const bookmarks = { name: 'bookmarks' }
    const scope = scopeOf(api('chrome-extension://id/', { contextMenus, bookmarks }))
    assert.equal(adapt(scope), true)
    const adapted = scope.browser
    assert.ok(adapted)
    assert.equal(adapted['menus'], contextMenus)
    assert.equal(adapted['bookmarks'], bookmarks)
    assert.equal(adapted['contextMenus'], contextMenus)
    const other = api('chrome-extension://other/')
    scope.browser = other
    assert.equal(scope.browser, other, 'stays writable')
  })
}

test('in Node, which is neither, FireDial counts as in Firefox', () => {
  assert.equal(IS_CHROME, false)
  assert.equal(BROWSER_NAME, 'Firefox')
})

test("the version shown is Chrome's version_name, else the version", () => {
  assert.equal(versionOf({ version: '2026.11.14.1834', version_name: '2026.11.14.183412' }), '2026.11.14.183412')
  assert.equal(versionOf({ version: '2026.11.14.183412' }), '2026.11.14.183412')
})

interface Call {
  method: string
  details: unknown
}

function fakeSearch(chrome: boolean): { calls: Call[]; api: Parameters<typeof searchWeb>[0] } {
  const calls: Call[] = []
  const engines = [{ name: 'Example', isDefault: true }]
  const query = (details: unknown): Promise<void> => {
    calls.push({ method: 'query', details })
    return Promise.resolve()
  }
  const search = (details: unknown): Promise<void> => {
    calls.push({ method: 'search', details })
    return Promise.resolve()
  }
  return { calls, api: chrome ? { query, search } : { get: () => Promise.resolve(engines), query, search } }
}

test('Firefox lists its engines and searches with the one picked', async () => {
  const { calls, api } = fakeSearch(false)
  assert.deepEqual(await searchEngines(api), [{ name: 'Example', isDefault: true }])
  await searchWeb(api, 'cats', 'Example')
  await searchWeb(api, 'dogs', undefined)
  assert.deepEqual(calls, [
    { method: 'search', details: { query: 'cats', engine: 'Example', disposition: 'CURRENT_TAB' } },
    { method: 'search', details: { query: 'dogs', disposition: 'CURRENT_TAB' } }
  ])
})

test('Chrome has no engines to list and searches with its default one', async () => {
  const { calls, api } = fakeSearch(true)
  assert.deepEqual(await searchEngines(api), [])
  await searchWeb(api, 'cats', undefined)
  assert.deepEqual(calls, [{ method: 'query', details: { text: 'cats', disposition: 'CURRENT_TAB' } }])
})
