# Migrations

App Store 当前只使用文件状态目录，不需要数据库迁移。后续迁移必须放在此目录，并由 `hooks/install.sh` 或插件运行时按版本执行。
