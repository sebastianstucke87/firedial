// Two-way sync with native bookmarks, for Firefox Sync and bookmark tools: a "FireDial" folder
// in Other Bookmarks with one bookmark per spark, in All's order, plus data bookmarks for the
// labels and the views. Images stay local.
//
// Push makes the bookmarks match the store after a change in FireDial, pull makes the store match
// the bookmarks after a change in Firefox. Both only compare and fix, so running either one again
// changes nothing, and the bookmark events of a push run into a pull that finds nothing to do.
// Pull goes through the store like any change, so even a deletion in Firefox can be undone.
// Push never removes what it doesn't know: only bookmarks it made or adopted. Folders inside
// FireDial's folder are left alone.

import * as z from 'zod/mini'

import { allocSpark, canonicalize, labelKey, listOf, makeView, SparkId, toLabel, toLabelNames, toSparkUrl, View, ViewId } from './model.ts'
import type { Doc, LabelName, Spark } from './model.ts'
import type { KeyValue, Store } from './store.ts'

const FIREFOX_OTHER = 'unfiled_____' // Firefox's Other Bookmarks
const ROOT_TITLE = 'FireDial'
const SAVE_EVERY = 50 // bookmark writes between saving the map, so a crash can't orphan many
const PULL_DELAY = 300 // ms: Firefox Sync and bulk edits fire many events in a row

export interface TreeNode {
  id: string
  title: string
  type?: string | undefined // Firefox only
  folderType?: string | undefined // Chrome only
  syncing?: boolean | undefined // Chrome only
  url?: string | null | undefined
  children?: TreeNode[] | undefined
}

export interface BookmarkApi {
  getTree(): Promise<TreeNode[]>
  getChildren(id: string): Promise<TreeNode[]>
  getSubTree(id: string): Promise<TreeNode[]>
  create(details: { parentId: string; title: string; url?: string }): Promise<{ id: string }>
  update(id: string, changes: { title?: string; url?: string }): Promise<unknown>
  move(id: string, destination: { parentId: string; index: number }): Promise<unknown>
  remove(id: string): Promise<void>
  removeTree(id: string): Promise<void>
}

interface BookmarkMap {
  root: string | null
  sparks: Map<SparkId, string>
}

const emptyMap = (): BookmarkMap => ({ root: null, sparks: new Map() })

const entries = <S extends z.ZodMiniType>(key: S) => z.catch(listOf(z.tuple([key, z.string()])), [])
const MapSchema = z.object({ root: z.catch(z.nullable(z.string()), null), sparks: entries(SparkId) })

export function parseMap(raw: unknown): BookmarkMap {
  const result = MapSchema.safeParse(raw)
  if (!result.success) return emptyMap()
  const { root, sparks } = result.data
  return { root, sparks: new Map(sparks) }
}

const serializeMap = (map: BookmarkMap): Record<string, unknown> => ({ root: map.root, sparks: [...map.sparks] })

// Labels and views travel in bookmarks of their own in the FireDial folder, as JSON in the address
// of a domain that never exists. Sparks are named by their bookmark id there, which Firefox Sync
// keeps. Firefox takes addresses up to about 65 000 characters, so the JSON is split over as many
// as it takes.
const DATA = 'https://firedial.invalid/'
const LABEL_DATA = `${DATA}labels/`
const VIEW_DATA = `${DATA}views/`
const LABEL_DATA_TITLE = 'FireDial labels'
const VIEW_DATA_TITLE = 'FireDial views'
const DATA_CHUNK = 60_000 // characters of JSON in one address

// Firefox tells folders, bookmarks and separators by type; Chrome has no type and no separators.
export const isFolder = (node: Pick<TreeNode, 'type' | 'url'>): boolean => node.type === 'folder' || (node.type === undefined && node.url == null)
export const isBookmark = (node: Pick<TreeNode, 'type' | 'url'>): boolean =>
  node.type === 'bookmark' || (node.type === undefined && typeof node.url === 'string')
const isData = (node: TreeNode): boolean => isBookmark(node) && (node.url ?? '').startsWith(DATA)
const isSpark = (node: TreeNode): boolean => isBookmark(node) && !isData(node)
const childBookmarks = (node: TreeNode): TreeNode[] => (node.children ?? []).filter(isSpark)
const dataOf = (root: TreeNode, prefix: string): TreeNode[] => (root.children ?? []).filter((node) => isData(node) && (node.url ?? '').startsWith(prefix))

