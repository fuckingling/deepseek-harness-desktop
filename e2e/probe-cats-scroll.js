// E2E probe: market 发现 — actually scroll the market body (eGUBIq_body) and
// verify the sticky category bar anchors at the container top without ever
// resting on top of the search box.
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

  const searchRow = document.querySelector('[class*="tabSearchRow"]')
  const body = searchRow === null ? null : searchRow.parentElement // eGUBIq_body is the scroll container
  const cats = Array.from(document.querySelectorAll('div')).find(el => /全部/.test(el.textContent || '') && el.children.length > 0 && (el.className || '').includes('cats') && !(el.parentElement?.className || '').includes('cats'))
  const r = el => { const b = el.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)] }
  const containerTop = body === null ? null : Math.round(body.getBoundingClientRect().y)

  const samples = []
  for (const amount of [0, 200, 400, 800]) {
    if (body !== null) body.scrollTop = amount
    await wait(500)
    samples.push({ scroll: body === null ? null : body.scrollTop, cats: r(cats), searchRow: r(searchRow), containerTop })
  }

  // after real scrolling: cats top must equal the container top (anchored),
  // and the search row must be fully scrolled away (above the bar) — never
  // resting partially under the bar's top edge.
  const scrolled = samples[samples.length - 1]
  const anchored = Math.abs(scrolled.cats[1] - containerTop) <= 2
  const searchGone = scrolled.searchRow[1] + scrolled.searchRow[3] <= scrolled.cats[1] + 2
  return { ok: anchored && searchGone, samples, anchored, searchGone }
})()
