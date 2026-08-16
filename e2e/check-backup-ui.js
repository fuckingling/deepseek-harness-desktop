// E2E probe: open settings → 备份与还原 section and report its rendered
// content (buttons, backup list, sizes).
(async function () {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const describe = b => ((b.getAttribute('aria-label') || '') + ' | ' + (b.textContent || '').trim()).slice(0, 60)
  const leaves = () => Array.from(document.querySelectorAll('button, [role="tab"], [role="menuitem"], div, span'))
    .filter(n => n.children.length === 0)

  const settingsBtn = Array.from(document.querySelectorAll('button')).find(b => /设置|Settings|Preferences/i.test(describe(b)))
  settingsBtn.click()
  await wait(1500)
  const backupNav = leaves().find(n => /备份与还原|Backup & Restore/.test((n.textContent || '').trim()))
  if (!backupNav) return { ok: false, step: 'nav' }
  backupNav.click()
  await wait(2000)
  const body = document.body.innerText
  const lines = body.split('\n').filter(l => l.trim() !== '')
  return {
    ok: /聊天记录备份与还原|Chat history backup/.test(body) && /创建备份|Create backup/.test(body),
    hasTitle: /聊天记录备份与还原|Chat history backup/.test(body),
    hasCreate: /创建备份|Create backup/.test(body),
    hasUpload: /从备份文件还原|Restore from a backup/.test(body),
    hasList: /chat-backup-/.test(body),
    snippet: lines.slice(0, 34),
  }
})()
