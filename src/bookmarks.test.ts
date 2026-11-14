import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  BookmarkSync,
  hasBookmarkFolder,
  isBookmark,
  isFolder,
  labelDataUrls,
  parseMap,
  readLabelData,
  readViewData,
  samePage,
  viewDataUrls
} from './bookmarks.ts'
import type { BookmarkApi, TreeNode } from './bookmarks.ts'
import { addLabels, addTo, allocSpark, allocView, arrange, LabelName, LIMITS, moveInView, removeLabels, SparkId, SparkUrl, toLabel } from './model.ts'
import type { Doc, Spark, View } from './model.ts'
import { Store } from './store.ts'
import type { KeyValue, Lock } from './store.ts'

// Small limits: the limit tests then build 1,000 sparks, not 100,000, which matters for mutation testing.
Object.assign(LIMITS, { views: 20, sparks: 1000 })

const firefoxAreas = (): TreeNode[] => [
  { id: 'toolbar_____', title: 'Bookmarks Toolbar', type: 'folder', children: [] },
  { id: 'unfiled_____', title: 'Other Bookmarks', type: 'folder', children: [] }
]

// Chrome signed in to an account: Bookmarks bar and Other bookmarks on this device and in the account.
const chromeAreas = (): TreeNode[] => [
  { id: '1', title: 'Bookmarks bar', folderType: 'bookmarks-bar', syncing: false, children: [] },
  { id: '2', title: 'Other bookmarks', folderType: 'other', syncing: false, children: [] },
  { id: '7', title: 'Bookmarks bar', folderType: 'bookmarks-bar', syncing: true, children: [] },
  { id: '8', title: 'Other bookmarks', folderType: 'other', syncing: true, children: [] }
]

// The browser's bookmarks as far as FireDial cares: normalized URLs, stable ids, failures on bad
// URLs. Firefox's nodes have a type; Chrome's have none.
class FakeBookmarks implements BookmarkApi {
  private nextId = 1
  writes = 0
  readonly tree: TreeNode
  readonly root: TreeNode // where FireDial's folder belongs
  private readonly typed: boolean

  constructor(areas: TreeNode[] = firefoxAreas(), other = 'unfiled_____') {
    this.tree = { id: 'root________', title: '', children: areas }
    const root = areas.find((area) => area.id === other)
    assert.ok(root)
    this.root = root
    this.typed = areas.some((area) => area.type !== undefined)
  }

  getTree(): Promise<TreeNode[]> {
    return Promise.resolve([structuredClone(this.tree)])
  }

  private find(id: string, node: TreeNode = this.tree): TreeNode | null {
    if (node.id === id) return node
    for (const child of node.children ?? []) {
      const found = this.find(id, child)
      if (found) return found
    }
    return null
  }

  private parentOf(id: string, node: TreeNode = this.tree): TreeNode | null {
    if (node.children?.some((child) => child.id === id)) return node
    for (const child of node.children ?? []) {
      const found = this.parentOf(id, child)
      if (found) return found
    }
    return null
  }

  private detach(id: string): TreeNode {
    const parent = this.parentOf(id)
    const index = parent?.children?.findIndex((child) => child.id === id) ?? -1
    const removed = parent?.children?.splice(index, 1)[0]
    if (!removed) throw new Error(`No bookmark ${id}`)
    return removed
  }

  getChildren(id: string): Promise<TreeNode[]> {
    return Promise.resolve(structuredClone(this.find(id)?.children ?? []))
  }

  getSubTree(id: string): Promise<TreeNode[]> {
    const node = this.find(id)
    if (!node) return Promise.reject(new Error('node is null'))
    return Promise.resolve([structuredClone(node)])
  }

  create(details: { parentId: string; title: string; url?: string }): Promise<{ id: string }> {
    this.writes += 1
    if (details.url === 'bad' || details.title === 'refused') return Promise.reject(new Error('Invalid bookmark'))
    const node: TreeNode =
      details.url === undefined
        ? { id: `b${this.nextId++}`, title: details.title, ...(this.typed ? { type: 'folder' } : {}), children: [] }
        : { id: `b${this.nextId++}`, title: details.title, ...(this.typed ? { type: 'bookmark' } : {}), url: new URL(details.url).href }
    this.find(details.parentId)?.children?.push(node)
    return Promise.resolve({ id: node.id })
  }

