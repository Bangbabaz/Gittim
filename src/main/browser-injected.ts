// 浏览器注入脚本集合。
//
// 这些脚本通过 Runtime.evaluate 注入到 webview 的页面上下文中执行，
// 因此只能使用浏览器 API，不能引用 Node.js API。
//
// 核心算法提取自 Playwright（Apache 2.0 License）:
//   - injected/injectedScript.ts → fill 逻辑、事件序列
//   - injected/selectorGenerator.ts → 从 element 生成唯一选择器
//   - frames.ts → actionability checks
//   - accessibility.ts → AX tree 序列化

// ---------------------------------------------------------------------------
// 4.1 fill — 兼容 React/Vue 受控组件的文本填入
// ---------------------------------------------------------------------------

export const FILL_SCRIPT = `
(selector, value) => {
  const el = document.querySelector(selector);
  if (!el) return { success: false, error: 'element_not_found', selector: selector };

  // 聚焦
  el.focus();

  // 选中全部并删除（清空现有内容）
  if (typeof el.select === 'function') {
    el.select();
  } else {
    try { document.execCommand('selectAll', false, null); } catch (_) {}
  }
  try { document.execCommand('delete', false, null); } catch (_) {}

  // 通过原型链上的 native setter 设值（绕过 React/Vue 的 getter/setter 劫持）
  const proto = Object.getPrototypeOf(el);
  const nativeSetter =
    (Object.getOwnPropertyDescriptor(proto, 'value') || {}).set ||
    (Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value') || {}).set ||
    (Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value') || {}).set;

  if (nativeSetter) {
    nativeSetter.call(el, value);
  } else {
    el.value = value;
  }

  // 触发事件序列（React 监听 input，Vue 监听 input，原生表单监听 change）
  el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
  el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));

  // 对 React 16+ 额外处理：React 通过 _valueTracker 追踪值
  const tracker = el._valueTracker;
  if (tracker) {
    tracker.setValue('');
  }

  // 验证
  const actualValue = el.value;
  return {
    success: actualValue === value,
    value: actualValue,
    selector: selector
  };
}
`

// ---------------------------------------------------------------------------
// 4.2 actionability check — 点击前检查元素是否可操作
// ---------------------------------------------------------------------------

export const ACTIONABILITY_SCRIPT = `
(selector) => {
  const el = document.querySelector(selector);
  if (!el) return { actionable: false, reason: 'element_not_found', selector: selector };

  const rect = el.getBoundingClientRect();

  // 1. 可见性检查
  if (rect.width === 0 && rect.height === 0) {
    return { actionable: false, reason: 'element_has_zero_size', selector: selector };
  }

  const style = getComputedStyle(el);
  if (style.visibility === 'hidden') {
    return { actionable: false, reason: 'element_is_hidden (visibility)', selector: selector };
  }
  if (style.display === 'none') {
    return { actionable: false, reason: 'element_is_hidden (display)', selector: selector };
  }
  if (parseFloat(style.opacity) === 0) {
    return { actionable: false, reason: 'element_is_hidden (opacity)', selector: selector };
  }

  // 2. 是否被遮挡
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const topEl = document.elementFromPoint(cx, cy);
  if (topEl && topEl !== el && !el.contains(topEl)) {
    const tag = topEl.tagName;
    const cls = topEl.className && typeof topEl.className === 'string'
      ? '.' + topEl.className.trim().split(/\\s+/)[0]
      : '';
    return {
      actionable: false,
      reason: 'element_is_covered_by: ' + tag + cls,
      selector: selector,
      coveredBy: { tag: tag, className: cls }
    };
  }

  // 3. disabled 状态
  if (el.disabled) {
    return { actionable: false, reason: 'element_is_disabled', selector: selector };
  }

  // 4. 视口内检查
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw) {
    return {
      actionable: false,
      reason: 'element_is_outside_viewport',
      selector: selector,
      viewport: { width: vw, height: vh },
      elementRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    };
  }

  return {
    actionable: true,
    center: { x: cx, y: cy },
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  };
}
`

// ---------------------------------------------------------------------------
// 4.3 selector 生成 — 从 element 生成唯一 CSS 选择器
//    （作为函数内联到 snapshot 脚本中，也独立导出供 element_info 使用）
// ---------------------------------------------------------------------------

