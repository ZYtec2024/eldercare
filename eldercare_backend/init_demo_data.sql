-- ============================================================
-- 智慧伴老平台 - openGauss 完整建表 + 演示数据 SQL
-- 适用于 openGauss / PostgreSQL 数据库
-- 数据库名: elderly_care_system
-- ============================================================

-- Persist system timestamps in UTC; API responses convert them to Shanghai.
SET TIME ZONE 'UTC';
SET search_path TO public;

DROP TABLE IF EXISTS conversation_messages CASCADE;
DROP TABLE IF EXISTS conversation_members CASCADE;
DROP TABLE IF EXISTS conversations CASCADE;
DROP TABLE IF EXISTS emergency_notifications CASCADE;
DROP TABLE IF EXISTS emergency_incidents CASCADE;
DROP TABLE IF EXISTS volunteer_return_routes CASCADE;
DROP TABLE IF EXISTS dispatch_events CASCADE;
DROP TABLE IF EXISTS dispatch_routes CASCADE;
DROP TABLE IF EXISTS dispatch_candidates CASCADE;
DROP TABLE IF EXISTS dispatch_orders CASCADE;
DROP TABLE IF EXISTS volunteer_skill_tags CASCADE;
DROP TABLE IF EXISTS elder_addresses CASCADE;
DROP TABLE IF EXISTS elder_location_state CASCADE;
DROP TABLE IF EXISTS volunteer_location_state CASCADE;
DROP TABLE IF EXISTS admin_region_scope CASCADE;
DROP TABLE IF EXISTS administrative_regions CASCADE;
DROP TABLE IF EXISTS dispatch_system_state CASCADE;
DROP TABLE IF EXISTS donation_records CASCADE;
DROP TABLE IF EXISTS volunteer_award_requests CASCADE;
DROP TABLE IF EXISTS volunteer_hour_reviews CASCADE;
DROP TABLE IF EXISTS volunteer_likes CASCADE;
DROP TABLE IF EXISTS reviews CASCADE;
DROP TABLE IF EXISTS health_notice_reads CASCADE;
DROP TABLE IF EXISTS alerts CASCADE;
DROP TABLE IF EXISTS health_records CASCADE;
DROP TABLE IF EXISTS orders CASCADE;
DROP TABLE IF EXISTS user_elder_relation CASCADE;
DROP TABLE IF EXISTS volunteers_profile CASCADE;
DROP TABLE IF EXISTS elders CASCADE;
DROP TABLE IF EXISTS users CASCADE;
DROP TABLE IF EXISTS ai_service_settings CASCADE;
DROP TABLE IF EXISTS companion_chat_history CASCADE;
DROP TABLE IF EXISTS weekly_reports CASCADE;

