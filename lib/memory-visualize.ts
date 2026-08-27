// lib/memory-visualize.ts
// Kiwi memory constellation: 构建「记忆星图」数据。
// 借鉴 MemoryConstellations 的星图隐喻——
// 高热度记忆 = 明亮恒星（靠近中心、更大更亮），
// 低热度记忆 = 边缘星尘（小而暗淡），Dream 产物 = 超新星遗迹（带来源连线）。
// 纯数据构建，不含 UI；组件层负责渲染。
import type { MemoryEntry } from "./memory-types";
import { effectiveHeat } from "./memory-heat";

/** 热度五档分布桶 */
export type HeatBucket = { label: string; count: number; color: string };

/** 星图节点：坐标归一化 0-1，由组件映射到像素 */
export type ConstellationNode = {
    id: string;
    label: string;
    content: string;
    kind: "long_term" | "core";
    heat: number;            // 当前有效热度（已考虑衰减）
    importance: number;
    accessedTimes: number;
    createdAt: string;
    dreamed: boolean;        // 是否为 Dream 整合产物
    x: number;
    y: number;
    radius: number;          // 相对半径 0-1（热度和重要度越大越亮眼）
    cluster?: string;        // 实体簇名（迁移时由 LLM 抽取）
};

/** Dream 连线：产物 → 源碎片 */
export type DreamLink = { from: string; to: string };

/** 记忆快照：星图 + 统计面板需要的全部数据 */
export type MemorySnapshot = {
    total: number;
    kiwiCount: number;
    legacyCount: number;
    dreamedCount: number;
    avgHeat: number;
    topHeat: number;
    buckets: HeatBucket[];
    nodes: ConstellationNode[];
    links: DreamLink[];
    entityClusters: { name: string; count: number }[];
};

const NODE_CAP = 60;          // 移动端渲染上限
const BUCKET_STEPS = [
    { label: "0-0.2", color: "#3b4a6b" },
    { label: "0.2-0.4", color: "#5b6b9e" },
    { label: "0.4-0.6", color: "#8b7bb8" },
    { label: "0.6-0.8", color: "#c78ab0" },
    { label: "0.8-1.0", color: "#ff9d5c" },
];

/** 热度 → 颜色：冷蓝星尘 → 暖橙恒星 */
export function heatColor(heat: number): string {
    const t = Math.min(1, Math.max(0, heat));
    const hue = 220 - t * 195;                 // 220(蓝) → 25(橙)
    const sat = 55 + t * 35;
    const light = 32 + t * 26;
    return `hsl(${hue}, ${sat}%, ${light}%)`;
}

/** 提取记忆中的实体标签（迁移/总结时写入 metadata.entities） */
function extractEntities(entry: MemoryEntry): string[] {
    const raw = entry.metadata?.entities;
    if (Array.isArray(raw)) {
        return raw.filter((e): e is string => typeof e === "string" && e.trim().length > 0);
    }
    return [];
}

/**
 * 构建记忆快照。
 * - 热度分布桶（用于直方图）
 * - 节点：Dream 产物必选 + 热度 Top 补齐，螺旋式布局（黄金角让节点均匀铺开）
 * - 连线：dreamCompacted 产物的 originIds → 源节点
 * - 实体簇：metadata.entities 聚合
 */
export function buildMemorySnapshot(
    entries: MemoryEntry[],
    halfLifeDays = 7,
    now: Date | number = Date.now(),
): MemorySnapshot {
    const scored = entries
        .map(entry => ({ entry, heat: effectiveHeat(entry, now, halfLifeDays) }))
        .sort((a, b) => b.heat - a.heat);

    // 统计
    const total = entries.length;
    const kiwiCount = entries.filter(e => typeof e.heat === "number" && !Number.isNaN(e.heat)).length;
    const legacyCount = total - kiwiCount;
    const dreamedCount = entries.filter(e => e.dreamCompacted === true).length;
    const avgHeat = total > 0 ? scored.reduce((s, x) => s + x.heat, 0) / total : 0;
    const topHeat = scored.length > 0 ? scored[0].heat : 0;

    // 热度分布
    const buckets: HeatBucket[] = BUCKET_STEPS.map(b => ({ ...b, count: 0 }));
    for (const { heat } of scored) {
        const idx = Math.min(BUCKET_STEPS.length - 1, Math.floor(heat * BUCKET_STEPS.length));
        buckets[idx].count += 1;
    }

    // 节点选择：Dream 产物优先（它们是星图里的超新星），再按热度补足
    const dreamedNodes = scored.filter(s => s.entry.dreamCompacted === true);
    const picked = new Map<string, { entry: MemoryEntry; heat: number }>();
    for (const item of dreamedNodes) picked.set(item.entry.id, item);
    for (const item of scored) {
        if (picked.size >= NODE_CAP) break;
        if (!picked.has(item.entry.id)) picked.set(item.entry.id, item);
    }
    const selected = [...picked.values()].sort((a, b) => b.heat - a.heat);

    // 螺旋布局：黄金角 2.399963 rad，热度越高越靠近中心、半径越大
    const GOLDEN_ANGLE = 2.399963;
    const n = selected.length;
    const nodes: ConstellationNode[] = selected.map((item, i) => {
        const { entry, heat } = item;
        const baseR = (0.16 + 0.68 * Math.sqrt(i / Math.max(1, n - 1))) * (1 - heat * 0.35);
        const theta = i * GOLDEN_ANGLE;
        const cluster = extractEntities(entry)[0];
        return {
            id: entry.id,
            label: entry.content.slice(0, 18) + (entry.content.length > 18 ? "…" : ""),
            content: entry.content,
            kind: entry.type,
            heat,
            importance: entry.importance ?? 0.5,
            accessedTimes: entry.accessCount ?? 0,
            createdAt: entry.createdAt,
            dreamed: entry.dreamCompacted === true,
            x: 0.5 + baseR * Math.cos(theta) * 0.46,
            y: 0.5 + baseR * Math.sin(theta) * 0.46,
            radius: 0.05 + heat * 0.1 + (entry.type === "core" ? 0.02 : 0),
            cluster,
        };
    });

    // Dream 连线：产物 originIds → 源节点（源节点未入选时跳过）
    const nodeById = new Map(nodes.map(nd => [nd.id, nd]));
    const links: DreamLink[] = [];
    for (const item of selected) {
        const entry = item.entry;
        if (!entry.dreamCompacted || !entry.originIds) continue;
        for (const originId of entry.originIds) {
            if (nodeById.has(originId)) links.push({ from: originId, to: entry.id });
        }
    }

    // 实体簇聚合
    const clusterCounts = new Map<string, number>();
    for (const item of scored) {
        for (const entity of extractEntities(item.entry)) {
            clusterCounts.set(entity, (clusterCounts.get(entity) || 0) + 1);
        }
    }
    const entityClusters = [...clusterCounts.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 12);

    return { total, kiwiCount, legacyCount, dreamedCount, avgHeat, topHeat, buckets, nodes, links, entityClusters };
}
