# 公网部署前的安全配置

本地 `http://127.0.0.1:3000` 只用于回环地址演示，Compose 默认也只将
3000、5000、5432 绑定到 `127.0.0.1`，不会直接开放给局域网。公网部署必须：

1. 申请域名和有效 TLS 证书，参考 `deploy/nginx/eldercare-https.conf.example` 启用 HTTPS。
2. 在 `.env` 设置至少 32 字节的随机 `SECRET_KEY`。
3. 设置 `SESSION_COOKIE_SECURE=true`，然后重新构建后端。
4. 设置 `APP_ENV=production`，让容器使用 Gunicorn，而不是 Flask 开发服务器。
   当前调度时钟仍在应用进程中运行，因此 `WEB_CONCURRENCY` 保持为 `1`，通过线程处理并发。
5. 设置 `ALLOW_DEMO_PASSWORD_RESET=false`。在短信/邮件验证码流程完成前，公网环境不开放演示式密码重置。
6. 将 `CORS_ORIGINS` 设置为实际 HTTPS 前端域名，不能使用 `*`。
7. 不要把数据库 5432 或后端 5000 端口直接暴露到公网，只开放反向代理的 80/443。
8. 将高德 Key、数据库密码和 AI Key 改为部署平台的 Secret，不提交真实密钥。

浏览器仍会在开发者工具中显示登录请求内容，这是客户端自身可见的正常现象；
HTTPS 负责保证密码在浏览器到服务器的网络链路上不可被明文抓取。服务器只保存
带随机盐的 scrypt 哈希，登录状态使用 HttpOnly、SameSite 签名 Cookie。
