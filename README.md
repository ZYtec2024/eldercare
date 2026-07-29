# 智慧伴老平台 (ElderCare Platform)

面向社区养老的纯公益 Web 应用系统。连接**老人**、**家属**、**志愿者**、**管理员**四类角色，提供健康打卡、SOS 紧急求助、智能调度派单、AI 语音陪聊、志愿时长管理、荣誉激励、数据看板等功能。

---

## 角色与核心功能

| 角色 | 核心功能 |
|:----:|----------|
| **老人** | 每日健康打卡（血压/心率/血氧/血糖/体温/体重）、一键 SOS 紧急求助（短信+邮件通知家属与志愿者）、查看服务记录、评价志愿者、**AI 智能陪聊**（语音转文字 → Groq/自定义模型对话 → Edge TTS 朗读回复）、查看健康周报 |
| **家属** | 绑定长辈账号、填写老人性格简介（用于志愿者了解老人偏好）、查看健康趋势图表（ECharts 可视化）、发布公益服务需求订单、实时追踪志愿者位置、确认服务时长、接收 SOS 告警 |
| **志愿者** | 任务大厅抢单（按服务区县隔离）、查看老人性格简介与地址、服务执行与状态流转、个人成就徽章、服务时长统计、**荣誉排行榜**（按区域/全局排名） |
| **管理员** | 用户管理与志愿者审核、区县区域管理（基于高德行政区划边界）、告警处理、时长审计、每周结算、数据看板（概览统计）、**智能调度面板**（A\* 路径规划 / 疲劳度 / 候选评分）、AI 服务配置（Groq / 自定义 OpenAI 兼容模型 / Edge TTS 语音参数）、捐款记录管理 |

---

## 技术栈

### 后端
| 技术 | 版本 | 说明 |
|------|------|------|
| Python | 3.11 | 运行环境 |
| Flask | 3.0 | Web 框架 |
| Flask-CORS | 4.0 | 跨域支持 |
| psycopg2 | 2.9 | PostgreSQL / openGauss 数据库驱动 |
| requests | ≥2.32 | HTTP 客户端（Groq API、高德 Web 服务调用） |
| edge-tts | ≥7.2 | Microsoft Edge TTS 语音合成（免费，无需 API Key） |
| Werkzeug | 3.0 | WSGI 工具链 |

### 前端
| 技术 | 版本 | 说明 |
|------|------|------|
| React | 19.2 | UI 框架 |
| TypeScript | 5.9 | 类型安全 |
| Vite | 8 | 构建工具 |
| Ant Design | 6.3 | UI 组件库（中文主题） |
| Tailwind CSS | 3.4 | 原子化样式 |
| React Router | 7.13 | 路由管理 |
| ECharts | 6 | 健康数据可视化 |
| Axios | 1.13 | HTTP 客户端 |
| MSW | 2.12 | Mock Service Worker（无后端本地演示） |

### 数据库
- **openGauss**（PostgreSQL 兼容模式），Docker 运行时由 `db` 服务提供，后端默认连接 `omm` 库
- 33 张核心表 + 2 个视图 + 1 个触发器，涵盖用户、老人档案、健康记录、订单、调度、会话、AI 配置、周报等全部业务域

### 外部服务
| 服务 | 用途 |
|------|------|
| 高德地图 Web API | 行政区划查询、地址核验（地理编码/逆地理编码）、POI 搜索、驾车路径规划 |
| Groq API | AI 语音转写（Whisper）、对话模型（Llama 3.1 8B） |
| 自定义大模型 API | 可选替代 Groq，支持任意 OpenAI 兼容接口（如 DeepSeek / 豆包 / GPT） |
| 周报大模型 API | 健康周报专用模型（独立配置，可与陪聊模型分离） |
| Edge TTS | 微软免费文本转语音（中文神经语音） |
| SMTP | SOS 告警邮件、健康异常通知 |

---

## 项目结构