// The addresses that hold this value: part/parts#JSON, in order.
function dataUrls(prefix: string, value: unknown): string[] {
  const text = encodeURIComponent(JSON.stringify(value))
  const chunks: string[] = []
  for (let start = 0; start < text.length; start += DATA_CHUNK) chunks.push(text.slice(start, start + DATA_CHUNK))
  return chunks.map((chunk, index) => `${prefix}${index + 1}-${chunks.length}#${chunk}`)
}

// The value; undefined without data bookmarks, or with some of them missing or broken.
function readData(prefix: string, nodes: readonly TreeNode[]): unknown {
  const parts = new Map<number, string>()
  let total = 0
  for (const node of nodes) {
    const match = /^(\d+)-(\d+)#(.*)$/s.exec((node.url ?? '').slice(prefix.length))
    if (!match) return undefined
    const [, index, count, chunk] = match
    if (total && total !== Number(count)) return undefined
    total = Number(count)
    parts.set(Number(index), chunk ?? '')
  }
  if (!total || parts.size !== total) return undefined
  try {
    return JSON.parse(decodeURIComponent(Array.from({ length: total }, (_, index) => parts.get(index + 1) ?? '').join('')))
  } catch {
    return undefined
  }
}

export const labelDataUrls = (labels: Readonly<Record<string, readonly LabelName[]>>): string[] => dataUrls(LABEL_DATA, labels)

const LabelData = z.record(z.string(), z.catch(z.array(z.unknown()), []))

// The labels by bookmark id; null without label bookmarks, or with broken ones, for then they say
// nothing about which labels a spark has.
export function readLabelData(nodes: readonly TreeNode[]): Map<string, LabelName[]> | null {
  const data = LabelData.safeParse(readData(LABEL_DATA, nodes))
  return data.success ? new Map(Object.entries(data.data).map(([id, labels]) => [id, toLabelNames(labels)])) : null
}

// A view as synced: its order by bookmark id.
const SyncedView = z.object({ ...View.shape, id: z.optional(z.unknown()), order: z.catch(listOf(z.string()), []) })
type SyncedView = z.infer<typeof SyncedView>
const ViewData = listOf(SyncedView)

export const viewDataUrls = (views: readonly SyncedView[]): string[] => dataUrls(VIEW_DATA, views)

export function readViewData(nodes: readonly TreeNode[]): SyncedView[] | null {
  const raw = readData(VIEW_DATA, nodes)
  return raw === undefined ? null : ViewData.parse(raw)
}

// Firefox stores URLs normalized: https://a.example becomes https://a.example/.
function canonicalUrl(url: string): string {
  try {
    return new URL(url).href
  } catch {
    return url
  }
}

const sameUrl = (a: string, b: string): boolean => canonicalUrl(a) === canonicalUrl(b)

// What's left of an address once a site's redirects don't matter: to https, to or from www.
function pageOf(url: string): string {
  try {
    const { protocol, hostname, port, pathname, search, hash } = new URL(url)
    return `${/^https?:$/.test(protocol) ? '' : protocol}//${hostname.replace(/^www\./, '')}:${port}${pathname}${search}${hash}`
  } catch {
    return url
  }
}

export const samePage = (a: string, b: string): boolean => pageOf(a) === pageOf(b)

function reversed<Id>(map: ReadonlyMap<Id, string>): Map<string, Id> {
  return new Map([...map].map(([id, bookmarkId]) => [bookmarkId, id]))
}

// Puts the ranked items in rank order, in the places ranked items hold; the others stay put.
function sortRanked<Item extends { id: number }>(items: readonly Item[], rank: ReadonlyMap<number, number>): Item[] {
  const ranked = items.filter((item) => rank.has(item.id)).sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0))
  let next = 0
  return items.map((item) => (rank.has(item.id) ? (ranked[next++] ?? item) : item))
}

