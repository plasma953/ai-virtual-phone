// lib/palace-engine.ts
// 记忆宫殿 v3 —— 核心引擎
// 取代旧版「短期事件 → 总结成长期记忆」管线。新流程：
//
//   每轮对话 → 事件计数（chat-engine 现有机制，+2/轮）
//   计数达到 X（设置页"自动记忆触发间隔"）→ runPalaceExtraction：
//     1. 读原生时间线（聊天/朋友圈/剧情/游戏……全部来源）
//     2. LLM 提取原子记忆节点（分房间/重要度/情绪/标签/实体/逐字引用）
//     3. 机械保真校验（引用必须逐字存在于事件原文，非法丢弃）
//     4. 去重（余弦>0.9 或 2-gram 重叠>0.8 跳过）
//     5. 批量向量化（嵌入 API 可用时）+ 自动链接（时间链/情绪链）
//     6. 门牌整理 + 认知消化（一次 LLM 调用：四块门牌全量合并 + worry/aspire 裁决）
//     7. 推进水位线 + 重置计数
import type { MemoryRoom, MemoryNode, MemoryLink, PlateRoom, DigestReport, DigestResult } from "./palace-types";
import { ROOM_CONFIGS, ALL_ROOMS, PLATE_ROOMS, PLATE_META } from "./palace-types";
import {
    bulkPutPalaceNodes,
    loadPalaceNodes,
    savePalaceLink,
    loadDigestReports,
    saveDigestReport,
} from "./palace-storage";
import {
    loadMemoryConfig,
    getEventCounter,
    resetEventCounter,
    getLastSummarizedTimestamp,
    setLastSummarizedTimestamp,
} from "./memory-storage";
import { loadNativeTimeline, formatTimelineForSummarization, filterTimelineByAllowedSources } from "./short-term-assembler";
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { generateEmbedding, resolveEmbeddingModel, cosineSimilarity } from "./memory-embedding";
import { simpleLLMCall } from "./api-helpers";
import { verifyQuoteAgainstSource } from "./memory-quote";
import { calculatePalaceEffectiveImportance } from "./palace-search";
import { palaceTokenize } from "./palace-bm25";
import { mergePalacePlateEntries } from "./palace-plates";
import { savePalacePlate, deletePalacePlate, loadPalacePlates } from "./palace-storage";
import type { PlateEntry } from "./palace-types";
import { kvGet, kvSet } from "./kv-db";

/** 按角色防并发 */
const runningSet = new Set<string>();
const DIGEST_WATERMARK_KEY = "palace_last_digest_";

// ─── LLM 输出解析 ─────────────────────────────────────
function extractJsonArray(raw: string): unknown[] | null {
    if (!raw) return null;
    const cleaned = raw.replace(/```(?:json)?/gi, "").trim();
    try {
        const parsed = JSON.parse(cleaned);
        if (Array.isArray(parsed)) return parsed;
    } catch { /* fallthrough */ }
    const m = cleaned.match(/\[[\s\S]*\]/);
    if (m) {
        try {
            const parsed = JSON.parse(m[0]);
            if (Array.isArray(parsed)) return parsed;
        } catch { /* fallthrough */ }
    }
    return null;
}

function extractJsonObject(raw: string): Record<string, unknown> | null {
    if (!raw) return null;
    const cleaned = raw.replace(/```(?:json)?/gi, "").trim();
    try {
        const parsed = JSON.parse(cleaned);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch { /* fallthrough */ }
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) {
        try {
            const parsed = JSON.parse(m[0]);
            if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
        } catch { /* fallthrough */ }
    }
    return null;
}

function clampImportance(v: unknown): number {
    const n = typeof v === "number" ? v : parseFloat(String(v));
    if (!Number.isFinite(n)) return 5;
    return Math.min(10, Math.max(1, Math.round(n)));
}

function sanitizeRoom(v: unknown): MemoryRoom | null {
    const s = String(v ?? "").trim();
    return (ALL_ROOMS as string[]).includes(s) ? (s as MemoryRoom) : null;
}

