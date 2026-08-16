// E2E probe: shrink the sidebar by dragging its resize handle, then report
// the brand button geometry + ancestor chain so the shell CSS can reserve
// the traffic-light zone in every sidebar mode.
(async function () {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const rect = el => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }

  const before = (() => {
    const brand = document.querySelector('button[class*="brand"], [class*="brand"]')
    if (brand === null) return null
    const chain = []
    let el = brand
    for (let i = 0; i < 4 && el !== null; i += 1) { chain.push({ tag: el.tagName, cls: String(el.className).slice(0, 60) }); el = el.parentElement }
    return { rect: rect(brand), chain }
  })()

  // find the sidebar resize handle (cursor col-resize / ew-resize)
  const all = Array.from(document.querySelectorAll('*'))
  const handle = all.find(el => {
    const cs = getComputedStyle(el)
    return cs.cursor === 'col-resize' || cs.cursor === 'ew-resize' || (el.getAttribute('role') === 'separator')
  })
  let dragged = false
  if (handle !== undefined) {
    const r = handle.getBoundingClientRect()
    const cx = r.x + r.width / 2
    const cy = r.y + r.height / 2
    const fire = (type, x, y, extra = {}) => handle.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, button: 0, buttons: type === 'pointerup' ? 0 : 1, ...extra }))
    fire('pointerdown', cx, cy)
    await wait(120)
    for (let step = 1; step <= 8; step += 1) {
      fire('pointermove', cx - step * 24, cy)
      await wait(60)
    }
    fire('pointerup', cx - 192, cy)
    await wait(600)
    dragged = true
  }

  const after = (() => {
    const brand = document.querySelector('button[class*="brand"], [class*="brand"]')
    if (brand === null) return null
    const chain = []
    let el = brand
    for (let i = 0; i < 4 && el !== null; i += 1) { chain.push({ tag: el.tagName, cls: String(el.className).slice(0, 60) }); el = el.parentElement }
    return { rect: rect(brand), chain }
  })()

  // traffic lights sit at approximately x 12-70, y 12-28 (hiddenInset)
  const lights = { x1: 12, y1: 12, x2: 72, y2: 30 }
  const overlap = after === null ? null : !(after.rect.y >= lights.y2 || after.rect.x + after.rect.w <= lights.x1 || after.rect.y + after.rect.h <= lights.y1)

  return {
    dragged,
    before,
    after,
    overlapWithLights: overlap,
    marginTop: after === null ? null : getComputedStyle(after.node ?? document.querySelector('[class*="brand"]')).marginTop,
    windowInner: { w: window.innerWidth, h: window.innerHeight },
  }
})()
