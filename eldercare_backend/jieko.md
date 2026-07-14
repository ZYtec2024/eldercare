# 智慧伴老平台前端接口文档（按当前后端代码生成）

## 1. 基础约定

- Base URL：`http://localhost:5000/api`
- 请求格式：`Content-Type: application/json`
- 返回格式统一为：

```json
{
  "code": 200,
  "message": "xxx",
  "data": {}
}
```

> 说明：部分接口只返回 `code + message`，没有 `data`。

## 2. 状态码约定（项目内）

- `200` 成功
- `400` 参数错误 / 业务状态不允许
- `401` 账号或密码错误
- `403` 无权限或审核未通过
- `404` 资源不存在
- `409` 冲突（重复注册/重复绑定/重复点赞/重复评价）
- `500` 服务端异常

---

## 3. Auth 模块（/auth）

### 3.1 注册
- 方法：`POST`
- 路径：`/auth/register`
- Body（基础必填）：

```json
{
  "username": "zhangsan",
  "password": "123456",
  "role": "volunteer",
  "real_name": "张三",
  "phone": "13800138000",
  "email": "zhangsan@example.com"
}
```

- 角色扩展字段：
  - `role=elder`：可传 `age`（默认60）、`gender`（默认“男”）、`address`（默认“未填写”）、`alert_sys_threshold`（默认140）
  - `role=volunteer`：必传 `id_card`，可传 `skills`（默认“热心群众”）
  - `role=admin`：必传 `invite_code=SHU2024ADMIN`

### 3.2 登录
- 方法：`POST`
- 路径：`/auth/login`
- Body：

```json
{
  "username": "zhangsan",
  "password": "123456"
}
```

- 成功返回 `data`：`user_id`、`role`、`real_name`、`token`
- 志愿者若 `pending/rejected` 会返回 `403`

### 3.3 忘记密码
- 方法：`POST`
- 路径：`/auth/forgot-password`
- Body：

```json
{
  "username": "zhangsan",
  "phone": "13800138000",
  "new_password": "newpass"
}
```

---

## 4. Profile 模块（/profile）

### 4.1 获取个人信息
- 方法：`GET`
- 路径：`/profile/info`
- Query：`user_id`、`role`（必填）
- 返回：
  - 通用字段：`real_name`、`phone`、`email`、`created_at`
  - `role=elder` 追加：`age`、`gender`、`address`、`medical_history`、`alert_sys_threshold`
  - `role=volunteer` 追加：`id_card`、`skills`、`total_hours`、`weekly_hours`、`awards`、`likes_count`

### 4.2 更新个人信息
- 方法：`POST`
- 路径：`/profile/update`
- Body：

```json
{
  "user_id": 1,
  "role": "elder",
  "phone": "13900000000",
  "email": "new@example.com",
  "medical_history": "高血压",
  "alert_sys_threshold": 145,
  "skills": "心理疏导"
}
```

- 说明：
  - `phone + email` 同时存在时才会更新通用信息
  - 老人更新需要 `medical_history` 与 `alert_sys_threshold` 同时提供
  - 志愿者更新使用 `skills`

---

## 5. Elder 模块（/elder）

### 5.1 健康打卡
- 方法：`POST`
- 路径：`/elder/health/checkin`
- Body（`user_id` 必填，其它健康项可为空）：

```json
{
  "user_id": 1,
  "blood_pressure_sys": 142,
  "blood_pressure_dia": 90,
  "heart_rate": 78,
  "blood_oxygen": 97,
  "blood_sugar": 6.1,
  "temperature": 36.8,
  "weight": 65.5,
  "notes": "状态良好"
}
```

- 触发条件会自动写入报警（高压、体温、血氧）

### 5.2 我的服务列表
- 方法：`GET`
- 路径：`/elder/my-services`
- Query：`user_id`（必填）
- 返回：`order_id`、`service_type`、`service_time`、`status`、`volunteer_name`

### 5.3 SOS 报警
- 方法：`POST`
- 路径：`/elder/sos`
- Body：

```json
{
  "user_id": 1
}
```

- 说明：后端会写入 `alerts`，并尝试向绑定家属邮箱发送邮件

