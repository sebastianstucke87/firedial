import assert from 'node:assert/strict'
import { test } from 'node:test'

import { planImport } from './import.ts'
import type { BookmarkNode, ImportPlan } from './import.ts'
import { allocSpark, allocView, emptyDoc, SparkUrl, toLabel } from './model.ts'

let next = 0
const bookmark = (title: string, url: string): BookmarkNode => ({ id: `b${next++}`, title, type: 'bookmark', url })
const folder = (title: string, ...children: BookmarkNode[]): BookmarkNode => ({ id: `f${next++}`, title, type: 'folder', children })
const area = (id: string, title: string, ...children: BookmarkNode[]): BookmarkNode => ({ id, title, type: 'folder', children })

function tree(...areas: BookmarkNode[]): BookmarkNode {
  return { id: 'root________', title: '', type: 'folder', children: areas }
}

const shape = (plan: ImportPlan): unknown => plan.sparks.map((spark) => [spark.title, spark.url, spark.labels.join(', ')])

test('every folder becomes a label, a top folder a view too', () => {
  const plan = planImport(
    tree(
      area(
        'toolbar_____',
        'Bookmarks Toolbar',
        folder('Work', bookmark('Board', 'https://board.example/'), folder('Docs', folder('Read Later', bookmark('Ref', 'https://ref.example/'))))
      )
    ),
    emptyDoc(),
    null
  )
  assert.deepEqual(shape(plan), [
    ['Board', 'https://board.example/', 'Work'],
    ['Ref', 'https://ref.example/', 'Work, Docs, Read Later']
  ])
  assert.deepEqual(plan.views, ['Work'])
  assert.deepEqual([plan.sparks.length, plan.folders, plan.known, plan.skipped], [2, 2, 0, 0])
})

test('bookmarks outside any folder come without a label', () => {
  const plan = planImport(
    tree(
      area('toolbar_____', 'Toolbar', bookmark('A', 'https://a.example/')),
      area('menu________', '', bookmark('B', 'https://b.example/')),
      area('mobile______', 'Mobile')
    ),
    emptyDoc(),
    null
  )
  assert.deepEqual(shape(plan), [
    ['A', 'https://a.example/', ''],
    ['B', 'https://b.example/', '']
  ])
  assert.deepEqual(plan.views, [])
})

test("FireDial's own folder stays out, by id or by name", () => {
  const own = folder('FireDial', bookmark('Mine', 'https://mine.example/'))
  const other = folder('FireDial', bookmark('Theirs', 'https://theirs.example/'))
  const bookmarks = tree(area('unfiled_____', 'Other Bookmarks', own), area('toolbar_____', 'Toolbar', other))
  assert.deepEqual(planImport(bookmarks, emptyDoc(), own.id).views, ['FireDial'], 'a folder of that name elsewhere is just a folder')
  assert.deepEqual(
    planImport(bookmarks, emptyDoc(), null).sparks.map((spark) => spark.title),
    ['Theirs']
  )
  assert.equal(planImport(tree(area('unfiled_____', 'Other Bookmarks', own)), emptyDoc(), null).sparks.length, 0)
})

test("Chrome's bookmarks, without types: folders by their missing address, FireDial's by name in Other bookmarks", () => {
  const chromeFolder = (title: string, ...children: BookmarkNode[]): BookmarkNode => ({ id: `f${next++}`, title, children })
  const link = (title: string): BookmarkNode => ({ id: `b${next++}`, title, url: `https://${title}.example/` })
  const bookmarks: BookmarkNode = {
    id: '0',
    title: '',
    children: [
      { id: '1', title: 'Bookmarks bar', folderType: 'bookmarks-bar', children: [link('bar'), chromeFolder('FireDial', link('kept'))] },
      { id: '8', title: 'Other bookmarks', folderType: 'other', children: [chromeFolder('FireDial', link('own')), chromeFolder('Work', link('w'))] }
    ]
  }
  const plan = planImport(bookmarks, emptyDoc(), null)
  assert.deepEqual(shape(plan), [
    ['bar', 'https://bar.example/', ''],
    ['kept', 'https://kept.example/', 'FireDial'],
    ['w', 'https://w.example/', 'Work']
  ])
})

test('a view of the same name is used, and an address FireDial has is left out', () => {
  const doc = emptyDoc()
  allocView(doc, 'work')
  allocSpark(doc, { title: toLabel('Board'), url: SparkUrl.parse('https://board.example'), thumb: null })
  const plan = planImport(
    tree(
      area(
        'toolbar_____',
        'Toolbar',
        folder('Work', bookmark('Board', 'https://board.example/'), bookmark('New', 'https://new.example/'), bookmark('New again', 'https://new.example/'))
      )
    ),
    doc,
    null
  )
  assert.deepEqual(shape(plan), [['New', 'https://new.example/', 'Work']])
  assert.deepEqual(plan.views, [])
  assert.equal(plan.known, 2)
})

