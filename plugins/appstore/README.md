# Dujiao App Store 生产插件

此目录只保存 App Store 的轻量生产部署文件。运行时直接拉取：

```text
ghcr.io/cnmbdb/dujioka-next-tgbot/appstore-expand:latest
```

服务器不会在本地构建 App Store 镜像，因此这里不保存 Dockerfile、Node.js 后端源码、依赖目录或前端构建源码。

## 保留文件

- `docker-compose.yml`：远程镜像、网络和运行时挂载。
- `.env.example`：App Store 独立配置模板。
- `plugin.json`：核心插件元数据、权限和入口。
- `hooks/`：标准生命周期入口。
- `public/images/icon.svg`：插件管理页图标。
- `backend/README.md`、`admin/README.md`、`migrations/README.md`：标准插件目录占位说明。

App Store 是永久核心插件，由 `./plugins/dujiao plugin apply` 随主系统启动。主机 Loader 直接请求远程镜像提供的 `/plugins/appstore/static/inject.js`，本地不保留它的副本。其他插件通过后台安装后默认保持停用。
