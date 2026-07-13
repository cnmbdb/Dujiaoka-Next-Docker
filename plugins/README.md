# 插件目录契约

每个一级子目录都是一个可安装、可独立分发的插件：

```text
plugins/<plugin-id>/
├── plugin.json          # 名称、版本、入口、权限与兼容版本
├── docker-compose.yml   # 插件服务
├── .env.example         # 插件配置模板
├── backend/             # 后端完整代码（按需）
├── admin/               # 后台页面（按需）
├── public/              # inject.js、CSS、图片（按需）
├── migrations/          # 数据库迁移（按需）
└── hooks/               # install/enable/disable/uninstall
```

规则：

- `plugin.json`、`docker-compose.yml` 和 `.env.example` 是标准插件的基础文件。
- 插件配置写入自己的 `.env`；`.env` 与 `.enabled` 都不提交到 Git。
- `plugins/appstore` 是永久加载的核心插件，不能停用，负责其他插件的安装、启用、禁用、配置和删除。
- 其他插件默认停用，由 App Store 或 `./dujiao plugin enable/disable` 管理本机状态。
- 插件不得改写主系统业务代码；主系统只固定加载 `/plugins/loader.js`。
