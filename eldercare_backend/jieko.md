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

> 最后更新：2026-07-29

## 2. 状态码约定

| 状态码 | 含义 |
|--------|------|
| `200` | 成功 |
| `400` | 参数错误 / 业务状态不允许 |
| `401` | 账号或密码错误 |
| `403` | 无权限或审核未通过 |
| `404` | 资源不存在 |
| `409` | 冲突（重复注册/重复绑定/重复点赞/重复评价） |
| `500` | 服务端异常 |
| `502` | 外部服务异常（高德 API / AI 模型调用失败） |

---

## 3. Auth 模块（/auth）

### 3.0 查询行政区划下级列表
- 方法：`GET`
- 路径：`/auth/regions/children`
- Query：`keywords`（默认 `中华人民共和国`，可选如 `上海市`、`宝山区`）

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
  - **`role=elder`**（老人）：
    - 必填：`province_name`、`city_name`、`district_name`、`region_adcode`（6位行政区划代码）、`detail_address`
    - 选填：`age`、`gender`、`medical_history`、`alert_sys_threshold`
    - 注册时后端通过高德地图核验地址是否属于所选区县
  - **`role=volunteer`**（志愿者）：
    - 必填：`id_card`、`skills`（技能/证书说明）、`region_adcode`（服务区县代码）
  - **`role=family`**（家属）：无额外必填字段
  - **`role=admin`**（管理员）：必填 `invite_code=SHU2024ADMIN`

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

### 3.3 修改密码
- 方法：`POST`
- 路径：`/auth/change-password`
- Body：

```json
{
  "user_id": 1,
  "old_password": "oldpass",
  "new_password": "newpass"
}
```

### 3.4 忘记密码
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
  - `role=elder` 追加：`age`、`gender`、`address`、`medical_history`、`alert_sys_threshold`、`region_adcode`、`region_name`
  - `role=volunteer` 追加：`id_card`、`skills`、`total_hours`、`weekly_hours`、`awards`、`likes_count`、`region_adcode`、`region_name`

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
  "alert_sys_threshold": 145
}
```

### 4.3 地址管理
| 端点 | 方法 | 说明 |
|------|------|------|
| `/profile/addresses` | GET | 获取地址列表（Query: `user_id`） |
| `/profile/addresses` | POST | 新增地址 |
| `/profile/addresses/<id>` | PUT | 更新地址 |
| `/profile/addresses/select` | POST | 设为默认地址 |
| `/profile/address-suggestions` | GET | 地址输入联想（高德 POI 搜索） |
| `/profile/location/resolve` | POST | 经纬度逆地理编码解析地址 |
| `/profile/volunteer/location` | POST | 上报志愿者实时位置 |

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

- 异常自动告警（高压 ≥ 阈值、体温 ≥ 37.3、血氧 ≤ 95）

### 5.2 健康趋势
- 方法：`GET`
- 路径：`/elder/health/chart`
- Query：`user_id`（必填）
- 返回最近 7 天健康数据

### 5.3 我的服务列表
- 方法：`GET`
- 路径：`/elder/my-services`
- Query：`user_id`（必填）

### 5.4 SOS 紧急求助
- 方法：`POST`
- 路径：`/elder/sos`
- Body：`{ "user_id": 1 }`
- 写入 `alerts` + 邮件通知绑定家属和管理员；存在活跃调度事件时自动创建 SOS 工单并启动智能派单

### 5.5 紧急事件管理
| 端点 | 方法 | 说明 |
|------|------|------|
| `/elder/emergency/incidents` | POST | 创建紧急事件 |
| `/elder/emergency/incidents` | GET | 查询紧急事件列表（Query: `user_id`） |
| `/elder/emergency/incidents/<id>/cancel` | POST | 取消紧急事件 |

### 5.6 订单评价
- 方法：`POST`
- 路径：`/elder/orders/review`
- Body：`{ "order_id": 1001, "rating": 5, "comment": "服务很好" }`
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
  "relation_type": "父子",
  "personality_bio": "性格开朗，喜欢下棋和聊天，听力略差需大声说话（选填，200字内）"
}
```

