// E2E probe: click 新会话 to create a real session record, then report the
// settings nav and the sidebar session list.
(async function () {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const describe = b => ((b.getAttribute('aria-label') || '') + ' | ' + (b.textContent || '').trim()).slice(0, 60)

  const newSession = Array.from(document.querySelectorAll('button')).find(b => /新会话|New session/i.test(describe(b)))
  const clicked = newSession !== undefined
  if (newSession !== undefined) newSession.click()
  await wait(1200)

  const settingsBtn = Array.from(document.querySelectorAll('button')).find(b => /设置|Settings|Preferences/i.test(describe(b)))
  const navs = []
  if (settingsBtn !== undefined) {
    settingsBtn.click()
    await wait(1200)
    const leaves = Array.from(document.querySelectorAll('button, [role="tab"], [role="menuitem"], div, span'))
      .filter(n => n.children.length === 0)
    for (const n of leaves) {
      const text = (n.textContent || '').trim()
      if (text !== '' && text.length <= 12) navs.push(text)
    }
  }
  return { clicked, navs }
})()
