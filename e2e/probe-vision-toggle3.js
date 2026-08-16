// E2E probe: click the real Vision Bridge sidebar switch
// (button[role="switch"]) OFF then ON while the settings modal is open, and
// sample root width + panel z-index throughout.
(async function () {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const describe = b => ((b.getAttribute('aria-label') || '') + ' | ' + (b.textContent || '').trim()).slice(0, 60)
  const leaves = () => Array.from(document.querySelectorAll('button, [role="tab"], [role="menuitem"], div, span'))
    .filter(n => n.children.length === 0)

  const settingsBtn = Array.from(document.querySelectorAll('button')).find(b => /设置|Settings|Preferences/i.test(describe(b)))
  settingsBtn.click()
  await wait(1500)
  leaves().find(n => /^(插件|Plugins)$/.test((n.textContent || '').trim())).click()
  await wait(1800)
  leaves().find(n => /^(插件配置|Plugin configuration)$/.test((n.textContent || '').trim())).click()
  await wait(1500)
  leaves().find(n => /视觉桥接|Vision Bridge/.test((n.textContent || '').trim())).click()
  await wait(1500)

  const sw = Array.from(document.querySelectorAll('button[role="switch"]')).find(b => /侧边栏|Sidebar/.test(b.getAttribute('aria-label') || ''))
  if (!sw) return { ok: false, step: 'no-switch' }

  const root = document.getElementById('root')
  const samples = []
  const sample = at => {
    const panel = document.querySelector('.LLI1OG_panel')
    samples.push({
      at,
      checked: sw.getAttribute('aria-checked'),
      rootWidth: Math.round(root.getBoundingClientRect().width),
      panelZ: panel === null ? null : getComputedStyle(panel).zIndex,
      panelPresent: panel !== null,
    })
  }
  sample('start')
  sw.click() // whatever direction → off
  for (let ms = 50; ms <= 400; ms += 50) { await wait(50); sample(`click1+${ms}ms`) }
  await wait(600)
  sample('click1-final')
  sw.click() // → on
  for (let ms = 50; ms <= 400; ms += 50) { await wait(50); sample(`click2+${ms}ms`) }
  await wait(800)
  sample('click2-final')

  const shrunk = samples.filter(s => s.rootWidth < window.innerWidth - 10)
  const panelAbove = samples.filter(s => s.panelPresent && Number(s.panelZ) >= 1000)
  const panelSamples = samples.filter(s => s.panelPresent)
  return {
    ok: shrunk.length === 0 && panelAbove.length === 0 && panelSamples.length > 0,
    windowWidth: window.innerWidth,
    samples,
    shrunkCount: shrunk.length,
    panelAboveCount: panelAbove.length,
    panelSeen: panelSamples.length,
  }
})()
