(function () {
  if (window.__DUJIAO_PLUGIN_LOADER__) return;
  window.__DUJIAO_PLUGIN_LOADER__ = true;

  var loaded = new Set();

  function loadStyle(url) {
    if (!url || loaded.has(url)) return Promise.resolve();
    loaded.add(url);
    return new Promise(function (resolve, reject) {
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = url;
      link.onload = resolve;
      link.onerror = reject;
      document.head.appendChild(link);
    });
  }

  function loadScript(url) {
    if (!url || loaded.has(url)) return Promise.resolve();
    loaded.add(url);
    return new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = url;
      script.async = false;
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }

  async function loadRegistry() {
    // App Store 是引导插件；未安装时请求失败不会影响主后台。
    await loadScript('/plugins/appstore/static/inject.js').catch(function () {});

    var response = await fetch('/plugins/registry.json', { cache: 'no-store' });
    if (!response.ok) return;
    var registry = await response.json();
    var plugins = Object.values(registry.plugins || {}).filter(function (plugin) {
      return plugin && plugin.enabled !== false;
    });

    for (var i = 0; i < plugins.length; i += 1) {
      var plugin = plugins[i];
      var styles = Array.isArray(plugin.styles) ? plugin.styles : [];
      var scripts = Array.isArray(plugin.scripts) ? plugin.scripts : [];
      for (var j = 0; j < styles.length; j += 1) await loadStyle(styles[j]);
      for (var k = 0; k < scripts.length; k += 1) await loadScript(scripts[k]);
    }
    window.dispatchEvent(new CustomEvent('dujiao:plugins-loaded', { detail: registry }));
  }

  loadRegistry().catch(function (error) {
    console.warn('[Dujiao Plugin Loader]', error);
  });
})();