function sanitizeTags(v: unknown): string[] {
    if (!Array.isArray(v)) return [];
    return v.map(t => String(t).trim()).filter(Boolean).slice(0, 5);
}

function sanitizeEntities(v: unknown): string[] {
    if (!Array.isArray(v)) return [];
    return v.map(e => String(e).trim()).filter(Boolean).slice(0, 8);
}

function generateNodeId(): string {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return `palace_${crypto.randomUUID().replace(/-/g, "").slice(0, 18)}`;
    }
    return `palace_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function generateLinkId(): string {
    return `link_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// ─── 去重 ─────────────────────────────────────────────
function bigramOverlap(a: string, b: string): number {
    const ta = new Set(palaceTokenize(a));
    const tb = new Set(palaceTokenize(b));
    if (ta.size === 0 || tb.size === 0) return 0;
    let hit = 0;
    for (const t of ta) if (tb.has(t)) hit++;
    return hit / Math.min(ta.size, tb.size);
}

// ─── 提取 Prompt ──────────────────────────────────────
function buildExtractionPrompt(characterName: string, userName: string, eventsText: string, earliest: string, latest: string, count: number): string {
    return `你是记忆档案员。下面是角色「${characterName}」与用户「${userName}」近期的原生事件时间线（${earliest} ~ ${latest}，共 ${count} 条）。

【任务】把它们整理成一条条独立的情景记忆节点，存入记忆宫殿的对应房间。

【房间定义】
- living_room 客厅：日常闲聊、近期互动琐事
- bedroom 卧室：亲密情感、羁绊、深谈
- study 书房：工作、学习、技能、项目
- user_room 用户房：用户的个人信息、习惯、偏好、重大个人事实
- self_room 自我房：${characterName}的自我认知、态度、成长
- attic 阁楼：未解决的困惑、悬而未决的事
- windowsill 窗台：许下的愿望、约定、目标、期盼

【规则】
1. 一条记忆只讲一件事；具体、自包含、第三人称叙事
2. 重要度 1-10：日常琐事 1-3，有信息量 4-6，情感节点/重要事实 7-8，承诺/里程碑/冲突 9-10
3. mood 从 happy/sad/angry/anxious/tender/calm/excited/lonely/grateful/confused/proud/neutral 中选一个
4. tags 2-5 个关键词；entities 只列明确出现的专名（人名/地名/项目名），没有就空数组
5. 每条附 quote：从原文逐字复制的 10-40 字事实性片段（一字不差，不得改写）；找不到合适片段就输出空字符串
6. 原文里已有的事不要合并成大块；没有信息量的寒暄直接跳过
7. 只输出 JSON 数组，不要输出任何其他内容：
[{"content":"...","room":"living_room","importance":5,"mood":"happy","tags":["关键词"],"entities":["专名"],"quote":"逐字片段"}]

【事件时间线】
${eventsText}`;
}

// ─── 提取管线 ─────────────────────────────────────────
export async function maybeRunPalaceMemory(characterId: string, characterName: string): Promise<void> {
    const config = loadMemoryConfig();
    if (config.autoSummarizeEnabled === false) return;
    const counter = getEventCounter(characterId);
    if (counter < (config.summarizationEventInterval ?? 50)) return;
    if (runningSet.has(characterId)) return;
    runningSet.add(characterId);
    try {
        await runPalaceExtraction(characterId, characterName);
    } finally {
        runningSet.delete(characterId);
    }
}

