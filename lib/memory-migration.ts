// lib/memory-migration.ts
// 智能迁移（Legacy → Kiwi）v2 —— 原子化拆分迁移：
// - 大块旧记忆（> 250 字，通常是旧系统把多段时间线"一大坨"混写的总结）
//   由 LLM 拆分成一条条原子化记忆事实（只拆分、不编造），每条附
//   「逐字引用」证据锚点（保真层机械校验），源条目归档（archived）永存、
//   可复活回滚；
// - 小块记忆走轻量路径：LLM 补齐重要度+实体标签，重置热度融入 Kiwi 系统。
import type { MemoryEntry } from "./memory-types";
import { DEFAULT_LEGACY_HEAT, DEFAULT_INITIAL_HEAT } from "./memory-heat";
import {
    loadMemoryEntries,
    saveMemoryEntry,
    getAllCharacterIdsWithMemories,
} from "./memory-storage";
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { simpleLLMCall } from "./api-helpers";
import {
    extractQuoteBlocks,
    verifyQuoteAgainstSource,
} from "./memory-quote";

/** 单批 LLM 评分的最大记忆条数（避免上下文/输出超限） */
const BATCH_SIZE = 10;
/** 单条记忆送入 LLM 的截断长度 */
const CONTENT_CAP = 200;
/** 原子化拆分阈值：超过该长度的大块旧记忆（旧系统混写总结）进入拆分路径 */
export const SPLIT_THRESHOLD = 250;
/** 拆分产物单条正文长度上限（超出截断，防 LLM 失控输出撑爆预算） */
const SPLIT_CONTENT_MAX = 300;
/** 单次拆分最多产出的原子记忆条数 */
const MAX_SPLITS_PER_ENTRY = 8;

export type MigrationStats = {
    scanned: number;    // 扫描到的旧格式记忆数
    migrated: number;   // 成功补齐元数据的条数（轻量路径）
    failed: number;     // LLM 解析失败 / 保存失败的条数
    skipped: number;    // 跳过（已有 heat，或当前角色无记忆）
    splitEntries: number;   // 进入拆分路径的大块记忆数
    splitProduced: number;  // 拆分产出的原子记忆总条数
    splitFailed: number;    // 拆分失败（回退为原样轻量迁移）的条数
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

/** 拆分产物（LLM 输出解析后的中间形态） */
type SplitAtom = { content: string; quote: string | null; importance: number };

/**
 * 把一条大块旧记忆 LLM 拆分为原子化记忆事实。
 * 保真原则：只允许「拆分/重述源文中已有的事实」，不允许新增编造；
 * 每条产物必须附 [引用: "源文原句"] 作为证据锚点，机械校验逐字存在。
 * 返回 null 表示拆分失败（调用方回退为原样轻量迁移，绝不丢数据）。
 */
async function splitLegacyEntryIntoAtoms(
    entry: MemoryEntry,
    signal?: AbortSignal,
): Promise<SplitAtom[] | null> {
    const apiConfig = resolveAuxiliaryApiConfig("memorySummaryApiConfigId");
    if (!apiConfig?.apiKey) return null;

    // 拆分基准 = 源条目完整原文（不截断——截断会导致拆分产物丢失尾部事实）
    const sourceText = entry.content.trim();
    const prompt = [
        `你是记忆档案整理员。下面是一条旧记忆系统生成的「大块混合总结」，它把多件事压在了一起。`,
        `你的任务：把它拆分成一条条「原子化记忆」，每条只讲一件事，方便后续按相关性和热度独立检索。`,
        "",
        `【大块记忆原文】`,
        sourceText,
        "",
        `【拆分规则（必须遵守）】`,
        `- 只拆分和重述原文中已有的事实，绝对禁止新增、推断或编造原文没有的信息`,
        `- 每条原子记忆：一个独立事实/事件/约定/偏好/情感节点，20-80 字，第三人称，陈述句`,
        `- 合并原文中的重复表述；时间线混乱的事实按语义归位`,
        `- 每条原子记忆必须附「逐字引用」：从上方原文中一字不差复制的 10-40 字片段，`,
        `  作为这条事实的证据（[引用: "..."] 紧跟在该条事实的 JSON 行内）`,
        `- 宁可少拆，绝不编造；拆不出来的一条都不要输出`,
        "",
        `只返回 JSON，不要任何解释，格式：`,
        `{"atoms":[{"content":"原子记忆事实","quote":"逐字复制的原文片段","importance":0.8}]}`,
    ].join("\n");

    const resp = await simpleLLMCall(
        apiConfig,
        [{ role: "user", content: prompt }],
        { temperature: 0.2, max_tokens: 2000, signal },
    );
    if (!resp.content || resp.wasTruncated) return null;

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
        const items = Array.isArray(obj.atoms) ? (obj.atoms as Array<Record<string, unknown>>) : [];
        if (items.length === 0) return null;

        const atoms: SplitAtom[] = [];
        for (const item of items.slice(0, MAX_SPLITS_PER_ENTRY)) {
            const rawContent = typeof item.content === "string" ? item.content.trim() : "";
            if (!rawContent) continue;
            let quote: string | null = typeof item.quote === "string" ? item.quote.trim() : "";
            // 保真层机械校验：引用必须逐字存在于源原文；兼容 LLM 把引用写进 content 的情况
            if (!quote || !verifyQuoteAgainstSource(quote, sourceText)) {
                const embedded = extractQuoteBlocks(rawContent);
                quote = embedded.quotes.find(q => verifyQuoteAgainstSource(q, sourceText)) ?? null;
            }
            if (!quote || !verifyQuoteAgainstSource(quote, sourceText)) {
                // 该条事实找不到逐字证据 → 视为不可靠，丢弃该条（宁可少，不可编）
                continue;
            }
            let importance = 0.5;
            if (typeof item.importance === "number" && Number.isFinite(item.importance)) {
                importance = Math.min(1, Math.max(0.1, item.importance));
            }
            const body = extractQuoteBlocks(rawContent).body || rawContent;
            atoms.push({
                content: body.slice(0, SPLIT_CONTENT_MAX),
                quote,
                importance,
            });
        }
        return atoms.length > 0 ? atoms : null;
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
 * 执行全量智能迁移（v2 双通道）：
 * 1) 收集所有角色的旧格式条目（无 heat），按长度分流
 * 2) 大块记忆（≥ SPLIT_THRESHOLD）→ 原子化拆分：LLM 拆成一条条原子事实，
 *    每条带逐字引用锚点，源条目归档（archived，可复活回滚）——「一大坨」不再原样注入
 * 3) 小块记忆 → 轻量通道：分批 LLM 补齐重要度+实体标签，重置热度
 * 4) LLM 不可用/失败 → 原样保留允许重试，绝不丢数据
 */
