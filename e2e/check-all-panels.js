// E2E probe: settings → "更新" panel checks, then settings → "个人中心"
// panel checks, and report the full settings nav for drift inspection.
(async function () {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const describe = b => ((b.getAttribute('aria-label') || '') + ' | ' + (b.textContent || '').trim()).slice(0, 60)
  const leaves = () => Array.from(document.querySelectorAll('button, [role="tab"], [role="menuitem"], div, span'))
    .filter(n => n.children.length === 0)

  // Click a settings nav section by its label; prefers the row button over
  // the bare label span and skips detached nodes (the modal re-renders while
  // sections switch, so a stale match must not be clicked).
  const clickNav = label => {
    const match = leaves().find(n => n.isConnected === true && (n.textContent || '').trim() === label)
    if (match === undefined) return false
    const row = match.closest("button, li, [role='tab'], [role='menuitem']") || match
    row.click()
    return true
  }

  const settingsBtn = Array.from(document.querySelectorAll('button')).find(b => /设置|Settings|Preferences/i.test(describe(b)))
  if (!settingsBtn) return { step: 'settings', ok: false, buttons: Array.from(document.querySelectorAll('button')).map(describe).slice(0, 40) }
  settingsBtn.click()
  await wait(1500)

  if (!clickNav('更新') && !clickNav('Updates')) return { step: 'updates-nav', ok: false }
  await wait(1500)
  const body1 = document.body.innerText
  const updatesOk = /更新 Harness|Update Harness/.test(body1) && /检查更新|Check for updates/.test(body1)

  if (!clickNav('个人中心') && !clickNav('Personal')) return { step: 'personal-nav', ok: false, updatesOk }
  await wait(1800)
  const body2 = document.body.innerText
  const personalOk = /个人中心|Personal center/.test(body2) && /累计 Token|Total tokens/.test(body2)

  return {
    step: 'done',
    ok: updatesOk && personalOk,
    updatesOk,
    personalOk,
    pluginSnippet: body2.split('\n').filter(l => l.trim() !== '').slice(0, 30),
  }
})()