```
eldercare/
├── docker-compose.yml               # 一键启动编排
├── eldercare_backend/                # Flask 后端
│   ├── Dockerfile                    # 后端容器镜像（Python 3.11-slim）
│   ├── entrypoint.sh                 # 启动脚本（等待数据库就绪 + 启动 Flask）
│   ├── app.py                        # 应用入口（蓝图注册 / 数据库自动迁移 / 调度时钟）
│   ├── db.py                         # 数据库连接配置（psycopg2）
│   ├── utils.py                      # 工具函数（API 响应、健康趋势查询、邮件告警）
│   ├── region_service.py             # 行政区划服务（高德 API 封装 / 多边形边界 / 地址核验）
│   ├── requirements.txt              # Python 依赖
│   ├── datebase.sql                  # 备用建表 SQL
│   ├── jieko.md                      # API 接口文档
│   ├── init_demo_data.sql            # 完整建表 + 演示数据（首次启动自动导入）
│   ├── routes/
│   │   ├── auth.py                   # 多角色注册/登录/忘记密码/区域查询
│   │   ├── profile.py                # 个人信息查询与更新
│   │   ├── elder.py                  # 健康打卡/SOS 告警/服务评价
│   │   ├── family.py                 # 长辈绑定/健康趋势/服务订单管理/实时追踪
│   │   ├── volunteer.py              # 任务大厅/抢单/服务执行/排行榜/成就
│   │   ├── admin.py                  # 用户管理/数据看板/时长审计/区域管理/AI 配置
│   │   ├── public.py                 # 公开任务大厅（无需登录浏览）
│   │   ├── conversation.py           # 服务沟通与 SOS 协同会话（隐私隔离）
│   │   ├── dispatch.py               # 智能调度引擎（A* 路径 / 疲劳度 / 候选评分）
│   │   ├── report.py                 # AI 智能健康周报（模板渲染 + 模型调用）
│   │   └── ai.py                     # AI 陪聊（Groq 语音转写 + 对话 / Edge TTS 朗读）
│   ├── skills/
│   │   └── weekly_report/            # 周报 Markdown 模板（3 套风格）
│   ├── scripts/                      # 运维脚本
│   └── tests/                        # 后端测试
│
└── frontend/                         # React + Vite 前端
    ├── Dockerfile                    # 多阶段构建（Node.js 22 构建 → Nginx Alpine 托管）
    ├── nginx.conf                    # Nginx 反向代理（API 转发到 backend:5000）
    ├── package.json
    ├── vite.config.ts
    ├── tailwind.config.ts
    ├── index.html
    └── src/
        ├── main.tsx                  # 启动入口（MSW 初始化）
        ├── app/App.tsx               # 根组件
        ├── features/                 # 功能模块
        │   ├── auth/                 #   登录/注册/忘记密码 + 会话管理
        │   ├── elder/                #   健康打卡 / SOS / AI 陪聊 / 健康周报
        │   ├── family/               #   绑定长辈 / 健康趋势 / 订单管理 / 实时追踪
        │   ├── volunteer/            #   任务大厅 / 抢单 / 排行榜 / 成就
        │   ├── admin/                #   用户管理 / 数据看板 / 调度面板 / AI 配置
        │   ├── conversation/         #   服务沟通会话
        │   ├── dispatch/             #   智能调度前端组件
        │   ├── donation/             #   捐款记录
        │   ├── home/                 #   公开首页
        │   ├── onboarding/           #   新用户引导
        │   ├── public/               #   公开任务大厅
        │   ├── profile/              #   个人信息
        │   └── shared/               #   共享组件（LiveNotice 等）
        ├── layouts/AppShell.tsx      # 主布局（侧边导航 + 顶栏 + 角色菜单）
        ├── routes/                   # 路由配置 / 懒加载 / 权限守卫 / 角色默认页
        ├── services/                 # Axios HTTP 封装 + 各模块 API 适配器
        ├── charts/                   # ECharts 图表配置（健康趋势）
        ├── mocks/                    # MSW Mock 数据与接口处理器
        ├── types/                    # TypeScript 类型定义
        ├── utils/                    # 工具函数（浏览器定位等）
        └── styles/                   # 全局样式 + Ant Design 主题令牌
```

---

## 快速开始

