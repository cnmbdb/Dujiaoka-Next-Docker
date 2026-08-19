-- ============================================
-- Dujiao-Bot 数据库迁移脚本
-- 独立插件数据库表结构
-- ============================================

-- 1. Bot 配置表
CREATE TABLE IF NOT EXISTS dujiao_bot_config (
    id SERIAL PRIMARY KEY,
    config_key VARCHAR(100) NOT NULL UNIQUE,
    config_value TEXT,
    config_type VARCHAR(20) DEFAULT 'string',
    config_group VARCHAR(50) DEFAULT 'general',
    config_label VARCHAR(100),
    is_public BOOLEAN DEFAULT FALSE,
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. Bot 用户绑定表
CREATE TABLE IF NOT EXISTS dujiao_bot_user (
    id SERIAL PRIMARY KEY,
    telegram_user_id BIGINT NOT NULL UNIQUE,
    telegram_username VARCHAR(100),
    telegram_first_name VARCHAR(100),
    telegram_last_name VARCHAR(100),
    dujiaoka_user_id INTEGER,
    dujiaoka_email VARCHAR(255),
    bind_status VARCHAR(20) DEFAULT 'pending',
    bind_token VARCHAR(64),
    bind_token_expire TIMESTAMP,
    last_active_at TIMESTAMP,
    notification_enabled BOOLEAN DEFAULT TRUE,
    is_admin BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 3. 自动发货队列表
CREATE TABLE IF NOT EXISTS dujiao_bot_delivery_queue (
    id SERIAL PRIMARY KEY,
    order_id INTEGER NOT NULL,
    order_no VARCHAR(50) NOT NULL,
    telegram_user_id BIGINT,
    goods_id INTEGER,
    goods_name VARCHAR(255),
    quantity INTEGER DEFAULT 1,
    card_info TEXT,
    status VARCHAR(20) DEFAULT 'pending',
    attempts INTEGER DEFAULT 0,
    last_attempt_at TIMESTAMP,
    error_message TEXT,
    delivered_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 4. 客服会话表
CREATE TABLE IF NOT EXISTS dujiao_bot_chat_session (
    id SERIAL PRIMARY KEY,
    session_id VARCHAR(64) NOT NULL UNIQUE,
    telegram_user_id BIGINT,
    dujiaoka_user_id INTEGER,
    chat_type VARCHAR(30),
    status VARCHAR(20) DEFAULT 'waiting',
    admin_id BIGINT,
    last_message_at TIMESTAMP,
    message_count INTEGER DEFAULT 0,
    rating INTEGER,
    feedback TEXT,
    opened_at TIMESTAMP,
    closed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 5. 聊天消息表
CREATE TABLE IF NOT EXISTS dujiao_bot_chat_message (
    id SERIAL PRIMARY KEY,
    session_id VARCHAR(64) NOT NULL,
    message_id VARCHAR(100),
    sender_type VARCHAR(20) NOT NULL,
    sender_id BIGINT,
    message_type VARCHAR(20) DEFAULT 'text',
    content TEXT,
    metadata JSONB,
    is_read BOOLEAN DEFAULT FALSE,
    read_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 6. 广播记录表
CREATE TABLE IF NOT EXISTS dujiao_bot_broadcast (
    id SERIAL PRIMARY KEY,
    broadcast_id VARCHAR(64) NOT NULL UNIQUE,
    title VARCHAR(255),
    content TEXT NOT NULL,
    message_type VARCHAR(20) DEFAULT 'text',
    media_url VARCHAR(500),
    target_filter JSONB,
    total_users INTEGER DEFAULT 0,
    sent_count INTEGER DEFAULT 0,
    failed_count INTEGER DEFAULT 0,
    status VARCHAR(20) DEFAULT 'draft',
    scheduled_at TIMESTAMP,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    created_by BIGINT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 7. Bot 操作日志表
CREATE TABLE IF NOT EXISTS dujiao_bot_log (
    id SERIAL PRIMARY KEY,
    log_type VARCHAR(20) DEFAULT 'info',
    action VARCHAR(50),
    user_id BIGINT,
    target_type VARCHAR(50),
    target_id VARCHAR(100),
    message TEXT,
    details JSONB,
    ip_address VARCHAR(45),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 8. 自动回复规则表
CREATE TABLE IF NOT EXISTS dujiao_bot_auto_reply (
    id SERIAL PRIMARY KEY,
    keyword VARCHAR(100) NOT NULL,
    match_type VARCHAR(20) DEFAULT 'contains',
    response_type VARCHAR(20) DEFAULT 'text',
    response_content TEXT NOT NULL,
    media_url VARCHAR(500),
    is_active BOOLEAN DEFAULT TRUE,
    priority INTEGER DEFAULT 0,
    usage_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================
-- 索引
-- ============================================

-- Bot 用户索引
CREATE INDEX IF NOT EXISTS idx_bot_user_telegram_id ON dujiao_bot_user(telegram_user_id);
CREATE INDEX IF NOT EXISTS idx_bot_user_status ON dujiao_bot_user(bind_status);
CREATE INDEX IF NOT EXISTS idx_bot_user_dujiaoka_id ON dujiao_bot_user(dujiaoka_user_id);

-- 发货队列索引
CREATE INDEX IF NOT EXISTS idx_delivery_order ON dujiao_bot_delivery_queue(order_id);
CREATE INDEX IF NOT EXISTS idx_delivery_status ON dujiao_bot_delivery_queue(status);
CREATE INDEX IF NOT EXISTS idx_delivery_telegram_id ON dujiao_bot_delivery_queue(telegram_user_id);

-- 客服会话索引
CREATE INDEX IF NOT EXISTS idx_chat_session_id ON dujiao_bot_chat_session(session_id);
CREATE INDEX IF NOT EXISTS idx_chat_session_status ON dujiao_bot_chat_session(status);
CREATE INDEX IF NOT EXISTS idx_chat_session_user ON dujiao_bot_chat_session(telegram_user_id);

-- 聊天消息索引
CREATE INDEX IF NOT EXISTS idx_chat_message_session ON dujiao_bot_chat_message(session_id);
CREATE INDEX IF NOT EXISTS idx_chat_message_created ON dujiao_bot_chat_message(created_at);

-- 日志索引
CREATE INDEX IF NOT EXISTS idx_bot_log_created ON dujiao_bot_log(created_at);
CREATE INDEX IF NOT EXISTS idx_bot_log_type ON dujiao_bot_log(log_type);
CREATE INDEX IF NOT EXISTS idx_bot_log_user ON dujiao_bot_log(user_id);

-- 自动回复索引
CREATE INDEX IF NOT EXISTS idx_auto_reply_keyword ON dujiao_bot_auto_reply(keyword);
CREATE INDEX IF NOT EXISTS idx_auto_reply_active ON dujiao_bot_auto_reply(is_active);

-- ============================================
-- 初始数据
-- ============================================

-- 插入默认配置
INSERT INTO dujiao_bot_config (config_key, config_value, config_type, config_group, config_label, sort_order) VALUES
('bot_name', 'Dujiao-Bot', 'string', 'general', 'Bot 名称', 1),
('bot_enabled', 'true', 'boolean', 'general', '启用 Bot', 2),
('auto_delivery', 'true', 'boolean', 'feature', '自动发货', 10),
('customer_service', 'true', 'boolean', 'feature', '客服功能', 11),
('notification', 'true', 'boolean', 'feature', '订单通知', 12),
('broadcast', 'true', 'boolean', 'feature', '广播功能', 13),
('order_tracking', 'true', 'boolean', 'feature', '订单追踪', 14),
('delivery_delay', '1000', 'number', 'delivery', '发货延迟(ms)', 20),
('delivery_max_attempts', '3', 'number', 'delivery', '最大重试次数', 21),
('cs_timeout', '30', 'number', 'customer_service', '会话超时(分钟)', 30),
('cs_max_concurrent', '100', 'number', 'customer_service', '最大并发会话', 31),
('low_stock_threshold', '10', 'number', 'notification', '库存预警阈值', 40),
('notify_new_order', 'true', 'boolean', 'notification', '新订单通知', 41),
('notify_payment', 'true', 'boolean', 'notification', '支付通知', 42),
('notify_delivery', 'true', 'boolean', 'notification', '发货通知', 43),
('notify_refund', 'true', 'boolean', 'notification', '退款通知', 44)
ON CONFLICT (config_key) DO NOTHING;

-- 插入默认自动回复
INSERT INTO dujiao_bot_auto_reply (keyword, match_type, response_type, response_content, priority) VALUES
('你好', 'contains', 'text', '你好！有什么可以帮助你的吗？', 10),
('帮助', 'exact', 'text', '发送 /help 查看所有可用命令', 10),
('人工', 'contains', 'text', '正在为您转接人工客服，请稍候...', 20),
('人工客服', 'contains', 'text', '正在为您转接人工客服，请稍候...', 20),
('谢谢', 'contains', 'text', '不客气！很高兴能帮到你 😊', 5),
('下单', 'contains', 'text', '请前往网站选择商品下单，网站地址请联系管理员获取', 5),
('充值', 'contains', 'text', '请前往网站充值，网站地址请联系管理员获取', 5)
ON CONFLICT DO NOTHING;
