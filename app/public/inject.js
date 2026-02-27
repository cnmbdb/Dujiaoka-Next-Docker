(function () {
  if (window.__APPSTORE_EXPAND_MOUNTED__) return;
  window.__APPSTORE_EXPAND_MOUNTED__ = true;

  var cfg = window.__APPSTORE_EXPAND__ || {};
  var title = cfg.title || 'AppStore Expand';
  var statusText = cfg.statusText || '应用商店扩展开启';

  var panelUrl = window.location.origin + '/appstore-expand/panel';
  var healthUrl = window.location.origin + '/appstore-expand/health';

  function qs(sel) { return document.querySelector(sel); }
  function qsa(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

  function createBtn() {
    var btn = document.createElement('button');
    btn.id = 'dj-appstore-expand-btn';
    btn.type = 'button';
    btn.style.cssText = 'height:30px;padding:0 10px;border:1px solid #0ea5e9;background:#0f172a;color:#e2e8f0;border-radius:8px;display:inline-flex;align-items:center;gap:8px;cursor:pointer;font-size:12px;';

    var dot = document.createElement('span');
    dot.style.cssText = 'width:8px;height:8px;border-radius:50%;background:#ef4444;display:inline-block;';
    dot.id = 'dj-appstore-expand-dot';

    var text = document.createElement('span');
    text.textContent = title;

    btn.appendChild(dot);
    btn.appendChild(text);
    btn.addEventListener('click', openPanel);
    return btn;
  }

  function createFallbackHost() {
    var host = document.createElement('div');
    host.id = 'dj-appstore-expand-fallback';
    host.style.cssText = 'position:fixed;top:14px;right:14px;z-index:9999;';
    document.body.appendChild(host);
    return host;
  }

  function mountBtn() {
    var existing = qs('#dj-appstore-expand-btn');
    if (existing) return;

    var btn = createBtn();
    var langNode = qsa('button,div,span,a').find(function (el) {
      var t = (el.textContent || '').trim();
      return t === '中文' || t === 'English' || t.indexOf('语言') !== -1 || t.indexOf('Language') !== -1;
    });

    if (langNode && langNode.parentElement) {
      langNode.parentElement.insertBefore(btn, langNode);
    } else {
      createFallbackHost().appendChild(btn);
    }
  }

  function openPanel() {
    var wrap = qs('#dj-appstore-expand-drawer');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'dj-appstore-expand-drawer';
      wrap.style.cssText = 'position:fixed;top:0;right:0;width:min(620px,96vw);height:100vh;background:#0b1220;border-left:1px solid #334155;z-index:10000;box-shadow:-8px 0 24px rgba(0,0,0,.35);';

      var top = document.createElement('div');
      top.style.cssText = 'height:46px;border-bottom:1px solid #334155;display:flex;align-items:center;justify-content:space-between;padding:0 12px;color:#e2e8f0;font-size:13px;';
      top.textContent = title;

      var close = document.createElement('button');
      close.textContent = '关闭';
      close.style.cssText = 'border:1px solid #475569;background:#111827;color:#e2e8f0;border-radius:6px;padding:4px 8px;cursor:pointer;';
      close.onclick = function () { wrap.remove(); };
      top.appendChild(close);

      var ifr = document.createElement('iframe');
      ifr.src = panelUrl;
      ifr.style.cssText = 'width:100%;height:calc(100vh - 46px);border:0;background:#0f172a;';

      wrap.appendChild(top);
      wrap.appendChild(ifr);
      document.body.appendChild(wrap);
    }
  }

  function pingHealth() {
    fetch(healthUrl, { method: 'GET' }).then(function (r) {
      var dot = qs('#dj-appstore-expand-dot');
      if (!dot) return;
      dot.style.background = r.ok ? '#22c55e' : '#ef4444';
      dot.title = r.ok ? statusText : '应用商店扩展异常';
    }).catch(function () {
      var dot = qs('#dj-appstore-expand-dot');
      if (!dot) return;
      dot.style.background = '#ef4444';
      dot.title = '应用商店扩展异常';
    });
  }

  function boot() {
    mountBtn();
    pingHealth();
    setInterval(pingHealth, 15000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  new MutationObserver(mountBtn).observe(document.documentElement, { childList: true, subtree: true });
})();
