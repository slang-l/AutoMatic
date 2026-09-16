# AutoMatic

AutoMatic 是一个面向微信公众号内容创作的前后端 monorepo，提供 BlockSuite 编辑、公众号样式预览，以及基于 JWT 的账号注册、登录和会话续期。

## 技术架构

```text
浏览器
  └─ apps/web   React 18 + Vite + BlockSuite + Zustand
       │  /api（开发环境由 Vite 代理）
       ▼
     apps/api   Express 5 + TypeScript + JWT + bcrypt
       │
       ▼
     PostgreSQL  用户与 Refresh Session
```

仓库使用 pnpm workspace：

```text
AutoMatic/
├─ apps/
│  ├─ web/                 # Web 应用，默认端口 5173
│  └─ api/                 # API 服务，默认端口 3000
├─ compose.yaml            # 本地 PostgreSQL
├─ package.json            # 工作区统一命令
├─ pnpm-workspace.yaml
└─ tsconfig.base.json
```

目前文章内容仍保存在浏览器 `localStorage`；PostgreSQL 用于账号和登录会话。

认证模块的设计依据、Token 生命周期、完整接口示例和生产部署注意事项见
[`docs/authentication.md`](docs/authentication.md)。

## 代码格式化

在仓库根目录执行 `pnpm format`，即可一键格式化项目代码；执行 `pnpm format:check` 可以只检查格式，不修改文件。

项目使用 Prettier，采用 2 空格缩进、单引号、分号、100 字符行宽和 LF 换行。第三方 BlockSuite 源码、锁文件、构建产物及临时文件不参与格式化。

VS Code 安装工作区推荐的 **Prettier - Code formatter** 扩展后，保存时会自动格式化，也可使用“格式化文档”命令（Windows：`Shift+Alt+F`）。

## 环境要求

- Node.js 20.12+（不使用 Node.js 21），或 Node.js 22+
- pnpm 9.15.4
- Docker Desktop，或 Docker Engine + Docker Compose v2

可先确认本机环境：

```bash
node --version
pnpm --version
docker compose version
```

如果还没有 pnpm，可通过 Node.js 自带的 Corepack 启用：

```bash
corepack enable
corepack prepare pnpm@9.15.4 --activate
```

## 首次启动

### 1. 安装依赖

在仓库根目录执行：

```bash
pnpm install
```

### 2. 创建本地环境变量

PowerShell：

```powershell
Copy-Item apps/api/.env.example apps/api/.env
```

macOS 或 Linux：

```bash
cp apps/api/.env.example apps/api/.env
```

示例文件已经可以连接本项目的本地 PostgreSQL。`JWT_ACCESS_SECRET` 的示例值仅用于本机开发；部署前必须替换为独立的随机密钥。可以用 Node.js 生成一个：

```bash
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

将输出值填入 `apps/api/.env` 的 `JWT_ACCESS_SECRET`。

### 3. 启动 PostgreSQL

```bash
pnpm db:up
```

该命令会启动 `postgres:17-alpine`，等待健康检查通过，并在本机开放 `5432` 端口。开发环境默认连接信息为：

| 项目     | 值                                           |
| -------- | -------------------------------------------- |
| Host     | `localhost`                                  |
| Port     | `5432`                                       |
| Database | `automatic`                                                    |
| User     | `automatic`                                                    |
| Password | `automatic`                                                    |
| URL      | `postgresql://automatic:automatic@localhost:5432/automatic`     |

数据库文件保存在 Docker 命名卷中，执行 `pnpm db:down` 后仍会保留。

### 4. 执行数据库迁移

```bash
pnpm db:migrate
```

迁移会创建认证所需的 `users` 和 `refresh_sessions` 表。迁移源文件位于 `apps/api/migrations/`，新环境和数据库结构升级后都应执行此命令。

### 5. 启动前后端

```bash
pnpm dev
```

启动后访问：

- Web：<http://localhost:5173>
- API：<http://localhost:3000>
- 健康检查：<http://localhost:3000/api/health>

开发环境中，Vite 会把浏览器发往 `/api` 的请求代理到 `http://127.0.0.1:3000`。首次使用可直接在登录页注册账号。

开发环境启动 API 时还会幂等初始化一个最高权限账号：

| 项目 | 默认值         |
| ---- | -------------- |
| 邮箱 | `admin@qq.com` |
| 密码 | `123456`       |
| 角色 | `admin`        |

该账号只在 `NODE_ENV=development` 中启用。若数据库里已经存在同邮箱用户，启动时会
将其校正为启用的 `admin` 并同步开发密码；生产环境禁止启用这组默认凭据。

