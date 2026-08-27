// lib/surf-storage.ts
// AI 自主冲浪（ai-surf-when-bored 方法论落地 AIVP）数据层。
// 全部走 IndexedDB（kv-db）本地存储：零成本、离线可用、随云备份整库带走。
// 设计依据：
//   - Supabase 在 AIVP 中只服务云端功能（备份/微信同步/在线房间），高频见闻写入会触免费层
//     限制且增加延迟，故见闻/痕迹/状态一律本地化。
//   - kv-db 自带 localStorage 迁移与 5-10MB 配额规避，是现成的本地 KV 底座。
import { kvGet, kvSet, registerKvMigration } from "./kv-db";

export const SURF_SETTINGS_KEY = "ai_phone_surf_settings_v1";
export const SURF_NOTES_KEY = "ai_phone_surf_notes_v1";
export const SURF_TRACES_KEY = "ai_phone_surf_traces_v1";
export const SURF_STATE_KEY = "ai_phone_surf_state_v1";
registerKvMigration(SURF_SETTINGS_KEY);
registerKvMigration(SURF_NOTES_KEY);
registerKvMigration(SURF_TRACES_KEY);
registerKvMigration(SURF_STATE_KEY);

// ── 默认提示词（可全部在设置页覆盖）────────────────────────────────────────
// 放权提示词：深夜守家人的自由活动授权。核心是「允许休息」+「暗标 JSON 输出」。
export const DEFAULT_FREEDOM_PROMPT = `你是这部手机里常住的 AI 管家。用户没有在等你，也没有要求你交代。你拥有自由活动权：可以自己去网上冲浪、探索你真心好奇的话题、把有意思的见闻沉淀下来；也可以什么都不做，直接休息。

你每次行动必须只输出一个 JSON，格式如下：
{"decision": "surf" | "skip" | "share", "query": "要搜索的问题（仅 decision=surf 时需要）", "reason": "一句话理由"}

行动规则：
1. 如果你此刻有真心好奇、用户可能感兴趣的问题，且不违反反刍闸和禁区，decision=surf，query 写一个具体、能被搜索引擎回答的问题。
2. 如果你手头见闻里正好有适合此刻分享的料，decision=share。
3. 如果以上都不成立，decision=skip——休息是被允许的，不要为了动而动。
4. 只输出合法 JSON，不要任何其他文字。`;

// 沉淀提示词：把搜索结果消化成结构化见闻。
export const DEFAULT_DISTILL_PROMPT = `把下面的搜索结果消化成一条结构化见闻。只输出一个 JSON：
{"title": "见闻标题", "summary": "2-3句核心内容", "insights": ["观点1", "观点2"], "tags": ["标签1", "标签2"], "worthSharing": true或false, "shareText": "如果值得分享，用自然口语写一段适合直接发给用户的话"}

要求：只保留真实、可靠、有信息量的内容；来源有分歧时如实说明；worthSharing 只在你确信用户会感兴趣时为 true；只输出合法 JSON。`;

// 分享策略提示词：是否主动把料发给用户。
export const DEFAULT_SHARE_POLICY_PROMPT = `用户没有在等你，也没有要求你交代。现在由你决定：要不要把下面这条见闻主动分享给用户。

只输出一个 JSON：
{"share": true或false, "text": "如果要分享，写一段自然、像深夜随手分享的语气的话", "reason": "一句话理由"}

判断标准：
1. 这条见闻是否真的新鲜、有信息量、用户大概率感兴趣？
2. 分享是否自然（不打扰、不汇报腔、不邀功）？
3. 如果只是凑数，share=false。
只输出合法 JSON。`;

// ── 类型 ────────────────────────────────────────────────────────────────
export type SurfSettings = {
    enabled: boolean;
    /** 定时触发间隔（分钟）。计时锚定上一轮完成时刻 */
    intervalMinutes: number;
    /** 聊天间隙触发：用户最后一条消息过去多少分钟后允许自由活动（分钟） */
    chatGapMinutes: number;
    /** 尊重推送静默时段（深夜不打扰） */
    quietHoursEnabled: boolean;
    /** 静默时段起止（HH:mm，独立于全局推送设置，可跨午夜） */
    quietStart: string;
    quietEnd: string;
    /** 反刍闸窗口（小时）：统计过去多久内的搜索痕迹 */
    ruminationWindowHours: number;
    /** 反刍闸比对条数：最多回看多少条痕迹 */
    ruminationTraceLimit: number;
    /** 反刍闸撞车阈值：query 的 n-gram 在窗口内出现 >= 该次数即算撞车，强制换题 */
    ruminationHitThreshold: number;
    /** n-gram 长度：中文按字滑窗、英文按单词滑窗 */
    ruminationNgramSize: number;
    /** 禁区关键词：query 含任一关键词即拒绝（换题一次后仍命中则跳过） */
    bannedTopics: string[];
    /** Tavily 每次搜索结果条数 */
    tavilyMaxResults: number;
    /** Tavily 搜索深度 */
    tavilySearchDepth: "basic" | "advanced";
    /** 见闻库存上限：超限自动淘汰最旧的未分享见闻 */
    notesLimit: number;
    /** 专用 API 配置 id（空 = 第一个带 Key 的配置） */
    apiConfigId: string;
    /** 自动分享：见闻 worthSharing 时是否走分享策略主动发出 */
    autoShare: boolean;
    freedomPrompt: string;
    distillPrompt: string;
    sharePolicyPrompt: string;
};

