// E2E probe: market 发现 tab — measure the search row vs the category row
// ("全部…" chips) geometry + DOM order + computed styles.
(async function () {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const describe = b => ((b.getAttribute('aria-label') || '') + ' | ' + (b.textContent || '').trim()).slice(0, 60)
  const leaves = () => Array.from(document.querySelectorAll('button, [role="tab"], [role="menuitem"], div, span'))
    .filter(n => n.children.length === 0)

  const settingsBtn = Array.from(document.querySelectorAll('button')).find(b => /设置|Settings|Preferences/i.test(describe(b)))
  settingsBtn.click()
  await wait(1500)
  leaves().find(n => /插件市场|Plugin Market|Market/i.test((n.textContent || '').trim())).click()
  await wait(4500)

  const search = document.querySelector('input[placeholder*="搜索插件"]')
  const cats = Array.from(document.querySelectorAll('div')).find(el => /全部/.test(el.textContent || '') && el.children.length > 0 && (el.className || '').includes('cats') && !(el.parentElement?.className || '').includes('cats'))
  const r = el => { const b = el.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)] }

  const searchRow = search === null ? null : search.closest('[class*="tabSearchRow"]')
  const catsRow = cats === null ? null : cats
  const order = (searchRow !== null && catsRow !== null)
    ? (searchRow.compareDocumentPosition(catsRow) & Node.DOCUMENT_POSITION_FOLLOWING ? 'search-first' : 'cats-first')
    : null

  const cs = cats === null ? null : getComputedStyle(cats)
  return {
    search: search === null ? null : r(search),
    searchRow: searchRow === null ? null : r(searchRow),
    cats: cats === null ? null : r(cats),
    catsStyle: cats === null ? null : { position: cs.position, top: cs.top, margin: cs.margin, zIndex: cs.zIndex },
    order,
    overlap: (search === null || cats === null) ? null : Math.max(0, Math.min(r(search)[1] + r(search)[3], r(cats)[1] + r(cats)[3]) - Math.max(r(search)[1], r(cats)[1])),
  }
})()
