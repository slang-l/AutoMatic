# AutoMatic 认证模块说明

本文档描述仓库当前已经实现的认证系统，而不是一份待实现的 JWT 示例。服务端使用
Express 5、PostgreSQL、bcrypt 和 `jsonwebtoken`；浏览器端使用短效 Access Token 与
HttpOnly Refresh Cookie 维持登录状态。

## 1. 当前实现范围

认证模块已经完成以下闭环：

- 邮箱验证码注册、密码登录和退出登录；
- HS256 Access JWT 的签发与校验；
- Refresh Token 的服务端持久化、轮换、绝对过期和重放检测；
- PostgreSQL 用户与 Refresh Session 仓库及 SQL 迁移；
- 前端启动时恢复会话、Access Token 过期后刷新并重试；
- 统一错误结构、请求 ID、CORS、Helmet 和 Cookie 安全属性；
- 使用内存仓库运行的隔离接口测试。

文章正文目前仍按用户 ID 分区保存在浏览器 `localStorage`，不在本认证数据库中。

### 关键代码位置

| 文件                                                                | 职责                                             |
| ------------------------------------------------------------------- | ------------------------------------------------ |
| `apps/api/src/config.ts`                                            | 读取并校验服务端环境变量                         |
| `apps/api/src/server.ts`                                            | 生产式进程入口，创建 PostgreSQL 连接池并注入仓库 |
| `apps/api/src/app.ts`                                               | 组装 Express、中间件、服务和路由                 |
| `apps/api/src/services/token.service.ts`                            | 签发/验证 Access JWT，生成并哈希 Refresh Token   |
| `apps/api/src/services/auth.service.ts`                             | 注册、登录、刷新、重放处理和退出的业务规则       |
| `apps/api/src/services/registration-verification.service.ts`        | 验证码生成、过期、重试与失败次数限制             |
| `apps/api/src/services/registration-verification-sender.service.ts` | 通过 Resend 投递验证码邮件                       |
| `apps/api/src/routes/auth.ts`                                       | 输入校验、Cookie 设置和 HTTP 响应                |
| `apps/api/src/middlewares/auth.middleware.ts`                       | Bearer JWT 校验与当前用户复查                    |
| `apps/api/src/repositories/auth.repository.ts`                      | 持久化接口与公开用户字段映射                     |
| `apps/api/src/repositories/postgres.repository.ts`                  | PostgreSQL 实现和事务化 Token 轮换               |
| `apps/api/src/repositories/memory.repository.ts`                    | 面向测试的隔离内存实现                           |
| `apps/api/migrations/001_auth.sql`                                  | `users`、`refresh_sessions` 表和索引             |
| `apps/web/src/services/auth-api.ts`                                 | 浏览器端 Token 内存管理、刷新合并与请求重试      |
| `apps/web/src/App.tsx`                                              | 应用启动恢复会话及登录状态切换                   |

## 2. 架构与安全选择

```text
┌──────────────────────────────────────────────────────────────┐
│ Browser                                                      │
│  Access JWT：仅保存在 JS 模块内存                            │
│  Refresh Token：HttpOnly Cookie，JavaScript 不可读取          │
└───────────────────────┬──────────────────────────────────────┘
                        │ /api + credentials: include
                        ▼
┌──────────────────────────────────────────────────────────────┐
│ Express                                                      │
│  route → auth service → repository                           │
│  Bearer JWT → requireAuth → 再查询当前用户状态                │
└───────────────────────┬──────────────────────────────────────┘
                        ▼
┌──────────────────────────────────────────────────────────────┐
│ PostgreSQL                                                   │
│  users：bcrypt 密码哈希                                      │
│  refresh_sessions：Refresh Token 的 SHA-256 哈希与轮换链      │
└──────────────────────────────────────────────────────────────┘
```

系统有意采用两种不同的凭据：

1. **Access Token 是 JWT**。它有效期短，适合随受保护 API 请求发送，服务端无需读取
   Refresh Session 就能校验签名和标准声明。
2. **Refresh Token 不是 JWT**。它是 `randomBytes(32)` 生成的 256 bit 随机值，不携带
   业务信息。服务端必须查询会话记录，因此可以撤销、轮换和检测重放。

