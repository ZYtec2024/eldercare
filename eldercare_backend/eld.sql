-- ⚠️ 此文件已过期 (V4.0 旧版 schema)
-- 当前完整建表 + 演示数据请使用 init_demo_data.sql
-- 此文件仅作为历史参考保留
-- 智慧伴老平台 V4.0 openGauss版

CREATE TABLE users (
    user_id SERIAL PRIMARY KEY,
    username VARCHAR(50) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL CHECK (role IN ('admin', 'family', 'volunteer', 'elder')),
    real_name VARCHAR(50) NOT NULL,
    phone VARCHAR(20) NOT NULL,
    email VARCHAR(100) DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE volunteers_profile (
    profile_id SERIAL PRIMARY KEY,
    user_id INT NOT NULL UNIQUE,
    id_card VARCHAR(18) NOT NULL,
    skills VARCHAR(255),
    audit_status VARCHAR(20) DEFAULT 'pending'
        CHECK (audit_status IN ('pending', 'approved', 'rejected')),
    total_hours INT DEFAULT 0,
    weekly_hours INT DEFAULT 0,
    awards TEXT,
    likes_count INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE TABLE elders (
    elder_id SERIAL PRIMARY KEY,
    user_id INT UNIQUE,
    name VARCHAR(50) NOT NULL,
    age INT NOT NULL,
    gender VARCHAR(10) NOT NULL CHECK (gender IN ('男', '女')),
    address VARCHAR(255) NOT NULL,
    medical_history TEXT,
    alert_sys_threshold INT DEFAULT 140,
    alert_dia_threshold INT DEFAULT 90,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE SET NULL
);

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

CREATE TABLE health_records (
    record_id SERIAL PRIMARY KEY,
    elder_id INT NOT NULL,
    record_date DATE NOT NULL,
    blood_pressure_sys INT,
    blood_pressure_dia INT,
    heart_rate INT,
    blood_oxygen DECIMAL(4,1),
    blood_sugar DECIMAL(4,1),
    temperature DECIMAL(4,1),
    weight DECIMAL(5,1),
    notes VARCHAR(255),
    FOREIGN KEY (elder_id) REFERENCES elders(elder_id) ON DELETE CASCADE
);

CREATE TABLE orders (
    order_id SERIAL PRIMARY KEY,
    elder_id INT NOT NULL,
    created_by INT NOT NULL,
    volunteer_id INT,
    service_type VARCHAR(50) NOT NULL,
    service_time TIMESTAMP NOT NULL,
    service_hours INT NOT NULL DEFAULT 1,
    address VARCHAR(255),
    status VARCHAR(20) DEFAULT 'pending'
        CHECK (status IN ('pending', 'accepted', 'in_progress', 'completed', 'cancelled')),
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (elder_id) REFERENCES elders(elder_id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(user_id) ON DELETE CASCADE,
    FOREIGN KEY (volunteer_id) REFERENCES users(user_id) ON DELETE SET NULL
);

CREATE TABLE reviews (
    review_id SERIAL PRIMARY KEY,
    order_id INT NOT NULL UNIQUE,
    rating INT NOT NULL CHECK (rating >= 1 AND rating <= 5),
    comment TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (order_id) REFERENCES orders(order_id) ON DELETE CASCADE
);

CREATE TABLE alerts (
    alert_id SERIAL PRIMARY KEY,
    elder_id INT NOT NULL,
    alert_type VARCHAR(30) NOT NULL
        CHECK (alert_type IN ('sos', 'health_warning')),
    description VARCHAR(255) NOT NULL,
    is_handled BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (elder_id) REFERENCES elders(elder_id) ON DELETE CASCADE
);

CREATE TABLE volunteer_likes (
    like_id SERIAL PRIMARY KEY,
    from_user_id INT NOT NULL,
    to_volunteer_id INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (from_user_id) REFERENCES users(user_id) ON DELETE CASCADE,
    FOREIGN KEY (to_volunteer_id) REFERENCES users(user_id) ON DELETE CASCADE,
    UNIQUE (from_user_id, to_volunteer_id)
);