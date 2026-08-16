// E2E probe: verify the traffic-light clearance in both sidebar modes.
// Clicks the sidebar toggle (wide → collapsed rail) and reports geometry.
(async function () {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const rect = el => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
  const logoRow = () => document.querySelector('[class*="logoRow"]')
  const toggle = () => document.querySelector('button[class*="toggle"]')

  const wide = { logoRow: rect(logoRow()), toggle: rect(toggle()), paddingTop: getComputedStyle(logoRow()).paddingTop }
  toggle().click()
  await wait(800)
  const collapsed = { logoRow: rect(logoRow()), toggle: rect(toggle()), paddingTop: getComputedStyle(logoRow()).paddingTop }

  // traffic lights ≈ x 12-72, y 12-30; content must start at y >= 32
  const wideOk = wide.toggle.y >= 32
  const collapsedOk = collapsed.toggle.y >= 32
  return { wide, collapsed, ok: wideOk && collapsedOk }
})()