## 环境变量

服务端读取 `apps/api/.env`。完整模板见 [`apps/api/.env.example`](apps/api/.env.example)。

| 变量                     | 示例或默认值                                 | 说明                                          |
| ------------------------ | -------------------------------------------- | --------------------------------------------- |
| `NODE_ENV`               | `development`                                | `development`、`test` 或 `production`         |
| `HOST`                   | `0.0.0.0`                                    | API 监听地址                                  |
| `PORT`                   | `3000`                                       | API 监听端口                                  |
| `CORS_ORIGINS`           | `http://localhost:5173`                      | 允许携带凭据的前端来源，多个来源用逗号分隔    |
| `DATABASE_URL`           | `postgresql://automatic:automatic@localhost:5432/automatic` | PostgreSQL 连接字符串                         |
| `JWT_ACCESS_SECRET`      | 无                                           | JWT HMAC 签名密钥，必填且至少 32 个字符       |
| `JWT_ISSUER`             | `automatic-api`                              | Access Token 的签发者                         |
| `JWT_AUDIENCE`           | `automatic-web`                              | Access Token 的接收方                         |
| `ACCESS_TOKEN_TTL`       | `15m`                                        | Access Token 有效期，范围为 60 秒至 1 天      |
| `REFRESH_TOKEN_TTL_DAYS` | `7`                                          | Refresh Token 有效天数，范围为 1 至 90 天     |
| `DEV_ADMIN_ENABLED`      | `true`（仅开发）                             | 是否初始化本地管理员；非开发环境禁止为 `true` |
| `DEV_ADMIN_EMAIL`        | `admin@qq.com`                               | 本地管理员邮箱                                |
| `DEV_ADMIN_PASSWORD`     | `123456`                                     | 本地管理员密码，不得用于生产                  |
| `DEV_ADMIN_NAME`         | `系统管理员`                                 | 本地管理员显示名称                            |

生产环境不要使用 `compose.yaml` 中的开发密码，也不要提交 `.env`。生产前端地址还需要加入 `CORS_ORIGINS`，并使用 HTTPS。

## 鉴权 API

| 方法   | 路径                 | 凭据                   | 成功状态 | 用途                                                               |
| ------ | -------------------- | ---------------------- | -------- | ------------------------------------------------------------------ |
| `POST` | `/api/auth/register` | 无                     | `201`    | 注册账号并创建会话                                                 |
| `POST` | `/api/auth/login`    | 无                     | `200`    | 使用邮箱和密码登录                                                 |
| `POST` | `/api/auth/refresh`  | Refresh Cookie         | `200`    | 轮换 Refresh Token 并签发新的 Access Token；不延长会话绝对过期时间 |
| `POST` | `/api/auth/logout`   | Refresh Cookie（可选） | `204`    | 撤销当前会话并清除 Cookie，可重复调用                              |
| `GET`  | `/api/auth/me`       | Bearer Token           | `200`    | 获取当前用户                                                       |
| `GET`  | `/api/health`        | 无                     | `200`    | 服务健康检查                                                       |

注册请求：

```json
{
  "email": "name@example.com",
  "password": "a-strong-password",
  "name": "Name"
}
```

登录请求：

```json
{
  "email": "name@example.com",
  "password": "a-strong-password"
}
```

注册、登录和刷新成功后，响应包含短效 Access Token 和公开用户信息；Refresh Token 由服务端通过名为 `automatic_refresh_token` 的 HttpOnly Cookie 管理：

```json
{
  "accessToken": "eyJ...",
  "user": {
    "id": "uuid",
    "email": "name@example.com",
    "name": "Name",
    "role": "user",
    "status": "active"
  }
}
```

访问受保护接口时使用：

```http
Authorization: Bearer <access-token>
```

错误响应采用统一结构，并通过 `x-request-id` 响应头返回同一个请求 ID：

```json
{
  "error": {
    "code": "INVALID_CREDENTIALS",
    "message": "Invalid email or password",
    "requestId": "8ae223ac-8094-4c16-bdb4-e5f04c12637d"
  }
}
```

## 安全设计