export const GENERATE_SELECTOR_FN = `
function generateSelector(element) {
  // 优先用 id
  if (element.id) {
    return '#' + CSS.escape(element.id);
  }

  // data-testid / data-test-id
  var testId = element.getAttribute('data-testid') || element.getAttribute('data-test-id');
  if (testId) {
    return '[data-testid="' + testId.replace(/"/g, '\\"') + '"]';
  }

  // role + accessible name
  var role = element.getAttribute('role');
  var ariaLabel = element.getAttribute('aria-label');
  if (role && ariaLabel) {
    return '[role="' + role + '"][aria-label="' + ariaLabel.replace(/"/g, '\\"') + '"]';
  }

  // 构造 nth-of-type 路径（fallback）
  var parts = [];
  var cur = element;
  while (cur && cur !== document.body && cur !== document.documentElement) {
    var seg = cur.tagName.toLowerCase();
    var parent = cur.parentElement;
    if (parent) {
      var siblings = Array.from(parent.children).filter(function(c) {
        return c.tagName === cur.tagName;
      });
      if (siblings.length > 1) {
        seg += ':nth-of-type(' + (siblings.indexOf(cur) + 1) + ')';
      }
    }
    parts.unshift(seg);
    cur = parent;
  }
  return parts.join(' > ');
}
`

// ---------------------------------------------------------------------------
// 4.4 accessibility tree — 获取页面可交互元素列表
// ---------------------------------------------------------------------------

export const SNAPSHOT_SCRIPT = `
(function() {
  var INTERACTIVE_ROLES = {
    button: true, link: true, textbox: true, checkbox: true, radio: true,
    combobox: true, listbox: true, option: true, menuitem: true, tab: true,
    switch: true, slider: true, searchbox: true, spinbutton: true,
    menuitemcheckbox: true, menuitemradio: true
  };
  var SKIP_TAGS = { SCRIPT: true, STYLE: true, NOSCRIPT: true, META: true, LINK: true, HEAD: true };
  var MAX_NODES = 100;

  var results = [];

  function walk(node, depth) {
    if (results.length >= MAX_NODES) return;
    if (node.nodeType !== 1) return;
    if (SKIP_TAGS[node.tagName]) return;

    var el = node;
    var style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return;

    var tag = el.tagName.toLowerCase();
    var role = el.getAttribute('role') || mapImplicitRole(el);
    var isInteractive = !!INTERACTIVE_ROLES[role] ||
      tag === 'input' || tag === 'textarea' || tag === 'select' ||
      tag === 'button' || tag === 'a' ||
      el.getAttribute('tabindex') !== null ||
      el.getAttribute('contenteditable') === 'true';

    var name = el.getAttribute('aria-label') ||
      el.getAttribute('title') ||
      el.getAttribute('placeholder') ||
      (tag === 'img' ? (el.getAttribute('alt') || '') : null) ||
      (isInteractive ? (el.textContent || '').trim().slice(0, 80) : null) ||
      '';

    if (isInteractive || (name && name.length > 0)) {
      var ref = results.length + 1;
      var entry = {
        ref: ref,
        role: role,
        name: name || '',
        tag: tag,
        selector: generateSelector(el)
      };
      // 可选字段仅在有值时添加，减少输出大小
      if (el.value !== undefined && el.value !== null) entry.value = String(el.value).slice(0, 100);
      if (el.checked !== undefined && el.checked !== null) entry.checked = el.checked;
      if (el.disabled) entry.disabled = true;
      if (document.activeElement === el) entry.focused = true;
      results.push(entry);
    }

    for (var i = 0; i < el.children.length; i++) {
      walk(el.children[i], depth + 1);
    }
  }

  function mapImplicitRole(el) {
    var tag = el.tagName;
    if (tag === 'INPUT') {
      var type = (el.type || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      if (type === 'search') return 'searchbox';
      return 'textbox';
    }
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'SELECT') return 'combobox';
    if (tag === 'BUTTON') return 'button';
    if (tag === 'A' && el.href) return 'link';
    return tag.toLowerCase();
  }

  ${GENERATE_SELECTOR_FN}

  walk(document.body, 0);
  return results;
})()
`

// ---------------------------------------------------------------------------
// element_info 查询脚本
// ---------------------------------------------------------------------------

