// E2E probe: report the page elements occupying the top 40px strip
// (tag, class, text, rect) so the shell can place a drag region safely.
(function () {
  const rows = []
  const all = document.querySelectorAll('header, nav, aside, div, button, span, [class*="side"], [class*="top"], [class*="header"], [class*="title"]')
  const seen = new Set()
  for (const el of all) {
    const rect = el.getBoundingClientRect()
    if (rect.bottom < 60 && rect.width > 40 && rect.height > 4) {
      const key = `${el.tagName}|${el.className}`
      if (seen.has(key)) continue
      seen.add(key)
      rows.push({
        tag: el.tagName,
        cls: String(el.className).slice(0, 70),
        text: (el.textContent || '').trim().slice(0, 24),
        rect: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)],
      })
    }
  }
  return { title: document.title, top: rows.slice(0, 30) }
})()
