// lib/memory-service.ts
// 心潮·念 v3（记忆宫殿）—— 门面层
// 策略：「保留签名、替换心脏」——22 个业务引擎只认识这两个检索函数，
// 内部已全部改走记忆宫殿：语义记忆 = 混合检索（向量85% + 本地BM25 15%）+ 扩散激活；
// 底色认知 = 四块门牌（TA的事/我是谁/我们之间/我的领域）每轮常驻，不再"抽卡"。
// 旧 v2 记忆经幂等迁移进入宫殿（core→用户房，long_term→客厅），v2 数据保留可回退。

import type { MemoryConfig, MemoryEntry } from "./memory-types";
import type { MemoryNode } from "./palace-types";
import { ROOM_LABELS } from "./palace-types";
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { resolveEmbeddingModel } from "./memory-embedding";
import { estimateTokens } from "./token-counter";
import { palaceHybridSearch, palaceSpreadActivation } from "./palace-search";
import {
    bulkPutPalaceNodes,
    loadPalacePlates,
    migrateLegacyEntriesToPalace,
} from "./palace-storage";

/**
 * 旧引擎版本判定。宫殿 v3 起后端恒为记忆宫殿，该函数保留导出
 * 仅为兼容旧引擎模块（memory-dream / memory-conflict）的引用。
 */
export function isKiwiEngine(_config: MemoryConfig): boolean {
    void _config;
    return true;
}

/** 宫殿节点 → 旧 MemoryEntry 适配（保真字段完整携带，业务格式化器零改动）。 */
export function palaceNodeToEntry(node: MemoryNode): MemoryEntry {
    const createdIso = new Date(node.createdAt).toISOString();
    return {
        id: node.id,
        characterId: node.characterId,
        sourceApp: "chat",
        type: "long_term",
        content: node.content,
        embedding: node.embedding,
        importance: node.importance / 10,
        createdAt: createdIso,
        updatedAt: createdIso,
        accessCount: node.accessCount,
        lastAccessedAt: new Date(node.lastAccessedAt).toISOString(),
        status: node.status,
        quote: node.quote,
        quoteSource: node.quoteSource,
        metadata: { palaceRoom: node.room, roomLabel: ROOM_LABELS[node.room] },
    };
}

/**
 * 语义记忆检索（原「长期记忆」注入点，签名不变）。
 * 宫殿实现：懒迁移 → 混合检索（嵌入可用=向量+BM25 融合；无嵌入=纯本地 BM25）
 * → 扩散激活（沿链接图联想关联记忆）→ token 预算顺取。
 * 召回节点 accessCount+1 为 fire-and-forget（熟悉度加成的输入）。
 */
export async function retrieveMemoriesForPrompt(
    characterId: string,
    currentContext: string,
    config: MemoryConfig
): Promise<MemoryEntry[]> {
    if (!currentContext.trim()) return [];
    await migrateLegacyEntriesToPalace(characterId).catch(() => null);

    const embeddingApiConfig = config.vectorRecallEnabled
        ? resolveAuxiliaryApiConfig("embeddingApiConfigId")
        : null;
    const usable = embeddingApiConfig && resolveEmbeddingModel(embeddingApiConfig)
        ? embeddingApiConfig
        : null;

    const budget = Math.max(0, config.longTermTokenBudget);
    const seeded = await palaceHybridSearch(currentContext, characterId, {
        embeddingApiConfig: usable,
        topK: 40,
    });
    const expanded = await palaceSpreadActivation(seeded, characterId, 6);
    const picked = fillByBudget(expanded.map(s => palaceNodeToEntry(s.node)), budget);

    if (picked.length > 0) {
        const touched = picked
            .map(e => expanded.find(s => s.node.id === e.id)?.node)
            .filter((n): n is MemoryNode => Boolean(n))
            .map(n => ({
                ...n,
                accessCount: (n.accessCount || 0) + 1,
                lastAccessedAt: Date.now(),
            }));
        if (touched.length > 0) {
            bulkPutPalaceNodes(touched).catch(() => {
                /* 熟悉度追踪失败不影响主流程 */
            });
        }
    }
    return picked;
}

/**
 * 底色认知（原「核心记忆」注入点，签名不变）。
 * 宫殿实现：四块门牌作为每轮常驻 Constraint——稳定认知不再走检索。
 * 返回 PlateEntry 的 MemoryEntry 适配，沿用业务方现有格式化器（逐条 bullet）。
 * coreMemoryTokenBudget 兜底截断。
 */
export async function retrieveCoreMemoriesForPrompt(
    characterId: string,
    config: MemoryConfig,
): Promise<MemoryEntry[]> {
    await migrateLegacyEntriesToPalace(characterId).catch(() => null);
    const plates = await loadPalacePlates(characterId);
    if (plates.length === 0) return [];

    const entries: MemoryEntry[] = plates
        .map(p => ({
            id: p.id,
            characterId: p.characterId,
            sourceApp: "chat" as const,
            type: "core" as const,
            content: p.content,
            importance: 1,
            createdAt: new Date(p.firstLearnedAt || p.createdAt).toISOString(),
            updatedAt: new Date(p.updatedAt).toISOString(),
            metadata: { plate: true },
        }))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return fillByBudget(entries, Math.max(0, config.coreMemoryTokenBudget));
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