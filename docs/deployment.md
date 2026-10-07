# AutoMatic 云服务器部署流程

本文按当前项目实现编写，适用于首次上线和后续更新。采用 Ubuntu 24.04 LTS、Node.js 22、pnpm 9.15.4、Nginx、systemd 和 PostgreSQL 17。PostgreSQL 使用 Docker Compose，前端和 API 运行在宿主机。

当前服务器已部署在 <https://180.76.248.209>，使用 Nginx、systemd 和 PostgreSQL，并已配置 IP HTTPS 证书自动续期、每日备份。后续自动发布、专用 SSH 部署账号、发布包校验与回滚见 [CI/CD 操作与学习指南](ci-cd.md)。

本文下面的命令保留为新服务器的手工安装和故障恢复参考；示例域名为 `app.example.com`，所有域名、IP、邮件配置和密钥占位值都需要替换。不要在已有生产服务器重复初始化数据库或更换 JWT 密钥。

## 1. 部署结构与前置条件

```mermaid
flowchart LR
  Browser[浏览器] -->|HTTPS 443| Nginx[Nginx]
  Nginx -->|静态文件| Web[前端构建产物]
  Nginx -->|保留 /api 路径| API[127.0.0.1:3000 Node.js API]
  API --> DB[127.0.0.1:5432 PostgreSQL]
  API --> Resend[注册验证码邮件]
  API --> WeChat[微信公众号接口]
```

准备以下资源：

| 项目     | 建议                                                                              |
| -------- | --------------------------------------------------------------------------------- |
| 云服务器 | Ubuntu 24.04 LTS，2 核 CPU、4 GB 内存、40 GB 以上 SSD 起步                        |
| 构建资源 | 编辑器依赖较多，构建阶段预留 4-8 GB 内存；资源紧张时在 CI 或另一台 Linux 机器构建 |
| 网络     | 固定公网 IP，允许访问 npm、NodeSource、容器镜像仓库、Resend 和微信 HTTPS 接口     |
| 域名     | 如 `app.example.com`，A 记录指向云服务器公网 IPv4                                 |
| SSH      | 能以有 sudo 权限的账号登录；本文使用 `ubuntu` 作为示例                            |
| 邮件     | Resend API Key，以及在 Resend 验证过的发信域名                                    |
| 微信     | 需要发布时，准备具备相应接口权限的公众号 AppID 和 AppSecret                       |

云服务器安全组开放 80 和 443；22 仅允许你的管理 IP。API 的 3000、开发服务器的 5173 和数据库的 5432 无需对公网开放。

如果配置 AAAA 记录，服务器也必须能通过相应 IPv6 地址提供服务；没有配置 IPv6 时仅设置 A 记录。中国大陆服务器通过域名提供网站时，需按云服务商要求完成 ICP 备案。

### 本项目需要注意的事项

- `pnpm dev` 和 Vite 的开发代理用于开发；生产环境由 Nginx 托管 `apps/web/dist`，API 启动入口是 `apps/api/dist/server.js`。
- 前端请求使用相对路径 `/api/...`。让前端和 API 共用域名，可直接沿用现有代码。
- 生产环境的 Refresh Cookie 带 `Secure` 属性，正式使用必须通过 HTTPS。
- `NODE_ENV=production` 时，`DEV_ADMIN_ENABLED` 必须为 `false`；示例中的开发管理员不能用于上线。
- 当前生产注册不返回测试验证码。没有配置真实邮件服务时，用户无法从接口响应中获得验证码，也不会收到邮件。
- `JWT_ACCESS_SECRET` 同时用于派生微信 AppSecret 的加密密钥。常规发布必须保留原密钥，数据库恢复也需要对应的原密钥；更换它后现有加密凭据无法解密，需要重新配置公众号。
- 文章、目录、回收站和发布记录接入 PostgreSQL，首次登录会迁移当前站点已有的本地文章；界面偏好和自定义主题仍保存在浏览器。迁移功能需要发布包含 `005_articles.sql` 的前后端版本才能生效。
- PostgreSQL 持久化账号、会话、文章、品牌素材图片、公众号配置，以及协同接口写入的数据。数据库备份包含已成功保存的文章，不包含浏览器中尚未上传的修改。

