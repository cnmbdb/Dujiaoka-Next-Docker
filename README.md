# Dujiao-Next Docker 部署

## 部署方式

1. 编辑唯一环境文件 `.env`（按你的服务器环境填写端口、数据库密码、API_URL 等）。
2. 执行下面这一条命令启动：

```bash
docker compose up -d --build
```

## 访问地址（默认）

- User 前台: `http://localhost:3000`
- API 服务: `http://localhost:3001`
- Admin 后台: `http://localhost:3002`

## 说明

- 本项目通过 `docker-compose.yml` 拉取并运行远程镜像。
- 环境配置只使用一个 `.env` 文件；后续修改 `.env` 后，重新执行上面的启动命令即可生效。