  update(id: string, changes: { title?: string; url?: string }): Promise<unknown> {
    this.writes += 1
    const node = this.find(id)
    if (!node) return Promise.reject(new Error('gone'))
    if (changes.title !== undefined) node.title = changes.title
    if (changes.url !== undefined) node.url = new URL(changes.url).href
    return Promise.resolve(null)
  }

  move(id: string, destination: { parentId: string; index: number }): Promise<unknown> {
    this.writes += 1
    const node = this.detach(id)
    this.find(destination.parentId)?.children?.splice(destination.index, 0, node)
    return Promise.resolve(null)
  }

  remove(id: string): Promise<void> {
    this.writes += 1
    this.detach(id)
    return Promise.resolve()
  }

  removeTree(id: string): Promise<void> {
    return this.remove(id)
  }

  // Edits made in Firefox, without going through FireDial's own counter.
  folder(): TreeNode {
    const folder = this.root.children?.find((node) => node.title === 'FireDial')
    assert.ok(folder)
    return folder
  }

  child(title: string, node: TreeNode = this.folder()): TreeNode {
    const found = node.children?.find((item) => item.title === title)
    assert.ok(found, `no ${title}`)
    return found
  }

  shape(): string[] {
    return (this.folder().children ?? []).map((node) => node.title)
  }
}

function memory(): KeyValue & { data: Map<string, unknown>; sets: string[][] } {
  const data = new Map<string, unknown>()
  const sets: string[][] = []
  return {
    data,
    sets,
    get(keys) {
      const list = [keys].flat()
      return Promise.resolve(Object.fromEntries(list.filter((key) => data.has(key)).map((key) => [key, structuredClone(data.get(key))])))
    },
    set(items) {
      sets.push(Object.keys(items).sort())
      for (const [key, value] of Object.entries(items)) data.set(key, structuredClone(value))
      return Promise.resolve()
    },
    remove(keys) {
      for (const key of [keys].flat()) data.delete(key)
      return Promise.resolve()
    },
    onChanged() {
      // the tests run sync jobs themselves
    }
  }
}

const noLock: Lock = (task) => task()

interface Setup {
  kv: ReturnType<typeof memory>
  store: Store
  api: FakeBookmarks
  sync: BookmarkSync
  // Two sync rounds with everything settled: the first lets a pull see the push's result.
  settle: () => Promise<void>
}

async function setup(api = new FakeBookmarks()): Promise<Setup> {
  const kv = memory()
  const store = new Store(kv, noLock)
  const sync = new BookmarkSync(store, kv, api)
  await store.load()
  return { kv, store, api, sync, settle: () => sync.start() }
}

const viewOf = (doc: Doc, title: string): View => {
  const view = doc.views.find((each) => each.title === title)
  if (!view) throw new Error(`no view ${title}`)
  return view
}

function spark(doc: Doc, title: string, view?: string): Spark {
  const made = allocSpark(doc, { title: toLabel(title), url: SparkUrl.parse(`https://${title}.example`), thumb: null })
  if (view) addTo([made], viewOf(doc, view))
  return made
}

const DATA = ['FireDial labels', 'FireDial views']

// Home has a and b, Linux has c.
async function seeded(): Promise<Setup> {
  const context = await setup()
  await context.store.commit((doc) => {
    allocView(doc, 'Home')
    allocView(doc, 'Linux')
    spark(doc, 'a', 'Home')
    spark(doc, 'b', 'Home')
    spark(doc, 'c', 'Linux')
    return undefined
  })
  await context.settle()
  return context
}

const titles = (store: Store): string[] => store.doc.sparks.map((item) => item.title)
const labelsOf = (store: Store): string[][] => store.doc.sparks.map((item) => item.labels)

