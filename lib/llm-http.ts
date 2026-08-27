// lib/llm-http.ts
// LLM 请求的统一 fetch 出口。所有走 buildProviderRequest 的调用点统一经它发请求：
//  - 普通 provider：浏览器直连（现状不变）；
//  - serverProxy 标记（OpenCode 网关）：改发本站 /api/llm-proxy，由服务端转发，
//    绕过 opencode.ai 未开放浏览器 CORS 的问题。

import type { LlmRequestPayload } from "./llm-provider-adapter";
import { TOTAL_BYTES_ABS_CAP } from "./prompt-guard";

export type FetchLlmPayloadOptions = {
    signal?: AbortSignal;
};

export function fetchLlmPayload(
    payload: LlmRequestPayload,
    options: FetchLlmPayloadOptions = {},
): Promise<Response> {
    const bodyText = JSON.stringify(payload.body);
    // 物理保险丝（#sym:500 最后防线）：正常路径在 buildProviderRequest /
    // simpleLLMCall 内已被双轨总闸裁剪，此处不应触发。一旦触发说明存在
    // 未知新路径绕过了钳制——宁可熔断单次请求，也不允许超限 body 打爆
    // VPS 网关（4MB 容差）造成全局链路 500。
    const bodyBytes = new TextEncoder().encode(bodyText).length;
    if (bodyBytes > TOTAL_BYTES_ABS_CAP) {
        console.error(
            "[fetchLlmPayload] fuse blown: body " + bodyBytes +
            " bytes > cap " + TOTAL_BYTES_ABS_CAP + ", refused. URL=" + payload.url.slice(0, 120),
        );
        return Promise.resolve(new Response(JSON.stringify({
            error: "payload_too_large",
            message: "request body exceeds gateway physical cap, fused locally",
            bodyBytes,
            capBytes: TOTAL_BYTES_ABS_CAP,
        }), { status: 413, headers: { "Content-Type": "application/json" } }));
    }
    if (payload.serverProxy) {
        return fetch("/api/llm-proxy", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                url: payload.url,
                headers: payload.headers,
                body: bodyText,
            }),
            signal: options.signal,
        });
    }
    return fetch(payload.url, {
        method: "POST",
        headers: payload.headers,
        body: bodyText,
        signal: options.signal,
    });
}