## 2. 安装服务器软件

登录服务器，以下 bash 命令在云服务器执行：

```bash
ssh ubuntu@YOUR_SERVER_IP
sudo apt-get update
sudo apt-get install -y ca-certificates curl openssl nano nginx certbot python3-certbot-nginx docker.io docker-compose-v2
```

安装 Node.js 22。Ubuntu 默认仓库里的 Node.js 版本可能不符合本项目要求；下面使用 NodeSource 的 22.x 软件源：

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/automatic-nodesource.sh
sudo bash /tmp/automatic-nodesource.sh
sudo apt-get install -y nodejs
sudo npm install -g pnpm@9.15.4
node --version
pnpm --version
command -v node
sudo docker compose version
sudo systemctl enable --now docker nginx
```

预期 Node.js 为 22.x，pnpm 为 9.15.4，Node 可执行文件位于 `/usr/bin/node`。如果实际路径不同，修改后文 systemd 的 `ExecStart`。

如果启用了 UFW，先允许 SSH，再开放 Web 端口：

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status
```

使用自定义 SSH 端口时，先放行实际端口。云安全组和服务器防火墙都需要允许 Web 访问。

## 3. 创建运行账号与目录

创建单独的系统账号运行 API、安装依赖和构建：

```bash
sudo adduser --system --group --home /srv/automatic automatic
sudo install -d -o automatic -g automatic -m 755 /srv/automatic/releases
sudo install -d -o automatic -g automatic -m 700 /srv/automatic/shared
sudo install -d -o automatic -g automatic -m 755 /var/www/automatic/assets
sudo chmod 755 /srv/automatic
```

目录用途：

```text
/srv/automatic/
  releases/                  每个版本独立保存源码、依赖和构建产物
  current -> releases/...    当前启用版本
  shared/
    api.env                  生产 API 配置
    postgres.env             数据库管理员配置
    compose.yaml             生产数据库服务
/var/www/automatic/assets/   保留多个版本的带 hash 静态资源
```

保留旧静态资源可减少更新后已打开页面加载旧分块文件时出现的 404。`shared` 目录仅运行账号和 root 可访问，Nginx 只读取前端构建产物和公开静态资源。

## 4. 从本地上传完整源码

当前工作区存在未提交修改，`packages/blocksuite` 是 Git 子模块，但根目录没有 `.gitmodules`。首次部署使用完整源码包，包含当前 BlockSuite 源码和 UI 修改。

在本地 Windows PowerShell 执行，先确认前面的修改就是要上线的版本：

```powershell
Set-Location D:\code\AutoMatic
git status --short
tar -czf automatic-source.tar.gz --exclude=node_modules --exclude=.git --exclude=.env --exclude='.env.*' --exclude=dist --exclude=apps/api/data --exclude=apps/api/uploads package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json apps packages
scp .\automatic-source.tar.gz ubuntu@YOUR_SERVER_IP:/tmp/automatic-source.tar.gz
```

该包包含源代码和锁文件，排除了本机依赖、Git 元数据、环境文件及构建输出。Windows 的 `node_modules` 不适合作为 Linux 的依赖部署，服务器上重新安装。

解包到一个新的版本目录，在服务器执行：

```bash
release_id="$(date -u +%Y%m%dT%H%M%SZ)"
release_dir="/srv/automatic/releases/$release_id"
sudo install -d -o automatic -g automatic -m 755 "$release_dir"
sudo -u automatic tar -xzf /tmp/automatic-source.tar.gz -C "$release_dir"
printf '%s\n' "$release_dir"
test -f "$release_dir/packages/blocksuite/packages/blocks/package.json"
test -f "$release_dir/apps/api/migrations/001_auth.sql"
```

记住输出的版本目录；后续命令使用同一 SSH 会话中的 `release_dir`。重新连接 SSH 后，需要将它设为实际目录。