// What a view shows on this device, in its order.
const shownIn = (store: Store, title: string): string[] => arrange(store.doc, viewOf(store.doc, title)).map((item) => item.title)

// Another device: its own storage, the same bookmarks through Firefox Sync.
async function secondDevice(api: FakeBookmarks): Promise<Setup> {
  const kv = memory()
  const store = new Store(kv, noLock)
  await store.load()
  const sync = new BookmarkSync(store, kv, api)
  await sync.start()
  return { kv, store, api, sync, settle: () => sync.start() }
}

test("FireDial's folder counts only as a folder named FireDial in Other Bookmarks", async () => {
  const api = new FakeBookmarks()
  assert.equal(await hasBookmarkFolder(api), false)
  await api.create({ parentId: 'unfiled_____', title: 'FireDial', url: 'https://example.com/' })
  await api.create({ parentId: 'unfiled_____', title: 'Other' })
  assert.equal(await hasBookmarkFolder(api), false)
  await api.create({ parentId: 'unfiled_____', title: 'FireDial' })
  assert.equal(await hasBookmarkFolder(api), true)
})

test("folders and bookmarks, by Firefox's type or, in Chrome, by the address", () => {
  const kinds = (node: Pick<TreeNode, 'type' | 'url'>): [boolean, boolean] => [isFolder(node), isBookmark(node)]
  assert.deepEqual(kinds({ type: 'folder' }), [true, false])
  assert.deepEqual(kinds({ type: 'bookmark', url: 'https://a.example/' }), [false, true])
  assert.deepEqual(kinds({ type: 'separator', url: 'data:' }), [false, false])
  assert.deepEqual(kinds({ type: 'separator' }), [false, false])
  assert.deepEqual(kinds({}), [true, false])
  assert.deepEqual(kinds({ url: 'https://a.example/' }), [false, true])
})

test('a FireDial folder elsewhere, e.g. in the toolbar, is not the one', async () => {
  const api = new FakeBookmarks()
  await api.create({ parentId: 'toolbar_____', title: 'FireDial' })
  assert.equal(await hasBookmarkFolder(api), false)
})

test("in Chrome, FireDial's folder goes to the Other bookmarks that sync to the account", async () => {
  const api = new FakeBookmarks(chromeAreas(), '8')
  assert.equal(await hasBookmarkFolder(api), false)
  await api.create({ parentId: '2', title: 'FireDial' }) // on this device only
  assert.equal(await hasBookmarkFolder(api), false)
  const { store, settle } = await setup(api)
  await store.commit((doc) => {
    spark(doc, 'a')
    return undefined
  })
  await settle()
  assert.equal(await hasBookmarkFolder(api), true)
  assert.deepEqual(api.shape(), ['a', 'FireDial views'])
  assert.equal(api.child('a').type, undefined)
})

test('in Chrome without an account, the folder goes to Other bookmarks on the device', async () => {
  const api = new FakeBookmarks(chromeAreas().slice(0, 2), '2')
  const { store, settle } = await setup(api)
  await store.commit((doc) => {
    spark(doc, 'a')
    return undefined
  })
  await settle()
  assert.deepEqual(api.shape(), ['a', 'FireDial views'])
})

test('in Chrome, bookmark edits come back as edits of the sparks', async () => {
  const api = new FakeBookmarks(chromeAreas(), '8')
  const { store, settle } = await setup(api)
  await store.commit((doc) => {
    spark(doc, 'a')
    spark(doc, 'b')
    return undefined
  })
  await settle()
  await api.update(api.child('a').id, { title: 'renamed' })
  await api.remove(api.child('b').id)
  await settle()
  assert.deepEqual(titles(store), ['renamed'])
})

test('without Other Bookmarks there is no place for the folder', async () => {
  const api = new FakeBookmarks()
  api.tree.children = []
  await assert.rejects(hasBookmarkFolder(api), /No Other Bookmarks/)
})

test("first push puts every spark in FireDial's folder, in All's order, then the data", async () => {
  const { api } = await seeded()
  assert.deepEqual(api.shape(), ['a', 'b', 'c', ...DATA])
})

