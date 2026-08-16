// E2E probe: open settings → 插件市场 and inventory search inputs there.
(async function () {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const describe = b => ((b.getAttribute('aria-label') || '') + ' | ' + (b.textContent || '').trim()).slice(0, 60)
  const leaves = () => Array.from(document.querySelectorAll('button, [role="tab"], [role="menuitem"], div, span'))
    .filter(n => n.children.length === 0)

  const settingsBtn = Array.from(document.querySelectorAll('button')).find(b => /设置|Settings|Preferences/i.test(describe(b)))
  settingsBtn.click()
  await wait(1500)
  leaves().find(n => /插件市场|Plugin Market|Market/i.test((n.textContent || '').trim())).click()
  await wait(3500)

  const out = []
  for (const el of document.querySelectorAll('input, [contenteditable="true"], textarea, [role="searchbox"]')) {
    const r = el.getBoundingClientRect()
    if (r.width < 40) continue
    let parent = el.parentElement
    const chain = []
    for (let i = 0; i < 3 && parent !== null; i += 1) { chain.push(String(parent.className).slice(0, 50)); parent = parent.parentElement }
    out.push({
      tag: el.tagName,
      type: el.getAttribute('type') ?? '',
      ph: (el.getAttribute('placeholder') || '').slice(0, 40),
      aria: (el.getAttribute('aria-label') || '').slice(0, 30),
      cls: String(el.className).slice(0, 60),
      rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      underStrip: r.y < 32,
      chain,
    })
  }
  return { step: 'market', inputs: out }
})()
