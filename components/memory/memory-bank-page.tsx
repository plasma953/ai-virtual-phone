"use client";
// components/memory/memory-bank-page.tsx
// 心潮·念 v3（记忆宫殿）—— 记忆银行页面
// 七个脑区房间（客厅/卧室/书房/用户房/自我房/阁楼/窗台）+ 四块常驻门牌 +
// 原生事件时间线 + 手动触发提取。旧 v2 短期/长期/热度/星图 UI 已随旧系统移除。
import { useState, useEffect, useCallback, type CSSProperties, type ReactNode } from "react";
import {
    Home, Moon, BookOpen, User, Sparkles, CloudRain, Wind,
    LayoutGrid, Tag, Clock, Trash2, RotateCcw, RefreshCw, ChevronRight, Brain, Archive,
} from "lucide-react";
import { loadCharacters } from "@/lib/character-storage";
import {
    loadPalaceNodes,
    loadPalacePlates,
    deletePalaceNode,
    savePalaceNode,
    clearPalaceData,
    isPalaceMigrated,
} from "@/lib/palace-storage";
import type { MemoryNode, PlateEntry, MemoryRoom, PlateRoom } from "@/lib/palace-types";
import { ALL_ROOMS, PLATE_ROOMS, PLATE_META, ROOM_LABELS } from "@/lib/palace-types";
import { runPalaceExtraction } from "@/lib/palace-engine";
import { loadMemoryConfig, saveMemoryConfig } from "@/lib/memory-storage";
import type { MemoryConfig } from "@/lib/memory-types";
import { loadNativeTimeline, type NativeTimelineEntry } from "@/lib/short-term-assembler";
import { hydrateChatStorage } from "@/lib/chat-storage";

type MemoryView = "list" | "detail" | "settings";
type Props = {
    view: MemoryView;
    selectedCharId?: string;
    onSelectChar: (charId: string) => void;
    onNotice?: (msg: string) => void;
};
type MainTab = "plates" | "rooms" | "timeline";

// ── 房间 UI 元数据 ──
const ROOM_UI: Record<MemoryRoom, { icon: typeof Home; color: string; hint: string }> = {
    living_room: { icon: Home,      color: "#F59E0B", hint: "日常闲聊与近期互动（快衰减）" },
    bedroom:     { icon: Moon,      color: "#EC4899", hint: "亲密情感、羁绊、深谈" },
    study:       { icon: BookOpen,  color: "#3B82F6", hint: "工作、学习、技能、项目" },
    user_room:   { icon: User,      color: "#10B981", hint: "用户的信息、习惯、重要事实" },
    self_room:   { icon: Sparkles,  color: "#8B5CF6", hint: "TA 的自我认知与成长（不衰减）" },
    attic:       { icon: CloudRain, color: "#6B7280", hint: "未解决的困惑与挂心之事" },
    windowsill:  { icon: Wind,      color: "#06B6D4", hint: "许下的愿望、约定、目标（不衰减）" },
};

const SOURCE_LABELS: Record<NativeTimelineEntry["sourceApp"], string> = {
    chat: "聊天", moments: "朋友圈", story: "剧情", vn: "视觉小说", map: "地图冒险",
    game: "游戏", diary: "日记", xiaohongshu: "小红书", interview_magazine: "采访",
    cocreate: "共创", checkphone: "查手机", custom_app: "自定义",
};

type SourceKey = keyof NonNullable<MemoryConfig["shortTermAllowedSources"]>;
const SOURCE_TOGGLE_META: { key: SourceKey; label: string }[] = [
    { key: "chat", label: "私聊" },
    { key: "group_chat", label: "群聊" },
    { key: "moments", label: "朋友圈" },
    { key: "checkphone", label: "查手机" },
    { key: "diary", label: "日记" },
    { key: "xiaohongshu", label: "小红书" },
    { key: "interview_magazine", label: "采访" },
    { key: "cocreate", label: "共创" },
    { key: "game", label: "游戏" },
    { key: "story", label: "剧情" },
    { key: "vn", label: "视觉小说" },
    { key: "adventure", label: "冒险" },
    { key: "custom_app", label: "自定义App" },
];

