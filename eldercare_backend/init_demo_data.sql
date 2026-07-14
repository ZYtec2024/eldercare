-- ============================================================
-- 智慧伴老平台 - openGauss 完整建表 + 演示数据 SQL
-- 适用于 openGauss / PostgreSQL 数据库
-- 数据库名: elderly_care_system
-- ============================================================

DROP TABLE IF EXISTS volunteer_award_requests CASCADE;
DROP TABLE IF EXISTS volunteer_hour_reviews CASCADE;
DROP TABLE IF EXISTS volunteer_likes CASCADE;
DROP TABLE IF EXISTS reviews CASCADE;
DROP TABLE IF EXISTS alerts CASCADE;
DROP TABLE IF EXISTS health_records CASCADE;
DROP TABLE IF EXISTS orders CASCADE;
DROP TABLE IF EXISTS user_elder_relation CASCADE;
DROP TABLE IF EXISTS volunteers_profile CASCADE;
DROP TABLE IF EXISTS elders CASCADE;
DROP TABLE IF EXISTS users CASCADE;

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
    medical_history TEXT,
    alert_sys_threshold INT DEFAULT 140,
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
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'in_progress', 'completed', 'cancelled')),
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (elder_id) REFERENCES elders(elder_id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(user_id) ON DELETE CASCADE,
    FOREIGN KEY (volunteer_id) REFERENCES users(user_id) ON DELETE SET NULL
);

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
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (elder_id) REFERENCES elders(elder_id) ON DELETE CASCADE
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


-- ============================================================
-- 第二部分：演示数据
-- ============================================================

-- ====== 管理员 (user_id=1) ======
INSERT INTO users (username, password_hash, role, real_name, phone, email) VALUES
('admin', 'admin123', 'admin', '系统管理员', '13000000001', 'admin@eldercare.com');

-- ====== 家属 (user_id=2~5) ======
INSERT INTO users (username, password_hash, role, real_name, phone, email) VALUES
('zhangsan', 'pass123', 'family', '张三', '13800138001', 'zhangsan@qq.com'),
('lisi_family', 'pass123', 'family', '李思', '13800138002', 'lisi@qq.com'),
('wangwu_family', 'pass123', 'family', '王五', '13800138003', 'wangwu@163.com'),
('zhaoliu_family', 'pass123', 'family', '赵六', '13800138004', 'zhaoliu@gmail.com');

-- ====== 老人 (user_id=6~10) ======
INSERT INTO users (username, password_hash, role, real_name, phone, email) VALUES
('elder_zhang', 'pass123', 'elder', '张大爷', '13900001001', 'zhangdaye@qq.com'),
('elder_li', 'pass123', 'elder', '李奶奶', '13900001002', 'linainai@qq.com'),
('elder_wang', 'pass123', 'elder', '王伯伯', '13900001003', 'wangbobo@qq.com'),
('elder_chen', 'pass123', 'elder', '陈阿姨', '13900001004', 'chenayi@qq.com'),
('elder_liu', 'pass123', 'elder', '刘爷爷', '13900001005', 'liuyeye@qq.com');

-- ====== 志愿者 (user_id=11~16) ======
INSERT INTO users (username, password_hash, role, real_name, phone, email) VALUES
('vol_wangjiaming', 'pass123', 'volunteer', '王佳明', '15000001001', 'wjm@volunteer.org'),
('vol_lizhiqiang', 'pass123', 'volunteer', '李志强', '15000001002', 'lzq@volunteer.org'),
('vol_chenxiaoyu', 'pass123', 'volunteer', '陈小宇', '15000001003', 'cxy@volunteer.org'),
('vol_zhoumin', 'pass123', 'volunteer', '周敏', '15000001004', 'zm@volunteer.org'),
('vol_sunhao', 'pass123', 'volunteer', '孙浩', '15000001005', 'sh@volunteer.org'),
('vol_huangxin', 'pass123', 'volunteer', '黄鑫', '15000001006', 'hx@volunteer.org');

-- ====== 老人档案 (elder_id=1~5) ======
INSERT INTO elders (user_id, name, age, gender, address, medical_history, alert_sys_threshold) VALUES
(6,  '张大爷', 78, '男', '幸福小区1栋301室',  '高血压病史10年，长期服用降压药', 140),
(7,  '李奶奶', 82, '女', '阳光花园3栋502室',  '糖尿病II型，骨质疏松，需定期复查血糖', 135),
(8,  '王伯伯', 75, '男', '和平路18号院2单元', '冠心病，安装过心脏支架，需避免剧烈运动', 130),
(9,  '陈阿姨', 70, '女', '翠苑小区5栋101室',  '轻度认知障碍，偶有健忘，身体状况总体良好', 140),
(10, '刘爷爷', 85, '男', '银杏苑7栋203室',    '帕金森病早期，行动不便需要助行器，听力下降', 140);

