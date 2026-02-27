# Dujiao-Next 域名 + HTTPS/SSL 配置指南

## ✅ 不会有问题

添加域名和 HTTPS/SSL **完全兼容**，是推荐的生产部署方式。当前架构支持直接加一层 Nginx 反向代理处理 SSL。

---

## 📐 架构说明

```
用户浏览器 (HTTPS)
       ↓
   Nginx (SSL 终止，监听 443)
       ↓
   Docker 服务 (HTTP 内部通信)
   ├── User:3000
   ├── API:3001
   └── Admin:3002
```

- **外部**：用户通过 HTTPS 访问
- **内部**：Nginx 把请求转发到各服务的 HTTP 端口
- **Docker 服务**：无需改动，继续用 HTTP

---

## 🚀 配置步骤

### 1. 域名解析

在域名服务商处添加 A 记录，指向服务器 IP：

| 子域名 | 类型 | 记录值 |
|--------|------|--------|
| www | A | 服务器IP |
| api | A | 服务器IP |
| admin | A | 服务器IP |

### 2. 修改环境变量（重要）

在 `.env` 中设置 **公网 API 地址**：

```bash
# 使用 HTTPS 域名（浏览器会请求这个地址）
API_URL=https://api.your-domain.com
```

User 和 Admin 前端会通过该地址调用 API，必须使用 HTTPS 域名。

### 3. 安装 Nginx 和 Certbot

```bash
# Ubuntu/Debian
sudo apt update
sudo apt install nginx certbot python3-certbot-nginx -y
```

### 4. 配置 Nginx 反向代理

创建配置文件 `/etc/nginx/sites-available/dujiao-next`：

```nginx
# User 前台
server {
    listen 80;
    server_name www.your-domain.com;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

# API
server {
    listen 80;
    server_name api.your-domain.com;
    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

# Admin 后台
server {
    listen 80;
    server_name admin.your-domain.com;
    location / {
        proxy_pass http://127.0.0.1:3002;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

启用配置：

```bash
sudo ln -s /etc/nginx/sites-available/dujiao-next /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### 5. 申请 SSL 证书

```bash
sudo certbot --nginx -d www.your-domain.com -d api.your-domain.com -d admin.your-domain.com
```

按提示完成验证，Certbot 会自动修改 Nginx 配置并启用 HTTPS。

### 6. 重启 Docker 服务使 API_URL 生效

```bash
cd /opt/dujiao-next
docker compose restart user admin
```

### 7. （可选）关闭直接端口访问

若只通过域名访问，可在 `docker-compose.yml` 中注释掉端口映射，或只绑定到 127.0.0.1：

```yaml
ports:
  - "127.0.0.1:3000:80"   # 仅本机可访问
```

---

## ⚠️ 注意事项

### 1. API_URL 必须正确

- 使用域名时：`API_URL=https://api.your-domain.com`
- 使用 IP 时：`API_URL=http://服务器IP:3001`

### 2. CORS

API 默认 `cors.allowed_origins: ["*"]`，支持任意域名。如需限制，可在 `config/config.yml` 中修改。

### 3. 上传文件大小

如有大文件上传，在 Nginx 中增加：

```nginx
client_max_body_size 50M;
```

### 4. 证书续期

Let's Encrypt 证书约 90 天过期，Certbot 会配置自动续期。可测试续期：

```bash
sudo certbot renew --dry-run
```

---

## 📋 配置检查清单

- [ ] 域名 A 记录已解析到服务器
- [ ] `.env` 中 `API_URL` 已改为 HTTPS 域名
- [ ] Nginx 反向代理已配置
- [ ] SSL 证书已申请
- [ ] 已重启 user、admin 服务
- [ ] 防火墙已放行 80、443 端口

---

## 🔗 访问地址示例

配置完成后：

- 用户前台: `https://www.your-domain.com`
- API: `https://api.your-domain.com`
- 后台管理: `https://admin.your-domain.com`