- 密码使用 bcrypt 单向哈希，API 不返回密码哈希。
- Access Token 是短效 HS256 JWT，同时校验算法、签发者、接收方、类型和有效期。
- Access Token 由 Web 应用保存在内存中，不写入 `localStorage`。
- Refresh Token 是高强度随机值，通过 HttpOnly Cookie 传输；数据库只保存它的 SHA-256 哈希。
- 每次刷新都会轮换 Refresh Token，但新 Token 继承当前 family 最初的绝对过期时间，不会形成无限滑动会话。
- 已轮换的旧 Token 被再次使用时，服务端会把它视为重放并撤销同一 token family，包括已经签发的新 Token。
- 受保护请求会重新检查用户是否存在且处于启用状态，不能只依赖 JWT 内的角色或状态。
- 退出登录会撤销当前轮换链上的整个 Refresh Token family；短效 Access Token 在到期前仍可能有效。
- Cookie 认证写请求会校验 `Origin`/`Sec-Fetch-Site`；来自非白名单网页的请求返回 `403 UNTRUSTED_ORIGIN`。

`apps/api/src/server.ts` 是实际服务入口，它显式创建并注入 PostgreSQL
仓库。`buildApp()` 为方便隔离测试而默认创建内存仓库，因此不要在生产入口中省略
`authRepository`；当前 API 单元/接口测试也不会访问本地 PostgreSQL。

## 常用命令

| 命令                             | 作用                           |
| -------------------------------- | ------------------------------ |
| `pnpm dev`                       | 并行启动 Web 和 API            |
| `pnpm dev:web`                   | 只启动 Web                     |
| `pnpm dev:api`                   | 只启动 API                     |
| `pnpm db:up`                     | 启动并等待 PostgreSQL 健康     |
| `pnpm db:down`                   | 停止 PostgreSQL，保留数据卷    |
| `pnpm db:migrate`                | 执行 API 数据库迁移            |
| `pnpm typecheck`                 | 检查所有应用的 TypeScript 类型 |
| `pnpm test`                      | 运行所有应用测试               |
| `pnpm build`                     | 构建所有应用                   |
| `pnpm check`                     | 依次执行类型检查、测试和构建   |
| `pnpm --filter @automatic/api start` | 启动已构建的 API               |

提交前建议运行：

```bash
pnpm check
```

## 贡献说明

欢迎通过 Issue 和 Pull Request 参与 AutoMatic 的改进，包括功能建议、问题修复、文档完善和用户体验优化。

### 开始贡献

1. Fork 本仓库并克隆到本地。
2. 从最新的主分支创建独立分支，例如 `feat/theme-editor`、`fix/login-session` 或 `docs/contributing`。
3. 执行 `pnpm install` 安装依赖，并参考“首次启动”章节配置本地开发环境。
4. 完成修改后运行 `pnpm check`，确保类型检查、测试和构建均通过。
5. 提交修改并发起 Pull Request。

### 开发约定

- 保持每次提交目标单一，避免在同一个 Pull Request 中混入无关修改。
- 遵循项目现有的 TypeScript、React 和 Prettier 代码风格；可运行 `pnpm format` 统一格式。
- 新增或修改功能时，请同步补充相关测试和文档。
- 不要提交 `.env`、密钥、访问令牌、数据库文件或其他敏感信息。
- 修改数据库结构时，请在 `apps/api/migrations/` 中新增迁移文件，不要直接改写已经发布的迁移。

### 提交与 Pull Request

建议使用清晰的提交信息，例如：

```text
feat: 新增公众号主题导入功能
fix: 修复刷新会话重复使用问题
docs: 完善本地开发说明
```

Pull Request 应说明修改目的、主要变化和验证方式；涉及界面调整时，建议附上截图或录屏。提交前请确认不存在无关文件、调试日志或敏感数据。

## 常见问题

### API 报数据库连接失败

先检查容器和健康状态：

```bash
docker compose ps
docker compose logs postgres
```

确认 `apps/api/.env` 中的 `DATABASE_URL` 与 `compose.yaml` 一致，然后重新执行 `pnpm db:migrate`。

### `5432` 端口已被占用

停止本机已有的 PostgreSQL，或者同时修改 `compose.yaml` 的宿主机端口和 `DATABASE_URL` 中的端口。

### API 启动时提示 JWT 配置错误

确认 `JWT_ACCESS_SECRET` 至少包含 32 个字符，并且 `JWT_ISSUER`、`JWT_AUDIENCE` 都已设置。修改 `.env` 后需要重启 API。

### 想清空本地数据库

`pnpm db:down` 默认保留数据。下面的命令会永久删除本地 PostgreSQL 命名卷及全部账号、会话数据，请确认不再需要后再执行：

```bash
docker compose down --volumes
```

随后重新执行 `pnpm db:up` 和 `pnpm db:migrate`。
