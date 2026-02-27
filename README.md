# Dujiao-Next 部署指南

## 🚀 快速开始

### 1. 配置环境变量

```bash
vim .env  # 修改 DB_PASSWORD 等配置
```

### 2. 配置 API

编辑 `config/config.yml`，确保数据库密码与 `.env` 中的 `DB_PASSWORD` 一致。

### 3. 创建数据目录（首次部署）

```bash
mkdir -p data/{postgres,redis,uploads,logs}
chmod -R 777 data/logs data/uploads
```

### 4. 启动服务

```bash
docker compose up -d
```

### 5. 访问服务

- **User 前台**: http://localhost:3000
- **API 服务**: http://localhost:3001
- **Admin 后台**: http://localhost:3002

**后台默认账号**: `admin` / `admin123`（首次启动时自动创建）

---

## 📁 必需文件

- `docker-compose.yml` - Docker 编排配置
- `.env` - 唯一环境变量文件（运行时读取）
- `config/config.yml` - API 配置文件
- `data/` - 数据目录（首次部署前创建）

## 💾 存储卷说明

根据官方文档，使用 **bind mount**（本地目录）存储数据：

- `data/postgres/` - PostgreSQL 数据库数据
- `data/redis/` - Redis 数据
- `data/uploads/` - 上传文件
- `data/logs/` - API 日志

**注意**：数据存储在本地 `data/` 目录，便于备份和管理。

---

## ⚙️ 配置说明

### .env 文件

主要配置项：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `TAG` | 镜像版本 | `v0.0.3-beta` |
| `DB_PASSWORD` | 数据库密码 | `dujiao_password` |
| `API_URL` | API 地址（域名+HTTPS 时填写） | 空（使用默认） |
| `DJ_DEFAULT_ADMIN_USERNAME` | 默认管理员账号 | `admin` |
| `DJ_DEFAULT_ADMIN_PASSWORD` | 默认管理员密码 | `admin123` |

### config.yml 文件

- `database.dsn`: 数据库连接（密码需与 `.env` 中的 `DB_PASSWORD` 一致）
- `jwt.secret`: JWT 密钥（生产环境需强密钥）
- `redis.host`: Redis 地址（使用容器名 `dujiao-redis`）

---

## 🔧 常用命令

```bash
# 启动服务
docker compose up -d

# 查看状态
docker compose ps

# 查看日志
docker compose logs -f

# 停止服务
docker compose down

# 更新服务
docker compose pull
docker compose up -d
```

---

## 🌐 域名 + HTTPS

使用域名和 HTTPS 时：

1. 配置 Nginx 反向代理（参考 `nginx/nginx-https.conf.example`）
2. 在 `.env` 中设置 `API_URL=https://api.your-domain.com`
3. 重启服务：`docker compose restart user admin`

详细说明见 `HTTPS_SSL_配置指南.md`

---

## 🆘 后台登录问题

如果无法登录后台：

1. 检查管理员是否已创建：`docker compose logs api | grep admin`
2. 查看初始化说明：参考 `初始化说明.md`
3. 重新初始化：删除 `data/postgres/` 目录后重启

默认账号：`admin` / `admin123`

---

## 📚 更多信息

- 官方文档: https://dujiao-next.com/deploy/docker-compose
- 部署流程: 参考 `服务器部署流程.md`
- 初始化问题: 参考 `初始化说明.md`
