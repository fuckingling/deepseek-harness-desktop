// E2E probe: open settings and verify each custom nav section shows a
// patched icon (data-dsh-navicon) with a distinct glyph, not the stock gear.
(async function () {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const describe = b => ((b.getAttribute('aria-label') || '') + ' | ' + (b.textContent || '').trim()).slice(0, 60)
  const settingsBtn = Array.from(document.querySelectorAll('button')).find(b => /设置|Settings|Preferences/i.test(describe(b)))
  if (!settingsBtn) return { ok: false, step: 'settings' }
  settingsBtn.click()
  await wait(1800)

  const targets = ['插件市场', '备份与还原', '个人中心', '更新']
  const rows = []
  const labels = Array.from(document.querySelectorAll("span[class*='navLabel']"))
  for (const label of labels) {
    const text = (label.textContent || '').trim()
    if (!targets.includes(text)) continue
    const row = label.closest("button, li, [role='tab'], [role='menuitem']") || label.parentElement
    const svg = row === null ? null : row.querySelector('svg')
    rows.push({
      text,
      patched: svg !== null && svg.getAttribute('data-dsh-navicon') === '1',
      pathHead: svg === null ? null : ((svg.querySelector('path')?.getAttribute('d') || '').slice(0, 14)),
      viewBox: svg === null ? null : svg.getAttribute('viewBox'),
    })
  }
  const allPatched = rows.length === targets.length && rows.every(r => r.patched)
  const distinct = new Set(rows.map(r => r.pathHead)).size === rows.length
  return { ok: allPatched && distinct, allPatched, distinct, rows }
})()