这种设计避免把长期凭据暴露给前端 JavaScript。Access Token 没有写入
`localStorage` 或 `sessionStorage`，页面刷新后会消失；Refresh Token 位于
`automatic_refresh_token` Cookie 中，设置为：

- `HttpOnly`：前端脚本无法读取；
- `SameSite=Lax`：减少跨站请求自动携带 Cookie 的风险；
- `Secure`：`NODE_ENV=production` 时启用，只通过 HTTPS 发送；
- `Path=/api/auth`：只发送到认证接口；
- `Expires=<family 的绝对过期时间>`。

此外，认证路由对所有非 `GET`/`HEAD`/`OPTIONS` 请求执行来源校验：请求带有
`Origin` 时必须命中 `CORS_ORIGINS`；没有 `Origin` 但浏览器明确发送
`Sec-Fetch-Site: cross-site` 时也会拒绝。没有浏览器来源头的 curl 或服务间调用仍然
允许。这样避免了“CORS 阻止前端读取响应，但服务端仍执行带 Cookie 的写请求”这一
常见误区。

Access JWT 使用 HS256，签发和验证两端都固定校验：

- `alg`：`HS256`；
- `iss`：`JWT_ISSUER`；
- `aud`：`JWT_AUDIENCE`；
- `type`：固定为 `access`；
- `sub`：用户 ID；
- `role`：`user` 或 `admin`；
- `jti`：每个 Access Token 独立的 UUID；
- `iat`、`exp`：签发时间和过期时间。

JWT 中的角色不是用户状态的最终事实。`requireAuth` 验证 JWT 后还会按 `sub` 查询
数据库，只有用户仍存在且 `status=active` 才把公开用户信息写入 `request.auth`。

### 密码和输入规则

- 邮箱会 `trim`、转小写，最大 254 个字符，并由数据库唯一约束兜底；
- 密码最少 8、最多 128 个字符，同时不得超过 bcrypt 可安全处理的 72 个 UTF-8
  字节；
- 可选昵称为 1～80 个字符；当前 Web 注册页没有昵称输入时，服务端使用邮箱
  `@` 前的部分；
- 密码用 bcrypt 哈希，默认 cost factor 为 12；测试为了速度显式使用 4；
- 登录时，即使邮箱不存在也执行一次 dummy bcrypt compare，减小通过响应耗时枚举
  已注册邮箱的差异；
- API 响应通过 `toPublicUser` 白名单映射，永远不返回 `passwordHash`。

## 3. Access / Refresh 生命周期

### 3.1 注册或登录

```text
用户先获取并提交邮箱验证码、邮箱和密码
  → 服务端校验验证码/输入/密码
  → 创建新的 familyId
  → 生成随机 Refresh Token
  → 数据库只保存 SHA-256(token)
  → 签发短效 Access JWT
  → JSON 返回 Access JWT；Set-Cookie 返回 Refresh Token
```

每次成功注册或登录都会创建一个新的 Refresh Token family。不同设备或不同浏览器
登录形成不同 family，退出当前会话不会自动退出其他设备。

### 3.2 正常刷新

假设首次登录时间为 `T0`，`REFRESH_TOKEN_TTL_DAYS=7`：

```text
T0           创建 R1，family 绝对过期时间 = T0 + 7 天
T1           使用 R1 刷新
             ├─ R1 标记 revoked，并记录 replaced_by_hash = hash(R2)
             └─ 创建 R2；R2.expires_at 仍为 T0 + 7 天
T2           使用 R2 刷新
             ├─ R2 标记 revoked
             └─ 创建 R3；R3.expires_at 仍为 T0 + 7 天
T0 + 7 天    整个 family 无法继续刷新，需要重新登录
```

也就是说，这是**绝对过期会话**，不是每次刷新都重新续 7 天的滑动会话。刷新响应会
让新 Cookie 继承当前 Session 的 `expiresAt`，数据库事务也强制新记录继承原值。

PostgreSQL 轮换在同一事务内完成：

