// E2E probe: inventory all inputs (search boxes) with rects and ancestors.
(function () {
  const out = []
  for (const el of document.querySelectorAll('input, [contenteditable="true"], textarea, [role="searchbox"], [class*="search"], [class*="Search"]')) {
    const r = el.getBoundingClientRect()
    if (r.width < 40) continue
    let parent = el.parentElement
    const chain = []
    for (let i = 0; i < 3 && parent !== null; i += 1) { chain.push(String(parent.className).slice(0, 50)); parent = parent.parentElement }
    out.push({
      tag: el.tagName,
      type: el.getAttribute('type') ?? '',
      ph: (el.getAttribute('placeholder') || '').slice(0, 30),
      aria: (el.getAttribute('aria-label') || '').slice(0, 30),
      cls: String(el.className).slice(0, 60),
      rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      underStrip: r.y < 32, // inside the injected drag strip zone
      underLights: r.y < 30 && r.x < 90, // traffic-light zone
      chain,
    })
  }
  return { inputs: out }
})()