项目已配置子模块 URL 和 `patches/blocksuite/` 补丁，GitHub CI 会检出固定上游提交并应用补丁。后续子模块新增修改需保存为补丁，或提交到可访问的 fork 再更新父仓库指针；仅提交父仓库不会包含子模块里的未提交改动。

## 5. 启动生产数据库

在服务器生成两个不同的随机数据库密码和一个 JWT 密钥，分别用于数据库管理员、应用数据库账号和 API：

```bash
openssl rand -hex 24
openssl rand -hex 24
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

数据库密码使用上述十六进制值，避免连接 URL 中特殊字符的编码问题。后续常规发布沿用已有值。

使用编辑器创建数据库环境文件：

```bash
sudo -u automatic touch /srv/automatic/shared/postgres.env
sudo chmod 600 /srv/automatic/shared/postgres.env
sudo -u automatic nano /srv/automatic/shared/postgres.env
```

内容如下，替换管理员密码：

```dotenv
POSTGRES_DB=automatic
POSTGRES_USER=automatic_admin
POSTGRES_PASSWORD=REPLACE_WITH_ADMIN_DATABASE_PASSWORD
```

创建 `/srv/automatic/shared/compose.yaml`：

```bash
sudo -u automatic nano /srv/automatic/shared/compose.yaml
```

配置如下。不要使用仓库根目录的开发数据库密码和公网端口绑定：

```yaml
name: automatic
services:
  postgres:
    image: postgres:17-alpine
    restart: unless-stopped
    env_file:
      - ./postgres.env
    ports:
      - '127.0.0.1:5432:5432'
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U $$POSTGRES_USER -d $$POSTGRES_DB']
      interval: 5s
      timeout: 5s
      retries: 10
      start_period: 5s
volumes:
  postgres_data:
```

启动并确认健康状态：

```bash
sudo docker compose -f /srv/automatic/shared/compose.yaml up -d --wait postgres
sudo docker compose -f /srv/automatic/shared/compose.yaml ps
```

创建单独的应用数据库账号，API 不使用数据库管理员账号：

```bash
sudo docker compose -f /srv/automatic/shared/compose.yaml exec postgres psql -U automatic_admin -d postgres
```

在 psql 里执行：

```sql
CREATE ROLE automatic_app LOGIN;
\password automatic_app
ALTER DATABASE automatic OWNER TO automatic_app;
\q
```

`\password` 会交互式提示输入并确认密码，使用刚才生成的应用数据库密码。该账号拥有应用数据库，可以执行项目迁移，但没有超级用户权限。

`POSTGRES_PASSWORD` 只在首次初始化空数据卷时生效；修改环境文件不会自动更改已存在的数据库密码。数据库数据存放在持久卷中，日常更新不要删除卷。

## 6. 配置生产 API 环境

```bash
sudo -u automatic touch /srv/automatic/shared/api.env
sudo chmod 600 /srv/automatic/shared/api.env
sudo -u automatic nano /srv/automatic/shared/api.env
```

填写下面的配置：

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
CORS_ORIGINS=https://app.example.com
DATABASE_URL=postgresql://automatic_app:REPLACE_WITH_APP_DATABASE_PASSWORD@127.0.0.1:5432/automatic
JWT_ACCESS_SECRET=REPLACE_WITH_GENERATED_JWT_SECRET
JWT_ISSUER=automatic-api
JWT_AUDIENCE=automatic-web
ACCESS_TOKEN_TTL=15m
REFRESH_TOKEN_TTL_DAYS=7
RESEND_API_KEY=re_REPLACE_WITH_YOUR_RESEND_KEY
RESEND_FROM="AutoMatic <verify@example.com>"
DEV_ADMIN_ENABLED=false
```

域名需要同时替换配置中的 `CORS_ORIGINS` 和后文 Nginx 的 `server_name`。`CORS_ORIGINS` 是完整来源，包含协议，不包含路径或末尾 `/`，例如 `https://app.example.com`。多个来源用逗号分隔。