1. 根据 `family_id` 获取 PostgreSQL 事务级 advisory lock；
2. 仅当旧记录尚未撤销且尚未过期时，原子地将它更新为已撤销；
3. 创建同一 `user_id`、`family_id`、`expires_at` 的下一条记录；
4. 全部成功后提交并释放锁。

轮换、退出和重放撤销使用同一把 family 锁，因此两个并发请求不能都成功消费同一个
Refresh Token，退出也不会漏掉另一个事务刚创建的下一代 Token。

### 3.3 重放检测

浏览器正常轮换后不应再次发送旧 Token。若已撤销的 R1 再次出现，服务端将其视为
可能被复制或重放：

```text
攻击者/旧请求再次发送 R1
  → 发现 R1.revoked_at 不为空
  → 撤销 R1 所属 family 的所有活动 Token（包括 R2/R3）
  → 返回 401 INVALID_REFRESH_TOKEN
```

如果并发刷新在 compare-and-swap 中失败，服务端同样撤销整个 family。这一策略更
保守：极少数重复请求可能让用户重新登录，但不会让被复制的旧 Token 保住后代会话。

### 3.4 退出和 Access Token 的剩余窗口

退出接口根据收到的 Refresh Token 找到 family，并撤销该 family 的所有活动记录，
同时清除浏览器 Cookie。接口是幂等式的：没有 Cookie 时也返回 `204`。

Access JWT 是无状态凭据，当前没有 Access Token denylist。退出后，已经签发的 JWT
在自身 `exp` 到达之前理论上仍可访问接口；这也是 Access Token 默认只存活 15 分钟
的原因。若未来有“立即封禁所有 Access Token”的强需求，可加入用户级
`token_version`、`valid_after` 或集中 denylist，但这会增加每次请求的状态查询/缓存
复杂度。

## 4. HTTP 接口

所有认证响应都带有 `Cache-Control: no-store` 与 `Pragma: no-cache`。所有错误使用：

```json
{
  "error": {
    "code": "INVALID_CREDENTIALS",
    "message": "Invalid email or password",
    "requestId": "8ae223ac-8094-4c16-bdb4-e5f04c12637d"
  }
}
```

响应头 `x-request-id` 与 `error.requestId` 一致。客户端也可以主动发送
`x-request-id` 便于串联日志。

### 4.1 `POST /api/auth/register/verification-code`

请求：

```json
{
  "email": "writer@example.com"
}
```

成功：`201 Created`。验证码有效期为 10 分钟，同一邮箱 60 秒后才能再次获取：

```json
{
  "expiresInSeconds": 600,
  "resendAfterSeconds": 60,
  "testCode": "123456"
}
```

`testCode` 只在 `development` 和 `test` 环境返回，Web 注册页会直接显示它，便于本地
测试。生产环境不会返回验证码，必须配置邮件发送服务。

常见失败：

- `400 INVALID_REQUEST`：邮箱格式不正确；
- `409 EMAIL_ALREADY_EXISTS`：邮箱已经注册；
- `429 VERIFICATION_CODE_RATE_LIMITED`：尚未到允许重新获取的时间；
- `502 VERIFICATION_CODE_DELIVERY_FAILED`：邮件服务投递失败，用户可以立即重试。

### 4.2 `POST /api/auth/register`

请求：

```http
POST /api/auth/register HTTP/1.1
Content-Type: application/json

{
  "email": "writer@example.com",
  "password": "correct horse battery staple",
  "verificationCode": "123456",
  "name": "Writer"
}
```

成功：`201 Created`

```http
Set-Cookie: automatic_refresh_token=<opaque-token>; Path=/api/auth; Expires=...; HttpOnly; SameSite=Lax
```

```json
{
  "accessToken": "eyJ...",
  "user": {
    "id": "2079eb93-bb56-4db4-9c40-bdd1e240cfc7",
    "email": "writer@example.com",
    "name": "Writer",
    "role": "user",
    "status": "active"
  }
}
```

常见失败：

