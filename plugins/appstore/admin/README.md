# App Store Admin

App Store 后台通过 `plugin.json` 声明的 iframe 入口 `/plugins/appstore/panel` 加载。当前 iframe 内容由 `APPSTORE_FRONTEND_URL` 提供，插件后端负责附加当前站点和本地插件 API 参数。

远程 iframe 只能通过受信任的 `postMessage` 请求本地插件操作，不能直接访问 Docker Socket。
