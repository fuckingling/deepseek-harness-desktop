// E2E probe: market 发现 tab — scroll the list, then verify the category bar
// no longer covers the search box (the input scrolls away under the bar with
// no resting overlap, and the bar sticks flush at the container top).
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

  const body = document.querySelector('[class*="tabSearchRow"]')?.parentElement?.parentElement
  const search = document.querySelector('input[placeholder*="搜索插件"]')
  const cats = Array.from(document.querySelectorAll('div')).find(el => /全部/.test(el.textContent || '') && el.children.length > 0 && (el.className || '').includes('cats') && !(el.parentElement?.className || '').includes('cats'))
  const r = el => { const b = el.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)] }

  const before = { catsTop: getComputedStyle(cats).top, catsMarginTop: getComputedStyle(cats).marginTop, cats: r(cats), search: search === null ? null : r(search) }

  // scroll the market body by a few hundred px and re-measure
  const scrollEl = body ?? document.scrollingElement
  scrollEl.scrollTop = 400
  await wait(600)
  const afterScroll = { scrollTop: scrollEl.scrollTop, cats: r(cats), search: search === null ? null : r(search) }

  // is any part of the search rect covered by the cats bar while scrolled?
  let overlap = 0
  if (search !== null) {
    const s = r(search)
    const c = r(cats)
    overlap = Math.max(0, Math.min(s[1] + s[3], c[1] + c[3]) - Math.max(s[1], c[1]))
  }

  return {
    ok: before.catsTop === '0px' && before.catsMarginTop === '0px' && overlap === 0,
    before,
    afterScroll,
    overlap,
  }
})()
