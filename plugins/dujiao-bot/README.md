# Dujiao Bot 生产插件

此目录是 Dujiao Bot 的轻量生产部署包。运行时拉取远程镜像，不在生产仓库保存依赖、构建缓存或完整开发源码。

## 手动测试启用

1. 在 Dujiao-Next 后台进入插件管理。
2. 找到 `Dujiao Bot`。
3. 如需连接 Telegram，先在插件配置中填写 Bot Token、用户名和 Webhook。
4. 点击“启用”。

启用钩子会自动创建 `.env`、连接核心 `dujiao-network`，并启动 `dujiao-bot` 容器。插件会使用：

- PostgreSQL：`dujiao-postgres:5432`
- Redis：`dujiao-redis:6379`
- Core API：`dujiao-next-api:3000`

## 生产内容

- `plugin.json`：插件元数据、权限与入口。
- `docker-compose.yml`：远程镜像和持久化卷。
- `.env.example`：首次配置模板。
- `hooks/`：安装、启用、禁用和卸载生命周期。
- `migrations/`：数据库结构说明与迁移文件。
- `nginx.conf`、`public/`：后台路由、菜单注入和图标。

禁用只停止容器并取消后台注册。卸载默认保留插件数据；只有明确选择删除数据时才会删除命名卷。
