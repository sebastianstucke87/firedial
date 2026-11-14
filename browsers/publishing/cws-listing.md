# Chrome Web Store listing

What to fill in on the Chrome Web Store (Developer Dashboard → FireDial). Each release uploads `dist/chrome` and submits it for review (`release.yml`); everything here is set by hand.

## Store listing

### Description

```
FireDial turns your new tab into a speed dial of your bookmarks, in views. Add any page with a right-click.

Pick a layout, columns, light or dark and an accent color. Search, undo, backups.

No ads, no account, no tracking. Your sparks are Chrome bookmarks, so Chrome sync carries them. Open source: https://github.com/sebastianstucke87/FireDial

Enjoy your new tab!
```

The summary is `description` in `browsers/chrome/manifest.json`.

### Category

Productivity → Tools

### Language

English

### Store icon

`browsers/chrome/icons/icon-128.png`

### Screenshots

`browsers/screenshots/` scaled to 1280×800, the only size the store takes, with the captions in `amo-listing.md`: the same everywhere.

### Small promo tile

`cws-promo-small.png` (440×280), made with the screenshots. No marquee tile.

### Homepage URL

https://github.com/sebastianstucke87/FireDial

### Support URL

https://github.com/sebastianstucke87/FireDial/issues

## Privacy

### Single purpose

```
Shows the user's bookmarks as a speed dial on the new tab page.
```

### Permission justification

| Permission              | Justification                                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| `bookmarks`             | Sparks are stored as bookmarks                                                                              |
| `contextMenus`          | The Add to FireDial context menu                                                                            |
| `activeTab`             | A preview image of the page being added                                                                     |
| `scripting`             | The short confirmation shown on that page after adding                                                      |
| `search`                | Searching the web from the new tab with the user's default search engine                                    |
| `downloads`             | Saving backups                                                                                              |
| `storage`               | Settings, undo history, preview images                                                                      |
| `unlimitedStorage`      | Preview images can outgrow the default quota                                                                |
| `<all_urls>` (optional) | Asked for only by the bookmark import, to load each site's icon from the site itself; given back afterwards |

### Remote code

No, I am not using remote code.

### Data usage

Nothing collected. Tick the three certifications.

### Privacy policy URL

https://github.com/sebastianstucke87/FireDial#trust (FireDial collects and sends no data)

## Distribution

Public, all regions.
