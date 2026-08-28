// lib/memory-migration.ts
// 智能迁移（Legacy → Kiwi）：把 v1 时代没有 heat 字段的旧记忆，
// 通过 LLM 补齐「重要度评分 + 实体标签」，并重置初始热度，
// 让旧记忆无缝融入 Kiwi 热度系统（星图 / Dream / 热度召回）。
import type { MemoryEntry } from "./memory-types";
import { DEFAULT_LEGACY_HEAT } from "./memory-heat";
import {
    loadMemoryEntries,
    saveMemoryEntry,
    getAllCharacterIdsWithMemories,
} from "./memory-storage";
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { simpleLLMCall } from "./api-helpers";

/** 单批 LLM 评分的最大记忆条数（避免上下文/输出超限） */
const BATCH_SIZE = 10;
/** 单条记忆送入 LLM 的截断长度 */
const CONTENT_CAP = 200;

export type MigrationStats = {
    scanned: number;    // 扫描到的旧格式记忆数
    migrated: number;   // 成功补齐元数据的条数
    failed: number;     // LLM 解析失败 / 保存失败的条数
    skipped: number;    // 跳过（已有 heat，或当前角色无记忆）
};

/** 判断一条记忆是否为「旧格式」（缺少 Kiwi 热度元数据） */
export function isLegacyEntry(entry: MemoryEntry): boolean {
    return typeof entry.heat !== "number" || Number.isNaN(entry.heat);
}

/** 解析 LLM 返回的 JSON；失败返回 null（调用方按 failed 计数，不中断整体流程） */
function parseScoreJson(raw: string): { importance: number; entities: string[] } | null {
    try {
        const cleaned = raw.trim()
            .replace(/^```json\s*/i, "")
            .replace(/^```\s*/i, "")
            .replace(/```\s*$/, "")
            .trim();
        const start = cleaned.indexOf("{");
        const end = cleaned.lastIndexOf("}");
        if (start < 0 || end <= start) return null;
        const obj = JSON.parse(cleaned.slice(start, end + 1));
        const items = Array.isArray(obj.items) ? obj.items : [];
        const result: { importance: number; entities: string[] } = {
            importance: 0.5,
            entities: [],
        };
        const first = items[0];
        if (first && typeof first === "object") {
            const rawImp = (first as { importance?: unknown }).importance;
            if (typeof rawImp === "number" && Number.isFinite(rawImp)) {
                result.importance = Math.min(1, Math.max(0, rawImp));
            }
            const rawEntities = (first as { entities?: unknown }).entities;
            if (Array.isArray(rawEntities)) {
                result.entities = rawEntities
                    .filter((e): e is string => typeof e === "string" && e.trim().length > 0)
                    .map(e => e.trim())
                    .slice(0, 6);
            }
        }
        return result;
    } catch {
        return null;
    }
}

/**
 * 对一批旧记忆执行 LLM 重要度评分 + 实体抽取。
 * 返回 map: entryId → { importance, entities }；
 * 无可用 API 或单条失败时返回 null（保持原样，允许用户重试）。
 */
async function scoreBatch(
    batch: MemoryEntry[],
    signal?: AbortSignal,
): Promise<Map<string, { importance: number; entities: string[] }> | null> {
    const apiConfig = resolveAuxiliaryApiConfig("memorySummaryApiConfigId");
    if (!apiConfig?.apiKey) return null;

    // 只对 1-4 个重要实体进行抽取，避免输出过长
    const lines = batch.map((e, idx) => `[${idx}] ${e.content.slice(0, CONTENT_CAP)}`).join("\n");
    const prompt = [
        "你是记忆档案管理员。下面每行是一条记忆（[序号] 内容）。",
        "请逐条评估重要性 importance（0-1 小数，越重要越接近 1）",
        "并抽取 1-4 个实体关键词 entities（人名/地点/事件主题/约定）。",
        '只返回 JSON，不要任何解释：{"items":[{"idx":0,"importance":0.8,"entities":["Alice","项目"]}]}',
        "",
        lines,
    ].join("\n");

    const resp = await simpleLLMCall(
        apiConfig,
        [{ role: "user", content: prompt }],
        { temperature: 0.2, max_tokens: 800, signal },
    );
    if (!resp.content) return null;

    const map = new Map<string, { importance: number; entities: string[] }>();
    try {
        const cleaned = resp.content.trim()
            .replace(/^```json\s*/i, "")
            .replace(/^```\s*/i, "")
            .replace(/```\s*$/, "")
            .trim();
        const start = cleaned.indexOf("{");
        const end = cleaned.lastIndexOf("}");
        if (start < 0 || end <= start) return null;
        const obj = JSON.parse(cleaned.slice(start, end + 1));
        const items = Array.isArray(obj.items) ? (obj.items as Array<Record<string, unknown>>) : [];
        for (const item of items) {
            const idx = Number(item.idx);
            if (!Number.isInteger(idx) || idx < 0 || idx >= batch.length) continue;
            const entry = batch[idx];
            let importance = entry.importance;
            if (typeof item.importance === "number" && Number.isFinite(item.importance)) {
                importance = Math.min(1, Math.max(0, item.importance));
            }
            let entities: string[] = [];
            if (Array.isArray(item.entities)) {
                entities = item.entities
                    .filter((e): e is string => typeof e === "string" && e.trim().length > 0)
                    .map(e => e.trim())
                    .slice(0, 6);
            }
            map.set(entry.id, { importance, entities });
        }
    } catch {
        return map.size > 0 ? map : null;
    }
    return map.size > 0 ? map : null;
}

