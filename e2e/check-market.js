// E2E probe: settings → 插件市场 page opens and renders the market UI.
(async function () {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const describe = b => ((b.getAttribute('aria-label') || '') + ' | ' + (b.textContent || '').trim()).slice(0, 60)
  const leaves = () => Array.from(document.querySelectorAll('button, [role="tab"], [role="menuitem"], div, span'))
    .filter(n => n.children.length === 0)

  const settingsBtn = Array.from(document.querySelectorAll('button')).find(b => /设置|Settings|Preferences/i.test(describe(b)))
  if (!settingsBtn) return { ok: false, step: 'settings' }
  settingsBtn.click()
  await wait(1500)
  const market = leaves().find(n => /插件市场|Plugin Market|Market/i.test((n.textContent || '').trim()))
  if (!market) return { ok: false, step: 'market-nav', texts: leaves().map(n => (n.textContent || '').trim()).filter(t => t !== '' && t.length <= 24).slice(0, 60) }
  market.click()
  await wait(4000)
  const body = document.body.innerText
  const hasMarket = /插件市场|Plugin Market|逛一逛|Browse/i.test(body)
  const hasPnpm = /pnpm/i.test(body)
  return {
    ok: hasMarket,
    hasMarket,
    hasPnpm,
    snippet: body.split('\n').filter(l => l.trim() !== '').slice(0, 30),
  }
})()