### 环境要求
- Docker Desktop（唯一依赖）
- Python 3.11+ / Node.js 22+（仅本地开发需要，Docker 模式无需安装）

### 一键启动（Docker — 推荐）

```bash
docker compose up -d --build
```

首次启动会自动建表并导入演示数据，约 30 秒后就绪。

Docker 模式下的实际运行链路是：openGauss 数据库 + Flask 后端 + Nginx 托管的前端静态资源。前端不会在 Docker 镜像里启用 MSW mock，mock 只用于本地开发态。

| 服务 | 地址 |
|------|------|
| 前端 | `http://localhost:3000` |
| 后端 API | `http://localhost:5000` |

```bash
docker compose down       # 停止所有服务（数据保留）
docker compose down -v    # 停止并清除数据，下次启动重新初始化
```

### 本地开发启动

#### 后端

```bash
cd eldercare_backend

# 安装依赖
pip install -r requirements.txt

# 初始化数据库（Docker 一键方案，Windows PowerShell）
docker run --name eldercare-og -e GS_PASSWORD=Enmo@123 -p 5432:5432 -d enmotech/opengauss:latest
Get-Content -Encoding UTF8 init_demo_data.sql -Raw | docker exec -i eldercare-og gsql -U gaussdb -d postgres -p 5432

# 启动服务（默认监听 0.0.0.0:5000）
python app.py
```

> 数据库连接配置见 `db.py`，默认 `host=127.0.0.1, port=5432, user=gaussdb, password=Enmo@123, dbname=omm`。

### 前端启动

```bash
cd frontend

# 安装依赖
npm install

# 启动开发服务器（默认 http://localhost:5173）
npm run dev
```

### 两种开发模式

| 模式 | 配置 | 说明 |
|------|------|------|
| 真后端模式（默认） | `VITE_MOCK=false` | 本地前端直连后端 `localhost:5000` |
| Mock 模式 | `VITE_MOCK=true` | 仅本地 `npm run dev` 时启用，MSW 拦截 API，无需后端 |

> 配置项在本地开发环境的 `frontend/.env.development` 中修改；Docker 构建不读取这个文件。

### 演示账号

Docker 模式与真后端模式使用同一套数据库账号：

| 角色 | 用户名 | 密码 | 备注 |
|------|--------|------|------|
| 管理员 | `admin` | `admin123` | — |
| 家属 | `zhangsan` | `pass123` | 张三 |
| 老人 | `elder_zhang` | `pass123` | 张大爷 |
| 志愿者 | `vol_wangjiaming` | `pass123` | 王佳明（已审核） |
| 志愿者 | `vol_huangxin` | `pass123` | 黄鑫（待审核） |

> 仅 Mock 模式（`VITE_MOCK=true`）使用另一套账号：`admin01`/`123456`、`family01`/`123456` 等，详见 `frontend/src/mocks/fixtures/shared.ts`。

> 已验证（2026-07-19）：`admin`、`zhangsan`、`elder_zhang`、`vol_wangjiaming` 可正常登录；`vol_huangxin` 登录后状态为 `pending_review`。

> 说明：这些账号是 openGauss 数据库中的真实账号数据，前端页面本身不直接连数据库。

---

## 核心流程

### 订单状态机

```
pending ──> accepted ──> in_progress ──> completed
                                              │
                                   家属确认时长 ──> 计入志愿时长
```

### 抢单防超卖

使用 PostgreSQL `SELECT ... FOR UPDATE` 悲观锁，保证高并发下同一订单不被多人抢走。

### 健康异常自动告警

老人打卡时自动检测血压/体温/血氧异常 → 写入 `alerts` 表 → 通过邮件通知绑定家属和管理员。数据库层另有 `trg_health_alert` 触发器作为双重保障。

### 志愿时长审核

志愿者完成服务 → 家属确认时长 → 若声明时长超过预估 1.5 倍，转管理员审核 → 审核通过后计入 `total_hours` / `weekly_hours`。

### 每周结算

管理员触发结算 → TOP3 志愿者自动获得荣誉奖章 → 全站 `weekly_hours` 清零。