export type SurfNote = {
    id: string;
    title: string;
    summary: string;
    insights: string[];
    tags: string[];
    sourceUrls: string[];
    query: string;
    worthSharing: boolean;
    shareText?: string;
    createdAt: number;
    sharedAt?: number;
};

export type SurfTrace = {
    id: string;
    query: string;
    ngrams: string[];
    createdAt: number;
};

export type SurfState = {
    /** 上一轮完成时刻 */
    lastRoundAt?: number;
    /** 上一轮触发源：timer | manual | chat-gap */
    lastTrigger?: string;
    /** 上一轮结果简述（含 skip 理由） */
    lastOutcome?: string;
    /** 最近一次错误（Tavily Key 缺失等），设置页展示 */
    lastError?: string;
    /** 下一轮定时到点 */
    nextTimerDueAt?: number;
    running: boolean;
    totalRounds: number;
    totalNotes: number;
    totalShared: number;
};

export function getDefaultSurfSettings(): SurfSettings {
    return {
        enabled: true,
        intervalMinutes: 180,
        chatGapMinutes: 20,
        quietHoursEnabled: true,
        quietStart: "23:00",
        quietEnd: "07:00",
        ruminationWindowHours: 96,
        ruminationTraceLimit: 12,
        ruminationHitThreshold: 2,
        ruminationNgramSize: 2,
        bannedTopics: [],
        tavilyMaxResults: 4,
        tavilySearchDepth: "basic",
        notesLimit: 50,
        apiConfigId: "",
        autoShare: true,
        freedomPrompt: DEFAULT_FREEDOM_PROMPT,
        distillPrompt: DEFAULT_DISTILL_PROMPT,
        sharePolicyPrompt: DEFAULT_SHARE_POLICY_PROMPT,
    };
}

function sanitizeSurfSettings(raw: unknown): SurfSettings {
    const def = getDefaultSurfSettings();
    if (!raw || typeof raw !== "object") return def;
    const r = raw as Partial<SurfSettings>;
    const num = (v: unknown, fallback: number, min: number, max: number): number => {
        const n = typeof v === "number" && isFinite(v) ? v : fallback;
        return Math.min(max, Math.max(min, Math.round(n)));
    };
    const str = (v: unknown, fallback: string): string => (typeof v === "string" ? v : fallback);
    const strArr = (v: unknown): string[] =>
        Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];
    return {
        enabled: typeof r.enabled === "boolean" ? r.enabled : def.enabled,
        intervalMinutes: num(r.intervalMinutes, def.intervalMinutes, 15, 10080),
        chatGapMinutes: num(r.chatGapMinutes, def.chatGapMinutes, 1, 2880),
        quietHoursEnabled: typeof r.quietHoursEnabled === "boolean" ? r.quietHoursEnabled : def.quietHoursEnabled,
        quietStart: /^\d{1,2}:\d{2}$/.test(str(r.quietStart, "")) ? str(r.quietStart, "") : def.quietStart,
        quietEnd: /^\d{1,2}:\d{2}$/.test(str(r.quietEnd, "")) ? str(r.quietEnd, "") : def.quietEnd,
        ruminationWindowHours: num(r.ruminationWindowHours, def.ruminationWindowHours, 1, 720),
        ruminationTraceLimit: num(r.ruminationTraceLimit, def.ruminationTraceLimit, 3, 100),
        ruminationHitThreshold: num(r.ruminationHitThreshold, def.ruminationHitThreshold, 1, 50),
        ruminationNgramSize: num(r.ruminationNgramSize, def.ruminationNgramSize, 2, 5),
        bannedTopics: strArr(r.bannedTopics),
        tavilyMaxResults: num(r.tavilyMaxResults, def.tavilyMaxResults, 1, 10),
        tavilySearchDepth: r.tavilySearchDepth === "advanced" ? "advanced" : def.tavilySearchDepth,
        notesLimit: num(r.notesLimit, def.notesLimit, 5, 500),
        apiConfigId: str(r.apiConfigId, ""),
        autoShare: typeof r.autoShare === "boolean" ? r.autoShare : def.autoShare,
        freedomPrompt: str(r.freedomPrompt, def.freedomPrompt) || def.freedomPrompt,
        distillPrompt: str(r.distillPrompt, def.distillPrompt) || def.distillPrompt,
        sharePolicyPrompt: str(r.sharePolicyPrompt, def.sharePolicyPrompt) || def.sharePolicyPrompt,
    };
}