- `400 INVALID_REQUEST`：字段缺失、多余、格式错误或密码不符合限制；
- `400 VERIFICATION_CODE_REQUIRED`：尚未获取验证码；
- `400 INVALID_VERIFICATION_CODE`：验证码不正确；
- `400 VERIFICATION_CODE_EXPIRED`：验证码已经过期；
- `400 VERIFICATION_CODE_ATTEMPTS_EXCEEDED`：错误次数已达到上限，需要重新获取；
- `409 EMAIL_ALREADY_EXISTS`：规范化后的邮箱已经注册。

### 4.3 `POST /api/auth/login`

请求：

```json
{
  "email": "writer@example.com",
  "password": "correct horse battery staple"
}
```

成功：`200 OK`，响应结构和 Cookie 与注册相同。

常见失败：

- `400 INVALID_REQUEST`：请求体不合法；
- `401 INVALID_CREDENTIALS`：邮箱不存在或密码不正确；
- `403 ACCOUNT_DISABLED`：用户已禁用。

邮箱不存在和密码错误使用完全相同的公开错误，避免泄露账号是否存在。

### 4.4 `POST /api/auth/refresh`

请求体为空，浏览器自动携带 Cookie：

```http
POST /api/auth/refresh HTTP/1.1
Cookie: automatic_refresh_token=<opaque-token>
```

成功：`200 OK`，服务端设置一个值不同、但 `Expires` 不延长的新 Cookie，并返回新的
Access Token 和当前公开用户信息。

失败：`401 INVALID_REFRESH_TOKEN`。服务端有意不区分 Cookie 缺失、Token 不存在、
已过期、已撤销或用户失效，避免暴露内部会话状态。

### 4.5 `POST /api/auth/logout`

```http
POST /api/auth/logout HTTP/1.1
Cookie: automatic_refresh_token=<opaque-token>
```

成功：`204 No Content`，没有 JSON 响应体。无论 Cookie 是否存在都会清除客户端 Cookie；
如果能找到对应 Session，则撤销整个 family。

### 4.6 `GET /api/auth/me`

```http
GET /api/auth/me HTTP/1.1
Authorization: Bearer <access-token>
```

成功：`200 OK`

```json
{
  "user": {
    "id": "2079eb93-bb56-4db4-9c40-bdd1e240cfc7",
    "email": "writer@example.com",
    "name": "Writer",
    "role": "user",
    "status": "active"
  }
}
```

常见失败：

- `401 AUTHENTICATION_REQUIRED`：没有严格的 `Bearer <token>` 请求头；
- `401 INVALID_ACCESS_TOKEN`：JWT 无效、过期、声明不符，或对应用户不存在/已禁用。

除 `/me` 这一安全读取接口外，认证写接口还可能返回
`403 UNTRUSTED_ORIGIN`，表示浏览器来源不在配置的白名单中。

### 4.7 使用 curl 验证完整流程

以下命令使用 Cookie Jar 保存 HttpOnly Cookie。先启动数据库、执行迁移并启动 API：

```bash
curl -s \
  -H "Content-Type: application/json" \
  -d '{"email":"writer@example.com"}' \
  http://localhost:3000/api/auth/register/verification-code

# 从上一步的开发环境响应中复制 testCode
curl -i -c cookies.txt \
  -H "Content-Type: application/json" \
  -d '{"email":"writer@example.com","password":"correct horse battery staple","verificationCode":"123456","name":"Writer"}' \
  http://localhost:3000/api/auth/register

curl -i -b cookies.txt -c cookies.txt \
  -X POST http://localhost:3000/api/auth/refresh

curl -i -b cookies.txt \
  -X POST http://localhost:3000/api/auth/logout
```

调用 `/me` 时，从注册或刷新 JSON 中复制 `accessToken`：

```bash
curl -i \
  -H "Authorization: Bearer eyJ..." \
  http://localhost:3000/api/auth/me
```

## 5. 前端会话行为

`apps/web/src/services/auth-api.ts` 是 Access Token 的唯一管理位置：

