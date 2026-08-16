// E2E probe: open the market, locate the search input, and hit-test its
// rect point by point to find what covers it; also report ancestor clipping.
(async function () {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const describe = b => ((b.getAttribute('aria-label') || '') + ' | ' + (b.textContent || '').trim()).slice(0, 60)
  const leaves = () => Array.from(document.querySelectorAll('button, [role="tab"], [role="menuitem"], div, span'))
    .filter(n => n.children.length === 0)

  const settingsBtn = Array.from(document.querySelectorAll('button')).find(b => /设置|Settings|Preferences/i.test(describe(b)))
  settingsBtn.click()
  await wait(1500)
  leaves().find(n => /插件市场|Plugin Market|Market/i.test((n.textContent || '').trim())).click()
  await wait(3500)

  const input = document.querySelector('input[placeholder*="搜索"]')
  if (input === null) return { ok: false, step: 'no-input' }
  const r = input.getBoundingClientRect()

  // point-scan the input's rect: report topmost elements that are NOT the input
  const hits = new Set()
  for (let y = r.y + 2; y < r.bottom - 1; y += 4) {
    for (let x = r.x + 2; x < r.right - 1; x += 4) {
      const el = document.elementFromPoint(x, y)
      if (el === null) continue
      if (el === input || input.contains(el) || el.contains(input)) continue
      hits.add(`${el.tagName}.${String(el.className).slice(0, 60)}`)
    }
  }

  // ancestor clipping: any ancestor whose overflow clips the input's box
  const clip = []
  let node = input.parentElement
  while (node !== null && node !== document.body) {
    const cs = getComputedStyle(node)
    const nr = node.getBoundingClientRect()
    if ((cs.overflow === 'hidden' || cs.overflowX === 'hidden' || cs.overflowY === 'hidden' || cs.overflow === 'clip') && (nr.width < r.width + 1 || nr.height < r.height + 1)) {
      clip.push({ cls: String(node.className).slice(0, 60), rect: [Math.round(nr.x), Math.round(nr.y), Math.round(nr.width), Math.round(nr.height)], overflow: cs.overflow })
    }
    node = node.parentElement
  }

  const inputStyles = getComputedStyle(input)
  return {
    ok: hits.size === 0,
    inputRect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
    inputSize: inputStyles.fontSize + ' / height ' + inputStyles.height,
    covering: [...hits],
    clippedBy: clip,
  }
})()