在 Resend 验证实际发信域名并配置其要求的 DNS 记录，将发件人替换为该域名下的邮箱。生产注册需要 `RESEND_API_KEY` 和 `RESEND_FROM` 同时正确配置；仅填写占位值不能发送邮件。

将本次版本的 API 配置链接到共享配置：

```bash
sudo -u automatic ln -s /srv/automatic/shared/api.env "$release_dir/apps/api/.env"
```

API 从当前工作目录读取 `.env`。后文 systemd 的工作目录必须是该版本的 `apps/api`，而不是仓库根目录。

## 7. 安装依赖并构建

```bash
cd "$release_dir"
sudo -u automatic -H pnpm install --frozen-lockfile
sudo -u automatic -H pnpm check
test -f apps/web/dist/index.html
test -f apps/api/dist/server.js
test -f apps/api/dist/database/migrate.js
```

`pnpm check` 依次执行应用的类型检查、测试和构建。API 测试使用隔离的测试仓库，不能代替下一步真实 PostgreSQL 连接验证。

构建前需要开发依赖，安装时不要加 `--prod` 或提前设置全局 `NODE_ENV=production`。生产运行环境由 `api.env` 和 systemd 单独设置。

如果 `--frozen-lockfile` 提示锁文件与依赖声明不一致，应在开发环境修正并验证锁文件后重新打包发布。

Vite 的大分块体积提示属于构建警告；以命令退出码是否为 0 判断构建是否成功。如果构建被系统终止或出现内存不足，增加构建资源或改用 Linux CI 构建，不要跳过构建步骤。

## 8. 执行迁移并启用当前版本

在新版本目录执行：

```bash
cd "$release_dir"
sudo -u automatic -H pnpm db:migrate
```

预期迁移成功，或显示数据库已是最新状态。当前迁移包含账号会话、公众号配置、品牌素材和协同数据表。API 启动时也会自动执行幂等迁移；发布前显式执行有助于提前发现数据库问题。

生产入口需要保留 `apps/api/migrations`，仅上传 `apps/api/dist` 会导致启动时找不到迁移文件。

复制公开静态资源，随后用临时链接原子替换 `current`：

```bash
sudo -u automatic cp -a "$release_dir/apps/web/dist/assets/." /var/www/automatic/assets/
sudo find /var/www/automatic/assets -type d -exec chmod 755 {} +
sudo find /var/www/automatic/assets -type f -exec chmod 644 {} +
sudo ln -s "$release_dir" /srv/automatic/current-next
sudo mv -Tf /srv/automatic/current-next /srv/automatic/current
readlink -f /srv/automatic/current
```

`current` 应始终是软链接，不能是放置源码的普通目录。`current-next` 是本次切换的临时链接，执行前确认没有同名残留链接。

## 9. 使用 systemd 管理 API

```bash
sudo nano /etc/systemd/system/automatic-api.service
```

内容如下：

```ini
[Unit]
Description=AutoMatic API
Wants=network-online.target docker.service
After=network-online.target docker.service

[Service]
Type=simple
User=automatic
Group=automatic
WorkingDirectory=/srv/automatic/current/apps/api
Environment=NODE_ENV=production
ExecStart=/usr/bin/node dist/server.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
KillSignal=SIGTERM
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
UMask=0077

[Install]
WantedBy=multi-user.target
```

