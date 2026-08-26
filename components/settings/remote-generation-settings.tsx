"use client";

// 远程生成设置：VPS 中转回复（tools/vps-chat-gateway）。
// 开启后聊天回复先交由自部署网关生成，前端轮询拿回结果；
// 网关不可用时自动回落本地生成，聊天永不中断。

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, Rss, Server, ShieldCheck } from "lucide-react";
import { Toggle, Input } from "@/components/ui/form";
import { Alert } from "@/components/ui/feedback";
import { loadChatAppSettings, saveChatAppSettings, type RemoteGenerationSettings } from "@/lib/chat-storage";
import { normalizeRemoteBaseUrl, testRemoteGateway } from "@/lib/remote-chat-client";

export function RemoteGenerationSettings() {
    const [settings, setSettings] = useState<RemoteGenerationSettings>(() => loadChatAppSettings().remoteGeneration ?? {});
    const [isTesting, setIsTesting] = useState(false);
    const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
    const [isLoaded, setIsLoaded] = useState(false);

    useEffect(() => {
        setSettings(loadChatAppSettings().remoteGeneration ?? {});
        setIsLoaded(true);
    }, []);

    const persist = useCallback((next: RemoteGenerationSettings) => {
        setSettings(next);
        const appSettings = loadChatAppSettings();
        saveChatAppSettings({ ...appSettings, remoteGeneration: next });
    }, []);

    const update = (patch: Partial<RemoteGenerationSettings>) => {
        persist({ ...settings, ...patch });
    };

    const runTest = async () => {
        setIsTesting(true);
        setTestResult(null);
        const result = await testRemoteGateway({
            baseUrl: settings.baseUrl,
            apiToken: settings.apiToken,
        });
        setTestResult(result);
        setIsTesting(false);
    };

    if (!isLoaded) return null;

    const configured = Boolean(settings.baseUrl?.trim() && settings.apiToken?.trim());
    const active = Boolean(settings.enabled && configured);

    return (
        <div className="flex flex-col gap-6">
            <div className="flex items-center">
                <h2 className="m-0 mx-2 ts-28 font-bold italic leading-none text-black">Remote Generation</h2>
            </div>

            <div className="ui-toggle-row mt-2">
                <span className="flex min-w-0 flex-col">
                    <span className="menu-label font-medium">启用 VPS 中转回复</span>
                    <span className="menu-desc whitespace-normal break-words leading-[1.45]">
                        回复生成交由自部署网关完成，浏览器只提交与轮询，断网、切后台、杀页面都不影响生成。
                    </span>
                </span>
                <Toggle
                    checked={settings.enabled === true}
                    onChange={(v) => {
                        if (v && !configured) {
                            setTestResult({ success: false, message: "请先填写网关地址与令牌，再开启中转。" });
                            return;
                        }
                        update({ enabled: v });
                    }}
                />
            </div>

            <div className="flex flex-col gap-1">
                <label className="menu-desc ml-1">网关地址 (Gateway Base URL)</label>
                <Input
                    type="url"
                    value={settings.baseUrl || ""}
                    onChange={(e) => update({ baseUrl: e.target.value })}
                    placeholder="https://chat.43451695.xyz 或 http://1.2.3.4:8795"
                />
                <span className="menu-desc ml-1 mt-0.5">
                    对应 VPS 上 vps-chat-gateway 的对外地址（支持 Caddy 反代域名或 IP:端口直连）。
                </span>
            </div>

            <div className="flex flex-col gap-1">
                <label className="menu-desc ml-1">网关令牌 (Gateway Token)</label>
                <Input
                    type="password"
                    value={settings.apiToken || ""}
                    onChange={(e) => update({ apiToken: e.target.value })}
                    placeholder="与 VPS 端 PHONE_GATEWAY_TOKEN 一致"
                />
                <span className="menu-desc ml-1 mt-0.5">
                    每个使用者可填自己的 VPS 地址与令牌，互不影响。
                </span>
            </div>

            <button
                onClick={runTest}
                disabled={isTesting || !configured}
                className="ui-btn ui-btn-success"
            >
                <Rss size={16} className={isTesting ? "animate-spin" : ""} />
                {isTesting ? "测试中..." : "测试连接"}
            </button>

            {testResult && testResult.message && (
                <Alert variant={testResult.success ? "success" : "danger"}>
                    <AlertCircle size={16} className="mt-[2px] shrink-0" />
                    <span className="break-all leading-[1.5]">{testResult.message}</span>
                </Alert>
            )}

            <div className="flex flex-col gap-2 rounded-[16px] border border-[var(--c-line)] bg-[var(--c-card-soft)] p-4">
                <div className="flex items-center gap-2">
                    <Server size={15} className="shrink-0 text-[var(--c-text-sub)]" />
                    <span className="menu-label font-medium">工作原理</span>
                </div>
                <span className="menu-desc whitespace-normal break-words leading-[1.6]">
                    发消息后，前端把组装好的完整请求快照提交到网关；网关在机房网络里一次性生成，
                    前端每几秒轮询一次直到完成，再走与本地完全一致的解析管线落库。
                    因为浏览器与网关之间只有短请求，不再依赖长时间流式连接，弱网与锁屏环境也不会丢回复。
                </span>
            </div>

            <div className="flex flex-col gap-2 rounded-[16px] border border-[var(--c-line)] bg-[var(--c-card-soft)] p-4">
                <div className="flex items-center gap-2">
                    <ShieldCheck size={15} className="shrink-0 text-[var(--c-text-sub)]" />
                    <span className="menu-label font-medium">行为说明</span>
                </div>
                <ul className="menu-desc m-0 flex list-disc flex-col gap-1 pl-5 whitespace-normal leading-[1.6]">
                    <li>网关不可用、超时或令牌错误时，自动回落本地直接生成，并在聊天里提示。</li>
                    <li>中转模式下原生工具走文本动作协议（效果一致，只是不再流式出工具轮）。</li>
                    <li>请求快照含你的 LLM API Key，会透传到网关——请只在你自己信任的 VPS 上启用。</li>
                    <li>网关部署说明见仓库 tools/vps-chat-gateway/README.md（含 systemd 与 Caddy 配置）。</li>
                </ul>
            </div>

            {active && (
                <Alert variant="info">
                    <Server size={16} className="mt-[2px] shrink-0" />
                    <span className="break-all leading-[1.5]">
                        已启用中转：{normalizeRemoteBaseUrl(settings.baseUrl || "")} — 聊天与群聊回复将经此网关生成。
                    </span>
                </Alert>
            )}
        </div>
    );
}