test('another # or www, or http, is no double', () => {
  const doc = emptyDoc()
  allocSpark(doc, { title: toLabel('A'), url: SparkUrl.parse('https://a.example/'), thumb: null })
  const plan = planImport(
    tree(
      area(
        'toolbar_____',
        'Toolbar',
        folder(
          'Other',
          bookmark('A', 'https://a.example/'),
          bookmark('A#x', 'https://a.example/#x'),
          bookmark('A#y', 'https://a.example/#y'),
          bookmark('www', 'https://www.a.example/'),
          bookmark('http', 'http://a.example/')
        )
      )
    ),
    doc,
    null
  )
  assert.equal(plan.sparks.length, 4)
  assert.equal(plan.known, 1)
})

test('importing what was imported adds nothing', () => {
  const bookmarks = tree(
    area('toolbar_____', 'Toolbar', bookmark('Loose', 'https://loose.example/'), folder('Work', folder('Docs', bookmark('D', 'https://d.example/'))))
  )
  const doc = emptyDoc()
  const plan = planImport(bookmarks, doc, null)
  for (const title of plan.views) allocView(doc, title)
  for (const spark of plan.sparks) allocSpark(doc, { ...spark, thumb: null })
  const again = planImport(bookmarks, doc, null)
  assert.deepEqual([again.sparks.length, again.known, again.views.length], [0, 2, 0])
})

test('separators, queries and addresses FireDial can not hold are left out', () => {
  const plan = planImport(
    tree(
      area(
        'toolbar_____',
        'Toolbar',
        { id: 's', title: '', type: 'separator' },
        bookmark('Recent', 'place:sort=8&maxResults=10'),
        bookmark('Long', `https://a.example/${'x'.repeat(5000)}`),
        bookmark('Fine', 'https://fine.example/')
      )
    ),
    emptyDoc(),
    null
  )
  assert.deepEqual([plan.sparks.length, plan.skipped], [1, 2])
})

test('folder names keep their case; commas and empty names go, each label once', () => {
  const labelsFor = (...path: string[]): string => {
    let inner: BookmarkNode = bookmark('X', `https://x${next++}.example/`)
    for (const name of [...path].reverse()) inner = folder(name, inner)
    const plan = planImport(tree(area('toolbar_____', 'Toolbar', inner)), emptyDoc(), null)
    return plan.sparks[0]?.labels.join(' | ') ?? ''
  }
  assert.equal(labelsFor('Read Later', 'C++, Rust'), 'Read Later | C++ Rust')
  assert.equal(labelsFor('  ', 'Docs', 'docs'), 'Docs')
})

test('a top folder without a usable name makes no view', () => {
  const plan = planImport(tree(area('toolbar_____', 'Toolbar', folder(' ', folder('Docs', bookmark('D', 'https://d.example/'))))), emptyDoc(), null)
  assert.deepEqual(plan.views, [])
  assert.deepEqual(plan.sparks[0]?.labels, ['Docs'])
})

test('nodes from an older Firefox, without a type, tell folders from bookmarks by their address', () => {
  const plan = planImport(
    {
      id: 'root________',
      title: '',
      children: [
        {
          id: 'toolbar_____',
          title: 'Toolbar',
          children: [
            { id: 'u1', title: 'Loose', url: 'https://loose.example/' },
            { id: 'u2', title: 'Old', children: [{ id: 'u3', title: 'Inner', url: 'https://inner.example/' }] }
          ]
        },
        { id: 'menu________', title: 'Menu' }
      ]
    },
    emptyDoc(),
    null
  )
  assert.deepEqual(shape(plan), [
    ['Loose', 'https://loose.example/', ''],
    ['Inner', 'https://inner.example/', 'Old']
  ])
  assert.deepEqual(plan.views, ['Old'])
  assert.deepEqual(planImport({ id: 'root________', title: '' }, emptyDoc(), null).sparks, [], 'a tree without children')
})

test("FireDial's own folder stays out by id at any depth; elsewhere a FireDial folder is just a folder", () => {
  const own = folder('Sparks', bookmark('Mine', 'https://mine.example/'))
  const named = folder('FireDial', bookmark('Named', 'https://named.example/'))
  const bookmarks = tree(area('toolbar_____', 'Toolbar', folder('Work', own, bookmark('W', 'https://w.example/'))), area('unfiled_____', 'Other', named))
  assert.deepEqual(
    planImport(bookmarks, emptyDoc(), own.id).sparks.map((spark) => spark.title),
    ['W', 'Named']
  )
  assert.deepEqual(
    planImport(tree(area('menu________', 'Menu', folder('FireDial', bookmark('M', 'https://m.example/')))), emptyDoc(), null).views,
    ['FireDial'],
    'only Other Bookmarks holds FireDial'
  )
  const top = folder('Top', bookmark('T', 'https://t.example/'))
  assert.deepEqual(planImport(tree(area('toolbar_____', 'Toolbar', top)), emptyDoc(), top.id).sparks, [], 'by id at the top too')
})

test('a comma in a folder name becomes a space; place: only counts at the start', () => {
  const plan = planImport(
    tree(
      area(
        'toolbar_____',
        'Toolbar',
        folder('A,B', bookmark('Q', 'https://q.example/?find=place:x')),
        bookmark('Odd', 'not an address'),
        bookmark('Odd again', 'not an address')
      )
    ),
    emptyDoc(),
    null
  )
  assert.deepEqual(shape(plan), [
    ['Q', 'https://q.example/?find=place:x', 'A B'],
    ['Odd', 'not an address', '']
  ])
  assert.equal(plan.known, 1, 'an address URL can not read is compared as it is')
})
