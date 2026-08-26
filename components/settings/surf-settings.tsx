"use client";
// 「自主冲浪」设置页：AI 在非交互时段的自由活动权——网上冲浪、沉淀见闻、择机分享。
// 设计核心：
//  - 放权：AI 自行决定 surf / share / skip，休息（skip）是合法动作。
//  - 反刍闸：n-gram 词频统计防执念，杜绝单一话题死循环。
//  - 分寸感：静默时段只沉淀、不打扰。
// 所有数据存本地 IndexedDB（kv-db），零云端依赖。
import { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import {
    Compass,
    Play,
    Trash2,
    RotateCcw,
    AlertCircle,
    Clock,
    Waves,
    MessageSquare,
    ShieldCheck,
    Database,
    Radio,
    Send,
    Sparkles,
} from "lucide-react";
import { Toggle, Input, Textarea, Select, Slider } from "@/components/ui/form";
import { Alert } from "@/components/ui/feedback";
import { ConfirmDialog } from "@/components/ui/modal";
import {
    loadSurfSettings,
    saveSurfSettings,
    resetSurfSettings,
    deleteSurfNote,
    saveSurfTraces,
    type SurfSettings,
} from "@/lib/surf-storage";
import {
    surfNow,
    startSurfService,
    stopSurfService,
    isSurfServiceRunning,
    getSurfDashboard,
    resolveShareSession,
} from "@/lib/surf-engine";
import { loadApiConfigs } from "@/lib/settings-storage";
import { loadChatSessions, type ChatSession } from "@/lib/chat-storage";

function sessionLabel(s: ChatSession): string {
    if (s.isGroup) return s.groupName || `群聊 ${s.id}`;
    return s.alias || `User_${s.contactId.slice(-4)}`;
}

function formatTime(ts?: number): string {
    if (!ts) return "—";
    const d = new Date(ts);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function StatusChip({ on, children }: { on?: boolean; children: ReactNode }) {
    const color = on === undefined ? "var(--c-icon-active)" : on ? "var(--c-success)" : "var(--c-danger)";
    return (
        <span
            className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
            style={{ color, backgroundColor: "var(--c-input)", border: "1px solid var(--c-card-border)" }}
        >
            {children}
        </span>
    );
}

export function SurfSettingsPage({ onNotice }: { onNotice?: (msg: string) => void }) {
    const [settings, setSettings] = useState<SurfSettings>(() => loadSurfSettings());
    const [dashboard, setDashboard] = useState(() => getSurfDashboard());
    const [serviceRunning, setServiceRunning] = useState(() => isSurfServiceRunning());
    const [surfing, setSurfing] = useState(false);
    const [surfResult, setSurfResult] = useState<string | null>(null);
    const [confirmDeleteNoteId, setConfirmDeleteNoteId] = useState<string | null>(null);
    const [confirmReset, setConfirmReset] = useState(false);
    const [confirmClearTraces, setConfirmClearTraces] = useState(false);
    const [bannedDraft, setBannedDraft] = useState<string>(() => loadSurfSettings().bannedTopics.join("，"));
    const bannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // 后台服务运行状态需要轮询（可能被其它页面起停）
    useEffect(() => {
        const t = setInterval(() => setServiceRunning(isSurfServiceRunning()), 2000);
        return () => clearInterval(t);
    }, []);

    useEffect(() => () => {
        if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
    }, []);

    const refreshDashboard = useCallback(() => {
        setDashboard(getSurfDashboard());
        setServiceRunning(isSurfServiceRunning());
    }, []);

    const patch = useCallback((next: SurfSettings) => {
        saveSurfSettings(next);
        setSettings(next);
        setDashboard(getSurfDashboard());
    }, []);

    const patchField = useCallback(
        <K extends keyof SurfSettings>(key: K, value: SurfSettings[K]) => {
            patch({ ...loadSurfSettings(), [key]: value });
        },
        [patch],
    );

    const showBanner = useCallback((msg: string) => {
        setSurfResult(msg);
        if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
        bannerTimerRef.current = setTimeout(() => setSurfResult(null), 8000);
    }, []);

    const handleSurfNow = async () => {
        if (surfing) return;
        setSurfing(true);
        try {
            const msg = await surfNow();
            showBanner(msg);
            onNotice?.(msg);
        } catch (e) {
            const msg = `冲浪失败：${e instanceof Error ? e.message : String(e)}`;
            showBanner(msg);
            onNotice?.(msg);
        } finally {
            setSurfing(false);
            refreshDashboard();
        }
    };

    const handleEnabled = (value: boolean) => {
        patchField("enabled", value);
        if (value) {
            startSurfService();
            setServiceRunning(true);
            onNotice?.("自主冲浪已开启，AI 会在空闲时段自由活动");
        } else {
            onNotice?.("自主冲浪已关闭");
        }
    };

    const handleServiceToggle = () => {
        if (serviceRunning) {
            stopSurfService();
            setServiceRunning(false);
            onNotice?.("已停止后台冲浪服务");
        } else {
            startSurfService();
            setServiceRunning(true);
            onNotice?.("已启动后台冲浪服务");
        }
    };

    const commitBannedDraft = () => {
        const list = bannedDraft
            .split(/[，,、\s]+/)
            .map(s => s.trim())
            .filter(Boolean);
        patchField("bannedTopics", list);
        setBannedDraft(list.join("，"));
        onNotice?.(`禁区关键词已更新（${list.length} 个）`);
    };

    const handleReset = () => {
        const fresh = resetSurfSettings();
        setSettings(fresh);
        setBannedDraft(fresh.bannedTopics.join("，"));
        setConfirmReset(false);
        refreshDashboard();
        onNotice?.("已恢复默认配置");
    };

    const handleClearTraces = () => {
        saveSurfTraces([]);
        setConfirmClearTraces(false);
        refreshDashboard();
        onNotice?.("已清空搜索痕迹（反刍闸窗口归零）");
    };

    const apiConfigs = loadApiConfigs();
    const sessions = loadChatSessions().filter(s => !s.isBlacklisted);
    const resolvedShareSession = resolveShareSession(settings);

    return (
        <div className="flex flex-col gap-[16px]">
            {/* ── 说明与状态卡 ── */}
            <div className="ui-group-card !items-stretch">
                <div className="flex items-start gap-3">
                    <div className="ui-icon-circle shrink-0"><Compass size={20} /></div>
                    <div className="flex-1 flex flex-col gap-1">
                        <span className="menu-label font-medium">自主冲浪</span>
                        <span className="menu-desc !mt-0">
                            非交互时段，AI 拥有自由活动权：自己决定去网上冲浪、沉淀见闻，或择机分享给你——也可以什么都不做，直接休息。
                            所有见闻与搜索痕迹只存在本机（IndexedDB），不占用任何云端额度。
                        </span>
                    </div>
                </div>
                <div className="flex flex-col gap-2 mt-4">
                    <div className="flex items-center gap-2 flex-wrap">
                        <StatusChip on={serviceRunning}>
                            <Radio size={12} /> {serviceRunning ? "后台服务运行中" : "后台服务未运行"}
                        </StatusChip>
                        <StatusChip on={dashboard.hasTavilyKey}>
                            <Waves size={12} /> {dashboard.hasTavilyKey ? "Tavily 搜索就绪" : "缺 Tavily Key"}
                        </StatusChip>
                        <StatusChip on={dashboard.hasApiConfig}>
                            <Sparkles size={12} /> {dashboard.hasApiConfig ? "决策模型就绪" : "缺 API 配置"}
                        </StatusChip>
                    </div>
                    <div className="flex items-center gap-2 text-[12px] text-[var(--c-text)] flex-wrap">
                        <Clock size={12} />
                        <span>上一轮 {formatTime(dashboard.state.lastRoundAt)}</span>
                        <span>·</span>
                        <span>下轮定时 {formatTime(dashboard.state.nextTimerDueAt)}</span>
                        <span>·</span>
                        <span>见闻 {dashboard.notes.length} 条</span>
                        <span>·</span>
                        <span>痕迹 {dashboard.traces.length} 条</span>
                    </div>
                </div>
                {!dashboard.hasTavilyKey && (
                    <div className="mt-3">
                        <Alert variant="warning">
                            <AlertCircle size={14} />
                            未检测到 Tavily 搜索工具。请到「聊天工具箱」添加内置搜索（builtin_search）并填入 Tavily API Key，AI 才能上网冲浪。
                        </Alert>
                    </div>
                )}
                <div className="flex gap-2 mt-4">
                    <button
                        type="button"
                        className="ui-btn ui-btn-primary flex-1 justify-center"
                        disabled={surfing}
                        onClick={handleSurfNow}
                    >
                        <Play size={16} /> {surfing ? "冲浪中…" : "现在冲一轮"}
                    </button>
                    <button
                        type="button"
                        className="ui-btn flex-1 justify-center"
                        onClick={handleServiceToggle}
                    >
                        {serviceRunning ? "停止服务" : "启动服务"}
                    </button>
                </div>
                {surfResult && (
                    <div className="mt-3">
                        <Alert variant="info">{surfResult}</Alert>
                    </div>
                )}
            </div>

            {/* ── 总开关与触发节奏 ── */}
            <div className="ui-group-card !items-stretch">
                <div className="flex items-center gap-3">
                    <div className="flex-1 flex flex-col gap-1 min-w-0">
                        <span className="menu-label">启用自主冲浪</span>
                        <span className="menu-desc !mt-0">关闭后 AI 不会在后台自主活动，手动「冲一轮」仍可用</span>
                    </div>
                    <Toggle checked={settings.enabled} onChange={handleEnabled} />
                </div>
                <div className="flex flex-col gap-4 mt-4">
                    <Slider
                        label="定时冲浪间隔"
                        displayValue={`${settings.intervalMinutes} 分钟`}
                        hint="计时锚定上一轮完成时刻，到点即触发一轮决策"
                        min={5}
                        max={240}
                        step={5}
                        value={settings.intervalMinutes}
                        onChange={e => patchField("intervalMinutes", Number(e.target.value))}
                    />
                    <Slider
                        label="聊天间隙触发"
                        displayValue={settings.chatGapMinutes > 0 ? `${settings.chatGapMinutes} 分钟` : "关闭"}
                        hint="你最后一条消息过去这么久后，AI 可以自由活动；0 = 关闭间隙触发"
                        min={0}
                        max={120}
                        step={5}
                        value={settings.chatGapMinutes}
                        onChange={e => patchField("chatGapMinutes", Number(e.target.value))}
                    />
                </div>
            </div>

            {/* ── 分寸感：静默时段 ── */}
            <div className="ui-group-card !items-stretch">
                <div className="flex items-center gap-3">
                    <div className="ui-icon-circle shrink-0"><MessageSquare size={20} /></div>
                    <div className="flex-1 flex flex-col gap-1 min-w-0">
                        <span className="menu-label">静默时段（Quiet Hours）</span>
                        <span className="menu-desc !mt-0">深夜免打扰时段内，AI 只沉淀见闻、不推送任何消息</span>
                    </div>
                    <Toggle checked={settings.quietHoursEnabled} onChange={v => patchField("quietHoursEnabled", v)} />
                </div>
            </div>

            {/* ── 反刍闸 ── */}
            <div className="ui-group-card !items-stretch">
                <div className="flex items-center gap-3">
                    <div className="ui-icon-circle shrink-0"><ShieldCheck size={20} /></div>
                    <div className="flex-1 flex flex-col gap-1 min-w-0">
                        <span className="menu-label">反刍闸（Rumination Gate）</span>
                        <span className="menu-desc !mt-0">
                            防止 AI 陷入单一话题死循环：每次搜索前用 n-gram 词频比对过去窗口内的搜索痕迹，撞车即强制换题。
                        </span>
                    </div>
                </div>
                <div className="flex flex-col gap-4 mt-4">
                    <Slider
                        label="统计窗口"
                        displayValue={`${settings.ruminationWindowHours} 小时`}
                        hint="只回看这段时间内的搜索痕迹"
                        min={12}
                        max={336}
                        step={12}
                        value={settings.ruminationWindowHours}
                        onChange={e => patchField("ruminationWindowHours", Number(e.target.value))}
                    />
                    <Slider
                        label="回看条数"
                        displayValue={`${settings.ruminationTraceLimit} 条`}
                        hint="最多比对多少条历史痕迹"
                        min={10}
                        max={200}
                        step={10}
                        value={settings.ruminationTraceLimit}
                        onChange={e => patchField("ruminationTraceLimit", Number(e.target.value))}
                    />
                    <Slider
                        label="撞车阈值"
                        displayValue={`≥ ${settings.ruminationHitThreshold} 次`}
                        hint="query 的 n-gram 在窗口内出现达到该次数即算撞车"
                        min={1}
                        max={10}
                        step={1}
                        value={settings.ruminationHitThreshold}
                        onChange={e => patchField("ruminationHitThreshold", Number(e.target.value))}
                    />
                    <div className="flex flex-col gap-1.5">
                        <span className="menu-label">n-gram 长度</span>
                        <Select
                            value={settings.ruminationNgramSize}
                            onChange={e => patchField("ruminationNgramSize", Number(e.target.value))}
                        >
                            <option value={1}>1-gram（最严格，单字/单词比对）</option>
                            <option value={2}>2-gram（默认，兼顾精度与召回）</option>
                            <option value={3}>3-gram（宽松，只看三连片段）</option>
                        </Select>
                        <span className="menu-desc !mt-0">中文按字滑窗、英文按单词滑窗</span>
                    </div>
                    <div className="flex flex-col gap-1.5">
                        <span className="menu-label">禁区关键词</span>
                        <Input
                            value={bannedDraft}
                            placeholder="用逗号分隔，如：彩票，赌博"
                            onChange={e => setBannedDraft(e.target.value)}
                            onBlur={commitBannedDraft}
                        />
                        <span className="menu-desc !mt-0">query 命中任一关键词即拒绝；换题一次后仍命中则本轮跳过</span>
                    </div>
                </div>
            </div>

            {/* ── 搜索（Tavily） ── */}
            <div className="ui-group-card !items-stretch">
                <div className="flex items-center gap-3">
                    <div className="ui-icon-circle shrink-0"><Waves size={20} /></div>
                    <div className="flex-1 flex flex-col gap-1 min-w-0">
                        <span className="menu-label">搜索（Tavily）</span>
                        <span className="menu-desc !mt-0">Key 在「聊天工具箱 → 内置搜索」中配置，此处只管搜索行为</span>
                    </div>
                </div>
                <div className="flex flex-col gap-4 mt-4">
                    <Slider
                        label="每次结果条数"
                        displayValue={`${settings.tavilyMaxResults} 条`}
                        min={1}
                        max={10}
                        step={1}
                        value={settings.tavilyMaxResults}
                        onChange={e => patchField("tavilyMaxResults", Number(e.target.value))}
                    />
                    <div className="flex flex-col gap-1.5">
                        <span className="menu-label">搜索深度</span>
                        <Select
                            value={settings.tavilySearchDepth}
                            onChange={e => patchField("tavilySearchDepth", e.target.value as "basic" | "advanced")}
                        >
                            <option value="basic">basic（快，省额度）</option>
                            <option value="advanced">advanced（深，费额度）</option>
                        </Select>
                    </div>
                </div>
            </div>

            {/* ── 沉淀与分享 ── */}
            <div className="ui-group-card !items-stretch">
                <div className="flex items-center gap-3">
                    <div className="ui-icon-circle shrink-0"><Database size={20} /></div>
                    <div className="flex-1 flex flex-col gap-1 min-w-0">
                        <span className="menu-label">沉淀与分享</span>
                        <span className="menu-desc !mt-0">见闻存本地、超限自动淘汰最旧的未分享条目；分享目标会话与模型绑定</span>
                    </div>
                </div>
                <div className="flex flex-col gap-4 mt-4">
                    <Slider
                        label="见闻库存上限"
                        displayValue={`${settings.notesLimit} 条`}
                        hint="超限自动淘汰最旧的未分享见闻，防止本地存储膨胀"
                        min={10}
                        max={200}
                        step={10}
                        value={settings.notesLimit}
                        onChange={e => patchField("notesLimit", Number(e.target.value))}
                    />
                    <div className="flex flex-col gap-1.5">
                        <span className="menu-label">分享目标会话</span>
                        <Select
                            value={settings.targetSessionId}
                            onChange={e => patchField("targetSessionId", e.target.value)}
                        >
                            <option value="">自动（第一个非群聊会话）</option>
                            {sessions.map(s => (
                                <option key={s.id} value={s.id}>
                                    {sessionLabel(s)}{s.isGroup ? "（群聊）" : ""}
                                </option>
                            ))}
                        </Select>
                        <span className="menu-desc !mt-0">
                            当前实际分享到：{resolvedShareSession ? sessionLabel(resolvedShareSession) : "无可用会话（只沉淀不分享）"}
                        </span>
                    </div>
                    <div className="flex flex-col gap-1.5">
                        <span className="menu-label">决策模型 API 配置</span>
                        <Select
                            value={settings.apiConfigId}
                            onChange={e => patchField("apiConfigId", e.target.value)}
                        >
                            <option value="">跟随分享目标会话的角色绑定</option>
                            {apiConfigs.map(c => (
                                <option key={c.id} value={c.id}>
                                    {c.name || c.id}（{c.provider}）
                                </option>
                            ))}
                        </Select>
                        <span className="menu-desc !mt-0">可为自主活动锁定专用模型，不影响会话内聊天</span>
                    </div>
                    <div className="flex items-center gap-3">
                        <div className="flex-1 flex flex-col gap-1 min-w-0">
                            <span className="menu-label">自动分享</span>
                            <span className="menu-desc !mt-0">见闻值得分享时，AI 按分享策略主动发出（静默时段除外）</span>
                        </div>
                        <Toggle checked={settings.autoShare} onChange={v => patchField("autoShare", v)} />
                    </div>
                </div>
            </div>

            {/* ── 提示词 ── */}
            <div className="ui-group-card !items-stretch">
                <div className="flex items-center gap-3">
                    <div className="ui-icon-circle shrink-0"><Send size={20} /></div>
                    <div className="flex-1 flex flex-col gap-1 min-w-0">
                        <span className="menu-label">放权提示词</span>
                        <span className="menu-desc !mt-0">决定 AI 的「灵魂」：怎么想、怎么选、怎么跟你说。每次行动必须输出 JSON</span>
                    </div>
                </div>
                <div className="flex flex-col gap-4 mt-4">
                    <div className="flex flex-col gap-1.5">
                        <span className="menu-label">自由决策（surf / share / skip）</span>
                        <Textarea
                            value={settings.freedomPrompt}
                            rows={8}
                            onChange={e => patchField("freedomPrompt", e.target.value)}
                        />
                    </div>
                    <div className="flex flex-col gap-1.5">
                        <span className="menu-label">见闻消化（Distill）</span>
                        <Textarea
                            value={settings.distillPrompt}
                            rows={6}
                            onChange={e => patchField("distillPrompt", e.target.value)}
                        />
                    </div>
                    <div className="flex flex-col gap-1.5">
                        <span className="menu-label">分享策略（Share Policy）</span>
                        <Textarea
                            value={settings.sharePolicyPrompt}
                            rows={6}
                            onChange={e => patchField("sharePolicyPrompt", e.target.value)}
                        />
                    </div>
                </div>
            </div>

            {/* ── 见闻库 ── */}
            <div className="ui-group-card !items-stretch">
                <div className="flex items-center justify-between">
                    <span className="menu-label font-medium">见闻库（{dashboard.notes.length} 条）</span>
                    <span className="menu-desc !mt-0">AI 沉淀下来的探索成果</span>
                </div>
                {dashboard.notes.length === 0 ? (
                    <div className="menu-desc !mt-0 py-4 text-center">还没有见闻。开一轮冲浪，或等待 AI 自己出去逛。</div>
                ) : (
                    <div className="flex flex-col gap-2 mt-3 max-h-[360px] overflow-y-auto">
                        {[...dashboard.notes]
                            .sort((a, b) => b.createdAt - a.createdAt)
                            .map(note => (
                                <div key={note.id} className="flex items-start gap-2 rounded-xl border p-3" style={{ borderColor: "var(--c-card-border)", backgroundColor: "var(--c-panel)" }}>
                                    <div className="flex-1 flex flex-col gap-1 min-w-0">
                                        <div className="flex items-center gap-2 flex-wrap">
                                            <span className="menu-label">{note.title || "（无标题见闻）"}</span>
                                            {note.worthSharing && (
                                                <StatusChip on>
                                                    <Sparkles size={10} /> 值得分享
                                                </StatusChip>
                                            )}
                                            {note.sharedAt && (
                                                <StatusChip on>
                                                    <Send size={10} /> 已分享 {formatTime(note.sharedAt)}
                                                </StatusChip>
                                            )}
                                        </div>
                                        <span className="menu-desc !mt-0 line-clamp-3">{note.summary}</span>
                                        <div className="flex items-center gap-2 flex-wrap">
                                            {note.tags.slice(0, 5).map(tag => (
                                                <StatusChip key={tag}>#{tag}</StatusChip>
                                            ))}
                                            <span className="menu-desc !mt-0">{formatTime(note.createdAt)}</span>
                                        </div>
                                    </div>
                                    <button
                                        type="button"
                                        className="ui-icon-btn shrink-0"
                                        style={{ color: "var(--c-danger)" }}
                                        aria-label="删除见闻"
                                        onClick={() => setConfirmDeleteNoteId(note.id)}
                                    >
                                        <Trash2 size={16} />
                                    </button>
                                </div>
                            ))}
                    </div>
                )}
            </div>

            {/* ── 危险区 ── */}
            <div className="ui-group-card !items-stretch">
                <div className="flex items-center justify-between gap-2">
                    <div className="flex-1 flex flex-col gap-1 min-w-0">
                        <span className="menu-label font-medium">清空与重置</span>
                        <span className="menu-desc !mt-0">清空搜索痕迹或恢复全部默认配置</span>
                    </div>
                    <div className="flex gap-2 shrink-0">
                        <button
                            type="button"
                            className="ui-btn ui-btn-danger"
                            onClick={() => setConfirmClearTraces(true)}
                        >
                            清空痕迹
                        </button>
                        <button
                            type="button"
                            className="ui-btn"
                            onClick={() => setConfirmReset(true)}
                        >
                            <RotateCcw size={14} /> 重置配置
                        </button>
                    </div>
                </div>
            </div>

            {confirmDeleteNoteId && (
                <ConfirmDialog
                    title="删除这条见闻？"
                    message="删除后不可恢复。"
                    confirmLabel="删除"
                    variant="danger"
                    onCancel={() => setConfirmDeleteNoteId(null)}
                    onConfirm={() => {
                        deleteSurfNote(confirmDeleteNoteId);
                        setConfirmDeleteNoteId(null);
                        refreshDashboard();
                        onNotice?.("已删除见闻");
                    }}
                />
            )}
            {confirmReset && (
                <ConfirmDialog
                    title="恢复默认配置？"
                    message="所有自主冲浪设置（包括提示词）将恢复为默认值。见闻与痕迹不受影响。"
                    confirmLabel="恢复默认"
                    onCancel={() => setConfirmReset(false)}
                    onConfirm={handleReset}
                />
            )}
            {confirmClearTraces && (
                <ConfirmDialog
                    title="清空搜索痕迹？"
                    message="反刍闸的历史比对记录将全部清除，AI 将不再记得最近搜过什么。"
                    confirmLabel="清空"
                    variant="danger"
                    onCancel={() => setConfirmClearTraces(false)}
                    onConfirm={handleClearTraces}
                />
            )}
        </div>
    );
}