// The views as the bookmarks have them: views keep their ids where kind, or title for a normal
// view, match. An order names sparks by bookmark id; sparks it doesn't know go to the end.
function applyViews(doc: Doc, synced: readonly SyncedView[], sparkIds: ReadonlyMap<string, SparkId>): void {
  const keyOf = (view: { kind: View['kind']; title: string }): string => (view.kind === 'normal' ? `normal:${labelKey(view.title)}` : view.kind)
  const existing = new Map(doc.views.map((view) => [keyOf(view), view]))
  doc.views = synced.map((item) => {
    const view = existing.get(keyOf(item)) ?? makeView(ViewId.parse(doc.nextViewId++), item.kind, item.title)
    return { ...view, title: item.title, sort: item.sort, rule: item.rule, order: item.order.flatMap((id) => sparkIds.get(id) ?? []) }
  })
}

// Pull: the doc takes over the folder. New bookmarks become sparks, what's gone from the folder
// goes from the doc, and the order of the bookmarks is All's order. Sparks a push couldn't map stay.
function applyTree(doc: Doc, root: TreeNode, map: BookmarkMap): void {
  const sparkIds = reversed(map.sparks)
  const sparks = new Map(doc.sparks.map((spark) => [spark.id, spark]))
  const seen = new Set<SparkId>()
  const position = new Map<number, number>()
  const labels = readLabelData(dataOf(root, LABEL_DATA))

  for (const node of childBookmarks(root)) {
    const known = sparkIds.get(node.id)
    const spark = known === undefined ? undefined : sparks.get(known)
    const url = toSparkUrl(node.url ?? '')
    if (spark) seen.add(spark.id)
    if (!url) continue
    const target: Spark = spark ?? allocSpark(doc, { title: toLabel(node.title), url, thumb: null })
    map.sparks.set(target.id, node.id)
    seen.add(target.id)
    target.title = toLabel(node.title)
    if (!sameUrl(target.url, url)) target.url = url
    if (labels) target.labels = labels.get(node.id) ?? []
    position.set(target.id, position.size)
  }

  for (const id of map.sparks.keys()) {
    if (!seen.has(id)) map.sparks.delete(id)
  }
  const mapped = new Set(sparkIds.values())
  doc.sparks = sortRanked(
    doc.sparks.filter((spark) => seen.has(spark.id) || !mapped.has(spark.id)),
    position
  )
  const views = readViewData(dataOf(root, VIEW_DATA))
  if (views) applyViews(doc, views, reversed(map.sparks))
  canonicalize(doc)
}

async function fetchRoot(api: BookmarkApi, id: string): Promise<TreeNode | null> {
  try {
    return (await api.getSubTree(id))[0] ?? null
  } catch {
    return null // deleted
  }
}

// Other Bookmarks, where FireDial's folder goes. Chrome marks it with a folder type; signed in, it
// has two, and the one that syncs to the account wins over the one on this device only.
export const isOtherBookmarks = (node: TreeNode): boolean => node.id === FIREFOX_OTHER || node.folderType === 'other'

async function otherBookmarks(api: BookmarkApi): Promise<string> {
  const [tree] = await api.getTree()
  const others = (tree?.children ?? []).filter(isOtherBookmarks)
  const other = others.find((node) => node.syncing === true) ?? others[0]
  if (!other) throw new Error('No Other Bookmarks')
  return other.id
}

const findFolder = async (api: BookmarkApi, parent: string): Promise<TreeNode | undefined> =>
  (await api.getChildren(parent)).find((node) => isFolder(node) && node.title === ROOT_TITLE)

// FireDial's folder is in the bookmarks already, e.g. brought by browser sync from another device.
export async function hasBookmarkFolder(api: BookmarkApi): Promise<boolean> {
  return (await findFolder(api, await otherBookmarks(api))) !== undefined
}

// The root folder. It comes back if it's gone: deleting it must not wipe FireDial.
async function ensureRoot(api: BookmarkApi, map: BookmarkMap): Promise<TreeNode> {
  const current = map.root === null ? null : await fetchRoot(api, map.root)
  if (current) return current
  map.sparks.clear()
  const parent = await otherBookmarks(api)
  const id = (await findFolder(api, parent))?.id ?? (await api.create({ parentId: parent, title: ROOT_TITLE })).id
  map.root = id
  const root = await fetchRoot(api, id)
  if (!root) throw new Error('Bookmark folder vanished')
  return root
}

class Pusher {
  private readonly api: BookmarkApi
  private readonly map: BookmarkMap
  private readonly save: () => Promise<void>
  private writes = 0