> `personality_bio` 选填，绑定时可同时写入老人性格简介，志愿者接单时可见。

### 6.2 解除绑定
- 方法：`DELETE`
- 路径：`/family/bind-elder`
- Body：`{ "family_user_id": 2, "elder_id": 1 }`

### 6.3 更新绑定关系
- 方法：`PUT`
- 路径：`/family/bind-elder/relation`
- Body：`{ "family_user_id": 2, "elder_id": 1, "relation_type": "父女" }`

### 6.4 获取绑定老人列表
- 方法：`GET`
- 路径：`/family/elders`
- Query：`family_user_id`（必填）
- 返回字段包含 `personality_bio`、`bio_updated_by`、`bio_updated_at`

### 6.5 更新老人性格简介
- 方法：`PUT`
- 路径：`/family/elders/<elder_id>/bio`
- Body：`{ "family_user_id": 2, "personality_bio": "..." }`
- 鉴权：仅绑定了该老人的家属可修改；超过 200 字自动截断

### 6.6 老人地址管理
| 端点 | 方法 | 说明 |
|------|------|------|
| `/family/elders/<id>/addresses` | GET | 获取老人地址列表 |
| `/family/elders/<id>/addresses` | POST | 新增老人地址 |
| `/family/elders/<id>/addresses/<addr_id>` | PUT | 更新地址 |
| `/family/elders/<id>/addresses/select` | POST | 设为默认地址 |

### 6.7 健康趋势
- 方法：`GET`
- 路径：`/family/elder-health-chart/<elder_id>`
- 返回最近 7 条健康记录（按日期正序）

### 6.8 订单管理
| 端点 | 方法 | 说明 |
|------|------|------|
| `/family/orders/publish` | POST | 发布服务需求订单 |
| `/family/orders` | GET | 订单列表（Query: `family_user_id`） |
| `/family/orders/cancel` | POST | 撤销订单（仅 `pending` 状态） |
| `/family/orders/confirm-hours` | POST | 家属确认服务时长 |
| `/family/orders/review` | POST | 家属评价订单 |

### 6.9 告警管理
| 端点 | 方法 | 说明 |
|------|------|------|
| `/family/alerts` | GET | 告警列表（Query: `family_user_id`） |
| `/family/alerts/ack` | POST | 确认告警 |

---

## 7. Volunteer 模块（/volunteer）

### 7.1 任务大厅
| 端点 | 方法 | 说明 |
|------|------|------|
| `/volunteer/orders/available` | GET | 可接订单列表（按服务区县隔离，支持 Query: `volunteer_id`） |
| `/volunteer/orders/available/<task_id>` | GET | 订单详情（含老人性格简介、地址） |

### 7.2 抢单
- 方法：`POST`
- 路径：`/volunteer/orders/grab`
- Body：`{ "order_id": 1001, "volunteer_id": 3 }`
- 带事务与 `SELECT ... FOR UPDATE` 悲观锁，防并发重复抢单

### 7.3 更新订单状态
- 方法：`POST`
- 路径：`/volunteer/orders/update-status`
- Body：`{ "order_id": 1001, "action": "start" }` 或 `{ "order_id": 1001, "action": "complete" }`
- `start`：`accepted → in_progress`；`complete`：`in_progress → completed`，累计志愿时长

### 7.4 我的任务
- 方法：`GET`
- 路径：`/volunteer/my-tasks`
- Query：`volunteer_id`（必填）

### 7.5 我的评价
- 方法：`GET`
- 路径：`/volunteer/my-reviews`
- Query：`volunteer_id`（必填）

