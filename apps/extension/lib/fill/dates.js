// @ts-check
// lib/fill/dates.js — date selects and pickers, and multi-entry sections (education,
// experience) that need "+ Add" clicks.
//
// Part of the autofill content script: manifest content_scripts loads
// lib/fill/* in order, then content.js. Helpers are shared through
// window.LandedFill.
(function (global) {
const F = global.LandedFill || (global.LandedFill = {});
const { MULTI_ENTRY_SECTIONS, fillInputBatch, getVisibleInputs } = F;
const { normalize, getFieldLabel } = global.ResumeFillerFieldDetect;

// ─── 年 / 月 select 检测 ─────────────────────────────────────────────────────

function isYearSelect(el) {
  if (el.tagName.toLowerCase() !== 'select') return false;
  const opts = Array.from(el.options).filter(o => o.value !== '' && o.value !== '0');
  if (opts.length < 4) return false;
  // 先剥掉非数字（兼容 "2020年"、"2020" 等格式）
  const yearCount = opts.filter(o => {
    const digits = (o.value || o.text || '').replace(/[^\d]/g, '');
    return /^(19|20)\d{2}$/.test(digits);
  }).length;
  return yearCount >= opts.length * 0.5;
}

function isMonthSelect(el) {
  if (el.tagName.toLowerCase() !== 'select') return false;
  const opts = Array.from(el.options).filter(o => o.value !== '' && o.value !== '0');
  // 月份通常恰好 12 个选项（或 13 个含占位）
  if (opts.length < 4 || opts.length > 13) return false;
  const monthCount = opts.filter(o => {
    const digits = (o.value || '').replace(/[^\d]/g, '');
    const n = parseInt(digits !== '' ? digits : o.text);
    return !isNaN(n) && n >= 1 && n <= 12;
  }).length;
  return monthCount >= opts.length * 0.7;
}

// 从 "YYYY-MM" 取年
function yearFromDate(dateStr) {
  return (dateStr || '').split('-')[0] || '';
}

// 从 "YYYY-MM" 取月（整数字符串，无前导零）
function monthFromDate(dateStr) {
  const parts = (dateStr || '').split('-');
  if (parts.length < 2) return '';
  return String(parseInt(parts[1]));
}

// ─── 专用年份 select 填值（精确数字比对，不用 includes 避免"2021"命中"2020"）──

function fillYearSelect(el, yearStr) {
  const target = (yearStr || '').trim();
  if (!target) return false;
  for (const opt of el.options) {
    const digits = (opt.value || opt.text || '').replace(/[^\d]/g, '');
    if (digits === target || opt.value.trim() === target) {
      el.value = opt.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
  }
  return false;
}

// ─── 专用月份 select 填值（整数比对，避免"10"命中"1"的 includes 污染）───────

function fillMonthSelect(el, monthStr) {
  const target = parseInt(monthStr);
  if (isNaN(target) || target < 1 || target > 12) return false;
  // 先按 option.value 的纯数字匹配
  for (const opt of el.options) {
    const digits = opt.value.replace(/[^\d]/g, '');
    if (digits !== '' && parseInt(digits) === target) {
      el.value = opt.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
  }
  // 再按 option.text 的纯数字匹配（兼容 "三月" 等中文月名）
  for (const opt of el.options) {
    const digits = opt.text.replace(/[^\d]/g, '');
    if (digits !== '' && parseInt(digits) === target) {
      el.value = opt.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
  }
  return false;
}

// ─── 自定义"年"/"月" picker 触发元素检测 ────────────────────────────────────
// 匹配 placeholder="年"/"月" 的 input，以及 div/span 类自定义 select

function findCustomDateTriggers(container) {
  const yearTriggers = [];
  const monthTriggers = [];

  function visRect(el) { const r = el.getBoundingClientRect(); return r.width > 0 || r.height > 0; }

  // 1. input[placeholder="年/月"] — 最常见形式
  for (const el of container.querySelectorAll(
    'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit])'
  )) {
    if (!visRect(el)) continue;
    const ph = (el.getAttribute('placeholder') || '').trim();
    if (ph === '年' || /^yyyy$/i.test(ph)) yearTriggers.push(el);
    else if (ph === '月' || /^mm$/i.test(ph)) monthTriggers.push(el);
  }

  // 2. div/span 自定义 select（文本节点直接是"年"或"月"）
  for (const el of container.querySelectorAll(
    '[role="combobox"],[tabindex="0"],div[class*="select"],div[class*="year"],div[class*="month"],' +
    'span[class*="select"],span[class*="year"],span[class*="month"]'
  )) {
    if (!visRect(el) || el.tagName.toLowerCase() === 'select') continue;
    // 只看直接文本节点或第一个 span/em 子元素，不递归全文（避免容器误匹配）
    const directText = Array.from(el.childNodes)
      .filter(n => n.nodeType === Node.TEXT_NODE)
      .map(n => n.textContent.trim()).join('');
    const firstChildText = (el.querySelector('span,em,i,b')?.textContent || '').trim();
    const candidate = directText || firstChildText;
    if (candidate === '年') yearTriggers.push(el);
    else if (candidate === '月') monthTriggers.push(el);
  }

  return { yearTriggers, monthTriggers };
}

// ─── 点击自定义 picker 并选中目标值 ──────────────────────────────────────────

async function fillCustomComboOption(trigger, value) {
  if (!trigger || !value) return false;

  const OPT_SEL = [
    'li', '[role="option"]', '[role="listitem"]', '[role="menuitem"]',
    '[class*="year-item"]', '[class*="month-item"]', '[class*="date-item"]',
    '[class*="select-item"]', '[class*="picker-item"]', '[class*="cascader"]',
  ].join(',');

  const numVal = parseInt(value);

  // getBoundingClientRect 判断可见（offsetParent 对 position:fixed 元素不可靠）
  function isVis(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function matchOpt(list) {
    if (!isNaN(numVal)) {
      const m = list.find(el => {
        const d = (el.textContent || '').replace(/[^\d]/g, '');
        return d !== '' && parseInt(d) === numVal;
      });
      if (m) return m;
    }
    return list.find(el => (el.textContent || '').trim() === String(value).trim()) || null;
  }

  // 同时发 PointerEvent + MouseEvent（兼容只监听 pointer 的 Vue/React 组件）
  function doClick(el) {
    const init = { bubbles: true, cancelable: true };
    try { el.dispatchEvent(new PointerEvent('pointerover',  init)); } catch { /* PointerEvent unsupported */ }
    try { el.dispatchEvent(new PointerEvent('pointerenter', { ...init, bubbles: false })); } catch { /* PointerEvent unsupported */ }
    try { el.dispatchEvent(new PointerEvent('pointerdown',  init)); } catch { /* PointerEvent unsupported */ }
    el.dispatchEvent(new MouseEvent('mousedown', init));
    try { el.dispatchEvent(new PointerEvent('pointerup', init)); } catch { /* PointerEvent unsupported */ }
    el.dispatchEvent(new MouseEvent('mouseup',  init));
    el.dispatchEvent(new MouseEvent('click',    init));
  }

  // 点击前快照，用于找出真正因此次点击新出现的 option 元素
  const beforeSet = new Set(Array.from(document.querySelectorAll(OPT_SEL)).filter(isVis));

  // 关闭其他已打开的下拉
  doClick(document.body);
  await new Promise(r => setTimeout(r, 80));

  // 点击 trigger 本身 + 向上最多 3 层 wrapper（覆盖 input 在 div 内部的情况）
  doClick(trigger);
  if (trigger.tagName.toLowerCase() === 'input') trigger.focus();
  let p = trigger.parentElement;
  for (let i = 0; i < 3 && p && p !== document.body; i++) {
    if (['DIV', 'SPAN', 'A'].includes(p.tagName)) doClick(p);
    p = p.parentElement;
  }

  await new Promise(r => setTimeout(r, 520));

  // 新出现的 option 优先（最精确），兜底用全部可见 option
  const afterAll = Array.from(document.querySelectorAll(OPT_SEL)).filter(isVis);
  const newEls   = afterAll.filter(el => !beforeSet.has(el));

  const match = matchOpt(newEls) || matchOpt(afterAll);

  if (match) {
    doClick(match);
    await new Promise(r => setTimeout(r, 200));
    return true;
  }

  doClick(document.body);
  return false;
}

// ─── 在一个 DOM 容器内填日期 select + 自定义picker + 至今 checkbox ──────────
//    startDate / endDate: "YYYY-MM" 格式；isCurrent: boolean

async function fillDateAndCurrentInContainer(container, startDate, endDate, isCurrent) {
  // ── 原生 <select> 年月 ───────────────────────────────────────────────────
  const yearSelects  = Array.from(container.querySelectorAll('select')).filter(isYearSelect);
  const monthSelects = Array.from(container.querySelectorAll('select')).filter(isMonthSelect);

  const isStartCtx = (el) => /开始|起始|入学|入职|start|from|begin/.test(normalize(getFieldLabel(el)));
  const isEndCtx   = (el) => /结束|截止|毕业|离职|end|to$|until/.test(normalize(getFieldLabel(el)));

  if (yearSelects.length || monthSelects.length) {
    let startYears  = yearSelects.filter(isStartCtx);
    let endYears    = yearSelects.filter(isEndCtx);
    let startMonths = monthSelects.filter(isStartCtx);
    let endMonths   = monthSelects.filter(isEndCtx);

    if (!startYears.length && !endYears.length) { startYears = yearSelects.slice(0,1); endYears = yearSelects.slice(1,2); }
    if (!startMonths.length && !endMonths.length) { startMonths = monthSelects.slice(0,1); endMonths = monthSelects.slice(1,2); }

    if (startDate) {
      startYears.forEach(el  => fillYearSelect(el,  yearFromDate(startDate)));
      startMonths.forEach(el => fillMonthSelect(el, monthFromDate(startDate)));
    }
    if (!isCurrent && endDate) {
      endYears.forEach(el  => fillYearSelect(el,  yearFromDate(endDate)));
      endMonths.forEach(el => fillMonthSelect(el, monthFromDate(endDate)));
    }
  }

  // ── 自定义 "年"/"月" picker（input placeholder="年" 或 div 自定义 select）──
  const { yearTriggers, monthTriggers } = findCustomDateTriggers(container);

  if (yearTriggers.length || monthTriggers.length) {
    let startYearT  = yearTriggers.filter(isStartCtx);
    let endYearT    = yearTriggers.filter(isEndCtx);
    let startMonthT = monthTriggers.filter(isStartCtx);
    let endMonthT   = monthTriggers.filter(isEndCtx);

    if (!startYearT.length && !endYearT.length) { startYearT = yearTriggers.slice(0,1); endYearT = yearTriggers.slice(1,2); }
    if (!startMonthT.length && !endMonthT.length) { startMonthT = monthTriggers.slice(0,1); endMonthT = monthTriggers.slice(1,2); }

    if (startDate) {
      for (const tr of startYearT)  await fillCustomComboOption(tr, yearFromDate(startDate));
      for (const tr of startMonthT) await fillCustomComboOption(tr, monthFromDate(startDate));
    }
    if (!isCurrent && endDate) {
      for (const tr of endYearT)  await fillCustomComboOption(tr, yearFromDate(endDate));
      for (const tr of endMonthT) await fillCustomComboOption(tr, monthFromDate(endDate));
    }
  }

  // ── 至今 checkbox ─────────────────────────────────────────────────────────
  if (isCurrent) {
    for (const cb of container.querySelectorAll('input[type="checkbox"]')) {
      const lbl = (getFieldLabel(cb) || cb.parentElement?.textContent || '').trim();
      if (/至今|present|current|ongoing/i.test(lbl)) {
        if (!cb.checked) { cb.click(); cb.dispatchEvent(new Event('change', { bubbles: true })); }
        break;
      }
    }
  }
}

// ─── 找 section 的"添加"按钮 ─────────────────────────────────────────────────

function findAddButtonForSection(keywords) {
  const allEls = /** @type {HTMLElement[]} */ (
    Array.from(document.querySelectorAll('*'))
  ).filter(el => {
    if (!el.offsetParent) return false;
    const ownText = (el.childNodes[0]?.nodeValue || '').trim();
    if (!ownText) return false;
    return keywords.some(kw => normalize(ownText).includes(normalize(kw)));
  });
  for (const heading of allEls) {
    let container = heading.parentElement;
    for (let i = 0; i < 10 && container; i++) {
      const btn = findAddBtnInContainer(container);
      if (btn) return btn;
      container = container.parentElement;
    }
  }
  return null;
}

function findAddBtnInContainer(container) {
  return Array.from(container.querySelectorAll('button, [role="button"], a, span, div'))
    .find(el => {
      if (!el.offsetParent) return false;
      const text = (el.textContent || '').trim();
      if (text.length > 20) return false;
      return /^[+＋]$|添加|新增|增加|\+\s*(add|experience|education|project)/i.test(text);
    }) || null;
}

// ─── 等新 inputs 出现 ─────────────────────────────────────────────────────────

function waitForNewInputs(knownSet, timeout = 2500) {
  return new Promise(resolve => {
    const getNew = () => getVisibleInputs().filter(el => !knownSet.has(el));
    const immediate = getNew();
    if (immediate.length > 0) { resolve(immediate); return; }
    const timer = setTimeout(() => { observer.disconnect(); resolve(getNew()); }, timeout);
    const observer = new MutationObserver(() => {
      const found = getNew();
      if (found.length > 0) { clearTimeout(timer); observer.disconnect(); resolve(found); }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
}

// 找一组新 inputs 的最小公共祖先容器
function commonAncestor(els) {
  if (!els.length) return document.body;
  let ancestor = els[0].parentElement;
  while (ancestor) {
    if (els.every(el => ancestor.contains(el))) return ancestor;
    ancestor = ancestor.parentElement;
  }
  return document.body;
}

// ─── 所有 section 的日期 + 多条目点"+"填写（合并 Phase 4 + Phase 6）──────────

async function fillAllSectionDates(resume, filled) {
  const allYearSels = Array.from(document.querySelectorAll('select'))
    .filter(el => el.offsetParent && isYearSelect(el));

  for (const section of MULTI_ENTRY_SECTIONS) {
    const entries = resume[section.resumeKey];
    if (!Array.isArray(entries) || entries.length === 0) continue;

    const addBtn = findAddButtonForSection(section.sectionKeywords);

    // ── 第一条：找 section 容器，填日期 select ───────────────────────────────
    const flatFirst = section.flatEntry(entries[0]);
    if (flatFirst._start_date || flatFirst._end_date || flatFirst._current) {
      let container = null;

      if (addBtn) {
        // 从 addBtn 向上找含年份 select（原生或自定义）的最小容器
        let p = addBtn.parentElement;
        for (let i = 0; i < 14 && p && p !== document.body; i++) {
          const hasNativeSel = Array.from(p.querySelectorAll('select')).some(isYearSelect);
          if (hasNativeSel) { container = p; break; }
          // 同时检测自定义年份 picker（input placeholder="年" 等）
          const { yearTriggers: customYears } = findCustomDateTriggers(p);
          if (customYears.length > 0) { container = p; break; }
          p = p.parentElement;
        }
      }

      // 找不到精确容器时：只有全页年份控件不多（≤4），才用 document.body
      // 避免多 section 页面乱填
      const allCustomYears = findCustomDateTriggers(document.body).yearTriggers;
      const totalYearControls = allYearSels.length + allCustomYears.length;
      if (!container && totalYearControls <= 4) container = document.body;

      if (container) {
        await fillDateAndCurrentInContainer(
          container,
          flatFirst._start_date,
          flatFirst._end_date,
          flatFirst._current
        );
      }
    }

    // ── 后续条目：点"+"并填写 ───────────────────────────────────────────────
    if (!addBtn || entries.length <= 1) continue;

    for (let i = 1; i < entries.length; i++) {
      const knownBefore = new Set(getVisibleInputs());
      addBtn.click();
      const newInputs = await waitForNewInputs(knownBefore);
      if (newInputs.length === 0) break;

      const entryFlat = section.flatEntry(entries[i]);
      fillInputBatch(newInputs, entryFlat, filled, [], null);

      const container = commonAncestor(newInputs);
      await fillDateAndCurrentInContainer(
        container,
        entryFlat._start_date,
        entryFlat._end_date,
        entryFlat._current
      );
    }
  }
}

Object.assign(F, { isYearSelect, isMonthSelect, yearFromDate, monthFromDate, fillYearSelect, fillMonthSelect, findCustomDateTriggers, fillCustomComboOption, fillDateAndCurrentInContainer, findAddButtonForSection, findAddBtnInContainer, waitForNewInputs, commonAncestor, fillAllSectionDates });
})(typeof window !== 'undefined' ? window : globalThis);