test('a synced state causes no writes, even with normalized URLs', async () => {
  const { store, api, settle } = await seeded()
  const steps = store.canUndo
  const writes = api.writes
  await settle()
  await settle()
  assert.equal(api.writes, writes)
  assert.equal(store.canUndo, steps)
  await store.undo() // only the seeding step exists: first sync added none
  assert.equal(store.canUndo, false)
})

test('changes in FireDial reach the bookmarks', async () => {
  const { store, api, settle } = await seeded()
  await store.commit((doc) => {
    spark(doc, 'd', 'Linux')
    const [first] = doc.sparks
    if (first) first.title = toLabel('renamed')
    doc.sparks = doc.sparks.filter((item) => item.title !== 'b')
    return undefined
  })
  await settle()
  assert.deepEqual(api.shape(), ['renamed', 'c', 'd', ...DATA])
})

test('reordering All in FireDial reaches the bookmarks, other orders stay in the data', async () => {
  const { store, api, settle } = await seeded()
  await store.commit((doc) => {
    const all = viewOf(doc, 'All')
    moveInView(doc, all, [SparkId.parse(2)], SparkId.parse(0), false)
    const home = viewOf(doc, 'Home')
    moveInView(doc, home, [SparkId.parse(1)], SparkId.parse(0), false)
    return undefined
  })
  await settle()
  assert.deepEqual(api.shape(), ['c', 'a', 'b', ...DATA])
  const second = await secondDevice(api)
  assert.deepEqual(titles(second.store), ['c', 'a', 'b'])
  assert.deepEqual(shownIn(second.store, 'Home'), ['b', 'a'])
})

test('edits in Firefox reach FireDial', async () => {
  const { store, api, settle } = await seeded()
  api.child('a').title = 'edited'
  api.child('b').url = 'https://moved.example/'
  await settle()
  assert.deepEqual(titles(store), ['edited', 'b', 'c'])
  assert.equal(store.doc.sparks[1]?.url, 'https://moved.example/')
})

test('a new bookmark in Firefox becomes a spark in Unlabeled', async () => {
  const { store, api, settle } = await seeded()
  await api.create({ parentId: api.folder().id, title: 'new', url: 'https://new.example/' })
  await settle()
  assert.deepEqual(titles(store), ['a', 'b', 'c', 'new'])
  assert.deepEqual(shownIn(store, 'Unlabeled'), ['new'])
  assert.equal(store.doc.sparks[3]?.thumb, null)
})

test('a reorder in Firefox is the new order of All', async () => {
  const { store, api, settle } = await seeded()
  await api.move(api.child('c').id, { parentId: api.folder().id, index: 0 })
  await settle()
  assert.deepEqual(titles(store), ['c', 'a', 'b'])
  assert.deepEqual(shownIn(store, 'Home'), ['a', 'b'], 'a view keeps its own order')
})

test('a deletion in Firefox can be undone, and the bookmark comes back', async () => {
  const { store, api, settle } = await seeded()
  await api.remove(api.child('b').id)
  await settle()
  assert.deepEqual(titles(store), ['a', 'c'])
  await store.undo()
  await settle()
  assert.deepEqual(titles(store), ['a', 'b', 'c'])
  assert.deepEqual(api.shape(), ['a', 'b', 'c', ...DATA])
  assert.deepEqual(shownIn(store, 'Home'), ['a', 'b'])
})

test('deleting the whole FireDial folder wipes nothing: it comes back', async () => {
  const { store, api, settle } = await seeded()
  await api.remove(api.folder().id)
  await settle()
  assert.deepEqual(titles(store), ['a', 'b', 'c'])
  assert.deepEqual(api.shape(), ['a', 'b', 'c', ...DATA])
})

