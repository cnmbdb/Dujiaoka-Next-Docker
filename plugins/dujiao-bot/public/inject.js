(function () {
  if (window.__DUJAO_BOT_INJECT_V3__) return;
  window.__DUJAO_BOT_INJECT_V3__ = true;

  var cfg = window.__DUJAO_BOT__ || {};
  var title = cfg.title || 'Dujiao-Bot';
  var groupTitle = cfg.groupTitle || 'Dujiao-Bot';
  var panelUrl = window.location.origin + '/plugins/dujiao-bot/panel';
  var healthUrl = window.location.origin + '/plugins/dujiao-bot/health';

  // Expose debug state
  window.__DUJAO_BOT_DEBUG__ = {
    bootAt: Date.now(),
    status: 'init',
    navFound: false,
    menuRootFound: false,
    groupMounted: false,
    error: null
  };

  /* ── 开发调试：直连 next dev 服务器 ────────────────────────────────
   * 生产环境留空，inject.js 会走主站 nginx 路由到 admin 容器。
   * 开发时填 'http://localhost:3001'（admin-panel npm run dev 需先启动）。
   * 也可以通过主站后台页面控制台执行：
   *   window.__BOT_DEV_URL__ = 'http://localhost:3001'
   *   location.reload()
   * ─────────────────────────────────────────────────────────────── */
  window.__BOT_DEV_URL__ = window.__BOT_DEV_URL__ || '';

  var healthState = {
    ok: null,
    busy: false,
    lastAt: 0
  };
  var HEALTH_INTERVAL_MS = 15000;
  var currentPanelSlug = null;
  var LS_EXPAND = 'dj_bot_nav_expanded_v1';
  var CLS_GROUP = 'dj-dujiao-bot-nav-group';
  var botPageHashPrefix = '#/dujiao-bot';
  var botLegacyPathPrefix = '/telegram-bot';
  var botPageState = null;

  /** Dujiao-Bot 独立七页（Next.js 路由） */
  var SLUG_TO_PATH = {
    'bot-settings':    '/plugins/dujiao-bot/ui/bot/settings/',
    'feature-chain':  '/plugins/dujiao-bot/ui/bot/feature-chain/',
    'commands':       '/plugins/dujiao-bot/ui/bot/commands/',
    'keyboard-buttons': '/plugins/dujiao-bot/ui/bot/keyboard/',
    'inline-buttons': '/plugins/dujiao-bot/ui/bot/inline-buttons/',
    'keyword-reply':  '/plugins/dujiao-bot/ui/bot/keyword-reply/',
    'groups-users':    '/plugins/dujiao-bot/ui/bot/groups-users/',
  };

  /** 与 admin-panel NAV_ITEMS 一致；缺失会导致 mountDujiaoBotNav 抛错、侧栏不显示 */
  var DEFAULT_SUBITEMS = [
    { slug: 'bot-settings', label: '机器人设置' },
    { slug: 'feature-chain', label: '功能链配置' },
    { slug: 'commands', label: '命令设置' },
    { slug: 'keyboard-buttons', label: '键盘按钮' },
    { slug: 'inline-buttons', label: '内联按钮' },
    { slug: 'keyword-reply', label: '关键词回复' },
    { slug: 'groups-users', label: '群组与用户' },
  ];

  function slugToPanelPath(slug) {
    var p = SLUG_TO_PATH[slug || 'bot-settings'];
    var devUrl = (typeof window !== 'undefined' && window.__BOT_DEV_URL__) || '';
    var base = devUrl
      ? devUrl.replace(/\/$/, '') + p
      : window.location.origin + p;
    var u = new URL(base);
    u.searchParams.set('embed', '1');
    u.searchParams.set('view', slug || 'bot-settings');
    u.searchParams.set('theme', detectHostTheme());
    return u.toString();
  }

  var EMBED_SHELL_ID = 'dj-dujiao-bot-embed-shell';
  var embedOpenedAtPath = null;

  function qs(sel) { return document.querySelector(sel); }
  function qsa(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

  function log() {
    var msg = '[Dujiao-Bot inject.v3] ' + Array.prototype.slice.call(arguments).join(' ');
    console.info(msg);
  }

  function logWarn() {
    var msg = Array.prototype.slice.call(arguments).join(' ');
    console.warn('[Dujiao-Bot inject.v3] ' + msg);
  }

  function postThemeToIframe() {
    var shell = qs('#' + EMBED_SHELL_ID);
    if (!shell || shell.style.display === 'none') return;
    var ifr = shell.querySelector('iframe.dj-dujiao-bot-embed-frame');
    if (!ifr || !ifr.contentWindow) return;
    var t = detectHostTheme();
    try {
      ifr.contentWindow.postMessage({ type: 'dj-dujiao-bot-theme', theme: t }, window.location.origin);
    } catch (_e) {}
  }

  function bindIframeThemeBridge() {
    if (window.__DJ_BOT_THEME_BRIDGE__) return;
    window.__DJ_BOT_THEME_BRIDGE__ = true;
    var fire = function () {
      postThemeToIframe();
    };
    try {
      var mo = new MutationObserver(fire);
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
      if (document.body) mo.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    } catch (_e) {}
    window.addEventListener('resize', fire);
  }

  function isVisible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    var s = window.getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
  }

  function normText(t) {
    return String(t || '').replace(/\s+/g, ' ').trim();
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

  function slugFromTelegramHref(href) {
    if (!href) return 'overview';
    try {
      var p = String(href).split('?')[0];
      var hash = p.indexOf('#');
      if (hash >= 0) {
        var frag = p.slice(hash + 1).replace(/^!?\/?/g, '');
        if (/telegram-bot/i.test(frag)) p = '/' + frag.replace(/^\/+/, '');
      }
      var low = p.toLowerCase();
      if (low === '/telegram-bot' || low.endsWith('/telegram-bot')) return 'overview';
      var m = low.match(/\/telegram-bot\/([^/?#]+)/);
      return m ? m[1] : 'overview';
    } catch (_e) {
      return 'overview';
    }
  }

  function collectSubmenuItemsFromTelegram(tgGroup) {
    var pl = tgGroup.querySelector(':scope > div.pl-9');
    if (!pl) pl = tgGroup.querySelector('div[class*="pl-9"]');
    if (!pl) return DEFAULT_SUBITEMS.slice();
    var links = pl.querySelectorAll('a[href]');
    var out = [];
    var i;
    for (i = 0; i < links.length; i++) {
      var a = links[i];
      var label = normText(a.textContent);
      if (!label) continue;
      out.push({ label: label, slug: slugFromTelegramHref(a.getAttribute('href') || '') });
    }
    return out.length ? out : DEFAULT_SUBITEMS.slice();
  }

  /**
   * 增强版侧栏检测：多策略并行尝试
   * 策略1: 找含 space-y-1 的 nav/aside/role=navigation（标准 Tailwind 侧栏）
   * 策略2: 找所有可见的 nav 容器并检查是否有按钮型菜单
   * 策略3: 扫描所有可能的侧栏元素，找有子菜单链接的
   */
  function collectSidebarRoots() {
    var seen = Object.create(null);
    var out = [];
    var i;

    // 策略1: 标准 Tailwind 结构
    var navEls = qsa('nav');
    for (i = 0; i < navEls.length; i++) {
      var el = navEls[i];
      if (seen[el]) continue;
      seen[el] = true;
      out.push(el);
    }

    var roleEls = qsa('[role="navigation"]');
    for (i = 0; i < roleEls.length; i++) {
      var r = roleEls[i];
      if (seen[r]) continue;
      seen[r] = true;
      out.push(r);
    }

    // 策略2: aside 元素（必须有按钮菜单）
    var asides = qsa('aside');
    for (i = 0; i < asides.length; i++) {
      var a = asides[i];
      if (seen[a]) continue;
      // 检查是否是菜单类 aside（含有按钮或链接）
      if (!a.querySelector('button, a[href], [role="button"]')) continue;
      seen[a] = true;
      out.push(a);
    }

    // 策略3: 扫描含特定 class 的 div（侧栏通常用 flex 布局）
    var flexDivs = qsa('aside, [class*="sidebar"], [class*="Sidebar"], [class*="side-bar"]');
    for (i = 0; i < flexDivs.length; i++) {
      var fd = flexDivs[i];
      if (seen[fd]) continue;
      if (!fd.querySelector('button, a[href], [role="button"]')) continue;
      seen[fd] = true;
      out.push(fd);
    }

    // 策略4: 扫描 div.flex（很多后台用 flex 做侧栏布局）
    var flexContainers = qsa('div[class*="flex"][class*="w-"], div[class*="flex"][class*="w_"]');
    for (i = 0; i < flexContainers.length; i++) {
      var fc = flexContainers[i];
      if (seen[fc]) continue;
      // 检查宽度是否像侧栏（较窄）
      var r = fc.getBoundingClientRect();
      if (r.width < 60 || r.width > 400) continue;
      if (!fc.querySelector('button, a[href], [role="button"]')) continue;
      seen[fc] = true;
      out.push(fc);
    }

    return out;
  }

  /**
   * 增强版菜单根节点检测
   */
  function getSidebarMenuRoot(nav) {
    // 策略1: 标准 Tailwind space-y-1 分组
    var all = nav.querySelectorAll('div.space-y-1');
    if (all.length > 0) {
      var buckets = [];
      var i, j;
      for (i = 0; i < all.length; i++) {
        var g = all[i];
        if (g.classList.contains(CLS_GROUP)) continue;
        var btn = g.querySelector(':scope > button[type="button"]');
        if (!btn) continue;
        var p = g.parentElement;
        if (!p || !nav.contains(p)) continue;
        var found = -1;
        for (j = 0; j < buckets.length; j++) {
          if (buckets[j].el === p) { found = j; break; }
        }
        if (found >= 0) buckets[found].n += 1;
        else buckets.push({ el: p, n: 1 });
      }
      var best = null;
      var bestN = 0;
      for (i = 0; i < buckets.length; i++) {
        if (buckets[i].n > bestN) { bestN = buckets[i].n; best = buckets[i].el; }
      }
      if (best) return best;
    }

    // 策略2: 找有多个子菜单链接的容器
    var menuLike = nav.querySelectorAll('div[class*="menu"], div[class*="nav"], div[class*="Menu"], div[class*="Nav"]');
    for (i = 0; i < menuLike.length; i++) {
      var ml = menuLike[i];
      if (ml.classList.contains(CLS_GROUP)) continue;
      var links = ml.querySelectorAll('a[href], button, [role="button"]');
      if (links.length >= 2) return ml;
    }

    // 策略3: 直接返回 nav（最宽松）
    return nav;
  }

  function findTelegramGroupBlock(menuRoot) {
    var selectors = [
      // 标准 Tailwind 分组
      'div.space-y-1',
      // 任意含按钮的 div
      'div[class*="group"]',
      // div 容器
      'div'
    ];

    var i, j, divs, btn, tx;

    for (j = 0; j < selectors.length; j++) {
      try {
        divs = menuRoot.querySelectorAll(':scope > ' + selectors[j]);
      } catch (_e) {
        divs = menuRoot.querySelectorAll(selectors[j]);
      }

      for (i = 0; i < divs.length; i++) {
        var g = divs[i];
        if (g.classList.contains(CLS_GROUP)) continue;
        if (g.classList.contains('dj-dujiao-bot-nav-group')) continue;

        // 跳过显然不是菜单组的元素
        if (g.querySelectorAll('a[href], button, [role="button"]').length === 0) continue;

        var btns = g.querySelectorAll('button');
        for (var k = 0; k < btns.length; k++) {
          btn = btns[k];
          tx = normText(btn.textContent);
          if (/telegram/i.test(tx) && (/bot/i.test(tx) || /机器人/.test(tx))) return g;
          if (tx === 'Telegram Bot') return g;
          if (tx === 'Dujiao-Bot') return g;
          if (/dujiao.*bot/i.test(tx)) return g;
        }

        // 检查是否有包含 bot 字样的链接
        var links = g.querySelectorAll('a');
        for (k = 0; k < links.length; k++) {
          tx = normText(links[k].textContent);
          if (/telegram.*bot/i.test(tx) || /dujiao.*bot/i.test(tx)) return g;
        }
      }
    }
    return null;
  }

  function findSystemGroupBlock(menuRoot) {
    var i, divs, btn, tx;
    try {
      divs = menuRoot.querySelectorAll(':scope > div.space-y-1');
    } catch (_e) {
      divs = [];
    }

    for (i = 0; i < divs.length; i++) {
      var g = divs[i];
      if (g.classList.contains(CLS_GROUP)) continue;
      var btns = g.querySelectorAll('button');
      for (var j = 0; j < btns.length; j++) {
        btn = btns[j];
        tx = normText(btn.textContent);
        if (/系统设置|系統設定|System Settings/i.test(tx)) return g;
      }
    }
    return null;
  }

  function findVisibleAdminNavs() {
    var candidates = collectSidebarRoots();
    var out = [];
    var i;
    for (i = 0; i < candidates.length; i++) {
      var nav = candidates[i];
      if (!isVisible(nav)) continue;
      var menuRoot = getSidebarMenuRoot(nav);
      var hasMenu = menuRoot.querySelector('button, a[href]');
      if (!hasMenu) continue;
      out.push(nav);
    }
    return out;
  }

  function sidebarShellAncestor(el) {
    var n = el;
    while (n && n !== document.documentElement) {
      if (n.tagName === 'NAV') return n;
      if (n.tagName === 'ASIDE') return n;
      if (n.getAttribute && String(n.getAttribute('role') || '').toLowerCase() === 'navigation') return n;
      var cls = String(n.className || '');
      if (/sidebar|side-bar|sider|Sider|layout-sider/i.test(cls)) return n;
      n = n.parentElement;
    }
    return null;
  }

  function readExpandedDefault() {
    try {
      var raw = localStorage.getItem(LS_EXPAND);
      if (raw === '0' || raw === 'false') return false;
      return true;
    } catch (_e) {
      return true;
    }
  }

  function saveExpanded(v) {
    try {
      localStorage.setItem(LS_EXPAND, v ? '1' : '0');
    } catch (_e) {}
  }

  function removeLegacySidebarRow() {
    var leg = qs('#dj-dujiao-bot-sidebar-row');
    if (leg) leg.remove();
  }

  var STYLE_VER = '13';

  function ensureStyle() {
    var prev = qs('#dj-dujiao-bot-style');
    if (prev && prev.getAttribute('data-dj-style-ver') === STYLE_VER) return;
    if (prev) prev.remove();
    var style = document.createElement('style');
    style.id = 'dj-dujiao-bot-style';
    style.setAttribute('data-dj-style-ver', STYLE_VER);
    style.textContent = '' +
      '#dj-dujiao-bot-page{height:calc(100vh - 118px);min-height:560px;display:flex;flex-direction:column;gap:12px;background:transparent;}' +
      '#dj-dujiao-bot-page .dj-dujiao-bot-page-head{display:flex;align-items:center;justify-content:space-between;gap:12px;}' +
      '#dj-dujiao-bot-page .dj-dujiao-bot-page-title{min-width:0;}' +
      '#dj-dujiao-bot-page .dj-dujiao-bot-page-title h1{margin:0;font-size:24px;line-height:1.2;font-weight:700;color:inherit;}' +
      '#dj-dujiao-bot-page .dj-dujiao-bot-page-frame-wrap{flex:1;min-height:0;overflow:hidden;background:transparent;border:0;border-radius:0;}' +
      '#dj-dujiao-bot-page iframe.dj-dujiao-bot-page-frame{border:0;width:100%;height:100%;display:block;background:transparent;}' +
      '#' + EMBED_SHELL_ID + '{display:none !important;}' +
      '#' + EMBED_SHELL_ID + ' .dj-shell-inner{display:none !important;}' +
      '#' + EMBED_SHELL_ID + ' iframe.dj-dujiao-bot-embed-frame{border:0;width:100%;height:100%;display:block;background:transparent;}' +
      '#' + EMBED_SHELL_ID + ' .dj-backdrop{display:none !important;}' +
      '.' + CLS_GROUP + '{position:relative;}' +
      '.' + CLS_GROUP + ' .dj-dujiao-bot-chevron{transition:transform .2s ease;}' +
      '.' + CLS_GROUP + ' .dj-dujiao-bot-child-icon-wrap{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;flex-shrink:0;}' +
      '.' + CLS_GROUP + ' svg.dj-dujiao-bot-child-icon{width:16px;height:16px;min-width:16px;min-height:16px;flex-shrink:0;display:block;stroke:currentColor;}' +
      '.' + CLS_GROUP + ' .dj-dujiao-bot-child svg{stroke:currentColor;}' +
      '.' + CLS_GROUP + ' .dj-dujiao-bot-child{cursor:pointer;}' +
      '.dj-debug-active #' + EMBED_SHELL_ID + ' .dj-shell-inner{border:2px dashed #f59e0b;}' +
      '.dj-debug-active .' + CLS_GROUP + '{outline:2px dashed #f59e0b;}' +
      '.dj-debug-active .' + CLS_GROUP + ' .dj-dujiao-bot-child{outline:1px dashed #10b981;}';
    document.head.appendChild(style);
  }

  function setChildActiveStates() {
    var nodes = qsa('.' + CLS_GROUP + ' .dj-dujiao-bot-child');
    var base = 'dj-dujiao-bot-child flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors cursor-pointer outline-none';
    var inactive = base + ' text-muted-foreground hover:bg-secondary/70 hover:text-foreground';
    var active = base + ' bg-secondary text-foreground';
    var i;
    for (i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var slug = n.getAttribute('data-slug') || '';
      n.className = (currentPanelSlug && slug === currentPanelSlug) ? active : inactive;
    }
  }

  function getTopNavHeight() {
    var sel = 'header, [class*="navbar"], [class*="top-nav"], [class*="header"], [class*="topbar"], [role="banner"]';
    var el = document.querySelector(sel);
    if (!el) return 0;
    var r = el.getBoundingClientRect();
    return r.height > 0 ? Math.floor(r.bottom) : 0;
  }

  function getSidebarRightEdge() {
    var injected = qs('.' + CLS_GROUP);
    if (injected) {
      var navEl = injected.closest('nav') || injected.closest('aside') || injected.closest('[role="navigation"]') || injected.parentElement;
      if (navEl && isVisible(navEl)) {
        var ir = navEl.getBoundingClientRect();
        if (ir.width > 40 && ir.width < window.innerWidth * 0.85) {
          var right = Math.max(0, Math.floor(ir.right));
          if (right > 0) return right;
        }
      }
    }
    var navs = findVisibleAdminNavs();
    var best = 0;
    var i;
    for (i = 0; i < navs.length; i++) {
      var nr = navs[i].getBoundingClientRect();
      if (nr.width < 80) continue;
      if (nr.width >= window.innerWidth * 0.85) continue;
      if (nr.left > window.innerWidth * 0.35) continue;
      var cand = Math.floor(nr.right);
      if (cand > 50 && cand < window.innerWidth * 0.55 && cand > best) best = cand;
    }
    return best;
  }

  function slugFromBotRoute() {
    var hash = String(window.location.hash || '');
    if (hash.indexOf(botPageHashPrefix) === 0) {
      var rest = hash.slice(botPageHashPrefix.length).replace(/^\/+/, '').split(/[?#]/)[0];
      return rest || 'bot-settings';
    }
    var path = String(window.location.pathname || '');
    if (path === botLegacyPathPrefix || path.indexOf(botLegacyPathPrefix + '/') === 0) {
      var legacy = path.slice(botLegacyPathPrefix.length).replace(/^\/+/, '').split(/[?#]/)[0];
      return legacy || 'bot-settings';
    }
    return null;
  }

  function botRouteForSlug(slug) {
    return '/' + botPageHashPrefix + '/' + encodeURIComponent(slug || 'bot-settings');
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

  function syncBotPageTheme(frame) {
    try {
      if (!frame || !frame.contentWindow) return;
      frame.contentWindow.postMessage({ type: 'dj-dujiao-bot-theme', theme: detectHostTheme() }, window.location.origin);
    } catch (_e) {}
  }

  function renderBotPage(slug) {
    ensureStyle();
    var s = slug || 'bot-settings';
    currentPanelSlug = s;

    var legacyShell = qs('#' + EMBED_SHELL_ID);
    if (legacyShell) legacyShell.remove();

    var main = locateMainContent();
    if (!main) return false;

    if (!botPageState || botPageState.main !== main) {
      botPageState = {
        main: main,
        originalChildren: Array.prototype.slice.call(main.childNodes),
        originalScrollTop: main.scrollTop
      };
    }

    var existing = main.querySelector('#dj-dujiao-bot-page');
    if (existing) {
      existing.setAttribute('data-slug', s);
      var existingTitle = existing.querySelector('.dj-dujiao-bot-page-title h1');
      if (existingTitle) existingTitle.textContent = groupTitle;
      var existingFrame = existing.querySelector('iframe.dj-dujiao-bot-page-frame');
      var nextSrc = slugToPanelPath(s);
      if (existingFrame && existingFrame.getAttribute('data-dj-src') !== nextSrc) {
        existingFrame.setAttribute('data-dj-src', nextSrc);
        existingFrame.src = nextSrc;
      }
      syncBotPageTheme(existingFrame);
      setChildActiveStates();
      return true;
    }

    main.innerHTML = '';
    main.scrollTop = 0;

    var root = document.createElement('div');
    root.id = 'dj-dujiao-bot-page';
    root.setAttribute('data-slug', s);

    var head = document.createElement('div');
    head.className = 'dj-dujiao-bot-page-head';
    var titleBox = document.createElement('div');
    titleBox.className = 'dj-dujiao-bot-page-title';
    var h1 = document.createElement('h1');
    h1.textContent = groupTitle;
    titleBox.appendChild(h1);
    head.appendChild(titleBox);

    var frameWrap = document.createElement('div');
    frameWrap.className = 'dj-dujiao-bot-page-frame-wrap';
    var frame = document.createElement('iframe');
    frame.className = 'dj-dujiao-bot-page-frame';
    frame.setAttribute('title', title);
    var frameSrc = slugToPanelPath(s);
    frame.setAttribute('data-dj-src', frameSrc);
    frame.src = frameSrc;
    frame.addEventListener('load', function () {
      syncBotPageTheme(frame);
      setTimeout(function () { syncBotPageTheme(frame); }, 120);
    });
    frameWrap.appendChild(frame);

    root.appendChild(head);
    root.appendChild(frameWrap);
    main.appendChild(root);

    syncBotPageTheme(frame);
    setChildActiveStates();
    return true;
  }

  function restoreBotPage() {
    if (!botPageState || !botPageState.main) return;
    var main = botPageState.main;
    if (!document.contains(main)) {
      botPageState = null;
      return;
    }
    main.innerHTML = '';
    for (var i = 0; i < botPageState.originalChildren.length; i++) {
      main.appendChild(botPageState.originalChildren[i]);
    }
    main.scrollTop = botPageState.originalScrollTop || 0;
    botPageState = null;
    currentPanelSlug = null;
    setChildActiveStates();
  }

  function handleBotRoute() {
    var slug = slugFromBotRoute();
    if (window.location.pathname === botLegacyPathPrefix || window.location.pathname.indexOf(botLegacyPathPrefix + '/') === 0) {
      history.replaceState({ djDujiaoBot: true }, '', botRouteForSlug(slug || 'bot-settings'));
      slug = slugFromBotRoute();
    }
    if (slug) {
      renderBotPage(slug);
      return;
    }
    restoreBotPage();
  }

  function layoutEmbedShell() {
    var shell = qs('#' + EMBED_SHELL_ID);
    if (!shell || shell.style.display === 'none') return;

    var sidebarRight = getSidebarRightEdge();
    var topNavBottom = getTopNavHeight();

    var shellInner = shell.querySelector('.dj-shell-inner');
    var backdrop = shell.querySelector('.dj-backdrop');

    if (!shellInner) return;

    if (sidebarRight > 0) {
      var innerAvail = window.innerWidth - sidebarRight;
      var minInner = Math.min(420, Math.floor(window.innerWidth * 0.45));
      if (innerAvail < minInner) sidebarRight = 0;
    }

    if (!sidebarRight || sidebarRight <= 0) {
      shell.style.left = '0px';
      shell.style.top = topNavBottom > 0 ? topNavBottom + 'px' : '0px';
      shell.style.width = '100%';
      shell.style.height = topNavBottom > 0
        ? 'calc(100vh - ' + topNavBottom + 'px)'
        : '100vh';
      shellInner.style.left = '0px';
      shellInner.style.right = 'auto';
      shellInner.style.width = '100%';
      if (backdrop) { backdrop.style.width = '0px'; }
      log('sidebar detection failed — using full-screen fallback');
      return;
    }

    shell.style.left = '0px';
    shell.style.top = topNavBottom > 0 ? topNavBottom + 'px' : '0px';
    shell.style.width = '100%';
    shell.style.height = topNavBottom > 0
      ? 'calc(100vh - ' + topNavBottom + 'px)'
      : '100vh';

    shellInner.style.left = sidebarRight + 'px';
    shellInner.style.right = 'auto';
    shellInner.style.width = 'calc(100vw - ' + sidebarRight + 'px)';
    shellInner.style.height = '100%';

    if (backdrop) {
      backdrop.style.width = sidebarRight + 'px';
      backdrop.style.right = 'auto';
    }
  }

  function hideEmbedShell() {
    embedOpenedAtPath = null;
    var shell = qs('#' + EMBED_SHELL_ID);
    if (shell) {
      shell.style.display = 'none';
      var ifr = shell.querySelector('iframe');
      if (ifr) {
        ifr.removeAttribute('data-dj-src');
        ifr.src = 'about:blank';
      }
    }
    currentPanelSlug = null;
    setChildActiveStates();
  }

  function showEmbedShell(slug) {
    currentPanelSlug = slug || 'bot-settings';
    var shell = qs('#' + EMBED_SHELL_ID);
    if (!shell) {
      shell = document.createElement('div');
      shell.id = EMBED_SHELL_ID;
      document.body.appendChild(shell);
    }
    shell.style.display = 'block';
    shell.style.position = 'fixed';
    shell.style.zIndex = '10050';
    shell.style.margin = '0';
    shell.style.padding = '0';
    shell.style.border = 'none';
    shell.style.overflow = 'hidden';
    shell.style.boxSizing = 'border-box';
    shell.style.background = 'transparent';

    var inner = shell.querySelector('.dj-shell-inner');
    if (!inner) {
      inner = document.createElement('div');
      inner.className = 'dj-shell-inner';
      shell.appendChild(inner);
    }

    var backdrop = shell.querySelector('.dj-backdrop');
    if (!backdrop) {
      backdrop = document.createElement('div');
      backdrop.className = 'dj-backdrop';
      shell.insertBefore(backdrop, inner);
    }

    var ifr = shell.querySelector('iframe.dj-dujiao-bot-embed-frame');
    if (!ifr) {
      ifr = document.createElement('iframe');
      ifr.className = 'dj-dujiao-bot-embed-frame';
      ifr.setAttribute('title', title);
      inner.appendChild(ifr);
    }

    layoutEmbedShell();
    embedOpenedAtPath = window.location.pathname;

    var next = slugToPanelPath(currentPanelSlug);

    var prevAttr = ifr.getAttribute('data-dj-src');
    var doc = null;
    try { doc = ifr.contentDocument; } catch (_ignoreCrossOrigin) {}
    if (prevAttr && doc && doc.readyState === 'complete') {
      try {
        var prev = new URL(prevAttr, window.location.origin);
        var neu = new URL(next, window.location.origin);
        var samePath = prev.pathname === neu.pathname;
        var bothEmbed = prev.searchParams.get('embed') === '1' && neu.searchParams.get('embed') === '1';
        var themeSame = prev.searchParams.get('theme') === neu.searchParams.get('theme');
        var verSame = prev.searchParams.get('panelv') === neu.searchParams.get('panelv');
        var viewChanged = prev.searchParams.get('view') !== neu.searchParams.get('view');
        if (samePath && bothEmbed && themeSame && verSame && viewChanged) {
          ifr.setAttribute('data-dj-src', next);
          ifr.contentWindow.postMessage({ type: 'dj-dujiao-bot-nav', view: currentPanelSlug }, window.location.origin);
          postThemeToIframe();
          setChildActiveStates();
          log('panel soft-nav:', currentPanelSlug);
          return;
        }
      } catch (_e) {}
    }

    ifr.setAttribute('data-dj-src', next);
    ifr.onload = function () {
      postThemeToIframe();
    };
    ifr.src = next;

    log('panel opened:', slug, '| sidebarRight:', getSidebarRightEdge(), '| topNav:', getTopNavHeight());
  }

  function openDujiaoBotPanel(evt, slug, itemLabel) {
    if (evt) {
      evt.preventDefault();
      evt.stopPropagation();
    }
    var s = slug || 'bot-settings';
    var target = botRouteForSlug(s);
    if (window.location.hash !== botPageHashPrefix + '/' + encodeURIComponent(s)) {
      history.pushState({ djDujiaoBot: true, slug: s }, '', target);
    }
    renderBotPage(s);
  }

  function closePanel() {
    hideEmbedShell();
    var panel = qs('#dj-dujiao-bot-panel');
    if (panel) panel.remove();
    var backdrop = qs('#dj-dujiao-bot-backdrop');
    if (backdrop) backdrop.remove();
  }

  function robotIconSvg() {
    return '<svg class="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/></svg>';
  }

  function chevronSvg() {
    return '<svg class="h-4 w-4 shrink-0 text-muted-foreground dj-dujiao-bot-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg>';
  }

  function childIconSvg(slug) {
    var base = 'class="dj-dujiao-bot-child-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
    var s = String(slug || '');
    if (s === 'bot-settings') {
      return '<svg ' + base + '><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/></svg>';
    }
    if (s === 'feature-chain') {
      return '<svg ' + base + '><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>';
    }
    if (s === 'commands') {
      return '<svg ' + base + '><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>';
    }
    if (s === 'keyboard-buttons') {
      return '<svg ' + base + '><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8"/></svg>';
    }
    if (s === 'inline-buttons') {
      return '<svg ' + base + '><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>';
    }
    if (s === 'keyword-reply') {
      return '<svg ' + base + '><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/><path d="M13 8H7"/><path d="M17 12H7"/></svg>';
    }
    if (s === 'groups-users') {
      return '<svg ' + base + '><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>';
    }
    if (s === 'overview') {
      return '<svg ' + base + '><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>';
    }
    if (s === 'settings') {
      return '<svg ' + base + '><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>';
    }
    if (s === 'help-center') {
      return '<svg ' + base + '><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>';
    }
    if (s === 'menu') {
      return '<svg ' + base + '><path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/></svg>';
    }
    if (s === 'status') {
      return '<svg ' + base + '><path d="M5 12.55a11 11 0 0114.08 0"/><path d="M1.42 9a16 16 0 0121.16 0"/><path d="M8.53 16.11a6 6 0 016.95 0"/><path d="M12 20h.01"/></svg>';
    }
    if (s === 'broadcasts') {
      return '<svg ' + base + '><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg>';
    }
    if (s === 'users') {
      return '<svg ' + base + '><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>';
    }
    if (s === 'delivery') {
      return '<svg ' + base + '><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>';
    }
    if (s === 'customer-service') {
      return '<svg ' + base + '><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>';
    }
    if (s === 'auto-reply') {
      return '<svg ' + base + '><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>';
    }
    if (s === 'config') {
      return '<svg ' + base + '><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93l-1.41 1.41M5.34 18.66l-1.41 1.41M2 12h2M20 12h2M19.07 19.07l-1.41-1.41M5.34 5.34L3.93 3.93M12 2v2M12 20v2"/></svg>';
    }
    if (s === 'logs') {
      return '<svg ' + base + '><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>';
    }
    return '<svg ' + base + '><circle cx="12" cy="12" r="3"/></svg>';
  }

  function itemsSignature(items) {
    return items.map(function (x) { return x.slug + ':' + x.label; }).join('|') + '|nav13';
  }

  function buildOrUpdateGroup(menuRoot, items) {
    var root = menuRoot.querySelector('.' + CLS_GROUP);
    var sig = itemsSignature(items);
    if (root && root.getAttribute('data-dj-items') === sig && root.querySelector('.dj-dujiao-bot-child') && root.querySelector('.dj-dujiao-bot-child-icon')) {
      positionGroup(menuRoot, root);
      wireGroup(root, items);
      applyExpandedUi(root);
      setChildActiveStates();
      return root;
    }
    if (root) root.remove();

    root = document.createElement('div');
    root.className = CLS_GROUP + ' space-y-1';
    root.setAttribute('data-dj-injected', '1');
    root.setAttribute('data-dj-items', sig);

    var expanded = readExpandedDefault();
    root.setAttribute('data-dj-expanded', expanded ? '1' : '0');

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm transition-colors hover:bg-secondary/70 text-foreground';
    btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');

    var left = document.createElement('div');
    left.className = 'flex min-w-0 items-center gap-3';
    left.innerHTML = robotIconSvg();
    var titleSpan = document.createElement('span');
    titleSpan.className = 'truncate';
    titleSpan.textContent = groupTitle;
    left.appendChild(titleSpan);

    var chevWrap = document.createElement('span');
    chevWrap.innerHTML = chevronSvg();

    btn.appendChild(left);
    btn.appendChild(chevWrap);

    var childWrap = document.createElement('div');
    childWrap.className = 'space-y-1 pl-9 dj-dujiao-bot-submenu';

    var j;
    for (j = 0; j < items.length; j++) {
      (function (item) {
        var row = document.createElement('div');
        row.setAttribute('role', 'button');
        row.tabIndex = 0;
        row.className = 'dj-dujiao-bot-child flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors cursor-pointer text-muted-foreground hover:bg-secondary/70 hover:text-foreground';
        row.setAttribute('data-slug', item.slug);
        var iconWrap = document.createElement('span');
        iconWrap.className = 'dj-dujiao-bot-child-icon-wrap text-current';
        iconWrap.innerHTML = childIconSvg(item.slug);
        var sp = document.createElement('span');
        sp.className = 'dj-dujiao-bot-child-label truncate';
        sp.textContent = item.label;
        row.appendChild(iconWrap);
        row.appendChild(sp);
        childWrap.appendChild(row);
      })(items[j]);
    }

    root.appendChild(btn);
    root.appendChild(childWrap);

    wireGroup(root, items);
    applyExpandedUi(root);
    positionGroup(menuRoot, root);
    setChildActiveStates();
    return root;
  }

  function applyExpandedUi(root) {
    var expanded = root.getAttribute('data-dj-expanded') === '1';
    var btn = root.querySelector('button[type="button"]');
    var childWrap = root.querySelector('.dj-dujiao-bot-submenu');
    var chev = root.querySelector('.dj-dujiao-bot-chevron');
    if (btn) {
      btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      btn.className = expanded
        ? 'flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm transition-colors hover:bg-secondary/70 bg-secondary/40 text-foreground'
        : 'flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm transition-colors hover:bg-secondary/70 text-foreground';
    }
    if (childWrap) childWrap.style.display = expanded ? '' : 'none';
    if (chev) chev.style.transform = expanded ? 'rotate(90deg)' : 'rotate(0deg)';
  }

  function wireGroup(root, items) {
    var btn = root.querySelector('button[type="button"]');
    if (btn && !btn.__djBound) {
      btn.__djBound = true;
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var ex = root.getAttribute('data-dj-expanded') === '1';
        root.setAttribute('data-dj-expanded', ex ? '0' : '1');
        saveExpanded(!ex);
        applyExpandedUi(root);
      });
    }

    var rows = root.querySelectorAll('.dj-dujiao-bot-child');
    var i;
    for (i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (row.__djBound) continue;
      row.__djBound = true;
      var slug = row.getAttribute('data-slug') || 'bot-settings';
      var labelEl = row.querySelector('.dj-dujiao-bot-child-label');
      var label = labelEl ? normText(labelEl.textContent) : normText(row.textContent);
      row.addEventListener('click', function (s, lb) {
        return function (e) {
          openDujiaoBotPanel(e, s, lb);
        };
      }(slug, label));
      row.addEventListener('keydown', function (s, lb) {
        return function (evt) {
          if (evt.key === 'Enter' || evt.key === ' ') openDujiaoBotPanel(evt, s, lb);
        };
      }(slug, label));
    }
  }

  function positionGroup(nav, root) {
    // 如果已注入，不要重复插入
    if (root.parentNode === nav) return;

    var tg = findTelegramGroupBlock(nav);
    if (tg && tg.parentNode === nav) {
      if (root.parentNode) root.parentNode.removeChild(root);
      if (tg.nextSibling) nav.insertBefore(root, tg.nextSibling);
      else nav.appendChild(root);
      log('positioned after Telegram group');
      return;
    }
    var sys = findSystemGroupBlock(nav);
    if (sys && sys.parentNode === nav) {
      if (root.parentNode) root.parentNode.removeChild(root);
      nav.insertBefore(root, sys);
      log('positioned before system settings group');
      return;
    }
    if (root.parentNode) root.parentNode.removeChild(root);
    var firstGrp = nav.querySelector(':scope > div.space-y-1');
    if (firstGrp) nav.insertBefore(root, firstGrp.nextSibling);
    else nav.appendChild(root);
    log('positioned at end of nav');
  }

  /**
   * 强制注入：无论侧栏结构如何都尝试注入
   * 使用 appendChild 到 menuRoot 作为最后防线
   */
  function forceInject(menuRoot) {
    if (qs('.' + CLS_GROUP)) {
      log('group already exists, skipping force inject');
      return;
    }
    var items = DEFAULT_SUBITEMS.slice();
    buildOrUpdateGroup(menuRoot, items);
    log('force inject to menuRoot:', menuRoot.tagName, menuRoot.className.substring(0, 60));
  }

  function mountDujiaoBotNav() {
    try {
      if (window.location.pathname === '/login') {
        qsa('.' + CLS_GROUP).forEach(function (n) { n.remove(); });
        closePanel();
        window.__DUJAO_BOT_DEBUG__.status = 'login-page';
        return false;
      }

      ensureStyle();
      removeLegacySidebarRow();
      removeTopNavButton();

      var navs = findVisibleAdminNavs();
      window.__DUJAO_BOT_DEBUG__.navFound = navs.length > 0;
      window.__DUJAO_BOT_DEBUG__.navCount = navs.length;

      if (!navs.length) {
        logWarn('no admin navs found, trying force inject...');
        // 最后尝试：直接在 body 里找最像侧栏的元素
        var candidates = qsa('aside, nav, [role="navigation"], [class*="sidebar"], [class*="Sidebar"]');
        var injected = false;
        for (var ci = 0; ci < candidates.length; ci++) {
          var c = candidates[ci];
          if (!isVisible(c)) continue;
          if (c.querySelector('.' + CLS_GROUP)) continue;
          var menuRoot = getSidebarMenuRoot(c);
          if (menuRoot) {
            forceInject(menuRoot);
            injected = true;
            break;
          }
        }
        if (!injected) {
          logWarn('could not find any valid menu root for injection');
          window.__DUJAO_BOT_DEBUG__.status = 'no-navs';
        }
        return navs.length > 0;
      }

      var i;
      for (i = 0; i < navs.length; i++) {
        var nav = navs[i];
        var menuRoot = getSidebarMenuRoot(nav);
        window.__DUJAO_BOT_DEBUG__.menuRootFound = !!menuRoot;
        if (!menuRoot) continue;
        var items = DEFAULT_SUBITEMS.slice();
        buildOrUpdateGroup(menuRoot, items);
        window.__DUJAO_BOT_DEBUG__.groupMounted = true;
        window.__DUJAO_BOT_DEBUG__.status = 'mounted';
        log('mounted on nav:', nav.tagName, '| menuRoot:', menuRoot.tagName, '| items:', items.length);
      }

      qsa('.' + CLS_GROUP).forEach(function (g) {
        if (!document.contains(g)) return;
        var shell = sidebarShellAncestor(g);
        // 仅当能定位到侧栏壳且确实不可见时才移除；shell===null 常见于新版后台用 div 包菜单（无 nav/aside），勿误删
        if (shell && !isVisible(shell)) g.remove();
      });

      return true;
    } catch (e) {
      logWarn('mountDujiaoBotNav error:', e.message);
      window.__DUJAO_BOT_DEBUG__.error = e.message;
      return false;
    }
  }

  function renderStatus() {
    var tip = '';
    if (healthState.ok === null) tip = title + ' · 状态检测中';
    else if (healthState.ok) tip = title + ' · 插件运行中';
    else tip = title + ' · 插件未运行';
    qsa('.' + CLS_GROUP + ' button[type="button"]').forEach(function (b) {
      b.setAttribute('title', tip);
    });
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
    if (window.__DUJAO_BOT_CLOSE_BOUND__) return;
    window.__DUJAO_BOT_CLOSE_BOUND__ = true;
    window.addEventListener('keydown', function (evt) {
      if (evt.key !== 'Escape') return;
      closePanel();
    });
    window.addEventListener('message', function (ev) {
      if (ev.origin !== window.location.origin) return;
      var d = ev.data;
      if (!d || d.type !== 'dj-dujiao-bot-view') return;
      currentPanelSlug = d.view || 'bot-settings';
      setChildActiveStates();
    });
    window.addEventListener('resize', function () {
      layoutEmbedShell();
    });
  }

  function removeTopNavButton() {
    try {
      if (window.location.pathname === '/login') {
        var b = qs('#dj-dujiao-bot-btn');
        if (b) b.remove();
        closePanel();
        return;
      }
      var btn = qs('#dj-dujiao-bot-btn');
      if (btn) btn.remove();
    } catch (_e) {}
  }

  function patchHistoryNavigation() {
    if (window.__DUJAO_BOT_HISTORY_PATCHED__) return;
    window.__DUJAO_BOT_HISTORY_PATCHED__ = true;
    var fire = function () {
      if (embedOpenedAtPath !== null && window.location.pathname !== embedOpenedAtPath) {
        hideEmbedShell();
      }
      setTimeout(handleBotRoute, 20);
      setTimeout(removeTopNavButton, 0);
      setTimeout(removeTopNavButton, 220);
      setTimeout(mountDujiaoBotNav, 0);
      setTimeout(handleBotRoute, 260);
      setTimeout(mountDujiaoBotNav, 220);
      setTimeout(mountDujiaoBotNav, 900);
      setTimeout(handleBotRoute, 940);
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

  function bindCaptureClick() {
    if (window.__DUJAO_BOT_CAPTURE_BOUND__) return;
    window.__DUJAO_BOT_CAPTURE_BOUND__ = true;
    document.addEventListener('click', function (e) {
      var el = e.target;
      while (el && el !== document.documentElement) {
        var slug = el.getAttribute ? el.getAttribute('data-slug') : null;
        if (slug && el.classList && el.classList.contains('dj-dujiao-bot-child')) {
          e.stopPropagation();
          e.preventDefault();
          var labelEl = el.querySelector('.dj-dujiao-bot-child-label');
          var label = labelEl ? normText(labelEl.textContent) : normText(el.textContent);
          openDujiaoBotPanel(null, slug, label);
          return;
        }
        el = el.parentElement;
      }
    }, true);
  }

  /**
   * 调试辅助：在控制台暴露诊断信息
   * 用户可以在浏览器控制台执行：
   *   window.__DUJAO_BOT_DIAGNOSE__()
   * 查看详细的注入诊断信息
   */
  window.__DUJAO_BOT_DIAGNOSE__ = function () {
    var debug = window.__DUJAO_BOT_DEBUG__ || {};
    var navs = findVisibleAdminNavs();
    var injected = qsa('.' + CLS_GROUP);
    var sidebarCandidates = qsa('aside, nav, [role="navigation"], [class*="sidebar"], [class*="Sidebar"]');
    var result = {
      debug: debug,
      visibleNavs: navs.length,
      navTags: navs.map(function(n) { return n.tagName + (n.id ? '#' + n.id : '') + (n.className ? '.' + n.className.substring(0, 40) : ''); }),
      injectedGroups: injected.length,
      sidebarCandidates: sidebarCandidates.length,
      sidebarCandidateTags: sidebarCandidates.map(function(n) {
        return n.tagName + (n.id ? '#' + n.id : '') + ' visible=' + isVisible(n) + ' w=' + Math.round(n.getBoundingClientRect().width);
      }),
      pathname: window.location.pathname
    };
    console.info('[Dujiao-Bot diagnose]', result);
    return result;
  };

  // 启用调试模式（在 URL 加 ?djdebug=1 参数）
  if (window.location.search.indexOf('djdebug=1') >= 0) {
    document.body.classList.add('dj-debug-active');
  }

  function boot() {
    bindCaptureClick();
    patchHistoryNavigation();
    bindPanelCloseBehavior();
    bindIframeThemeBridge();
    renderStatus();
    handleBotRoute();

    log('booting...', 'pathname:', window.location.pathname);

    var tick = 0;
    var timer = setInterval(function () {
      tick += 1;
      removeTopNavButton();
      var mounted = mountDujiaoBotNav();
      handleBotRoute();
      if (mounted && tick >= 2) {
        clearInterval(timer);
        log('initial mount complete at tick', tick);
      }
      if (tick > 50) {
        clearInterval(timer);
        logWarn('mount timer expired after 50 ticks');
      }
    }, 280);

    window.addEventListener('resize', function () {
      mountDujiaoBotNav();
      handleBotRoute();
    });

    var moTimer = null;
    new MutationObserver(function () {
      if (moTimer) return;
      moTimer = setTimeout(function () {
        moTimer = null;
        removeTopNavButton();
        mountDujiaoBotNav();
        handleBotRoute();
      }, 120);
    }).observe(document.documentElement, { childList: true, subtree: true });

    setInterval(function () {
      removeTopNavButton();
      mountDujiaoBotNav();
      var slug = slugFromBotRoute();
      if (slug && !qs('#dj-dujiao-bot-page')) {
        handleBotRoute();
      }
    }, 1200);

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