export const ELEMENT_INFO_SCRIPT = `
(selector, props) => {
  var el = document.querySelector(selector);
  if (!el) return { error: 'element_not_found', selector: selector };

  var info = {
    selector: selector,
    tag: el.tagName.toLowerCase()
  };

  if (props.indexOf('text') !== -1 || props.length === 0) {
    info.text = (el.textContent || '').trim().slice(0, 200);
  }
  if (props.indexOf('value') !== -1 || props.length === 0) {
    if (el.value !== undefined) info.value = String(el.value);
  }
  if (props.indexOf('visible') !== -1 || props.length === 0) {
    var style = getComputedStyle(el);
    info.visible = style.display !== 'none' && style.visibility !== 'hidden';
  }
  if (props.indexOf('enabled') !== -1 || props.length === 0) {
    info.enabled = !el.disabled;
    info.disabled = !!el.disabled;
  }
  if (props.indexOf('checked') !== -1 || props.length === 0) {
    if (el.checked !== undefined) info.checked = el.checked;
  }
  if (props.indexOf('href') !== -1 || props.length === 0) {
    if (el.href) info.href = el.href;
  }
  if (props.indexOf('placeholder') !== -1 || props.length === 0) {
    if (el.placeholder) info.placeholder = el.placeholder;
  }
  var rect = el.getBoundingClientRect();
  info.boundingBox = {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height)
  };

  return info;
}
`

// ---------------------------------------------------------------------------
// 等待条件脚本生成
// ---------------------------------------------------------------------------

export function waitScript(selector: string, state: string): string {
  const checks: Record<string, string> = {
    visible: `el && el.offsetParent !== null && getComputedStyle(el).visibility !== 'hidden'`,
    hidden: `!el || el.offsetParent === null || getComputedStyle(el).visibility === 'hidden'`,
    attached: `document.querySelector('${selector.replace(/'/g, "\\'")}') !== null`,
    detached: `document.querySelector('${selector.replace(/'/g, "\\'")}') === null`
  }
  const check = checks[state] || checks.visible
  return `(function(){ var el = document.querySelector('${selector.replace(/'/g, "\\'")}'); return ${check}; })()`
}

// ---------------------------------------------------------------------------
// 滚动脚本
// ---------------------------------------------------------------------------

export const SCROLL_INTO_VIEW_SCRIPT = `
(selector) => {
  var el = document.querySelector(selector);
  if (!el) return { success: false, error: 'element_not_found' };
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  return { success: true, scrollX: window.scrollX, scrollY: window.scrollY };
}
`

export function scrollByScript(direction: string, amount: number): string {
  const deltas: Record<string, [number, number]> = {
    down: [0, amount],
    up: [0, -amount],
    right: [amount, 0],
    left: [-amount, 0]
  }
  const [dx, dy] = deltas[direction] || [0, amount]
  return `(function(){ window.scrollBy(${dx}, ${dy}); return { scrollX: window.scrollX, scrollY: window.scrollY }; })()`
}

// ---------------------------------------------------------------------------
// selectOption 脚本（原生 select）
// ---------------------------------------------------------------------------

export const SELECT_OPTION_SCRIPT = `
(selector, value, label) => {
  var el = document.querySelector(selector);
  if (!el || el.tagName !== 'SELECT') return { success: false, error: 'not_a_select_element' };

  var options = Array.from(el.options);
  var target = null;
  for (var i = 0; i < options.length; i++) {
    var o = options[i];
    if ((value && o.value === value) || (label && o.textContent.trim() === label)) {
      target = o;
      break;
    }
  }
  if (!target) return { success: false, error: 'option_not_found', value: value, label: label };

  el.value = target.value;
  el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
  return { success: true, value: target.value, text: target.textContent.trim() };
}
`

// ---------------------------------------------------------------------------
// checkbox/radio 勾选脚本
// ---------------------------------------------------------------------------

export const CHECK_SCRIPT = `
(selector, checked) => {
  var el = document.querySelector(selector);
  if (!el) return { success: false, error: 'element_not_found' };
  if (el.checked === undefined) return { success: false, error: 'element_not_checkable', tag: el.tagName };

  if (el.checked !== checked) {
    el.click();
  }

  return { success: true, checked: el.checked };
}
`
