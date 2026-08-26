# VPS 中转回复网关（vps-chat-gateway）

把「AI 回复生成」从浏览器搬到 VPS 上：前端提交完整的 LLM 请求快照，
服务端在机房网络里一次性生成，前端轮询拿回结果。浏览器与 VPS 之间
只有短请求，**天然免疫流式生成中断**（切后台、弱网、锁屏都不影响生成）。

> 零依赖，Node 18+ 即可运行，无需 npm install。

## 1. 部署到 VPS

```bash
# 上传本目录（scp / git 均可）
mkdir -p ~/apps && cd ~/apps
scp -r tools/vps-chat-gateway root@108.165.20.235:~/apps/
ssh root@108.165.20.235

cd ~/apps/vps-chat-gateway

# 生成随机网关令牌（与前端设置页里填的必须一致）
export PHONE_GATEWAY_TOKEN=$(openssl rand -hex 24)

# 前台试跑
node server.mjs

# 确认健康检查
curl http://127.0.0.1:8795/healthz
# → {"ok":true,"pending":0,"active":0,...}
```

### systemd 常驻（推荐）

```bash
cat > /etc/systemd/system/phone-chat-gateway.service <<'EOF'
[Unit]
Description=AI Phone VPS Chat Gateway
After=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/apps/vps-chat-gateway
Environment=PORT=8795
Environment=PHONE_GATEWAY_TOKEN=换成上一步生成的令牌
Environment=MAX_CONCURRENT=2
Environment=LLM_TIMEOUT_MS=300000
ExecStart=/usr/bin/node server.mjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now phone-chat-gateway
systemctl status phone-chat-gateway
```

## 2. Caddy 反代（与你的 43451695.xyz 配置一致）

```caddyfile
chat.43451695.xyz {
    reverse_proxy 127.0.0.1:8795
    encode gzip
}
```

然后给 `chat.43451695.xyz` 加一条 A 记录指向 `108.165.20.235`，`caddy reload`。
（域名 DNS 解析与 Caddy 站点配置按你现有的方式处理即可，无需 Cloudflare。）

## 3. 前端配置

小手机里：**设置 → 远程生成**：

| 字段 | 填写 |
|---|---|
| 启用远程中转 | 开 |
| 网关地址 | `https://chat.43451695.xyz`（或 `http://IP:8795`） |
| 网关令牌 | 与 VPS `PHONE_GATEWAY_TOKEN` 一致 |

点「测试连接」验证通过后，回到聊天即可使用。

## 4. 接口协议

```
POST /v1/chat/jobs
  headers: { "x-phone-token": "<token>" }
  body: {
    "request": { "url": "...", "headers": {...}, "body": {...}, "providerKind": "openai-compatible" },
    "merge": { ...任意元数据，服务端原样保留 }
  }
  → { "ok": true, "job": { "id": "job_xxx", "status": "pending" } }

GET /v1/chat/jobs/:id
  → { "ok": true, "job": { "id", "status": "pending|generating|done|failed",
       "output": "<LLM 原始响应 JSON 字符串，仅 done 时存在>", "error": "<仅 failed>" } }

GET /healthz
  → { "ok": true, "pending": 0, "active": 0, "uptimeSec": 123 }
```

要点：

- 服务端**不解析任何 LLM 协议**，响应原文回传；前端复用本地
  `parseProviderResponse` 解析，行为与本地生成 100% 一致（含 reasoning、原生工具字段）；
- 任务落盘于 `jobs/` 目录，重启不丢；已完成任务 12 小时自动清理；
- 全局排队上限 40、并发 2、单任务 300s 超时（均可环境变量调整）；
- 未设置 `PHONE_GATEWAY_TOKEN` 时为开放模式，仅建议内网使用。

## 5. 常见问题

- **回复很慢 / 一直排队**：看 `journalctl -u phone-chat-gateway -f`，`pending` 数是否持续增长；调整 `MAX_CONCURRENT`。
- **前端提示「远程中转不可用，已自动改为本地生成」**：网关地址/令牌错误、VPS 未开防火墙端口，或 Caddy 证书问题；先用 `curl -H "x-phone-token: xxx" https://chat.43451695.xyz/healthz` 排障。
- **LLM 密钥安全**：请求快照包含 API Key 透传到 VPS。网关按 IP 排布属你自己的 VPS，风险可控；若要更严格，可把网关挂在仅自己的站点上使用并设置令牌。