  constructor(api: BookmarkApi, map: BookmarkMap, save: () => Promise<void>) {
    this.api = api
    this.map = map
    this.save = save
  }

  // One failed bookmark must not stop the rest: the spark just stays local until the next push.
  private async attempt<T>(write: () => Promise<T>): Promise<T | null> {
    try {
      const result = await write()
      if (++this.writes % SAVE_EVERY === 0) await this.save()
      return result
    } catch (error) {
      console.warn('FireDial bookmark sync:', error)
      return null
    }
  }

  private async removeStale(doc: Doc, root: TreeNode): Promise<void> {
    const sparkIds = new Set(doc.sparks.map((spark) => spark.id))
    const present = new Set(childBookmarks(root).map((node) => node.id))
    for (const [id, bookmarkId] of this.map.sparks) {
      if (sparkIds.has(id)) continue
      this.map.sparks.delete(id)
      if (present.has(bookmarkId)) await this.attempt(() => this.api.remove(bookmarkId))
    }
  }

  private async pushSparks(doc: Doc, root: TreeNode): Promise<void> {
    const bookmarks = new Map(childBookmarks(root).map((node) => [node.id, node]))
    const taken = new Set(this.map.sparks.values())
    for (const spark of doc.sparks) {
      const mapped = this.map.sparks.get(spark.id)
      const existing = mapped === undefined ? undefined : bookmarks.get(mapped)
      // A bookmark nobody claims with this address: an interrupted first sync, or a reinstall.
      const node = existing ?? childBookmarks(root).find((item) => sameUrl(item.url ?? '', spark.url) && !taken.has(item.id))
      if (!node) {
        const created = await this.attempt(() => this.api.create({ parentId: root.id, title: spark.title, url: spark.url }))
        if (created) this.map.sparks.set(spark.id, created.id)
        continue
      }
      taken.add(node.id)
      this.map.sparks.set(spark.id, node.id)
      if (node.title !== spark.title || !sameUrl(node.url ?? '', spark.url)) {
        await this.attempt(() => this.api.update(node.id, { title: spark.title, url: spark.url }))
      }
    }
  }

  // The bookmarks in All's order at the top of the folder, from a fresh look at it; data
  // bookmarks and folders follow.
  private async arrange(doc: Doc, rootId: string): Promise<void> {
    const root = await fetchRoot(this.api, rootId)
    if (!root) return
    const current = (root.children ?? []).map((node) => node.id)
    const wanted = doc.sparks.flatMap((spark) => this.map.sparks.get(spark.id) ?? []).filter((id) => current.includes(id))
    for (const [index, id] of wanted.entries()) {
      if (current[index] === id) continue
      await this.attempt(() => this.api.move(id, { parentId: root.id, index }))
      current.splice(current.indexOf(id), 1)
      current.splice(index, 0, id)
    }
  }

  // Writes data bookmarks only where they differ.
  private async writeData(root: TreeNode, nodes: readonly TreeNode[], urls: readonly string[], title: string): Promise<void> {
    for (const [index, url] of urls.entries()) {
      const node = nodes[index]
      if (!node) await this.attempt(() => this.api.create({ parentId: root.id, title, url }))
      else if (node.url !== url) await this.attempt(() => this.api.update(node.id, { url }))
    }
    for (const node of nodes.slice(urls.length)) await this.attempt(() => this.api.remove(node.id))
  }

