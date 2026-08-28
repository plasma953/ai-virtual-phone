// lib/memory-migration.ts
// 智能迁移（Legacy → Kiwi）v3 —— 轻量迁移 + 拆分任务扫描：
// - 小块旧记忆：LLM 补齐「重要度评分 + 实体标签」并重置热度，直接融入 Kiwi；
// - 大块旧记忆（≥ 配置的 splitThreshold）：不自动拆分入库，而是作为
//   「待拆分任务」返回，由用户在记忆银行 UI 中预览拆分结果、
//   重新生成或应用（lib/memory-split.ts 的 preview/apply 两段式，防失控）。
import type { MemoryEntry } from "./memory-types";
import { DEFAULT_LEGACY_HEAT } from "./memory-heat";
import {
    loadMemoryEntries,
    saveMemoryEntry,
    getAllCharacterIdsWithMemories,
} from "./memory-storage";
import { loadMemoryConfig } from "./memory-storage";
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { simpleLLMCall } from "./api-helpers";

/** 单批 LLM 评分的最大记忆条数（避免上下文/输出超限） */
const BATCH_SIZE = 10;
/** 单条记忆送入 LLM 的截断长度 */
const CONTENT_CAP = 200;
/** 拆分流阈值默认值（可在设置页自定义 splitThreshold） */
export const DEFAULT_SPLIT_THRESHOLD = 250;

export type MigrationStats = {
    scanned: number;    // 扫描到的旧格式记忆数
    migrated: number;   // 轻量迁移成功的条数
    failed: number;     // LLM 解析失败 / 保存失败的条数
    skipped: number;    // 跳过（已有 heat，或当前角色无记忆）
    splitPending: number;   // 待人工预览拆分的大块记忆数（不自动入库）
};

/** 待拆分任务：大块旧记忆 + 所属角色名（供 UI 展示与逐条预览拆分） */
export type SplitTask = {
    entry: MemoryEntry;
    characterName: string;
};

/** 扫描待拆分任务：读取用户自定义 splitThreshold，收集所有大块旧记忆 */
export async function scanSplitTasks(): Promise<SplitTask[]> {
    const config = loadMemoryConfig();
    const threshold = Math.max(1, config.splitThreshold ?? DEFAULT_SPLIT_THRESHOLD);
    const charIds = await getAllCharacterIdsWithMemories();
    const allChars = (await import("@/lib/character-storage")).loadCharacters();
    const tasks: SplitTask[] = [];
    for (const charId of charIds) {
        // 归档/失效条目同样扫描：大块归档条目也可能需要拆分
        const entries = await loadMemoryEntries(charId, { includeInactive: true });
        for (const entry of entries) {
            if (isLegacyEntry(entry) && entry.content.length >= threshold) {
                const name = allChars.find(c => c.id === charId)?.name ?? "";
                tasks.push({ entry, characterName: name });
            }
        }
    }
    return tasks;
}

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
 * 执行轻量迁移（小块记忆直接补元数据）：
 * 大块记忆不再自动拆分入库——由 scanSplitTasks 返回任务，
 * 用户在记忆银行预览拆分结果（previewLegacySplit）后手动应用（applyLegacySplit）。
 */
export async function migrateLegacyMemories(opts?: {
    signal?: AbortSignal;
    onProgress?: (done: number, total: number) => void;
}): Promise<MigrationStats> {
    const stats: MigrationStats = { scanned: 0, migrated: 0, failed: 0, skipped: 0, splitPending: 0 };
    const config = loadMemoryConfig();
    const threshold = Math.max(1, config.splitThreshold ?? DEFAULT_SPLIT_THRESHOLD);
    const charIds = await getAllCharacterIdsWithMemories();
    const lightweight: MemoryEntry[] = [];
    for (const charId of charIds) {
        const entries = await loadMemoryEntries(charId, { includeInactive: true });
        for (const entry of entries) {
            if (!isLegacyEntry(entry)) continue;
            if (entry.content.length >= threshold) {
                stats.splitPending += 1;    // 大块：待人工拆分，不自动处理
                continue;
            }
            lightweight.push(entry);
        }
    }
    stats.scanned = stats.migrated + stats.failed + stats.splitPending;
    if (lightweight.length === 0) return stats;

    const now = new Date().toISOString();
    let done = 0;
    for (let i = 0; i < lightweight.length; i += BATCH_SIZE) {
        if (opts?.signal?.aborted) break;
        const batch = lightweight.slice(i, i + BATCH_SIZE);
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
            opts?.onProgress?.(done, lightweight.length);
        }
    }
    return stats;
}