-- ====== 志愿者档案 ======
INSERT INTO volunteers_profile (user_id, id_card, skills, total_hours, weekly_hours, likes_count, awards, audit_status) VALUES
(11, '310101199501011234', '急救培训证书；擅长陪聊散步；有驾照可陪同就医', 156.5, 12.5, 48, '2025年度社区服务之星；最佳志愿者奖', 'approved'),
(12, '310101199602022345', '护理专业背景；擅长健康指导和康复训练', 128.0, 8.0, 35, '优秀志愿者称号', 'approved'),
(13, '310101199803033456', '大学生志愿者；擅长教老人使用智能手机', 89.5, 6.5, 22, '', 'approved'),
(14, '310101199704044567', '社工专业；心理咨询师资格；擅长情感陪伴', 67.0, 4.0, 18, '', 'approved'),
(15, '310101200005055678', '体育专业；擅长带领老人做健身操', 45.0, 3.0, 12, '', 'approved'),
(16, '310101200106066789', '医学院在读；可提供基础健康咨询', 0.0, 0.0, 0, '', 'pending');

-- ====== 家属-老人绑定关系 ======
INSERT INTO user_elder_relation (family_user_id, elder_id, relation_type) VALUES
(2, 1, '父子'),
(2, 2, '母子'),
(3, 2, '女儿'),
(3, 3, '儿媳'),
(4, 4, '女儿'),
(5, 5, '孙子');

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
(1, 2, 11, '陪同就医', '2026-04-05 09:00:00', 3, '幸福小区1栋301室', 'completed', '张大爷需要去社区医院复查血压', '2026-04-03 10:00:00'),
(2, 3, 12, '上门打扫', '2026-04-06 14:00:00', 2, '阳光花园3栋502室', 'completed', '李奶奶家需要打扫卫生', '2026-04-04 09:00:00'),
(3, 3, 11, '代买代办', '2026-04-07 10:00:00', 1, '和平路18号院2单元', 'completed', '帮王伯伯去药店买降压药', '2026-04-05 15:00:00'),
(4, 4, 13, '陪聊散步', '2026-04-08 16:00:00', 2, '翠苑小区5栋101室', 'completed', '陈阿姨想去公园散步', '2026-04-06 11:00:00'),
(1, 2, 14, '健康指导', '2026-04-09 10:00:00', 1.5, '幸福小区1栋301室', 'completed', '教张大爷使用血压计自测', '2026-04-07 08:00:00'),
(5, 5, 12, '陪同就医', '2026-04-10 08:30:00', 4, '银杏苑7栋203室', 'completed', '刘爷爷需要去三甲医院做帕金森复查', '2026-04-08 14:00:00');

-- ====== 进行中的订单 (order_id=7~8) ======
INSERT INTO orders (elder_id, created_by, volunteer_id, service_type, service_time, service_hours, address, status, notes, created_at) VALUES
(2, 2, 11, '康复训练', '2026-04-15 09:00:00', 2, '阳光花园3栋502室', 'in_progress', '李奶奶需要做腿部康复训练', '2026-04-13 10:00:00'),
(5, 5, 15, '陪聊散步', '2026-04-15 15:00:00', 1.5, '银杏苑7栋203室', 'accepted', '刘爷爷想在小区花园散步', '2026-04-13 16:00:00');

-- ====== 待接单的订单 (order_id=9~13) ======
INSERT INTO orders (elder_id, created_by, service_type, service_time, service_hours, address, status, notes, created_at) VALUES
(1, 2, '代买代办', '2026-04-16 10:00:00', 1, '幸福小区1栋301室', 'pending', '帮张大爷去超市买米面油和日用品', '2026-04-14 09:00:00'),
(3, 3, '上门打扫', '2026-04-17 14:00:00', 3, '和平路18号院2单元', 'pending', '王伯伯家大扫除', '2026-04-14 11:00:00'),
(4, 4, '健康指导', '2026-04-18 09:00:00', 1, '翠苑小区5栋101室', 'pending', '教陈阿姨做记忆力训练游戏', '2026-04-14 14:00:00'),
(2, 3, '陪同就医', '2026-04-19 08:00:00', 3, '阳光花园3栋502室', 'pending', '李奶奶需要去医院做血糖复查', '2026-04-14 16:00:00'),
(5, 5, '代买代办', '2026-04-20 11:00:00', 1.5, '银杏苑7栋203室', 'pending', '帮刘爷爷去药店买帕金森用药', '2026-04-15 08:00:00');

-- ====== 已取消的订单 (order_id=14) ======
INSERT INTO orders (elder_id, created_by, service_type, service_time, service_hours, address, status, notes, created_at) VALUES
(4, 4, '陪同就医', '2026-04-12 09:00:00', 2, '翠苑小区5栋101室', 'cancelled', '陈阿姨身体好转，取消就医安排', '2026-04-10 10:00:00');

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
FOR EACH ROW EXECUTE FUNCTION fn_health_alert();

-- ============================================================
-- 数据概览：
-- 16个用户 | 5位老人 | 6条绑定关系 | 35条健康记录
-- 14个订单 | 6条评价 | 5条报警 | 12条点赞
-- 6条时长审核 | 3条荣誉申请
-- 2个视图 | 1个触发器
-- ============================================================
