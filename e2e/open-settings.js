// E2E probe executed inside the rendered page by the shell's
// DSH_LAUNCHER_E2E_SCRIPT hook. Stage 1: report the page and click the
// settings trigger if present.
(function () {
  const buttons = Array.from(document.querySelectorAll('button'))
  const describe = b => ((b.getAttribute('aria-label') || '') + ' | ' + (b.textContent || '').trim()).slice(0, 60)
  const hit = buttons.find(b => /设置|Settings|Preferences/i.test(describe(b)))
  if (!hit) return { step: 'find-settings', clicked: false, buttons: buttons.map(describe).slice(0, 40) }
  hit.click()
  return { step: 'find-settings', clicked: true, label: describe(hit) }
})()
