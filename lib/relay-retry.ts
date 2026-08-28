// lib/relay-retry.ts
// 上游中继错误分类与自动重试（#sym:500 溯源，2026-08-27）。
// 生产实测结论：体积/长历史/生成超时均不是 #sym:500 的诱因
// （2.6MB 请求体、43 万字符多轮历史、69s 长生成全部 200 通过）。
// 真实故障源组合为：
//   1) 模型名渠道前缀缺失 → 404「未知或不可用模型」（catiecli 要求
//      gcli-/agy- 前缀，已由 api-helpers.resolveRelayModelName 自动适配）
//   2) 中继限速 10 次/分钟 → 429「速率限制」（主聊天与 20+ 后台任务共用同一 Key）
//   3) 上游凭证池/无头浏览器渠道随机故障 → 500「#sym:500」（符号化汇总错误码）
// 对可恢复错误（429/5xx）做有限自动重试，并把原始报错翻译成可读的中文提示。
// chat-engine（主聊天）与 api-helpers.simpleLLMCall（后台任务）共用。

const RELAY_RETRY_ATTEMPTS = 2;
const RELAY_RETRY_BASE_DELAY_MS = 2500;

export function classifyHttpError(status: number, body: string, url: string): string {
    const isCatiecli = /catiecli/i.test(url);
    if (status === 429) {
        return "上游中继限速（约 10 次/分钟）。后台任务与主聊天共用同一额度，已自动等待重试；若仍失败请稍候片刻再发送。";
    }
    if (status === 404 && /未知或不可用模型/.test(body)) {
        return isCatiecli
            ? "上游中继不认识当前模型名。若配置的是裸名（如 gemini-3.1-pro-preview），请给模型名加上 gcli- 前缀（gcli-gemini-3.1-pro-preview）。"
            : `模型不可用：${body.slice(0, 120)}`;
    }
    if (status >= 500) {
        return /#sym:500/.test(body)
            ? "上游中继通道暂时故障（#sym:500）：中继的凭证池或生成渠道不可用，与你的消息历史/体积无关，已自动重试。"
            : `上游服务异常（HTTP ${status}），已自动重试。原始返回：${body.slice(0, 160)}`;
    }
    return `API Error ${status}: ${body}`;
}

/**
 * 把 fetch 网络层异常翻译成可读提示：明确「与消息体积/token 数无关」，
 * 避免用户误以为是自己内容太长导致（实测 2.6MB 请求体都能 200 通过）。
 */
export function describeNetworkFetchError(detail: string): string {
    if (/failed to fetch|load failed|networkerror|err_(connection|network|internet)|fetch failed/i.test(detail)) {
        return "设备网络瞬断（Wi‑Fi/流量切换、DNS 或 TLS 抖动），请求未到达服务器——与消息体积和 token 数无关。已自动重试仍未成功，请稍候重发。";
    }
    return detail;
}

export async function fetchWithRelayRetry(
    doFetch: () => Promise<Response>,
    externalSignal?: AbortSignal,
): Promise<Response> {
    for (let attempt = 0; attempt <= RELAY_RETRY_ATTEMPTS; attempt += 1) {
        let response: Response;
        try {
            response = await doFetch();
        } catch (error) {
            // 网络层异常（TypeError: Failed to fetch / Load failed）：请求根本没拿到
            // HTTP 响应——瞬断网、DNS 抖动、TLS 重置、中继瞬时重启等瞬时抖动。
            // 与消息体积/内容无关（fetch 抛异常时服务器从未给出状态码）。
            // 移动端网络极易瞬时抖动，这里必须自动重试（此前只重试 HTTP 429/5xx，
            // 网络层异常直接穿透导致零容忍报错）。
            if (error instanceof DOMException && error.name === "AbortError") throw error;
            if (externalSignal?.aborted) throw error;
            if (attempt >= RELAY_RETRY_ATTEMPTS) throw error;
            // 网络抖动的恢复窗口比 HTTP 错误更短，退避稍快（2x 步进）
            const waitMs = RELAY_RETRY_BASE_DELAY_MS * (attempt + 1) * 2;
            console.warn(`[relay-retry] 网络层异常（${error instanceof Error ? error.message : String(error)}），第 ${attempt + 1}/${RELAY_RETRY_ATTEMPTS} 次自动重试，等待 ${waitMs}ms`);
            await new Promise<void>((resolve) => {
                let timer: ReturnType<typeof setTimeout> | undefined;
                const onAbort = () => { if (timer) clearTimeout(timer); resolve(); };
                timer = setTimeout(() => {
                    externalSignal?.removeEventListener("abort", onAbort);
                    resolve();
                }, waitMs);
                externalSignal?.addEventListener("abort", onAbort);
            });
            continue;
        }
        if (response.ok) return response;
        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable || attempt >= RELAY_RETRY_ATTEMPTS) return response;
        // 429 等待更久（限速窗口约 1 分钟），5xx 短暂退避即可
        const waitMs = RELAY_RETRY_BASE_DELAY_MS * (attempt + 1) * (response.status === 429 ? 3 : 1);
        console.warn(`[relay-retry] HTTP ${response.status}，第 ${attempt + 1}/${RELAY_RETRY_ATTEMPTS} 次自动重试，等待 ${waitMs}ms`);
        await new Promise<void>((resolve) => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const onAbort = () => { if (timer) clearTimeout(timer); resolve(); };
            timer = setTimeout(() => {
                externalSignal?.removeEventListener("abort", onAbort);
                resolve();
            }, waitMs);
            externalSignal?.addEventListener("abort", onAbort);
        });
    }
    // 理论不可达：循环必然在上方 return
    throw new Error("unreachable: relay retry loop");
}
