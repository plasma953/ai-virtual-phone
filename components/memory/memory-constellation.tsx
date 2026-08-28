"use client";
// components/memory/memory-constellation.tsx
// 记忆星图：把 Kiwi 热度系统变成「所见即所得」的星空。
// 高热度记忆 = 明亮恒星（靠近中心、更大更亮），低热度 = 边缘星尘，
// Dream 整合产物 = 超新星遗迹（金色描边 + 与源碎片的连线）。
// 零依赖 SVG 渲染，60 节点上限，移动端 Safari 友好。
import { useMemo, useState } from "react";
import type { MemoryEntry, MemoryConfig } from "@/lib/memory-types";
import {
    buildMemorySnapshot,
    heatColor,
    type ConstellationNode,
} from "@/lib/memory-visualize";
import { DEFAULT_SPLIT_THRESHOLD } from "@/lib/memory-migration";
import { X, Sparkles, Scissors } from "lucide-react";

const VIEW = 360;                 // SVG viewBox 尺寸
const TAU = Math.PI * 2;

/** 确定性伪随机（避免每次渲染星星闪烁） */
function seededRandom(seed: number) {
    let s = seed;
    return () => {
        s = (s * 16807) % 2147483647;
        return (s - 1) / 2147483646;
    };
}

/** 背景星尘：一组固定的小亮点，营造深空感 */
function Starfield({ seed = 7 }: { seed?: number }) {
    const stars = useMemo(() => {
        const rand = seededRandom(seed);
        return Array.from({ length: 46 }, (_, i) => ({
            x: rand() * VIEW,
            y: rand() * VIEW,
            r: 0.4 + rand() * 0.9,
            o: 0.12 + rand() * 0.4,
        }));
    }, [seed]);
    return (
        <g>
            {stars.map((s, i) => (
                <circle key={i} cx={s.x} cy={s.y} r={s.r} fill="#cdd6f4" opacity={s.o} />
            ))}
        </g>
    );
}