test('a spark the bookmark API refuses stays in FireDial, the rest syncs', async () => {
  const context = await setup()
  await context.store.commit((doc) => {
    spark(doc, 'a')
    allocSpark(doc, { title: toLabel('refused'), url: SparkUrl.parse('https://r.example'), thumb: null })
    spark(doc, 'b')
    return undefined
  })
  await context.settle()
  assert.deepEqual(titles(context.store), ['a', 'refused', 'b'])
  assert.deepEqual(context.api.shape(), ['a', 'b', 'FireDial views'])
})

test('an interrupted first sync adopts what it made instead of doubling it', async () => {
  const { store, api, kv, settle } = await seeded()
  kv.data.delete('bookmarkMap')
  kv.data.delete('syncedRev')
  await settle()
  assert.deepEqual(api.shape(), ['a', 'b', 'c', ...DATA])
  assert.deepEqual(titles(store), ['a', 'b', 'c'])
})

test('a fresh install picks up an existing FireDial folder: sparks, labels, views, rules and orders', async () => {
  const first = await seeded()
  await first.store.commit((doc) => {
    const home = viewOf(doc, 'Home')
    home.sort = 'name'
    moveInView(doc, viewOf(doc, 'Linux'), [], null, false)
    const morning = allocView(doc, 'Morning')
    morning.rule = { all: false, include: [LabelName.parse('linux')], exclude: [LabelName.parse('Home')] }
    addLabels(doc.sparks.slice(0, 1), [LabelName.parse('Trip to Rome')])
    return undefined
  })
  await first.settle()
  const second = await secondDevice(first.api)
  const shape = (store: Store): unknown => store.doc.views.map(({ kind, title, sort, rule }) => [kind, title, sort, rule])
  assert.deepEqual(shape(second.store), shape(first.store))
  assert.deepEqual(titles(second.store), ['a', 'b', 'c'])
  assert.deepEqual(labelsOf(second.store), labelsOf(first.store))
  assert.deepEqual(shownIn(second.store, 'Morning'), ['c'])
})

test('views changed on one device reach the other, keeping their ids where they match', async () => {
  const first = await seeded()
  const second = await secondDevice(first.api)
  const linux = viewOf(second.store.doc, 'Linux').id
  await first.store.commit((doc) => {
    allocView(doc, 'Fresh')
    doc.views = doc.views.filter((view) => view.title !== 'Home')
    viewOf(doc, 'Linux').sort = 'date'
    return undefined
  })
  await first.settle()
  await second.settle()
  assert.deepEqual(
    second.store.doc.views.map((view) => view.title),
    ['All', 'Unlabeled', 'Linux', 'Fresh']
  )
  assert.equal(viewOf(second.store.doc, 'Linux').id, linux)
  assert.equal(viewOf(second.store.doc, 'Linux').sort, 'date')
  assert.deepEqual(labelsOf(second.store), [['Home'], ['Home'], ['Linux']], 'labels stay with a deleted view')
})

test('folders and other items in the FireDial folder are left alone', async () => {
  const { store, api, settle } = await seeded()
  await api.create({ parentId: api.folder().id, title: 'Old group' })
  await api.create({ parentId: api.child('Old group').id, title: 'inside', url: 'https://inside.example/' })
  api.folder().children?.push({ id: 'sep', title: '', type: 'separator' })
  await store.commit((doc) => {
    spark(doc, 'd')
    return undefined
  })
  await settle()
  assert.deepEqual(titles(store), ['a', 'b', 'c', 'd'])
  assert.ok(api.folder().children?.some((node) => node.id === 'sep'))
  assert.deepEqual(
    api.child('Old group').children?.map((node) => node.title),
    ['inside']
  )
})

test('the map survives storage, and a broken one reads as empty', () => {
  const map = parseMap({
    root: 'r',
    sparks: [
      [2, 's'],
      ['bad', 's']
    ]
  })
  assert.equal(map.root, 'r')
  assert.equal(map.sparks.size, 1)
  assert.equal(parseMap(null).root, null)
  const broken = parseMap({ root: 'r', sparks: 'x' })
  assert.equal(broken.root, 'r')
  assert.equal(broken.sparks.size, 0)
})

