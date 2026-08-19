// E2E probe: settings → 个人中心 renders the Codex-style stat bar, heatmap,
// and the model usage ranking (no cost figures anywhere).
(async function () {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const describe = b => ((b.getAttribute('aria-label') || '') + ' | ' + (b.textContent || '').trim()).slice(0, 60)
  const leaves = () => Array.from(document.querySelectorAll('button, [role="tab"], [role="menuitem"], div, span'))
    .filter(n => n.children.length === 0)

  const settingsBtn = Array.from(document.querySelectorAll('button')).find(b => /设置|Settings|Preferences/i.test(describe(b)))
  settingsBtn.click()
  await wait(1500)
  const nav = leaves().find(n => /个人中心|Personal center|Personal/i.test((n.textContent || '').trim()))
  if (!nav) return { ok: false, step: 'nav', texts: leaves().map(n => (n.textContent || '').trim()).filter(t => t !== '' && t.length <= 16).slice(0, 40) }
  nav.click()
  await wait(2500)
  const body = document.body.innerText
  return {
    ok: /累计 Token|Total tokens/.test(body) && /连续天数|Streak/.test(body) && !/累计费用|Total cost/.test(body) && /模型调用排行|Model ranking/.test(body),
    hasTokens: /累计 Token|Total tokens/.test(body),
    hasPeak: /峰值|Peak day/.test(body),
    hasLongest: /最长持续时间|Longest session/.test(body),
    hasStreak: /连续天数|Streak/.test(body),
    hasCost: /累计费用|Total cost/.test(body),
    hasHeatmap: /Token 活动|Token activity/.test(body),
    hasModel: /模型调用排行|Model ranking/.test(body),
    hasPricing: /计费设置|Pricing/.test(body),
    snippet: body.split('\n').filter(l => l.trim() !== '').slice(14, 44),
  }
})()