加载并启动：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now automatic-api
sudo systemctl status automatic-api --no-pager
curl -fsS http://127.0.0.1:3000/api/health
```

API 启动失败时先查看日志：

```bash
sudo journalctl -u automatic-api -n 100 --no-pager
sudo docker compose -f /srv/automatic/shared/compose.yaml logs --tail=100 postgres
```

API 在数据库连接和迁移成功后才监听端口。健康检查接口本身不是每次请求都检查数据库的就绪探针，因此最终还需要验证注册、登录等实际请求。

## 10. 配置 Nginx

```bash
sudo nano /etc/nginx/sites-available/automatic
```

先配置 HTTP，下一步由 Certbot 添加 HTTPS：

```nginx
server {
    listen 80;
    server_name app.example.com;
    root /srv/automatic/current/apps/web/dist;
    index index.html;
    charset utf-8;
    client_max_body_size 16m;

    gzip on;
    gzip_types text/css application/javascript application/json image/svg+xml;

    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Request-ID $request_id;
        proxy_read_timeout 90s;
    }

    location /assets/ {
        root /var/www/automatic;
        try_files $uri =404;
        add_header Cache-Control "public, max-age=604800, immutable";
    }

    location = /index.html {
        add_header Cache-Control "no-cache";
    }

    location / {
        try_files $uri $uri/ /index.html;
        add_header Cache-Control "no-cache";
    }
}
```

关键点：`proxy_pass` 的地址后不要添加 `/`，这样 `/api/auth/login` 会原样传给 API。Nginx 默认会转发 `Origin`，保留它供项目验证来源；不要照搬开发代理里删除 `Origin` 的逻辑。

在这台新服务器上启用站点。如果已存在同名启用链接，应先检查它指向的配置，避免重复创建：

```bash
sudo ln -s /etc/nginx/sites-available/automatic /etc/nginx/sites-enabled/automatic
sudo nginx -t
sudo systemctl reload nginx
curl -fsS -H 'Host: app.example.com' http://127.0.0.1/api/health
```

此时只验证 HTTP 路由；正式登录和会话恢复等到 HTTPS 配置完成后再测试。

## 11. 配置 HTTPS 与自动续期

先确认公网 DNS 已指向服务器，80/443 能从外部访问。服务器能访问证书签发服务后执行：

```bash
sudo certbot --nginx -d app.example.com --redirect
sudo nginx -t
sudo systemctl reload nginx
sudo systemctl status certbot.timer --no-pager
sudo certbot renew --dry-run
curl -fsS https://app.example.com/api/health
curl -I https://app.example.com/
curl -I http://app.example.com/
```

签发过程中填写证书通知邮箱，并确认 HTTP 重定向到 HTTPS。`renew --dry-run` 应通过，`certbot.timer` 应处于启用状态。如果环境不允许使用 Certbot，可使用云服务商签发的证书，安装到 Nginx 并建立相应续期流程。

以后始终使用 `https://app.example.com` 访问应用。修改网站域名时，同时更新 DNS、Nginx、TLS 证书和 `CORS_ORIGINS`。

## 12. 上线验收与微信配置

依次检查：

1. HTTPS 页面和所有 JS/CSS 请求正常，浏览器控制台没有资源 404。
2. 使用真实邮箱获取注册验证码，邮件能送达；生产接口响应不包含 `testCode`。
3. 注册、退出、重新登录正常。刷新页面或重新打开浏览器后，未过期会话可以恢复。
4. 浏览器中的 `automatic_refresh_token` 为 HttpOnly、Secure、SameSite=Lax；不要把它或 Access Token 写入截图、工单或日志。
5. 编辑、新建文章和预览正常。等待显示“已保存”，用新的浏览器登录同一账号，确认正文、图片及回收站内容仍在。
6. 品牌素材上传后能重新读取，真实数据库连接正常。
7. 关闭 SSH 会话后页面仍可使用；在维护窗口重启服务器后，Docker、数据库、API 和 Nginx 能自动恢复。

生产环境不会创建本地默认管理员。通过真实验证码注册账号；如需生产管理员，应另行设计受控的管理员初始化流程。

要使用微信发布，还需：

1. 将服务器实际出站公网 IP 加入公众号后台的接口 IP 白名单。如果经过 NAT 网关，出站地址可能和服务器入站 IP 不同。
2. 在应用的微信发布配置中填写对应公众号的 AppID、AppSecret 和默认作者等信息。前端代码和源码仓库不存放 AppSecret。
3. 确认公众号具备项目使用的草稿和发布接口权限。页面可打开不等于账号已具备微信接口权限。
4. 用明确允许发布的测试内容验证图片上传、提交和发布状态查询。当前“一键发布”会先创建微信草稿再提交正式发布，这一步会对外产生实际发布行为。

