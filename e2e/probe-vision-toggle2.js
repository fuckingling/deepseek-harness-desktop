// E2E probe (round 2): toggle the vision sidebar switch OFF then back ON
// while the settings modal is open; the panel must mount at z-index 999 and
// the root must never shrink.
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
  const toggle = leaves().find(n => /^(侧边栏|Sidebar)$/.test((n.textContent || '').trim()))
  if (!toggle) return { ok: false, step: 'no-toggle' }

  const root = document.getElementById('root')
  const samples = []
  const sample = at => {
    const panel = document.querySelector('.LLI1OG_panel')
    samples.push({
      at,
      rootWidth: Math.round(root.getBoundingClientRect().width),
      panelZ: panel === null ? null : getComputedStyle(panel).zIndex,
      panelPresent: panel !== null,
    })
  }
  sample('start')
  toggle.click() // off
  await wait(700)
  sample('after-off')
  toggle.click() // back on
  for (let ms = 50; ms <= 500; ms += 50) { await wait(50); sample(`on+${ms}ms`) }
  await wait(800)
  sample('on-final')

  const shrunk = samples.filter(s => s.rootWidth < window.innerWidth - 10)
  const panelAbove = samples.filter(s => s.panelPresent && Number(s.panelZ) >= 1000)
  return {
    ok: shrunk.length === 0 && panelAbove.length === 0 && samples.filter(s => s.panelPresent).length > 0,
    windowWidth: window.innerWidth,
    samples,
    shrunkCount: shrunk.length,
    panelAboveCount: panelAbove.length,
  }
})()
