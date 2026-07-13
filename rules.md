# Dujiao-Next Development Rules

本文件是 `Dujiao-Next` 与核心 `plugins/appstore` 插件的系统助记词与协作开发规则。

## 1. 目标与边界

- 目标：稳定交付可运行、可部署、可回滚的电商系统（主站 + 扩展应用商店）。
- 优先级：`稳定性 > 可观测性 > 可扩展性 > 新功能速度`。
- 禁止无验证直接改生产关键链路（支付、订单状态、回调处理、库存扣减）。

## 2. 项目结构认知

- `Dujiao-Next`：主系统（API/User/Admin/Postgres/Redis）。
- `plugins/appstore`：拥有插件安装、启用、禁用、配置与删除能力的核心应用商店服务。
- 核心服务和官方插件使用远程镜像；App Store 永久加载，其他插件由 `./dujiao` 根据 `plugins/*/.enabled` 统一编排。

## 3. 开发原则

- 任何改动必须可解释：改什么、为什么、影响范围、如何回滚。
- 小步提交，避免一次改动跨多个高风险模块。
- 配置优先通过环境变量和显式配置文件控制，不写死到代码。
- 保持接口兼容性：变更字段时优先新增而非直接替换。

## 4. 支付与回调专项规则

- 回调地址必须使用公网可达 HTTPS 域名，不得使用 `127.0.0.1` 或 `localhost`。
- 固定回调地址基准：`https://dujiao-next-api.aloure-web.top/api/v1/payments/callback`。
- 易支付问题排查顺序固定：
  1. 回调是否到达 API（日志是否出现 `payment_callback_received`）。
  2. 参数是否完整（特别是 `param`）。
  3. 支付 ID 是否有效（`payment_id_invalid` / `payment_not_found`）。
  4. 验签是否通过（密钥/算法/版本匹配）。
- 回调失败时优先保留原始请求参数与服务端日志，不先做猜测式修改。

## 5. 部署与 Tunnel 规则

- 开发联调用固定 Tunnel（Named Tunnel），避免 Quick Tunnel URL 频繁变化。
- 当前固定域名映射：
  - API: `dujiao-next-api.aloure-web.top` -> `http://dujiao-next-api:3000`
  - User: `dujiao-next-user.aloure-web.top` -> `http://dujiao-next-user:80`
  - Admin: `dujiao-next-admin.aloure-web.top` -> `http://dujiao-next-admin:80`
- 生产部署默认流程：
  1. `git pull`
  2. `./dujiao plugin apply`
  3. 健康检查 + 关键接口回归（登录、下单、支付回调）

## 6. 配置规则

- `.env` 以最小权限、最小暴露原则维护。
- 严禁将真实密钥、Token、支付私钥提交到 Git。
- `API_URL` 必须指向公网 API 域名，不允许本机回环地址。

## 7. 日志与排障规则

- 所有问题先看证据：容器状态、接口响应、API 日志、数据库状态。
- 常用排障命令：
  - `./dujiao plugin command ps`
  - `docker logs -f dujiao-next-api`
  - `docker logs -f dujiao-next-user`
  - `docker logs -f dujiao-next-admin`
- 排障输出至少包含：时间、请求路径、状态码、关键错误字段。

## 8. 数据与安全规则

- 不直接改线上数据库关键表（`orders`, `payments`, `payment_channels`）除非有备份与回滚方案。
- 管理员账号、支付配置、API Token 变更需记录操作时间与变更人。
- 任何批量脚本必须先在测试环境验证。

## 9. 提交与发布规则

- 每次发布前完成最小回归：
  - 用户端访问
  - 后台登录
  - 下单创建支付
  - 回调落单与状态更新
- 发布说明至少包含：
  - 变更摘要
  - 风险点
  - 回滚步骤

## 10. AI 协作规则（助记）

- AI 只做有证据的判断，不凭空推断生产状态。
- AI 输出优先给可执行命令与可验证结论。
- 遇到阻塞项（凭据、域名控制权、第三方平台权限）要明确列出，不绕过。
- AI 进行配置/部署变更后必须复测并给出结果（HTTP 状态或日志证据）。

---

维护建议：每次出现新故障类型后，把“复盘结论 + 预防规则”补进本文件。
