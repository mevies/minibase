# Auth JWT 签名密钥轮换

Minibase 将 Auth JWT 签名密钥保存在项目的 `.minibase/secrets.json` 中。
该文件属于运行数据，不能提交到版本库、复制到客户端或写入普通日志。

也可以通过进程环境变量 `MINIBASE_AUTH_JWT_SECRET`，或由 `MINIBASE_SECRETS_FILE` / `minibase.toml`
中的 `[secrets] file = "private.env"` 指向外部 dotenv 文件。外部文件只接受以下凭据变量：

- `MINIBASE_AUTH_JWT_SECRET`
- `MINIBASE_DATABASE_URL`
- `MINIBASE_S3_ACCESS_KEY_ID`
- `MINIBASE_S3_SECRET_ACCESS_KEY`
- `MINIBASE_S3_SESSION_TOKEN`

进程环境变量优先于外部 Secret 文件，外部 Secret 文件优先于 `minibase.toml` 中的普通配置。外部 Auth
Secret 至少需要 32 个字符；Minibase 只在内存中使用它，不会创建 `.minibase/secrets.json`。

## 密钥格式与兼容性

当前格式使用 `formatVersion: 1`、一个 `activeKid` 和多个 `signingKeys`。Minibase 本地管理的活动密钥
使用 P-256/ES256，新签发的 JWT 在 Header 中包含 `alg: "ES256"` 和 `kid`；验证时按算法与 `kid`
选择密钥。ES256 条目保存私有 JWK 和公开 JWK，私钥字段 `d` 与旧 HMAC Secret 具有相同的 Secret
保护等级。

旧版 `{ "jwtSecret": "..." }` 文件和仅含 HS256 密钥的 `formatVersion: 1` keyring 会在首次启动或执行
Auth key CLI 时自动迁移。迁移生成并激活一个新的 ES256 密钥，同时保留原 Secret，因此迁移前签发、 没有
`kid` 或带旧 `kid` 的 HS256 JWT 仍可由保留密钥验证。迁移不会修改 `supabase/` 下的任何文件，
再次加载也不会重复生成密钥。

Minibase 可以从 keyring 生成只含 `kty`、`crv`、`x`、`y`、`kid`、`alg` 和 `use` 的公开 JWKS。 公开
JWKS 不包含 `d`、旧 HMAC Secret 或完整私有 JWK；它用于让 Function Runtime 验证用户 Token，
不能用于签发 Token。`minibase doctor` 会导入 ES256 公私钥并执行签名/验证探针，以发现损坏或不匹配的
密钥对，但诊断输出不包含私钥材料。

## 安全轮换流程

1. 停止 Minibase：`minibase stop --project <path>`。
2. 创建并激活新的 ES256 密钥：`minibase auth keys rotate --project <path> --json`。
3. 启动 Minibase。新的 Access Token、Service Role Token 和 Storage 签名 Token 使用新 `kid`；旧密钥仍
   保留，所以已签发 Token 不会立即失效。
4. 等待需要保留的旧 Token 过期。普通 Access Token 当前有效期为 15 分钟；Service Role Token 最长可达
   1 年；Storage 签名 Token 最长 7 天。实际等待时间必须按部署中签发过的最长 Token 决定。
5. 如需回滚，停止服务后执行 `minibase auth keys activate --kid <old-kid> --project <path> --json`。
6. 确认旧 Token 可以失效后，停止服务并执行
   `minibase auth keys remove --kid <old-kid> --project <path> --force --json`。

`list`、`rotate`、`activate` 和 `remove` 的输出只包含 `kid`、算法、创建时间和活动状态，不包含 HMAC
Secret、私钥 `d` 或私有 JWK。修改命令在服务运行时会被拒绝，避免磁盘 keyring 与进程内 keyring
不一致。

活动密钥不能被删除。

## 外部管理的 Auth Secret

使用 `MINIBASE_AUTH_JWT_SECRET` 时，`auth keys list/rotate/activate/remove` 会明确拒绝执行。外部
Secret 管理系统负责生成、授权、更新、回滚和审计该值；Minibase CLI 不会改写外部文件。该兼容输入
仍使用 HS256，不会被写入本地 keyring，也无法生成只含公钥的安全 JWKS。更新后需要重启 Minibase，
使新进程加载新值。直接替换单个 HS256 Secret 会让旧 Secret 签发的现有 JWT 立即失效，因此需要保留 旧
Token 的部署应先在上游 Secret 管理与发布流程中设计重叠验证或维护窗口。依赖公开 JWKS 的高级 Function
Context 在外部 HS256 模式下必须明确拒绝或报告不可用，不能把对称 Secret 暴露为 JWK。

外部文件必须是普通文件、不得超过 1 MiB。为了兼容 Kubernetes 等 Secret volume，loader 会跟随指向
普通文件的符号链接；`minibase doctor` 会将链接报告为风险提示，并检查非链接文件的 Unix 权限或 Windows
ACL。符号链接目标、挂载权限和原子轮换均由部署方负责。

## 运维注意事项

- 轮换不会撤销数据库中的 Refresh Token；Refresh Token 下次换取 Access Token 时会使用当前活动密钥。
- 删除旧密钥会立即使该 `kid` 签发的 Access、Service Role 和 Storage 签名 Token 失效。
- 回滚激活保留的 HS256 密钥会使新 Token 暂时恢复使用 HS256；这只用于受控迁移回滚，依赖公开 JWKS
  的能力在此期间不可用。
- `.minibase/secrets.json` 丢失后无法验证现有 JWT；应使用受控的 Secret 备份与恢复流程保护该文件。
- 不要通过聊天、工单、命令输出或日志传递 Secret；跨机器部署应使用受控的 Secret 管理渠道。
