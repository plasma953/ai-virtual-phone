// app/api/llm-proxy/route.ts
// LLM 中转代理：VPS 上的 weixin-proactive 主动服务无法直连用户配置的 LLM 网关时
// （部分网关屏蔽 VPS 所在 ASN），通过本函数转发（Vercel 出口可达）。
// 与 /api/weixin 代理 iLink 是同一类思路：apiKey 仅本次请求透传，不存储、不写日志。
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 25;

const PROXY_TOKEN = "LlmProxy#AiVirtualPhone#2026";

type LlmProxyRequest = {
  token?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  messages?: unknown[];
  params?: Record<string, unknown>;
};

export async function POST(req: Request) {
  let payload: LlmProxyRequest;
  try {
    payload = (await req.json()) as LlmProxyRequest;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (payload.token !== PROXY_TOKEN) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const baseUrl = String(payload.baseUrl || "").trim().replace(/\/+$/, "");
  const apiKey = String(payload.apiKey || "").trim();
  const model = String(payload.model || "").trim();
  if (!baseUrl || !apiKey || !model || !Array.isArray(payload.messages) || payload.messages.length === 0) {
    return NextResponse.json({ error: "invalid_params" }, { status: 400 });
  }

  const url = baseUrl.endsWith("/chat/completions") ? baseUrl : `${baseUrl}/chat/completions`;
  const body: Record<string, unknown> = {
    model,
    messages: payload.messages,
    ...(payload.params || {}),
  };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    const upstream = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const text = await upstream.text();
    return new NextResponse(text, {
      status: upstream.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return NextResponse.json(
      { error: "upstream_failed", detail: String((e as Error)?.message || e) },
      { status: 502 },
    );
  }
}
