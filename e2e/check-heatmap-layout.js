// E2E probe: nav order (个人中心 first) + heatmap layout (full width, month
// labels below, no weekday column, lighter future cells).
(async function () {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const describe = b => ((b.getAttribute('aria-label') || '') + ' | ' + (b.textContent || '').trim()).slice(0, 60)
  const leaves = () => Array.from(document.querySelectorAll('button, [role="tab"], [role="menuitem"], div, span'))
    .filter(n => n.children.length === 0)

  const settingsBtn = Array.from(document.querySelectorAll('button')).find(b => /设置|Settings|Preferences/i.test(describe(b)))
  settingsBtn.click()
  await wait(1500)
  const navTexts = Array.from(document.querySelectorAll("span[class*='navLabel']")).map(n => (n.textContent || '').trim())
  const first = navTexts.length > 0 ? navTexts[0] : null

  leaves().find(n => /个人中心|Personal/.test((n.textContent || '').trim())).click()
  await wait(2500)

  // the heatmap grid: element with gridTemplateColumns repeat(... 1fr)
  const grids = Array.from(document.querySelectorAll('div')).filter(el => {
    const cs = getComputedStyle(el)
    return cs.display === 'grid' && cs.gridTemplateColumns.split(' ').length > 10
  })
  const grid = grids.length > 0 ? grids[0] : null
  const cells = grid === null ? [] : Array.from(grid.querySelectorAll(':scope > div > div'))
  const futureCell = cells.find(c => getComputedStyle(c).backgroundColor === 'rgba(128, 132, 145, 0.05)')
  const labelRow = grid === null ? null : grid.nextElementSibling
  const body = document.body.innerText
  return {
    ok: first === '个人中心' && grid !== null && cells.length >= 182 && futureCell !== undefined && !/^(一|三|五)$/m.test(body),
    first,
    navTexts: navTexts.slice(0, 4),
    gridWidth: grid === null ? null : grid.getBoundingClientRect().width,
    cellCount: cells.length,
    futureCellFound: futureCell !== undefined,
    labelRowBelow: labelRow === null ? null : labelRow.getBoundingClientRect().y > grid.getBoundingClientRect().y + grid.getBoundingClientRect().height,
    monthText: labelRow === null ? null : (labelRow.textContent || '').trim().slice(0, 30),
  }
})()
