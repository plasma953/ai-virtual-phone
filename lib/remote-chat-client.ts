// lib/remote-chat-client.ts
// VPS 中转回复（客户端侧）：
// 把 buildProviderRequest 的完整快照提交到自部署网关（tools/vps-chat-gateway），
// 轮询任务状态直到生成完成。浏览器与网关之间只有短请求：
// 断网/切后台/杀页面都不影响 VPS 上的生成，回来继续轮询同一 jobId 即可。

import { loadChatAppSettings, type RemoteGenerationSettings } from "./chat-storage";
/** 供 chat-engine / group-chat-engine 统一从此模块取远程设置类型 */
export type { RemoteGenerationSettings } from "./chat-storage";

/** 远程生成不可用自动回落本地时广播（chat-room 弹提示用） */
export const REMOTE_CHAT_FALLBACK_EVENT = "remote-chat-fallback";

export type RemoteJobRequest = {
    request: {
        url: string;
        headers: Record<string, string>;
        body: Record<string, unknown>;
        providerKind: string;
    };
    /** 服务端原样保留的元数据（预留：会话信息、正则等） */
    merge?: Record<string, unknown>;
    /** 幂等键：提交响应丢失后可用它向网关找回已创建的任务，避免重复生成 */
    dedupKey?: string;
};

export type RemoteJobStatus = "pending" | "generating" | "done" | "failed";

export type RemoteJob = {
    id: string;
    status: RemoteJobStatus;
    createdAt?: number;
    startedAt?: number;
    finishedAt?: number;
    /** status === "done" 时：LLM 原始响应 JSON 字符串 */
    output?: string;
    /** status === "failed" 时：错误信息 */
    error?: string;
    merge?: Record<string, unknown>;
};

const DEFAULT_POLL_INTERVAL_MS = 2500;
const DEFAULT_TOTAL_TIMEOUT_MS = 6 * 60 * 1000; // 6 分钟：VPS 单任务 5 分钟 + 排队余量

export function normalizeRemoteBaseUrl(raw: string): string {
    return String(raw || "").trim().replace(/\/+$/, "");
}

export function loadRemoteGenerationSettings(): RemoteGenerationSettings {
    return loadChatAppSettings().remoteGeneration ?? {};
}

export function isRemoteGenerationActive(): boolean {
    if (typeof window === "undefined") return false;
    const cfg = loadRemoteGenerationSettings();
    return Boolean(cfg.enabled && cfg.baseUrl && cfg.apiToken);
}

function remoteHeaders(cfg: RemoteGenerationSettings): Record<string, string> {
    return {
        "Content-Type": "application/json",
        "x-phone-token": cfg.apiToken || "",
    };
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/** 按幂等键找回任务 ID（提交响应丢失时用）。找不到返回 null；网络失败按 attempts 重试后仍失败则抛错。 */
export async function findRemoteJobByDedup(
    cfg: RemoteGenerationSettings,
    dedupKey: string,
    attempts = 3,
): Promise<{ id: string; status: string } | null> {
    const baseUrl = normalizeRemoteBaseUrl(cfg.baseUrl || "");
    let lastError: unknown = null;
    for (let i = 0; i < attempts; i++) {
        try {
            const response = await fetch(`${baseUrl}/v1/chat/jobs/by-dedup/${encodeURIComponent(dedupKey)}`, {
                method: "GET",
                headers: remoteHeaders(cfg),
            });
            if (response.status === 404) return null; // 网关明确告知没有此任务
            if (!response.ok) {
                lastError = new Error(`HTTP ${response.status}`);
                await sleep(800 * (i + 1));
                continue;
            }
            const data = await response.json().catch(() => ({})) as { ok?: boolean; job?: { id?: string; status?: string } };
            if (data.ok && data.job?.id) return { id: data.job.id, status: data.job.status || "pending" };
            return null;
        } catch (error) {
            lastError = error;
            if (i < attempts - 1) await sleep(800 * (i + 1));
        }
    }
    if (lastError) throw lastError;
    return null;
}
/** 提交生成任务，返回 jobId。失败抛错（含 30s 提交超时；网络失败会先尝试按 dedupKey 找回）。 */
export async function submitRemoteJob(cfg: RemoteGenerationSettings, job: RemoteJobRequest): Promise<string> {
    const baseUrl = normalizeRemoteBaseUrl(cfg.baseUrl || "");
    if (!baseUrl) throw new Error("远程网关地址未配置");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
        const response = await fetch(`${baseUrl}/v1/chat/jobs`, {
            method: "POST",
            headers: remoteHeaders(cfg),
            body: JSON.stringify(job),
            signal: controller.signal,
        });
        if (!response.ok) {
            const text = await response.text().catch(() => "");
            throw new Error(`网关提交失败 HTTP ${response.status}: ${text.slice(0, 200)}`);
        }
        const data = await response.json().catch(() => ({})) as { ok?: boolean; job?: { id?: string }; error?: string };
        if (!data.ok || !data.job?.id) throw new Error(data.error || "网关未返回任务 ID");
        return data.job.id;
    } catch (error) {
        // 网络层失败时任务可能已在网关创建（响应丢失）。按幂等键找回，不重复生成。
        if (job.dedupKey) {
            try {
                const recovered = await findRemoteJobByDedup(cfg, job.dedupKey, 3);
                if (recovered) {
                    console.warn("[remote-chat-client] submit failed but job recovered via dedupKey:", recovered.id);
                    return recovered.id;
                }
            } catch (recoverError) {
                console.warn("[remote-chat-client] dedup recovery failed:", recoverError);
            }
        }
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

/** 查询单个任务状态。 */
export async function fetchRemoteJob(cfg: RemoteGenerationSettings, jobId: string): Promise<RemoteJob> {
    const baseUrl = normalizeRemoteBaseUrl(cfg.baseUrl || "");
    const response = await fetch(`${baseUrl}/v1/chat/jobs/${encodeURIComponent(jobId)}`, {
        method: "GET",
        headers: remoteHeaders(cfg),
    });
    if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`网关查询失败 HTTP ${response.status}: ${text.slice(0, 200)}`);
    }
    const data = await response.json().catch(() => ({})) as { ok?: boolean; job?: RemoteJob; error?: string };
    if (!data.ok || !data.job) throw new Error(data.error || "网关返回异常");
    return data.job;
}

