// lib/memory-dream.ts
// Kiwi-style Dream consolidation: 睡眠式整合。
// 人脑在睡眠时会重放白天的记忆碎片，把零散片段整合成稳定的长期记忆。
// 这里模拟该机制：定期把「低热度（久未想起）」的碎片记忆提炼压缩成一条
// 高浓度总结记忆。Paramecium 保真层：原始碎片改为归档（archived）而非物理删除，
// 原文永存、可追溯、可复活；归档条目不参与召回/星图/再次整合。

import type { MemoryEntry } from "./memory-types";
import {
    loadMemoryConfig,
    loadMemoryEntriesByType,
    saveMemoryEntry,
    getLastDreamTimestamp,
    setLastDreamTimestamp,
} from "./memory-storage";
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { effectiveHeat, DEFAULT_INITIAL_HEAT } from "./memory-heat";
import { isKiwiEngine } from "./memory-service";
import { simpleLLMCall } from "./api-helpers";
import {
    extractQuoteBlocks,
    verifyQuotes,
    QUOTE_REQUIREMENT_SUFFIX,
    buildQuoteRetrySuffix,
} from "./memory-quote";

/** Per-character lock to prevent concurrent Dream consolidation. */
const dreamingSet = new Set<string>();

const DREAM_PROMPT_TEMPLATE = `你是一个记忆整合助手。以下是某角色过去一段时间里零散且久未被翻起的记忆碎片，请把它们整合成一段精炼、连贯的日志式总结。

碎片：
{{fragments}}

要求：
- 合并重复信息、保留独特事实（人名、承诺、事件、偏好、情感节点）
- 删除冗余和过时细节
- 120-250字，第三人称，不要格式标记

整合结果正文写完后，必须附上「逐字引用」区块（每行一条，格式如下）：
[引用: "从上方碎片中逐字复制的原文片段"]
引用要求：
- 每条引用必须一字不差地复制自上方「碎片」，不得改写、增删字、加省略号
- 每条引用 10-40 字，至少 1 条，最多 3 条
- 宁可少写，绝不编造

整合结果：`;

/**
 * 检查是否满足 Dream 条件并执行整合。
 * 条件：dreamEnabled && 距离上次 Dream >= dreamIntervalDays && 低热度碎片 >= dreamMinFragments。
 * 由记忆总结流水线触发（fire-and-forget，不阻塞主流程）。
 */
export async function maybeRunDreamConsolidation(
    characterId: string,
    characterName: string,
): Promise<void> {
    const config = loadMemoryConfig();
    if (!isKiwiEngine(config) || config.dreamEnabled === false) return;

    const before = getLastDreamTimestamp(characterId);
    const intervalMs = (config.dreamIntervalDays ?? 3) * 86_400_000;
    if (before) {
        const elapsed = Date.now() - new Date(before).getTime();
        if (!Number.isNaN(elapsed) && elapsed < intervalMs) return;
    }
    if (dreamingSet.has(characterId)) return;
    dreamingSet.add(characterId);
    try {
        await runDreamConsolidation(characterId, characterName);
    } finally {
        dreamingSet.delete(characterId);
    }
}

