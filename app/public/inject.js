(function () {
  if (window.__APPSTORE_EXPAND_MOUNTED__) return;
  window.__APPSTORE_EXPAND_MOUNTED__ = true;

  var cfg = window.__APPSTORE_EXPAND__ || {};
  var title = cfg.title || 'AppStore Expand';
  var buttonText = cfg.buttonText || '扩展应用商店';
  var statusText = cfg.statusText || '应用商店扩展开启';
  var panelUrl = window.location.origin + '/appstore-expand/panel';
  var healthUrl = window.location.origin + '/appstore-expand/health';
  var healthState = {
    ok: null,
    busy: false,
    lastAt: 0
  };
  var HEALTH_INTERVAL_MS = 15000;
  var pulseTimer = null;
  var pulseStartTs = Date.now();
  var panelToggleBusy = false;
  var lastPanelOpenAt = 0;

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
      '#dj-appstore-expand-btn{height:34px;padding:0 13px;border:1.5px solid rgba(34,197,94,.14);background:linear-gradient(135deg,rgba(15,23,42,.75),rgba(15,23,42,.5));background-size:180% 180%;background-position:0% 50%;color:hsl(var(--foreground, 220 15% 90%));border-radius:9px;display:inline-flex;align-items:center;gap:9px;cursor:pointer;font-size:12px;line-height:1;white-space:nowrap;transition:all .2s ease;will-change:box-shadow,border-color,background-position,transform;transform:translateZ(0);animation:dj-appstore-border-shift 3.2s linear infinite;pointer-events:auto;touch-action:manipulation;user-select:none;-webkit-tap-highlight-color:transparent;}' +
      '#dj-appstore-expand-btn:hover{border-color:rgba(74,222,128,.7);background:linear-gradient(135deg,rgba(22,36,56,.9),rgba(20,34,53,.65));}' +
      '#dj-appstore-expand-btn.is-open{border-color:rgba(74,222,128,.8);background:linear-gradient(135deg,rgba(22,36,56,.95),rgba(20,34,53,.75));}' +
      '#dj-appstore-expand-btn:focus-visible{outline:none;box-shadow:0 0 0 1px rgba(74,222,128,.82),0 0 14px rgba(34,197,94,.35);}' +
      '#dj-appstore-expand-btn .dj-appstore-expand-icon{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;color:currentColor;opacity:.98;}' +
      '@keyframes dj-appstore-border-shift{0%{background-position:0% 50%;}50%{background-position:100% 50%;}100%{background-position:0% 50%;}}' +
      '#dj-appstore-expand-host{display:flex;align-items:center;gap:8px;}' +
      '#dj-appstore-expand-backdrop{position:fixed;inset:0;background:rgba(2,6,16,.62);backdrop-filter:blur(2px);z-index:9998;opacity:0;transition:opacity .18s ease;}' +
      '#dj-appstore-expand-backdrop.is-open{opacity:1;}' +
      '#dj-appstore-expand-panel{position:fixed;left:50%;top:52%;transform:translate(-50%,-50%) scale(.985);opacity:0;width:min(1180px,96vw);height:min(88vh,920px);border:1px solid #2b303b;background:#0f1115;z-index:9999;border-radius:14px;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 18px 64px rgba(0,0,0,.52);transition:opacity .2s ease,transform .22s ease;}' +
      '#dj-appstore-expand-panel.is-open{opacity:1;transform:translate(-50%,-50%) scale(1);}' +
      '#dj-appstore-expand-panel .dj-appstore-expand-panel-head{height:42px;display:flex;align-items:center;justify-content:space-between;padding:0 12px;border-bottom:1px solid #252b36;background:#111722;}' +
      '#dj-appstore-expand-panel .dj-appstore-expand-panel-title{font-size:13px;font-weight:600;color:hsl(var(--foreground, 220 15% 90%));}' +
      '#dj-appstore-expand-panel .dj-appstore-expand-panel-close{width:26px;height:26px;border:1px solid #2d3440;border-radius:7px;background:#0f1724;color:hsl(var(--foreground, 220 15% 90%));display:inline-flex;align-items:center;justify-content:center;cursor:pointer;transition:all .15s ease;}' +
      '#dj-appstore-expand-panel .dj-appstore-expand-panel-close:hover{border-color:rgba(74,222,128,.72);color:#ffffff;background:#152031;}' +
      '#dj-appstore-expand-panel .dj-appstore-expand-panel-close:focus-visible{outline:none;box-shadow:0 0 0 1px rgba(74,222,128,.82),0 0 12px rgba(34,197,94,.24);}' +
      '#dj-appstore-expand-panel .dj-appstore-expand-frame{width:100%;height:100%;flex:1;border:0;background:#0f1115;}' +
      '@media (max-width:720px){#dj-appstore-expand-panel{left:8px;top:10px;transform:none;width:calc(100vw - 16px);height:calc(100vh - 20px);border-radius:12px;}#dj-appstore-expand-panel.is-open{transform:none;}}';
    document.head.appendChild(style);
  }

  function ensurePulseDriver() {
    if (pulseTimer) return;
    pulseStartTs = Date.now();
    pulseTimer = setInterval(function () {
      var btn = qs('#dj-appstore-expand-btn');
      if (!btn || !isVisible(btn)) return;

      // 0 -> 亮 -> 0，从接近 0 光强开始的平滑呼吸
      var period = 3.8;
      var phase = ((Date.now() - pulseStartTs) / 1000) / period * Math.PI * 2;
      var p = (Math.sin(phase - Math.PI / 2) + 1) / 2;
      var eased = p * p * (3 - 2 * p);

      var borderAlpha = 0.02 + 0.36 * eased;
      var alphaRing = 0.00 + 0.07 * eased;
      var alphaNear = 0.00 + 0.17 * eased;
      var alphaFar = 0.00 + 0.09 * eased;
      var spread = 0.00 + 1.4 * eased;
      var blurNear = 0.00 + 7.0 * eased;
      var blurFar = 0.00 + 14.0 * eased;

      btn.style.borderColor = 'rgba(74,222,128,' + borderAlpha.toFixed(3) + ')';
      if (eased < 0.02) {
        btn.style.boxShadow = 'none';
      } else {
        btn.style.boxShadow =
          '0 0 0 ' + spread.toFixed(2) + 'px rgba(34,197,94,' + alphaRing.toFixed(3) + '),' +
          '0 0 ' + blurNear.toFixed(2) + 'px rgba(34,197,94,' + alphaNear.toFixed(3) + '),' +
          '0 0 ' + blurFar.toFixed(2) + 'px rgba(34,197,94,' + alphaFar.toFixed(3) + ')';
      }
    }, 80);
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
    btn.className = 'flex items-center whitespace-nowrap';
    btn.setAttribute('aria-label', title);
    btn.setAttribute('title', title);

    var icon = document.createElement('span');
    icon.className = 'dj-appstore-expand-icon';
    icon.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.15" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9.5h16"></path><path d="M5 9.5l1.2-4h11.6l1.2 4"></path><path d="M5 9.5v8.7a1.8 1.8 0 0 0 1.8 1.8h10.4a1.8 1.8 0 0 0 1.8-1.8V9.5"></path><path d="M9.5 13h5"></path><path d="M12 13v4"></path></svg>';

    var text = document.createElement('span');
    text.textContent = buttonText;

    btn.appendChild(icon);
    btn.appendChild(text);

    function togglePanel(evt) {
      if (evt) {
        evt.preventDefault();
        evt.stopPropagation();
      }
      if (panelToggleBusy) return;
      panelToggleBusy = true;
      setTimeout(function () {
        panelToggleBusy = false;
      }, 140);

      var existing = qs('#dj-appstore-expand-panel');
      if (existing) {
        closePanel();
        return;
      }

      lastPanelOpenAt = Date.now();
      var backdrop = document.createElement('div');
      backdrop.id = 'dj-appstore-expand-backdrop';

      var panel = document.createElement('div');
      panel.id = 'dj-appstore-expand-panel';

      var head = document.createElement('div');
      head.className = 'dj-appstore-expand-panel-head';

      var titleEl = document.createElement('div');
      titleEl.className = 'dj-appstore-expand-panel-title';
      titleEl.textContent = buttonText;

      var closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'dj-appstore-expand-panel-close';
      closeBtn.setAttribute('aria-label', '关闭');
      closeBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6L6 18"></path><path d="M6 6l12 12"></path></svg>';
      closeBtn.onclick = function (e) {
        if (e) {
          e.preventDefault();
          e.stopPropagation();
        }
        closePanel();
      };

      head.appendChild(titleEl);
      head.appendChild(closeBtn);

      var ifr = document.createElement('iframe');
      ifr.className = 'dj-appstore-expand-frame';
      ifr.src = panelUrl;
      backdrop.onclick = function () {
        if (Date.now() - lastPanelOpenAt < 180) return;
        closePanel();
      };

      panel.appendChild(head);
      panel.appendChild(ifr);
      document.body.appendChild(backdrop);
      document.body.appendChild(panel);
      requestAnimationFrame(function () {
        backdrop.classList.add('is-open');
        panel.classList.add('is-open');
      });
      btn.classList.add('is-open');
      updateStatus(true);
    }

    btn.addEventListener('click', togglePanel);
    btn.addEventListener('keydown', function (evt) {
      if (evt.key === 'Enter' || evt.key === ' ') togglePanel(evt);
    });

    return btn;
  }

  function closePanel() {
    var panel = qs('#dj-appstore-expand-panel');
    if (panel) panel.remove();
    var backdrop = qs('#dj-appstore-expand-backdrop');
    if (backdrop) backdrop.remove();
    var btn = qs('#dj-appstore-expand-btn');
    if (btn) btn.classList.remove('is-open');
  }

  function renderStatus() {
    var btn = qs('#dj-appstore-expand-btn');
    if (!btn) return;
    if (healthState.ok === null) {
      btn.setAttribute('title', title + ' · 状态检测中');
      return;
    }
    if (healthState.ok) {
      btn.setAttribute('title', title + ' · ' + statusText);
      return;
    }
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
      closePanel();
    });
  }

  function mountInTopNav() {
    try {
      if (window.location.pathname === '/login') {
        var oldBtn = qs('#dj-appstore-expand-btn');
        if (oldBtn) oldBtn.remove();
        closePanel();
        return false;
      }

      ensureStyle();
      ensurePulseDriver();
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
    ensurePulseDriver();

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
