(function () {
  if (window.__APPSTORE_EXPAND_MOUNTED__) return;
  window.__APPSTORE_EXPAND_MOUNTED__ = true;
  if (window.location.pathname === '/login') return;

  var cfg = window.__APPSTORE_EXPAND__ || {};
  var title = cfg.title || 'AppStore Expand';
  var statusText = cfg.statusText || '应用商店扩展开启';
  var panelUrl = window.location.origin + '/appstore-expand/panel';
  var healthUrl = window.location.origin + '/appstore-expand/health';

  function qs(sel) { return document.querySelector(sel); }
  function qsa(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

  function isVisible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    var s = window.getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
  }

  function ensureStyle() {
    if (qs('#dj-appstore-expand-style')) return;
    var style = document.createElement('style');
    style.id = 'dj-appstore-expand-style';
    style.textContent = '' +
      '#dj-appstore-expand-btn{height:32px;padding:0 12px;border:1px solid #2b303b;background:#111318;color:#e5e7eb;border-radius:8px;display:inline-flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;line-height:1;white-space:nowrap;transition:all .15s ease;}' +
      '#dj-appstore-expand-btn:hover{background:#171a21;border-color:#3b4252;}' +
      '#dj-appstore-expand-btn .dj-appstore-expand-dot{width:8px;height:8px;border-radius:999px;display:inline-block;background:#ef4444;}' +
      '#dj-appstore-expand-panel{position:fixed;top:56px;right:12px;width:min(520px,90vw);height:70vh;border:1px solid #2b303b;background:#0f1115;z-index:9999;border-radius:10px;overflow:hidden;}';
    document.head.appendChild(style);
  }

  function locateActionGroup() {
    // 优先命中 Dujiao-Next 顶栏结构：header + 右侧操作组
    var header = qs('header.flex.items-center.justify-between');

    if (!header) {
      // 回退：按几何特征找顶部横向 header
      var headers = qsa('header,div');
      for (var i = 0; i < headers.length; i++) {
        var h = headers[i];
        if (!isVisible(h)) continue;
        var hs = window.getComputedStyle(h);
        if (hs.display !== 'flex') continue;
        if (hs.justifyContent !== 'space-between') continue;
        var hr = h.getBoundingClientRect();
        if (hr.top < -2 || hr.top > 20) continue;
        if (hr.height < 44 || hr.height > 90) continue;
        if (hr.width < window.innerWidth * 0.45) continue;
        header = h;
        break;
      }
    }

    if (!header) return null;

    var group = header.querySelector(':scope > .flex.items-center.gap-2');
    if (group && isVisible(group)) return group;

    var children = Array.prototype.slice.call(header.children || []);
    for (var j = children.length - 1; j >= 0; j--) {
      var child = children[j];
      if (!isVisible(child)) continue;
      var s = window.getComputedStyle(child);
      if (s.display !== 'flex') continue;
      var r = child.getBoundingClientRect();
      if (r.height < 28 || r.height > 52) continue;
      if (r.left < window.innerWidth * 0.45) continue;
      if (child.querySelector('button,[role="button"],a')) return child;
    }

    return null;
  }

  function createBtn() {
    var btn = document.createElement('button');
    btn.id = 'dj-appstore-expand-btn';
    btn.type = 'button';

    var dot = document.createElement('span');
    dot.className = 'dj-appstore-expand-dot';
    dot.id = 'dj-appstore-expand-dot';

    var text = document.createElement('span');
    text.textContent = title;

    btn.appendChild(dot);
    btn.appendChild(text);

    btn.onclick = function () {
      var existing = qs('#dj-appstore-expand-panel');
      if (existing) {
        existing.remove();
        return;
      }
      var panel = document.createElement('div');
      panel.id = 'dj-appstore-expand-panel';
      var ifr = document.createElement('iframe');
      ifr.src = panelUrl;
      ifr.style.cssText = 'width:100%;height:100%;border:0;background:#0f1115;';
      panel.appendChild(ifr);
      document.body.appendChild(panel);
    };

    return btn;
  }

  function updateStatus() {
    fetch(healthUrl, { cache: 'no-store' }).then(function (r) {
      var dot = qs('#dj-appstore-expand-dot');
      if (!dot) return;
      dot.style.background = r.ok ? '#22c55e' : '#ef4444';
      dot.title = r.ok ? statusText : '应用商店扩展异常';
    }).catch(function () {});
  }

  function mountInTopNav() {
    ensureStyle();
    var btn = qs('#dj-appstore-expand-btn') || createBtn();
    var group = locateActionGroup();
    if (!group) {
      if (btn.parentElement) btn.remove();
      return false;
    }

    // 必须嵌入导航栏：清空所有浮动样式
    btn.style.position = '';
    btn.style.top = '';
    btn.style.left = '';
    btn.style.right = '';
    btn.style.zIndex = '';
    btn.style.display = 'inline-flex';

    try {
      group.style.gap = group.style.gap || '8px';
      group.insertBefore(btn, group.firstElementChild || null);
    } catch (_e) {
      if (btn.parentElement) btn.remove();
      return false;
    }

    updateStatus();
    return true;
  }

  function boot() {
    var tick = 0;
    var timer = setInterval(function () {
      tick += 1;
      var ok = mountInTopNav();
      if (ok && tick > 4) clearInterval(timer);
      if (tick > 40) clearInterval(timer);
    }, 300);

    window.addEventListener('resize', mountInTopNav);
    window.addEventListener('popstate', mountInTopNav);
    window.addEventListener('hashchange', mountInTopNav);

    var moTimer = null;
    new MutationObserver(function () {
      if (moTimer) return;
      moTimer = setTimeout(function () {
        moTimer = null;
        mountInTopNav();
      }, 120);
    }).observe(document.documentElement, { childList: true, subtree: true });

    // 常驻轻量守护：防止仪表台异步重渲染后按钮被覆盖移除
    setInterval(function () {
      var btn = qs('#dj-appstore-expand-btn');
      if (!btn || !document.contains(btn) || !isVisible(btn)) {
        mountInTopNav();
      }
    }, 2000);

    setInterval(updateStatus, 15000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
