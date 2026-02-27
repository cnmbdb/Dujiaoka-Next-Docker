# Dujiao-Next Docker 部署

## 部署步骤

1. 编辑唯一环境文件 `.env`（按你的服务器环境填写端口、数据库密码、API_URL 等）。
2. 执行下面这一条命令启动：

```bash
docker compose up -d --build
```

## 更新步骤

- 修改普通配置后重启（默认推荐）：

```bash
docker compose up -d --build
```

- 如果改的是端口、镜像标签、容器启动参数等 Compose 级配置，执行：

```bash
docker compose up -d --force-recreate
```

## 访问地址（默认）

- User 前台: `http://localhost:3000`
- API 服务: `http://localhost:3001`
- Admin 后台: `http://localhost:3002`

## 说明

- 本项目通过 `docker-compose.yml` 拉取并运行远程镜像。
- 环境配置只使用一个 `.env` 文件（挂载到容器内）。
