(function () {
  if (window.__APPSTORE_EXPAND_MOUNTED__) return;
  window.__APPSTORE_EXPAND_MOUNTED__ = true;

  var cfg = window.__APPSTORE_EXPAND__ || {};
  var title = cfg.title || 'AppStore Expand';
  var buttonText = cfg.buttonText || '扩展应用商店';
  var statusText = cfg.statusText || '应用商店扩展开启';
  var panelUrl = window.location.origin + '/plugins/appstore/panel';
  var healthUrl = window.location.origin + '/plugins/appstore/health';
  var appstorePageHash = '#/appstore-expand';
  var pluginManagerPageHash = '#/plugin-manager';
  var pluginConfigPageHashPrefix = '#/plugin-config/';
  var legacyAppstorePagePath = '/appstore-expand-page';
  var appstorePageTitle = buttonText;
  var pluginManagerPageTitle = '扩展插件管理';
  var pluginManagerUrl = window.location.origin + '/plugins/appstore/manage';
  var healthState = {
    ok: null,
    busy: false,
    lastAt: 0
  };
  var HEALTH_INTERVAL_MS = 15000;
  var pulseTimer = null;
  var pulseStartTs = Date.now();
  var panelToggleBusy = false;
  var lastButtonPointerUpAt = 0;
  var lastPanelOpenAt = 0;
  var panelThemeSyncTimer = null;
  var embeddedPageState = null;

  function qs(sel) { return document.querySelector(sel); }
  function qsa(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

  function isVisible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    var s = window.getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
  }

  function hasThemeClass(el, theme) {
    if (!el || !el.classList) return false;
    return el.classList.contains(theme) ||
      el.classList.contains(theme + '-theme') ||
      el.classList.contains('theme-' + theme) ||
      el.classList.contains('is-' + theme);
  }

  function detectHostTheme() {
    var de = document.documentElement;
    var body = document.body;
    var attr = '';
    if (de) attr += ' ' + (de.getAttribute('data-theme') || '');
    if (body) attr += ' ' + (body.getAttribute('data-theme') || '');
    if (/dark/i.test(attr)) return 'dark';
    if (/light/i.test(attr)) return 'light';

    if (hasThemeClass(de, 'dark') || hasThemeClass(body, 'dark')) return 'dark';
    if (hasThemeClass(de, 'light') || hasThemeClass(body, 'light')) return 'light';

    try {
      var ref = body || de;
      if (ref) {
        var bg = window.getComputedStyle(ref).backgroundColor || '';
        var nums = bg.match(/\d+/g);
        if (nums && nums.length >= 3) {
          var r = Number(nums[0]);
          var g = Number(nums[1]);
          var b = Number(nums[2]);
          var luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
          return luma < 0.58 ? 'dark' : 'light';
        }
      }
    } catch (_ignored) {}

    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  }

  function applyButtonTheme(btn) {
    if (!btn) return;
    btn.setAttribute('data-theme', detectHostTheme());
  }

  function ensureStyle() {
    if (qs('#dj-appstore-expand-style')) return;
    var style = document.createElement('style');
    style.id = 'dj-appstore-expand-style';
    style.textContent = '' +
      '#dj-appstore-expand-btn{position:relative;z-index:20;min-width:132px;height:38px;padding:0 15px;border:1.5px solid rgba(34,197,94,.14);background:linear-gradient(135deg,rgba(15,23,42,.75),rgba(15,23,42,.5));background-size:180% 180%;background-position:0% 50%;color:hsl(var(--foreground, 220 15% 90%));border-radius:9px;display:inline-flex;align-items:center;justify-content:center;gap:9px;cursor:pointer;font-size:12px;line-height:1;white-space:nowrap;flex:0 0 auto;transition:all .14s ease;will-change:box-shadow,border-color,background-position,transform;transform:translateZ(0);animation:dj-appstore-border-shift 3.2s linear infinite;pointer-events:auto;touch-action:manipulation;user-select:none;-webkit-tap-highlight-color:transparent;}' +
      '#dj-appstore-expand-btn::before{content:"";position:absolute;inset:-6px;border-radius:13px;}' +
      '#dj-appstore-expand-btn:hover{border-color:rgba(74,222,128,.7);background:linear-gradient(135deg,rgba(22,36,56,.9),rgba(20,34,53,.65));}' +
      '#dj-appstore-expand-btn:active{transform:translateZ(0) scale(.985);}' +
      '#dj-appstore-expand-btn.is-open{border-color:rgba(74,222,128,.8);background:linear-gradient(135deg,rgba(22,36,56,.95),rgba(20,34,53,.75));}' +
      '#dj-appstore-expand-btn[data-theme="light"]{background:#ffffff;color:#0f172a;border-color:rgba(148,163,184,.45);box-shadow:0 1px 2px rgba(15,23,42,.08);}' +
      '#dj-appstore-expand-btn[data-theme="light"]:hover{border-color:rgba(74,222,128,.72);background:#f7fafc;}' +
      '#dj-appstore-expand-btn[data-theme="light"].is-open{border-color:rgba(34,197,94,.78);background:#f0fdf4;}' +
      '#dj-appstore-expand-btn:focus-visible{outline:none;box-shadow:0 0 0 1px rgba(74,222,128,.82),0 0 14px rgba(34,197,94,.35);}' +
      '#dj-appstore-expand-btn .dj-appstore-expand-icon,#dj-appstore-expand-btn span{pointer-events:none;}' +
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
      '#dj-appstore-expand-backdrop[data-theme="light"]{background:rgba(255,255,255,.55);backdrop-filter:blur(2px);}' +
      '#dj-appstore-expand-panel[data-theme="light"]{border-color:#d7e1ef;background:#ffffff;box-shadow:0 18px 56px rgba(15,23,42,.12);}' +
      '#dj-appstore-expand-panel[data-theme="light"] .dj-appstore-expand-panel-head{background:#f8fbff;border-bottom-color:#d7e1ef;}' +
      '#dj-appstore-expand-panel[data-theme="light"] .dj-appstore-expand-panel-title{color:#0f172a;}' +
      '#dj-appstore-expand-panel[data-theme="light"] .dj-appstore-expand-panel-close{border-color:#cbd5e1;background:#ffffff;color:#0f172a;}' +
      '#dj-appstore-expand-panel[data-theme="light"] .dj-appstore-expand-panel-close:hover{border-color:#22c55e;background:#f0fdf4;color:#0f172a;}' +
      '#dj-appstore-expand-panel .dj-appstore-expand-frame{width:100%;height:100%;flex:1;border:0;background:#0f1115;}' +
      '#dj-appstore-expand-page{height:calc(100vh - 118px);min-height:560px;display:flex;flex-direction:column;gap:12px;}' +
      '#dj-appstore-expand-page .dj-appstore-expand-page-head{display:flex;align-items:center;justify-content:space-between;gap:12px;}' +
      '#dj-appstore-expand-page .dj-appstore-expand-page-title{min-width:0;}' +
      '#dj-appstore-expand-page .dj-appstore-expand-page-title h1{margin:0;font-size:24px;line-height:1.2;font-weight:700;color:inherit;}' +
      '#dj-appstore-expand-page .dj-appstore-expand-page-frame-wrap{flex:1;min-height:0;border:0;border-radius:0;overflow:hidden;background:transparent;}' +
      '#dj-appstore-expand-page .dj-appstore-expand-page-frame{width:100%;height:100%;border:0;background:transparent;display:block;}' +
      '@media (max-width:720px){#dj-appstore-expand-panel{left:8px;top:10px;transform:none;width:calc(100vw - 16px);height:calc(100vh - 20px);border-radius:12px;}#dj-appstore-expand-panel.is-open{transform:none;}}' +
      'aside[class*="w-64"] > div:last-child > div.text-\\[11px\\]{display:none !important;}';
    document.head.appendChild(style);
  }

  function ensureManageStyle() {
    if (qs('#dj-appstore-manage-style')) return;
    var style = document.createElement('style');
    style.id = 'dj-appstore-manage-style';
    style.textContent = '' +
      '#dj-appstore-manage-btn{height:38px;padding:0 14px;border:1px solid hsl(var(--border,214 32% 91%));border-radius:9px;background:hsl(var(--background,0 0% 100%));color:hsl(var(--foreground,222 47% 11%));display:inline-flex;align-items:center;justify-content:center;gap:8px;white-space:nowrap;font-size:12px;font-weight:500;line-height:1;transition:background .15s ease,border-color .15s ease;}' +
      '#dj-appstore-manage-btn:hover{background:hsl(var(--muted,210 40% 96%));}' +
      '#dj-appstore-manage-btn.is-open{background:hsl(var(--secondary,210 40% 96%));border-color:hsl(var(--ring,215 20% 65%));}' +
      '#dj-appstore-manage-btn:focus-visible{outline:2px solid hsl(var(--ring,215 20% 65%));outline-offset:2px;}' +
      '#dj-appstore-manage-btn .dj-appstore-manage-icon{display:inline-flex;align-items:center;justify-content:center;}' +
      '#dj-appstore-manage-btn .dj-appstore-manage-icon svg{width:17px;height:17px;}' +
      '#dj-appstore-manage-page,#dj-plugin-config-page{height:calc(100vh - 118px);min-height:560px;display:flex;flex-direction:column;gap:12px;}' +
      '.dj-appstore-internal-head{display:flex;align-items:center;justify-content:space-between;gap:12px;}' +
      '.dj-appstore-internal-title{margin:0;font-size:24px;line-height:1.2;font-weight:700;color:inherit;}' +
      '.dj-appstore-internal-frame-wrap{flex:1;min-height:0;overflow:hidden;background:transparent;}' +
      '.dj-appstore-internal-frame{width:100%;height:100%;display:block;border:0;background:transparent;}';
    document.head.appendChild(style);
  }

  function ensurePulseDriver() {
    if (pulseTimer) return;
    pulseStartTs = Date.now();
    pulseTimer = setInterval(function () {
      var btn = qs('#dj-appstore-expand-btn');
      if (!btn || !isVisible(btn)) return;
      applyButtonTheme(btn);

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
    if (!header) header = qs('[role="banner"]');
    if (!header) {
      var headers = qsa('header,div');
      for (var i = 0; i < headers.length; i++) {
        var h = headers[i];
        if (!isVisible(h)) continue;
        var hs = window.getComputedStyle(h);
        if (hs.display !== 'flex') continue;
        if (hs.justifyContent !== 'space-between') continue;
        var hr = h.getBoundingClientRect();
        if (hr.top < -2 || hr.top > 72) continue;
        if (hr.height < 36 || hr.height > 100) continue;
        if (hr.width < window.innerWidth * 0.45) continue;
        header = h;
        break;
      }
    }
    if (!header) {
      var banners = qsa('[role="banner"], header');
      for (var j = 0; j < banners.length; j++) {
        var b = banners[j];
        if (!isVisible(b)) continue;
        var br = b.getBoundingClientRect();
        if (br.top > 80 || br.width < window.innerWidth * 0.4) continue;
        header = b;
        break;
      }
    }
    return header;
  }

  function textLooksLikeLang(t) {
    if (!t) return false;
    return /简体|繁體|中文|English|Language|语言|Locale|i18n|🇨🇳|🇺🇸/i.test(String(t).trim());
  }

  /** 从语言控件向上找到横向工具条（flex 行），避免 parent 过窄导致按钮错位 */
  function findToolbarRowForLang(langNode) {
    var el = langNode;
    var maxHops = 8;
    while (el && maxHops-- > 0) {
      var tag = String(el.tagName || '').toLowerCase();
      var role = String(el.getAttribute && el.getAttribute('role') || '').toLowerCase();
      var isInteractive = tag === 'button' || tag === 'a' || role === 'button';
      var cs = window.getComputedStyle(el);
      var disp = cs.display;
      if (!isInteractive && (disp === 'flex' || disp === 'inline-flex') && cs.flexDirection !== 'column') {
        var r = el.getBoundingClientRect();
        if (r.width >= 120 && el.children && el.children.length >= 2) return el;
      }
      el = el.parentElement;
    }
    if (langNode && langNode.parentElement) {
      var parentTag = String(langNode.parentElement.tagName || '').toLowerCase();
      var parentRole = String(langNode.parentElement.getAttribute && langNode.parentElement.getAttribute('role') || '').toLowerCase();
      if (parentTag !== 'button' && parentTag !== 'a' && parentRole !== 'button') return langNode.parentElement;
    }
    return null;
  }

  function pickLanguageNode() {
    var nodes = qsa(
      'button,[role="button"],a,.n-button,.n-base-selection,.n-select,.n-base-selection-label,' +
      'div[class*="n-base-selection"],div[class*="n-select"],.n-dropdown-trigger'
    );
    var best = null;
    var bestScore = -1;
    var i;
    for (i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!isVisible(el)) continue;
      var t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      var cls = String(el.className || '');
      var r = el.getBoundingClientRect();
      if (r.top < -2 || r.top > 140) continue;
      if (r.left < window.innerWidth * 0.2) continue;
      // Naive UI 语言选择器可能很宽（>240px），原先条件会误杀
      if (r.width < 36 || r.width > 420) continue;
      if (r.height < 18 || r.height > 52) continue;

      var ariaLabel = String(el.getAttribute('aria-label') || '');
      var dataTestId = String(el.getAttribute('data-testid') || '');
      var nameHint = String(el.getAttribute('name') || '');
      var isLangText = textLooksLikeLang(t);
      var isLangHint =
        /lang|locale|i18n|语言/i.test(ariaLabel) ||
        /lang|locale|i18n|语言/i.test(dataTestId) ||
        /lang|locale|i18n|语言/i.test(nameHint) ||
        /lang|locale|i18n|language|n-select|n-base-selection/i.test(cls);
      // 仅接受“明显语言控件”，避免误选退出登录/主题按钮
      if (!isLangText && !isLangHint) continue;

      var score = Math.round(r.left) + (isLangText ? 400 : 0) - Math.min((t || '').length, 24) * 2;
      if (score > bestScore) {
        best = el;
        bestScore = score;
      }
    }
    return best;
  }

  /** 后台顶栏右侧：items-center + gap-*（gap-2 / gap-3 等） */
  function findRightToolbarGroup(header) {
    if (!header) return null;
    var rows = header.querySelectorAll('[class*="items-center"]');
    var best = null;
    var bestLeft = -1;
    for (var i = 0; i < rows.length; i++) {
      var el = rows[i];
      if (!isVisible(el)) continue;
      var tag = String(el.tagName || '').toLowerCase();
      var role = String(el.getAttribute && el.getAttribute('role') || '').toLowerCase();
      if (tag === 'button' || tag === 'a' || role === 'button') continue;
      var cls = String(el.className || '');
      if (cls.indexOf('gap-') === -1 && cls.indexOf('gap') === -1) continue;
      var r = el.getBoundingClientRect();
      if (r.left < window.innerWidth * 0.3) continue;
      if (r.width < 100) continue;
      if (!el.querySelector('button,[role="button"],a')) continue;
      if (r.left >= bestLeft) {
        bestLeft = r.left;
        best = el;
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

    var rightToolbar = findRightToolbarGroup(header);
    if (rightToolbar) return rightToolbar;

    for (var k = 0; k < header.children.length; k++) {
      var c = header.children[k];
      if (!isVisible(c)) continue;
      var tag = String(c.tagName || '').toLowerCase();
      var role = String(c.getAttribute && c.getAttribute('role') || '').toLowerCase();
      if (tag === 'button' || tag === 'a' || role === 'button') continue;
      var cn = typeof c.className === 'string' ? c.className : '';
      if (cn.indexOf('items-center') !== -1 && cn.indexOf('gap-') !== -1) {
        return c;
      }
    }

    var lang = null;
    var nodes = qsa('button,[role="button"],a,.n-button,.n-base-selection');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!header.contains(el) || !isVisible(el)) continue;
      var t = (el.textContent || '').trim();
      if (!t || t.length > 48) continue;
      if (textLooksLikeLang(t)) {
        lang = el;
        break;
      }
    }
    if (lang && lang.parentElement && isVisible(lang.parentElement)) {
      var langGroup = findToolbarRowForLang(lang);
      if (langGroup) return langGroup;
    }

    var children = Array.prototype.slice.call(header.children || []);
    for (var j = children.length - 1; j >= 0; j--) {
      var child = children[j];
      if (!isVisible(child)) continue;
      var childTag = String(child.tagName || '').toLowerCase();
      var childRole = String(child.getAttribute && child.getAttribute('role') || '').toLowerCase();
      if (childTag === 'button' || childTag === 'a' || childRole === 'button') continue;
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
        if (evt.stopImmediatePropagation) evt.stopImmediatePropagation();
      }
      if (panelToggleBusy) return;
      panelToggleBusy = true;
      setTimeout(function () {
        panelToggleBusy = false;
      }, 80);

      openAppstorePage();
      updateStatus(true);
    }

    btn.addEventListener('pointerdown', function (evt) {
      if (evt) {
        evt.preventDefault();
        evt.stopPropagation();
        if (evt.stopImmediatePropagation) evt.stopImmediatePropagation();
      }
    }, true);
    btn.addEventListener('pointerup', function (evt) {
      lastButtonPointerUpAt = Date.now();
      togglePanel(evt);
    }, true);
    btn.addEventListener('click', function (evt) {
      if (Date.now() - lastButtonPointerUpAt < 350) {
        if (evt) {
          evt.preventDefault();
          evt.stopPropagation();
          if (evt.stopImmediatePropagation) evt.stopImmediatePropagation();
        }
        return;
      }
      togglePanel(evt);
    }, true);
    btn.addEventListener('keydown', function (evt) {
      if (evt.key === 'Enter' || evt.key === ' ') togglePanel(evt);
    });

    return btn;
  }

  function createManageBtn() {
    ensureManageStyle();
    var btn = document.createElement('button');
    btn.id = 'dj-appstore-manage-btn';
    btn.type = 'button';
    btn.setAttribute('aria-label', pluginManagerPageTitle);
    btn.setAttribute('title', pluginManagerPageTitle);
    btn.innerHTML = '<span class="dj-appstore-manage-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3H5a2 2 0 0 0-2 2v4h18V5a2 2 0 0 0-2-2h-3"/><path d="M3 9v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9"/><path d="M9 13h6"/><path d="M12 10v6"/></svg></span><span>扩展插件管理</span>';
    btn.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      openPluginManagerPage();
    }, true);
    return btn;
  }

  function closePanel() {
    var panel = qs('#dj-appstore-expand-panel');
    if (panel) panel.remove();
    var backdrop = qs('#dj-appstore-expand-backdrop');
    if (backdrop) backdrop.remove();
    var btn = qs('#dj-appstore-expand-btn');
    if (btn) btn.classList.remove('is-open');
    if (panelThemeSyncTimer) {
      clearInterval(panelThemeSyncTimer);
      panelThemeSyncTimer = null;
    }
  }

  function locateMainContent() {
    var main = qs('main');
    if (main && isVisible(main)) return main;
    var candidates = qsa('[role="main"],div');
    var best = null;
    var bestArea = 0;
    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];
      if (!isVisible(el)) continue;
      var r = el.getBoundingClientRect();
      if (r.left < 180 || r.top < 48 || r.width < 520 || r.height < 360) continue;
      var area = r.width * r.height;
      if (area > bestArea) {
        best = el;
        bestArea = area;
      }
    }
    return best;
  }

  function syncEmbeddedPageTheme(frame, wrap) {
    var theme = detectHostTheme();
    if (wrap) wrap.setAttribute('data-theme', theme);
    try {
      if (!frame || !frame.contentWindow) return;
      frame.contentWindow.postMessage({ type: 'DJ_APPSTORE_THEME', theme: theme }, window.location.origin);
    } catch (_ignored) {}
  }

  function renderAppstorePage() {
    ensureStyle();
    ensureManageStyle();
    closePanel();
    var main = locateMainContent();
    if (!main) return false;

    if (!embeddedPageState || embeddedPageState.main !== main) {
      embeddedPageState = {
        main: main,
        originalChildren: Array.prototype.slice.call(main.childNodes),
        originalScrollTop: main.scrollTop
      };
    }

    main.innerHTML = '';
    main.scrollTop = 0;

    var root = document.createElement('div');
    root.id = 'dj-appstore-expand-page';

    var head = document.createElement('div');
    head.className = 'dj-appstore-expand-page-head';

    var titleBox = document.createElement('div');
    titleBox.className = 'dj-appstore-expand-page-title';
    var h1 = document.createElement('h1');
    h1.textContent = appstorePageTitle;
    titleBox.appendChild(h1);

    head.appendChild(titleBox);
    head.appendChild(createManageBtn());

    var frameWrap = document.createElement('div');
    frameWrap.className = 'dj-appstore-expand-page-frame-wrap';
    var frame = document.createElement('iframe');
    frame.className = 'dj-appstore-expand-page-frame';
    var iframeUrl = new URL(panelUrl, window.location.origin);
    iframeUrl.searchParams.set('theme', detectHostTheme());
    frame.src = iframeUrl.toString();
    frame.addEventListener('load', function () {
      syncEmbeddedPageTheme(frame, frameWrap);
      setTimeout(function () { syncEmbeddedPageTheme(frame, frameWrap); }, 120);
    });
    frameWrap.appendChild(frame);

    root.appendChild(head);
    root.appendChild(frameWrap);
    main.appendChild(root);

    if (panelThemeSyncTimer) clearInterval(panelThemeSyncTimer);
    panelThemeSyncTimer = setInterval(function () {
      syncEmbeddedPageTheme(frame, frameWrap);
    }, 700);
    syncEmbeddedPageTheme(frame, frameWrap);
    return true;
  }

  function renderInternalPage(rootId, pageTitle, frameUrl) {
    ensureStyle();
    ensureManageStyle();
    closePanel();
    var main = locateMainContent();
    if (!main) return false;
    var resolvedUrl = new URL(frameUrl, window.location.origin);
    resolvedUrl.searchParams.set('theme', detectHostTheme());
    var existing = main.querySelector('#' + rootId);
    if (existing && existing.getAttribute('data-frame-url') === resolvedUrl.toString()) return true;

    if (!embeddedPageState || embeddedPageState.main !== main) {
      embeddedPageState = {
        main: main,
        originalChildren: Array.prototype.slice.call(main.childNodes),
        originalScrollTop: main.scrollTop
      };
    }

    main.innerHTML = '';
    main.scrollTop = 0;

    var root = document.createElement('div');
    root.id = rootId;
    root.setAttribute('data-frame-url', resolvedUrl.toString());
    var head = document.createElement('div');
    head.className = 'dj-appstore-internal-head';
    var h1 = document.createElement('h1');
    h1.className = 'dj-appstore-internal-title';
    h1.textContent = pageTitle;
    head.appendChild(h1);

    var frameWrap = document.createElement('div');
    frameWrap.className = 'dj-appstore-internal-frame-wrap';
    var frame = document.createElement('iframe');
    frame.className = 'dj-appstore-internal-frame';
    frame.setAttribute('title', pageTitle);
    frame.src = resolvedUrl.toString();
    frame.addEventListener('load', function () {
      syncEmbeddedPageTheme(frame, frameWrap);
      setTimeout(function () { syncEmbeddedPageTheme(frame, frameWrap); }, 120);
    });
    frameWrap.appendChild(frame);
    root.appendChild(head);
    root.appendChild(frameWrap);
    main.appendChild(root);

    if (panelThemeSyncTimer) clearInterval(panelThemeSyncTimer);
    panelThemeSyncTimer = setInterval(function () { syncEmbeddedPageTheme(frame, frameWrap); }, 700);
    syncEmbeddedPageTheme(frame, frameWrap);
    return true;
  }

  function renderPluginManagerPage() {
    return renderInternalPage('dj-appstore-manage-page', pluginManagerPageTitle, pluginManagerUrl);
  }

  function getPluginConfigRoute() {
    var hash = String(window.location.hash || '');
    if (hash.indexOf(pluginConfigPageHashPrefix) !== 0) return null;
    var queryIndex = hash.indexOf('?');
    var rawId = hash.slice(pluginConfigPageHashPrefix.length, queryIndex >= 0 ? queryIndex : undefined);
    var params = new URLSearchParams(queryIndex >= 0 ? hash.slice(queryIndex + 1) : '');
    var pluginId = decodeURIComponent(rawId || '');
    var configTitle = params.get('title') || pluginId || '插件配置';
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(pluginId)) return null;
    return { pluginId: pluginId, title: configTitle };
  }

  function renderPluginConfigPage() {
    var route = getPluginConfigRoute();
    if (!route) return false;
    var configUrl = window.location.origin + '/plugins/appstore/plugin-config/' + encodeURIComponent(route.pluginId);
    return renderInternalPage('dj-plugin-config-page', route.title, configUrl);
  }

  function restoreAppstorePage() {
    if (!embeddedPageState || !embeddedPageState.main) return;
    var main = embeddedPageState.main;
    if (!document.contains(main)) {
      embeddedPageState = null;
      return;
    }
    main.innerHTML = '';
    for (var i = 0; i < embeddedPageState.originalChildren.length; i++) {
      main.appendChild(embeddedPageState.originalChildren[i]);
    }
    main.scrollTop = embeddedPageState.originalScrollTop || 0;
    embeddedPageState = null;
    if (panelThemeSyncTimer) {
      clearInterval(panelThemeSyncTimer);
      panelThemeSyncTimer = null;
    }
    var manageBtn = qs('#dj-appstore-manage-btn');
    if (manageBtn) manageBtn.classList.remove('is-open');
  }

  function isAppstorePageRoute() {
    return window.location.hash === appstorePageHash || window.location.pathname === legacyAppstorePagePath;
  }

  function isPluginManagerPageRoute() {
    return window.location.hash === pluginManagerPageHash;
  }

  function isPluginConfigPageRoute() {
    return String(window.location.hash || '').indexOf(pluginConfigPageHashPrefix) === 0;
  }

  function openAppstorePage() {
    if (!isAppstorePageRoute()) {
      history.pushState({ djAppstoreExpand: true }, '', '/' + appstorePageHash);
    }
    renderAppstorePage();
    var btn = qs('#dj-appstore-expand-btn');
    if (btn) btn.classList.add('is-open');
  }

  function openPluginManagerPage() {
    if (!isPluginManagerPageRoute()) {
      history.pushState({ djPluginManager: true }, '', '/' + pluginManagerPageHash);
    }
    renderPluginManagerPage();
    var btn = qs('#dj-appstore-manage-btn');
    if (btn) btn.classList.add('is-open');
    var storeBtn = qs('#dj-appstore-expand-btn');
    if (storeBtn) storeBtn.classList.remove('is-open');
  }

  function handleAppstoreRoute() {
    if (window.location.pathname === legacyAppstorePagePath) {
      history.replaceState({ djAppstoreExpand: true }, '', '/' + appstorePageHash);
    }
    if (isAppstorePageRoute()) {
      renderAppstorePage();
      var btn = qs('#dj-appstore-expand-btn');
      if (btn) btn.classList.add('is-open');
      var manage = qs('#dj-appstore-manage-btn');
      if (manage) manage.classList.remove('is-open');
      return;
    }
    if (isPluginManagerPageRoute()) {
      renderPluginManagerPage();
      var manager = qs('#dj-appstore-manage-btn');
      if (manager) manager.classList.add('is-open');
      var oldStoreBtn = qs('#dj-appstore-expand-btn');
      if (oldStoreBtn) oldStoreBtn.classList.remove('is-open');
      return;
    }
    if (isPluginConfigPageRoute()) {
      renderPluginConfigPage();
      return;
    }
    restoreAppstorePage();
    var oldBtn = qs('#dj-appstore-expand-btn');
    if (oldBtn) oldBtn.classList.remove('is-open');
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

  function isBotAdminHeader(header) {
    if (!header) return false;
    var hs = window.getComputedStyle(header);
    if (hs.display !== 'flex') return false;
    if (hs.justifyContent !== 'space-between') return false;
    var hr = header.getBoundingClientRect();
    if (hr.top < -2 || hr.top > 72) return false;
    if (hr.height < 36 || hr.height > 100) return false;
    // 匹配任何满足上述布局条件的顶部导航栏
    return true;
  }

  function mountInTopNav() {
    try {
      if (window.location.pathname === '/login') {
        var oldBtn = qs('#dj-appstore-expand-btn');
        if (oldBtn) oldBtn.remove();
        var oldManageBtn = qs('#dj-appstore-manage-btn');
        if (oldManageBtn) oldManageBtn.remove();
        closePanel();
        return false;
      }

      ensureStyle();
      ensurePulseDriver();
      var btn = qs('#dj-appstore-expand-btn') || createBtn();
      applyButtonTheme(btn);
      var hdr = locateHeader();
      var langNode = pickLanguageNode();
      var group = null;

      // 优先：插入到语言切换控件左边（同一工具条容器内）
      if (langNode) {
        group = findToolbarRowForLang(langNode);
        if (!group && langNode.parentElement && isVisible(langNode.parentElement)) {
          group = langNode.parentElement;
        }
        var groupTag = group ? String(group.tagName || '').toLowerCase() : '';
        var groupRole = group ? String(group.getAttribute && group.getAttribute('role') || '').toLowerCase() : '';
        if (group && groupTag !== 'button' && groupTag !== 'a' && groupRole !== 'button') {
          group.style.gap = group.style.gap || '8px';
          var langTargetInGroup = directChildWithin(group, langNode);
          if (langTargetInGroup && langTargetInGroup.parentElement === group) {
            group.insertBefore(btn, langTargetInGroup);
          } else {
            group.insertBefore(btn, group.firstElementChild || null);
          }
          btn.style.position = '';
          btn.style.top = '';
          btn.style.left = '';
          btn.style.right = '';
          btn.style.zIndex = '';
          btn.style.display = 'inline-flex';
          renderStatus();
          updateStatus(false);
          return true;
        }
      }

      // 顶部导航栏：找不到语言控件时，插到 header 末尾
      if (hdr && isBotAdminHeader(hdr)) {
        var toolbar = findRightToolbarGroup(hdr) || findActionGroupFromHeader(hdr);
        if (toolbar && toolbar !== hdr) {
          toolbar.insertBefore(btn, toolbar.firstElementChild || null);
        } else {
          hdr.appendChild(btn);
        }
        btn.style.position = '';
        btn.style.top = '';
        btn.style.left = '';
        btn.style.right = '';
        btn.style.zIndex = '';
        btn.style.display = 'inline-flex';
        renderStatus();
        updateStatus(false);
        return true;
      }

      // 如果有 header 且语言节点在 header 内，尝试插到语言控件左边
      if (hdr && langNode && hdr.contains(langNode)) {
        if (langNode.parentElement === hdr) hdr.insertBefore(btn, langNode);
        else hdr.appendChild(btn);
        btn.style.position = '';
        btn.style.top = '';
        btn.style.left = '';
        btn.style.right = '';
        btn.style.zIndex = '';
        btn.style.display = 'inline-flex';
        renderStatus();
        updateStatus(false);
        return true;
      }

      if (!group && hdr) group = findRightToolbarGroup(hdr);
      if (!group) group = locateActionGroup();
      if (!group) return false;

      btn.style.position = '';
      btn.style.top = '';
      btn.style.left = '';
      btn.style.right = '';
      btn.style.zIndex = '';
      btn.style.display = 'inline-flex';

      group.style.gap = group.style.gap || '8px';
      var target = langNode ? directChildWithin(group, langNode) : null;
      // 插入到语言按钮的前面（左边）
      if (target && target.parentElement === group) group.insertBefore(btn, target);
      else group.insertBefore(btn, group.firstElementChild || null);
    } catch (_ignored) {
      return false;
    }

    renderStatus();
    updateStatus(false);
    return true;
  }

  function bindPluginManagerMessages() {
    if (window.__APPSTORE_PLUGIN_MANAGER_MESSAGES_BOUND__) return;
    window.__APPSTORE_PLUGIN_MANAGER_MESSAGES_BOUND__ = true;
    window.addEventListener('message', function (event) {
      if (event.origin !== window.location.origin) return;
      var data = event.data || {};
      if (data.type === 'DJ_APPSTORE_CLOSE_PLUGIN_CONFIG') {
        history.replaceState({ djPluginManager: true }, '', '/#/plugin-manager');
        handleAppstoreRoute();
        return;
      }
      if (data.type !== 'DJ_APPSTORE_OPEN_PLUGIN_CONFIG') return;
      var pluginId = String(data.pluginId || '').trim();
      var pluginName = String(data.pluginName || pluginId).trim();
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(pluginId)) return;
      var route = '/#' + pluginConfigPageHashPrefix.slice(1) + encodeURIComponent(pluginId) +
        '?title=' + encodeURIComponent(pluginName + ' 配置');
      history.pushState({ djPluginConfig: true, pluginId: pluginId }, '', route);
      handleAppstoreRoute();
    });
  }

  function patchHistoryNavigation() {
    if (window.__APPSTORE_EXPAND_HISTORY_PATCHED__) return;
    window.__APPSTORE_EXPAND_HISTORY_PATCHED__ = true;
    var fire = function () {
      setTimeout(mountInTopNav, 0);
      setTimeout(handleAppstoreRoute, 20);
      setTimeout(mountInTopNav, 220);
      setTimeout(handleAppstoreRoute, 260);
      setTimeout(mountInTopNav, 900);
      setTimeout(handleAppstoreRoute, 940);
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
    bindPluginManagerMessages();
    renderStatus();
    ensurePulseDriver();
    handleAppstoreRoute();

    var tick = 0;
    var timer = setInterval(function () {
      tick += 1;
      var ok = mountInTopNav();
      handleAppstoreRoute();
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
      if (isAppstorePageRoute() && !qs('#dj-appstore-expand-page')) {
        handleAppstoreRoute();
      }
      if (isPluginManagerPageRoute() && !qs('#dj-appstore-manage-page')) {
        handleAppstoreRoute();
      }
      if (isPluginConfigPageRoute() && !qs('#dj-plugin-config-page')) {
        handleAppstoreRoute();
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
