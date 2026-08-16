// E2E probe (combined): open the settings panel, then the "更新" nav entry,
// and report the update section's rendered text.
(async function () {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const describe = b => ((b.getAttribute('aria-label') || '') + ' | ' + (b.textContent || '').trim()).slice(0, 60)
  const buttons = Array.from(document.querySelectorAll('button'))
  const settingsBtn = buttons.find(b => /设置|Settings|Preferences/i.test(describe(b)))
  if (!settingsBtn) return { step: 'settings', ok: false, buttons: buttons.map(describe).slice(0, 40) }
  settingsBtn.click()
  await wait(1500)

  const leaves = Array.from(document.querySelectorAll('button, [role="tab"], [role="menuitem"], div, span'))
    .filter(n => n.children.length === 0)
  const updates = leaves.find(n => /^(更新|Updates)$/.test((n.textContent || '').trim()))
  if (!updates) return { step: 'updates-nav', ok: false, texts: leaves.map(n => (n.textContent || '').trim()).filter(t => t !== '' && t.length <= 24).slice(0, 80) }
  updates.click()
  await wait(1500)

  const body = document.body.innerText
  const hasSection = /更新 Harness|Update Harness/.test(body)
  const hasCheckBtn = /检查更新|Check for updates/.test(body)
  const hasVersions = /Harness 运行时|Harness runtime/.test(body)
  return {
    step: 'updates-panel',
    ok: hasSection,
    hasSection,
    hasCheckBtn,
    hasVersions,
    snippet: body.split('\n').filter(l => l.trim() !== '').slice(0, 40),
  }
})()
