// E2E probe: open settings → 更新 → click 检查更新 → report the panel text
// (verifies the official npm channel renders in the real app).
(async function () {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const describe = b => ((b.getAttribute('aria-label') || '') + ' | ' + (b.textContent || '').trim()).slice(0, 60)
  const leaves = () => Array.from(document.querySelectorAll('button, [role="tab"], [role="menuitem"], div, span'))
    .filter(n => n.children.length === 0)

  const settingsBtn = Array.from(document.querySelectorAll('button')).find(b => /设置|Settings|Preferences/i.test(describe(b)))
  if (!settingsBtn) return { ok: false, step: 'settings' }
  settingsBtn.click()
  await wait(1500)
  const updates = leaves().find(n => /^(更新|Updates)$/.test((n.textContent || '').trim()))
  if (!updates) return { ok: false, step: 'updates-nav' }
  updates.click()
  await wait(1500)
  const checkBtn = Array.from(document.querySelectorAll('button')).find(b => /检查更新|Check for updates/.test((b.textContent || '').trim()))
  if (!checkBtn) return { ok: false, step: 'check-button' }
  checkBtn.click()
  await wait(6000)
  const body = document.body.innerText
  const lines = body.split('\n').filter(l => l.trim() !== '')
  return {
    ok: /官方最新|Official latest/.test(body),
    hasOfficialRow: /官方最新|Official latest/.test(body),
    hasLatest: /0\.1\.0-rc\.6/.test(body),
    upToDate: /已是最新版本|up to date/i.test(body),
    snippet: lines.slice(0, 26),
  }
})()
