// E2E probe: default state (no settings open) overlay inventory.
(function () {
  const out = []
  for (const el of document.querySelectorAll('div, section, aside')) {
    const cs = getComputedStyle(el)
    if ((cs.position === 'fixed' || cs.position === 'absolute') && cs.zIndex !== 'auto') {
      const r = el.getBoundingClientRect()
      if (r.width < 50 || r.height < 50) continue
      const cls = String(el.className)
      if (!cls.includes('overlay')) continue
      out.push({ cls: cls.slice(0, 60), z: cs.zIndex, rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] })
    }
  }
  return { overlays: out }
})()