-- 1. 用户总表
CREATE TABLE users (
    user_id SERIAL PRIMARY KEY,
    username VARCHAR(50) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL CHECK (role IN ('admin', 'family', 'volunteer', 'elder')),
    real_name VARCHAR(50) NOT NULL,
    phone VARCHAR(20) NOT NULL,
    email VARCHAR(100),
    credit_score INT DEFAULT 100,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. 老人档案表
CREATE TABLE elders (
    elder_id SERIAL PRIMARY KEY,
    user_id INT UNIQUE DEFAULT NULL,
    name VARCHAR(50) NOT NULL,
    age INT NOT NULL,
    gender VARCHAR(4) NOT NULL CHECK (gender IN ('男', '女')),
    address VARCHAR(255) NOT NULL,
    region_adcode VARCHAR(12) NOT NULL DEFAULT '310113',
    medical_history TEXT,
    alert_sys_threshold INT DEFAULT 140,
    personality_bio TEXT DEFAULT NULL,
    bio_updated_by INT DEFAULT NULL,
    bio_updated_at TIMESTAMP DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE SET NULL
);

-- 3. 志愿者档案表
CREATE TABLE volunteers_profile (
    profile_id SERIAL PRIMARY KEY,
    user_id INT NOT NULL UNIQUE,
    id_card VARCHAR(18) NOT NULL,
    skills VARCHAR(255) DEFAULT '热心群众',
    total_hours NUMERIC(10,2) DEFAULT 0,
    weekly_hours NUMERIC(10,2) DEFAULT 0,
    likes_count INT DEFAULT 0,
    awards TEXT,
    audit_status VARCHAR(20) DEFAULT 'pending' CHECK (audit_status IN ('pending', 'approved', 'rejected', 'pending_review')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

-- 4. 家属-老人关系表 (多对多)
CREATE TABLE user_elder_relation (
    id SERIAL PRIMARY KEY,
    family_user_id INT NOT NULL,
    elder_id INT NOT NULL,
    relation_type VARCHAR(50) DEFAULT '亲属',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (family_user_id) REFERENCES users(user_id) ON DELETE CASCADE,
    FOREIGN KEY (elder_id) REFERENCES elders(elder_id) ON DELETE CASCADE,
    UNIQUE (family_user_id, elder_id)
);

-- 5. 健康打卡记录表
CREATE TABLE health_records (
    record_id SERIAL PRIMARY KEY,
    elder_id INT NOT NULL,
    record_date DATE NOT NULL,
    blood_pressure_sys INT,
    blood_pressure_dia INT,
    heart_rate INT,
    blood_oxygen NUMERIC(5,2),
    blood_sugar NUMERIC(5,2),
    temperature NUMERIC(4,1),
    weight NUMERIC(5,1),
    notes VARCHAR(255),
    FOREIGN KEY (elder_id) REFERENCES elders(elder_id) ON DELETE CASCADE
);

-- 6. 服务订单表 (核心流转表)
CREATE TABLE orders (
    order_id SERIAL PRIMARY KEY,
    elder_id INT NOT NULL,
    created_by INT NOT NULL,
    volunteer_id INT DEFAULT NULL,
    service_type VARCHAR(50) NOT NULL,
    service_time TIMESTAMP NOT NULL,
    service_hours NUMERIC(8,2) DEFAULT 1,
    reward_points INT NOT NULL DEFAULT 0,
    address VARCHAR(255) DEFAULT NULL,
    region_adcode VARCHAR(12) NOT NULL DEFAULT '310113',
    -- Snapshot of service point at order create (dispatch must not follow elder GPS moves).
    service_lng NUMERIC(10,6),
    service_lat NUMERIC(10,6),
    proxy_created_by INT DEFAULT NULL,
    proxy_reason TEXT,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'in_progress', 'completed', 'cancelled')),
    arrived_at TIMESTAMP NULL,
    service_started_at TIMESTAMP NULL,
    service_ended_at TIMESTAMP NULL,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (elder_id) REFERENCES elders(elder_id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(user_id) ON DELETE CASCADE,
    FOREIGN KEY (volunteer_id) REFERENCES users(user_id) ON DELETE SET NULL
);

-- 登录安全审计：应用写入前会先对客户端 IP 脱敏。
CREATE TABLE login_audit_logs (
    audit_id SERIAL PRIMARY KEY,
    user_id INT NULL REFERENCES users(user_id) ON DELETE SET NULL,
    username VARCHAR(50) NOT NULL,
    role VARCHAR(20) NULL,
    masked_ip VARCHAR(64) NOT NULL,
    login_success BOOLEAN NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_login_audit_created_at ON login_audit_logs(created_at DESC);
CREATE INDEX idx_login_audit_username ON login_audit_logs(username, created_at DESC);

-- 7. 订单评价表
CREATE TABLE reviews (
    review_id SERIAL PRIMARY KEY,
    order_id INT NOT NULL UNIQUE,
    rating INT NOT NULL CHECK (rating >= 1 AND rating <= 5),
    comment TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (order_id) REFERENCES orders(order_id) ON DELETE CASCADE
);

-- 8. 紧急求助与健康报警表
CREATE TABLE alerts (
    alert_id SERIAL PRIMARY KEY,
    elder_id INT NOT NULL,
    alert_type VARCHAR(20) NOT NULL CHECK (alert_type IN ('sos', 'health_warning')),
    description VARCHAR(255) NOT NULL,
    is_handled BOOLEAN DEFAULT FALSE,
    emergency_incident_id INT DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (elder_id) REFERENCES elders(elder_id) ON DELETE CASCADE
);

-- 健康异常提醒按用户记录已读状态，避免一个人已读后影响其他家属。
CREATE TABLE health_notice_reads (
    user_id INT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    alert_id INT NOT NULL REFERENCES alerts(alert_id) ON DELETE CASCADE,
    read_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP NULL,
    PRIMARY KEY (user_id, alert_id)
);

-- 9. 志愿者点赞表
CREATE TABLE volunteer_likes (
    like_id SERIAL PRIMARY KEY,
    from_user_id INT NOT NULL,
    to_volunteer_id INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (from_user_id) REFERENCES users(user_id) ON DELETE CASCADE,
    FOREIGN KEY (to_volunteer_id) REFERENCES users(user_id) ON DELETE CASCADE,
    UNIQUE (from_user_id, to_volunteer_id)
);

-- 10. 志愿时长审核表
CREATE TABLE volunteer_hour_reviews (
    review_id SERIAL PRIMARY KEY,
    order_id INT NOT NULL UNIQUE,
    volunteer_id INT NOT NULL,
    expected_hours NUMERIC(8,2) NOT NULL,
    declared_hours NUMERIC(8,2) NOT NULL,
    max_auto_hours NUMERIC(8,2) NOT NULL,
    review_status VARCHAR(20) NOT NULL DEFAULT 'approved',
    approved_hours NUMERIC(8,2),
    review_note TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    reviewed_at TIMESTAMP NULL
);

-- 11. 志愿者荣誉申请表
CREATE TABLE volunteer_award_requests (
    request_id SERIAL PRIMARY KEY,
    volunteer_id INT NOT NULL,
    award_title VARCHAR(255) NOT NULL,
    reason TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    review_note TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    reviewed_at TIMESTAMP NULL,
    FOREIGN KEY (volunteer_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE TABLE ai_service_settings (
    config_key VARCHAR(64) PRIMARY KEY,
    config_value TEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE companion_chat_history (
    message_id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    role VARCHAR(16) NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_companion_chat_user ON companion_chat_history(user_id, created_at);

CREATE TABLE weekly_reports (
    report_id SERIAL PRIMARY KEY,
    elder_id INT NOT NULL,
    week_start DATE NOT NULL,
    week_end DATE NOT NULL,
    template_name VARCHAR(100),
    content TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'saved',
    generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (elder_id) REFERENCES elders(elder_id) ON DELETE CASCADE
);

-- 12. 爱心捐赠沙盘记录（仅模拟支付，不接入真实资金渠道）
CREATE TABLE donation_records (
    donation_id SERIAL PRIMARY KEY,
    donor_name VARCHAR(80) NOT NULL,
    contact VARCHAR(120),
    amount NUMERIC(10,2) NOT NULL CHECK (amount > 0),
    payment_method VARCHAR(20) NOT NULL CHECK (payment_method IN ('wechat', 'alipay')),
    payment_status VARCHAR(20) NOT NULL DEFAULT 'success',
    transaction_no VARCHAR(64) NOT NULL UNIQUE,
    message VARCHAR(500),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 13. 智能调度、区域权限、会话与定位运行时表
-- 按外键依赖顺序创建。Python 中的 ensure_dispatch_schema() 只负责
-- 老版本数据卷的幂等升级，空数据库不再依赖启动时临时补表。
CREATE TABLE dispatch_system_state (
    state_key VARCHAR(64) PRIMARY KEY,
    state_value VARCHAR(255) NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE administrative_regions (
    adcode VARCHAR(12) PRIMARY KEY,
    name VARCHAR(80) NOT NULL,
    city_name VARCHAR(80) NOT NULL,
    province_name VARCHAR(80),
    region_level VARCHAR(20) NOT NULL DEFAULT 'district',
    bounds_json TEXT NOT NULL,
    polygon_json TEXT,
    center_lng NUMERIC(10,6),
    center_lat NUMERIC(10,6),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE admin_region_scope (
    admin_user_id INT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    region_adcode VARCHAR(12) NOT NULL,
    permission VARCHAR(20) NOT NULL DEFAULT 'manage',
    PRIMARY KEY (admin_user_id, region_adcode)
);

CREATE TABLE volunteer_location_state (
    volunteer_id INT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
    lng NUMERIC(10,6) NOT NULL,
    lat NUMERIC(10,6) NOT NULL,
    availability VARCHAR(20) NOT NULL DEFAULT 'idle',
    fatigue_score INT NOT NULL DEFAULT 0 CHECK (fatigue_score BETWEEN 0 AND 100),
    service_rating NUMERIC(3,2) NOT NULL DEFAULT 4.50,
    assigned_today INT NOT NULL DEFAULT 0,
    location_source VARCHAR(24) NOT NULL DEFAULT 'simulated',
    home_lng NUMERIC(10,6),
    home_lat NUMERIC(10,6),
    auto_accept_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    return_started_at TIMESTAMP NULL,
    fatigue_updated_at TIMESTAMP NULL,
    service_region_adcode VARCHAR(12) NOT NULL DEFAULT '310113',
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE elder_location_state (
    elder_id INT PRIMARY KEY REFERENCES elders(elder_id) ON DELETE CASCADE,
    lng NUMERIC(10,6) NOT NULL,
    lat NUMERIC(10,6) NOT NULL,
    location_source VARCHAR(24) NOT NULL DEFAULT 'simulated',
    is_home_fixed BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE elder_addresses (
    address_id SERIAL PRIMARY KEY,
    elder_id INT NOT NULL REFERENCES elders(elder_id) ON DELETE CASCADE,
    label VARCHAR(40) NOT NULL DEFAULT '家',
    province_name VARCHAR(80) NOT NULL,
    city_name VARCHAR(80) NOT NULL,
    district_name VARCHAR(80) NOT NULL,
    region_adcode VARCHAR(12) NOT NULL,
    detail_address VARCHAR(255) NOT NULL,
    full_address VARCHAR(500) NOT NULL,
    lng NUMERIC(10,6) NOT NULL,
    lat NUMERIC(10,6) NOT NULL,
    is_current BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (elder_id, full_address)
);
CREATE UNIQUE INDEX uq_elder_current_address
    ON elder_addresses(elder_id) WHERE is_current = TRUE;

CREATE TABLE volunteer_skill_tags (
    volunteer_id INT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    skill_tag VARCHAR(64) NOT NULL,
    verified BOOLEAN NOT NULL DEFAULT TRUE,
    PRIMARY KEY (volunteer_id, skill_tag)
);

CREATE TABLE emergency_incidents (
    incident_id SERIAL PRIMARY KEY,
    elder_id INT NOT NULL REFERENCES elders(elder_id) ON DELETE CASCADE,
    region_adcode VARCHAR(12) NOT NULL,
    -- Snapshot of confirmed SOS service point (immutable after create).
    service_address TEXT,
    service_lng NUMERIC(10,6),
    service_lat NUMERIC(10,6),
    location_mode VARCHAR(16),
    incident_type VARCHAR(40) NOT NULL DEFAULT 'general_help',
    description TEXT NOT NULL DEFAULT '',
    status VARCHAR(24) NOT NULL DEFAULT 'reported',
    created_by INT NULL REFERENCES users(user_id) ON DELETE SET NULL,
    linked_order_id INT NULL REFERENCES orders(order_id) ON DELETE SET NULL,
    assigned_admin_id INT NULL REFERENCES users(user_id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    acknowledged_at TIMESTAMP NULL,
    acknowledged_by INT NULL REFERENCES users(user_id) ON DELETE SET NULL,
    resolved_at TIMESTAMP NULL,
    resolved_by INT NULL REFERENCES users(user_id) ON DELETE SET NULL,
    resolution_summary TEXT NULL
);
CREATE INDEX idx_alerts_emergency_incident ON alerts(emergency_incident_id);

-- 必须在任何回填、查询或清理 SQL 之前创建以下三张表。
CREATE TABLE emergency_notifications (
    notification_id SERIAL PRIMARY KEY,
    incident_id INT NOT NULL REFERENCES emergency_incidents(incident_id) ON DELETE CASCADE,
    recipient_user_id INT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    recipient_role VARCHAR(20) NOT NULL,
    notification_type VARCHAR(24) NOT NULL DEFAULT 'in_app',
    read_at TIMESTAMP NULL,
    acknowledged_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (incident_id, recipient_user_id, notification_type)
);

CREATE TABLE conversations (
    conversation_id SERIAL PRIMARY KEY,
    conversation_type VARCHAR(24) NOT NULL,
    elder_id INT NULL REFERENCES elders(elder_id) ON DELETE CASCADE,
    order_id INT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
    incident_id INT NULL REFERENCES emergency_incidents(incident_id) ON DELETE CASCADE,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    upgraded_to_sos BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    archived_at TIMESTAMP NULL
);

CREATE TABLE conversation_members (
    conversation_id INT NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
    user_id INT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    role_in_conversation VARCHAR(24) NOT NULL,
    last_read_at TIMESTAMP NULL,
    can_speak BOOLEAN NOT NULL DEFAULT TRUE,
    hidden_at TIMESTAMP NULL,
    PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE conversation_messages (
    message_id SERIAL PRIMARY KEY,
    conversation_id INT NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
    sender_user_id INT NULL REFERENCES users(user_id) ON DELETE SET NULL,
    message_type VARCHAR(24) NOT NULL DEFAULT 'text',
    content TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE dispatch_orders (
    order_id INT PRIMARY KEY REFERENCES orders(order_id) ON DELETE CASCADE,
    urgency VARCHAR(16) NOT NULL DEFAULT 'normal',
    required_skills TEXT NOT NULL,
    dispatch_state VARCHAR(24) NOT NULL DEFAULT 'matching',
    search_stage INT NOT NULL DEFAULT 1,
    dispatch_phase VARCHAR(24) NOT NULL DEFAULT 'top1',
    phase_started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    phase_expires_at TIMESTAMP NULL,
    dispatch_version INT NOT NULL DEFAULT 1,
    priority_tier INT NOT NULL DEFAULT 2,
    region_adcode VARCHAR(12) NOT NULL DEFAULT '310113',
    forced_assignment BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_expanded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE dispatch_candidates (
    candidate_id SERIAL PRIMARY KEY,
    order_id INT NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
    volunteer_id INT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    eligible BOOLEAN NOT NULL,
    skill_match TEXT NOT NULL,
    distance_km NUMERIC(8,2),
    eta_minutes INT,
    distance_score NUMERIC(8,2),
    traffic_score NUMERIC(8,2),
    fatigue_score NUMERIC(8,2),
    rating_score NUMERIC(8,2),
    total_score NUMERIC(8,2),
    candidate_rank INT,
    response_status VARCHAR(20) NOT NULL DEFAULT 'waiting',
    invited_at TIMESTAMP NULL,
    responded_at TIMESTAMP NULL,
    UNIQUE (order_id, volunteer_id)
);

CREATE TABLE dispatch_routes (
    order_id INT PRIMARY KEY REFERENCES orders(order_id) ON DELETE CASCADE,
    volunteer_id INT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    route_json TEXT NOT NULL,
    eta_minutes INT NOT NULL,
    traffic_version INT NOT NULL,
    replanned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE dispatch_events (
    event_id SERIAL PRIMARY KEY,
    order_id INT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
    event_type VARCHAR(40) NOT NULL,
    message VARCHAR(500) NOT NULL,
    details TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE volunteer_return_routes (
    volunteer_id INT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
    route_json TEXT NOT NULL,
    eta_minutes INT NOT NULL,
    traffic_version INT NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);


-- ============================================================
-- 第二部分：演示数据
-- ============================================================

-- 演示账号统一说明（仅用于本地演示，正式环境必须更换密码）：
--   总管理员：admin / admin123
--   下列家属、老人、志愿者账号：对应 username / pass123
--   区域管理员：admin_pudong、admin_chaoyang / Admin@2026
--   其余宝山、浦东、朝阳演示家属、老人、志愿者：对应 username / pass123
-- 全部 72 个初始账户均在本文件中声明；后端种子函数只为旧数据卷补缺。
-- 初始化文件仅保存带随机盐的 scrypt 哈希；注释中的密码仅用于本地演示登录。

-- ====== 总管理员 (user_id=1；登录账号 admin / admin123) ======
INSERT INTO users (username, password_hash, role, real_name, phone, email) VALUES
('admin', 'scrypt:32768:8:1$KcjCrYz0VJMVyYAd$0cd68d91411ce30ebd3b4952d54e970b4407ee2041d59ae87c40ac11388bf48c70e024f8ebffec862f524d1964fe953e050f354a3710183dc17ab057c85e0a17', 'admin', '系统管理员', '13000000001', 'admin@eldercare.com');

-- ====== 家属 (user_id=2~5) ======
INSERT INTO users (username, password_hash, role, real_name, phone, email) VALUES
('zhangsan', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'family', '张三', '13800138001', 'zhangsan@qq.com'),
('lisi_family', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'family', '李思', '13800138002', 'lisi@qq.com'),
('wangwu_family', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'family', '王五', '13800138003', 'wangwu@163.com'),
('zhaoliu_family', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'family', '赵六', '13800138004', 'zhaoliu@gmail.com');

-- ====== 老人 (user_id=6~10) ======
INSERT INTO users (username, password_hash, role, real_name, phone, email) VALUES
('elder_zhang', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'elder', '张大爷', '13900001001', 'zhangdaye@qq.com'),
('elder_li', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'elder', '李奶奶', '13900001002', 'linainai@qq.com'),
('elder_wang', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'elder', '王伯伯', '13900001003', 'wangbobo@qq.com'),
('elder_chen', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'elder', '陈阿姨', '13900001004', 'chenayi@qq.com'),
('elder_liu', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'elder', '刘爷爷', '13900001005', 'liuyeye@qq.com');

-- ====== 志愿者 (user_id=11~16) ======
INSERT INTO users (username, password_hash, role, real_name, phone, email) VALUES
('vol_wangjiaming', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'volunteer', '王佳明', '15000001001', 'wjm@volunteer.org'),
('vol_lizhiqiang', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'volunteer', '李志强', '15000001002', 'lzq@volunteer.org'),
('vol_chenxiaoyu', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'volunteer', '陈小宇', '15000001003', 'cxy@volunteer.org'),
('vol_zhoumin', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'volunteer', '周敏', '15000001004', 'zm@volunteer.org'),
('vol_sunhao', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'volunteer', '孙浩', '15000001005', 'sh@volunteer.org'),
('vol_huangxin', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'volunteer', '黄鑫', '15000001006', 'hx@volunteer.org');

-- ====== 宝山区调度沙盘补充账户 (user_id=17~38) ======
INSERT INTO users (username, password_hash, role, real_name, phone, email) VALUES
('sim_vol_07', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'volunteer', '调度志愿者07', '13990000107', 'sim_vol_07@dispatch.demo'),
('sim_vol_08', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'volunteer', '调度志愿者08', '13990000108', 'sim_vol_08@dispatch.demo'),
('sim_elder_06', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'elder', '宝山长者06', '13990000306', 'sim_elder_06@dispatch.demo'),
('sim_elder_07', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'elder', '宝山长者07', '13990000307', 'sim_elder_07@dispatch.demo'),
('sim_elder_08', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'elder', '宝山长者08', '13990000308', 'sim_elder_08@dispatch.demo'),
('sim_elder_09', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'elder', '宝山长者09', '13990000309', 'sim_elder_09@dispatch.demo'),
('sim_elder_10', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'elder', '宝山长者10', '13990000310', 'sim_elder_10@dispatch.demo'),
('sim_elder_11', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'elder', '宝山长者11', '13990000311', 'sim_elder_11@dispatch.demo'),
('sim_elder_12', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'elder', '宝山长者12', '13990000312', 'sim_elder_12@dispatch.demo'),
('sim_elder_13', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'elder', '宝山长者13', '13990000313', 'sim_elder_13@dispatch.demo'),
('sim_elder_14', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'elder', '宝山长者14', '13990000314', 'sim_elder_14@dispatch.demo'),
('sim_elder_15', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'elder', '宝山长者15', '13990000315', 'sim_elder_15@dispatch.demo'),
('sim_elder_16', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'elder', '宝山长者16', '13990000316', 'sim_elder_16@dispatch.demo'),
('sim_elder_17', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'elder', '宝山长者17', '13990000317', 'sim_elder_17@dispatch.demo'),
('sim_elder_18', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'elder', '宝山长者18', '13990000318', 'sim_elder_18@dispatch.demo'),
('sim_elder_19', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'elder', '宝山长者19', '13990000319', 'sim_elder_19@dispatch.demo'),
('sim_elder_20', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'elder', '宝山长者20', '13990000320', 'sim_elder_20@dispatch.demo'),
('sim_elder_21', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'elder', '宝山长者21', '13990000321', 'sim_elder_21@dispatch.demo'),
('sim_elder_22', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'elder', '宝山长者22', '13990000322', 'sim_elder_22@dispatch.demo'),
('sim_elder_23', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'elder', '宝山长者23', '13990000323', 'sim_elder_23@dispatch.demo'),
('sim_elder_24', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'elder', '宝山长者24', '13990000324', 'sim_elder_24@dispatch.demo'),
('sim_elder_25', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'elder', '宝山长者25', '13990000325', 'sim_elder_25@dispatch.demo');

-- ====== 浦东新区演示账户 (user_id=39~55) ======
INSERT INTO users (username, password_hash, role, real_name, phone, email) VALUES
('admin_pudong', 'scrypt:32768:8:1$FulRygLoFejJRQei$38c7e15312bda8cfc9897d1b5c5f4a467b7c74e8d9c33f2a1e0f5da8e38ae74b43dd8377aea2579da4d70ad1ca55fd50592dcad6d2aae76ce3687d372902fa1e', 'admin', '浦东新区管理员', '13990000115', 'admin_pudong@dispatch.demo'),
('demo_310115_vol_1', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'volunteer', '浦东志愿者李晨', '13990000116', 'demo_310115_vol_1@dispatch.demo'),
('demo_310115_vol_2', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'volunteer', '浦东志愿者王宁', '13990000117', 'demo_310115_vol_2@dispatch.demo'),
('demo_310115_vol_3', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'volunteer', '浦东志愿者陈悦', '13990000118', 'demo_310115_vol_3@dispatch.demo'),
('demo_310115_vol_4', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'volunteer', '浦东志愿者赵峰', '13990000119', 'demo_310115_vol_4@dispatch.demo'),
('demo_310115_elder_1', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'elder', '浦东张阿姨', '13990000216', 'demo_310115_elder_1@dispatch.demo'),
('demo_310115_family_1', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'family', '浦东张阿姨家属', '13990000316', 'demo_310115_family_1@dispatch.demo'),
('demo_310115_elder_2', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'elder', '浦东陈伯伯', '13990000217', 'demo_310115_elder_2@dispatch.demo'),
('demo_310115_family_2', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'family', '浦东陈伯伯家属', '13990000317', 'demo_310115_family_2@dispatch.demo'),
('demo_310115_elder_3', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'elder', '浦东李奶奶', '13990000218', 'demo_310115_elder_3@dispatch.demo'),
('demo_310115_family_3', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'family', '浦东李奶奶家属', '13990000318', 'demo_310115_family_3@dispatch.demo'),
('demo_310115_elder_4', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'elder', '浦东王大爷', '13990000219', 'demo_310115_elder_4@dispatch.demo'),
('demo_310115_family_4', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'family', '浦东王大爷家属', '13990000319', 'demo_310115_family_4@dispatch.demo'),
('demo_310115_elder_5', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'elder', '浦东周阿姨', '13990000220', 'demo_310115_elder_5@dispatch.demo'),
('demo_310115_family_5', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'family', '浦东周阿姨家属', '13990000320', 'demo_310115_family_5@dispatch.demo'),
('demo_310115_elder_6', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'elder', '浦东孙爷爷', '13990000221', 'demo_310115_elder_6@dispatch.demo'),
('demo_310115_family_6', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'family', '浦东孙爷爷家属', '13990000321', 'demo_310115_family_6@dispatch.demo');

-- ====== 北京市朝阳区演示账户 (user_id=56~72) ======
INSERT INTO users (username, password_hash, role, real_name, phone, email) VALUES
('admin_chaoyang', 'scrypt:32768:8:1$FulRygLoFejJRQei$38c7e15312bda8cfc9897d1b5c5f4a467b7c74e8d9c33f2a1e0f5da8e38ae74b43dd8377aea2579da4d70ad1ca55fd50592dcad6d2aae76ce3687d372902fa1e', 'admin', '朝阳区管理员', '13990000105', 'admin_chaoyang@dispatch.demo'),
('demo_110105_vol_1', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'volunteer', '朝阳志愿者刘洋', '13990000106', 'demo_110105_vol_1@dispatch.demo'),
('demo_110105_vol_2', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'volunteer', '朝阳志愿者周倩', '13990000107', 'demo_110105_vol_2@dispatch.demo'),
('demo_110105_vol_3', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'volunteer', '朝阳志愿者马强', '13990000108', 'demo_110105_vol_3@dispatch.demo'),
('demo_110105_vol_4', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'volunteer', '朝阳志愿者何静', '13990000109', 'demo_110105_vol_4@dispatch.demo'),
('demo_110105_elder_1', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'elder', '朝阳赵阿姨', '13990000206', 'demo_110105_elder_1@dispatch.demo'),
('demo_110105_family_1', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'family', '朝阳赵阿姨家属', '13990000306', 'demo_110105_family_1@dispatch.demo'),
('demo_110105_elder_2', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'elder', '朝阳刘伯伯', '13990000207', 'demo_110105_elder_2@dispatch.demo'),
('demo_110105_family_2', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'family', '朝阳刘伯伯家属', '13990000307', 'demo_110105_family_2@dispatch.demo'),
('demo_110105_elder_3', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'elder', '朝阳孙奶奶', '13990000208', 'demo_110105_elder_3@dispatch.demo'),
('demo_110105_family_3', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'family', '朝阳孙奶奶家属', '13990000308', 'demo_110105_family_3@dispatch.demo'),
('demo_110105_elder_4', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'elder', '朝阳吴大爷', '13990000209', 'demo_110105_elder_4@dispatch.demo'),
('demo_110105_family_4', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'family', '朝阳吴大爷家属', '13990000309', 'demo_110105_family_4@dispatch.demo'),
('demo_110105_elder_5', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'elder', '朝阳钱阿姨', '13990000210', 'demo_110105_elder_5@dispatch.demo'),
('demo_110105_family_5', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'family', '朝阳钱阿姨家属', '13990000310', 'demo_110105_family_5@dispatch.demo'),
('demo_110105_elder_6', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'elder', '朝阳冯爷爷', '13990000211', 'demo_110105_elder_6@dispatch.demo'),
('demo_110105_family_6', 'scrypt:32768:8:1$Z5ianuRFoBYp6lSh$b083e4b5881f8d9cc3cb333303cff9425be271133673ccd6b270e2a980ebffcbcc2e9425465b196d13e77913bae8c25a0df77f2c49d25b7878763bbdd964079d', 'family', '朝阳冯爷爷家属', '13990000311', 'demo_110105_family_6@dispatch.demo');

-- ====== 老人档案 (elder_id=1~5) ======
INSERT INTO elders (user_id, name, age, gender, address, medical_history, alert_sys_threshold) VALUES
(6,  '张大爷', 78, '男', '上海市宝山区锦秋路699弄112号1号楼101室', '高血压病史10年，长期服用降压药', 140),
(7,  '李奶奶', 82, '女', '上海市宝山区殷高路21弄5号1号楼102室', '糖尿病II型，骨质疏松，需定期复查血糖', 135),
(8,  '王伯伯', 75, '男', '上海市宝山区新二路183弄57号1号楼103室', '冠心病，安装过心脏支架，需避免剧烈运动', 130),
(9,  '陈阿姨', 70, '女', '上海市宝山区国权北路828弄139号1号楼104室', '轻度认知障碍，偶有健忘，身体状况总体良好', 140),
(10, '刘爷爷', 85, '男', '上海市宝山区盘古路528号1号楼201室', '帕金森病早期，行动不便需要助行器，听力下降', 140);

-- 示例：为前 3 位老人补充性格简介（由家属填写）
UPDATE elders SET personality_bio = '张大爷以前是语文老师，喜欢京剧和下象棋，性格要强，平时喜欢别人叫他张老师。', bio_updated_by = 2, bio_updated_at = NOW() WHERE elder_id = 1;
UPDATE elders SET personality_bio = '文静内向，喜欢听戏曲和养花。对陌生人比较警惕，需要耐心沟通建立信任。', bio_updated_by = 2, bio_updated_at = NOW() WHERE elder_id = 2;
UPDATE elders SET personality_bio = '幽默风趣，曾是工程师，喜欢聊科技话题。行动不便但思维清晰，自尊心强。', bio_updated_by = 3, bio_updated_at = NOW() WHERE elder_id = 3;

-- ====== 宝山区调度沙盘老人档案 (elder_id=6~25) ======
INSERT INTO elders
    (user_id, name, age, gender, address, medical_history, alert_sys_threshold, region_adcode)
VALUES
(19, '宝山长者06', 74, '男', '上海市宝山区殷高路21弄1号楼202室', '智能调度模拟档案', 140, '310113'),
(20, '宝山长者07', 75, '女', '上海市宝山区高境路477弄1号楼203室', '智能调度模拟档案', 140, '310113'),
(21, '宝山长者08', 76, '男', '上海市宝山区新二路999弄1号楼204室', '智能调度模拟档案', 140, '310113'),
(22, '宝山长者09', 77, '女', '上海市宝山区逸仙路1321弄2号楼301室', '智能调度模拟档案', 140, '310113'),
(23, '宝山长者10', 78, '男', '上海市宝山区三门路489弄2号楼302室', '智能调度模拟档案', 140, '310113'),
(24, '宝山长者11', 79, '女', '上海市宝山区国权北路828弄2号楼303室', '智能调度模拟档案', 140, '310113'),
(25, '宝山长者12', 80, '男', '上海市宝山区盘古路528号2号楼304室', '智能调度模拟档案', 140, '310113'),
(26, '宝山长者13', 81, '女', '上海市宝山区锦秋路699弄2号楼401室', '智能调度模拟档案', 140, '310113'),
(27, '宝山长者14', 82, '男', '上海市宝山区纬地路88弄2号楼402室', '智能调度模拟档案', 140, '310113'),
(28, '宝山长者15', 83, '女', '上海市宝山区聚丰园路628弄2号楼403室', '智能调度模拟档案', 140, '310113'),
(29, '宝山长者16', 84, '男', '上海市宝山区真金路1039弄2号楼404室', '智能调度模拟档案', 140, '310113'),
(30, '宝山长者17', 85, '女', '上海市宝山区华灵路1885弄3号楼501室', '智能调度模拟档案', 140, '310113'),
(31, '宝山长者18', 86, '男', '上海市宝山区殷高路21弄3号楼502室', '智能调度模拟档案', 140, '310113'),
(32, '宝山长者19', 87, '女', '上海市宝山区高境路477弄3号楼503室', '智能调度模拟档案', 140, '310113'),
(33, '宝山长者20', 88, '男', '上海市宝山区新二路999弄3号楼504室', '智能调度模拟档案', 140, '310113'),
(34, '宝山长者21', 89, '女', '上海市宝山区逸仙路1321弄3号楼601室', '智能调度模拟档案', 140, '310113'),
(35, '宝山长者22', 68, '男', '上海市宝山区三门路489弄3号楼602室', '智能调度模拟档案', 140, '310113'),
(36, '宝山长者23', 69, '女', '上海市宝山区国权北路828弄3号楼603室', '智能调度模拟档案', 140, '310113'),
(37, '宝山长者24', 70, '男', '上海市宝山区盘古路528号3号楼604室', '智能调度模拟档案', 140, '310113'),
(38, '宝山长者25', 71, '女', '上海市宝山区锦秋路699弄4号楼701室', '智能调度模拟档案', 140, '310113');

-- ====== 浦东新区与朝阳区老人档案 (elder_id=26~37) ======
INSERT INTO elders
    (user_id, name, age, gender, address, medical_history, alert_sys_threshold, region_adcode)
VALUES
(44, '浦东张阿姨', 69, '女', '上海市浦东新区张江路665号1号楼101室', '区域调度演示档案', 140, '310115'),
(46, '浦东陈伯伯', 70, '男', '上海市浦东新区祖冲之路2305号1号楼102室', '区域调度演示档案', 140, '310115'),
(48, '浦东李奶奶', 71, '女', '上海市浦东新区金科路2889号1号楼103室', '区域调度演示档案', 140, '310115'),
(50, '浦东王大爷', 72, '男', '上海市浦东新区世纪大道100号1号楼104室', '区域调度演示档案', 140, '310115'),
(52, '浦东周阿姨', 73, '女', '上海市浦东新区杨高南路729号1号楼201室', '区域调度演示档案', 140, '310115'),
(54, '浦东孙爷爷', 74, '男', '上海市浦东新区浦东南路1111号1号楼202室', '区域调度演示档案', 140, '310115'),
(61, '朝阳赵阿姨', 69, '女', '北京市朝阳区望京街10号1号楼101室', '区域调度演示档案', 140, '110105'),
(63, '朝阳刘伯伯', 70, '男', '北京市朝阳区阜通东大街6号1号楼102室', '区域调度演示档案', 140, '110105'),
(65, '朝阳孙奶奶', 71, '女', '北京市朝阳区朝阳北路101号1号楼103室', '区域调度演示档案', 140, '110105'),
(67, '朝阳吴大爷', 72, '男', '北京市朝阳区建国路93号1号楼104室', '区域调度演示档案', 140, '110105'),
(69, '朝阳钱阿姨', 73, '女', '北京市朝阳区酒仙桥路10号1号楼201室', '区域调度演示档案', 140, '110105'),
(71, '朝阳冯爷爷', 74, '男', '北京市朝阳区北苑路170号1号楼202室', '区域调度演示档案', 140, '110105');

-- ====== 志愿者档案 ======
INSERT INTO volunteers_profile (user_id, id_card, skills, total_hours, weekly_hours, likes_count, awards, audit_status) VALUES
(11, '310101199501011234', '急救培训证书；擅长陪聊散步；有驾照可陪同就医', 156.5, 12.5, 48, '2025年度社区服务之星；最佳志愿者奖', 'approved'),
(12, '310101199602022345', '护理专业背景；擅长健康指导和康复训练', 128.0, 8.0, 35, '优秀志愿者称号', 'approved'),
(13, '310101199803033456', '大学生志愿者；擅长教老人使用智能手机', 89.5, 6.5, 22, '', 'approved'),
(14, '310101199704044567', '社工专业；心理咨询师资格；擅长情感陪伴', 67.0, 4.0, 18, '', 'approved'),
(15, '310101200005055678', '体育专业；擅长带领老人做健身操', 45.0, 3.0, 12, '', 'approved'),
(16, '310101200106066789', '医学院在读；可提供基础健康咨询', 0.0, 0.0, 0, '', 'pending');

INSERT INTO volunteers_profile
    (user_id, id_card, skills, total_hours, weekly_hours, likes_count, awards, audit_status)
VALUES
(17, '310113199007000017', '智能调度模拟志愿者', 0, 0, 0, '', 'approved'),
(18, '310113199008000018', '智能调度模拟志愿者', 0, 0, 0, '', 'approved'),
(40, '310115199201000040', '区域智能调度演示志愿者', 0, 0, 0, '', 'approved'),
(41, '310115199202000041', '区域智能调度演示志愿者', 0, 0, 0, '', 'approved'),
(42, '310115199203000042', '区域智能调度演示志愿者', 0, 0, 0, '', 'approved'),
(43, '310115199204000043', '区域智能调度演示志愿者', 0, 0, 0, '', 'approved'),
(57, '110105199201000057', '区域智能调度演示志愿者', 0, 0, 0, '', 'approved'),
(58, '110105199202000058', '区域智能调度演示志愿者', 0, 0, 0, '', 'approved'),
(59, '110105199203000059', '区域智能调度演示志愿者', 0, 0, 0, '', 'approved'),
(60, '110105199204000060', '区域智能调度演示志愿者', 0, 0, 0, '', 'approved');

-- ====== 家属-老人绑定关系 ======
INSERT INTO user_elder_relation (family_user_id, elder_id, relation_type) VALUES
(2, 1, '父子'),
(2, 2, '母子'),
(3, 2, '女儿'),
(3, 3, '儿媳'),
(4, 4, '女儿'),
(5, 5, '孙子');

INSERT INTO user_elder_relation (family_user_id, elder_id, relation_type) VALUES
(45, 26, '子女'),
(47, 27, '子女'),
(49, 28, '子女'),
(51, 29, '子女'),
(53, 30, '子女'),
(55, 31, '子女'),
(62, 32, '子女'),
(64, 33, '子女'),
(66, 34, '子女'),
(68, 35, '子女'),
(70, 36, '子女'),
(72, 37, '子女');

-- ====== 核心运行时状态（保证只执行 init SQL 也能直接使用） ======
INSERT INTO dispatch_system_state (state_key, state_value) VALUES
('traffic_version', '1');

INSERT INTO ai_service_settings (config_key, config_value) VALUES
('groq_chat_model', 'llama-3.1-8b-instant'),
('groq_transcribe_model', 'whisper-large-v3'),
('transcribe_provider', 'groq'),
('tencent_asr_region', 'ap-shanghai'),
('tencent_asr_engine_model_type', '16k_zh'),
('tts_voice', 'zh-CN-XiaoxiaoNeural'),
('tts_rate', '+0%'),
('tts_volume', '+0%'),
('companion_system_prompt', '你是智慧伴老平台的智能陪聊助手。请用亲切、耐心、简洁的中文与老人交流。优先关心情绪、健康和安全，不要输出夸张或不现实的承诺。如果涉及紧急医疗风险，请明确提醒老人立即联系家属、志愿者或拨打当地急救电话。严禁输出任何推广、广告、打赏、订阅、点赞请求，严禁输出歌词、作词作曲等娱乐元数据，严禁输出链接。');

INSERT INTO administrative_regions
    (adcode, name, city_name, province_name, region_level, bounds_json, polygon_json, center_lng, center_lat)
VALUES
('310113', '宝山区', '上海市', '上海市', 'district',
 '{"west":121.405,"east":121.535,"south":31.325,"north":31.455}', NULL, 121.458000, 31.382000),
('310115', '浦东新区', '上海市', '上海市', 'district',
 '{"west":121.500,"east":121.700,"south":31.120,"north":31.320}', NULL, 121.572000, 31.218000),
('110105', '朝阳区', '北京市', '北京市', 'district',
 '{"west":116.370,"east":116.560,"south":39.820,"north":40.060}', NULL, 116.472000, 39.943000);

INSERT INTO admin_region_scope (admin_user_id, region_adcode, permission) VALUES
(1, '*', 'manage'),
(39, '310115', 'manage'),
(56, '110105', 'manage');

INSERT INTO elder_location_state
    (elder_id, lng, lat, location_source, is_home_fixed)
VALUES
(1, 121.483901, 31.380686, 'simulated', TRUE),
(2, 121.468575, 31.395776, 'simulated', TRUE),
(3, 121.438985, 31.392285, 'simulated', TRUE),
(4, 121.435043, 31.374920, 'simulated', TRUE),
(5, 121.462067, 31.367106, 'simulated', TRUE),
(6, 121.483605, 31.379381, 'simulated', TRUE),
(7, 121.470605, 31.395189, 'simulated', TRUE),
(8, 121.440603, 31.393207, 'simulated', TRUE),
(9, 121.434067, 31.376108, 'simulated', TRUE),
(10, 121.459814, 31.366957, 'simulated', TRUE),
(11, 121.483114, 31.378097, 'simulated', TRUE),
(12, 121.472539, 31.394502, 'simulated', TRUE),
(13, 121.415977, 31.392852, 'simulated', TRUE),
(14, 121.426628, 31.362487, 'simulated', TRUE),
(15, 121.479596, 31.358443, 'simulated', TRUE),
(16, 121.503434, 31.386174, 'simulated', TRUE),
(17, 121.465988, 31.408275, 'simulated', TRUE),
(18, 121.417767, 31.394935, 'simulated', TRUE),
(19, 121.423815, 31.364148, 'simulated', TRUE),
(20, 121.475974, 31.357441, 'simulated', TRUE),
(21, 121.508320, 31.400953, 'simulated', TRUE),
(22, 121.443485, 31.415766, 'simulated', TRUE),
(23, 121.402000, 31.385033, 'simulated', TRUE),
(24, 121.433596, 31.350209, 'simulated', TRUE),
(25, 121.501881, 31.358266, 'simulated', TRUE),
(26, 121.562149, 31.227078, 'simulated', TRUE),
(27, 121.550750, 31.213900, 'simulated', TRUE),
(28, 121.570608, 31.210870, 'simulated', TRUE),
(29, 121.585715, 31.212067, 'simulated', TRUE),
(30, 121.589798, 31.227311, 'simulated', TRUE),
(31, 121.569750, 31.225015, 'simulated', TRUE),
(32, 116.462149, 39.952078, 'simulated', TRUE),
(33, 116.450750, 39.938900, 'simulated', TRUE),
(34, 116.470608, 39.935870, 'simulated', TRUE),
(35, 116.485715, 39.937067, 'simulated', TRUE),
(36, 116.489798, 39.952311, 'simulated', TRUE),
(37, 116.469750, 39.950015, 'simulated', TRUE);

-- 正式版中初始实时位置来自当前默认地址，不属于自动模拟位置。
UPDATE elder_location_state SET location_source = 'address_book';

INSERT INTO elder_addresses
    (elder_id, label, province_name, city_name, district_name, region_adcode,
     detail_address, full_address, lng, lat, is_current)
VALUES
(1, '家', '上海市', '上海市', '宝山区', '310113',
 '锦秋路699弄112号1号楼101室', '上海市宝山区锦秋路699弄112号1号楼101室',
 121.483901, 31.380686, TRUE),
(2, '家', '上海市', '上海市', '宝山区', '310113',
 '殷高路21弄5号1号楼102室', '上海市宝山区殷高路21弄5号1号楼102室',
 121.468575, 31.395776, TRUE),
(3, '家', '上海市', '上海市', '宝山区', '310113',
 '新二路183弄57号1号楼103室', '上海市宝山区新二路183弄57号1号楼103室',
 121.438985, 31.392285, TRUE),
(4, '家', '上海市', '上海市', '宝山区', '310113',
 '国权北路828弄139号1号楼104室', '上海市宝山区国权北路828弄139号1号楼104室',
 121.435043, 31.374920, TRUE),
(5, '家', '上海市', '上海市', '宝山区', '310113',
 '盘古路528号1号楼201室', '上海市宝山区盘古路528号1号楼201室',
 121.462067, 31.367106, TRUE);

INSERT INTO elder_addresses
    (elder_id, label, province_name, city_name, district_name, region_adcode,
     detail_address, full_address, lng, lat, is_current)
SELECT
    e.elder_id,
    '家',
    CASE WHEN e.region_adcode = '110105' THEN '北京市' ELSE '上海市' END,
    CASE WHEN e.region_adcode = '110105' THEN '北京市' ELSE '上海市' END,
    CASE
        WHEN e.region_adcode = '310115' THEN '浦东新区'
        WHEN e.region_adcode = '110105' THEN '朝阳区'
        ELSE '宝山区'
    END,
    e.region_adcode,
    e.address,
    e.address,
    p.lng,
    p.lat,
    TRUE
FROM elders e
JOIN elder_location_state p ON p.elder_id = e.elder_id
WHERE e.elder_id BETWEEN 6 AND 37;

INSERT INTO volunteer_location_state
    (volunteer_id, lng, lat, availability, fatigue_score, service_rating,
     assigned_today, location_source, home_lng, home_lat, auto_accept_enabled,
     service_region_adcode)
VALUES
(11, 121.405500, 31.325500, 'idle', 12, 4.90, 0, 'simulated', 121.406500, 31.326500, FALSE, '310113'),
(12, 121.411000, 31.326000, 'idle', 18, 4.80, 0, 'simulated', 121.412000, 31.327000, FALSE, '310113'),
(13, 121.437512, 31.391284, 'idle', 10, 4.70, 0, 'simulated', 121.479596, 31.358443, FALSE, '310113'),
(14, 121.436195, 31.373787, 'idle', 15, 4.75, 0, 'simulated', 121.503434, 31.386174, FALSE, '310113'),
(15, 121.464290, 31.367368, 'idle', 8, 4.65, 0, 'simulated', 121.465988, 31.408275, FALSE, '310113'),
(16, 121.407500, 31.329000, 'idle', 0, 4.50, 0, 'simulated', 121.408500, 31.330000, FALSE, '310113'),
(17, 121.453991, 31.408578, 'idle', 10, 4.81, 2, 'simulated', 121.438466, 31.349096, FALSE, '310113'),
(18, 121.402000, 31.372993, 'idle', 19, 4.15, 3, 'simulated', 121.505281, 31.360575, FALSE, '310113'),
-- Demo volunteers default auto_accept OFF; they must toggle it in the volunteer UI.
(40, 121.573116, 31.229492, 'idle', 5, 4.60, 0, 'simulated', 121.577592, 31.212031, FALSE, '310115'),
(41, 121.552398, 31.225191, 'idle', 10, 4.70, 0, 'simulated', 121.587706, 31.220198, FALSE, '310115'),
(42, 121.564340, 31.213372, 'idle', 15, 4.50, 0, 'simulated', 121.576574, 31.233494, FALSE, '310115'),
(43, 121.576678, 31.206983, 'idle', 20, 4.60, 0, 'simulated', 121.563808, 31.222130, FALSE, '310115'),
(57, 116.473116, 39.954492, 'idle', 5, 4.60, 0, 'simulated', 116.477592, 39.937031, FALSE, '110105'),
(58, 116.452398, 39.950191, 'idle', 10, 4.70, 0, 'simulated', 116.487706, 39.945198, FALSE, '110105'),
(59, 116.464340, 39.938372, 'idle', 15, 4.50, 0, 'simulated', 116.476574, 39.958494, FALSE, '110105'),
(60, 116.476678, 39.931983, 'idle', 20, 4.60, 0, 'simulated', 116.463808, 39.947130, FALSE, '110105');

INSERT INTO volunteer_skill_tags (volunteer_id, skill_tag, verified) VALUES
(11, '陪诊', TRUE),
(11, '急救', TRUE),
(11, '陪伴', TRUE),
(12, '健康指导', TRUE),
(12, '康复训练', TRUE),
(13, '智能设备指导', TRUE),
(14, '心理陪伴', TRUE),
(15, '运动康复', TRUE);

-- 调度匹配使用的标准技能编码
INSERT INTO volunteer_skill_tags (volunteer_id, skill_tag, verified) VALUES
(11, 'medical_support', TRUE),
(11, 'emergency_response', TRUE),
(11, 'mobility_assist', TRUE),
(11, 'errand', TRUE),
(12, 'medical_support', TRUE),
(12, 'rehab', TRUE),
(12, 'mobility_assist', TRUE),
(13, 'digital_assist', TRUE),
(13, 'companion', TRUE),
(13, 'errand', TRUE),
(14, 'companion', TRUE),
(14, 'rehab', TRUE),
(14, 'mobility_assist', TRUE),
(15, 'grooming', TRUE),
(15, 'companion', TRUE),
(15, 'errand', TRUE),
(16, 'medical_support', TRUE),
(16, 'emergency_response', TRUE),
(16, 'errand', TRUE),
(17, 'digital_assist', TRUE),
(17, 'companion', TRUE),
(18, 'rehab', TRUE),
(18, 'mobility_assist', TRUE),
(18, 'companion', TRUE),
(40, 'medical_support', TRUE),
(40, 'emergency_response', TRUE),
(40, 'errand', TRUE),
(41, 'companion', TRUE),
(41, 'rehab', TRUE),
(41, 'mobility_assist', TRUE),
(42, 'digital_assist', TRUE),
(42, 'errand', TRUE),
(42, 'companion', TRUE),
(43, 'medical_support', TRUE),
(43, 'emergency_response', TRUE),
(43, 'mobility_assist', TRUE),
(57, 'medical_support', TRUE),
(57, 'emergency_response', TRUE),
(57, 'mobility_assist', TRUE),
(58, 'companion', TRUE),
(58, 'errand', TRUE),
(58, 'digital_assist', TRUE),
(59, 'medical_support', TRUE),
(59, 'rehab', TRUE),
(59, 'errand', TRUE),
(60, 'emergency_response', TRUE),
(60, 'companion', TRUE),
(60, 'mobility_assist', TRUE);

-- ====== 张大爷 7天健康打卡数据 ======
INSERT INTO health_records (elder_id, record_date, blood_pressure_sys, blood_pressure_dia, heart_rate, blood_oxygen, blood_sugar, temperature, weight, notes) VALUES
(1, '2026-04-08', 132, 82, 72, 97.5, 5.8, 36.4, 68.5, '今天精神不错，散步30分钟'),
(1, '2026-04-09', 128, 80, 70, 98.0, 5.6, 36.3, 68.5, '睡眠质量好'),
(1, '2026-04-10', 135, 85, 75, 97.0, 6.0, 36.5, 68.0, '有点头晕，下午休息了'),
(1, '2026-04-11', 138, 88, 78, 96.5, 5.9, 36.6, 68.0, '血压偏高，已加药'),
(1, '2026-04-12', 142, 90, 80, 96.0, 6.2, 36.4, 68.5, '血压仍然偏高，需要关注'),
(1, '2026-04-13', 136, 84, 74, 97.5, 5.7, 36.3, 68.5, '血压有所回落'),
(1, '2026-04-14', 130, 80, 71, 98.0, 5.5, 36.4, 68.5, '恢复正常，心情愉快');

-- ====== 李奶奶 7天健康打卡数据 ======
INSERT INTO health_records (elder_id, record_date, blood_pressure_sys, blood_pressure_dia, heart_rate, blood_oxygen, blood_sugar, temperature, weight, notes) VALUES
(2, '2026-04-08', 125, 78, 68, 97.0, 7.2, 36.5, 55.0, '血糖偏高，注意饮食'),
(2, '2026-04-09', 122, 76, 66, 97.5, 6.8, 36.4, 55.0, '控制了甜食摄入'),
(2, '2026-04-10', 120, 75, 65, 98.0, 6.5, 36.3, 55.5, '血糖有所下降'),
(2, '2026-04-11', 118, 74, 67, 97.5, 6.3, 36.4, 55.0, '状态良好'),
(2, '2026-04-12', 124, 77, 70, 97.0, 7.0, 36.5, 55.0, '昨晚没睡好'),
(2, '2026-04-13', 121, 75, 66, 97.5, 6.6, 36.4, 55.5, '恢复正常作息'),
(2, '2026-04-14', 119, 74, 65, 98.0, 6.4, 36.3, 55.0, '整体状态不错');

-- ====== 王伯伯 7天健康打卡数据 ======
INSERT INTO health_records (elder_id, record_date, blood_pressure_sys, blood_pressure_dia, heart_rate, blood_oxygen, blood_sugar, temperature, weight, notes) VALUES
(3, '2026-04-08', 126, 80, 62, 96.5, 5.4, 36.5, 72.0, '心率偏低，注意观察'),
(3, '2026-04-09', 128, 82, 64, 96.0, 5.5, 36.4, 72.0, '按时服药'),
(3, '2026-04-10', 130, 83, 65, 96.5, 5.6, 36.5, 72.5, '今天走了2000步'),
(3, '2026-04-11', 125, 79, 63, 97.0, 5.3, 36.3, 72.0, '休息充足'),
(3, '2026-04-12', 127, 81, 64, 96.5, 5.5, 36.4, 72.0, '状态平稳'),
(3, '2026-04-13', 129, 82, 66, 96.0, 5.7, 36.5, 72.5, '天气好出门晒太阳'),
(3, '2026-04-14', 124, 78, 63, 97.0, 5.4, 36.4, 72.0, '一切正常');

-- ====== 陈阿姨 7天健康打卡数据 ======
INSERT INTO health_records (elder_id, record_date, blood_pressure_sys, blood_pressure_dia, heart_rate, blood_oxygen, blood_sugar, temperature, weight, notes) VALUES
(4, '2026-04-08', 118, 72, 70, 98.0, 5.2, 36.3, 58.0, '身体状况良好'),
(4, '2026-04-09', 120, 74, 72, 98.0, 5.3, 36.4, 58.0, '今天记忆力不错'),
(4, '2026-04-10', 116, 70, 68, 98.5, 5.1, 36.3, 58.5, '做了记忆训练游戏'),
(4, '2026-04-11', 119, 73, 71, 98.0, 5.4, 36.4, 58.0, '和邻居聊天很开心'),
(4, '2026-04-12', 122, 75, 73, 97.5, 5.5, 36.5, 58.0, '有点忘记吃药'),
(4, '2026-04-13', 117, 71, 69, 98.0, 5.2, 36.3, 58.5, '女儿来看望了'),
(4, '2026-04-14', 115, 70, 68, 98.5, 5.0, 36.3, 58.0, '心情很好');

-- ====== 刘爷爷 7天健康打卡数据 ======
INSERT INTO health_records (elder_id, record_date, blood_pressure_sys, blood_pressure_dia, heart_rate, blood_oxygen, blood_sugar, temperature, weight, notes) VALUES
(5, '2026-04-08', 140, 88, 76, 95.5, 5.8, 36.6, 65.0, '手抖比较明显'),
(5, '2026-04-09', 138, 86, 74, 96.0, 5.6, 36.5, 65.0, '服药后有所缓解'),
(5, '2026-04-10', 145, 92, 80, 95.0, 6.0, 36.7, 65.5, '血压偏高，需要注意'),
(5, '2026-04-11', 142, 90, 78, 95.5, 5.9, 36.6, 65.0, '今天走路不太稳'),
(5, '2026-04-12', 136, 84, 73, 96.5, 5.5, 36.4, 65.0, '状态有所好转'),
(5, '2026-04-13', 134, 82, 72, 96.5, 5.4, 36.4, 65.5, '孙子来陪了一天'),
(5, '2026-04-14', 132, 80, 70, 97.0, 5.3, 36.3, 65.0, '精神状态不错');

-- ====== 已完成的订单 (order_id=1~6) ======
INSERT INTO orders (elder_id, created_by, volunteer_id, service_type, service_time, service_hours, address, status, notes, created_at) VALUES
(1, 2, 11, '陪同就医', '2026-04-05 09:00:00', 3, '上海市宝山区锦秋路699弄112号1号楼101室', 'completed', '张大爷需要去社区医院复查血压', '2026-04-03 10:00:00'),
(2, 3, 12, '上门打扫', '2026-04-06 14:00:00', 2, '上海市宝山区殷高路21弄5号1号楼102室', 'completed', '李奶奶家需要打扫卫生', '2026-04-04 09:00:00'),
(3, 3, 11, '代买代办', '2026-04-07 10:00:00', 1, '上海市宝山区新二路183弄57号1号楼103室', 'completed', '帮王伯伯去药店买降压药', '2026-04-05 15:00:00'),
(4, 4, 13, '陪聊散步', '2026-04-08 16:00:00', 2, '上海市宝山区国权北路828弄139号1号楼104室', 'completed', '陈阿姨想去公园散步', '2026-04-06 11:00:00'),
(1, 2, 14, '健康指导', '2026-04-09 10:00:00', 1.5, '上海市宝山区锦秋路699弄112号1号楼101室', 'completed', '教张大爷使用血压计自测', '2026-04-07 08:00:00'),
(5, 5, 12, '陪同就医', '2026-04-10 08:30:00', 4, '上海市宝山区盘古路528号1号楼201室', 'completed', '刘爷爷需要去三甲医院做帕金森复查', '2026-04-08 14:00:00');

-- ====== 进行中的订单 (order_id=7~8) ======
INSERT INTO orders (elder_id, created_by, volunteer_id, service_type, service_time, service_hours, address, status, notes, created_at) VALUES
(2, 2, 11, '康复训练', '2026-04-15 09:00:00', 2, '上海市宝山区殷高路21弄5号1号楼102室', 'in_progress', '李奶奶需要做腿部康复训练', '2026-04-13 10:00:00'),
(5, 5, 15, '陪聊散步', '2026-04-15 15:00:00', 1.5, '上海市宝山区盘古路528号1号楼201室', 'accepted', '刘爷爷想在小区花园散步', '2026-04-13 16:00:00');

-- ====== 待接单的订单 (order_id=9~13) ======
INSERT INTO orders (elder_id, created_by, service_type, service_time, service_hours, address, status, notes, created_at) VALUES
(1, 2, '代买代办', '2026-04-16 10:00:00', 1, '上海市宝山区锦秋路699弄112号1号楼101室', 'pending', '帮张大爷去超市买米面油和日用品', '2026-04-14 09:00:00'),
(3, 3, '上门打扫', '2026-04-17 14:00:00', 3, '上海市宝山区新二路183弄57号1号楼103室', 'pending', '王伯伯家大扫除', '2026-04-14 11:00:00'),
(4, 4, '健康指导', '2026-04-18 09:00:00', 1, '上海市宝山区国权北路828弄139号1号楼104室', 'pending', '教陈阿姨做记忆力训练游戏', '2026-04-14 14:00:00'),
(2, 3, '陪同就医', '2026-04-19 08:00:00', 3, '上海市宝山区殷高路21弄5号1号楼102室', 'pending', '李奶奶需要去医院做血糖复查', '2026-04-14 16:00:00'),
(5, 5, '代买代办', '2026-04-20 11:00:00', 1.5, '上海市宝山区盘古路528号1号楼201室', 'pending', '帮刘爷爷去药店买帕金森用药', '2026-04-15 08:00:00');

-- ====== 已取消的订单 (order_id=14) ======
INSERT INTO orders (elder_id, created_by, service_type, service_time, service_hours, address, status, notes, created_at) VALUES
(4, 4, '陪同就医', '2026-04-12 09:00:00', 2, '上海市宝山区国权北路828弄139号1号楼104室', 'cancelled', '陈阿姨身体好转，取消就医安排', '2026-04-10 10:00:00');

-- Demo seed: snapshot each order's service point from elder home pin (matches create-time behavior).
UPDATE orders o
SET service_lng = el.lng,
    service_lat = el.lat
FROM elder_location_state el
WHERE o.elder_id = el.elder_id
  AND o.service_lng IS NULL
  AND o.service_lat IS NULL;

-- ====== 订单评价 ======
INSERT INTO reviews (order_id, rating, comment) VALUES
(1, 5, '王佳明同学非常耐心，全程陪同张大爷看完了所有检查项目，非常感谢！'),
(2, 5, '李志强打扫得非常干净，厨房油烟机都擦得锃亮，李奶奶很满意！'),
(3, 4, '帮忙买药很及时，但是有一种药缺货没买到，总体还是很好的'),
(4, 5, '陈小宇很会聊天，陈阿姨散步回来心情特别好'),
(5, 5, '周敏讲解得很专业，张大爷学会了自己量血压'),
(6, 5, '李志强全程推轮椅陪刘爷爷看病，排队挂号取药一条龙，太贴心了！');

-- ====== 报警记录 ======
INSERT INTO alerts (elder_id, alert_type, description, is_handled, created_at) VALUES
(1, 'health_warning', '健康异常报警：高压超标(142)', TRUE,  '2026-04-12 09:15:00'),
(5, 'health_warning', '健康异常报警：高压超标(145)', TRUE,  '2026-04-10 08:30:00'),
(5, 'sos', '老人发起一键紧急求助！', TRUE,  '2026-04-11 14:22:00'),
(1, 'health_warning', '健康异常报警：高压超标(138)', FALSE, '2026-04-11 09:10:00'),
(2, 'health_warning', '健康异常报警：血糖偏高(7.2)', FALSE, '2026-04-08 08:45:00');

-- ====== 志愿者点赞 ======
INSERT INTO volunteer_likes (from_user_id, to_volunteer_id) VALUES
(2, 11), (3, 11), (4, 13), (5, 12), (6, 11), (7, 12),
(8, 11), (9, 13), (2, 12), (3, 12), (4, 14), (5, 15);

-- ====== 志愿时长审核记录 ======
INSERT INTO volunteer_hour_reviews (order_id, volunteer_id, expected_hours, declared_hours, max_auto_hours, review_status, approved_hours, review_note, reviewed_at) VALUES
(1, 11, 3, 3.5, 4.5, 'approved', 3.5, '家属确认实际服务3.5小时', '2026-04-05 18:00:00'),
(2, 12, 2, 2.0, 3.0, 'approved', 2.0, '服务时长与预期一致', '2026-04-06 17:00:00'),
(3, 11, 1, 1.0, 1.5, 'approved', 1.0, '买药用时1小时', '2026-04-07 12:00:00'),
(4, 13, 2, 2.5, 3.0, 'approved', 2.5, '散步加聊天共2.5小时', '2026-04-08 19:00:00'),
(5, 14, 1.5, 1.5, 2.25, 'approved', 1.5, '教学时长1.5小时', '2026-04-09 12:00:00'),
(6, 12, 4, 5.0, 6.0, 'approved', 5.0, '就医排队时间较长，实际服务5小时', '2026-04-10 16:00:00');

-- ====== 志愿者荣誉申请 ======
INSERT INTO volunteer_award_requests (volunteer_id, award_title, reason, status, review_note, reviewed_at) VALUES
(11, '年度最佳志愿者', '累计服务时长超过150小时，服务评价全部5星', 'approved', '表现优异，批准授予', '2026-04-01 10:00:00'),
(12, '护理之星', '护理专业背景，多次协助老人就医和康复训练', 'approved', '专业能力突出', '2026-04-02 10:00:00'),
(13, '青年志愿先锋', '大学生志愿者，积极参与社区服务', 'pending', NULL, NULL);


-- ============================================================
-- 第三部分：视图（数据库高分考点）
-- ============================================================

-- 服务类型统计视图
CREATE OR REPLACE VIEW v_service_type_stats AS
SELECT
    service_type AS type,
    COUNT(*) AS total_count,
    COUNT(CASE WHEN status = 'completed' THEN 1 END) AS completed_count,
    COUNT(CASE WHEN status = 'pending' THEN 1 END) AS pending_count
FROM orders
WHERE status != 'cancelled'
GROUP BY service_type
ORDER BY total_count DESC;

-- 志愿者排行榜视图
CREATE OR REPLACE VIEW v_volunteer_leaderboard AS
SELECT
    u.user_id, u.real_name,
    vp.total_hours, vp.weekly_hours, vp.likes_count, vp.awards, vp.skills,
    COALESCE(c.completed_count, 0) AS completed_count
FROM users u
JOIN volunteers_profile vp ON u.user_id = vp.user_id
LEFT JOIN (
    SELECT volunteer_id, COUNT(*) AS completed_count
    FROM orders WHERE status = 'completed'
    GROUP BY volunteer_id
) c ON c.volunteer_id = u.user_id
WHERE u.role = 'volunteer' AND vp.audit_status = 'approved'
ORDER BY vp.weekly_hours DESC, vp.likes_count DESC;


-- ============================================================
-- 第四部分：触发器（血压异常自动报警）
-- ============================================================

CREATE OR REPLACE FUNCTION fn_health_alert()
RETURNS TRIGGER AS $$
DECLARE
    v_threshold INT;
    v_elder_name VARCHAR(50);
    v_alert_msg VARCHAR(255);
BEGIN
    SELECT alert_sys_threshold, name INTO v_threshold, v_elder_name
    FROM elders WHERE elder_id = NEW.elder_id;
    IF v_threshold IS NULL THEN v_threshold := 140; END IF;
    IF NEW.blood_pressure_sys IS NOT NULL AND NEW.blood_pressure_sys > v_threshold THEN
        v_alert_msg := '健康异常报警：' || v_elder_name || '的收缩压达到' || NEW.blood_pressure_sys || '，超过阈值' || v_threshold;
        INSERT INTO alerts (elder_id, alert_type, description)
        VALUES (NEW.elder_id, 'health_warning', v_alert_msg);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_health_alert ON health_records;
CREATE TRIGGER trg_health_alert
AFTER INSERT ON health_records
FOR EACH ROW EXECUTE PROCEDURE fn_health_alert();

-- ============================================================
-- 数据概览：
-- 72个用户 | 37位老人 | 18条绑定关系 | 35条健康记录
-- 14个订单 | 6条评价 | 5条报警 | 12条点赞
-- 6条时长审核 | 3条荣誉申请
-- 2个视图 | 1个触发器
-- ============================================================
