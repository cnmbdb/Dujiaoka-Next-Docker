# Dujiao App Store 插件

App Store 是插件管理界面与本地执行服务。启用后，它通过后台 iframe 展示远程商店，并管理本机插件的安装、启用、禁用、更新和删除。

## 目录

```text
plugins/appstore/
├── plugin.json
├── docker-compose.yml
├── .env.example
├── backend/
├── admin/
├── public/
├── migrations/
├── hooks/
├── nginx.conf
└── Dockerfile
```

## 职责

- 扫描 `plugins/*/plugin.json`，合并本地插件与远程商店目录。
- 将插件包安装到 `plugins/<plugin-id>/`，不覆盖主系统文件。
- 只执行插件包内由 manifest 声明的生命周期 hook。
- 启用时启动插件 Compose、写入 `data/plugins/registry.json`、安装插件 Nginx 路由并重载 Admin。
- 禁用时撤销前端注册和路由，再停止插件服务。
- 删除时先禁用并执行卸载 hook，插件代码移入可恢复的 trash；业务数据默认保留。
- App Store 的 `selfManaged` 为 `false`，不能在自己的请求中禁用或删除自己。

## 后台 iframe

后台入口为：

```text
/plugins/appstore/panel
```

iframe 默认加载 `APPSTORE_FRONTEND_URL`，并附加：

- `dj_api_base=<当前后台>/plugins/appstore/api`
- `dj_panel_base=<当前后台>/plugins/appstore`
- 当前站点 origin、domain 和登录路径

远程 iframe 负责显示操作界面，本地 App Store 服务负责执行服务器动作。

## API

- `GET /health`
- `GET /static/inject.js`
- `GET /panel`
- `GET /api/extensions`
- `GET /api/plugins/local`
- `GET /api/extensions/:extensionId`
- `POST /api/extensions/:extensionId/:action`

`action` 支持：

- `download`
- `check`
- `install`
- `enable`
- `disable`
- `update`
- `uninstall`
- `delete`

## 首次启用

```bash
cp plugins/appstore/.env.example plugins/appstore/.env
vim plugins/appstore/.env
plugins/appstore/hooks/install.sh
plugins/appstore/hooks/enable.sh
```

主系统只固定加载 `/plugins/loader.js`。App Store 是引导插件，未安装或未运行时不会影响核心后台。

## 安全边界

App Store 需要项目插件目录和 Docker 管理权限，因此生产环境必须把动作 API 限制为已登录管理员，并验证插件包签名、版本兼容性和权限声明。不得执行远程目录返回的任意 Shell 字符串。
