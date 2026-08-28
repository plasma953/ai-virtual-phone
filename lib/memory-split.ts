// lib/memory-split.ts
// 旧记忆原子化拆分 —— 预览/应用两段式（防失控）：
// previewLegacySplit 只生成不落库，用户在 UI 预览每条原子记忆；
// 不满意可 regenerate 重出，满意后 applyLegacySplit 才写库并归档源条目。
// 每条原子记忆强制附「逐字引用」证据锚点（保真层机械校验），只拆不编。
import type { MemoryEntry } from "./memory-types";
import { loadMemoryConfig } from "./memory-storage";
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { simpleLLMCall } from "./api-helpers";
import { generateEmbedding, resolveEmbeddingModel } from "./memory-embedding";
import { extractQuoteBlocks, verifyQuoteAgainstSource, normalizeForMatch } from "./memory-quote";
import { DEFAULT_INITIAL_HEAT } from "./memory-heat";

/** 拆分产物单条正文长度上限（截断防失控输出撑爆预算） */
const SPLIT_CONTENT_MAX = 300;
/** 单次拆分最多产出的原子记忆条数 */
const MAX_SPLITS_PER_ENTRY = 8;

export type SplitPreviewAtom = {
    content: string;
    /** 逐字引用锚点（已通过机械校验，确保逐字存在于源原文） */
    quote: string;
    importance: number;
    /** 拆分时同步生成的向量（向量 API 不可用时为空，入库后可由召回链路兜底） */
    embedding?: number[];
};

export type SplitPreview = {
    sourceEntry: MemoryEntry;
    atoms: SplitPreviewAtom[];
};

/**
 * 拆分场景的引用校验：沿用逐字机械校验；超短原文（规范化后 < 6 字）时，
 * 引用等于整条原文即视为有效——保证「任何记忆都能拆」，不因长度下限误杀。
 */
function verifySplitQuote(quote: string, sourceText: string): boolean {
    if (verifyQuoteAgainstSource(quote, sourceText)) return true;
    const s = normalizeForMatch(sourceText);
    if (s.length < 6) return normalizeForMatch(quote) === s;
    return false;
}

/** 拆分 LLM 调用与解析（内部共享：首生成与重新生成走同一逻辑） */
async function callSplitLLM(
    sourceText: string,
    signal?: AbortSignal,
): Promise<SplitPreviewAtom[] | null> {
    const apiConfig = resolveAuxiliaryApiConfig("memorySummaryApiConfigId");
    if (!apiConfig?.apiKey) return null;

    const prompt = [
        `你是记忆档案整理员。下面是一条记忆，它可能只包含一件事，也可能把多件事混在一起。`,
        `你的任务：把它拆分成一条条「原子化记忆」，每条只讲一件事，方便后续按相关性和热度独立检索。`,
        `如果它本来就只有一件事，输出 1 条即可；不要为了多拆而强行切割。`,
        "",
        `【记忆原文】`,
        sourceText,
        "",
        `【拆分规则（必须遵守）】`,
        `- 只拆分和重述原文中已有的事实，绝对禁止新增、推断或编造原文没有的信息`,
        `- 每条原子记忆：一个独立事实/事件/约定/偏好/情感节点，不超过 80 字，第三人称，陈述句`,
        `- 合并原文中的重复表述；时间线混乱的事实按语义归位`,
        `- 每条原子记忆必须附「逐字引用」：从上方原文中一字不差复制的片段（10-40 字；`,
        `  原文不足 10 字时直接整条复制），作为这条事实的证据（JSON 行内的 quote 字段）`,
        `- 每条原子记忆的 importance（0-1 小数）必须独立重新评估，不要保持统一：`,
        `  按该事实对两人关系的分量打分——核心承诺/关系里程碑/强烈情感节点给 0.7-1.0，`,
        `  普通偏好/日常事件给 0.2-0.5，琐碎细节给 0.1-0.3；不要照抄源记忆的重要性`,
        `- 宁可少拆，绝不编造；拆不出来的一条都不要输出`,
        "",
        `只返回 JSON，不要任何解释，格式：`,
        `{"atoms":[{"content":"原子记忆事实","quote":"逐字复制的原文片段","importance":0.9},{"content":"另一条事实","quote":"另一段逐字原文","importance":0.3}]}`,
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

        const atoms: SplitPreviewAtom[] = [];
        for (const item of items.slice(0, MAX_SPLITS_PER_ENTRY)) {
            const rawContent = typeof item.content === "string" ? item.content.trim() : "";
            if (!rawContent) continue;
            let quote = typeof item.quote === "string" ? item.quote.trim() : "";
            // 保真层机械校验：引用必须逐字存在于源原文；兼容 LLM 把引用写进 content 的情况
            if (!quote || !verifySplitQuote(quote, sourceText)) {
                const embedded = extractQuoteBlocks(rawContent);
                quote = embedded.quotes.find(q => verifySplitQuote(q, sourceText)) ?? "";
            }
            if (!quote || !verifySplitQuote(quote, sourceText)) {
                // 找不到逐字证据 → 视为不可靠，丢弃该条（宁可少，不可编）
                continue;
            }
            let importance = 0.5;
            if (typeof item.importance === "number" && Number.isFinite(item.importance)) {
                importance = Math.min(1, Math.max(0.1, item.importance));
            }
            const body = extractQuoteBlocks(rawContent).body || rawContent;
            atoms.push({ content: body.slice(0, SPLIT_CONTENT_MAX), quote, importance });
        }
        return atoms.length > 0 ? atoms : null;
    } catch {
        return null;
    }
}