test('a page counts as the same one after a redirect to www or https', () => {
  assert.equal(samePage('http://example.com/a?b=1', 'https://www.example.com/a?b=1'), true)
  assert.equal(samePage('https://www.example.com/', 'https://example.com'), true)
  assert.equal(samePage('https://example.com/a', 'https://example.com/b'), false)
  assert.equal(samePage('https://example.com:8080/', 'https://example.com/'), false)
  assert.equal(samePage('https://sub.example.com/', 'https://example.com/'), false)
  assert.equal(samePage('ftp://example.com/', 'https://example.com/'), false)
})

test('a page is only the same one after a redirect, not with any www or http in it', () => {
  assert.equal(samePage('https://a.www.example.com/', 'https://a.example.com/'), false)
  assert.equal(samePage('git+https://example.com/', 'https://example.com/'), false)
  assert.equal(samePage('https+x://example.com/', 'https://example.com/'), false)
  assert.equal(samePage('not a url', 'not a url'), true)
  assert.equal(samePage('not a url', 'other'), false)
})

const editCount = async (context: Setup, edit: (doc: Doc) => void): Promise<number> => {
  const writes = context.api.writes
  await context.store.commit((doc) => {
    edit(doc)
    return undefined
  })
  await context.settle()
  return context.api.writes - writes
}

test('a push writes only what changed', async () => {
  const context = await seeded()
  assert.equal(
    await editCount(context, (doc) => {
      const [first] = doc.sparks
      if (first) first.title = toLabel('renamed')
    }),
    1
  )
  assert.equal(
    await editCount(context, (doc) => {
      viewOf(doc, 'Home').sort = 'date'
    }),
    1,
    'the views bookmark only'
  )
  assert.equal(
    await editCount(context, (doc) => {
      doc.prefs.columns = 7
    }),
    0
  )
})

test('reordering sparks in FireDial moves as few bookmarks as it takes', async () => {
  const context = await seeded()
  const moves = await editCount(context, (doc) => {
    moveInView(doc, viewOf(doc, 'All'), [SparkId.parse(2)], SparkId.parse(0), false)
  })
  assert.equal(moves, 1 + 1, 'one move, and the views bookmark')
  assert.deepEqual(context.api.shape(), ['c', 'a', 'b', ...DATA])
})

test('a removal that Firefox already made is not made again', async () => {
  const { store, api, kv, settle } = await seeded()
  await api.remove(api.child('b').id)
  await store.commit((doc) => {
    doc.sparks = doc.sparks.filter((item) => item.title !== 'b')
    return undefined
  })
  const writes = api.writes
  await settle()
  assert.equal(api.writes - writes, 2, 'the label and views bookmarks only')
  const map = parseMap(kv.data.get('bookmarkMap'))
  assert.equal(map.sparks.size, 2)
  assert.equal(kv.data.get('syncedRev'), store.revision)
})

test('the map is saved along the way of a long push', async () => {
  const context = await setup()
  await context.store.commit((doc) => {
    for (let index = 0; index < 120; index++) spark(doc, `s${index}`)
    return undefined
  })
  context.kv.sets.length = 0
  await context.settle()
  assert.equal(context.kv.sets.filter((keys) => keys.join() === 'bookmarkMap').length, 2)
})

test('a pull takes everything from Firefox, even over the limits', async () => {
  const { store, api, settle } = await seeded()
  const folder = api.folder()
  for (let index = 0; index < LIMITS.sparks; index++) folder.children?.push({ id: `many${index}`, title: 'm', type: 'bookmark', url: 'https://m.example/' })
  await settle()
  assert.equal(store.doc.sparks.length, LIMITS.sparks + 3)
})

test('jobs asked for at once run one after the other', async () => {
  const context = await setup()
  await context.store.commit((doc) => {
    spark(doc, 'a')
    return undefined
  })
  await Promise.all([context.sync.requestPush(), context.sync.requestPush(), context.sync.start()])
  assert.deepEqual(context.api.shape(), ['a', 'FireDial views'])
})

