// lib/memory-service.ts
// High-level memory orchestration: retrieve long-term memories for prompt injection.
// Kiwi-style enhancement: hybrid ranking (vector similarity × heat) + recall heat tracking.

import type { MemoryConfig, MemoryEntry } from "./memory-types";
import { loadMemoryEntriesByType, saveMemoryHeat } from "./memory-storage";
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { generateEmbedding, resolveEmbeddingModel, cosineSimilarity } from "./memory-embedding";
import { heatScore, touchMemory } from "./memory-heat";
import { estimateTokens } from "./token-counter";

/**
 * Retrieve relevant long-term memories for prompt injection.
 * Strategy:
 *   1. Total tokens <= longTermTokenBudget → return all
 *   2. Over budget + embedding API configured → hybrid ranking
 *      (vector similarity + heat), fill until budget
 *   3. Over budget + no embedding → heat & recency hybrid, fill until budget
 * Recalled entries get a heat boost (fire-and-forget persistence).
 * Embedding API is resolved from auxiliary binding (global, not per-character).
 */
export async function retrieveMemoriesForPrompt(
    characterId: string,
    currentContext: string,
    config: MemoryConfig
): Promise<MemoryEntry[]> {
    const longTermEntries = await loadMemoryEntriesByType(characterId, "long_term");
    if (longTermEntries.length === 0 || !currentContext.trim()) return [];

    const budget = config.longTermTokenBudget;

    // Calculate total tokens for all entries
    let totalTokens = 0;
    for (const entry of longTermEntries) {
        totalTokens += estimateTokens(entry.content) + 4;
    }

    // Strategy 1: all fit within budget → return all (touch all: everything is injected)
    if (totalTokens <= budget) {
        trackRecalledHeat(longTermEntries, config);
        return longTermEntries;
    }

    const useHeat = config.heatEnabled !== false;

    // Strategy 2: vector recall enabled + embedding API configured → hybrid search
    const embeddingApiConfig = config.vectorRecallEnabled ? resolveAuxiliaryApiConfig("embeddingApiConfigId") : null;
    if (embeddingApiConfig && resolveEmbeddingModel(embeddingApiConfig)) {
        const queryEmbedding = await generateEmbedding(currentContext, embeddingApiConfig);
        if (queryEmbedding) {
            const withEmbeddings = longTermEntries.filter(m => m.embedding && m.embedding.length > 0);
            if (withEmbeddings.length > 0) {
                const now = Date.now();
                const scored = withEmbeddings.map(entry => {
                    const sim = cosineSimilarity(queryEmbedding, entry.embedding!);
                    if (!useHeat) return { entry, score: sim };
                    // Hybrid: similarity × (1-w) + heat × w  → 既相关又"熟悉"的记忆优先
                    const heatW = Math.min(1, Math.max(0, config.heatWeightInRanking ?? 0.35));
                    const h = heatScore(entry, now, config.heatHalfLifeDays ?? 7);
                    return { entry, score: sim * (1 - heatW) + h * heatW };
                });
                scored.sort((a, b) => b.score - a.score);
                const picked = pickByBudget(scored, config, budget);
                if (useHeat) trackRecalledHeat(picked, config);
                return picked;
            }
        }
    }

    // Strategy 3: no embedding support → heat & recency hybrid, fill by budget
    const now = Date.now();
    const times = longTermEntries.map(e => new Date(e.createdAt).getTime());
    const minT = Math.min(...times);
    const maxT = Math.max(...times);
    const span = Math.max(1, maxT - minT);
    const scored = longTermEntries.map(entry => {
        const recencyT = new Date(entry.createdAt).getTime();
        const recencyScore = (recencyT - minT) / span; // 0(最旧) ~ 1(最新)
        if (!useHeat) return { entry, score: recencyT }; // 原行为：纯时间排序
        const heatW = Math.min(1, Math.max(0, config.heatWeightInRanking ?? 0.35));
        const h = heatScore(entry, now, config.heatHalfLifeDays ?? 7);
        return { entry, score: recencyScore * (1 - heatW) + h * heatW };
    });
    scored.sort((a, b) => b.score - a.score);
    const picked = pickByBudget(scored, config, budget);
    if (useHeat) trackRecalledHeat(picked, config);
    return picked;
}

/**
 * 预算填充入口：
 * - 普通模式：按评分顺取直到预算耗尽（fillByBudget）
 * - 日历套娃模式：按 今天/本周/本月/更早 分层分配预算（近层更详细），
 *   预算取 min(calendarSummaryTokenBudget, longTermTokenBudget)。
 */
