// E2E probe: settings → "更新" panel checks, then settings → "插件" page
// checks for the bundled ModLens vision plugin card.
(async function () {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const describe = b => ((b.getAttribute('aria-label') || '') + ' | ' + (b.textContent || '').trim()).slice(0, 60)
  const leaves = () => Array.from(document.querySelectorAll('button, [role="tab"], [role="menuitem"], div, span'))
    .filter(n => n.children.length === 0)

  const buttons = Array.from(document.querySelectorAll('button'))
  const settingsBtn = buttons.find(b => /设置|Settings|Preferences/i.test(describe(b)))
  if (!settingsBtn) return { step: 'settings', ok: false, buttons: buttons.map(describe).slice(0, 40) }
  settingsBtn.click()
  await wait(1500)

  const updates = leaves().find(n => /^(更新|Updates)$/.test((n.textContent || '').trim()))
  if (!updates) return { step: 'updates-nav', ok: false, texts: leaves().map(n => (n.textContent || '').trim()).filter(t => t !== '' && t.length <= 24).slice(0, 80) }
  updates.click()
  await wait(1500)
  const body1 = document.body.innerText
  const updatesOk = /更新 Harness|Update Harness/.test(body1) && /检查更新|Check for updates/.test(body1)

  const pluginsNav = leaves().find(n => /^(插件|Plugins)$/.test((n.textContent || '').trim()))
  if (!pluginsNav) return { step: 'plugins-nav', ok: false, updatesOk, texts: leaves().map(n => (n.textContent || '').trim()).filter(t => t !== '' && t.length <= 24).slice(0, 80) }
  pluginsNav.click()
  await wait(2000)
  const body2 = document.body.innerText
  const visionOk = /ModLens|modlens|视觉引擎|视觉/.test(body2)

  return {
    step: 'done',
    ok: updatesOk && visionOk,
    updatesOk,
    visionOk,
    pluginSnippet: body2.split('\n').filter(l => l.trim() !== '').slice(0, 30),
  }
})()
