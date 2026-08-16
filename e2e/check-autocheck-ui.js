// E2E probe: open settings → 更新 and verify the auto-check controls render
// (switch defaulted ON, time input 03:00, next-check line).
(async function () {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const describe = b => ((b.getAttribute('aria-label') || '') + ' | ' + (b.textContent || '').trim()).slice(0, 60)
  const leaves = () => Array.from(document.querySelectorAll('button, [role="tab"], [role="menuitem"], div, span'))
    .filter(n => n.children.length === 0)

  const settingsBtn = Array.from(document.querySelectorAll('button')).find(b => /设置|Settings|Preferences/i.test(describe(b)))
  settingsBtn.click()
  await wait(1500)
  leaves().find(n => /^(更新|Updates)$/.test((n.textContent || '').trim())).click()
  await wait(2000)
  const body = document.body.innerText
  const timeInputs = Array.from(document.querySelectorAll('input[type="time"]')).map(i => ({ value: i.value, disabled: i.disabled }))
  const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]')).map(i => ({ checked: i.checked }))
  return {
    ok: /自动检查更新|Auto-check for updates/.test(body) && timeInputs.some(t => t.value === '03:00') && checkboxes.some(c => c.checked),
    hasSwitch: /自动检查更新|Auto-check for updates/.test(body),
    hasHint: /每天在设定时间|Checks the official registry daily/.test(body),
    hasNext: /下次自动检查|Next auto check/.test(body),
    timeInputs,
    checkboxes,
    snippet: body.split('\n').filter(l => l.trim() !== '').slice(14, 40),
  }
})()