test('a failed job is logged and the next one runs', async (t) => {
  const context = await seeded()
  const errors = t.mock.method(console, 'error', () => undefined)
  const getChildren = t.mock.method(context.api, 'getChildren', () => Promise.reject(new Error('down')))
  context.kv.data.delete('bookmarkMap')
  await context.settle()
  assert.equal(errors.mock.callCount(), 1)
  assert.equal(errors.mock.calls[0]?.arguments[0], 'FireDial bookmark sync:')
  getChildren.mock.restore()
  await context.settle()
  assert.deepEqual(context.api.shape(), ['a', 'b', 'c', ...DATA])
})

test('a pull waits for Firefox to calm down, and pushes what FireDial changed first', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { store, api, sync } = await seeded()
  const settled = async (): Promise<void> => {
    for (let turn = 0; turn < 50; turn++) await new Promise(setImmediate)
  }
  await store.commit((doc) => {
    spark(doc, 'd')
    return undefined
  })
  await sync.requestPush()
  assert.deepEqual(api.shape(), ['a', 'b', 'c', 'd', ...DATA])
  api.child('c').title = 'renamed'
  sync.requestPull()
  t.mock.timers.tick(299)
  sync.requestPull()
  t.mock.timers.tick(299)
  await settled()
  assert.deepEqual(titles(store), ['a', 'b', 'c', 'd'])
  t.mock.timers.tick(1)
  await settled()
  assert.deepEqual(titles(store), ['a', 'b', 'renamed', 'd'])
  await store.commit((doc) => {
    spark(doc, 'e')
    return undefined
  })
  await api.create({ parentId: api.folder().id, title: 'new', url: 'https://new.example/' })
  sync.requestPull()
  t.mock.timers.tick(300)
  await settled()
  assert.deepEqual(titles(store), ['a', 'b', 'renamed', 'd', 'e', 'new'])
})

const labelSparks = (titlesToLabel: readonly string[], label: string) => (doc: Doc) => {
  addLabels(
    doc.sparks.filter((item) => titlesToLabel.includes(item.title)),
    [LabelName.parse(label)]
  )
  return undefined
}

test('without labels there is no label bookmark', async () => {
  const context = await setup()
  await context.store.commit((doc) => {
    spark(doc, 'a')
    return undefined
  })
  await context.settle()
  assert.deepEqual(context.api.shape(), ['a', 'FireDial views'])
})

test('a label change on one device reaches the other, removals too', async () => {
  const first = await seeded()
  await first.store.commit(labelSparks(['a'], 'web'))
  await first.settle()
  const second = await secondDevice(first.api)
  assert.deepEqual(labelsOf(second.store), [['Home', 'web'], ['Home'], ['Linux']])
  await second.store.commit((doc) => {
    removeLabels(doc.sparks, ['web'])
    return labelSparks(['b'], 'news')(doc)
  })
  await second.settle()
  await first.settle()
  assert.deepEqual(labelsOf(first.store), [['Home'], ['Home', 'news'], ['Linux']])
  await first.store.commit((doc) => {
    removeLabels(doc.sparks, ['news', 'home', 'linux'])
    return undefined
  })
  await first.settle()
  await second.settle()
  assert.deepEqual(labelsOf(second.store), [[], [], []], 'the last label gone is gone there too')
})

test('a synced state with labels and views causes no writes', async () => {
  const { store, api, settle } = await seeded()
  await store.commit(labelSparks(['a', 'b'], 'docs'))
  await settle()
  const writes = api.writes
  await settle()
  await settle()
  assert.equal(api.writes, writes)
})

test('broken data bookmarks leave labels and views alone', async () => {
  const { store, api, settle } = await seeded()
  api.child('FireDial labels').url = 'https://firedial.invalid/labels/1-2#%7B%7D'
  api.child('FireDial views').url = 'https://firedial.invalid/views/1-1#%7Bbroken'
  await api.create({ parentId: api.folder().id, title: 'new', url: 'https://new.example/' })
  await settle()
  assert.deepEqual(labelsOf(store), [['Home'], ['Home'], ['Linux'], []])
  assert.deepEqual(
    store.doc.views.map((view) => view.title),
    ['All', 'Unlabeled', 'Home', 'Linux']
  )
})

