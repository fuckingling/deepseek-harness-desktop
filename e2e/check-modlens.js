// E2E probe: settings → 插件 page — verify the ModLens card renders
// (the plugin contributes its own settings card over /modlens/config).
(async function () {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const describe = b => ((b.getAttribute('aria-label') || '') + ' | ' + (b.textContent || '').trim()).slice(0, 60)
  const leaves = () => Array.from(document.querySelectorAll('button, [role="tab"], [role="menuitem"], div, span'))
    .filter(n => n.children.length === 0)

  const settingsBtn = Array.from(document.querySelectorAll('button')).find(b => /设置|Settings|Preferences/i.test(describe(b)))
  if (!settingsBtn) return { ok: false, step: 'settings' }
  settingsBtn.click()
  await wait(1500)
  const plugins = leaves().find(n => /^(插件|Plugins)$/.test((n.textContent || '').trim()))
  if (!plugins) return { ok: false, step: 'plugins-nav' }
  plugins.click()
  await wait(2000)
  const body = document.body.innerText
  const hasModlens = /modlens/i.test(body)
  const hasVision = /视觉|vision/i.test(body)
  const lines = body.split('\n').filter(l => l.trim() !== '')
  return { ok: hasModlens || hasVision, hasModlens, hasVision, snippet: lines.slice(0, 40) }
})()
