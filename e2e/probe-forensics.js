// E2E probe: full layout forensics for every search-ish input in the market
// view: ancestors' rects + hit-test scan + nav column geometry.
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

  const inputs = []
  for (const el of document.querySelectorAll('input')) {
    const r = el.getBoundingClientRect()
    const chain = []
    let node = el.parentElement
    while (node !== null && node !== document.body) {
      const nr = node.getBoundingClientRect()
      const cs = getComputedStyle(node)
      chain.push({
        cls: String(node.className).slice(0, 60),
        rect: [Math.round(nr.x), Math.round(nr.y), Math.round(nr.width), Math.round(nr.height)],
        overflow: cs.overflow,
        display: cs.display,
        flex: cs.flex,
      })
      node = node.parentElement
    }
    // covering scan
    const covering = []
    if (r.width > 2) {
      const seen = new Set()
      for (let y = r.y + 2; y < r.bottom - 1; y += 3) {
        for (let x = r.x + 2; x < r.right - 1; x += 3) {
          const hit = document.elementFromPoint(x, y)
          if (hit === null || hit === el || el.contains(hit) || hit.contains(el)) continue
          const key = `${hit.tagName}.${String(hit.className).slice(0, 50)}`
          if (!seen.has(key)) { seen.add(key); covering.push(key) }
        }
      }
    }
    inputs.push({
      ph: (el.getAttribute('placeholder') || '').slice(0, 30),
      rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      covering,
      chain,
    })
  }
  // nav labels geometry
  const navs = Array.from(document.querySelectorAll('span[class*="navLabel"]')).map(n => {
    const r = n.getBoundingClientRect()
    return { text: (n.textContent || '').slice(0, 10), rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] }
  })
  return { step: 'market-forensics', windowWidth: window.innerWidth, inputs, navs }
})()
