// E2E probe, stage 2: inside the open settings panel, click the "更新"
// (Updates) nav entry and report whether the update section rendered.
(function () {
  const leaves = Array.from(document.querySelectorAll('button, [role="tab"], [role="menuitem"], div, span'))
    .filter(n => n.children.length === 0)
  const texts = leaves.map(n => (n.textContent || '').trim()).filter(t => t !== '' && t.length <= 24)
  const hit = leaves.find(n => /^(更新|Updates)$/.test((n.textContent || '').trim()))
  if (!hit) return { step: 'open-updates', clicked: false, texts: texts.slice(0, 80) }
  hit.click()
  return { step: 'open-updates', clicked: true, texts: texts.slice(0, 40) }
})()