async function runDreamConsolidation(
    characterId: string,
    characterName: string,
): Promise<void> {
    const config = loadMemoryConfig();
    const allLongTerm = await loadMemoryEntriesByType(characterId, "long_term");
    if (allLongTerm.length < (config.dreamMinFragments ?? 5)) return;

    // 收集低热度碎片：久未被想起、且未被整合过的
    const now = Date.now();
    const halfLife = config.heatHalfLifeDays ?? 7;
    const coldThreshold = config.dreamColdHeatThreshold ?? 0.3;
    const coldFragments = allLongTerm
        .filter(entry => !entry.dreamCompacted)
        .map(entry => ({ entry, heat: effectiveHeat(entry, now, halfLife) }))
        .filter(item => item.heat < coldThreshold)
        .sort((a, b) => a.heat - b.heat);

    if (coldFragments.length < (config.dreamMinFragments ?? 5)) return;

    // 只整合最冷的一批，控制单次 LLM 输入规模（最多 12 条）
    const target = coldFragments.slice(0, 12);
    const apiConfig = resolveAuxiliaryApiConfig("memorySummaryApiConfigId");
    if (!apiConfig) return;

    const fragmentsText = target
        .map(item => `- [${item.entry.createdAt.slice(0, 10)}] ${item.entry.content}`)
        .join("\n");

    const prompt = DREAM_PROMPT_TEMPLATE
        .replace(/\{\{fragments\}\}/gi, fragmentsText);

    // 保真层：统一追加逐字引用要求（自定义模板不适用此处，模板已内置）
    const quotePrompt = prompt.includes("[引用") ? prompt : prompt + QUOTE_REQUIREMENT_SUFFIX;

    let result = await simpleLLMCall(
        apiConfig,
        [{ role: "user", content: quotePrompt }],
        { temperature: 0.3 },
    );
    if (!result.content || result.wasTruncated) return;

    // 保真层机械校验：每条引用必须逐字存在于碎片原文中
    let parsed = extractQuoteBlocks(result.content);
    let quoteCheck = verifyQuotes(parsed.quotes, fragmentsText);
    if (quoteCheck.invalid.length > 0) {
        // 折中策略：带纠错说明重试一次；仍失败则剥离非法引用、保留整合正文
        const retry = await simpleLLMCall(
            apiConfig,
            [{ role: "user", content: quotePrompt + buildQuoteRetrySuffix(quoteCheck.invalid) }],
            { temperature: 0.3 },
        );
        if (retry.content && !retry.wasTruncated) {
            parsed = extractQuoteBlocks(retry.content);
            quoteCheck = verifyQuotes(parsed.quotes, fragmentsText);
        }
    }
    if (quoteCheck.invalid.length > 0) {
        console.warn("[MemoryDream] 非法引用已剥离（无法在碎片原文中找到逐字匹配）:", quoteCheck.invalid);
    }

    const summary = (parsed.body || result.content.trim()).trim();
    if (!summary) return;

    const nowIso = new Date(now).toISOString();
    // 用最早的源碎片时间作为产物时间线，保持时间语义
    const earliestTs = target.map(t => t.entry.createdAt).sort()[0] ?? nowIso;

    // 取出现最多的 sourceApp 作为产物的来源
    const sourceCounts = new Map<string, number>();
    for (const t of target) {
        sourceCounts.set(t.entry.sourceApp, (sourceCounts.get(t.entry.sourceApp) || 0) + 1);
    }
    let dominantSource: MemoryEntry["sourceApp"] = "chat";
    let maxCount = 0;
    for (const [src, count] of sourceCounts) {
        if (count > maxCount) { dominantSource = src as MemoryEntry["sourceApp"]; maxCount = count; }
    }

    const dreamEntry: MemoryEntry = {
        id: `mem_dream_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        characterId,
        sourceApp: dominantSource,
        type: "long_term",
        content: summary,
        importance: 0.75,
        createdAt: earliestTs,
        updatedAt: nowIso,
        heat: DEFAULT_INITIAL_HEAT,
        heatUpdatedAt: nowIso,
        accessCount: 0,
        dreamCompacted: true,
        originIds: target.map(t => t.entry.id),
        quote: quoteCheck.valid[0],
        quoteSource: `${target[0].entry.createdAt.slice(0, 10)} 起冷碎片（共 ${target.length} 条）`,
        metadata: {
            dreamedFrom: target.length,
            timeSpan: `${target[0].entry.createdAt} ~ ${target[target.length - 1].entry.createdAt}`,
            characterName,
            quoteVerified: quoteCheck.invalid.length === 0,
            quoteCount: quoteCheck.valid.length,
        },
    };

    await saveMemoryEntry(dreamEntry);
    // Paramecium 保真层：Dream 不再物理删除源碎片，改为归档（archived）。
    // 归档条目不参与召回/星图/再次整合，但原文永存、可追溯、可复活。
    for (const t of target) {
        await saveMemoryEntry({
            ...t.entry,
            status: "archived",
            dreamCompacted: true,
            updatedAt: nowIso,
        });
    }
    setLastDreamTimestamp(characterId, nowIso);
    console.log(`[MemoryDream] Dream consolidated ${target.length} cold fragments → 1 entry（源碎片已归档，不删除）`);
}