### 5.4 订单评价
- 方法：`POST`
- 路径：`/elder/orders/review`
- Body：

```json
{
  "order_id": 1001,
  "rating": 5,
  "comment": "服务很好"
}
```

- 仅允许评价 `completed` 订单；同一订单不可重复评价（`409`）

---

## 6. Family 模块（/family）

### 6.1 绑定老人
- 方法：`POST`
- 路径：`/family/bind-elder`
- Body：

```json
{
  "family_user_id": 2,
  "elder_phone": "13800000000",
  "relation_type": "父子"
}
```

### 6.2 获取绑定老人列表
- 方法：`GET`
- 路径：`/family/elders`
- Query：`family_user_id`（必填）

### 6.3 获取老人健康趋势（图表）
- 方法：`GET`
- 路径：`/family/elder-health-chart/<elder_id>`
- 返回最近7条健康记录（按日期正序）

### 6.4 发布服务订单
- 方法：`POST`
- 路径：`/family/orders/publish`
- Body：

```json
{
  "family_user_id": 2,
  "elder_id": 1,
  "service_type": "陪同就医",
  "service_time": "2026-04-09 10:00:00",
  "service_hours": 2,
  "notes": "需轮椅"
}
```

### 6.5 撤销订单
- 方法：`POST`
- 路径：`/family/orders/cancel`
- Body：

```json
{
  "order_id": 1001
}
```

- 仅 `pending` 状态可撤销

---

## 7. Volunteer 模块（/volunteer）

### 7.1 可接订单列表
- 方法：`GET`
- 路径：`/volunteer/orders/available`

### 7.2 抢单
- 方法：`POST`
- 路径：`/volunteer/orders/grab`
- Body：

```json
{
  "order_id": 1001,
  "volunteer_id": 3
}
```

- 说明：带事务与锁，防并发重复抢单

### 7.3 更新订单状态
- 方法：`POST`
- 路径：`/volunteer/orders/update-status`
- Body：

```json
{
  "order_id": 1001,
  "action": "start"
}
```

或

```json
{
  "order_id": 1001,
  "action": "complete"
}
```

- `start`：`accepted -> in_progress`
- `complete`：`in_progress -> completed`，并累计志愿时长到 `total_hours` 与 `weekly_hours`

### 7.4 点赞志愿者
- 方法：`POST`
- 路径：`/volunteer/like`
- Body：

```json
{
  "from_user_id": 2,
  "to_volunteer_id": 3
}
```

- 不可给自己点赞；重复点赞返回 `409`

### 7.5 荣誉榜单
- 方法：`GET`
- 路径：`/volunteer/leaderboard`
- 返回 TOP10（按 `total_hours`、`likes_count` 排序）

---

## 8. Admin 模块（/admin）

### 8.1 用户列表（分页+筛选）
- 方法：`GET`
- 路径：`/admin/users/list`
- Query：
  - `role` 可选
  - `page` 默认 `1`
  - `limit` 默认 `10`

### 8.2 报警列表
- 方法：`GET`
- 路径：`/admin/alerts`

### 8.3 大屏统计
- 方法：`GET`
- 路径：`/admin/dashboard/stats`
- 返回：
  - `total_users_count`
  - `total_service_hours`
  - `service_type_distribution`

### 8.4 志愿者审核
- 方法：`POST`
- 路径：`/admin/volunteers/audit`
- Body：

```json
{
  "user_id": 3,
  "action": "approve"
}
```

- `action`：`approve` / `reject`

### 8.5 报警处理
- 方法：`POST`
- 路径：`/admin/alerts/handle`
- Body：

```json
{
  "alert_id": 10
}
```

### 8.6 每周结算
- 方法：`POST`
- 路径：`/admin/weekly-settlement`
- Body：无
- 说明：结算后会给本周 TOP3 志愿者写入荣誉，并把全体 `weekly_hours` 清零

---

## 9. 前端联调建议

- 登录后保存 `user_id`、`role`、`token` 到本地状态
- 目前后端未校验 token，前端可先按登录态做路由守卫
- 对 `409`（重复操作）做友好提示（如“已点赞/已评价/已绑定”）
- 时间字段建议统一展示为本地格式（如 `YYYY-MM-DD HH:mm`）