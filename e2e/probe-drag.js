// E2E probe: verify the injected immersive-frame CSS took effect —
// the drag strip pseudo-element carries -webkit-app-region: drag, and the
// brand button sits below the traffic-light band.
(function () {
  const strip = getComputedStyle(document.body, '::before')
  const region = strip.getPropertyValue('-webkit-app-region')
  const brand = document.querySelector('button[class*="brand"]')
  const brandRect = brand === null ? null : {
    x: Math.round(brand.getBoundingClientRect().x),
    y: Math.round(brand.getBoundingClientRect().y),
    w: Math.round(brand.getBoundingClientRect().width),
    h: Math.round(brand.getBoundingClientRect().height),
  }
  return {
    dragRegion: region,
    brandRect,
    ok: region === 'drag' && brandRect !== null && brandRect.y >= 40,
  }
})()
