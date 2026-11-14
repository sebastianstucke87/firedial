// Chrome has chrome.* where Firefox has browser.* (newer Chrome has browser.* too). With Manifest
// V3 both return promises, so on Chrome browser is chrome, with the menus Chrome calls
// contextMenus. Imported first by every entry point, so the rest of FireDial uses browser.* only.

interface Api {
  runtime: { getURL(path: string): string }
}

interface Scope<T extends Api> {
  browser?: T | undefined
  chrome?: T | undefined
}

// Whether the scope is Chrome's, told by the address of FireDial's own pages; gives it the
// browser.* FireDial expects if so.
export function adapt<T extends Api>(scope: Scope<T>): boolean {
  const api = scope.browser ?? scope.chrome
  if (!api?.runtime.getURL('').startsWith('chrome-extension:')) return false
  const adapted = new Proxy(api, {
    get: (target, key) => Reflect.get(target, key === 'menus' ? 'contextMenus' : key)
  })
  Object.defineProperty(scope, 'browser', { value: adapted, configurable: true, writable: true })
  return true
}

export const IS_CHROME = adapt(globalThis)
export const BROWSER_NAME = IS_CHROME ? 'Chrome' : 'Firefox'

interface SearchApi {
  get?: (() => Promise<browser.search.SearchEngine[]>) | undefined
  search(details: { query: string; engine?: string; disposition: 'CURRENT_TAB' }): Promise<unknown>
  query(details: { text: string; disposition: 'CURRENT_TAB' }): Promise<void>
}

// Chrome can't list the search engines: there's only its default one.
export async function searchEngines(search: SearchApi): Promise<browser.search.SearchEngine[]> {
  return search.get ? await search.get() : []
}

export async function searchWeb(search: SearchApi, query: string, engine: string | undefined): Promise<void> {
  if (!search.get) return search.query({ text: query, disposition: 'CURRENT_TAB' })
  await search.search({ query, ...(engine === undefined ? {} : { engine }), disposition: 'CURRENT_TAB' })
}