## 13. 后续版本更新与回滚

### 一键更新（启用 CI/CD 后）

推荐按 [CI/CD 操作与学习指南](ci-cd.md) 完成 GitHub 配置及服务器发布命令升级，之后在本地执行：

```powershell
pnpm deploy:prod                    # 复用 master 当前提交已通过 CI 的包
pnpm release 1.2.3                  # 保存带版本号的包并部署
pnpm deploy:prod --tag v1.2.3        # 部署已保存版本
pnpm deploy:status                  # 查询生产版本
pnpm rollback                       # 回滚上一版代码
```

这些命令默认等待 GitHub 任务完成。CI/CD 安装后 release 目录由 root 管理，使用受限发布入口完成备份、迁移、切换和健康检查；不要再直接套用下面以 `automatic` 账号构建的旧流程。回滚代码不恢复数据库。

### 尚未启用 CI/CD 时的手动更新

首先记录当前版本并做数据库备份，再从本地上传新的源码包：

```bash
previous_release="$(readlink -f /srv/automatic/current)"
printf 'Previous release: %s\n' "$previous_release"
sudo install -d -m 700 /var/backups/automatic
backup_file="/var/backups/automatic/predeploy-$(date -u +%Y%m%dT%H%M%SZ).dump"
sudo bash -c 'umask 077; docker compose -f /srv/automatic/shared/compose.yaml exec -T postgres pg_dump -U automatic_admin -d automatic -Fc > "$1"' bash "$backup_file"
sudo test -s "$backup_file"
```

重复第 4 节解包，创建新的 `release_dir`。然后依次执行：

```bash
sudo -u automatic ln -s /srv/automatic/shared/api.env "$release_dir/apps/api/.env"
cd "$release_dir"
sudo -u automatic -H pnpm install --frozen-lockfile
sudo -u automatic -H pnpm check
sudo -u automatic -H pnpm db:migrate
sudo -u automatic cp -a "$release_dir/apps/web/dist/assets/." /var/www/automatic/assets/
sudo find /var/www/automatic/assets -type d -exec chmod 755 {} +
sudo find /var/www/automatic/assets -type f -exec chmod 644 {} +
sudo ln -s "$release_dir" /srv/automatic/current-next
sudo mv -Tf /srv/automatic/current-next /srv/automatic/current
sudo systemctl restart automatic-api
```

等待 API 就绪，再检查公网：

```bash
curl --fail --silent --show-error --retry 10 --retry-connrefused --retry-delay 1 http://127.0.0.1:3000/api/health
curl -fsS https://app.example.com/api/health
```

这套单实例部署会有短暂 API 重启窗口，也没有把前后端流量同时切换的完整编排。初期在维护窗口发布，保留至少两个已验证的版本；需要无停机更新时，再增加第二个 API 实例、就绪检查和流量切换。

### 代码回滚

确认 `previous_release` 是之前记录的已验证版本，并且新数据库结构兼容旧版本代码，然后执行：

```bash
test -f "$previous_release/apps/api/dist/server.js"
sudo ln -s "$previous_release" /srv/automatic/current-rollback
sudo mv -Tf /srv/automatic/current-rollback /srv/automatic/current
sudo systemctl restart automatic-api
curl --fail --silent --show-error --retry 10 --retry-connrefused --retry-delay 1 http://127.0.0.1:3000/api/health
```

切换代码不会撤销已执行的数据库迁移。项目的迁移文件带校验，已经执行的 SQL 文件不能改写；应新增迁移文件。涉及删除字段等不兼容变更时，需要专门安排数据库恢复或修复迁移，不能仅切换旧代码。恢复部署前备份也会丢失备份之后的新写入。

## 14. 备份和恢复验证

至少备份数据库、对应的 `api.env` 与 `postgres.env`、当前版本号和部署配置。密钥配置应加密保存、限制访问，并与数据库备份一起保留恢复所需的对应关系。备份还需上传到独立对象存储或另一台机器，单台服务器上的副本不能应对服务器或磁盘丢失。