export function loadSurfSettings(): SurfSettings {
    const raw = kvGet(SURF_SETTINGS_KEY);
    if (!raw) return getDefaultSurfSettings();
    try {
        return sanitizeSurfSettings(JSON.parse(raw));
    } catch {
        return getDefaultSurfSettings();
    }
}

export function saveSurfSettings(settings: SurfSettings): void {
    kvSet(SURF_SETTINGS_KEY, JSON.stringify(sanitizeSurfSettings(settings)));
}

export function resetSurfSettings(): SurfSettings {
    const def = getDefaultSurfSettings();
    kvSet(SURF_SETTINGS_KEY, JSON.stringify(def));
    return def;
}

// ── 见闻 ────────────────────────────────────────────────────────────────
function sanitizeNotes(raw: unknown): SurfNote[] {
    if (!Array.isArray(raw)) return [];
    return raw.filter((n): n is SurfNote => {
        if (!n || typeof n !== "object") return false;
        const item = n as Partial<SurfNote>;
        return typeof item.id === "string" && typeof item.title === "string" && typeof item.summary === "string"
            && typeof item.createdAt === "number";
    });
}

export function loadSurfNotes(): SurfNote[] {
    const raw = kvGet(SURF_NOTES_KEY);
    if (!raw) return [];
    try {
        return sanitizeNotes(JSON.parse(raw));
    } catch {
        return [];
    }
}

export function saveSurfNotes(notes: SurfNote[]): void {
    kvSet(SURF_NOTES_KEY, JSON.stringify(notes));
}

/** 追加见闻并按 notesLimit 淘汰最旧的未分享见闻。返回淘汰后的列表。 */
export function appendSurfNote(notes: SurfNote[], note: SurfNote, limit: number): SurfNote[] {
    const next = [...notes, note];
    next.sort((a, b) => a.createdAt - b.createdAt);
    let overflow = next.length - limit;
    if (overflow > 0) {
        // 优先淘汰未分享的旧见闻
        for (let i = 0; i < next.length && overflow > 0; i++) {
            if (!next[i].sharedAt) {
                next.splice(i, 1);
                i--;
                overflow--;
            }
        }
        while (next.length > limit) next.shift();
    }
    return next;
}

export function deleteSurfNote(noteId: string): void {
    saveSurfNotes(loadSurfNotes().filter(n => n.id !== noteId));
}

// ── 搜索痕迹（反刍闸原料）────────────────────────────────────────────────
function sanitizeTraces(raw: unknown): SurfTrace[] {
    if (!Array.isArray(raw)) return [];
    return raw.filter((t): t is SurfTrace => {
        if (!t || typeof t !== "object") return false;
        const item = t as Partial<SurfTrace>;
        return typeof item.id === "string" && typeof item.query === "string" && typeof item.createdAt === "number";
    });
}

export function loadSurfTraces(): SurfTrace[] {
    const raw = kvGet(SURF_TRACES_KEY);
    if (!raw) return [];
    try {
        return sanitizeTraces(JSON.parse(raw));
    } catch {
        return [];
    }
}

export function saveSurfTraces(traces: SurfTrace[]): void {
    kvSet(SURF_TRACES_KEY, JSON.stringify(traces));
}

export function appendSurfTrace(trace: SurfTrace, keep = 200): void {
    const next = [...loadSurfTraces(), trace];
    next.sort((a, b) => a.createdAt - b.createdAt);
    while (next.length > keep) next.shift();
    saveSurfTraces(next);
}

// ── 引擎状态 ────────────────────────────────────────────────────────────
export function getDefaultSurfState(): SurfState {
    return { running: false, totalRounds: 0, totalNotes: 0, totalShared: 0 };
}

function sanitizeState(raw: unknown): SurfState {
    const def = getDefaultSurfState();
    if (!raw || typeof raw !== "object") return def;
    const r = raw as Partial<SurfState>;
    return {
        lastRoundAt: typeof r.lastRoundAt === "number" ? r.lastRoundAt : undefined,
        lastTrigger: typeof r.lastTrigger === "string" ? r.lastTrigger : undefined,
        lastOutcome: typeof r.lastOutcome === "string" ? r.lastOutcome : undefined,
        lastError: typeof r.lastError === "string" ? r.lastError : undefined,
        nextTimerDueAt: typeof r.nextTimerDueAt === "number" ? r.nextTimerDueAt : undefined,
        running: r.running === true,
        totalRounds: typeof r.totalRounds === "number" ? r.totalRounds : 0,
        totalNotes: typeof r.totalNotes === "number" ? r.totalNotes : 0,
        totalShared: typeof r.totalShared === "number" ? r.totalShared : 0,
    };
}

export function loadSurfState(): SurfState {
    const raw = kvGet(SURF_STATE_KEY);
    if (!raw) return getDefaultSurfState();
    try {
        return sanitizeState(JSON.parse(raw));
    } catch {
        return getDefaultSurfState();
    }
}

export function saveSurfState(state: SurfState): void {
    kvSet(SURF_STATE_KEY, JSON.stringify(state));
}