/** 用向量 API 为原子记忆补齐 embedding（失败静默跳过，不阻塞预览） */
async function attachEmbeddings(atoms: SplitPreviewAtom[]): Promise<void> {
    const config = loadMemoryConfig();
    if (config.vectorRecallEnabled === false) return;
    const apiConfig = resolveAuxiliaryApiConfig("embeddingApiConfigId");
    if (!apiConfig || !resolveEmbeddingModel(apiConfig)) return;
    for (const atom of atoms) {
        try {
            const emb = await generateEmbedding(atom.content, apiConfig);
            if (emb) atom.embedding = emb;
        } catch { /* 单条失败不影响整体 */ }
    }
}

/**
 * 预览拆分：只生成不落库。返回 null 表示失败（API 不可用/解析失败/零有效原子）。
 * UI 侧失败时提示原因并允许重试。
 */
export async function previewLegacySplit(
    entry: MemoryEntry,
    signal?: AbortSignal,
): Promise<SplitPreview | null> {
    const atoms = await callSplitLLM(entry.content.trim(), signal);
    if (!atoms || atoms.length === 0) return null;
    await attachEmbeddings(atoms);
    return { sourceEntry: entry, atoms };
}

/**
 * 应用拆分：原子记忆写库（heat=0.7，继承源时间线与来源），源条目归档
 * （archived，原文永存、可复活回滚）。由用户在预览确认后调用。
 */
export async function applyLegacySplit(preview: SplitPreview): Promise<void> {
    const now = new Date().toISOString();
    const { sourceEntry, atoms } = preview;
    for (const atom of atoms) {
        await saveAtomEntry(sourceEntry, atom, now);
    }
    await saveAtomArchivedSource(sourceEntry, now);
}

async function saveAtomEntry(source: MemoryEntry, atom: SplitPreviewAtom, now: string): Promise<void> {
    const { saveMemoryEntry } = await import("./memory-storage");
    await saveMemoryEntry({
        id: `mem_lt_split_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        characterId: source.characterId,
        sourceApp: source.sourceApp,
        // 继承源类型：长期记忆拆出长期记忆，核心记忆拆出核心记忆（不降级）
        type: source.type,
        content: atom.content,
        importance: atom.importance,
        createdAt: source.createdAt,
        updatedAt: now,
        heat: DEFAULT_INITIAL_HEAT,
        heatUpdatedAt: now,
        accessCount: 0,
        embedding: atom.embedding,
        quote: atom.quote,
        quoteSource: `拆分自旧记忆（${source.createdAt.slice(0, 10)}）`,
        metadata: {
            origin: "legacy_split",
            splitFromId: source.id,
        },
    });
}

async function saveAtomArchivedSource(source: MemoryEntry, now: string): Promise<void> {
    const { saveMemoryEntry } = await import("./memory-storage");
    await saveMemoryEntry({ ...source, status: "archived", updatedAt: now });
}