// E2E probe: open settings and report the panel + close-button rects,
// verifying nothing interactive sits inside the top drag strip (y < 32).
(async function () {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const buttons = Array.from(document.querySelectorAll('button'))
  const hit = buttons.find(b => /设置|Settings|Preferences/i.test(((b.getAttribute('aria-label') || '') + ' | ' + (b.textContent || '').trim())))
  if (!hit) return { ok: false, reason: 'settings button not found' }
  hit.click()
  await wait(1500)
  const close = Array.from(document.querySelectorAll('button')).find(b => /关闭|Close/.test((b.textContent || '').trim()))
  const rect = el => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
  const closeRect = close === null ? null : rect(close)
  return {
    ok: closeRect === null ? false : closeRect.y >= 32 || closeRect.y + closeRect.h <= 0,
    closeRect,
  }
})()