- 所有 fetch 请求都设置 `credentials: 'include'`，让浏览器收发 Refresh Cookie；
- 登录/注册成功后，仅把 `accessToken` 写入模块级内存；
- 页面刷新后内存 Token 消失，`App` 的 `bootstrap()` 会先调用 `/refresh` 恢复会话；
- 没有 Access Token 时，受保护请求会先刷新；
- 带 Access Token 的请求收到 `401` 时，最多刷新并重试一次；
- 多个并发请求共用同一个 `refreshPromise`，避免同一 Cookie 被并发轮换而误触重放；
- `sessionGeneration` 防止较早启动的登录/刷新异步结果在退出后重新写回 Token；
- 退出时先清除内存 Token；即使 API 暂时不可用，UI 也会回到未登录状态。

一个受保护请求的典型过程是：

```text
authenticatedRequest('/api/auth/me')
  ├─ 内存中有 Access Token → 添加 Authorization 请求头
  ├─ 成功 → 返回数据
  └─ 收到 401
       ├─ 并发请求已经换过 Token → 直接用新 Token 重试
       └─ 尚未刷新 → 所有请求共用一次 /refresh，再各自重试一次
```

不要在组件中复制一套 Token 状态，也不要把 Access Token 写入 Zustand 持久化或
`localStorage`。新增受保护 API 时，应统一通过 `authenticatedRequest` 调用。

## 6. 环境变量

服务端模板位于 `apps/api/.env.example`：

| 变量                     | 示例/默认                                                   | 校验和含义                                      |
| ------------------------ | ----------------------------------------------------------- | ----------------------------------------------- |
| `NODE_ENV`               | `development`                                               | 只允许 `development`、`test`、`production`      |
| `HOST`                   | `0.0.0.0`                                                   | API 监听地址                                    |
| `PORT`                   | `3000`                                                      | 1～65535 的整数                                 |
| `CORS_ORIGINS`           | `http://localhost:5173,http://127.0.0.1:5173`               | 显式 Origin 列表，逗号分隔；启用凭据时禁止 `*`  |
| `DATABASE_URL`           | `postgresql://automatic:automatic@localhost:5432/automatic` | 必填的 PostgreSQL URL                           |
| `JWT_ACCESS_SECRET`      | 无安全默认值                                                | 必填，至少 32 个字符；兼容旧变量名 `JWT_SECRET` |
| `JWT_ISSUER`             | `automatic-api`                                             | 必填，必须与 Token 验证端一致                   |
| `JWT_AUDIENCE`           | `automatic-web`                                             | 必填，必须与 Token 验证端一致                   |
| `ACCESS_TOKEN_TTL`       | `15m`                                                       | `数字+s/m/h/d`，实际范围 60 秒～1 天            |
| `REFRESH_TOKEN_TTL_DAYS` | `7`                                                         | 1～90 的整数，表示 family 绝对寿命              |
| `RESEND_API_KEY`         | 空                                                          | 可选；Resend API Key                            |
| `RESEND_FROM`            | 空                                                          | 可选；如 `AutoMatic <verify@example.com>`       |
| `DEV_ADMIN_ENABLED`      | `true`（仅 development）                                    | 是否在 API 启动时幂等初始化本地管理员           |
| `DEV_ADMIN_EMAIL`        | `admin@qq.com`                                              | 本地管理员邮箱                                  |
| `DEV_ADMIN_PASSWORD`     | `123456`                                                    | 本地管理员密码；已知弱口令，不得进入生产        |
| `DEV_ADMIN_NAME`         | `系统管理员`                                                | 本地管理员显示名称                              |

### 注册验证码与邮件投递

本地开发不要求邮件服务。`NODE_ENV=development` 时，获取验证码的响应包含 `testCode`，
Web 页面会把它显示在验证码输入框下方。

需要发送真实邮件时，在 `apps/api/.env` 中同时配置：

```dotenv
RESEND_API_KEY=your-resend-api-key
RESEND_FROM="AutoMatic <verify@your-domain.example>"
```

启用真实邮件时，`RESEND_API_KEY` 和 `RESEND_FROM` 必须同时存在，只配置其中一个会
导致 API 拒绝启动。发件域名需要先在 Resend 控制台完成验证。邮件投递失败时，本次验证码会立即失效并解除重发冷却，接口返回
`502 VERIFICATION_CODE_DELIVERY_FAILED`，因此用户可以直接重试，不会被一个未收到的
验证码锁住。

### 开发管理员