export function MemoryConstellation({
    entries,
    config,
    onSplitEntry,
}: {
    entries: MemoryEntry[];
    config: MemoryConfig;
    /** 星图内拆分大块记忆：把节点详情里的「拆分」动作交还给记忆银行页
     * （复用其全局的 预览→应用 两段式拆分面板，防失控）。 */
    onSplitEntry?: (entry: MemoryEntry) => void;
}) {
    const snapshot = useMemo(
        () => buildMemorySnapshot(entries, config.heatHalfLifeDays ?? 7),
        [entries, config.heatHalfLifeDays],
    );
    const [selected, setSelected] = useState<ConstellationNode | null>(null);

    const nodeById = useMemo(() => new Map(snapshot.nodes.map(n => [n.id, n])), [snapshot.nodes]);

    return (
        <div className="flex flex-col gap-3" style={{ paddingBottom: 90 }}>
            {/* ── 统计卡片行 ── */}
            <div className="flex gap-2 overflow-x-auto">
                <StatCard label="记忆总量" value={String(snapshot.total)} />
                <StatCard label="Dream 产物" value={String(snapshot.dreamedCount)} accent />
                <StatCard label="平均热度" value={(snapshot.avgHeat * 100).toFixed(0) + "%"} />
                <StatCard label="最热记忆" value={(snapshot.topHeat * 100).toFixed(0) + "%"} hot />
            </div>

            {/* ── 星图 SVG ── */}
            <div
                className="relative"
                style={{
                    borderRadius: 20,
                    overflow: "hidden",
                    background: "radial-gradient(circle at 50% 42%, #1a2340 0%, #0c1024 62%, #060814 100%)",
                    border: "1px solid rgba(140,160,255,0.14)",
                }}
            >
                <svg
                    viewBox={`0 0 ${VIEW} ${VIEW}`}
                    style={{ width: "100%", height: "auto", display: "block", touchAction: "manipulation" }}
                >
                    <defs>
                        <radialGradient id="mem-core-glow" cx="50%" cy="50%" r="50%">
                            <stop offset="0%" stopColor="rgba(255,190,120,0.5)" />
                            <stop offset="100%" stopColor="rgba(255,190,120,0)" />
                        </radialGradient>
                    </defs>
                    {/* 中心光晕：认知核心 */}
                    <circle cx={VIEW / 2} cy={VIEW / 2} r={86} fill="url(#mem-core-glow)" opacity={0.8} />
                    <Starfield />

                    {/* Dream 连线：产物 → 源碎片（先画，压在节点下面） */}
                    {snapshot.links.map((link, i) => {
                        const src = nodeById.get(link.from);
                        const dst = nodeById.get(link.to);
                        if (!src || !dst) return null;
                        return (
                            <line
                                key={`link-${i}`}
                                x1={src.x * VIEW}
                                y1={src.y * VIEW}
                                x2={dst.x * VIEW}
                                y2={dst.y * VIEW}
                                stroke="#8b9cf5"
                                strokeWidth={0.8}
                                strokeDasharray="2 3"
                                opacity={0.45}
                            />
                        );
                    })}

                    {/* 节点：恒星/星尘 */}
                    {snapshot.nodes.map(node => {
                        const cx = node.x * VIEW;
                        const cy = node.y * VIEW;
                        const r = 4 + node.radius * 30;      // 亮度越高越大
                        const color = heatColor(node.heat);
                        return (
                            <g
                                key={node.id}
                                onClick={() => setSelected(selected?.id === node.id ? null : node)}
                                style={{ cursor: "pointer" }}
                            >
                                {/* 光晕 */}
                                <circle cx={cx} cy={cy} r={r * 2.1} fill={color} opacity={0.10 + node.heat * 0.10} />
                                {node.dreamed && (
                                    <circle cx={cx} cy={cy} r={r * 1.55} fill="none" stroke="#ffd166" strokeWidth={1} opacity={0.85} />
                                )}
                                <circle
                                    cx={cx}
                                    cy={cy}
                                    r={r}
                                    fill={color}
                                    fillOpacity={0.55 + node.heat * 0.45}
                                    stroke={selected?.id === node.id ? "#ffffff" : "rgba(255,255,255,0.22)"}
                                    strokeWidth={selected?.id === node.id ? 1.4 : 0.7}
                                />
                            </g>
                        );
                    })}
                </svg>

                {/* 图例浮层 */}
                <div className="flex flex-col gap-1" style={{ position: "absolute", top: 10, right: 10, pointerEvents: "none" }}>
                    <LegendDot color="#ff9d5c" label="高频记忆" />
                    <LegendDot color="#5b6b9e" label="低频星尘" />
                    <LegendDot color="#ffd166" label="Dream 产物" outline />
                </div>
            </div>

            {/* ── 热度分布直方图 ── */}
            <div className="flex flex-col gap-1.5">
                <span className="ts-12 text-secondary">热度分布</span>
                <div className="flex items-end gap-1.5" style={{ height: 54 }}>
                    {snapshot.buckets.map((b, i) => {
                        const max = Math.max(1, ...snapshot.buckets.map(x => x.count));
                        const h = Math.max(6, (b.count / max) * 44);
                        return (
                            <div key={i} className="flex flex-col items-center gap-1 flex-1">
                                <div
                                    style={{
                                        width: "100%",
                                        height: h,
                                        borderRadius: 6,
                                        background: b.color,
                                        opacity: 0.85,
                                        transition: "height .3s ease",
                                    }}
                                />
                                <span className="ts-10 text-tertiary">{b.label}</span>
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* ── 实体簇（迁移后由 LLM 抽取） ── */}
            {snapshot.entityClusters.length > 0 && (
                <div className="flex flex-col gap-1.5">
                    <span className="ts-12 text-secondary">实体星簇</span>
                    <div className="flex flex-wrap gap-1.5">
                        {snapshot.entityClusters.map(c => (
                            <span
                                key={c.name}
                                className="ts-11"
                                style={{
                                    padding: "3px 9px",
                                    borderRadius: 999,
                                    background: "rgba(139,156,245,0.14)",
                                    color: "#aab4f8",
                                    border: "1px solid rgba(139,156,245,0.25)",
                                }}
                            >
                                {c.name}
                                <span style={{ opacity: 0.65 }}> ×{c.count}</span>
                            </span>
                        ))}
                    </div>
                </div>
            )}

            {/* ── 选中节点详情浮层 ── */}
            {selected && (
                <div
                    className="modal-overlay modal-overlay-bottom"
                    data-ui="modal"
                    onClick={() => setSelected(null)}
                >
                    <div className="modal-sheet" data-ui="modal-sheet" onClick={e => e.stopPropagation()} style={{ paddingBottom: 20 }}>
                        <div className="modal-header">
                            <button className="modal-header-btn modal-header-btn-muted" onClick={() => setSelected(null)}>
                                <X size={18} />
                            </button>
                            <h3 className="modal-title flex items-center gap-1.5">
                                <Sparkles size={15} style={{ color: heatColor(selected.heat) }} />
                                记忆详情
                            </h3>
                            <span style={{ width: 36 }} />
                        </div>
                        <div className="flex flex-col gap-2 px-4" style={{ maxHeight: "46vh", overflowY: "auto" }}>
                            <div className="flex items-center gap-2 flex-wrap">
                                <HeatPill heat={selected.heat} />
                                <span className="ts-11" style={{ padding: "2px 8px", borderRadius: 999, background: "rgba(255,255,255,0.07)", color: "var(--secondary)" }}>
                                    {selected.kind === "core" ? "核心记忆" : "长期记忆"}
                                </span>
                                {selected.dreamed && (
                                    <span className="ts-11" style={{ padding: "2px 8px", borderRadius: 999, background: "rgba(255,209,102,0.14)", color: "#ffd166" }}>
                                        梦境产物
                                    </span>
                                )}
                            </div>
                            <p className="ts-13" style={{ color: "var(--primary)", lineHeight: 1.55 }}>
                                {selected.content}
                            </p>
                            <div className="flex flex-wrap gap-1.5 ts-11 text-tertiary">
                                <span>重要度 {(selected.importance * 100).toFixed(0)}%</span>
                                <span>·</span>
                                <span>召回 {selected.accessedTimes} 次</span>
                                <span>·</span>
                                <span>{new Date(selected.createdAt).toLocaleDateString()}</span>
                                {selected.cluster && (
                                    <>
                                        <span>·</span>
                                        <span>星簇 {selected.cluster}</span>
                                    </>
                                )}
                            </div>
                            {/* ── 星图内拆分：大块记忆直接在星图里原子化 ── */}
                            {onSplitEntry
                                && selected.kind === "long_term"
                                && selected.content.length >= (config.splitThreshold ?? DEFAULT_SPLIT_THRESHOLD) && (
                                    <button
                                        className="ui-btn ui-btn-outline"
                                        style={{
                                            marginTop: 10,
                                            display: "flex",
                                            alignItems: "center",
                                            justifyContent: "center",
                                            gap: 6,
                                            padding: "8px 12px",
                                            borderRadius: 12,
                                        }}
                                        onClick={() => {
                                            const entry = entries.find(e => e.id === selected.id);
                                            setSelected(null);
                                            if (entry) onSplitEntry(entry);
                                        }}
                                    >
                                        <Scissors size={14} />
                                        拆分此记忆（{selected.content.length} 字大块）
                                    </button>
                                )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

function StatCard({ label, value, accent, hot }: { label: string; value: string; accent?: boolean; hot?: boolean }) {
    return (
        <div
            className="flex flex-col gap-0.5 shrink-0"
            style={{
                minWidth: 86,
                padding: "8px 12px",
                borderRadius: 14,
                background: accent ? "rgba(255,209,102,0.10)" : hot ? "rgba(255,157,92,0.12)" : "rgba(139,156,245,0.08)",
                border: `1px solid ${accent ? "rgba(255,209,102,0.28)" : hot ? "rgba(255,157,92,0.30)" : "rgba(139,156,245,0.18)"}`,
            }}
        >
            <span className="ts-10 text-tertiary">{label}</span>
            <span className="ts-16" style={{ color: accent ? "#ffd166" : hot ? "#ff9d5c" : "var(--primary)", fontWeight: 600 }}>
                {value}
            </span>
        </div>
    );
}

function LegendDot({ color, label, outline }: { color: string; label: string; outline?: boolean }) {
    return (
        <span className="flex items-center gap-1 ts-10">
            <span
                style={{
                    width: 8,
                    height: 8,
                    borderRadius: 999,
                    background: outline ? "transparent" : color,
                    border: outline ? `1.4px solid ${color}` : "none",
                }}
            />
            <span style={{ color: "rgba(205,214,244,0.75)" }}>{label}</span>
        </span>
    );
}

function HeatPill({ heat }: { heat: number }) {
    const color = heatColor(heat);
    return (
        <span
            className="ts-11"
            style={{
                padding: "2px 9px",
                borderRadius: 999,
                background: `${color}22`,
                color,
                border: `1px solid ${color}55`,
            }}
        >
            热度 {(heat * 100).toFixed(0)}%
        </span>
    );
}