  // None at all while no spark ever had a label. A push speaks only for its own sparks: labels of
  // bookmarks it hasn't pulled yet, say on a device that just started syncing, stay as they are.
  private async pushLabels(doc: Doc, root: TreeNode): Promise<void> {
    const nodes = dataOf(root, LABEL_DATA)
    const present = new Set(childBookmarks(root).map((node) => node.id))
    const own = new Set(this.map.sparks.values())
    const labels: Record<string, LabelName[]> = {}
    for (const [id, kept] of readLabelData(nodes) ?? []) {
      if (present.has(id) && !own.has(id) && kept.length) labels[id] = kept
    }
    for (const spark of doc.sparks) {
      const id = this.map.sparks.get(spark.id)
      if (id !== undefined && spark.labels.length) labels[id] = spark.labels
    }
    if (!nodes.length && !Object.keys(labels).length) return
    const sorted = Object.fromEntries(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b))) // a reorder changes no label
    const urls = Object.keys(sorted).length || present.size ? labelDataUrls(sorted) : [] // no bookmark left to label
    await this.writeData(root, nodes, urls, LABEL_DATA_TITLE)
  }

  // A device that hasn't synced yet leaves views it finds alone: the pull after this push takes them.
  private async pushViews(doc: Doc, root: TreeNode, fresh: boolean): Promise<void> {
    if (fresh && readViewData(dataOf(root, VIEW_DATA))) return
    const views = doc.views.map(({ kind, title, sort, rule, order }) => ({
      kind,
      title,
      sort,
      rule,
      order: order.flatMap((id) => this.map.sparks.get(id) ?? [])
    }))
    await this.writeData(root, dataOf(root, VIEW_DATA), viewDataUrls(views), VIEW_DATA_TITLE)
  }

  async push(doc: Doc): Promise<void> {
    const fresh = this.map.root === null
    await this.removeStale(doc, await ensureRoot(this.api, this.map))
    const root = await ensureRoot(this.api, this.map) // what's left: nothing removed may be adopted
    await this.pushSparks(doc, root)
    await this.arrange(doc, root.id)
    const now = await fetchRoot(this.api, root.id)
    if (!now) return
    await this.pushLabels(doc, now)
    await this.pushViews(doc, now, fresh)
  }
}

// Runs in the background script, one job at a time. A job asked for while one runs waits for it.
export class BookmarkSync {
  private readonly store: Store
  private readonly kv: KeyValue
  private readonly api: BookmarkApi
  private running = false
  private wantPush = false
  private wantPull = false
  private pullTimer: ReturnType<typeof setTimeout> | undefined

  constructor(store: Store, kv: KeyValue, api: BookmarkApi) {
    this.store = store
    this.kv = kv
    this.api = api
  }

  requestPush(): Promise<void> {
    this.wantPush = true
    return this.pump()
  }

  requestPull(): void {
    clearTimeout(this.pullTimer)
    this.pullTimer = setTimeout(() => {
      this.wantPull = true
      void this.pump()
    }, PULL_DELAY)
  }

  // At startup: unsynced changes in FireDial first, then whatever happened to the bookmarks.
  start(): Promise<void> {
    this.wantPush = true
    this.wantPull = true
    return this.pump()
  }

  // Resolves once nothing is left to do, or at once when another call is already at it.
  private async pump(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (this.wantPush || this.wantPull) {
        if (this.wantPush) {
          this.wantPush = false
          await this.push()
        } else {
          this.wantPull = false
          await this.pull()
        }
      }
    } catch (error) {
      console.error('FireDial bookmark sync:', error)
    } finally {
      this.running = false
    }
  }

  private async readSyncState(): Promise<{ map: BookmarkMap; syncedRev: number }> {
    const { bookmarkMap, syncedRev } = await this.kv.get(['bookmarkMap', 'syncedRev'])
    return { map: parseMap(bookmarkMap), syncedRev: Number(syncedRev) || 0 }
  }

  private async push(): Promise<void> {
    await this.store.load()
    const { map, syncedRev } = await this.readSyncState()
    const { doc, revision } = this.store
    if (revision === syncedRev && map.root !== null) return
    const save = (): Promise<void> => this.kv.set({ bookmarkMap: serializeMap(map) })
    await new Pusher(this.api, map, save).push(doc)
    await this.kv.set({ bookmarkMap: serializeMap(map), syncedRev: revision })
  }

  private async pull(): Promise<void> {
    await this.store.load()
    const { map, syncedRev } = await this.readSyncState()
    if (this.store.revision !== syncedRev) {
      this.wantPush = true
      this.wantPull = true
      return
    }
    const root = map.root === null ? null : await fetchRoot(this.api, map.root)
    if (!root) {
      map.root = null // gone: push puts it back
      await this.kv.set({ bookmarkMap: serializeMap(map) })
      this.wantPush = true
      return
    }
    const applied = await this.store.commit(
      (doc) => {
        applyTree(doc, root, map)
        return undefined
      },
      { unchecked: true, ifRevision: syncedRev }
    )
    if (!applied) {
      this.wantPush = true
      this.wantPull = true
      return
    }
    await this.kv.set({ bookmarkMap: serializeMap(map), syncedRev: this.store.revision })
  }
}