### 7.6 点赞志愿者
- 方法：`POST`
- 路径：`/volunteer/like`
- Body：`{ "from_user_id": 2, "to_volunteer_id": 3 }`
- 不可给自己点赞；重复点赞返回 `409`

### 7.7 荣誉榜单
- 方法：`GET`
- 路径：`/volunteer/leaderboard`
- Query：`user_id`（可选，用于区域隔离）
- 返回 TOP10（按 `total_hours`、`likes_count` 排序）

### 7.8 个人档案概要
- 方法：`GET`
- 路径：`/volunteer/profile/summary`
- Query：`volunteer_id`（必填）

### 7.9 荣誉申请
- 方法：`POST`
- 路径：`/volunteer/awards/request`
- Body：`{ "volunteer_id": 3, "award_name": "月度服务之星" }`

---

## 8. Admin 模块（/admin）

### 8.1 用户管理
| 端点 | 方法 | 说明 |
|------|------|------|
| `/admin/users/list` | GET | 用户列表（分页+筛选），Query: `role`/`page`/`limit` |
| `/admin/users/delete` | POST | 删除用户，Body: `{ "user_id": 5 }` |

### 8.2 志愿者审核
- 方法：`POST`
- 路径：`/admin/volunteers/audit`
- Body：`{ "user_id": 3, "action": "approve" }` （`action`：`approve` / `reject`）

### 8.3 告警管理
| 端点 | 方法 | 说明 |
|------|------|------|
| `/admin/alerts` | GET | 告警列表 |
| `/admin/alerts/handle` | POST | 处理告警，Body: `{ "alert_id": 10 }` |

### 8.4 数据看板
- 方法：`GET`
- 路径：`/admin/dashboard/stats`
- 返回：`total_users_count`、`total_service_hours`、`service_type_distribution`

### 8.5 每周结算
- 方法：`POST`
- 路径：`/admin/weekly-settlement`
- TOP3 志愿者获荣誉奖章，全站 `weekly_hours` 清零

### 8.6 时长审计
| 端点 | 方法 | 说明 |
|------|------|------|
| `/admin/hour-reviews` | GET | 待审核时长列表 |
| `/admin/hour-reviews/review` | POST | 审核时长，Body: `{ "review_id": 1, "action": "approve"/"reject" }` |

### 8.7 荣誉管理
| 端点 | 方法 | 说明 |
|------|------|------|
| `/admin/award-requests` | GET | 荣誉申请列表 |
| `/admin/award-requests/review` | POST | 审核荣誉申请 |

### 8.8 捐款记录
- 方法：`GET`
- 路径：`/admin/donations`
- 返回所有捐款记录列表

> 区域管理端点挂载在 `/api/dispatch/admin/regions`，AI 配置挂载在 `/api/admin/ai-config`，详见对应模块。

---

## 9. Public 模块（/public）

### 9.1 公开任务大厅
| 端点 | 方法 | 说明 |
|------|------|------|
| `/public/tasks` | GET | 公开任务列表（无需登录，Query: `user_id` 可选） |
| `/public/tasks/<order_id>/delete` | POST | 删除任务（管理员） |
| `/public/tasks/batch-delete` | POST | 批量删除任务 |

### 9.2 捐款
- 方法：`POST`
- 路径：`/public/donations/simulate`
- Body：`{ "donor_name": "爱心人士", "amount": 100, "message": "略尽绵薄之力" }`

---

## 10. Dispatch 模块（/dispatch）

智能调度引擎，基于高德地图实现区域隔离、A\* 路径规划、志愿者评分与派单。

### 10.1 调度概览与通知
| 端点 | 方法 | 说明 |
|------|------|------|
| `/dispatch/overview` | GET | 调度总览（工单统计、志愿者分布） |
| `/dispatch/live-notices` | GET | 实时通知列表 |
| `/dispatch/live-notices/dismiss` | POST | 关闭通知 |

