# Dujiaoka-AppStore-Expand

独立扩展项目（插件化），用于在 **Dujiaoka-Next 后台顶部导航** 增加“应用商店状态按钮”，并提供扩展面板入口。

目标：
- 独立镜像、独立 compose、独立配置
- 不侵入 Dujiaoka-Next 核心业务代码
- Dujiaoka-Next 升级后，插件可继续独立运行

## 已完成开发

### 1. 独立可运行插件服务

已完成文件：
- `docker-compose.yml`
- `.env`
- `app/Dockerfile`
- `app/package.json`
- `app/server.js`
- `app/public/inject.js`
- `integration/admin-nginx.patch.conf`

启动方式（在本目录执行）：

```bash
docker compose up -d --build
```

### 2. 插件能力（当前版本）

- `GET /health`：健康检查接口
- `GET /inject/appstore-expand.js`：后台注入脚本
- `GET /panel`：扩展面板页面（抽屉 iframe 打开）

### 3. 后台按钮注入逻辑

- 优先插入到“语言切换左侧”
- 如果无法定位语言节点，自动降级到右上角浮动按钮
- 按钮显示扩展状态：
  - 绿色：扩展正常
  - 红色：扩展异常

### 4. 接入 Dujiaoka-Next 方式（非侵入）

通过 Nginx 做两件事：
1. 增加 `/appstore-expand/` 反向代理到插件容器
2. 在 admin HTML 响应里注入脚本标签

参考文件：
- `integration/admin-nginx.patch.conf`

## 当前联调验证结果（已通过）

- 插件直连健康：`http://localhost:3010/health` 正常
- 通过 admin 反代健康：`http://localhost:3002/appstore-expand/health` 正常
- 注入脚本地址：`http://localhost:3002/appstore-expand/inject/appstore-expand.js` 正常返回

说明：当前本机环境已完成一次端到端联调。

## 部署说明（生产）

1. 把 `Dujiaoka-AppStore-Expand` 文件夹放到服务器任意目录（建议与 Dujiaoka-Next 同级）
2. 在插件目录执行：

```bash
docker compose up -d --build
```

3. 按 `integration/admin-nginx.patch.conf` 修改 Dujiaoka-Next 的 admin nginx 配置
4. 重建 admin 容器：

```bash
cd /path/to/Dujiao-Next
docker compose up -d --force-recreate admin
```

## 后续开发计划（Roadmap）

### P1：可用性增强
- 增加插件配置页（按钮文案、状态文案、面板地址）
- 增加注入开关（仅 admin 登录后显示）
- 增加版本与健康状态展示

### P2：应用商店核心功能
- 应用列表（远程仓库/本地源）
- 一键安装/卸载/启停
- 扩展运行状态监控

### P3：权限与隔离
- 与 Dujiaoka-Next 管理员权限打通（最小权限原则）
- 插件能力白名单（只开放允许的 API）
- 操作审计日志

### P4：发布与分发
- 生成标准发布包（zip / release）
- 版本升级策略（向后兼容）
- 一键安装脚本（可选）

## 设计约束（长期保持）

- 不直接改 Dujiaoka-Next 核心源码
- 插件独立版本管理、独立发布
- 接入层只保留在网关（Nginx）与注入脚本