export type RemotePollOptions = {
    signal?: AbortSignal;
    /** 轮询间隔（毫秒），默认 2500；后续按 1.6 倍退避，上限 8000 */
    intervalMs?: number;
    /** 总等待上限（毫秒），默认 6 分钟 */
    timeoutMs?: number;
    /** 状态变化回调（可选，供 UI 显示进度） */
    onStatus?: (job: RemoteJob) => void;
};

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
        const err = new DOMException("Aborted", "AbortError");
        throw err;
    }
}

/** 轮询直到任务 done/failed/超时。返回终态任务。 */
export async function waitRemoteJob(cfg: RemoteGenerationSettings, jobId: string, options: RemotePollOptions = {}): Promise<RemoteJob> {
    const intervalMs = Math.max(1000, options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    const timeoutMs = Math.max(30_000, options.timeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS);
    const startedAt = Date.now();
    let currentInterval = intervalMs;
    let lastStatus: string = "";
    let consecutiveFailures = 0;
    while (true) {
        throwIfAborted(options.signal);
        let job: RemoteJob;
        try {
            job = await fetchRemoteJob(cfg, jobId);
            consecutiveFailures = 0;
        } catch (error) {
            // 单次轮询失败（网络抖动/切后台恢复）不放弃：退避重试，最多连续 6 次
            consecutiveFailures += 1;
            if (consecutiveFailures > 6) throw error;
            await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, Math.min(1200 * consecutiveFailures, 6000));
                options.signal?.addEventListener("abort", () => {
                    clearTimeout(timer);
                    resolve();
                }, { once: true });
            });
            continue;
        }
        if (job.status !== lastStatus) {
            lastStatus = job.status;
            try { options.onStatus?.(job); } catch { /* 回调异常不影响主流程 */ }
        }
        if (job.status === "done" || job.status === "failed") return job;
        if (Date.now() - startedAt > timeoutMs) {
            throw new Error(`远程生成超时（${Math.round(timeoutMs / 60000)} 分钟未完成），已取消等待`);
        }
        const delay = currentInterval;
        currentInterval = Math.min(8000, Math.round(currentInterval * 1.6));
        await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, delay);
            options.signal?.addEventListener("abort", () => {
                clearTimeout(timer);
                resolve();
            }, { once: true });
        });
    }
}

/** 网关连通性测试：GET /healthz。返回人话结果。 */
export async function testRemoteGateway(cfg: RemoteGenerationSettings): Promise<{ success: boolean; message: string }> {
    const baseUrl = normalizeRemoteBaseUrl(cfg.baseUrl || "");
    if (!baseUrl) return { success: false, message: "请先填写网关地址" };
    if (!cfg.apiToken) return { success: false, message: "请先填写网关令牌" };
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10_000);
        const response = await fetch(`${baseUrl}/healthz`, {
            method: "GET",
            headers: remoteHeaders(cfg),
            signal: controller.signal,
        });
        clearTimeout(timer);
        if (!response.ok) {
            const text = await response.text().catch(() => "");
            return { success: false, message: `网关返回 HTTP ${response.status}: ${text.slice(0, 120)}` };
        }
        const data = await response.json().catch(() => ({})) as { ok?: boolean; pending?: number; active?: number; requireToken?: boolean };
        if (!data.ok) return { success: false, message: "网关响应异常" };
        return {
            success: true,
            message: `连接成功！当前排队 ${data.pending ?? 0}，生成中 ${data.active ?? 0}${data.requireToken ? "" : "（网关为开放模式，未启用令牌校验）"}`,
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, message: `无法连接网关：${message}` };
    }
}
