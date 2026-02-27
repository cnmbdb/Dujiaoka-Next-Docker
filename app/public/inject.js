(function () {
  if (window.__APPSTORE_EXPAND_MOUNTED__) return;
  window.__APPSTORE_EXPAND_MOUNTED__ = true;

  var cfg = window.__APPSTORE_EXPAND__ || {};
  var title = cfg.title || 'AppStore Expand';
  var statusText = cfg.statusText || '应用商店扩展开启';
  var panelUrl = window.location.origin + '/appstore-expand/panel';
  var healthUrl = window.location.origin + '/appstore-expand/health';
  var healthState = {
    ok: null,
    busy: false,
    lastAt: 0
  };
  var HEALTH_INTERVAL_MS = 15000;

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
      '#dj-appstore-expand-btn{height:32px;padding:0 12px;border:1px solid hsl(var(--input, 215 20% 25%));background:transparent;color:hsl(var(--foreground, 220 15% 90%));border-radius:6px;display:inline-flex;align-items:center;gap:8px;cursor:pointer;font-size:12px;line-height:1;white-space:nowrap;transition:all .15s ease;box-shadow:0 1px 2px rgba(0,0,0,.2);}' +
      '#dj-appstore-expand-btn:hover{background:hsl(var(--accent, 220 16% 12%));color:hsl(var(--accent-foreground, 220 15% 90%));}' +
      '#dj-appstore-expand-btn:focus-visible{outline:none;box-shadow:0 0 0 1px hsl(var(--ring, 215 20% 45%));}' +
      '#dj-appstore-expand-btn .dj-appstore-expand-dot{width:8px;height:8px;border-radius:999px;display:inline-block;background:#ef4444;}' +
      '#dj-appstore-expand-host{display:flex;align-items:center;gap:8px;}' +
      '#dj-appstore-expand-panel{position:fixed;top:56px;right:12px;width:min(520px,90vw);height:70vh;border:1px solid #2b303b;background:#0f1115;z-index:9999;border-radius:10px;overflow:hidden;}';
    document.head.appendChild(style);
  }

  function locateHeader() {
    var header = qs('header.flex.items-center.justify-between');
    if (!header) {
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
    return header;
  }

  function pickLanguageNode() {
    var nodes = qsa('button,[role="button"],a,.n-button,.n-base-selection');
    var best = null;
    var bestScore = -1;
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!isVisible(el)) continue;
      var t = (el.textContent || '').trim();
      var cls = String(el.className || '');
      var r = el.getBoundingClientRect();
      if (r.top < -2 || r.top > 120) continue;
      if (r.left < window.innerWidth * 0.25) continue;
      if (r.width < 60 || r.width > 240) continue;
      if (r.height < 24 || r.height > 44) continue;

      var isLangText = t.indexOf('简体') !== -1 || t.indexOf('繁體') !== -1 || t === '中文' || t === 'English' || t.indexOf('Language') !== -1 || t.indexOf('语言') !== -1;
      var isLangClass = cls.indexOf('w-[140px]') !== -1 || cls.indexOf('justify-between') !== -1;
      if (!isLangText && !isLangClass) continue;

      // 越靠右越优先，且尽量短文本
      var score = Math.round(r.left) + (isLangText ? 300 : 0) - Math.min((t || '').length, 20) * 2;
      if (score > bestScore) {
        best = el;
        bestScore = score;
      }
    }
    return best;
  }

  function directChildWithin(group, node) {
    if (!group || !node) return null;
    var cur = node;
    while (cur && cur.parentElement && cur.parentElement !== group) cur = cur.parentElement;
    return cur && cur.parentElement === group ? cur : null;
  }

  function findActionGroupFromHeader(header) {
    if (!header) return null;

    for (var k = 0; k < header.children.length; k++) {
      var c = header.children[k];
      if (!isVisible(c)) continue;
      if (typeof c.className === 'string' && c.className.indexOf('items-center') !== -1 && c.className.indexOf('gap-2') !== -1) {
        return c;
      }
    }

    var lang = null;
    var nodes = qsa('button,[role="button"],a,.n-button,.n-base-selection');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!header.contains(el) || !isVisible(el)) continue;
      var t = (el.textContent || '').trim();
      if (!t || t.length > 24) continue;
      if (t.indexOf('简体') !== -1 || t.indexOf('繁體') !== -1 || t === '中文' || t === 'English' || t.indexOf('Language') !== -1 || t.indexOf('语言') !== -1) {
        lang = el;
        break;
      }
    }
    if (lang && lang.parentElement && isVisible(lang.parentElement)) return lang.parentElement;

    var children = Array.prototype.slice.call(header.children || []);
    for (var j = children.length - 1; j >= 0; j--) {
      var child = children[j];
      if (!isVisible(child)) continue;
      var s = window.getComputedStyle(child);
      if (s.display !== 'flex') continue;
      var r = child.getBoundingClientRect();
      if (r.height < 28 || r.height > 52) continue;
      if (r.left < window.innerWidth * 0.42) continue;
      if (child.querySelector('button,[role="button"],a')) return child;
    }

    return null;
  }

  function locateActionGroup() {
    var header = locateHeader();
    if (!header) return null;

    var group = findActionGroupFromHeader(header);
    if (group && isVisible(group)) return group;

    var host = qs('#dj-appstore-expand-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'dj-appstore-expand-host';
    }
    if (host.parentElement !== header) {
      var inserted = false;
      for (var x = 0; x < header.children.length; x++) {
        var node = header.children[x];
        if (!isVisible(node)) continue;
        var ns = window.getComputedStyle(node);
        if (ns.display !== 'flex') continue;
        var nr = node.getBoundingClientRect();
        if (nr.left >= window.innerWidth * 0.42) {
          header.insertBefore(host, node);
          inserted = true;
          break;
        }
      }
      if (!inserted) header.appendChild(host);
    }
    return host;
  }

  function createBtn() {
    var btn = document.createElement('button');
    btn.id = 'dj-appstore-expand-btn';
    btn.type = 'button';
    // 保持与后台语言切换按钮同视觉体系
    btn.className = 'flex items-center whitespace-nowrap rounded-md border border-input bg-transparent px-3 py-2 shadow-sm text-start h-8 text-xs';
    btn.setAttribute('aria-label', title);
    btn.setAttribute('title', title);

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
      updateStatus(true);
    };

    return btn;
  }

  function renderStatus() {
    var dot = qs('#dj-appstore-expand-dot');
    var btn = qs('#dj-appstore-expand-btn');
    if (!dot || !btn) return;
    if (healthState.ok === null) {
      dot.style.background = '#f59e0b';
      dot.title = '应用商店扩展状态检测中';
      btn.setAttribute('title', title + ' · 状态检测中');
      return;
    }
    if (healthState.ok) {
      dot.style.background = '#22c55e';
      dot.title = statusText;
      btn.setAttribute('title', title + ' · ' + statusText);
      return;
    }
    dot.style.background = '#ef4444';
    dot.title = '应用商店扩展异常';
    btn.setAttribute('title', title + ' · 应用商店扩展异常');
  }

  function updateStatus(force) {
    var now = Date.now();
    if (!force) {
      if (healthState.busy) return;
      if (healthState.lastAt > 0 && now - healthState.lastAt < HEALTH_INTERVAL_MS) return;
    }
    healthState.busy = true;
    fetch(healthUrl, { cache: 'no-store' }).then(function (r) {
      healthState.ok = !!r.ok;
      healthState.lastAt = Date.now();
      renderStatus();
    }).catch(function () {
      healthState.ok = false;
      healthState.lastAt = Date.now();
      renderStatus();
    }).finally(function () {
      healthState.busy = false;
    });
  }

  function bindPanelCloseBehavior() {
    if (window.__APPSTORE_EXPAND_CLOSE_BOUND__) return;
    window.__APPSTORE_EXPAND_CLOSE_BOUND__ = true;
    window.addEventListener('keydown', function (evt) {
      if (evt.key !== 'Escape') return;
      var panel = qs('#dj-appstore-expand-panel');
      if (panel) panel.remove();
    });
  }

  function mountInTopNav() {
    try {
      if (window.location.pathname === '/login') {
        var oldBtn = qs('#dj-appstore-expand-btn');
        if (oldBtn) oldBtn.remove();
        var oldPanel = qs('#dj-appstore-expand-panel');
        if (oldPanel) oldPanel.remove();
        return false;
      }

      ensureStyle();
      var btn = qs('#dj-appstore-expand-btn') || createBtn();
      var langNode = pickLanguageNode();
      var group = null;

      // 最高优先级：语言切换按钮左侧
      if (langNode && langNode.parentElement && isVisible(langNode.parentElement)) {
        group = langNode.parentElement;
      }

      if (!group) group = locateActionGroup();
      if (!group) return false;

      // 必须嵌入导航栏：清空所有浮动样式
      btn.style.position = '';
      btn.style.top = '';
      btn.style.left = '';
      btn.style.right = '';
      btn.style.zIndex = '';
      btn.style.display = 'inline-flex';

      group.style.gap = group.style.gap || '8px';
      var target = langNode ? directChildWithin(group, langNode) : null;
      if (target) group.insertBefore(btn, target);
      else group.insertBefore(btn, group.firstElementChild || null);
    } catch (_ignored) {
      return false;
    }

    renderStatus();
    updateStatus(false);
    return true;
  }

  function patchHistoryNavigation() {
    if (window.__APPSTORE_EXPAND_HISTORY_PATCHED__) return;
    window.__APPSTORE_EXPAND_HISTORY_PATCHED__ = true;
    var fire = function () {
      setTimeout(mountInTopNav, 0);
      setTimeout(mountInTopNav, 220);
      setTimeout(mountInTopNav, 900);
    };
    var rawPush = history.pushState;
    var rawReplace = history.replaceState;
    history.pushState = function () {
      var ret = rawPush.apply(this, arguments);
      fire();
      return ret;
    };
    history.replaceState = function () {
      var ret = rawReplace.apply(this, arguments);
      fire();
      return ret;
    };
    window.addEventListener('popstate', fire);
    window.addEventListener('hashchange', fire);
  }

  function boot() {
    patchHistoryNavigation();
    bindPanelCloseBehavior();
    renderStatus();

    var tick = 0;
    var timer = setInterval(function () {
      tick += 1;
      var ok = mountInTopNav();
      if (ok && tick > 4) clearInterval(timer);
      if (tick > 40) clearInterval(timer);
    }, 300);

    window.addEventListener('resize', mountInTopNav);

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
    }, 1000);

    setInterval(function () {
      updateStatus(false);
    }, HEALTH_INTERVAL_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