### 智能陪聊（AI Companion）

老人端提供语音交互式智能陪聊，流程如下：

```
老人说话 → 浏览器录音(WebM) → Groq Whisper 转文字 → Groq LLM 生成回复 → Edge TTS 朗读 MP3
```

- **语音转文字**：浏览器 `MediaRecorder` 录音 → `POST /api/elder/companion/transcribe` → Groq `whisper-large-v3`
- **AI 对话**：`POST /api/elder/companion/chat` → Groq `llama-3.1-8b-instant`，自动注入老人画像（年龄、住址、病史、**家属填写的性格简介**）
- **朗读回复**：`POST /api/elder/companion/tts` → Microsoft Edge TTS（`zh-CN-XiaoxiaoNeural` 女声），无需 API Key、完全免费
- **自动朗读开关**：老人可在界面上打开/关闭自动朗读
- **聊天历史持久化**：对话自动保存到 `companion_chat_history` 表，支持清空、编辑已发消息、重新生成 AI 回复

**AI 配置由总管理员在"智能陪聊配置"页面集中管理**（路径：`/admin/ai-settings`），可修改：
- Groq API Key、对话模型、转写模型
- 自定义模型（DeepSeek / 豆包 / GPT 等 OpenAI 兼容接口）
- TTS 语音角色、语速、音量
- 系统提示词（用于控制 AI 助手的语气和知识范围）

配置保存在 `ai_service_settings` 表中，修改后立即生效，无需重启。

### 智能调度（Intelligent Dispatch）

基于高德地图的智能派单引擎，核心流程：

```
家属发布需求 → 系统匹配候选志愿者（同区县 + 技能标签匹配）→ A* 路径规划 + 疲劳度评分 + 距离排序
    → 按优先级推送 → 志愿者抢单/系统指派 → 实时位置追踪 → 服务完成确认
```

- **区域隔离**：基于高德行政区划 adcode，订单只对同区县志愿者可见
- **候选评分**：综合技能匹配度、历史好评率、当前任务负载、疲劳度（连续工作时长）
- **路径规划**：A\* 算法基于真实路网估算距离，结合高德驾车路径
- **调度看板**：管理员可查看全局调度状态、工单流转、志愿者分布热力图

### 健康周报（Weekly Report）

```
每周自动/手动触发 → 汇总近7天健康数据（血压/心率/血氧等） + 病历 + 性格简介
    → 调用 AI 模型生成个性化健康评估与建议 → Markdown 模板渲染 → 老人端查看
```

- 支持 3 套周报模板风格（温馨关怀 / 专业医疗 / 简洁摘要）
- AI 模型可独立配置（`REPORT_API_KEY` 等环境变量），不与陪聊模型共用
> 出于安全考虑，GitHub 仓库中的初始 SQL 不含 API Key，首次启动后需由管理员在后台配置。