test('label data longer than one address is split and joined again', () => {
  const labels: Record<string, LabelName[]> = {}
  for (let index = 0; index < 3000; index += 1) labels[`bookmark-${index}`] = [LabelName.parse(`Label number ${index}`)]
  const urls = labelDataUrls(labels)
  assert.ok(urls.length > 1)
  for (const url of urls) assert.ok(url.length < 65_000, String(url.length))
  const nodes: TreeNode[] = urls.map((url, index) => ({ id: `n${index}`, title: 'FireDial labels', type: 'bookmark', url }))
  assert.deepEqual(readLabelData([...nodes].reverse()), new Map(Object.entries(labels)), 'in any order')
  assert.equal(readLabelData(nodes.slice(1)), null, 'a part missing')
  assert.equal(readLabelData([]), null)
  assert.equal(readLabelData([{ id: 'x', title: '', type: 'bookmark', url: 'https://firedial.invalid/labels/1-1#%7Bbroken' }]), null)
})

test('label data keeps only valid labels, each once', () => {
  const [url] = labelDataUrls({ b1: ['docs', 'Docs', 'Two Words', '', 'a,b'].map((text) => LabelName.parse(text)) })
  assert.ok(url)
  assert.deepEqual(readLabelData([{ id: 'x', title: '', type: 'bookmark', url }]), new Map([['b1', ['docs', 'Two Words']]]))
})

test('view data reads back, and broken views are left out', () => {
  const rule = { all: false, include: [LabelName.parse('a')], exclude: [] }
  const urls = viewDataUrls([{ kind: 'normal', title: LabelName.parse('Work'), sort: 'name', rule, order: ['b1', 'b2'] }])
  const nodes: TreeNode[] = urls.map((url, index) => ({ id: `v${index}`, title: 'FireDial views', type: 'bookmark', url }))
  assert.deepEqual(readViewData(nodes), [{ kind: 'normal', title: 'Work', sort: 'name', rule, order: ['b1', 'b2'] }])
  assert.equal(readViewData([]), null)
})

test('data bookmarks: ten parts and more read back; a stray, mixed or unreadable part spoils them', () => {
  const labels: Record<string, LabelName[]> = {}
  for (let index = 0; index < 16_000; index += 1) labels[`bookmark-${index}`] = [LabelName.parse(`Label number ${index}`)]
  const urls = labelDataUrls(labels)
  assert.ok(urls.length >= 10, String(urls.length))
  const node = (url: string, index = 0): TreeNode => ({ id: `n${index}`, title: 'FireDial labels', type: 'bookmark', url })
  const nodes = urls.map(node)
  assert.equal(readLabelData(nodes)?.size, 16_000)
  const prefix = 'https://firedial.invalid/labels/'
  assert.equal(readLabelData([...nodes, node(`${prefix}x1-1#%7B%7D`)]), null, 'a part with junk before its number')
  assert.equal(readLabelData([node(`${prefix}1-1#%7B%7D`), node(`${prefix}2-2#`)]), null, 'parts that disagree on how many there are')
  assert.equal(readLabelData([node(`${prefix}1-1#%E0%A4%A`)]), null, 'text that does not decode')
  assert.deepEqual(
    readLabelData([node(`${prefix}1-1#${encodeURIComponent(JSON.stringify({ b1: 'docs', b2: ['Docs'] }))}`)]),
    new Map([
      ['b1', []],
      ['b2', ['Docs']]
    ]),
    'labels that are no list count as none'
  )
  const [view] = viewDataUrls([])
  assert.ok(view)
  assert.deepEqual(
    readViewData([
      {
        id: 'v',
        title: '',
        type: 'bookmark',
        url: view.replace(/#.*/, `#${encodeURIComponent(JSON.stringify([{ kind: 'normal', title: 'W', order: 'b1' }]))}`)
      }
    ])?.[0]?.order,
    [],
    'an order that is no list is empty'
  )
})
