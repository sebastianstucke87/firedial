// Firefox's own bookmarks into FireDial, once and read-only: Firefox keeps them as they are.
// Every folder a bookmark is in becomes one of its labels, and each top folder a view too (Work ›
// Docs: labels Work and Docs, view Work). Bookmarks outside any folder come without a label.
// FireDial's own folder stays out. An address FireDial has already is left out, so a second
// import adds only what's new.

import { isBookmark, isFolder, isOtherBookmarks } from './bookmarks.ts'
import { sameLabel, toLabel, toLabelName, toSparkUrl, viewTitled } from './model.ts'
import type { Doc, Label, LabelName, SparkUrl } from './model.ts'

export interface BookmarkNode {
  id: string
  title: string
  type?: string | undefined
  folderType?: string | undefined
  url?: string | null | undefined
  children?: BookmarkNode[] | undefined
}

interface PlannedSpark {
  title: Label
  url: SparkUrl
  labels: LabelName[]
}

export interface ImportPlan {
  views: LabelName[] // new views, from top folders with sparks to add
  sparks: PlannedSpark[]
  folders: number // the folders the sparks come from
  known: number // left out: in FireDial already
  skipped: number // left out: no address FireDial can hold
}

// Firefox stores addresses normalized; compared the same way, nothing else: # and www count.
function sameAddress(url: string): string {
  try {
    return new URL(url).href
  } catch {
    return url
  }
}

// A folder name as a label: commas would split it, so they go.
const labelOf = (title: string): LabelName | null => toLabelName(title.replace(/,/g, ' '))

// skip: the id of FireDial's own folder; without one, a folder named FireDial in Other Bookmarks.
export function planImport(root: BookmarkNode, doc: Doc, skip: string | null): ImportPlan {
  const plan: ImportPlan = { views: [], sparks: [], folders: 0, known: 0, skipped: 0 }
  const addresses = new Set(doc.sparks.map((spark) => sameAddress(spark.url)))
  const folders = new Set<string>()

  const add = (node: BookmarkNode, labels: readonly LabelName[], top: LabelName | null, folderId: string): void => {
    const url = toSparkUrl(node.url ?? '')
    if (!url || /^place:/i.test(url)) {
      plan.skipped += 1
      return
    }
    if (addresses.has(sameAddress(url))) {
      plan.known += 1
      return
    }
    addresses.add(sameAddress(url))
    if (top && !viewTitled(doc.views, top) && !plan.views.some((view) => sameLabel(view, top))) plan.views.push(top)
    plan.sparks.push({ title: toLabel(node.title), url, labels: [...labels] })
    folders.add(folderId)
  }

  const walk = (folder: BookmarkNode, labels: readonly LabelName[], top: LabelName | null): void => {
    for (const node of folder.children ?? []) {
      if (isBookmark(node)) add(node, labels, top, folder.id)
      else if (isFolder(node) && node.id !== skip) {
        const label = labelOf(node.title)
        walk(node, label && !labels.some((each) => sameLabel(each, label)) ? [...labels, label] : labels, top)
      }
    }
  }

  for (const area of root.children ?? []) {
    for (const node of area.children ?? []) {
      const ownFolder = node.id === skip || (skip === null && isOtherBookmarks(area) && node.title === 'FireDial')
      if (isBookmark(node)) add(node, [], null, area.id)
      else if (isFolder(node) && !ownFolder) {
        const label = labelOf(node.title)
        walk(node, label ? [label] : [], label)
      }
    }
  }
  plan.folders = folders.size
  return plan
}
