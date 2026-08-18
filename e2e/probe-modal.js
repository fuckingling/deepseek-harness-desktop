// E2E probe: settings modal structure — classes, z-indexes, and whether the
// modal renders inside #root (the settings panel shrink targets #root).
(async function () {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const describe = b => ((b.getAttribute('aria-label') || '') + ' | ' + (b.textContent || '').trim()).slice(0, 60)
  const settingsBtn = Array.from(document.querySelectorAll('button')).find(b => /设置|Settings|Preferences/i.test(describe(b)))
  if (!settingsBtn) return { ok: false, step: 'settings button' }
  settingsBtn.click()
  await wait(1500)

  // topmost fixed/absolute layers with z-index
  const layers = []
  const seen = new Set()
  for (const el of document.querySelectorAll('div, section, aside')) {
    const cs = getComputedStyle(el)
    if ((cs.position === 'fixed' || cs.position === 'absolute') && cs.zIndex !== 'auto' && cs.zIndex !== '0') {
      const r = el.getBoundingClientRect()
      if (r.width < 100 || r.height < 100) continue
      const key = `${el.className}|${cs.zIndex}`
      if (seen.has(key)) continue
      seen.add(key)
      const inRoot = el.closest('#root') !== null
      layers.push({ cls: String(el.className).slice(0, 60), z: cs.zIndex, inRoot, rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] })
    }
  }
  layers.sort((a, b) => Number(b.z) - Number(a.z))

  // the settings panel itself (deepest large modal-ish element)
  const center = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2)
  return {
    ok: true,
    topLayers: layers.slice(0, 12),
    centerTop: center === null ? null : { tag: center.tagName, cls: String(center.className).slice(0, 60) },
  }
})()
