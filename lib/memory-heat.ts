// lib/memory-heat.ts
// Kiwi-style "human brain" heat system.
// 模拟人脑记忆的「热度」：记忆被访问越多越「记得牢」（heat 上升），
// 久不使用则按艾宾浩斯式遗忘曲线指数衰减（heat 下降）。
// 检索排序时 heat 与向量相似度加权融合，形成「既相关又熟悉」的召回。

import type { MemoryEntry } from "./memory-types";

export const DEFAULT_INITIAL_HEAT = 0.7;      // 新生成长期记忆的初始热度
export const DEFAULT_LEGACY_HEAT = 0.5;       // 旧版本数据（无 heat 字段）的默认热度
export const MIN_HEAT = 0.05;                  // 热度下限：再冷也不会归零，保留"隐约记得"感
export const MAX_HEAT = 1;                     // 热度上限

/**
 * 指数衰减：heat * 0.5^(elapsedDays / halfLifeDays)
 * 半衰期越长衰减越慢；不传 heatUpdatedAt 视为刚从初始热度开始（不衰减）。
 */
export function decayHeat(
    heat: number,
    heatUpdatedAt: string | undefined,
    now: Date | number = Date.now(),
    halfLifeDays = 7,
): number {
    const current = clampHeat(heat);
    if (!heatUpdatedAt) return current;
    const updatedMs = new Date(heatUpdatedAt).getTime();
    if (Number.isNaN(updatedMs)) return current;
    const elapsedDays = Math.max(0, (nowMs(now) - updatedMs) / 86_400_000);
    if (elapsedDays <= 0) return current;
    const decayed = current * Math.pow(0.5, elapsedDays / Math.max(0.1, halfLifeDays));
    return clampHeat(decayed);
}

/**
 * 饱和式热度提升：heat + boost * (1 - heat)
 * 与 boost 越大提升越多但永不超 1；高频访问的边际收益递减（模拟"熟记"）。
 */
export function boostHeat(heat: number, boost: number): number {
    const current = clampHeat(heat);
    return clampHeat(current + boost * (1 - current));
}

/** 计算记忆的当前有效热度（考虑衰减后的实时值，不写回存储）。 */
export function effectiveHeat(entry: MemoryEntry, now: Date | number = Date.now(), halfLifeDays = 7): number {
    const base = entry.heat ?? DEFAULT_LEGACY_HEAT;
    return decayHeat(base, entry.heatUpdatedAt ?? entry.updatedAt, now, halfLifeDays);
}

/**
 * 召回后热度追踪：提升 heat、累计 accessCount、记录 lastAccessedAt。
 * 返回 new entry 副本（调用方负责持久化）。
 */
export function touchMemory(
    entry: MemoryEntry,
    boost: number,
    now: Date | number = Date.now(),
): MemoryEntry {
    const ts = new Date(nowMs(now)).toISOString();
    // 基于当前有效热度（先衰减到此刻，再提升），保证 boost 语义一致
    const current = effectiveHeat(entry, now);
    return {
        ...entry,
        heat: boostHeat(current, boost),
        heatUpdatedAt: ts,
        accessCount: (entry.accessCount ?? 0) + 1,
        lastAccessedAt: ts,
    };
}

/** 把 heat 归一化到 [MIN_HEAT, MAX_HEAT] 区间。 */
export function clampHeat(heat: number): number {
    if (Number.isNaN(heat)) return DEFAULT_LEGACY_HEAT;
    return Math.min(MAX_HEAT, Math.max(MIN_HEAT, heat));
}

/** 用于检索排序：把 heat 转成 0-1 标准化分数（默认已是 0-1，仅做 clamp）。 */
export function heatScore(entry: MemoryEntry, now: Date | number = Date.now(), halfLifeDays = 7): number {
    return clampHeat(effectiveHeat(entry, now, halfLifeDays));
}

function nowMs(now: Date | number): number {
    return typeof now === "number" ? now : now.getTime();
}