export async function runPalaceExtraction(
    characterId: string,
    characterName: string,
    options?: { force?: boolean; sinceTimestamp?: string },
): Promise<{ success: boolean; error?: string; extracted?: number; skipped?: number }> {
    const config = loadMemoryConfig();
    const apiConfig = resolveAuxiliaryApiConfig("memorySummaryApiConfigId");
    if (!apiConfig) {
        return { success: false, error: "未配置记忆总结 API（请在绑定配置 → 辅助API绑定中设置）" };
    }
    const afterTimestamp = options?.force
        ? undefined
        : options?.sinceTimestamp ?? (getLastSummarizedTimestamp(characterId) ?? undefined);
    const allEntries = filterTimelineByAllowedSources(
        loadNativeTimeline(characterId, afterTimestamp ? { afterTimestamp } : undefined),
        config.shortTermAllowedSources,
    );
    if (allEntries.length < 4) {
        if (!options?.force) resetEventCounter(characterId);
        return { success: false, error: allEntries.length === 0 ? "没有可记忆的事件" : "事件不足 4 条" };
    }
    const formatted = formatTimelineForSummarization(allEntries);
    if (!formatted) return { success: false, error: "格式化事件数据失败" };
    const { eventsText, earliest, latest, count } = formatted;

    const userName = "用户";
    const prompt = buildExtractionPrompt(characterName, userName, eventsText, earliest, latest, count);
    let result = await simpleLLMCall(apiConfig, [{ role: "user", content: prompt }], { temperature: 0.3 });
    if (!result.content) return { success: false, error: result.error || "LLM 返回了空内容" };
    if (result.wasTruncated) {
        return { success: false, error: "记忆提取结果疑似被截断，已取消入库，请稍后重试" };
    }
    let items = extractJsonArray(result.content);
    if (!items) {
        // 带纠错说明重试一次
        const retry = await simpleLLMCall(
            apiConfig,
            [{ role: "user", content: prompt + "\n\n【格式纠错】上一次输出不是合法 JSON 数组。请只输出 JSON 数组，不要任何其他文字。" }],
            { temperature: 0.2 },
        );
        if (retry.content) items = extractJsonArray(retry.content);
    }
    if (!items || items.length === 0) {
        return { success: false, error: "LLM 未产出有效记忆节点（JSON 解析失败）" };
    }

    // ── 构建节点 + 保真机械校验 ──
    const now = Date.now();
    const sourceSessionIds = Array.from(new Set(allEntries.map(e => e.sessionId).filter((s): s is string => Boolean(s))));
    const dominantSource = (() => {
        const counts = new Map<string, number>();
        for (const e of allEntries) counts.set(e.sourceApp, (counts.get(e.sourceApp) || 0) + 1);
        let best = "chat", max = 0;
        for (const [s, c] of counts) if (c > max) { best = s; max = c; }
        return best;
    })();

    const existingNodes = await loadPalaceNodes(characterId);
    const embeddedExisting = existingNodes.filter(n => n.embedding && n.embedding.length > 0);

    const newNodes: MemoryNode[] = [];
    let skipped = 0;
    for (const raw of items) {
        if (!raw || typeof raw !== "object") continue;
        const obj = raw as Record<string, unknown>;
        const content = String(obj.content ?? "").trim();
        if (!content || content.length < 4) { skipped++; continue; }
        const room = sanitizeRoom(obj.room) ?? "living_room";
        const importance = clampImportance(obj.importance);
        const quoteRaw = String(obj.quote ?? "").trim();
        // 保真机械校验：引用必须逐字存在于事件原文；非法 → 丢弃引用（节点保留，不编造）
        const quote = quoteRaw && verifyQuoteAgainstSource(quoteRaw, eventsText) ? quoteRaw : "";
        if (quoteRaw && !quote) console.warn(`[PalaceEngine] 非法引用已剥离: "${quoteRaw.slice(0, 30)}"`);

        // 去重 1：语义（余弦 > 0.9）
        const embedding = obj.__embedding as number[] | undefined; // 稍后批量填充，先占位
        void embedding;
        // 去重 2：字面（2-gram 重叠 > 0.8）
        const dup = newNodes.some(n => bigramOverlap(n.content, content) > 0.8)
            || (embeddedExisting.length > 0 && embeddedExisting.some(n => bigramOverlap(n.content, content) > 0.8));
        if (dup) { skipped++; continue; }

        newNodes.push({
            id: generateNodeId(),
            characterId,
            content,
            room,
            tags: sanitizeTags(obj.tags),
            entities: sanitizeEntities(obj.entities).map(name => ({ name })),
            importance,
            mood: String(obj.mood ?? "neutral").trim() || "neutral",
            embedded: false,
            embedding: undefined,
            createdAt: now,
            lastAccessedAt: now,
            accessCount: 0,
            pinnedUntil: null,
            sourceId: null,
            origin: "extraction",
            digestedAt: null,
            status: "active",
            quote: quote || undefined,
            quoteSource: quote ? `${earliest} ~ ${latest}（${count}条事件）` : undefined,
            eventBoxId: null,
            isBoxSummary: false,
        });
        void dominantSource; void sourceSessionIds;
    }
    if (newNodes.length === 0) {
        setLastSummarizedTimestamp(characterId, latest);
        resetEventCounter(characterId);
        return { success: false, error: "全部候选记忆被去重或过滤" };
    }

    // ── 批量向量化（嵌入 API 可用时）──
    const embeddingApiConfig = config.vectorRecallEnabled !== false ? resolveAuxiliaryApiConfig("embeddingApiConfigId") : null;
    if (embeddingApiConfig && resolveEmbeddingModel(embeddingApiConfig)) {
        const BATCH = 20;
        for (let i = 0; i < newNodes.length; i += BATCH) {
            const batch = newNodes.slice(i, i + BATCH);
            try {
                const embs = await Promise.all(batch.map(n =>
                    generateEmbedding(n.content, embeddingApiConfig).catch(() => null)
                ));
                for (let j = 0; j < batch.length; j++) {
                    if (embs[j] && embs[j]!.length > 0) {
                        batch[j].embedding = embs[j]!;
                        batch[j].embedded = true;
                    }
                }
            } catch { /* 单批失败不阻塞 */ }
        }
    }

    // ── 语义去重（有向量时，余弦 > 0.9 跳过）──
    const finalNodes: MemoryNode[] = [];
    const keptEmbeddings = [...embeddedExisting.map(n => n.embedding!), ...newNodes.filter(n => n.embedding).map(n => n.embedding!)];
    for (const node of newNodes) {
        if (node.embedding) {
            const simDup = keptEmbeddings.some(e => cosineSimilarity(node.embedding!, e) > 0.9);
            if (simDup) { skipped++; continue; }
        }
        finalNodes.push(node);
        keptEmbeddings.push(node.embedding ?? []);
    }
    if (finalNodes.length === 0) {
        setLastSummarizedTimestamp(characterId, latest);
        resetEventCounter(characterId);
        return { success: false, error: "全部候选记忆与已有记忆语义重复" };
    }

    // ── 自动链接：时间链（近 24h 节点）+ 情绪链（同 mood）──
    const newLinks: MemoryLink[] = [];
    for (const node of finalNodes) {
        const recent = [...existingNodes, ...finalNodes]
            .filter(n => n.id !== node.id && Math.abs(n.createdAt - node.createdAt) <= 24 * 3600 * 1000)
            .sort((a, b) => Math.abs(a.createdAt - node.createdAt) - Math.abs(b.createdAt - node.createdAt))
            .slice(0, 3);
        for (const r of recent) {
            newLinks.push({
                id: generateLinkId(), characterId, fromId: node.id, toId: r.id,
                type: "time", strength: 0.4, createdAt: now,
            });
        }
        const sameMood = [...existingNodes, ...finalNodes]
            .filter(n => n.id !== node.id && n.mood && n.mood === node.mood)
            .slice(0, 2);
        for (const r of sameMood) {
            newLinks.push({
                id: generateLinkId(), characterId, fromId: node.id, toId: r.id,
                type: "emotion", strength: 0.35, createdAt: now,
            });
        }
    }

    await bulkPutPalaceNodes(finalNodes);
    for (const l of newLinks) await savePalaceLink(l);
    console.log(`[PalaceEngine] 提取完成：${finalNodes.length} 节点（跳过 ${skipped}），${newLinks.length} 链接`);

    // ── 门牌整理 + 认知消化（独立 LLM 调用，失败不阻塞提取主流程）──
    await consolidatePlatesAndDigest(characterId, characterName).catch(err => {
        console.warn("[PalaceEngine] 门牌/消化整理失败:", err);
    });

    // ── 房间容量淘汰（活跃节点超容的房间按有效重要度归档最弱者）──
    await enforceRoomCapacities(characterId).catch(err => {
        console.warn("[PalaceEngine] 容量淘汰失败:", err);
    });

    // ── 水位线 + 计数 ──
    setLastSummarizedTimestamp(characterId, latest);
    resetEventCounter(characterId);
    return { success: true, extracted: finalNodes.length, skipped };
}

