// tools/vps-chat-gateway/server.mjs
// AI 虚拟手机 · VPS 中转回复网关（零依赖，Node 18+）
//
// 职责：接收前端提交的「完整 LLM 请求快照」，在服务端网络环境下完成
//       一次性非流式生成，前端轮询拿回结果后走本地同一条解析管线落库。
//       浏览器与 VPS 之间只有短请求，天然免疫流式中断。
//
// 运行：
//   node server.mjs
// 环境变量（可选）：
//   PORT                监听端口，默认 8795
//   PHONE_GATEWAY_TOKEN 网关令牌。设置后客户端必须携带
//                       x-phone-token: <token> 或 Authorization: Bearer <token>；
//                       不设置则开放模式（仅建议内网使用）。
//   MAX_CONCURRENT      同时进行的 LLM 请求数，默认 2
//   LLM_TIMEOUT_MS      单次 LLM 请求超时，默认 300000（5 分钟）
//   JOB_TTL_MS          任务保留时长，默认 12 小时
//
// 接口：
//   POST /v1/chat/jobs        提交生成任务 → { ok, job: { id, status: "pending" } }
//     body: { request: { url, headers, body, providerKind }, merge: {...任意元数据，服务端原样保留}, dedupKey?: string }
//     dedupKey: 可选幂等键（1-64 位字母数字下划线连字符）。同一键重复提交时直接返回
//               已有任务 ID（即使提交响应在客户端丢失，重提/查询也能找回原任务，不重复生成）。
//   GET  /v1/chat/jobs/:id    查询任务 → { ok, job: { id, status, output?, error?, createdAt, startedAt, finishedAt } }
//     status: pending | generating | done | failed
//     output: LLM 返回的原始响应 JSON 字符串（由前端用其本地解析器解析，协议零耦合）
//   GET  /v1/chat/jobs/by-dedup/:key  按 dedupKey 找回任务 → { ok, job: { id, status } } 或 404
//   GET  /healthz              健康检查 → { ok, pending, active, uptimeSec }
//
// 说明：服务端不解析任何 LLM 协议——openai-compatible / anthropic / gemini
//       的响应原文回传，前端复用 lib/llm-provider-adapter 的 parseProviderResponse
//       解析，与本地生成行为 100% 一致。

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 8795);
const GATEWAY_TOKEN = (process.env.PHONE_GATEWAY_TOKEN || "").trim();
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 2);
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 300_000);
const JOB_TTL_MS = Number(process.env.JOB_TTL_MS || 12 * 60 * 60 * 1000);
const MAX_PAYLOAD_BYTES = 1024 * 1024; // 1MB
const MAX_OPEN_JOBS = 40; // 未完成任务的全局上限，防滥用
const JOBS_DIR = path.join(__dirname, "jobs");

// ── 任务存储（每任务一个 JSON 文件，原子写，重启不丢） ──────────────
if (!fs.existsSync(JOBS_DIR)) fs.mkdirSync(JOBS_DIR, { recursive: true });

const jobPath = (id) => path.join(JOBS_DIR, `${id}.json`);
const jobExists = (id) => fs.existsSync(jobPath(id));

function readJob(id) {
    try {
        return JSON.parse(fs.readFileSync(jobPath(id), "utf8"));
    } catch {
        return null;
    }
}