当 `NODE_ENV=development` 且 `DEV_ADMIN_ENABLED=true` 时，API 在连接 PostgreSQL 后会
调用 `provisionDevelopmentAdmin()`：不存在 `admin@qq.com` 时创建账号，已经存在时则
校正密码、显示名称、状态和角色。这个过程是幂等的，不会创建重复用户，账号角色固定为
系统当前最高角色 `admin`。

登录账号为 `admin@qq.com`，默认密码为 `123456`。由于这是用户明确指定的开发凭据，
登录接口允许已有账号提交少于 8 位的密码；公开注册仍要求新密码至少 8 位。配置加载器
会拒绝在 `test` 或 `production` 中将 `DEV_ADMIN_ENABLED` 设置为 `true`，防止已知密码被
误带到线上。

生成独立密钥：

```bash
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

每个环境应使用不同密钥。更换 `JWT_ACCESS_SECRET` 会立即使旧 Access Token 无效，
但不会自动撤销数据库中的 Refresh Session；如果这是一次密钥泄漏处置，还应同时撤销
或清理所有 Refresh Session，强制全部用户重新登录。

### CORS、Cookie 和部署域名

当前浏览器与 API 的设计适合**同站**部署，例如 `app.example.com` 与
`api.example.com`，以及本地的两个 `localhost` 端口。它们可以是不同 Origin，但仍是
同一 Site。生产环境需要：

- 把每个真实前端 Origin 精确加入 `CORS_ORIGINS`；
- 前端请求继续使用 `credentials: 'include'`；
- API 必须经 HTTPS 对外提供，使 `Secure` Cookie 能正常工作；
- 反向代理要保留 `Cookie`、`Set-Cookie` 和 `Authorization` 请求/响应头。

若 Web 与 API 是真正的跨站部署，当前 `SameSite=Lax` Cookie 不适用。不要只修改 CORS；
需要评审后把 Cookie 改为 `SameSite=None; Secure`，保留并正确配置现有 Origin 校验，
必要时再加入 CSRF Token。`SameSite`、CORS 和 CSRF 解决的是不同问题。

## 7. 本地开发和数据库迁移

在仓库根目录运行：

```powershell
pnpm install
Copy-Item apps/api/.env.example apps/api/.env
pnpm db:up
pnpm db:migrate
pnpm dev
```

macOS/Linux 将复制命令换为：

```bash
cp apps/api/.env.example apps/api/.env
```

访问地址：

- Web：<http://localhost:5173>；
- API：<http://localhost:3000>；
- 健康检查：<http://localhost:3000/api/health>。

`pnpm db:migrate` 执行 `apps/api/migrations/` 下符合
`数字_名称.sql` 格式的文件。迁移器具有以下保证：

- 按文件名字典序执行；
- 使用 PostgreSQL advisory lock 防止多个实例同时迁移；
- 每个迁移及其 `schema_migrations` 记录在同一事务内提交；
- 对已应用文件记录 SHA-256 checksum；修改历史迁移会直接失败；
- CRLF/LF 在计算 checksum 时会归一化，避免跨系统误报。

因此已经进入共享环境的迁移文件应视为不可变；结构变更要新增例如
`002_add_user_token_version.sql`，不要编辑 `001_auth.sql`。API 进程启动时只检查数据库
可连接，不会自动执行迁移，所以发布流程必须先运行 `pnpm db:migrate`。

`pnpm db:down` 只停止容器，命名卷仍保留。`docker compose down --volumes` 会永久删除
本地账号与会话数据，只能在明确不需要数据时执行。

## 8. 测试与检查

常用命令：

```bash
# 只运行 API 测试
pnpm --filter @automatic/api test

# 只检查 API 类型
pnpm --filter @automatic/api typecheck

# 全工作区测试
pnpm test