// ─── 门牌整理 + 认知消化（一次 LLM 调用）───────────────
function buildConsolidationPrompt(
    characterName: string,
    plates: PlateEntry[],
    materialNodes: MemoryNode[],
): string {
    const plateLines: string[] = [];
    const prefixMap: Record<PlateRoom, string> = { user_room: "U", self_room: "S", bedroom: "B", study: "D" };
    for (const room of PLATE_ROOMS) {
        const entries = plates.filter(p => p.plateRoom === room);
        const label = PLATE_META[room].title;
        if (entries.length === 0) {
            plateLines.push(`【${label}】（空）`);
        } else {
            plateLines.push(`【${label}】\n${entries.map((e, i) => `${prefixMap[room]}${i}: ${e.content}`).join("\n")}`);
        }
    }
    const materialLines = materialNodes
        .map((n, i) => `n${i}: (${n.room}, 重要度${n.importance}) ${n.content}`)
        .join("\n");
    const nodeIdMap = materialNodes.map((n, i) => `n${i}`).join(",");
    return `你是「${characterName}」的记忆管家。基于近期的记忆节点，完成两件事。

【现有门牌——已沉淀的稳定认知】
${plateLines.join("\n")}

【近期记忆节点】
${materialLines}

【任务一：门牌整理】
四块门牌是每轮对话都会常驻注入的"底色认知"——从情景记忆里沉淀出的稳定事实，不是话题。
- user_room「${PLATE_META.user_room.title}」（上限${PLATE_META.user_room.cap}）：只收必须写进角色卡的内容——基础信息/家庭结构/重要他人/人格冲击级重大节点；阶段性状态与情绪分析不收
- self_room「${PLATE_META.self_room.title}」（上限${PLATE_META.self_room.cap}）：对自己稳定、跨时间成立的认知
- bedroom「${PLATE_META.bedroom.title}」（上限${PLATE_META.bedroom.cap}）：关系的质地。硬规则：禁止给关系命名（不要出现"我们是恋人/朋友/家人"这类句子），只描述现象与质地
- study「${PLATE_META.study.title}」（上限${PLATE_META.study.cap}）：会什么、在学什么
规则：输出每块门牌的完整新列表；沿用旧条目时用 basedOn 标注旧标签（如 "basedOn":"U0"）并可改写措辞；过时/边界判错的旧条目不写即被淘汰；新认知直接加条目。单条 ≤60 字。

【任务二：认知消化】
回顾上面的记忆节点，给出裁决：
- worries：值得挂心的未决之事（≤2条）——困惑、悬念、没解决的问题 → 会存入阁楼，等待日后解决或淡化
- aspirations：许下的愿望/约定/目标（≤2条）→ 会存入窗台
- 没有就输出空数组；绝大多数经历只是经历，不必强行产出

只输出 JSON（不要其他内容）：
{"plates":{"user_room":[{"content":"...","basedOn":"U0"}],"self_room":[...],"bedroom":[...],"study":[...]},"digest":{"worries":[{"content":"...","sourceId":"n3","importance":6}],"aspirations":[{"content":"...","sourceId":"n5","importance":5}]}}
（节点编号取自上面材料：${nodeIdMap}）`;
}