function writeJob(job) {
    const tmp = `${jobPath(job.id)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(job));
    fs.renameSync(tmp, jobPath(job.id));
}

// 启动时加载并清理过期任务
function loadAllJobs() {
    const jobs = new Map();
    for (const file of fs.readdirSync(JOBS_DIR)) {
        if (!file.endsWith(".json")) continue;
        try {
            const job = JSON.parse(fs.readFileSync(path.join(JOBS_DIR, file), "utf8"));
            jobs.set(job.id, job);
        } catch { /* 忽略损坏文件 */ }
    }
    return jobs;
}

const jobs = loadAllJobs();

function cleanupExpiredJobs() {
    const now = Date.now();
    for (const [id, job] of jobs) {
        if (job.status !== "pending" && job.status !== "generating") {
            const finished = Number(job.finishedAt || job.createdAt || 0);
            if (finished && now - finished > JOB_TTL_MS) {
                jobs.delete(id);
                try { fs.unlinkSync(jobPath(id)); } catch { /* ignore */ }
            }
        }
    }
}
cleanupExpiredJobs();
const cleanupTimer = setInterval(cleanupExpiredJobs, 30 * 60 * 1000);
cleanupTimer.unref();

// ── 鉴权 ─────────────────────────────────────────────────────────────
function isAuthorized(req) {
    if (!GATEWAY_TOKEN) return true; // 开放模式
    const headerToken = String(req.headers["x-phone-token"] || "");
    const authHeader = String(req.headers["authorization"] || "");
    const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    const candidates = [headerToken, bearerToken].filter(Boolean);
    const expected = Buffer.from(GATEWAY_TOKEN);
    for (const token of candidates) {
        const buf = Buffer.from(token);
        if (buf.length === expected.length && crypto.timingSafeEqual(buf, expected)) return true;
    }
    return false;
}

// ── CORS ─────────────────────────────────────────────────────────────
const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Phone-Token, Authorization",
    "Access-Control-Max-Age": "86400",
};

function sendJson(res, status, data) {
    const body = JSON.stringify(data);
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        ...CORS_HEADERS,
    });
    res.end(body);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on("data", (chunk) => {
            size += chunk.length;
            if (size > MAX_PAYLOAD_BYTES + 64 * 1024) {
                const err = new Error("payload too large");
                err.code = "PAYLOAD_TOO_LARGE";
                reject(err);
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
    });
}

function validateJobPayload(payload) {
    if (!payload || typeof payload !== "object") return "缺少请求体";
    const request = payload.request;
    if (!request || typeof request !== "object") return "缺少 request 快照";
    if (typeof request.url !== "string" || !/^https?:\/\//.test(request.url)) return "request.url 必须是 http(s) 地址";
    if (!request.headers || typeof request.headers !== "object") return "request.headers 缺失";
    if (!request.body || typeof request.body !== "object") return "request.body 缺失";
    return null;
}

// ── 生成执行器（简单并发池） ─────────────────────────────────────────
let activeCount = 0;
let workerRunning = false;

async function runJob(job) {
    const payload = job.payload;
    job.status = "generating";
    job.startedAt = Date.now();
    writeJob(job);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
    try {
        const llmResponse = await fetch(payload.request.url, {
            method: "POST",
            headers: payload.request.headers,
            body: JSON.stringify(payload.request.body),
            signal: controller.signal,
        });
        if (!llmResponse.ok) {
            const errorText = await llmResponse.text().catch(() => "");
            throw new Error(`LLM HTTP ${llmResponse.status}: ${errorText.slice(0, 300)}`);
        }
        const rawText = await llmResponse.text();
        job.status = "done";
        job.output = rawText;
        job.finishedAt = Date.now();
        writeJob(job);
        console.log(`[gateway] job ${job.id} done (${rawText.length} bytes)`);
    } catch (error) {
        const aborted = error && (error.name === "AbortError" || String(error.message || error).includes("aborted"));
        const message = aborted ? `LLM 请求超时（${Math.round(LLM_TIMEOUT_MS / 1000)}s）` : String(error?.message || error);
        job.status = "failed";
        job.error = message;
        job.finishedAt = Date.now();
        writeJob(job);
        console.warn(`[gateway] job ${job.id} failed: ${message}`);
    } finally {
        clearTimeout(timeout);
        activeCount -= 1;
    }
}

async function workerLoop() {
    if (workerRunning) return;
    workerRunning = true;
    try {
        while (true) {
            if (activeCount >= MAX_CONCURRENT) break;
            // 按提交顺序取一个 pending 任务
            const pending = [...jobs.values()]
                .filter((job) => job.status === "pending")
                .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0))[0];
            if (!pending) break;
            activeCount += 1;
            void runJob(pending);
        }
    } finally {
        workerRunning = false;
    }
}

function kickWorker() {
    setImmediate(() => { void workerLoop(); });
}

// ── HTTP 服务器 ──────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
        res.writeHead(204, CORS_HEADERS);
        res.end();
        return;
    }

    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname.replace(/\/+$/, "") || "/";

    if (!isAuthorized(req)) {
        sendJson(res, 401, { ok: false, error: "unauthorized: token 无效" });
        return;
    }

    // GET /healthz
    if (req.method === "GET" && pathname === "/healthz") {
        sendJson(res, 200, {
            ok: true,
            pending: [...jobs.values()].filter((j) => j.status === "pending").length,
            active: activeCount,
            total: jobs.size,
            uptimeSec: Math.round(process.uptime()),
            requireToken: Boolean(GATEWAY_TOKEN),
        });
        return;
    }

    // POST /v1/chat/jobs
    if (req.method === "POST" && pathname === "/v1/chat/jobs") {
        try {
            const raw = await readBody(req);
            if (raw.length > MAX_PAYLOAD_BYTES) {
                sendJson(res, 413, { ok: false, error: `payload 超过 ${Math.round(MAX_PAYLOAD_BYTES / 1024)}KB 上限` });
                return;
            }
            const payload = JSON.parse(raw.toString("utf8"));
            const invalid = validateJobPayload(payload);
            if (invalid) {
                sendJson(res, 400, { ok: false, error: invalid });
                return;
            }
            const openCount = [...jobs.values()].filter((j) => j.status === "pending" || j.status === "generating").length;
            if (openCount >= MAX_OPEN_JOBS) {
                sendJson(res, 429, { ok: false, error: `排队任务过多（上限 ${MAX_OPEN_JOBS}），请稍后再试` });
                return;
            }
            // 幂等：同一 dedupKey 已有任务时直接返回已有任务（响应丢失后重提/找回不重复生成）
            const dedupKey = typeof payload.dedupKey === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(payload.dedupKey)
                ? payload.dedupKey
                : "";
            if (dedupKey) {
                const existing = [...jobs.values()].find((j) => j.dedupKey === dedupKey);
                if (existing) {
                    const finished = Number(existing.finishedAt || 0);
                    const expired = finished && Date.now() - finished > JOB_TTL_MS;
                    if (!expired) {
                        sendJson(res, 200, { ok: true, job: { id: existing.id, status: existing.status }, dedup: true });
                        return;
                    }
                    // 旧任务已过保留期但尚未被定时清理：立即移除，避免 by-dedup 找回命中过期任务导致幂等失效
                    jobs.delete(existing.id);
                    try { fs.unlinkSync(jobPath(existing.id)); } catch { /* ignore */ }
                }
            }
            const job = {
                id: `job_${Date.now().toString(36)}_${crypto.randomBytes(6).toString("hex")}`,
                status: "pending",
                createdAt: Date.now(),
                dedupKey: dedupKey || undefined,
                payload: {
                    request: {
                        url: payload.request.url,
                        headers: payload.request.headers,
                        body: payload.request.body,
                        providerKind: typeof payload.request.providerKind === "string" ? payload.request.providerKind : "openai-compatible",
                    },
                    merge: payload.merge && typeof payload.merge === "object" ? payload.merge : {},
                },
            };
            jobs.set(job.id, job);
            writeJob(job);
            kickWorker();
            console.log(`[gateway] job ${job.id} queued → ${payload.request.url}`);
            sendJson(res, 200, { ok: true, job: { id: job.id, status: job.status } });
        } catch (error) {
            if (error?.code === "PAYLOAD_TOO_LARGE") {
                sendJson(res, 413, { ok: false, error: `payload 超过 ${Math.round(MAX_PAYLOAD_BYTES / 1024)}KB 上限` });
                return;
            }
            const message = String(error?.message || error);
            sendJson(res, 400, { ok: false, error: `invalid payload: ${message}` });
        }
        return;
    }

    // GET /v1/chat/jobs/by-dedup/:key —— 提交响应丢失后按幂等键找回任务
    const byDedupMatch = pathname.match(/^\/v1\/chat\/jobs\/by-dedup\/([A-Za-z0-9_-]{1,64})$/);
    if (req.method === "GET" && byDedupMatch) {
        const key = byDedupMatch[1];
        const existing = [...jobs.values()].find((j) => j.dedupKey === key
            && !(j.finishedAt && Date.now() - Number(j.finishedAt) > JOB_TTL_MS));
        if (!existing) {
            sendJson(res, 404, { ok: false, error: "dedup key not found" });
            return;
        }
        sendJson(res, 200, {
            ok: true,
            job: {
                id: existing.id,
                status: existing.status,
                createdAt: existing.createdAt,
                finishedAt: existing.finishedAt,
            },
        });
        return;
    }
    // GET /v1/chat/jobs/:id
    const jobMatch = pathname.match(/^\/v1\/chat\/jobs\/([A-Za-z0-9_-]+)$/);
    if (req.method === "GET" && jobMatch) {
        const id = jobMatch[1];
        const job = jobs.get(id) || readJob(id);
        if (!job) {
            sendJson(res, 404, { ok: false, error: "task not found" });
            return;
        }
        sendJson(res, 200, {
            ok: true,
            job: {
                id: job.id,
                status: job.status,
                createdAt: job.createdAt,
                startedAt: job.startedAt,
                finishedAt: job.finishedAt,
                output: job.status === "done" ? job.output : undefined,
                error: job.status === "failed" ? job.error : undefined,
                merge: job.payload?.merge,
            },
        });
        return;
    }

    sendJson(res, 404, { ok: false, error: "not found" });
});

server.listen(PORT, "0.0.0.0", () => {
    console.log(`[vps-chat-gateway] listening on 0.0.0.0:${PORT}`);
    console.log(`[vps-chat-gateway] auth: ${GATEWAY_TOKEN ? "token required" : "OPEN (no token set — internal network only)"}`);
    console.log(`[vps-chat-gateway] concurrency: ${MAX_CONCURRENT}, llm timeout: ${Math.round(LLM_TIMEOUT_MS / 1000)}s, job ttl: ${Math.round(JOB_TTL_MS / 3600000)}h`);
});