# 类型检查、测试、构建
pnpm check
```

当前 `apps/api/test/app.test.ts` 通过 `buildApp()` 的默认内存仓库运行，因此测试：

- 不需要 Docker 或本机 PostgreSQL；
- 每个 app 实例拥有独立用户和 Session，不会污染其他用例；
- 覆盖验证码注册与投递失败、重复邮箱、登录、Bearer 校验、Cookie 安全属性、来源校验、轮换、并发
  消费、重放撤销 family、退出、输入校验、配置校验和统一错误响应；
- **不验证 PostgreSQL SQL、事务、迁移或真实连接行为**。

生产发布前建议增加 PostgreSQL 集成测试：启动临时数据库、执行真实迁移、向
`buildApp({ authRepository: createPostgresAuthRepository(pool) })` 注入仓库，再复用核心
认证场景。尤其应覆盖两个并发 refresh 只允许一个成功、另一个导致 family 被撤销。

## 9. 内存仓库与 PostgreSQL 的边界

`buildApp()` 默认使用 `createMemoryAuthRepository()` 是测试便利，不代表运行中的 API
默认使用内存：

```text
接口测试
  buildApp({ config })
    └─ 默认 MemoryAuthRepository

实际 API 进程
  server.ts
    ├─ createPostgresPool(DATABASE_URL)
    ├─ createPostgresAuthRepository(pool)
    └─ buildApp({ config, authRepository })
```

如果新增其他进程入口、Serverless Handler 或测试服务器，必须明确决定注入哪个仓库；
生产入口漏传 `authRepository` 会让账号仅存于单进程内存，并在重启后消失。

### 从内存数据切到生产数据库时

当前仓库已经完成 PostgreSQL 适配，但若某个已有环境曾使用内存仓库，需要注意：

1. 内存中的密码哈希和 Session 在进程外不可读取，通常无法进行数据迁移；应通知用户
   重新注册或走密码重置流程，不能尝试导出原始密码；
2. 先备份数据库并在与生产相同 PostgreSQL 大版本的暂存环境执行迁移；
3. 先运行迁移，再启动引用新结构的 API；迁移应保持向前/向后兼容以支持滚动发布；
4. 确认所有生产入口都显式注入 PostgreSQL 仓库，不要依赖 `buildApp()` 默认值；
5. 注册用户和初始 Session 必须保持同一事务，Token 轮换也必须是原子操作；当前
   PostgreSQL 仓库已经如此实现，替换 ORM 时不得丢失该语义；
6. 保留 `users.email` 唯一约束和规范化约束、Token 哈希唯一约束、外键与角色/状态
   CHECK 约束；应用层检查不能替代数据库并发约束；
7. 数据库存储 UTC 的 `timestamptz`，应用节点与数据库应启用可靠的时间同步；
8. 配置 TLS、最小权限数据库账号、连接池上限、备份与恢复演练、慢查询和连接耗尽监控；
9. 制定过期/已撤销 `refresh_sessions` 的定期清理任务。删除历史记录前要权衡重放检测
   窗口：至少不要在 family 仍可能有效时删除已轮换的旧记录；
10. 不记录密码、原始 Access Token、原始 Refresh Token 或完整 Cookie。排障应使用
    `requestId`、用户 ID、Session ID/family ID 等非凭据标识。

## 10. 上线检查清单

- [ ] `NODE_ENV=production`，API 只通过 HTTPS 暴露；
- [ ] 使用密码管理系统注入独立的强 `JWT_ACCESS_SECRET`；
- [ ] `DATABASE_URL` 使用非默认密码、最小权限账号和所需 TLS 参数；
- [ ] `CORS_ORIGINS` 只包含真实、精确的 HTTPS 前端 Origin；
- [ ] 发布前执行迁移并验证 `schema_migrations`；
- [ ] 反向代理正确传递 Cookie、Authorization，并设置合理请求体/超时限制；
- [ ] 登录与注册接口增加按 IP/账号维度的限流；
- [ ] 根据部署是否同站，复核 SameSite、现有 Origin 校验与 CSRF 防护；
- [ ] PostgreSQL 集成测试和并发 Refresh 测试通过；
- [ ] 配置数据库备份、恢复演练、Session 清理和安全日志告警；
- [ ] 明确用户禁用、改密、密钥轮换时如何撤销现有 Refresh Session。

当前实现已经提供安全的基础认证闭环，但限流、邮箱验证、忘记密码、多设备会话管理、
Access Token 全局即时撤销和审计后台仍属于后续产品能力。
