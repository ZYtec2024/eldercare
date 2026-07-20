-- 智能派单 / 共享地图调度模块（openGauss 兼容 DDL）
-- 运行后，应用启动会补充20名志愿者、50位老人和宝山区模拟坐标。

CREATE TABLE IF NOT EXISTS dispatch_system_state (
    state_key VARCHAR(64) PRIMARY KEY,
    state_value VARCHAR(255) NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS volunteer_location_state (
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
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS elder_location_state (
    elder_id INT PRIMARY KEY REFERENCES elders(elder_id) ON DELETE CASCADE,
    lng NUMERIC(10,6) NOT NULL,
    lat NUMERIC(10,6) NOT NULL,
    location_source VARCHAR(24) NOT NULL DEFAULT 'simulated',
    is_home_fixed BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS volunteer_skill_tags (
    volunteer_id INT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    skill_tag VARCHAR(64) NOT NULL,
    verified BOOLEAN NOT NULL DEFAULT TRUE,
    PRIMARY KEY (volunteer_id, skill_tag)
);

CREATE TABLE IF NOT EXISTS dispatch_orders (
    order_id INT PRIMARY KEY REFERENCES orders(order_id) ON DELETE CASCADE,
    urgency VARCHAR(16) NOT NULL DEFAULT 'normal',
    required_skills TEXT NOT NULL,
    dispatch_state VARCHAR(24) NOT NULL DEFAULT 'matching',
    search_stage INT NOT NULL DEFAULT 1,
    forced_assignment BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_expanded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS dispatch_candidates (
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

CREATE TABLE IF NOT EXISTS dispatch_routes (
    order_id INT PRIMARY KEY REFERENCES orders(order_id) ON DELETE CASCADE,
    volunteer_id INT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    route_json TEXT NOT NULL,
    eta_minutes INT NOT NULL,
    traffic_version INT NOT NULL,
    replanned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS dispatch_events (
    event_id SERIAL PRIMARY KEY,
    order_id INT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
    event_type VARCHAR(40) NOT NULL,
    message VARCHAR(500) NOT NULL,
    details TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Virtual return journey.  This belongs to the volunteer only and is never
-- exposed by the family tracking endpoint once a service has completed.
CREATE TABLE IF NOT EXISTS volunteer_return_routes (
    volunteer_id INT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
    route_json TEXT NOT NULL,
    eta_minutes INT NOT NULL,
    traffic_version INT NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- V2: nationwide platform with district-isolated scheduling.  A district is
-- the dispatch boundary: candidate search, SOS escalation and administrators
-- never cross this code unless a future policy explicitly adds mutual aid.
CREATE TABLE IF NOT EXISTS administrative_regions (
    adcode VARCHAR(12) PRIMARY KEY,
    name VARCHAR(80) NOT NULL,
    city_name VARCHAR(80) NOT NULL,
    region_level VARCHAR(20) NOT NULL DEFAULT 'district',
    bounds_json TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS admin_region_scope (
    admin_user_id INT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    region_adcode VARCHAR(12) NOT NULL,
    permission VARCHAR(20) NOT NULL DEFAULT 'manage',
    PRIMARY KEY (admin_user_id, region_adcode)
);

ALTER TABLE elders ADD COLUMN IF NOT EXISTS region_adcode VARCHAR(12) DEFAULT '310113';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS region_adcode VARCHAR(12) DEFAULT '310113';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS proxy_created_by INT NULL REFERENCES users(user_id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS proxy_reason VARCHAR(255) NULL;
ALTER TABLE volunteer_location_state ADD COLUMN IF NOT EXISTS service_region_adcode VARCHAR(12) DEFAULT '310113';
ALTER TABLE dispatch_orders ADD COLUMN IF NOT EXISTS region_adcode VARCHAR(12) DEFAULT '310113';

CREATE INDEX IF NOT EXISTS idx_orders_region_status ON orders(region_adcode, status);
CREATE INDEX IF NOT EXISTS idx_volunteer_region_state ON volunteer_location_state(service_region_adcode, availability);

CREATE TABLE IF NOT EXISTS emergency_incidents (
    incident_id SERIAL PRIMARY KEY,
    elder_id INT NOT NULL REFERENCES elders(elder_id) ON DELETE CASCADE,
    region_adcode VARCHAR(12) NOT NULL,
    incident_type VARCHAR(40) NOT NULL DEFAULT 'general_help',
    description TEXT NOT NULL DEFAULT '',
    status VARCHAR(24) NOT NULL DEFAULT 'reported',
    created_by INT NULL REFERENCES users(user_id) ON DELETE SET NULL,
    linked_order_id INT NULL REFERENCES orders(order_id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    acknowledged_at TIMESTAMP NULL,
    acknowledged_by INT NULL REFERENCES users(user_id) ON DELETE SET NULL,
    resolved_at TIMESTAMP NULL,
    resolved_by INT NULL REFERENCES users(user_id) ON DELETE SET NULL,
    resolution_summary TEXT NULL
);

-- An alert is the notification surface; an incident is the SOS lifecycle.
-- Keep this link so "acknowledged" never incorrectly means "resolved".
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS emergency_incident_id INT NULL;
ALTER TABLE emergency_incidents ADD COLUMN IF NOT EXISTS acknowledged_by INT NULL REFERENCES users(user_id) ON DELETE SET NULL;
ALTER TABLE emergency_incidents ADD COLUMN IF NOT EXISTS resolved_by INT NULL REFERENCES users(user_id) ON DELETE SET NULL;
ALTER TABLE emergency_incidents ADD COLUMN IF NOT EXISTS resolution_summary TEXT NULL;
CREATE INDEX IF NOT EXISTS idx_alerts_emergency_incident ON alerts(emergency_incident_id);

CREATE TABLE IF NOT EXISTS emergency_notifications (
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

CREATE TABLE IF NOT EXISTS conversations (
    conversation_id SERIAL PRIMARY KEY,
    conversation_type VARCHAR(24) NOT NULL,
    elder_id INT NULL REFERENCES elders(elder_id) ON DELETE CASCADE,
    order_id INT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
    incident_id INT NULL REFERENCES emergency_incidents(incident_id) ON DELETE CASCADE,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    archived_at TIMESTAMP NULL
);
CREATE TABLE IF NOT EXISTS conversation_members (
    conversation_id INT NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
    user_id INT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    role_in_conversation VARCHAR(24) NOT NULL,
    last_read_at TIMESTAMP NULL,
    PRIMARY KEY (conversation_id, user_id)
);
CREATE TABLE IF NOT EXISTS conversation_messages (
    message_id SERIAL PRIMARY KEY,
    conversation_id INT NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
    sender_user_id INT NULL REFERENCES users(user_id) ON DELETE SET NULL,
    message_type VARCHAR(24) NOT NULL DEFAULT 'text',
    content TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