第 13 节的 `pg_dump -Fc` 命令也可作为日常备份命令。通过 systemd timer、cron 或云服务定时任务每天执行，并为失败和存储不足设置通知。

恢复演练先使用一个独立数据库，避免覆盖线上数据：

```bash
sudo docker compose -f /srv/automatic/shared/compose.yaml exec -T postgres createdb -U automatic_admin -O automatic_app automatic_restore
sudo bash -c 'docker compose -f /srv/automatic/shared/compose.yaml exec -T postgres pg_restore -U automatic_admin --role=automatic_app -d automatic_restore --no-owner --no-privileges < "$1"' bash "$backup_file"
sudo docker compose -f /srv/automatic/shared/compose.yaml exec -T postgres psql -U automatic_admin -d automatic_restore -c 'SELECT count(*) FROM users;'
```

上述演练复用已创建的 `automatic_app` 角色，恢复的数据库和对象归该角色所有。全新服务器上还需先重建数据库角色、恢复原来的 JWT 密钥、配置 API 连接到恢复后的数据库，并验证实际请求。建议在隔离服务器上完成全流程演练后，再制定生产恢复操作。

不要执行 `docker compose down --volumes` 来更新项目；该选项会删除数据库持久卷。

切换到新域名前，在旧地址登录并等待文章显示“已保存”，确保旧浏览器草稿已经迁移到数据库。尚未上传的修改仍只在该浏览器中，需先恢复网络保存或独立备份。文章迁移与冲突恢复步骤见 [文章持久化说明](article-persistence.md)。

## 15. 常见故障排查

| 现象                                | 优先检查                                                                                       |
| ----------------------------------- | ---------------------------------------------------------------------------------------------- |
| 打开网页后 API 502                  | `journalctl -u automatic-api`；确认 API 监听 `127.0.0.1:3000`，数据库健康                      |
| API 启动提示开发管理员配置错误      | 生产配置必须是 `DEV_ADMIN_ENABLED=false`                                                       |
| API 提示缺少 JWT 或数据库配置       | systemd 工作目录是否为 `apps/api`；该目录的 `.env` 链接是否存在且运行账号可读                  |
| 注册接口返回成功但收不到邮件        | 是否同时配置真实 Resend Key 和已验证的发件域名；检查邮件服务投递记录                           |
| `VERIFICATION_CODE_DELIVERY_FAILED` | Resend 凭据、域名验证、收件限制及服务器出站访问                                                |
| 登录后刷新又回到登录页              | 使用 HTTPS；查看 Refresh Cookie；确认生产域名和 `CORS_ORIGINS` 一致                            |
| `403 UNTRUSTED_ORIGIN`              | `CORS_ORIGINS` 是否包含实际完整来源；Nginx 是否保留浏览器 `Origin`                             |
| 前端资源 404 或 MIME 类型错误       | Nginx 的 `/assets/` 路径和文件权限；旧分块是否保留；是否错误地把 API/资源请求返回成了 SPA HTML |
| 上传或发布出现 413                  | Nginx `client_max_body_size` 与 API 的 16 MB JSON 请求限制；图片 Base64 编码会增加体积         |
| 微信接口提示 IP 不在白名单          | 公众号后台登记的是服务器实际出站公网 IP                                                        |
| 更新后微信凭据无法解密              | 是否更换了 `JWT_ACCESS_SECRET`；恢复对应原密钥或重新配置公众号                                 |
| 换设备或域名看不到草稿              | 确认新版本已上线、登录同一账号，并在原浏览器等待“已保存”；检查 `/api/articles/workspace` 响应  |
| 证书申请失败                        | DNS 是否正确，80 是否放行，错误 AAAA 记录是否将验证请求导向不可达的 IPv6                       |

上线初期保持单个 API 实例。当前注册验证码状态保存在进程内存中，多实例轮询会导致验证码签发与验证落到不同实例；扩容前需要共享验证码存储或可靠的请求路由。同时增加健康告警、数据库备份失败告警，并根据真实流量配置认证接口限流。