### 10.2 工单生命周期
| 端点 | 方法 | 说明 |
|------|------|------|
| `/dispatch/orders` | POST | 创建调度工单 |
| `/dispatch/elder/orders` | GET | 老人端查看工单（Query: `user_id`） |
| `/dispatch/orders/<id>/respond` | POST | 志愿者响应工单 |
| `/dispatch/orders/<id>/cancel` | POST | 取消工单 |
| `/dispatch/orders/<id>/redispatch` | POST | 重新派单 |
| `/dispatch/orders/<id>/request-admin` | POST | 请求管理员介入 |
| `/dispatch/orders/<id>/elder-complete` | POST | 老人确认完成 |
| `/dispatch/orders/<id>/family-complete` | POST | 家属确认完成 |

### 10.3 管理员调度操作
| 端点 | 方法 | 说明 |
|------|------|------|
| `/dispatch/admin/orders/<id>/dispatch-trail` | GET | 查看工单调度轨迹 |
| `/dispatch/admin/orders/<id>/manual-assign` | POST | 手动指定志愿者 |
| `/dispatch/admin/incidents/<id>/start-manual-sos-service` | POST | 手动启动 SOS 服务工单 |
| `/dispatch/admin/incidents/<id>/start-auto-sos-service` | POST | 自动启动 SOS 服务工单 |

### 10.4 志愿者调度端
| 端点 | 方法 | 说明 |
|------|------|------|
| `/dispatch/volunteer/feed` | GET | 志愿者调度信息流 |
| `/dispatch/volunteer/preferences` | POST | 更新志愿者调度偏好 |
| `/dispatch/volunteer/return/move` | POST | 上报志愿者返程位置 |

### 10.5 位置与追踪
| 端点 | 方法 | 说明 |
|------|------|------|
| `/dispatch/tracking` | GET | 实时追踪（家属查看志愿者位置） |
| `/dispatch/locations/elder` | POST | 上报老人位置 |
| `/dispatch/locations/volunteer` | POST | 上报志愿者位置 |

### 10.6 路径规划
- 方法：`POST`
- 路径：`/dispatch/routes/<order_id>/geometry`
- 获取路径几何数据（高德驾车路线）

### 10.7 区域管理（管理员）
| 端点 | 方法 | 说明 |
|------|------|------|
| `/dispatch/admin/regions` | GET | 区域列表 |
| `/dispatch/admin/regions` | POST | 新增/更新区域 |
| `/dispatch/admin/regions/<adcode>` | PATCH | 更新区域边界/中心点 |
| `/dispatch/admin/regions/managed` | GET | 当前管理员管辖区域 |
| `/dispatch/admin/region-catalog/children` | GET | 区域下级列表（Query: `adcode`） |
| `/dispatch/admin/candidate-managers` | GET | 候选区域管理员列表 |
| `/dispatch/admin/regions/<adcode>/managers` | POST | 为区域分配管理员 |
| `/dispatch/admin/regions/<adcode>/managers/<uid>` | DELETE | 移除区域管理员 |

### 10.8 仿真测试
| 端点 | 方法 | 说明 |
|------|------|------|
| `/dispatch/traffic/perturb` | POST | 模拟交通扰动 |
| `/dispatch/simulation/burst` | POST | 模拟突发订单洪峰 |
| `/dispatch/simulation/tick` | POST | 触发一次调度时钟节拍 |
| `/dispatch/simulation/reset` | POST | 重置仿真状态 |

---

## 11. AI 模块（/api）

AI 服务配置与智能陪聊功能。

### 11.1 管理员 AI 配置
| 端点 | 方法 | 说明 |
|------|------|------|
| `/admin/ai-config` | GET | 获取当前 AI 服务全部配置 |
| `/admin/ai-config` | PUT | 更新 AI 服务配置 |

配置项包括：Groq（API Key / 对话模型 / 转写模型）、自定义 OpenAI 兼容模型（API Key / Base URL / 模型名）、TTS（语音角色 / 语速 / 音量）、周报专用模型、系统提示词。

