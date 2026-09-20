# 协同底层

协同 API 位于 `/api/collaboration`，全部使用现有 `Authorization: Bearer <accessToken>`。
生产入口注入 PostgreSQL 仓库；`buildApp()` 默认使用内存仓库供测试使用。
表结构在 `apps/api/migrations/004_collaboration.sql`，执行 `pnpm db:migrate` 或启动 API 时迁移。

目前提供文档共享、成员权限、二进制增量日志和在线状态的 HTTP 基础设施。
前端编辑器尚未接入；没有 WebSocket 广播、服务端 CRDT 校验/合并或快照压缩。
二进制内容由客户端生成和解释，服务端仅校验编码、大小并持久化，不能把任意 JSON 当作可合并的编辑操作。

## 接口

以下路径均相对 `/api/collaboration`。

| 方法   | 路径                                               | 请求 / 返回                                                  |
| ------ | -------------------------------------------------- | ------------------------------------------------------------ |
| GET    | `/documents`                                       | 当前用户参与的文档数组                                       |
| POST   | `/documents`                                       | `{title, initialUpdate?: {operationId, data}}`，201 返回文档 |
| GET    | `/documents/:documentId`                           | 文档及当前角色、成员数、最新序号                             |
| DELETE | `/documents/:documentId`                           | 仅 owner，204；删除关联成员、更新、在线状态                  |
| GET    | `/documents/:documentId/members`                   | 成员数组                                                     |
| POST   | `/documents/:documentId/members`                   | 仅 owner，`{email, role}`，201；添加已注册且启用的用户       |
| PATCH  | `/documents/:documentId/members/:userId`           | 仅 owner，`{role}`                                           |
| DELETE | `/documents/:documentId/members/:userId`           | 仅 owner，204                                                |
| POST   | `/documents/:documentId/updates`                   | owner/editor，`{operationId, data}`，200 返回持久化更新      |
| GET    | `/documents/:documentId/updates?after=0&limit=100` | `{updates, nextCursor, hasMore}`                             |
| PUT    | `/documents/:documentId/presence/:sessionId`       | `{state: {...}}`，返回本会话在线状态                         |
| GET    | `/documents/:documentId/presence`                  | 最近 60 秒心跳的会话数组                                     |
| DELETE | `/documents/:documentId/presence/:sessionId`       | 204；只删除当前用户自己的会话                                |

文档 ID 由服务端生成。`operationId`、`sessionId` 由客户端生成 UUID。
标题去除首尾空白后须为 1–200 字符。角色只允许 `editor` 或 `viewer`，owner 不可变更或移除。
viewer 可以读取历史和上报自己的在线状态。非成员读取文档返回 404；成员权限不足返回 403。
全局 admin 身份不会绕过文档成员权限。

## 增量同步约定

1. 创建文档时可携带初始二进制状态，文档、owner 和初始更新在同一事务内创建。
2. `data` 必须是标准、带正确填充的 Base64，解码后大小为 1 字节至 1 MiB。
3. 每个本地更新分配一个 `operationId`；断线重试必须保留相同 ID 和内容。
   同一文档内，相同作者和内容的重复提交返回原更新；同 ID 不同内容或作者返回 409。
4. 从 `after=0` 开始拉取，依次应用响应中的更新。应用成功后再保存 `nextCursor`。
   `hasMore=true` 时继续拉取，默认及最大每页 100 条。
5. 序号是字符串表示的 PostgreSQL bigint。不要转成 JavaScript Number，不要假设连续。
   游标范围是 0 至 9223372036854775807；空页保留原游标。
6. PostgreSQL 对同一文档的更新事务加锁后分配序号，防止客户端跳过尚未提交的较小序号。
   写入时在事务内重新校验成员权限，并与成员降权/移除协调。

客户端还需负责重连、待提交队列、远端更新回放去重，以及防止远端更新被再次当作本地更新发送。
读取日志不会确认客户端已经成功应用更新。日志暂不压缩；应在大规模使用前增加快照与保留策略。

## 在线状态

每个浏览器标签页使用独立 sessionId，建议每 20 秒发送心跳，离开时删除会话。
服务端返回可信的 userId/userName；客户端自定义 state 仅用于光标等展示，不作为权限依据。
state 必须是 JSON 对象，含 JSONB 分隔符开销的保守大小上限为 8 KiB；不允许空字符。
会话不能被其他成员覆盖。移除成员会清理其在线状态，读列表也会过滤非成员。
心跳会清理同文档的过期记录；没有后续心跳的文档仍可能保留过期记录，但不会显示为在线。

## 验证

`pnpm --filter @automatic/api test` 包含权限、并发重试、分页、输入限制和在线状态隔离的接口测试。
`pnpm --filter @automatic/api typecheck` 和 `pnpm --filter @automatic/api build` 验证类型和构建。

设置 `COLLABORATION_TEST_DATABASE_URL` 后，同一测试命令还会执行真实 PostgreSQL 集成测试；
未设置时跳过该项。请使用本地或专用测试数据库，连接用户需要创建 schema 的权限。
测试在随机命名的独立 schema 中应用迁移，验证并发幂等写入、权限和在线状态，最后删除该测试 schema。
