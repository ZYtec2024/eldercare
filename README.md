# 智慧伴老平台 (ElderCare Platform)

面向社区养老的纯公益 Web 应用系统。连接**老人**、**家属**、**志愿者**、**管理员**四类角色，提供健康打卡、SOS 紧急求助、公益服务任务调度、志愿时长管理、荣誉激励等功能。

---

## 角色与核心功能

| 角色 | 核心功能 |
|------|----------|
| **老人** | 每日健康打卡、一键 SOS 求助、查看服务记录、评价志愿者 |
| **家属** | 绑定长辈、健康趋势图表、发布公益服务需求、确认服务时长 |
| **志愿者** | 任务大厅抢单、服务执行、个人成就、荣誉排行榜 |
| **管理员** | 用户管理、志愿者审核、告警处理、时长审计、每周结算、数据看板；总管可开通区县、绑定/解绑区管理员、区县隔离派单 |

---

## 本分支新增（相对 master）

本仓库当前功能分支在 Docker 一键栈之上，补充了**区县调度与区域管理**能力，主要包括：

- 总管理员开通可调度区县（省 → 市 → 区），并从高德拉取官方行政区边界
- 开通时绑定区管理员；已开通区可再绑定 / 在弹窗中多选解绑
- 未开通或已停用的区县：禁止新落点、新下单、SOS
- 智能派单按区县隔离（Top1 → Top3 → Top10 → 兜底等待/抢单/管理员指派）
- 用户管理支持按区县筛选老人 / 家属

启用方式与 master 相同：检出本分支后执行下面的 `docker compose up -d --build` 即可。

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
├── docker-compose.yml               # 一键启动编排（db + backend + frontend）
├── eldercare_backend/                # Flask 后端
│   ├── Dockerfile                    # 后端容器镜像
│   ├── entrypoint.sh                 # 启动脚本（等待数据库就绪）
│   ├── app.py                        # 应用入口
│   ├── db.py                         # 数据库连接配置
│   ├── region_service.py             # 行政区目录 / 官方多边形（高德）
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
│       ├── dispatch.py               # 区县调度 / 区域管理 / 派单时钟
│       └── public.py                 # 公开任务大厅
│
└── frontend/                         # React + Vite 前端
    ├── Dockerfile                    # 前端容器镜像（多阶段构建）
    ├── nginx.conf                    # Nginx 反向代理（含 /api/ → backend）
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
- Docker Desktop（唯一依赖；请先启动 Docker Desktop）
- Python 3.11+ / Node.js 22+（仅本地开发需要，Docker 模式无需安装）

### 一键启动（Docker — 推荐）

**速览（和常见疑问）：**

1. **怎么启动**
   ```bash
   git checkout feat/region-dispatch-docker   # 切到本功能分支
   docker compose up -d --build            # 根目录执行
   ```
   打开 `http://localhost:3000`，总管账号 `admin` / `admin123` → **区域管理**。

2. **主分支和功能分支的 Docker 名字一样会冲突吗？**  
   Git 里的文件不会自动打架；冲突的是**本机正在跑的容器**。两边若都用 `eldercare-*` 容器名、端口 `3000` / `5000` / `5432`、数据卷 `ogdata`，同一台机器上**不能同时跑两套**。  
   切到另一分支后再执行 `docker compose up -d --build`，是**重建/替换当前这一套**（用当前工作区代码），不是两个分支各跑一套。

3. **怎么把 Docker 文件发到远程分支？**  
   Docker 相关文件就是普通源码，和业务代码一样 `add` → `commit` → `push` 即可（见下方「如何把 Docker 相关改动推到远程分支」）。不要提交含密钥的 `.env`。

---

在项目根目录（有 `docker-compose.yml` 的目录）执行：

```bash
# 1. 切到目标分支（示例：本功能分支）
git checkout feat/region-dispatch-docker

# 2. （可选）配置高德 Web 服务 Key，用于行政区查询 / 官方边界
#    也可不设：compose 内有默认值；生产/演示建议用自己的 Key
#    Windows PowerShell:
#      $env:AMAP_WEB_KEY="你的Key"
#    或在项目根目录建 .env（已被 gitignore，不会提交）：
#      AMAP_WEB_KEY=你的Key

# 3. 构建并后台启动：数据库 + 后端 + 前端
docker compose up -d --build
```

首次启动会自动建表并导入演示数据；后端有健康检查，前端会等后端就绪后再起。整栈通常约 1～2 分钟就绪。

| 服务 | 容器名 | 地址 |
|------|--------|------|
| 前端 | `eldercare-frontend` | `http://localhost:3000` |
| 后端 API | `eldercare-backend` | `http://localhost:5000` |
| openGauss | `eldercare-db` | `localhost:5432` |

常用命令：

```bash
docker compose ps                 # 查看状态
docker compose logs -f backend    # 看后端日志
docker compose up -d --build      # 改代码后重新构建并启动
docker compose down               # 停止（数据卷保留）
docker compose down -v            # 停止并清空数据库卷（下次会重新导入演示数据）
```

Docker 模式下的运行链路：`openGauss` → `Flask` → `Nginx` 托管前端静态资源。镜像内**不会**启用 MSW mock。

区域管理入口（总管理员）：登录后打开 **区域管理**（`/admin/regions`）。演示总管账号见下方「演示账号」。

#### 分支与 Docker 会不会冲突？（详细说明）

**会冲突的是本机正在跑的容器 / 端口 / 数据卷，不是 Git 分支文件本身。**

| 层面 | 说明 |
|------|------|
| Git 分支 | `master` 与功能分支可以各自保存一份 `docker-compose.yml` / `Dockerfile`，互不覆盖，直到你合并。 |
| 本机 Docker | compose 里写死了相同容器名（`eldercare-*`）、端口（`3000` / `5000` / `5432`）和数据卷名（`ogdata`）。同一台机器上**不能同时**跑两套同名栈。 |
| 切换分支后 | 检出另一分支再 `docker compose up -d --build`，会**重建/替换**当前这套同名容器；用的是**当前工作区里的代码**，不是「两个分支各跑一套」。 |
| 数据 | 默认共用卷 `ogdata`。换分支重建后，库里的演示/业务数据通常还在；只有 `docker compose down -v` 才会清库。 |

因此：日常在同一台电脑上，**同一时间只启动当前检出分支对应的那一套**即可。若必须并行两套，需要改端口、`container_name` 和 volume 名，或使用不同的 compose project 名（例如 `docker compose -p eldercare-feature up -d --build`），本仓库默认未拆成两套。

#### 如何把 Docker 相关改动推到远程分支

Docker 文件就是普通源码（根目录 `docker-compose.yml`、`eldercare_backend/Dockerfile`、`frontend/Dockerfile`、`frontend/nginx.conf` 等）。推送步骤示例：

```bash
git status
git add docker-compose.yml eldercare_backend/Dockerfile frontend/Dockerfile frontend/nginx.conf README.md
# 按需再 add 业务代码…
git commit -m "docs: explain Docker startup and region dispatch stack"
git push -u origin HEAD
```

> 不要提交 `.env`（含密钥）；用环境变量或本地 `.env` 配置 `AMAP_WEB_KEY`。

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
| 总管理员 | `admin` | `admin123` | 可开通区县、绑定/解绑区管理员（区域管理） |
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