---

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DB_HOST` | `127.0.0.1` | 数据库主机（Docker 内为 `db`） |
| `DB_PORT` | `5432` | 数据库端口 |
| `DB_USER` | `gaussdb` | 数据库用户 |
| `DB_PASSWORD` | `Enmo@123` | 数据库密码 |
| `DB_NAME` | `omm` | 数据库名 |
| `AMAP_WEB_KEY` | *(内置演示 Key)* | 高德 Web 服务 Key（需开通「行政区域查询」「地理编码」「逆地理编码」） |
| `GROQ_API_KEY` | *(空)* | Groq API Key（语音转写 + 对话模型） |
| `GROQ_CHAT_MODEL` | `llama-3.1-8b-instant` | Groq 对话模型名 |
| `GROQ_TRANSCRIBE_MODEL` | `whisper-large-v3` | Groq 语音转写模型名 |
| `CHAT_API_KEY` | *(空)* | 自定义对话模型 API Key（OpenAI 兼容接口） |
| `CHAT_API_BASE_URL` | *(空)* | 自定义对话模型 Base URL |
| `CHAT_MODEL_NAME` | *(空)* | 自定义对话模型名称 |
| `REPORT_API_KEY` | *(空)* | 智能周报专用模型 API Key |
| `REPORT_API_BASE_URL` | *(空)* | 智能周报专用模型 Base URL |
| `REPORT_MODEL_NAME` | *(空)* | 智能周报专用模型名称 |
| `EDGE_TTS_VOICE` | `zh-CN-XiaoxiaoNeural` | Edge TTS 语音角色 |
| `EDGE_TTS_RATE` | `+0%` | TTS 语速 |
| `EDGE_TTS_VOLUME` | `+0%` | TTS 音量 |
| `COMPANION_SYSTEM_PROMPT` | *(内置中文提示词)* | AI 陪聊系统提示词 |
| `TZ` | `Asia/Shanghai` | 时区（所有容器统一 UTC+8） |

> AI 相关配置也可以在管理员后台「智能陪聊配置」页面实时修改，无需重启服务。

---

## 设计亮点

- **适老化设计**：老人角色页面自动启用 `elder-mode` 大字体样式
- **区域隔离**：基于高德行政区划边界，老人/志愿者/管理员按区县隔离数据，支持多边形精确匹配
- **智能调度**：A\* 路径规划 + 志愿者疲劳度评分 + 多维候选排序，自动匹配最优服务人员
- **防刷赞**：数据库 `UNIQUE KEY` 约束，同一用户不可重复点赞
- **抢单防超卖**：PostgreSQL `SELECT ... FOR UPDATE` 悲观锁
- **字段自动转换**：后端 `after_request` 钩子自动将响应 JSON 的 snake_case 转为前端友好的 camelCase
- **懒加载路由**：按角色拆分 bundle，减少首屏加载体积
- **演示数据完备**：`init_demo_data.sql` 包含 72 个用户、37 位老人、35 条健康记录、14 个订单等
- **老人性格简介**：家属绑定时可填写简介（选填，200 字内），志愿者接单时可见，便于个性化服务；老人本人不可见
- **聊天历史持久化**：陪聊对话自动落库，切页或刷新不丢失，支持编辑已发消息和重新生成回复
- **Docker 时区统一**：所有容器均配置 `TZ=Asia/Shanghai` (UTC+8)，确保时间戳与业务一致
- **健康周报**：基于老人一周健康数据 + 病历 + 性格简介，由 AI 模型生成个性化健康周报（3 套模板风格可选）

---

## API 概览

Base URL: `http://localhost:5000/api`

所有接口统一响应格式：`{ code: number, message: string, data: ... }`

### 认证模块 (`/auth`)
| 端点 | 方法 | 说明 |
|------|------|------|
| `/auth/register` | POST | 多角色注册（老人需完整地址+高德核验，志愿者需技能+服务区县） |
| `/auth/login` | POST | 统一登录 |
| `/auth/forgot-password` | POST | 忘记密码 |
| `/auth/regions/children` | GET | 查询行政区划下级列表 |

### 老人模块 (`/elder`)
| 端点 | 方法 | 说明 |
|------|------|------|
| `/elder/health/checkin` | POST | 健康打卡（血压/心率/血氧/血糖/体温/体重，异常自动告警） |
| `/elder/sos` | POST | 一键 SOS 紧急求助（邮件通知家属+志愿者） |
| `/elder/services` | GET | 查看个人服务记录 |
| `/elder/companion/chat` | POST | AI 陪聊对话 |
| `/elder/companion/transcribe` | POST | 语音转文字（Groq Whisper） |
| `/elder/companion/tts` | POST | 文字转语音（Edge TTS MP3） |
| `/elder/companion/history` | GET/DELETE | 陪聊历史管理 |
| `/elder/weekly-report` | GET | 获取最新健康周报 |
| `/elder/weekly-report/generate` | POST | 生成健康周报（AI 模型） |

### 家属模块 (`/family`)
| 端点 | 方法 | 说明 |
|------|------|------|
| `/family/bind-elder` | POST | 绑定长辈（含性格简介） |
| `/family/elder-health-chart/:id` | GET | 近 7 天健康趋势 |
| `/family/orders/publish` | POST | 发布服务需求订单 |
| `/family/orders` | GET | 订单列表 |
| `/family/elders/:id/bio` | PUT | 更新老人性格简介 |
| `/family/live-tracking` | GET | 实时追踪志愿者位置 |