function fmtDate(ms: number): string {
    try { return new Date(ms).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" }); }
    catch { return ""; }
}
function fmtDateTime(iso: string): string {
    try { return new Date(iso).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
    catch { return iso; }
}

// ═══════════════════════════════════════════════════
export function MemoryBankPage({ view, selectedCharId, onSelectChar, onNotice }: Props) {
    if (view === "settings") {
        return <SettingsView selectedCharId={selectedCharId} onNotice={onNotice} />;
    }
    if (view === "detail" && selectedCharId) {
        return <PalaceDetail charId={selectedCharId} onNotice={onNotice} />;
    }
    return <CharList onSelectChar={onSelectChar} />;
}

// ── 列表：选择角色 ─────────────────────────────────
function CharList({ onSelectChar }: { onSelectChar: (id: string) => void }) {
    type Row = { id: string; name: string; palaceCount: number; plateCount: number };
    const [rows, setRows] = useState<Row[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let alive = true;
        (async () => {
            const chars = loadCharacters();
            const counted = await Promise.all(chars.slice(0, 80).map(async c => {
                try {
                    const [nodes, plates] = await Promise.all([
                        loadPalaceNodes(c.id), loadPalacePlates(c.id),
                    ]);
                    return {
                        id: c.id, name: c.name,
                        palaceCount: nodes.filter(n => n.status === "active").length,
                        plateCount: plates.length,
                    };
                } catch { return { id: c.id, name: c.name, palaceCount: 0, plateCount: 0 }; }
            }));
            if (alive) { setRows(counted); setLoading(false); }
        })();
        return () => { alive = false; };
    }, []);

    return (
        <div style={{ padding: "12px 14px" }}>
            <div style={{ fontSize: 13, color: "var(--muted, #888)", marginBottom: 10, lineHeight: 1.5 }}>
                每个角色拥有一座独立宫殿：情景记忆分房存放，稳定认知沉淀为门牌常驻。
            </div>
            {loading && <div style={{ textAlign: "center", color: "var(--muted, #888)", padding: 30, fontSize: 13 }}>加载中…</div>}
            {!loading && rows.length === 0 && (
                <div style={{ textAlign: "center", color: "var(--muted, #888)", padding: 40, fontSize: 13 }}>还没有角色</div>
            )}
            {rows.map(r => (
                <button key={r.id} onClick={() => onSelectChar(r.id)}
                    style={{
                        display: "flex", alignItems: "center", gap: 12, width: "100%", textAlign: "left",
                        padding: "12px 14px", marginBottom: 8, borderRadius: 14,
                        background: "var(--card, rgba(128,128,128,0.08))", border: "none", cursor: "pointer",
                    }}>
                    <div style={{
                        width: 38, height: 38, borderRadius: 12, flexShrink: 0,
                        background: "linear-gradient(135deg, #8B5CF633, #3B82F633)",
                        display: "flex", alignItems: "center", justifyContent: "center",
                    }}>
                        <Brain size={20} color="#8B5CF6" />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text, #eee)" }}>{r.name}</div>
                        <div style={{ fontSize: 12, color: "var(--muted, #888)", marginTop: 2 }}>
                            {r.palaceCount} 条记忆 · {r.plateCount} 条门牌
                        </div>
                    </div>
                    <ChevronRight size={16} color="var(--muted, #888)" />
                </button>
            ))}
        </div>
    );
}

// ── 详情：宫殿视图 ─────────────────────────────────
function PalaceDetail({ charId, onNotice }: { charId: string; onNotice?: (msg: string) => void }) {
    const [tab, setTab] = useState<MainTab>("rooms");
    const [activeRoom, setActiveRoom] = useState<MemoryRoom>("living_room");
    const [nodes, setNodes] = useState<MemoryNode[]>([]);
    const [plates, setPlates] = useState<PlateEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [extracting, setExtracting] = useState(false);
    const [showArchived, setShowArchived] = useState(false);

    const charName = loadCharacters().find(c => c.id === charId)?.name || "角色";

    const loadAll = useCallback(async () => {
        setLoading(true);
        try {
            const [ns, ps] = await Promise.all([loadPalaceNodes(charId), loadPalacePlates(charId)]);
            setNodes(ns); setPlates(ps);
        } finally { setLoading(false); }
    }, [charId]);

    useEffect(() => { loadAll(); }, [loadAll]);

    const activeNodes = nodes.filter(n => n.status === "active");
    const coldNodes = nodes.filter(n => n.status !== "active");
    const roomNodes = activeNodes.filter(n => n.room === activeRoom)
        .sort((a, b) => b.createdAt - a.createdAt);

    const handleExtract = async () => {
        if (extracting) return;
        setExtracting(true);
        try {
            const res = await runPalaceExtraction(charId, charName, { force: true });
            if (res.success) {
                onNotice?.(`已提取 ${res.extracted ?? 0} 条记忆${res.skipped ? `，去重跳过 ${res.skipped} 条` : ""}`);
                await loadAll();
            } else {
                onNotice?.(res.error || "提取失败");
            }
        } finally { setExtracting(false); }
    };

    const handleDelete = async (id: string) => {
        await deletePalaceNode(id);
        await loadAll();
        onNotice?.("已删除该记忆");
    };

    const handleRevive = async (node: MemoryNode) => {
        await savePalaceNode({ ...node, status: "active" });
        await loadAll();
        onNotice?.("记忆已复活");
    };

    return (
        <div style={{ padding: "10px 14px 24px" }}>
            {/* 顶部：手动提取 */}
            <button onClick={handleExtract} disabled={extracting}
                style={{
                    display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                    width: "100%", padding: "11px 0", borderRadius: 12, border: "none", cursor: "pointer",
                    background: extracting ? "var(--card, rgba(128,128,128,0.1))" : "linear-gradient(135deg, #8B5CF6, #6366F1)",
                    color: extracting ? "var(--muted, #888)" : "#fff",
                    fontSize: 14, fontWeight: 600, opacity: extracting ? 0.7 : 1,
                }}>
                <RefreshCw size={15} />
                {extracting ? "正在整理记忆…" : "立即整理一次记忆"}
            </button>

            {/* 主页签 */}
            <div style={{ display: "flex", gap: 6, margin: "12px 0", position: "sticky", top: 0, zIndex: 5, background: "var(--bg, transparent)", paddingTop: 4 }}>
                {([
                    { key: "rooms" as const, icon: LayoutGrid, label: "记忆房" },
                    { key: "plates" as const, icon: Tag, label: "门牌" },
                    { key: "timeline" as const, icon: Clock, label: "时间线" },
                ]).map(t => (
                    <button key={t.key} onClick={() => setTab(t.key)} style={{
                        flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
                        padding: "8px 0", borderRadius: 10, border: "none", cursor: "pointer", fontSize: 13,
                        background: tab === t.key ? "rgba(139,92,246,0.16)" : "transparent",
                        color: tab === t.key ? "#A78BFA" : "var(--muted, #888)", fontWeight: tab === t.key ? 600 : 400,
                    }}>
                        <t.icon size={14} /> {t.label}
                    </button>
                ))}
            </div>

            {loading && <div style={{ textAlign: "center", color: "var(--muted, #888)", padding: 40, fontSize: 13 }}>加载中…</div>}

            {!loading && tab === "rooms" && (
                <>
                    {/* 房间芯片 */}
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
                        {ALL_ROOMS.map(room => {
                            const ui = ROOM_UI[room];
                            const count = activeNodes.filter(n => n.room === room).length;
                            const Icon = ui.icon;
                            const on = activeRoom === room;
                            return (
                                <button key={room} onClick={() => setActiveRoom(room)} style={{
                                    display: "flex", alignItems: "center", gap: 5, padding: "6px 10px",
                                    borderRadius: 999, border: "none", cursor: "pointer", fontSize: 12,
                                    background: on ? `${ui.color}26` : "var(--card, rgba(128,128,128,0.08))",
                                    color: on ? ui.color : "var(--muted, #999)",
                                    fontWeight: on ? 600 : 400,
                                }}>
                                    <Icon size={13} /> {ROOM_LABELS[room]} {count}
                                </button>
                            );
                        })}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--muted, #888)", marginBottom: 10 }}>
                        {ROOM_UI[activeRoom].hint}
                    </div>

                    {roomNodes.length === 0 && (
                        <div style={{ textAlign: "center", color: "var(--muted, #888)", padding: 30, fontSize: 13 }}>
                            这个房间还没有记忆
                        </div>
                    )}
                    {roomNodes.map(n => <NodeCard key={n.id} node={n} onDelete={handleDelete} />)}

                    {/* 冷记忆（归档/被推翻） */}
                    {coldNodes.length > 0 && (
                        <div style={{ marginTop: 16 }}>
                            <button onClick={() => setShowArchived(v => !v)} style={{
                                display: "flex", alignItems: "center", gap: 6, padding: "8px 0",
                                background: "none", border: "none", cursor: "pointer", fontSize: 12,
                                color: "var(--muted, #888)",
                            }}>
                                <Archive size={13} /> 已归档 / 被推翻（{coldNodes.length}）{showArchived ? "▲" : "▼"}
                            </button>
                            {showArchived && coldNodes
                                .sort((a, b) => b.createdAt - a.createdAt)
                                .map(n => <NodeCard key={n.id} node={n} onRevive={handleRevive} />)}
                        </div>
                    )}
                </>
            )}

            {!loading && tab === "plates" && (
                <div style={{ fontSize: 12, color: "var(--muted, #888)", marginBottom: 12, lineHeight: 1.6 }}>
                    门牌是每轮对话都会常驻注入的「底色认知」——从情景记忆里沉淀出的稳定事实，不参与检索抽卡。
                </div>
            )}
            {!loading && tab === "plates" && PLATE_ROOMS.map((room: PlateRoom) => {
                const meta = PLATE_META[room];
                const entries = plates.filter(p => p.plateRoom === room)
                    .sort((a, b) => a.firstLearnedAt - b.firstLearnedAt);
                return (
                    <div key={room} style={{ marginBottom: 14 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text, #eee)", marginBottom: 6 }}>
                            {meta.title}
                            <span style={{ fontSize: 11, color: "var(--muted, #888)", fontWeight: 400, marginLeft: 8 }}>
                                {entries.length}/{meta.cap}
                            </span>
                        </div>
                        {entries.length === 0 && (
                            <div style={{ fontSize: 12, color: "var(--muted, #666)", padding: "6px 0" }}>（空）</div>
                        )}
                        {entries.map(e => (
                            <div key={e.id} style={{
                                padding: "9px 12px", marginBottom: 6, borderRadius: 10,
                                background: "var(--card, rgba(128,128,128,0.08))", fontSize: 13,
                                color: "var(--text, #ddd)", lineHeight: 1.5,
                            }}>
                                {e.content}
                                <div style={{ fontSize: 10, color: "var(--muted, #777)", marginTop: 4 }}>
                                    首知 {fmtDate(e.firstLearnedAt)} · 印证 {e.sourceCount} 次
                                </div>
                            </div>
                        ))}
                    </div>
                );
            })}

            {!loading && tab === "timeline" && <TimelineView charId={charId} />}
        </div>
    );
}

// ── 记忆节点卡片 ───────────────────────────────────
function NodeCard({ node, onDelete, onRevive }: {
    node: MemoryNode;
    onDelete?: (id: string) => void;
    onRevive?: (node: MemoryNode) => void;
}) {
    const [confirming, setConfirming] = useState(false);
    const ui = ROOM_UI[node.room];
    const cold = node.status !== "active";
    return (
        <div style={{
            padding: "10px 12px", marginBottom: 8, borderRadius: 12,
            background: "var(--card, rgba(128,128,128,0.08))",
            opacity: cold ? 0.55 : 1,
            borderLeft: `3px solid ${ui.color}`,
        }}>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                <div style={{ flex: 1, fontSize: 13, color: "var(--text, #ddd)", lineHeight: 1.55 }}>{node.content}</div>
                {onRevive && (
                    <button onClick={() => onRevive(node)} title="复活" style={iconBtnStyle}>
                        <RotateCcw size={13} color="#10B981" />
                    </button>
                )}
                {onDelete && !confirming && (
                    <button onClick={() => { setConfirming(true); setTimeout(() => setConfirming(false), 3000); }} title="删除" style={iconBtnStyle}>
                        <Trash2 size={13} color="var(--muted, #888)" />
                    </button>
                )}
                {onDelete && confirming && (
                    <button onClick={() => onDelete(node.id)} style={{
                        ...iconBtnStyle, fontSize: 10, color: "#EF4444", fontWeight: 600, width: "auto", padding: "0 6px",
                    }}>确认</button>
                )}
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6, alignItems: "center" }}>
                <span style={chipStyle(ui.color + "22", ui.color)}>{ROOM_LABELS[node.room]}</span>
                <span style={chipStyle("rgba(128,128,128,0.12)", "var(--muted, #999)")}>重要 {node.importance}</span>
                {node.mood && node.mood !== "neutral" && (
                    <span style={chipStyle("rgba(128,128,128,0.12)", "var(--muted, #999)")}>{node.mood}</span>
                )}
                {node.origin === "digestion" && (
                    <span style={chipStyle("rgba(6,182,212,0.14)", "#06B6D4")}>消化产物</span>
                )}
                {node.accessCount > 0 && (
                    <span style={chipStyle("rgba(128,128,128,0.12)", "var(--muted, #999)")}>想起 {node.accessCount} 次</span>
                )}
                <span style={{ fontSize: 10, color: "var(--muted, #666)", marginLeft: "auto" }}>{fmtDate(node.createdAt)}</span>
            </div>
            {node.quote && (
                <div style={{
                    marginTop: 6, padding: "6px 9px", borderRadius: 8, fontSize: 11,
                    background: "rgba(16,185,129,0.08)", color: "#6EE7B7", lineHeight: 1.5,
                }}>
                    「{node.quote}」
                    {node.quoteSource && (
                        <span style={{ color: "var(--muted, #777)", marginLeft: 4 }}>— {node.quoteSource}</span>
                    )}
                </div>
            )}
        </div>
    );
}

// ── 时间线 ─────────────────────────────────────────
function TimelineView({ charId }: { charId: string }) {
    const [events, setEvents] = useState<NativeTimelineEntry[] | null>(null);
    useEffect(() => {
        let alive = true;
        (async () => {
            try { await hydrateChatStorage(); } catch { /* ignore */ }
            const timeline = loadNativeTimeline(charId).slice(-300).reverse();
            if (alive) setEvents(timeline);
        })();
        return () => { alive = false; };
    }, [charId]);

    if (events === null) {
        return <div style={{ textAlign: "center", color: "var(--muted, #888)", padding: 40, fontSize: 13 }}>加载中…</div>;
    }
    if (events.length === 0) {
        return <div style={{ textAlign: "center", color: "var(--muted, #888)", padding: 30, fontSize: 13 }}>还没有原生事件</div>;
    }
    return (
        <div>
            {events.map(ev => (
                <div key={ev.id} style={{ padding: "9px 0", borderBottom: "1px solid rgba(128,128,128,0.1)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                        <span style={chipStyle("rgba(139,92,246,0.12)", "#A78BFA", 10)}>{SOURCE_LABELS[ev.sourceApp] || ev.sourceApp}</span>
                        <span style={{ fontSize: 10, color: "var(--muted, #666)", marginLeft: "auto" }}>{fmtDateTime(ev.timestamp)}</span>
                    </div>
                    <div style={{ fontSize: 12.5, color: "var(--text, #ccc)", lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                        {ev.content.length > 260 ? ev.content.slice(0, 260) + "…" : ev.content}
                    </div>
                </div>
            ))}
        </div>
    );
}

// ── 设置（极简：只暴露新引擎关心的开关）────────────
function SettingsView({ selectedCharId, onNotice }: { selectedCharId?: string; onNotice?: (msg: string) => void }) {
    const [config, setConfig] = useState<MemoryConfig>(loadMemoryConfig);
    const [confirmClear, setConfirmClear] = useState(false);

    const patch = (p: Partial<MemoryConfig>) => {
        const next = { ...config, ...p };
        setConfig(next);
        saveMemoryConfig(next);
    };

    const sources = config.shortTermAllowedSources ?? {};

    return (
        <div style={{ padding: "12px 14px 30px" }}>
            <div style={{
                padding: "10px 12px", borderRadius: 12, marginBottom: 14, fontSize: 12,
                background: "rgba(139,92,246,0.1)", color: "#C4B5FD", lineHeight: 1.6,
            }}>
                记忆宫殿 v3 已接管全部记忆：情景记忆按房间存放并混合检索（向量 + 本地关键词），
                稳定认知沉淀为门牌每轮常驻。旧版短期/长期记忆引擎已移除，历史数据已自动迁移。
            </div>

            <Section title="自动整理">
                <ToggleRow label="自动整理记忆" desc="对话每累积 N 条事件，自动提取记忆并整理门牌"
                    checked={config.autoSummarizeEnabled}
                    onChange={v => patch({ autoSummarizeEnabled: v })} />
                <div style={rowStyle}>
                    <div style={{ flex: 1 }}>
                        <div style={labelStyle}>触发间隔（事件数）</div>
                        <div style={hintStyle}>每累积这么多条事件触发一次</div>
                    </div>
                    <select value={config.summarizationEventInterval} onChange={e => patch({ summarizationEventInterval: Number(e.target.value) })}
                        style={selectStyle}>
                        {[20, 50, 80, 120, 200].map(v => <option key={v} value={v}>{v}</option>)}
                    </select>
                </div>
            </Section>

            <Section title="检索">
                <ToggleRow label="向量召回" desc="配置嵌入 API 后启用向量+关键词混合检索；关闭则纯本地关键词"
                    checked={config.vectorRecallEnabled}
                    onChange={v => patch({ vectorRecallEnabled: v })} />
                <NumberRow label="语义记忆预算" hint="单轮注入的检索记忆 token 上限"
                    value={config.longTermTokenBudget} onChange={v => patch({ longTermTokenBudget: v })} />
                <NumberRow label="门牌预算" hint="四块门牌常驻注入的 token 上限"
                    value={config.coreMemoryTokenBudget} onChange={v => patch({ coreMemoryTokenBudget: v })} />
            </Section>

            <Section title="记忆来源">
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    {SOURCE_TOGGLE_META.map(({ key, label }) => {
                        const on = (sources as Record<string, boolean | undefined>)[key] !== false;
                        return (
                            <button key={key} onClick={() => patch({ shortTermAllowedSources: { ...sources, [key]: !on } })}
                                style={{
                                    padding: "6px 12px", borderRadius: 999, border: "none", cursor: "pointer", fontSize: 12,
                                    background: on ? "rgba(139,92,246,0.16)" : "var(--card, rgba(128,128,128,0.08))",
                                    color: on ? "#A78BFA" : "var(--muted, #888)",
                                    fontWeight: on ? 600 : 400,
                                }}>
                                {label}
                            </button>
                        );
                    })}
                </div>
                <div style={{ ...hintStyle, marginTop: 8 }}>勾选的应用产生的事件才会进入记忆管线</div>
            </Section>

            {selectedCharId && (
                <Section title="数据">
                    <div style={{ ...hintStyle, marginBottom: 8 }}>
                        当前角色迁移状态：{isPalaceMigrated(selectedCharId) ? "已迁移至宫殿" : "尚未迁移（首次使用时自动进行）"}
                    </div>
                    {!confirmClear ? (
                        <button onClick={() => { setConfirmClear(true); setTimeout(() => setConfirmClear(false), 4000); }}
                            style={dangerBtnStyle}>
                            清空该角色的宫殿数据
                        </button>
                    ) : (
                        <button onClick={async () => {
                            await clearPalaceData(selectedCharId);
                            setConfirmClear(false);
                            onNotice?.("已清空该角色的宫殿数据");
                        }} style={{ ...dangerBtnStyle, background: "#EF4444" }}>
                            再点一次确认清空（不可恢复）
                        </button>
                    )}
                </Section>
            )}
        </div>
    );
}

// ── 通用小块 ───────────────────────────────────────
function Section({ title, children }: { title: string; children: ReactNode }) {
    return (
        <div style={{ marginBottom: 18 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--muted, #888)", marginBottom: 8, letterSpacing: 1 }}>{title}</div>
            <div style={{ background: "var(--card, rgba(128,128,128,0.06))", borderRadius: 14, padding: "4px 12px" }}>{children}</div>
        </div>
    );
}
function ToggleRow({ label, desc, checked, onChange }: {
    label: string; desc?: string; checked: boolean; onChange: (v: boolean) => void;
}) {
    return (
        <div style={{ ...rowStyle, padding: "10px 0", borderBottom: "1px solid rgba(128,128,128,0.08)" }}>
            <div style={{ flex: 1 }}>
                <div style={labelStyle}>{label}</div>
                {desc && <div style={hintStyle}>{desc}</div>}
            </div>
            <button onClick={() => onChange(!checked)} style={{
                width: 42, height: 24, borderRadius: 999, border: "none", cursor: "pointer",
                background: checked ? "#8B5CF6" : "rgba(128,128,128,0.3)", position: "relative", transition: "background 0.2s",
            }}>
                <span style={{
                    position: "absolute", top: 3, left: checked ? 21 : 3, width: 18, height: 18,
                    borderRadius: "50%", background: "#fff", transition: "left 0.2s",
                }} />
            </button>
        </div>
    );
}
function NumberRow({ label, hint, value, onChange }: {
    label: string; hint?: string; value: number; onChange: (v: number) => void;
}) {
    return (
        <div style={{ ...rowStyle, padding: "10px 0", borderBottom: "1px solid rgba(128,128,128,0.08)" }}>
            <div style={{ flex: 1 }}>
                <div style={labelStyle}>{label}</div>
                {hint && <div style={hintStyle}>{hint}</div>}
            </div>
            <input type="number" value={value} onChange={e => onChange(Math.max(200, Number(e.target.value) || 0))}
                style={{ ...selectStyle, width: 90 }} />
        </div>
    );
}

const rowStyle: CSSProperties = { display: "flex", alignItems: "center", gap: 10 };
const labelStyle: CSSProperties = { fontSize: 13.5, color: "var(--text, #ddd)" };
const hintStyle: CSSProperties = { fontSize: 11.5, color: "var(--muted, #888)", marginTop: 2, lineHeight: 1.5 };
const selectStyle: CSSProperties = {
    padding: "6px 10px", borderRadius: 8, border: "1px solid rgba(128,128,128,0.25)",
    background: "var(--card, rgba(128,128,128,0.1))", color: "var(--text, #ddd)", fontSize: 13,
};
const dangerBtnStyle: CSSProperties = {
    width: "100%", padding: "10px 0", borderRadius: 10, border: "none", cursor: "pointer",
    background: "rgba(239,68,68,0.14)", color: "#F87171", fontSize: 13, fontWeight: 600,
};
const iconBtnStyle: CSSProperties = {
    width: 26, height: 26, borderRadius: 8, border: "none", cursor: "pointer",
    background: "rgba(128,128,128,0.12)", display: "flex", alignItems: "center", justifyContent: "center",
    flexShrink: 0,
};
function chipStyle(bg: string, color: string, fontSize = 10.5): CSSProperties {
    return { padding: "2px 8px", borderRadius: 999, background: bg, color, fontSize, flexShrink: 0 };
}