# Railway 环境变量分层

Railway 的环境变量分为两层：

1. `env/shared.env.example`：production 环境共享变量，粘贴到 Railway 项目的 Environment Variables / Raw Editor。
2. `env/<service>.env.example`：只粘贴到对应 Railway Service 的 Variables / Raw Editor。

当前项目的四个应用服务分别使用：

- `api.env.example` → `api`
- `admin.env.example` → `admin`
- `user.env.example` → `user`
- `appstore-expand.env.example` → `appstore-expand`

Postgres 和 Redis 是 Railway 管理服务，不要把本机 `.env` 里的 `DB_*` 或 `REDIS_*` 直接粘贴到它们上面。API 通过 Railway 引用变量读取它们：

```text
DATABASE_DSN=${{Postgres.DATABASE_URL}}
REDIS_HOST=${{Redis.REDISHOST}}
REDIS_PORT=${{Redis.REDISPORT}}
REDIS_PASSWORD=${{Redis.REDISPASSWORD}}
```

## Raw Editor 使用顺序

1. 先把 `shared.env.example` 的内容粘贴到 production 环境级 Raw Editor。
2. 把 `api.env.example` 粘贴到 `api` 服务；把 `admin.env.example`、`user.env.example`、`appstore-expand.env.example` 分别粘贴到对应服务。
3. API 模板中的三个密钥必须改成三组不同的 `openssl rand -hex 32` 结果，管理员密码也必须换成强密码。
4. `APPSTORE_API_TOKEN` 必须与 API 使用的 App Store Token 分开，并设置为另一组随机值。
5. 保存后分别 Redeploy 四个应用服务。

本机的 `/Users/a2333/IDE/部署到服务器的文件/Dujiao-Next/.env` 只用于本地 Docker Compose，不会被 Railway 自动读取，也不应原样复制给每个服务。
