// E2E probe: navigate to the Vision Bridge config card, click its 侧边栏
// toggle, and sample #root width + panel z-index over time to verify the
// injected CSS keeps the modal full-width and the panel below it.
(async function () {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const describe = b => ((b.getAttribute('aria-label') || '') + ' | ' + (b.textContent || '').trim()).slice(0, 60)
  const leaves = () => Array.from(document.querySelectorAll('button, [role="tab"], [role="menuitem"], div, span'))
    .filter(n => n.children.length === 0)
  const step = (name, extra = {}) => ({ step: name, ...extra })

  const settingsBtn = Array.from(document.querySelectorAll('button')).find(b => /设置|Settings|Preferences/i.test(describe(b)))
  if (!settingsBtn) return step('settings-btn', { ok: false })
  settingsBtn.click()
  await wait(1500)

  const plugins = leaves().find(n => /^(插件|Plugins)$/.test((n.textContent || '').trim()))
  if (!plugins) return step('plugins-nav', { ok: false })
  plugins.click()
  await wait(1800)

  const configTab = leaves().find(n => /^(插件配置|Plugin configuration)$/.test((n.textContent || '').trim()))
  if (!configTab) return step('config-tab', { ok: false, texts: leaves().map(n => (n.textContent || '').trim()).filter(t => t !== '' && t.length <= 24).slice(0, 50) })
  configTab.click()
  await wait(1500)

  const card = leaves().find(n => /视觉桥接|Vision Bridge/.test((n.textContent || '').trim()))
  if (!card) return step('vision-card', { ok: false, texts: leaves().map(n => (n.textContent || '').trim()).filter(t => t !== '' && t.length <= 24).slice(0, 50) })
  card.click()
  await wait(1500)

  const toggle = leaves().find(n => /^(侧边栏|Sidebar)$/.test((n.textContent || '').trim()))
  if (!toggle) return step('sidebar-toggle', { ok: false, texts: leaves().map(n => (n.textContent || '').trim()).filter(t => t !== '' && t.length <= 24).slice(0, 60) })

  const root = document.getElementById('root')
  const samples = []
  const sample = at => {
    const panel = document.querySelector('.LLI1OG_panel')
    samples.push({
      at,
      rootWidth: Math.round(root.getBoundingClientRect().width),
      panelZ: panel === null ? null : getComputedStyle(panel).zIndex,
      overlayOpen: document.querySelector('[class*="overlay"]:not([class*="Layer"])') !== null,
    })
  }
  sample('before')
  toggle.click()
  for (let ms = 50; ms <= 500; ms += 50) { await wait(50); sample(`${ms}ms`) }
  await wait(800)
  sample('final')

  // the fix holds if the root never shrank while the overlay stayed open
  const shrunk = samples.filter(s => s.rootWidth < window.innerWidth - 10)
  const panelAbove = samples.filter(s => s.panelZ !== null && Number(s.panelZ) >= 1000)
  return {
    step: 'done',
    ok: shrunk.length === 0 && panelAbove.length === 0,
    windowWidth: window.innerWidth,
    samples,
    shrunkCount: shrunk.length,
    panelAboveCount: panelAbove.length,
  }
})()