### 11.2 智能陪聊对话
- 方法：`POST`
- 路径：`/elder/companion/chat`
- Body：`{ "user_id": 1, "message": "今天天气真好" }`
- 自动注入老人画像（年龄、住址、病史、性格简介），调用 Groq LLM（或自定义模型）

### 11.3 语音转文字
- 方法：`POST`
- 路径：`/elder/companion/transcribe`
- Body：`multipart/form-data`，字段 `audio`（WebM/MP3 音频文件）
- 调用 Groq Whisper 模型

### 11.4 文字转语音
- 方法：`POST`
- 路径：`/elder/companion/tts`
- Body：`{ "text": "您好，今天感觉怎么样？" }`
- 返回：MP3 音频流（`audio/mpeg`），使用 Edge TTS，免费无需 API Key

### 11.5 聊天历史管理
| 端点 | 方法 | 说明 |
|------|------|------|
| `/elder/companion/history` | GET | 获取聊天历史（最近 60 条，Query: `user_id`） |
| `/elder/companion/history` | POST | 保存单条消息 |
| `/elder/companion/history` | DELETE | 清空全部聊天记录（Query: `user_id`） |
| `/elder/companion/history/last` | DELETE | 删除最后 N 条（Query: `user_id`、`count`），用于编辑重发 |

---

## 12. Conversation 模块（/conversations）

服务沟通与 SOS 协同会话，支持隐私隔离（仅订单相关人员可见）。

### 12.1 会话管理
| 端点 | 方法 | 说明 |
|------|------|------|
| `/conversations` | GET | 获取会话列表（Query: `user_id`） |
| `/conversations` | POST | 创建新会话（绑定订单/事件） |
| `/conversations/read-all` | POST | 全部标记已读 |
| `/conversations/<id>/hide` | POST | 隐藏会话（软删除） |

### 12.2 消息收发
| 端点 | 方法 | 说明 |
|------|------|------|
| `/conversations/<id>/messages` | GET | 获取会话消息列表 |
| `/conversations/<id>/messages` | POST | 发送消息 |

---

## 13. Report 模块（/api/elder）

AI 智能健康周报，基于老人近 7 天健康数据 + 病历 + 性格简介生成个性化报告。

### 13.1 周报管理
| 端点 | 方法 | 说明 |
|------|------|------|
| `/elder/weekly-report/eligibility` | GET | 检查是否有资格生成周报（Query: `user_id`） |
| `/elder/weekly-report` | POST | 生成/获取本周周报，Body: `{ "user_id": 1, "template_name": "template_1" }` |
| `/elder/weekly-report/history` | GET | 历史周报列表（Query: `user_id`） |
| `/elder/weekly-report/<id>/save` | PUT | 保存周报（status → saved） |
| `/elder/weekly-report/<id>` | DELETE | 删除周报 |

- 模板可选：`template_1`（温馨关怀）、`template_2`（专业医疗）、`template_3`（简洁摘要）
- 周报 AI 模型可通过环境变量 `REPORT_API_KEY` / `REPORT_API_BASE_URL` / `REPORT_MODEL_NAME` 独立配置

---

## 14. 前端联调建议

- 登录后保存 `user_id`、`role`、`token` 到本地状态
- 目前后端未校验 token，前端可先按登录态做路由守卫
- 对 `409`（重复操作）做友好提示（如"已点赞/已评价/已绑定"）
- 时间字段建议统一展示为本地格式（如 `YYYY-MM-DD HH:mm`）
- 老人注册需要完整的省/市/区/详细地址，前端应使用级联选择器
- AI 陪聊功能需要在管理员后台先配置 API Key 才能正常使用
- 调度模块依赖高德地图 Web 服务 Key，需开通「行政区域查询」「地理编码」「驾车路径规划」