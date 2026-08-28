// lib/memory-conflict.ts
// Paramecium 式矛盾失效标记（保真层 #1）：
// 新总结入库后，与已有活跃长期记忆做一次独立 LLM 比对，
// 高置信度矛盾（新信息明确推翻旧记忆）→ 旧条目标 superseded（退出召回、可复活）。
// 失败不阻塞总结主流程（fire-and-forget 语义，由调用方 catch）。

import type { MemoryEntry } from "./memory-types";
import { loadMemoryConfig, loadMemoryEntriesByType, saveMemoryEntry } from "./memory-storage";
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { simpleLLMCall } from "./api-helpers";
import { isKiwiEngine } from "./memory-service";

/** 参与比对的旧记忆条数上限（按时间倒序取最近 N 条活跃长期记忆） */
const CANDIDATE_CAP = 15;
/** 单条记忆送入比对的截断长度（控制上下文） */
const CONTENT_CAP = 300;

/**
 * 矛盾失效检测：把新总结与最近活跃长期记忆交给 LLM 比对，
 * 返回被 superseded 的旧记忆条数。
 * 开关：conflictDetectionEnabled（默认开）；仅 kiwi 引擎生效；classic 保持原版行为。
 */
export async function detectAndSupersedeConflicts(
    characterId: string,
    newEntry: MemoryEntry,
    characterName: string,
): Promise<number> {
    const config = loadMemoryConfig();
    if (config.conflictDetectionEnabled === false) return 0;
    if (!isKiwiEngine(config)) return 0;

    const active = await loadMemoryEntriesByType(characterId, "long_term");
    const candidates = active
        .filter(e => e.id !== newEntry.id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, CANDIDATE_CAP);
    if (candidates.length === 0) return 0;

    const apiConfig = resolveAuxiliaryApiConfig("memorySummaryApiConfigId");
    if (!apiConfig?.apiKey) return 0;

    const candidateLines = candidates
        .map((e, i) => `[${i}] ${e.content.slice(0, CONTENT_CAP)}`)
        .join("\n");

    const prompt = [
        `你是记忆一致性校验助手。以下是角色「${characterName}」新生成的长期记忆总结：`,
        "",
        `新记忆：${newEntry.content.slice(0, 800)}`,
        "",
        "以下是该角色已有的旧记忆列表（编号从 0 开始）：",
        candidateLines,
        "",
        "任务：找出被新记忆【明确推翻】的旧记忆编号。",
        "判定标准（全部满足才列入）：",
        "1. 新旧记忆存在直接事实矛盾（如关系状态、已发生事件、明确承诺）；",
        "2. 新记忆明确来自更新的信息（旧记忆已过时）；",
        "3. 不确定、模糊、或只是补充信息的不要列入。",
        '只返回 JSON，不要任何解释：{"supersededIds":[0,3]}（没有则返回空数组）',
    ].join("\n");

    try {
        const resp = await simpleLLMCall(
            apiConfig,
            [{ role: "user", content: prompt }],
            { temperature: 0.2, max_tokens: 400 },
        );
        if (!resp.content) return 0;
        const cleaned = resp.content.trim()
            .replace(/^```json\s*/i, "")
            .replace(/^```\s*/i, "")
            .replace(/```\s*$/, "")
            .trim();
        const start = cleaned.indexOf("{");
        const end = cleaned.lastIndexOf("}");
        if (start < 0 || end <= start) return 0;
        const obj = JSON.parse(cleaned.slice(start, end + 1)) as { supersededIds?: unknown };
        const ids = Array.isArray(obj.supersededIds) ? obj.supersededIds : [];

        const nowIso = new Date().toISOString();
        let marked = 0;
        for (const rawId of ids) {
            const idx = Number(rawId);
            if (!Number.isInteger(idx) || idx < 0 || idx >= candidates.length) continue;
            const old = candidates[idx];
            if (old.status === "active" || !old.status) {
                await saveMemoryEntry({
                    ...old,
                    status: "superseded",
                    updatedAt: nowIso,
                });
                marked += 1;
            }
        }
        if (marked > 0) {
            console.log(`[MemoryConflict] Superseded ${marked} outdated memories for ${characterId}`);
        }
        return marked;
    } catch (err) {
        console.warn("[MemoryConflict] 矛盾检测失败（不阻塞主流程）:", err);
        return 0;
    }
}