### 志愿者模块 (`/volunteer`)
| 端点 | 方法 | 说明 |
|------|------|------|
| `/volunteer/orders/available` | GET | 任务大厅（待接单列表） |
| `/volunteer/orders/grab` | POST | 抢单（悲观锁防超卖） |
| `/volunteer/leaderboard` | GET | 荣誉排行榜（按区域/全局） |
| `/volunteer/profile` | GET/PUT | 个人资料与成就 |

### 管理员模块 (`/admin`)
| 端点 | 方法 | 说明 |
|------|------|------|
| `/admin/dashboard/stats` | GET | 数据看板概览 |
| `/admin/users` | GET | 用户管理列表 |
| `/admin/volunteers/approve` | POST | 志愿者审核 |
| `/admin/weekly-settlement` | POST | 每周结算（TOP3 授予荣誉） |
| `/admin/hour-reviews` | GET/POST | 时长审计 |
| `/admin/ai-config` | GET/PUT | AI 陪聊配置管理 |
| `/admin/regions` | GET/POST | 区县区域管理 |

### 调度模块 (`/dispatch`)
| 端点 | 方法 | 说明 |
|------|------|------|
| `/dispatch/orders` | GET/POST | 调度工单管理 |
| `/dispatch/candidates` | GET | 候选志愿者评分排序 |
| `/dispatch/routes` | GET | 路径规划结果 |
| `/dispatch/board` | GET | 调度看板总览 |

### 会话模块 (`/conversations`)
| 端点 | 方法 | 说明 |
|------|------|------|
| `/conversations` | GET/POST | 会话列表与创建 |
| `/conversations/:id/messages` | GET/POST | 会话消息收发 |

### 公开模块 (`/public`)
| 端点 | 方法 | 说明 |
|------|------|------|
| `/public/task-hall` | GET | 公开任务大厅（无需登录浏览） |
| `/public/donate` | GET/POST | 捐款记录查询与创建 |

> 完整 API 文档见 `eldercare_backend/jieko.md`。

---

## 开发指南

### 分支策略
- `main` — 稳定发布分支
- `dev` — 开发集成分支
- `feature/*` — 功能开发分支

### 代码规范
- **后端**：遵循 PEP 8，使用 `from __future__ import annotations` 延迟类型求值
- **前端**：TypeScript 严格模式，ESLint + Prettier，路径别名 `@/` 映射到 `src/`
- **提交信息**：建议使用 Conventional Commits 格式

### 添加新功能
1. **后端**：在 `routes/` 下创建或扩展蓝图 → 在 `app.py` 注册
2. **前端**：在 `features/` 下创建功能模块 → 在 `routes/route-config.tsx` 注册路由 → 在 `services/adapters/` 添加 API 适配器
3. **数据库变更**：编写独立迁移 SQL 文件（如 `migrate_*.sql`），由 `app.py` 的 `init_db()` 自动检测执行

> 本地启动步骤见上方「快速开始 → 本地开发启动」。

---

## 生产部署

### 环境检查
- Docker 20.10+
- 确保 `AMAP_WEB_KEY` 已配置为有效的高德 Web 服务 Key
- 生产环境务必修改数据库默认密码 `Enmo@123`

### 部署步骤
```bash
# 1. 克隆仓库
git clone <repo-url> && cd eldercare

# 2. 配置环境变量（可选，创建 .env 文件）
echo "AMAP_WEB_KEY=your_real_key" > .env
echo "GROQ_API_KEY=gsk_your_key" >> .env

# 3. 启动
docker compose up -d --build

# 4. 验证
curl http://localhost:5000/
curl http://localhost:3000/
```

### 数据备份
```bash
# 导出数据库
docker exec eldercare-db gs_dump -U gaussdb -d omm -F c -f /tmp/backup.dump
docker cp eldercare-db:/tmp/backup.dump ./backup_$(date +%Y%m%d).dump
```

---

## License

纯公益项目，无商业用途。
