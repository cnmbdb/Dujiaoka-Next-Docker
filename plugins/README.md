# Dujiao-Next 插件规范 v1

每个插件必须完全位于 `plugins/<plugin-id>/`，不能把代码复制到主系统目录，也不能直接修改核心镜像文件。

## 单文件夹宿主

完整 `plugins/` 文件夹同时携带宿主启动能力：

- `plugins/dujiao`：从上一级自动定位普通版本项目，合并主 Compose、App Store Compose 与宿主覆盖。
- `plugins/host/docker-compose.yml`：为 Admin 挂载插件 Nginx、Loader 和动态注册表，并创建固定插件网络。
- `plugins/host/admin-nginx.conf`：注入唯一 `/plugins/loader.js`，代理核心 App Store 和动态插件路由。
- `plugins/appstore`：永久核心插件，负责后续插件管理。

接入普通版本只需复制完整 `plugins/` 文件夹并执行：

```bash
chmod +x plugins/dujiao
./plugins/dujiao plugin apply
```

## 必需结构

```text
plugins/<plugin-id>/
├── plugin.json
├── docker-compose.yml
├── .env.example
├── backend/
├── admin/
├── public/
├── migrations/
└── hooks/
    ├── install.sh
    ├── enable.sh
    ├── disable.sh
    └── uninstall.sh
```

`plugin.json` 必须通过同级 `plugin.schema.json` 校验。路径必须是插件目录内的相对路径，插件 ID 使用小写字母、数字和短横线。

## 生命周期约定

- `install`：检查运行环境并准备插件配置，不启动服务。
- `enable`：执行迁移、启动服务并等待健康检查。
- `disable`：停止服务并撤销动态注册，保留配置和数据。
- `uninstall`：必须在禁用后执行，默认只删除运行资源，不删除业务数据。

运行时会向 hook 注入：

- `PLUGIN_ID`
- `PLUGIN_DIR`
- `PLUGIN_DATA_DIR`
- `PROJECT_ROOT`
- `PLUGIN_REMOVE_DATA`，只有显式请求清理数据时才为 `1`

插件不得从商店元数据执行任意 Shell 字符串；只允许执行插件包内、清单声明的 hook 文件。

由 App Store 容器通过 Docker Socket 启动的插件应优先使用命名卷。Compose 内的相对 bind mount 会按 App Store 容器路径传给宿主机 Docker，除非显式配置宿主机项目绝对路径，否则不可移植。

## 状态模型

插件管理器必须分别记录 `installed`、`enabled`、`running`、`healthy`、`version` 和 `lastError`。`enabled` 不能代替容器健康状态。