/**
 * 执行全量智能迁移。
 * 步骤：
 * 1) 遍历所有角色的记忆，收集旧格式条目（无 heat）
 * 2) 分批调用 LLM：重要度评分 + 实体抽取
 * 3) 逐条写回：importance / metadata.entities / heat=DEFAULT_LEGACY_HEAT / heatUpdatedAt=now
 * 返回统计（scanned/migrated/failed/skipped）。
 * 注意：LLM 不可用时不会写坏数据，仅 skipped，用户可以之后重试。
 */
export async function migrateLegacyMemories(opts?: {
    signal?: AbortSignal;
    onProgress?: (done: number, total: number) => void;
    /** 调试用：限制只处理前 N 条 */
    limit?: number;
}): Promise<MigrationStats> {
    const stats: MigrationStats = { scanned: 0, migrated: 0, failed: 0, skipped: 0 };
    const charIds = await getAllCharacterIdsWithMemories();
    const legacy: MemoryEntry[] = [];
    for (const charId of charIds) {
        // 归档/失效条目同样补齐热度元数据：复活后可直接参与召回。
        const entries = await loadMemoryEntries(charId, { includeInactive: true });
        for (const entry of entries) {
            if (isLegacyEntry(entry)) legacy.push(entry);
        }
    }
    stats.scanned = legacy.length;
    if (opts?.limit && opts.limit > 0) legacy.splice(opts.limit);
    stats.scanned = legacy.length;
    if (legacy.length === 0) return stats;

    const now = new Date().toISOString();
    let done = 0;
    for (let i = 0; i < legacy.length; i += BATCH_SIZE) {
        if (opts?.signal?.aborted) break;
        const batch = legacy.slice(i, i + BATCH_SIZE);
        const scores = await scoreBatch(batch, opts?.signal);
        for (const entry of batch) {
            if (opts?.signal?.aborted) break;
            try {
                const meta = scores?.get(entry.id);
                const next: MemoryEntry = {
                    ...entry,
                    importance: meta ? meta.importance : entry.importance,
                    heat: DEFAULT_LEGACY_HEAT,
                    heatUpdatedAt: now,
                    accessCount: entry.accessCount ?? 0,
                    metadata: {
                        ...(entry.metadata ?? {}),
                        ...(meta && meta.entities.length > 0 ? { entities: meta.entities } : {}),
                    },
                };
                await saveMemoryEntry(next);
                stats.migrated += 1;
            } catch {
                stats.failed += 1;
            }
            done += 1;
        }
        opts?.onProgress?.(done, legacy.length);
    }
    return stats;
}
