# nte-login（Cloudflare Workers 版）

NTEUID 外置登录服务，支持塔吉多与完美世界短信登录。本目录运行在 Cloudflare Workers，使用 SQLite-backed Durable Objects 保存登录会话；仓库根目录保留 Python 自部署版，EdgeOne Pages 版在 `edgeone` 分支。

当前只实现 `http_poll`，API 路径和凭据结构与 NTEUID 现有外置登录协议兼容。

## 架构

- 入口 Worker 解析 `/nte/*` 请求，并根据 `auth` 路由到固定 Durable Object。
- 每个 `auth` 对应一个 Durable Object；同一会话的写入、状态消费和页面读取串行执行。
- 会话写入 Durable Object 的强一致 SQLite storage，不依赖最终一致的 Workers KV。
- Durable Object Alarm 在固定 TTL 到期后删除 Cookie、角色和登录凭据。
- `success` / `failed` 终态在 `/nte/status/{auth}` 首次读取后立即删除，只能消费一次。

## 准备

- Node.js 22 或更高版本
- Cloudflare 账号
- 已安装并登录 Wrangler：`npx wrangler login`

```sh
cd cloudflare
npm install
```

## 配置

先设置与 NTEUID 后台一致的共享密钥。Cloudflare 版不接受空密钥；密钥只进入 Cloudflare Secret，不要写进 `wrangler.jsonc`。

首次从本地部署时，通过进程环境将密钥交给部署脚本；脚本只会创建权限为 `0600` 的临时 JSON 文件，并在 Wrangler 退出后删除：

```sh
SHARED_SECRET='和_NTELoginSecret_一致' npm run deploy
```

Worker 已存在且远端 Secret 已配置后，后续可以直接运行 `npm run deploy`，Wrangler 会继承现有 Secret。

`wrangler.jsonc` 内还有三个非敏感配置：

| 变量             | 默认值 | 说明                                        |
| ---------------- | -----: | ------------------------------------------- |
| `SESSION_TTL_S`  |  `600` | 登录会话有效期，允许 60–3600 秒             |
| `SIG_TTL_S`      |  `300` | HMAC 请求签名有效期                         |
| `SMS_COOLDOWN_S` |   `60` | 同一会话服务端短信发送冷却；设为 `0` 可关闭 |

本地开发可新建不会提交的 `.dev.vars`：

```dotenv
SHARED_SECRET=和_NTELoginSecret_一致
```

## 本地验证

```sh
npm run check
npm run dev
```

`npm run check` 会依次执行严格 TypeScript 检查、Workers/Miniflare 集成测试和 Wrangler dry-run 打包。

## 部署

### Cloudflare Workers Builds

在 Cloudflare 连接本仓库时使用以下配置：

| 字段           | 值                       |
| -------------- | ------------------------ |
| Git 仓库       | `tyql688/nte-login`      |
| 项目名称       | `nte-login`              |
| 生产分支       | `main`                   |
| 根目录         | `/cloudflare`            |
| 构建命令       | `npm run check`          |
| 部署命令       | `npm run deploy`         |
| 非生产分支构建 | 关闭                     |
| 构建监控路径   | 保持默认                 |
| API 令牌       | 让 Cloudflare 创建新令牌 |

新增一个加密的构建 Secret：

| 变量            | 值                              |
| --------------- | ------------------------------- |
| `SHARED_SECRET` | 与 NTEUID `NTELoginSecret` 相同 |

`npm run deploy` 会在首次部署时把该构建 Secret 作为 Worker 运行时 Secret 上传。API 令牌应让 Cloudflare 自动新建，不要复用其他项目的受限令牌。

保存配置后，选择“部署最新提交”（如界面提供），或向 `main` 推送一个新提交以触发构建。只修改分支或根目录不会重新运行旧构建，也不要重试修改配置前生成的历史构建。

正确构建会在 `/cloudflare` 中检测到 `package.json`，并执行 `npm ci`、`npm run check` 和 `npm run deploy`。若日志执行 `uv sync`，或提示仓库根目录不存在 `package.json`，说明生产分支或根目录仍然配置错误。若 API 令牌显示“不可用”，必须先重新创建令牌，部署阶段无法绕过该授权。

### Wrangler

```sh
npm run deploy
```

首次部署会按 `wrangler.jsonc` 中的 `v1` migration 创建 `LoginSessionDurableObject` SQLite namespace。不要删除或复用已经发布的 migration tag。

正式使用建议给 Worker 绑定自定义域名，并从真实用户网络验证：

1. 登录页面和完美世界验证码脚本可加载。
2. Worker 能访问 `user.laohu.com`、`id.wanmei.com` 和 `kf.wanmei.com`。
3. 塔吉多与完美世界都能完成“发短信 → 登录 → NTEUID 消费凭据”闭环。

Cloudflare 全球网络在中国大陆的延迟和连通性不能由本地 Miniflare 证明，发布前必须做大陆网络实测。

## NTEUID 后台对应

| 字段                | 值                            |
| ------------------- | ----------------------------- |
| `NTELoginTransport` | `http_poll`                   |
| `NTELoginUrl`       | Worker 自定义域名或部署 URL   |
| `NTELoginSecret`    | 同 Cloudflare `SHARED_SECRET` |
| `NTELoginTTL`       | 建议与 `SESSION_TTL_S` 一致   |

## API

保持以下现有路径：

- `POST /nte/start`
- `GET /nte/i/{auth}`
- `POST /nte/sendSmsCode`
- `POST /nte/login`
- `POST /nte/wanmei/prepare`
- `POST /nte/wanmei/sendSmsCode`
- `POST /nte/wanmei/login`
- `POST /nte/wanmei/selectRole`
- `GET /nte/status/{auth}`
- `GET /nte/done`

SSE 和 WebSocket 暂未实现。
