# Alouer 收银与运营插件

这是从提交 `6553ebf` 完整恢复、并适配 Dujiao-Next Plugin API v1 的独立插件。
整个目录可以单独复制或作为独立仓库发布，不依赖仓库根目录中的 Compose、Nginx 或源码。

## 已恢复功能

- 原版 4,416 行 Express、链上监控与 Telegram Bot 后端。
- TRC、ERC、BSC、OKC、GRC、POL 网络处理与钱包授权逻辑。
- 收银台、订单回查、访客会话及支付渠道同步。
- 原版 `pages` 静态业务站点与资源。
- 四个原版管理页面：主要配置、渔夫管理、总代管理、鱼苗管理。
- Dujiao Admin 左侧导航注入、iframe 嵌入与明暗主题同步。

## 目录

```text
backend/      原版 Bot 与 API
admin/        Next.js 管理面板源码及静态导出
site/         原版 pages 业务站点
public/       Dujiao 导航注入脚本与图标
migrations/   PostgreSQL 初始化脚本
config/       容器内部 Nginx
hooks/        Plugin API 生命周期
```

## 生产模式

`docker-compose.yml` 只拉取远程镜像，不包含 `build`，也不挂载源码：

```bash
docker compose --env-file .env -f docker-compose.yml pull
docker compose --env-file .env -f docker-compose.yml up -d --wait
```

默认镜像为 `ghcr.io/cnmbdb/alouer-steal:latest`。可通过 `ALOUER_IMAGE`、
`ALOUER_TAG` 和 `ALOUER_PULL_POLICY` 覆盖。插件发布端口默认为
`http://127.0.0.1:3025`，同时通过 `dujiao-network` 供 Dujiao Admin 代理访问。

## 开发模式

`docker-compose.dev.yml` 只使用远程 GHCR 镜像作为运行时基础，不执行本地 Docker build；
它挂载本目录的后端、管理面板源码、业务站点、注入脚本和 dev Nginx 配置：

```bash
docker compose --env-file .env -f docker-compose.dev.yml up -d --pull missing --wait
```

开发实例为 `dujiao-plugin-alouer-steal-dev`，默认地址
`http://127.0.0.1:3026`。容器内同时运行：

- `backend/bot.js`：Node.js `--watch` 自动重启。
- `admin/`：Next.js dev server，源码保存后自动 Fast Refresh。
- `site/`、`public/`：直接使用挂载文件，不需要重新构建镜像。

首次使用只需在宿主机安装管理端依赖：

```bash
npm --prefix admin ci
```

之后修改 `admin/src`、`backend`、`site` 或 `public` 会直接在 dev 服务生效，不需要重新
构建镜像，也不需要执行 `npm run build`。只有将插件改动推送到 `main` 时，GitHub Action
才会在远程构建并发布新的 GHCR 生产镜像；生产 Compose 始终只使用远程镜像。

## Plugin API 安装

```bash
cp .env.example .env
sh hooks/install.sh
sh hooks/enable.sh
```

`enable.sh` 会通过现有 `dujiao-postgres` 容器幂等执行 `migrations/001-alouer.sql`，
随后启动插件。停用与卸载不会默认删除命名数据卷；仅当宿主传入
`PLUGIN_REMOVE_DATA=1` 时卸载数据。

## 路由

- `/health`
- `/api/alouer/*`
- `/alouer-steal/alouer/main-config/`
- `/alouer-steal/alouer/daili-manage/`
- `/alouer-steal/alouer/group-manage/`
- `/alouer-steal/alouer/fish-manage/`
- `/alouer-pay/`、`/alouer-checkout/`、`/inject/`
- `/trx/`、`/tk/`、`/sw/`、`/sgk/`、`/xinbi/`、`/hwdb/`、`/energy/`

插件的 `nginx.conf` 由 App Store 安装到 Admin Nginx，因此管理页面和 API 无需修改
宿主配置。用户站点的同域名公开路径属于宿主 User Nginx 的职责；在坚持插件目录完全
可移植的边界下，可直接使用插件发布端口，或由部署环境选择性代理上述公开路径。

## 镜像发布

`.github/workflows/alouer-steal-image.yml` 支持独立插件仓库、当前单体仓库路径以及
`plugins/alouer-steal` 路径，构建 `linux/amd64` 与 `linux/arm64` 镜像并推送到 GHCR。
