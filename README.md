# 智慧伴老平台 (ElderCare Platform)

面向社区养老的纯公益 Web 应用系统。连接**老人**、**家属**、**志愿者**、**管理员**四类角色，提供健康打卡、SOS 紧急求助、公益服务任务调度、志愿时长管理、荣誉激励等功能。

---

## 角色与核心功能

| 角色 | 核心功能 |
|------|----------|
| **老人** | 每日健康打卡、一键 SOS 求助、查看服务记录、评价志愿者 |
| **家属** | 绑定长辈、健康趋势图表、发布公益服务需求、确认服务时长 |
| **志愿者** | 任务大厅抢单、服务执行、个人成就、荣誉排行榜 |
| **管理员** | 用户管理、志愿者审核、告警处理、时长审计、每周结算、数据看板 |

---

## 技术栈

### 后端
| 技术 | 版本 | 说明 |
|------|------|------|
| Python | 3.11 | 运行环境 |
| Flask | 3.0 | Web 框架 |
| Flask-CORS | 4.0 | 跨域支持 |
| psycopg2 | 2.9 | PostgreSQL 数据库驱动 |
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
| MSW | 2.12 | Mock Service Worker（无后端演示） |

### 数据库
- **openGauss / PostgreSQL 兼容模式**，Docker 运行时由 `db` 服务提供，后端默认连接 `omm` 库
- 11 张核心表 + 2 个视图 + 1 个触发器

---

## 项目结构

```
eldercare/
├── docker-compose.yml               # 一键启动编排
├── eldercare_backend/                # Flask 后端
│   ├── Dockerfile                    # 后端容器镜像
│   ├── entrypoint.sh                 # 启动脚本（等待数据库就绪）
│   ├── app.py                        # 应用入口
│   ├── db.py                         # 数据库连接配置
│   ├── utils.py                      # 工具函数（响应、邮件、业务逻辑）
│   ├── requirements.txt              # Python 依赖
│   ├── jieko.md                      # API 接口文档
│   ├── init_demo_data.sql            # 建表 + 演示数据
│   └── routes/
│       ├── auth.py                   # 注册/登录/忘记密码
│       ├── profile.py                # 个人信息
│       ├── elder.py                  # 健康打卡/SOS/服务评价
│       ├── family.py                 # 绑定/健康趋势/服务订单
│       ├── volunteer.py              # 任务大厅/抢单/排行榜
│       ├── admin.py                  # 用户管理/看板/结算
│       └── public.py                 # 公开任务大厅
│
└── frontend/                         # React + Vite 前端
    ├── Dockerfile                    # 前端容器镜像（多阶段构建）
    ├── nginx.conf                    # Nginx 反向代理配置
    ├── package.json
    ├── vite.config.ts
    ├── index.html
    └── src/
        ├── main.tsx                  # 启动入口
        ├── app/App.tsx               # 根组件
        ├── features/                 # 功能模块
        │   ├── auth/                 #   登录/注册/忘记密码
        │   ├── elder/                #   老人功能
        │   ├── family/               #   家属功能
        │   ├── volunteer/            #   志愿者功能
        │   ├── admin/                #   管理员功能
        │   ├── home/                 #   公开首页
        │   ├── public/               #   公开任务大厅
        │   └── profile/              #   个人信息
        ├── layouts/AppShell.tsx      # 主布局（侧边导航+顶栏）
        ├── routes/                   # 路由配置与守卫
        ├── services/                 # API 适配层
        ├── mocks/                    # MSW Mock 数据
        ├── types/                    # TypeScript 类型定义
        └── styles/                   # 全局样式
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
| Mock 模式（本地开发默认） | `VITE_MOCK=true` | 仅本地 `npm run dev` 时启用，MSW 拦截 API，无需后端 |
| 真后端模式 | `VITE_MOCK=false` | 本地前端直连后端 `localhost:5000` |

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

---

## 设计亮点

- **适老化设计**：老人角色页面自动启用 `elder-mode` 大字体样式
- **防刷赞**：数据库 `UNIQUE KEY` 约束，同一用户不可重复点赞
- **字段自动转换**：后端 `after_request` 钩子自动将响应 JSON 的 snake_case 转为前端友好的 camelCase
- **懒加载路由**：按角色拆分 bundle，减少首屏加载体积
- **演示数据完备**：`init_demo_data.sql` 包含 16 个用户、35 条健康记录、14 个订单、12 条点赞等

---

## API 概览

Base URL: `http://localhost:5000/api`

所有接口统一响应格式：`{ code: number, message: string, data: ... }`

| 模块 | 端点示例 | 说明 |
|------|----------|------|
| Auth | `POST /auth/login` | 登录 |
| Auth | `POST /auth/register` | 多角色注册 |
| Elder | `POST /elder/health/checkin` | 健康打卡 |
| Elder | `POST /elder/sos` | SOS 求助 |
| Family | `GET /family/elder-health-chart/:id` | 近7天健康趋势 |
| Family | `POST /family/orders/publish` | 发布服务需求 |
| Volunteer | `POST /volunteer/orders/grab` | 抢单 |
| Volunteer | `GET /volunteer/leaderboard` | 荣誉排行榜 |
| Admin | `GET /admin/dashboard/stats` | 大屏统计 |
| Admin | `POST /admin/weekly-settlement` | 每周结算 |

> 完整 API 文档见 `eldercare_backend/jieko.md`。

---

## License

纯公益项目，无商业用途。
