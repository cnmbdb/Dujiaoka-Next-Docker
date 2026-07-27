-- Bot 用户表：界面语言（与官方机器人一致：先选语言再进主菜单）
ALTER TABLE dujiao_bot_user ADD COLUMN IF NOT EXISTS preferred_locale VARCHAR(12);