export async function consolidatePlatesAndDigest(characterId: string, characterName: string): Promise<{ plateUpdated: boolean; digestNodes: number }> {
    const apiConfig = resolveAuxiliaryApiConfig("memorySummaryApiConfigId");
    if (!apiConfig) return { plateUpdated: false, digestNodes: 0 };

    // 材料：上次消化以来的节点（≤30 条，时间正序）；无水位线则取最近 20 条
    const allNodes = await loadPalaceNodes(characterId);
    const active = allNodes.filter(n => n.status !== "archived" && n.status !== "superseded");
    const lastDigestMs = Number(kvGet(`${DIGEST_WATERMARK_KEY}${characterId}`) || 0);
    let material = active
        .filter(n => !n.digestedAt && n.createdAt > (lastDigestMs || 0))
        .sort((a, b) => a.createdAt - b.createdAt);
    if (material.length === 0 && !lastDigestMs) {
        material = active.sort((a, b) => a.createdAt - b.createdAt).slice(-20);
    }
    if (material.length === 0) return { plateUpdated: false, digestNodes: 0 };
    if (material.length > 30) material = material.slice(-30);

    const plates = await loadPalacePlates(characterId);
    const prompt = buildConsolidationPrompt(characterName, plates, material);

    let result = await simpleLLMCall(apiConfig, [{ role: "user", content: prompt }], { temperature: 0.3 });
    if (!result.content) return { plateUpdated: false, digestNodes: 0 };
    let parsed = extractJsonObject(result.content);
    if (!parsed) {
        const retry = await simpleLLMCall(
            apiConfig,
            [{ role: "user", content: prompt + "\n\n【格式纠错】上一次输出不是合法 JSON。请只输出 JSON 对象。" }],
            { temperature: 0.2 },
        );
        if (retry.content) parsed = extractJsonObject(retry.content);
    }
    if (!parsed) {
        console.warn("[PalaceEngine] 门牌/消化 JSON 解析失败，本轮跳过（材料保留待下次）");
        return { plateUpdated: false, digestNodes: 0 };
    }

    const now = Date.now();
    const nodeIdByIdx = new Map<string, MemoryNode>();
    material.forEach((n, i) => nodeIdByIdx.set(`n${i}`, n));

    // ── 门牌合并（basedOn 标签语义；卧室命名栅栏在 merge 内）──
    let plateUpdated = false;
    const platesObj = (parsed.plates && typeof parsed.plates === "object") ? parsed.plates as Record<string, unknown> : null;
    if (platesObj) {
        for (const room of PLATE_ROOMS) {
            const rawItems = platesObj[room];
            if (!Array.isArray(rawItems)) continue; // 该房间未提及 → 保守不动
            const existing = plates.filter(p => p.plateRoom === room);
            const items = rawItems
                .filter(it => it && typeof it === "object")
                .map((it: Record<string, unknown>) => ({
                    content: String(it.content ?? "").trim(),
                    basedOn: it.basedOn ? String(it.basedOn).trim() : null,
                }))
                .filter(it => it.content);
            if (items.length === 0) continue; // 空列表 → 区分"决定清空"与"忘了"，保守不动
            const merged = mergePalacePlateEntries(room, existing, items, now);
            const mergedIds = new Set(merged.map(m => m.id));
            for (const e of merged) await savePalacePlate(e);
            for (const old of existing) {
                if (!mergedIds.has(old.id)) await deletePalacePlate(old.id);
            }
            plateUpdated = true;
        }
    }

    // ── 消化产物：worry → 阁楼；aspire → 窗台 ──
    const digestObj = (parsed.digest && typeof parsed.digest === "object") ? parsed.digest as Record<string, unknown> : null;
    const digestNodes: MemoryNode[] = [];
    const reviewedIds: string[] = [];
    let keptCount = 0;
    const worries: DigestResult["worries"] = [];
    const aspirations: DigestResult["aspirations"] = [];

    if (digestObj) {
        const buildDigestNode = (raw: unknown, room: MemoryRoom): MemoryNode | null => {
            if (!raw || typeof raw !== "object") return null;
            const obj = raw as Record<string, unknown>;
            const content = String(obj.content ?? "").trim();
            if (!content) return null;
            const srcRaw = String(obj.sourceId ?? "").trim();
            const src = nodeIdByIdx.get(srcRaw);
            return {
                id: generateNodeId(),
                characterId,
                content: content.slice(0, 200),
                room,
                tags: [],
                importance: clampImportance(obj.importance) || 6,
                mood: "neutral",
                embedded: false,
                createdAt: now,
                lastAccessedAt: now,
                accessCount: 0,
                sourceId: src?.id ?? null,
                origin: "digestion",
                digestedAt: null,
                status: "active",
            };
        };
        if (Array.isArray(digestObj.worries)) {
            for (const w of digestObj.worries.slice(0, 2)) {
                const node = buildDigestNode(w, "attic");
                if (node) {
                    digestNodes.push(node);
                    const obj = w as Record<string, unknown>;
                    worries.push({ content: node.content, room: "attic", importance: node.importance, mood: "neutral", sourceId: node.sourceId ?? "" });
                    void obj;
                }
            }
        }
        if (Array.isArray(digestObj.aspirations)) {
            for (const a of digestObj.aspirations.slice(0, 2)) {
                const node = buildDigestNode(a, "windowsill");
                if (node) {
                    digestNodes.push(node);
                    aspirations.push({ content: node.content, room: "windowsill", importance: node.importance, mood: "neutral", sourceId: node.sourceId ?? "" });
                }
            }
        }
    }

    if (digestNodes.length > 0) await bulkPutPalaceNodes(digestNodes);

    // 被消费的源节点打 digestedAt（退出后续消化候选池）；kept 计数
    for (const n of material) {
        reviewedIds.push(n.id);
        if (!digestNodes.some(d => d.sourceId === n.id)) keptCount++;
    }
    await bulkPutPalaceNodes(material.map(n => ({ ...n, digestedAt: now })));

    // ── 消化报告 ──
    const report: DigestReport = {
        id: `digest_${now}`,
        characterId,
        result: {
            reviewedIds,
            worries,
            aspirations,
            distillations: [],
            keptCount,
            plateUpdates: plateUpdated ? { user_room: 1 } : {},
            timestamp: now,
        },
        timestamp: now,
    };
    await saveDigestReport(report);
    const reports = await loadDigestReports(characterId, 30);
    kvSet(`${DIGEST_WATERMARK_KEY}${characterId}`, String(now));
    void reports;
    console.log(`[PalaceEngine] 整理完成：门牌${plateUpdated ? "已更新" : "未动"}，消化产物 ${digestNodes.length} 条`);
    return { plateUpdated, digestNodes: digestNodes.length };
}

// ─── 客厅容量淘汰（提取后调用）───────────────────────
export async function enforceRoomCapacities(characterId: string): Promise<number> {
    let evicted = 0;
    for (const room of ALL_ROOMS) {
        const cfg = ROOM_CONFIGS[room];
        if (cfg.capacity === null) continue;
        const nodes = (await loadPalaceNodes(characterId))
            .filter(n => n.room === room && n.status === "active")
            .sort((a, b) => {
                // 有效重要性低者先淘汰（importance × 衰减）
                const ea = calculatePalaceEffectiveImportance(a);
                const eb = calculatePalaceEffectiveImportance(b);
                return ea - eb;
            });
        const excess = nodes.length - cfg.capacity;
        if (excess > 0) {
            const toArchive = nodes.slice(0, excess);
            await bulkPutPalaceNodes(toArchive.map(n => ({ ...n, status: "archived" as const })));
            evicted += toArchive.length;
        }
    }
    return evicted;
}
