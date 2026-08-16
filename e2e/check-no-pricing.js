// E2E probe: personal center renders without the pricing settings card.
(async function () {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const describe = b => ((b.getAttribute('aria-label') || '') + ' | ' + (b.textContent || '').trim()).slice(0, 60)
  const leaves = () => Array.from(document.querySelectorAll('button, [role="tab"], [role="menuitem"], div, span'))
    .filter(n => n.children.length === 0)
  const settingsBtn = Array.from(document.querySelectorAll('button')).find(b => /设置|Settings|Preferences/i.test(describe(b)))
  settingsBtn.click()
  await wait(1500)
  leaves().find(n => /个人中心|Personal/.test((n.textContent || '').trim())).click()
  await wait(2000)
  const body = document.body.innerText
  return {
    ok: !/计费设置|Pricing/.test(body) && /累计 Token|Total tokens/.test(body) && /Token 活动|Token activity/.test(body),
    noPricing: !/计费设置|Pricing/.test(body),
    hasStats: /累计 Token|Total tokens/.test(body),
    hasHeatmap: /Token 活动|Token activity/.test(body),
    hasModel: /模型明细|By model/.test(body),
  }
})()
