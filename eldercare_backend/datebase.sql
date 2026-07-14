-- ==========================================================
-- 智慧伴老平台 V4.0 (纯公益版) 数据库初始化脚本
-- 包含：9张核心表，全面支持志愿时长、邮件报警、全民点赞等功能
-- ==========================================================

-- 1. 用户总表 (Users) - 存放所有人的登录信息
CREATE TABLE users (
    user_id INT AUTO_INCREMENT PRIMARY KEY COMMENT '用户唯一ID',
    username VARCHAR(50) NOT NULL UNIQUE COMMENT '登录账号',
    password_hash VARCHAR(255) NOT NULL COMMENT '密码哈希值',
    role ENUM('admin', 'family', 'volunteer', 'elder') NOT NULL COMMENT '用户角色',
    real_name VARCHAR(50) NOT NULL COMMENT '真实姓名',
    phone VARCHAR(20) NOT NULL COMMENT '联系电话',
    email VARCHAR(100) DEFAULT NULL COMMENT '预留邮箱(极重要：用于接收老人的SOS紧急求助邮件)',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '注册时间'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='系统用户总表(所有可登录账号)';

-- 2. 志愿者扩展档案表 (Volunteers_Profile) - 纯公益核心表
CREATE TABLE volunteers_profile (
    profile_id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL UNIQUE COMMENT '关联users表的登录账号',
    id_card VARCHAR(18) NOT NULL COMMENT '身份证号(实名认证)',
    skills VARCHAR(255) COMMENT '服务特长标签(如: 会急救, 擅长理发)',
    audit_status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending' COMMENT '管理员审核状态',
    total_hours INT DEFAULT 0 COMMENT '历史总志愿时长(小时)',
    weekly_hours INT DEFAULT 0 COMMENT '本周志愿时长(用于每周评奖后清零)',
    awards TEXT COMMENT '获得的荣誉奖项记录(如: 2023-11第一周服务之星)',
    likes_count INT DEFAULT 0 COMMENT '收到的总赞数(缓存字段)',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='志愿者实名与荣誉档案表';

-- 3. 老人档案表 (Elders) - 新增个性化健康阈值
CREATE TABLE elders (
    elder_id INT AUTO_INCREMENT PRIMARY KEY COMMENT '老人业务档案ID',
    user_id INT UNIQUE DEFAULT NULL COMMENT '关联users表(1对1关系，纯家属代管则为空)',
    name VARCHAR(50) NOT NULL COMMENT '老人姓名',
    age INT NOT NULL COMMENT '年龄',
    gender ENUM('男', '女') NOT NULL COMMENT '性别',
    address VARCHAR(255) NOT NULL COMMENT '详细住址',
    medical_history TEXT COMMENT '既往病史与注意事项',
    alert_sys_threshold INT DEFAULT 140 COMMENT '高压报警阈值(老人可自定义)',
    alert_dia_threshold INT DEFAULT 90 COMMENT '低压报警阈值',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='老人详细档案表';

-- 4. 用户-老人关系表 (User_Elder_Relation)
CREATE TABLE user_elder_relation (
    id INT AUTO_INCREMENT PRIMARY KEY,
    family_user_id INT NOT NULL COMMENT '家属的用户ID',
    elder_id INT NOT NULL COMMENT '绑定的老人档案ID',
    relation_type VARCHAR(50) DEFAULT '亲属' COMMENT '关系(如: 父子/母女)',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (family_user_id) REFERENCES users(user_id) ON DELETE CASCADE,
    FOREIGN KEY (elder_id) REFERENCES elders(elder_id) ON DELETE CASCADE,
    UNIQUE KEY unique_bind (family_user_id, elder_id) -- 防止重复绑定
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='家属与老人的绑定关系表';

-- 5. 健康打卡记录表 (Health_Records) - 包含全指标，允许部分为空
CREATE TABLE health_records (
    record_id INT AUTO_INCREMENT PRIMARY KEY,
    elder_id INT NOT NULL COMMENT '属于哪位老人',
    record_date DATE NOT NULL COMMENT '记录日期',
    blood_pressure_sys INT DEFAULT NULL COMMENT '收缩压(高压)',
    blood_pressure_dia INT DEFAULT NULL COMMENT '舒张压(低压)',
    heart_rate INT DEFAULT NULL COMMENT '心率',
    blood_oxygen DECIMAL(4,1) DEFAULT NULL COMMENT '血氧(%)',
    blood_sugar DECIMAL(4,1) DEFAULT NULL COMMENT '血糖(mmol/L)',
    temperature DECIMAL(4,1) DEFAULT NULL COMMENT '体温(℃)',
    weight DECIMAL(5,1) DEFAULT NULL COMMENT '体重(kg)',
    notes VARCHAR(255) COMMENT '当天情况备注',
    FOREIGN KEY (elder_id) REFERENCES elders(elder_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='老人每日健康打卡表';

-- 6. 服务订单表 (Orders) - 纯公益模式：取消积分，改为赚取时长
CREATE TABLE orders (
    order_id INT AUTO_INCREMENT PRIMARY KEY,
    elder_id INT NOT NULL COMMENT '需要服务的老人档案ID',
    created_by INT NOT NULL COMMENT '发单的用户ID',
    volunteer_id INT DEFAULT NULL COMMENT '接单的志愿者ID',
    service_type VARCHAR(50) NOT NULL COMMENT '服务类型(陪同就医/上门打扫等)',
    service_time DATETIME NOT NULL COMMENT '期望服务时间',
    service_hours INT NOT NULL DEFAULT 1 COMMENT '预计服务时长(小时，完成后累加给志愿者)',
    address VARCHAR(255) DEFAULT NULL COMMENT '服务地址(由家属填写，覆盖老人登记地址)[V5.1新增]',
    status ENUM('pending', 'accepted', 'in_progress', 'completed', 'cancelled') DEFAULT 'pending' COMMENT '订单流转状态',
    notes TEXT COMMENT '需求备注详情',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (elder_id) REFERENCES elders(elder_id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(user_id) ON DELETE CASCADE,
    FOREIGN KEY (volunteer_id) REFERENCES users(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='公益服务流转表';

-- 7. 订单评价表 (Reviews)
CREATE TABLE reviews (
    review_id INT AUTO_INCREMENT PRIMARY KEY,
    order_id INT NOT NULL UNIQUE COMMENT '关联的订单ID(1对1)',
    rating INT NOT NULL CHECK (rating >= 1 AND rating <= 5) COMMENT '星级评分(1-5星)',
    comment TEXT COMMENT '文字评价内容',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (order_id) REFERENCES orders(order_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='服务完成后的评价表';

-- 8. 紧急求助与健康报警表 (Alerts)
CREATE TABLE alerts (
    alert_id INT AUTO_INCREMENT PRIMARY KEY,
    elder_id INT NOT NULL COMMENT '报警的老人ID',
    alert_type ENUM('sos', 'health_warning') NOT NULL COMMENT '报警类型：主动SOS / 健康数据异常',
    description VARCHAR(255) NOT NULL COMMENT '报警详情',
    is_handled BOOLEAN DEFAULT FALSE COMMENT '管理员是否已处理',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (elder_id) REFERENCES elders(elder_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='SOS与系统健康预警表';

-- 9. 全民点赞记录表 (Volunteer_Likes) - 防刷赞机制核心表
CREATE TABLE volunteer_likes (
    like_id INT AUTO_INCREMENT PRIMARY KEY,
    from_user_id INT NOT NULL COMMENT '点赞人的账号ID',
    to_volunteer_id INT NOT NULL COMMENT '被点赞志愿者的账号ID',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (from_user_id) REFERENCES users(user_id) ON DELETE CASCADE,
    FOREIGN KEY (to_volunteer_id) REFERENCES users(user_id) ON DELETE CASCADE,
    UNIQUE KEY unique_like (from_user_id, to_volunteer_id) -- 核心防刷赞约束
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='全民为志愿者点赞记录表';