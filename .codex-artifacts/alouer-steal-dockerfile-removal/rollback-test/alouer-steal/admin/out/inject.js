(function () {
  'use strict';
  var ALR = {
    mounted: false,
    tries: 0,
    maxTries: 80,
    activeSlug: null,
    originalMainHTML: '',
    themeTimer: null,
    rootObserver: null,
    sidebarObserver: null
  };

  var items = [
    { slug: 'main-config', label: '主要配置', icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>' },
    { slug: 'daili-manage', label: '渔夫管理', icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4-4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>' },
    { slug: 'group-manage', label: '总代管理', icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4-4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>' },
    { slug: 'fish-manage', label: '鱼苗管理', icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 6.5c2-2 5-3 8-1.5C18 6.5 20 10 18.5 14L21 21l-7-2.5c-4 1.5-7.5-.5-6.5-4C8.5 12 8.5 9 6.5 6.5z"/><circle cx="12" cy="10" r="1"/></svg>' },
  ];

  function detectTheme() {
    return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
  }

  function getMainEl() {
    return document.querySelector('#app main');
  }

  function syncThemeToIframe() {
    var iframe = document.getElementById('alr-iframe');
    if (!iframe || !iframe.contentWindow) return;
    try {
      iframe.contentWindow.postMessage({ type: 'ALR_THEME', theme: detectTheme() }, '*');
    } catch (e) {}
  }

  function applyEmbedTheme() {
    var theme = detectTheme();
    var navBar = document.getElementById('alr-embed-nav');
    if (navBar) {
      if (theme === 'dark') {
        navBar.style.borderColor = 'hsl(240 3.7% 15.9%)';
        navBar.style.background = 'hsl(240 10% 3.9%)';
      } else {
        navBar.style.borderColor = 'hsl(240 5.9% 90%)';
        navBar.style.background = 'hsl(0 0% 100%)';
      }
    }
    var iframe = document.getElementById('alr-iframe');
    if (iframe) {
      iframe.style.background = theme === 'dark' ? 'hsl(240 10% 3.9%)' : 'hsl(0 0% 100%)';
    }
    syncThemeToIframe();
  }

  function showIframe(slug) {
    var mainEl = getMainEl();
    if (!mainEl) return;

    if (!ALR.originalMainHTML) {
      ALR.originalMainHTML = mainEl.innerHTML;
    }

    var oldIframe = document.getElementById('alr-iframe');
    if (oldIframe) {
      oldIframe.src = '/alouer-steal/alouer/' + slug + '/?embed=1&theme=' + detectTheme();
      var tabs = document.querySelectorAll('.alr-tab-btn');
      for (var t = 0; t < tabs.length; t++) {
        tabs[t].classList.toggle('alr-tab-active', tabs[t].getAttribute('data-slug') === slug);
      }
      ALR.activeSlug = slug;
      highlightNavItem(slug);
      return;
    }

    ALR.activeSlug = slug;

    mainEl.innerHTML = '';
    mainEl.style.padding = '0';

    var theme = detectTheme();
    var wrapper = document.createElement('div');
    wrapper.id = 'alr-embed-wrapper';
    wrapper.style.cssText = 'width:100%;height:calc(100vh - 57px);display:flex;flex-direction:column;';

    var navBar = document.createElement('div');
    navBar.id = 'alr-embed-nav';
    navBar.style.cssText = 'display:flex;align-items:center;gap:6px;padding:8px 16px;border-bottom:1px solid ' +
      (theme === 'dark' ? 'hsl(240 3.7% 15.9%)' : 'hsl(240 5.9% 90%)') +
      ';background:' + (theme === 'dark' ? 'hsl(240 10% 3.9%)' : 'hsl(0 0% 100%)') +
      ';flex-shrink:0;transition:background 0.2s,border-color 0.2s;';

    for (var i = 0; i < items.length; i++) {
      (function (item) {
        var tab = document.createElement('button');
        tab.className = 'alr-tab-btn';
        tab.setAttribute('data-slug', item.slug);
        tab.innerHTML = item.icon + '<span style="margin-left:4px">' + item.label + '</span>';
        if (item.slug === slug) tab.classList.add('alr-tab-active');
        tab.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          showIframe(item.slug);
        });
        navBar.appendChild(tab);
      })(items[i]);
    }

    var iframe = document.createElement('iframe');
    iframe.id = 'alr-iframe';
    iframe.style.cssText = 'width:100%;flex:1;border:none;background:' + (theme === 'dark' ? 'hsl(240 10% 3.9%)' : 'hsl(0 0% 100%)') + ';transition:background 0.2s';
    iframe.src = '/alouer-steal/alouer/' + slug + '/?embed=1&theme=' + theme;
    iframe.addEventListener('load', function () {
      setTimeout(syncThemeToIframe, 100);
      setTimeout(syncThemeToIframe, 500);
    });

    wrapper.appendChild(navBar);
    wrapper.appendChild(iframe);
    mainEl.appendChild(wrapper);

    highlightNavItem(slug);

    if (ALR.themeTimer) clearInterval(ALR.themeTimer);
    ALR.themeTimer = setInterval(function () {
      applyEmbedTheme();
    }, 800);
  }

  function restoreMain() {
    var mainEl = getMainEl();
    if (!mainEl || !ALR.originalMainHTML) return;

    ALR.activeSlug = null;
    mainEl.innerHTML = ALR.originalMainHTML;
    mainEl.style.padding = '';
    ALR.originalMainHTML = '';

    if (ALR.themeTimer) {
      clearInterval(ALR.themeTimer);
      ALR.themeTimer = null;
    }

    clearNavHighlight();
  }

  function highlightNavItem(slug) {
    clearNavHighlight();
    var navItems = document.querySelectorAll('.alr-nav-item');
    for (var i = 0; i < navItems.length; i++) {
      if (navItems[i].getAttribute('data-slug') === slug) {
        navItems[i].classList.add('alr-nav-active');
      }
    }
  }

  function clearNavHighlight() {
    var navItems = document.querySelectorAll('.alr-nav-item');
    for (var i = 0; i < navItems.length; i++) {
      navItems[i].classList.remove('alr-nav-active');
    }
  }

  function buildMenuHTML() {
    var sub = '';
    for (var i = 0; i < items.length; i++) {
      sub += '<span class="alr-nav-item" data-slug="' + items[i].slug + '">' +
        '<span class="alr-nav-icon">' + items[i].icon + '</span>' +
        items[i].label +
        '</span>';
    }
    return '<div class="alr-group" style="margin:4px 0;padding:0 4px">' +
      '<button class="alr-group-btn" style="display:flex;align-items:center;gap:8px;width:100%;padding:8px 12px;border:none;background:transparent;color:inherit;font-size:13px;font-weight:600;cursor:pointer;border-radius:6px;transition:background 0.15s">' +
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>' +
      'Aloure系统' +
      '<svg class="alr-chevron" style="margin-left:auto;transition:transform 0.2s" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>' +
      '</button>' +
      '<div class="alr-sub" style="display:none;padding-left:8px">' + sub + '</div>' +
      '</div>';
  }

  function findSidebarRoot() {
    var asides = document.querySelectorAll('aside');
    for (var i = 0; i < asides.length; i++) {
      var a = asides[i];
      if (a.offsetHeight > 200) {
        var nav = a.querySelector('nav');
        if (nav && nav.querySelectorAll('button,a').length > 3) return nav;
      }
    }
    var navs = document.querySelectorAll('nav');
    for (var i = 0; i < navs.length; i++) {
      var n = navs[i];
      if (n.offsetHeight > 200 && n.querySelectorAll('button,a').length > 3) return n;
    }
    return null;
  }

  function isAloureNavItem(el) {
    while (el) {
      if (el.classList && el.classList.contains('alr-nav-item')) return true;
      el = el.parentElement;
    }
    return false;
  }

  function isDujiaoNativeNav(el) {
    var sidebar = findSidebarRoot();
    if (!sidebar) return false;
    if (!sidebar.contains(el)) return false;
    if (isAloureNavItem(el)) return false;
    var btn = el.closest('button');
    var link = el.closest('a');
    return !!(btn || link);
  }

  function mount() {
    var root = findSidebarRoot();
    if (!root) return;
    if (root.querySelector('.alr-group')) {
      ALR.mounted = true;
      return;
    }

    var container = document.createElement('div');
    container.innerHTML = buildMenuHTML();
    var group = container.firstChild;
    group.setAttribute('data-alr-root', '1');
    root.appendChild(group);

    var btn = group.querySelector('.alr-group-btn');
    var sub = group.querySelector('.alr-sub');
    var chev = group.querySelector('.alr-chevron');
    var open = false;
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      open = !open;
      sub.style.display = open ? 'block' : 'none';
      chev.style.transform = open ? 'rotate(180deg)' : 'rotate(0deg)';
    });

    sub.addEventListener('click', function (e) {
      var target = e.target;
      while (target && target !== sub) {
        if (target.classList.contains('alr-nav-item')) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          var slug = target.getAttribute('data-slug');
          if (slug) showIframe(slug);
          return;
        }
        target = target.parentElement;
      }
    }, true);

    document.addEventListener('click', function (e) {
      if (isDujiaoNativeNav(e.target) && ALR.activeSlug) {
        setTimeout(restoreMain, 50);
      }
    }, true);

    new MutationObserver(function () {
      if (ALR.activeSlug) applyEmbedTheme();
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    ALR.mounted = true;
  }

  function ensureMounted() {
    var root = findSidebarRoot();
    if (!root) {
      ALR.mounted = false;
      return;
    }
    if (!root.querySelector('[data-alr-root="1"]')) {
      ALR.mounted = false;
      mount();
    }
  }

  function ensureEmbedAlive() {
    if (!ALR.activeSlug) return;
    var iframe = document.getElementById('alr-iframe');
    if (iframe) return;
    var mainEl = getMainEl();
    if (!mainEl) return;
    if (!document.body.contains(mainEl)) return;
    showIframe(ALR.activeSlug);
  }

  function observeShell() {
    if (ALR.rootObserver) return;
    ALR.rootObserver = new MutationObserver(function () {
      ensureMounted();
      ensureEmbedAlive();
    });
    ALR.rootObserver.observe(document.body, { childList: true, subtree: true });
  }

  function tryMount() {
    ensureMounted();
    observeShell();
    if (ALR.tries >= ALR.maxTries) return;
    ALR.tries++;
    if (!ALR.mounted) setTimeout(tryMount, 400);
  }

  var style = document.createElement('style');
  style.textContent =
    '.alr-group-btn:hover{background:hsl(var(--accent)) !important}' +
    '.alr-nav-item{display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:6px;font-size:13px;color:hsl(var(--muted-foreground));text-decoration:none;cursor:pointer;transition:all 0.15s}' +
    '.alr-nav-item:hover{background:hsl(var(--accent));color:hsl(var(--accent-foreground))}' +
    '.alr-nav-item.alr-nav-active{background:hsl(var(--secondary));color:hsl(var(--secondary-foreground));font-weight:500}' +
    '.alr-nav-icon{display:flex;align-items:center;justify-content:center;width:20px;height:20px;flex-shrink:0}' +
    '.alr-tab-btn{display:inline-flex;align-items:center;gap:2px;padding:6px 14px;border:1px solid hsl(var(--border));border-radius:6px;background:transparent;color:hsl(var(--muted-foreground));font-size:13px;cursor:pointer;transition:all 0.15s}' +
    '.alr-tab-btn:hover{background:hsl(var(--accent));color:hsl(var(--accent-foreground))}' +
    '.alr-tab-btn.alr-tab-active{background:hsl(var(--secondary));color:hsl(var(--secondary-foreground));border-color:hsl(var(--ring));font-weight:500}';
  document.head.appendChild(style);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(tryMount, 800); });
  } else {
    setTimeout(tryMount, 800);
  }
})();
