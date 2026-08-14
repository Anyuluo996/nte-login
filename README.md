# nte-login

NTEUID 外置登录服务。支持塔吉多与完美世界短信登录，让 bot 端无需对外暴露端口。

## 启动

```sh
uv sync && uv run start          # 本地
docker compose up -d --build     # docker compose（推荐，自动读 .env）
docker build -t nte-login . && docker run -d -p 7861:7861 nte-login   # 纯 docker
```

默认监听 `0.0.0.0:7861`，裸跑即可。

## 配置（环境变量 / `.env`）

```sh
cp .env.example .env             # 拷一份再按需改
```

| 变量            | 默认   | 说明                                                |
| --------------- | ------ | --------------------------------------------------- |
| `PORT`          | `7861` |                                                     |
| `SHARED_SECRET` | 空     | 启用 HMAC 签名校验；与 NTEUID `NTELoginSecret` 一致 |
| `SESSION_TTL_S` | `600`  | 会话存活秒数                                        |
| `LOG_LEVEL`     | `INFO` |                                                     |

## NTEUID 后台

| 字段                | 值                                             |
| ------------------- | ---------------------------------------------- |
| `NTELoginTransport` | `http_poll` / `sse` / `ws`                     |
| `NTELoginUrl`       | 本服务对外地址，如 `https://login.example.com` |
| `NTELoginSecret`    | 同 `SHARED_SECRET`，可留空                     |