function pickByBudget(
    scored: { entry: MemoryEntry; score: number }[],
    config: MemoryConfig,
    budget: number,
): MemoryEntry[] {
    if (!config.calendarSummaryEnabled) {
        return fillByBudget(scored.map(s => s.entry), budget);
    }
    const calendarBudget = (config.calendarSummaryTokenBudget ?? 0) > 0
        ? Math.min(config.calendarSummaryTokenBudget, budget)
        : budget;
    return selectByCalendarLayers(scored, calendarBudget);
}

/**
 * 日历套娃分层选择：模拟人脑按时间粒度组织记忆——「今天」记得最细（50% 预算），
 * 「本周」次之（25%），「本月」再之（15%），「更早」仅留少量（10%）。
 * 每层内部仍按混合评分（向量×热度）排序；某层为空/吃不满时预算顺延给后续层。
 */
function selectByCalendarLayers(
    scored: { entry: MemoryEntry; score: number }[],
    budget: number,
): MemoryEntry[] {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startOfWeek = startOfToday - ((now.getDay() + 6) % 7) * 86_400_000; // 周一为周起点
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

    const layers: { from: number; to: number; share: number }[] = [
        { from: startOfToday, to: Infinity, share: 0.50 },
        { from: startOfWeek, to: startOfToday, share: 0.25 },
        { from: startOfMonth, to: startOfWeek, share: 0.15 },
        { from: 0, to: startOfMonth, share: 0.10 },
    ];

    const selected: MemoryEntry[] = [];
    let remaining = budget;
    for (const layer of layers) {
        if (remaining <= 0) break;
        const layerScored = scored
            .filter(({ entry }) => {
                const t = new Date(entry.createdAt).getTime();
                if (Number.isNaN(t)) return false;
                return t >= layer.from && t < layer.to;
            })
            .sort((a, b) => b.score - a.score);
        if (layerScored.length === 0) continue;
        const layerBudget = Math.floor(budget * layer.share);
        const picked = fillByBudget(layerScored.map(s => s.entry), Math.min(layerBudget, remaining));
        selected.push(...picked);
        for (const p of picked) {
            remaining -= estimateTokens(p.content) + 4;
        }
    }
    return selected;
}

export async function retrieveCoreMemoriesForPrompt(
    characterId: string,
    config: MemoryConfig,
): Promise<MemoryEntry[]> {
    const coreEntries = await loadMemoryEntriesByType(characterId, "core");
    if (coreEntries.length === 0) return [];

    const now = Date.now();
    const useHeat = config.heatEnabled !== false;
    const heatW = useHeat ? Math.min(1, Math.max(0, config.heatWeightInRanking ?? 0.35)) : 0;

    const sorted = [...coreEntries].sort((a, b) => {
        // 1) active 标记优先（保留原业务逻辑）
        const aActive = a.metadata?.active ? 1 : 0;
        const bActive = b.metadata?.active ? 1 : 0;
        if (aActive !== bActive) return bActive - aActive;
        // 2) 热度加权
        if (useHeat) {
            const aH = heatScore(a, now, config.heatHalfLifeDays ?? 7);
            const bH = heatScore(b, now, config.heatHalfLifeDays ?? 7);
            if (Math.abs(aH - bH) > 0.01) return bH - aH;
        }
        // 3) 时间兜底（保留原行为）
        const aDate = String(a.metadata?.eventDate ?? a.updatedAt ?? a.createdAt);
        const bDate = String(b.metadata?.eventDate ?? b.updatedAt ?? b.createdAt);
        return bDate.localeCompare(aDate);
    });

    const picked = fillByBudget(sorted, config.coreMemoryTokenBudget);
    if (useHeat) trackRecalledHeat(picked, config);
    return picked;
}

/** Fire-and-forget: boost heat of recalled entries (persist async, never block). */
function trackRecalledHeat(entries: MemoryEntry[], config: MemoryConfig): void {
    if (!entries.length || config.heatEnabled === false) return;
    const boost = config.heatBoostOnRecall ?? 0.18;
    for (const entry of entries) {
        const touched = touchMemory(entry, boost);
        saveMemoryHeat(touched).catch(() => {
            /* 热度追踪失败不影响主流程 */
        });
    }
}

/** Pick entries in order until token budget is exhausted. */
function fillByBudget(entries: MemoryEntry[], budget: number): MemoryEntry[] {
    const result: MemoryEntry[] = [];
    let used = 0;
    for (const entry of entries) {
        const tokens = estimateTokens(entry.content) + 4;
        if (used + tokens > budget) break;
        result.push(entry);
        used += tokens;
    }
    return result;
}