export async function migrateLegacyMemories(opts?: {
    signal?: AbortSignal;
    onProgress?: (done: number, total: number) => void;
    /** 调试用：限制只处理前 N 条 */
    limit?: number;
}): Promise<MigrationStats> {
    const stats: MigrationStats = { scanned: 0, migrated: 0, failed: 0, skipped: 0, splitEntries: 0, splitProduced: 0, splitFailed: 0 };
    const charIds = await getAllCharacterIdsWithMemories();
    const legacy: MemoryEntry[] = [];
    for (const charId of charIds) {
        // 归档/失效条目同样扫描：大块归档条目也可能需要拆分。
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

    // 按长度分流：大块进拆分通道，小块走轻量通道
    const splittable: MemoryEntry[] = [];
    const lightweight: MemoryEntry[] = [];
    for (const entry of legacy) {
        if (entry.content.length >= SPLIT_THRESHOLD) splittable.push(entry);
        else lightweight.push(entry);
    }

    // ── 通道一：原子化拆分（逐条处理，产物继承源条目时间线）──
    for (const entry of splittable) {
        if (opts?.signal?.aborted) break;
        try {
            const atoms = await splitLegacyEntryIntoAtoms(entry, opts?.signal);
            if (atoms && atoms.length > 0) {
                for (const atom of atoms) {
                    await saveMemoryEntry({
                        id: `mem_lt_split_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                        characterId: entry.characterId,
                        sourceApp: entry.sourceApp,
                        type: "long_term",
                        content: atom.content,
                        importance: atom.importance,
                        createdAt: entry.createdAt,
                        updatedAt: now,
                        heat: DEFAULT_INITIAL_HEAT,
                        heatUpdatedAt: now,
                        accessCount: 0,
                        quote: atom.quote,
                        quoteSource: `拆分自旧记忆（${entry.createdAt.slice(0, 10)}）`,
                        metadata: {
                            origin: "legacy_split",
                            splitFromId: entry.id,
                        },
                    });
                    stats.splitProduced += 1;
                }
                // 拆分成功 → 源条目归档（archived）：原文永存、可复活回滚
                await saveMemoryEntry({
                    ...entry,
                    status: "archived",
                    updatedAt: now,
                });
                stats.splitEntries += 1;
            } else {
                // 拆分失败（API 不可用/解析失败/零有效原子）→ 回退轻量通道，绝不丢数据
                stats.splitFailed += 1;
                lightweight.push(entry);
            }
        } catch {
            stats.splitFailed += 1;
            lightweight.push(entry);
        }
        done += 1;
        opts?.onProgress?.(done, legacy.length);
    }

    // ── 通道二：轻量迁移（分批评分，逻辑与 v1 一致）──
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
        }
        opts?.onProgress?.(done, legacy.length);
    }
    return stats;
}
