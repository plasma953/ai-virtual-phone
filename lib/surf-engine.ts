// lib/surf-engine.ts
// AI 自主冲浪（ai-surf-when-bored 方法论落地 AIVP）核心逻辑引擎 + 全局后台服务。
//
// 设计原则：
//  - 「放权」：AI 在非交互时段自由决定 surf / share / skip，允许休息（skip 是合法动作）。
//  - 「反刍闸」：基于 n-gram 词频统计的防执念机制，杜绝单一话题死循环。
//  - 「分寸感」：静默时段（推送免打扰）只沉淀见闻，不主动打扰用户。
//  - 「一步到位」：所有 LLM 交互走 JSON 协议 + 容错解析，单轮失败自动降级为 skip。
//
// 依赖：bg-timer（Web Worker 定时器）、kv-db（IndexedDB）、
//       tool-storage 内置 Tavily（builtin_search）、llm-provider-adapter + llm-http（LLM 直连）。

import { bgSetInterval } from "./bg-timer";
import { isWithinPushQuietHours } from "./push-client";
import {
    loadSurfSettings,
    loadSurfNotes,
    appendSurfNote,
    saveSurfNotes,
    loadSurfTraces,
    appendSurfTrace,
    loadSurfState,
    saveSurfState,
    type SurfSettings,
    type SurfNote,
    type SurfTrace,
    type SurfState,
} from "./surf-storage";
import { loadRestTools } from "./tool-storage";
import { loadApiConfigs } from "./settings-storage";
import {
    buildProviderRequest,
    providerKindForConfig,
    parseProviderResponse,
    type LlmRequestMessage,
} from "./llm-provider-adapter";
import { fetchLlmPayload } from "./llm-http";
import { loadChatSessions, loadChatMessages, pushChatMessage, type ChatSession } from "./chat-storage";
import { dispatchChatMessageNotice } from "./chat-notification-events";

// ── n-gram 反刍闸 ────────────────────────────────────────────────────────────
// 中文按字滑窗、英文按单词滑窗、数字串整体成一个 token。

export function tokenizeQuery(q: string): string[] {
    const tokens: string[] = [];
    const re = /[\u4e00-\u9fff]|[a-zA-Z]+|\d+/g;
    const text = q.toLowerCase();
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) tokens.push(m[0]);
    return tokens;
}

export function nGramsFromTokens(tokens: string[], n: number): string[] {
    if (tokens.length === 0) return [];
    const size = Math.max(1, Math.round(n));
    if (tokens.length < size) return [tokens.join(" ")];
    const out: string[] = [];
    for (let i = 0; i + size <= tokens.length; i++) out.push(tokens.slice(i, i + size).join(" "));
    return out;
}

export function computeNgrams(q: string, n: number): string[] {
    return nGramsFromTokens(tokenizeQuery(q), n);
}

export function checkRuminationGate(
    query: string,
    settings: SurfSettings,
    traces: SurfTrace[],
): { blocked: boolean; hits: number } {
    const now = Date.now();
    const windowMs = settings.ruminationWindowHours * 3_600_000;
    const recent = traces
        .filter(t => t.createdAt >= now - windowMs)
        .slice(-settings.ruminationTraceLimit);
    const qNgrams = new Set(computeNgrams(query, settings.ruminationNgramSize));
    if (qNgrams.size === 0) return { blocked: false, hits: 0 };
    let hits = 0;
    for (const t of recent) {
        for (const g of t.ngrams) if (qNgrams.has(g)) hits++;
    }
    return { blocked: hits >= settings.ruminationHitThreshold, hits };
}

export function findBannedTopic(query: string, bannedTopics: string[]): string | null {
    const q = query.toLowerCase();
    for (const t of bannedTopics) {
        const k = t.trim().toLowerCase();
        if (k && q.includes(k)) return t.trim();
    }
    return null;
}

// ── 搜索：复用内置 Tavily（builtin_search）──────────────────────────────────

export function getSurfSearchTool(): { key: string; endpoint: string } | null {
    if (typeof window === "undefined") return null;
    try {
        const tools = loadRestTools();
        const search = tools.find(t => t.id === "builtin_search");
        if (!search) return null;
        const key = String((search.fixedParams || {})["api_key"] || "").trim();
        if (!key) return null;
        return { key, endpoint: search.endpoint || "https://api.tavily.com/search" };
    } catch {
        return null;
    }
}

export type TavilyResultItem = {
    title: string;
    url: string;
    content: string;
    score?: number;
};

export async function callTavilySearch(
    query: string,
    settings: SurfSettings,
    signal?: AbortSignal,
): Promise<TavilyResultItem[]> {
    const tool = getSurfSearchTool();
    if (!tool) throw new Error("未配置 Tavily API Key：请在「聊天工具箱 → 搜索」工具中填入后重试");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    const onAbort = () => controller.abort();
    if (signal) signal.addEventListener("abort", onAbort);
    try {
        const res = await fetch(tool.endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                api_key: tool.key,
                query,
                max_results: settings.tavilyMaxResults || 5,
                search_depth: settings.tavilySearchDepth || "basic",
            }),
            signal: controller.signal,
        });
        if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`);
        const data = await res.json().catch(() => ({}));
        const results = Array.isArray(data?.results) ? data.results : [];
        return (results as Array<{ title?: unknown; url?: unknown; content?: unknown; score?: unknown }>)
            .map(r => ({
                title: typeof r.title === "string" ? r.title : "",
                url: typeof r.url === "string" ? r.url : "",
                content: typeof r.content === "string" ? r.content : "",
                score: typeof r.score === "number" ? r.score : undefined,
            }))
            .filter(r => r.title || r.content);
    } finally {
        clearTimeout(timeout);
        if (signal) signal.removeEventListener("abort", onAbort);
    }
}

// ── LLM 直连（非流式、JSON 决策用）────────────────────────────────────────

export function resolveSurfApiConfig(settings: SurfSettings): ReturnType<typeof loadApiConfigs>[number] | null {
    if (typeof window === "undefined") return null;
    try {
        const configs = loadApiConfigs();
        if (!configs.length) return null;
        if (settings.apiConfigId) {
            const hit = configs.find(c => c.id === settings.apiConfigId);
            if (hit && hit.apiKey) return hit;
        }
        return configs.find(c => c.apiKey) ?? null;
    } catch {
        return null;
    }
}

export async function callLlmOnce(
    config: ReturnType<typeof loadApiConfigs>[number],
    promptText: string,
    opts: { signal?: AbortSignal; maxTokens?: number } = {},
): Promise<string> {
    const messages: LlmRequestMessage[] = [
        { role: "system", content: "你是严谨的 AI 助手。请只输出被要求的内容，不要任何多余解释。" },
        { role: "user", content: promptText },
    ];
    const request = buildProviderRequest(config, null, messages, {
        stream: false,
        maxTokens: opts.maxTokens ?? 1024,
    });
    const res = await fetchLlmPayload(request, { signal: opts.signal });
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
    const data = await res.json().catch(() => ({}));
    const parsed = parseProviderResponse(providerKindForConfig(config), data);
    return (parsed?.content || "").trim();
}

export function extractJsonObject(text: string): Record<string, unknown> | null {
    if (!text) return null;
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1] : text;
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
        const obj = JSON.parse(candidate.slice(start, end + 1));
        return obj && typeof obj === "object" ? (obj as Record<string, unknown>) : null;
    } catch {
        return null;
    }
}

// ── 决策 / 沉淀 / 分享 ─────────────────────────────────────────────────────

export type SurfDecision = {
    decision: "surf" | "skip" | "share";
    query: string;
    reason: string;
};

function weekdayLabel(ms: number): string {
    const w = ["日", "一", "二", "三", "四", "五", "六"][new Date(ms).getDay()];
    return `星期${w}`;
}

async function decideAction(
    settings: SurfSettings,
    config: ReturnType<typeof loadApiConfigs>[number],
    ctx: { recentNoteTitles: string[]; recentTopics: string[]; now: number },
    signal?: AbortSignal,
): Promise<SurfDecision> {
    const time = new Date(ctx.now);
    const pad = (n: number) => String(n).padStart(2, "0");
    const prompt =
        `${settings.freedomPrompt}\n\n` +
        `当前时间：${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())} ` +
        `${pad(time.getHours())}:${pad(time.getMinutes())}（${weekdayLabel(ctx.now)}）\n` +
        `你的见闻库存现有 ${ctx.recentNoteTitles.length} 条。最近几条标题：\n` +
        (ctx.recentNoteTitles.length
            ? ctx.recentNoteTitles.slice(0, 8).map(t => `- ${t}`).join("\n")
            : "（空）") +
        `\n近期搜索过的主题：${ctx.recentTopics.length ? ctx.recentTopics.slice(-6).join("；") : "（无）"}` +
        (settings.bannedTopics.length ? `\n禁区（禁止搜索这些话题）：${settings.bannedTopics.join("、")}` : "");
    const text = await callLlmOnce(config, prompt, { signal, maxTokens: 400 });
    const obj = extractJsonObject(text);
    const decision = (obj?.decision === "surf" || obj?.decision === "share" || obj?.decision === "skip")
        ? obj.decision
        : "skip";
    return {
        decision,
        query: typeof obj?.query === "string" ? obj.query.trim() : "",
        reason: typeof obj?.reason === "string" ? obj.reason.trim() : "（无理由）",
    };
}

async function askAlternateQuery(
    config: ReturnType<typeof loadApiConfigs>[number],
    query: string,
    reason: string,
    signal?: AbortSignal,
): Promise<string> {
    const prompt =
        `你之前想搜索「${query}」，但因为：${reason}。\n` +
        `请换一个完全不同、同样值得探索的问题。只输出一个 JSON：\n` +
        `{"query": "新问题"}`;
    try {
        const text = await callLlmOnce(config, prompt, { signal, maxTokens: 200 });
        const obj = extractJsonObject(text);
        return typeof obj?.query === "string" ? obj.query.trim() : "";
    } catch {
        return "";
    }
}

async function distillNote(
    settings: SurfSettings,
    config: ReturnType<typeof loadApiConfigs>[number],
    query: string,
    results: TavilyResultItem[],
    signal?: AbortSignal,
): Promise<Pick<SurfNote, "title" | "summary" | "insights" | "tags" | "worthSharing" | "shareText">> {
    const digest = results
        .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${(r.content || "").slice(0, 600)}`)
        .join("\n\n")
        .slice(0, 10_000);
    const prompt = `${settings.distillPrompt}\n\n搜索问题：${query}\n\n搜索结果：\n${digest || "（无结果）"}`;
    const text = await callLlmOnce(config, prompt, { signal, maxTokens: 900 });
    const obj = extractJsonObject(text);
    const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    return {
        title: typeof obj?.title === "string" && obj.title.trim() ? obj.title.trim().slice(0, 80) : `见闻：${query.slice(0, 60)}`,
        summary: typeof obj?.summary === "string" ? obj.summary.trim() : digest.slice(0, 500),
        insights: arr(obj?.insights).slice(0, 6),
        tags: arr(obj?.tags).slice(0, 8),
        worthSharing: obj?.worthSharing === true,
        shareText: typeof obj?.shareText === "string" ? obj.shareText.trim() : undefined,
    };
}

export type ShareVerdict = { share: boolean; text: string };

async function decideShare(
    settings: SurfSettings,
    config: ReturnType<typeof loadApiConfigs>[number],
    note: SurfNote,
    signal?: AbortSignal,
): Promise<ShareVerdict> {
    const prompt =
        `${settings.sharePolicyPrompt}\n\n` +
        `候选见闻：\n标题：${note.title}\n摘要：${note.summary}\n` +
        `亮点：${note.insights.join("；") || "（无）"}\n来源：${note.sourceUrls.slice(0, 3).join(" ")}`;
    try {
        const text = await callLlmOnce(config, prompt, { signal, maxTokens: 500 });
        const obj = extractJsonObject(text);
        const share = obj?.share === true;
        const shareText = typeof obj?.text === "string" ? obj.text.trim() : "";
        return { share, text: shareText || note.shareText || note.summary };
    } catch {
        return { share: false, text: "" };
    }
}

// ── 会话定位 ────────────────────────────────────────────────────────────────

export function resolveShareSession(settings: SurfSettings): ChatSession | null {
    if (typeof window === "undefined") return null;
    try {
        const sessions = loadChatSessions().filter(s => !s.isBlacklisted);
        if (!sessions.length) return null;
        if (settings.targetSessionId) {
            const hit = sessions.find(s => s.id === settings.targetSessionId);
            if (hit) return hit;
        }
        return sessions.find(s => !s.isGroup) ?? sessions[0];
    } catch {
        return null;
    }
}

export async function lastUserMessageAt(): Promise<number | null> {
    if (typeof window === "undefined") return null;
    try {
        const sessions = loadChatSessions();
        let last: number | null = null;
        for (const s of sessions) {
            const msgs = loadChatMessages(s.id);
            for (let i = msgs.length - 1; i >= 0; i--) {
                if (msgs[i].role === "user") {
                    const t = new Date(msgs[i].createdAt).getTime();
                    if (isFinite(t) && t > (last ?? 0)) last = t;
                    break;
                }
            }
        }
        return last;
    } catch {
        return null;
    }
}

// ── 主轮次 ─────────────────────────────────────────────────────────────────

export type SurfTrigger = "timer" | "manual" | "chat-gap";

function genId(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function runSurfRound(trigger: SurfTrigger): Promise<string> {
    if (typeof window === "undefined") return "非浏览器环境";
    const settings = loadSurfSettings();
    if (!settings.enabled) return "自主冲浪未启用";
    const state = loadSurfState();
    if (state.running) return "上一轮仍在进行中";
    state.running = true;
    saveSurfState(state);

    const finish = (outcome: string, error?: string) => {
        const now = Date.now();
        const next: SurfState = {
            ...loadSurfState(),
            running: false,
            lastRoundAt: now,
            lastTrigger: trigger,
            lastOutcome: outcome,
            lastError: error,
            nextTimerDueAt: now + settings.intervalMinutes * 60_000,
        };
        saveSurfState(next);
        return outcome;
    };

    try {
        const config = resolveSurfApiConfig(settings);
        if (!config) return finish("跳过：未找到可用的 API 配置（请在设置页指定或先配置大模型接口）", "无可用 API 配置");
        const quiet = settings.quietHoursEnabled && isWithinPushQuietHours(Date.now());
        const notes = loadSurfNotes();
        const traces = loadSurfTraces();
        const recentTopics = traces.slice(-8).map(t => t.query);
        const state0 = loadSurfState();

        // 1) 放权决策
        const decision = await decideAction(settings, config, {
            recentNoteTitles: notes.map(n => n.title),
            recentTopics,
            now: Date.now(),
        });

        if (decision.decision === "skip") {
            return finish(`休息（skip）：${decision.reason}`);
        }

        if (decision.decision === "share") {
            if (quiet) {
                return finish("静默时段：暂不分享，见闻继续沉淀");
            }
            const candidates = notes
                .filter(n => n.worthSharing && !n.sharedAt)
                .sort((a, b) => b.createdAt - a.createdAt);
            if (!candidates.length) {
                return finish("想分享但没有未分享的见闻，转为休息");
            }
            const verdict = await decideShare(settings, config, candidates[0]);
            if (!verdict.share) return finish(`分享决策为否：不打扰`);
            const sess = resolveShareSession(settings);
            if (!sess) return finish("没有可用会话，只沉淀不分享");
            const body = verdict.text.slice(0, 1500);
            pushChatMessage({ sessionId: sess.id, role: "assistant", content: body });
            dispatchChatMessageNotice({ sessionId: sess.id, body, isGroup: sess.isGroup });
            const chosen = candidates[0];
            const updated = notes.map(n => n.id === chosen.id ? { ...n, sharedAt: Date.now(), sharedSessionId: sess.id } : n);
            saveSurfNotes(updated);
            state0.totalShared++;
            saveSurfState({ ...state0 });
            return finish(`已分享见闻「${chosen.title.slice(0, 30)}」到会话 ${sess.id.slice(0, 8)}`);
        }

        // 2) surf：反刍闸 + 禁区，撞车时换题一次
        let query = decision.query.trim();
        if (!query) return finish("决策为 surf 但未给出 query，转为休息");
        let gate = checkRuminationGate(query, settings, traces);
        let banned = findBannedTopic(query, settings.bannedTopics);
        if (gate.blocked || banned) {
            const reason = gate.blocked
                ? `反刍闸判定该话题近期已搜索过（${gate.hits} 次 n-gram 撞车）`
                : `该话题命中禁区「${banned}」`;
            const alt = await askAlternateQuery(config, query, reason);
            if (alt && alt !== query) {
                query = alt;
                gate = checkRuminationGate(query, settings, traces);
                banned = findBannedTopic(query, settings.bannedTopics);
            }
            if (gate.blocked || banned) {
                return finish(`换题后仍受限，本轮放弃：${reason}`);
            }
        }

        // 3) 搜索
        const results = await callTavilySearch(query, settings);
        if (!results.length) return finish(`搜索「${query.slice(0, 40)}」无结果，本轮结束`);

        // 4) 沉淀
        const distilled = await distillNote(settings, config, query, results);
        const note: SurfNote = {
            id: genId("surf-note"),
            createdAt: Date.now(),
            query,
            title: distilled.title,
            summary: distilled.summary,
            insights: distilled.insights,
            tags: distilled.tags,
            worthSharing: distilled.worthSharing,
            shareText: distilled.shareText,
            sourceUrls: results.map(r => r.url).filter(Boolean).slice(0, 6),
        };
        saveSurfNotes(appendSurfNote(notes, note, settings.notesLimit));
        appendSurfTrace({ id: genId("surf-trace"), query, ngrams: computeNgrams(query, settings.ruminationNgramSize), createdAt: Date.now() });

        const state1 = loadSurfState();
        state1.totalNotes++;
        saveSurfState(state1);

        // 5) 分享（见闻值得分享 + 开启自动分享 + 非静默时段）
        if (note.worthSharing && settings.autoShare && !quiet) {
            const verdict = await decideShare(settings, config, note);
            if (verdict.share) {
                const sess = resolveShareSession(settings);
                if (sess) {
                    const body = verdict.text.slice(0, 1500);
                    pushChatMessage({ sessionId: sess.id, role: "assistant", content: body });
                    dispatchChatMessageNotice({ sessionId: sess.id, body, isGroup: sess.isGroup });
                    const updatedNotes = loadSurfNotes().map(n => n.id === note.id ? { ...n, sharedAt: Date.now(), sharedSessionId: sess.id } : n);
                    saveSurfNotes(updatedNotes);
                    const state2 = loadSurfState();
                    state2.totalShared++;
                    saveSurfState(state2);
                    return finish(`冲浪完成并已分享「${note.title.slice(0, 30)}」`);
                }
            }
        }
        return finish(`冲浪完成：沉淀见闻「${note.title.slice(0, 30)}」${quiet ? "（静默时段，未推送）" : ""}`);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[SurfEngine] Round failed:", error);
        return finish(`本轮失败：${message}`, message);
    }
}

export function surfNow(): Promise<string> {
    return runSurfRound("manual");
}

// ── 后台服务（全局 ticker）─────────────────────────────────────────────────

let surfServiceCleanup: (() => void) | null = null;

export function isSurfServiceRunning(): boolean {
    return surfServiceCleanup !== null;
}

export function startSurfService(): void {
    if (typeof window === "undefined" || surfServiceCleanup) return;
    surfServiceCleanup = bgSetInterval(() => { void surfTick(); }, 60_000);
    void surfTick();
}

export function stopSurfService(): void {
    surfServiceCleanup?.();
    surfServiceCleanup = null;
}

async function surfTick(): Promise<void> {
    if (typeof window === "undefined") return;
    const settings = loadSurfSettings();
    if (!settings.enabled) return;
    const state = loadSurfState();
    if (state.running) return;
    const now = Date.now();

    let trigger: SurfTrigger | null = null;
    if (state.nextTimerDueAt && now >= state.nextTimerDueAt) {
        trigger = "timer";
    } else if (!state.nextTimerDueAt) {
        // 首次启动：不立即触发，先设好下轮定时锚点
        state.nextTimerDueAt = now + settings.intervalMinutes * 60_000;
        saveSurfState(state);
        return;
    }

    // chat-gap 触发：用户静默超过阈值且距上一轮已过最小间隔
    if (!trigger && settings.chatGapMinutes > 0) {
        const lastUser = await lastUserMessageAt();
        if (lastUser && now - lastUser >= settings.chatGapMinutes * 60_000) {
            const sinceRound = state.lastRoundAt ? now - state.lastRoundAt : Number.POSITIVE_INFINITY;
            if (sinceRound >= settings.intervalMinutes * 60_000) trigger = "chat-gap";
        }
    }
    if (!trigger) return;
    await runSurfRound(trigger);
}

// ── 仪表盘（设置页用）──────────────────────────────────────────────────────

export function getSurfDashboard(): {
    settings: SurfSettings;
    state: SurfState;
    notes: SurfNote[];
    traces: SurfTrace[];
    hasTavilyKey: boolean;
    hasApiConfig: boolean;
} {
    const settings = loadSurfSettings();
    return {
        settings,
        state: loadSurfState(),
        notes: loadSurfNotes(),
        traces: loadSurfTraces(),
        hasTavilyKey: getSurfSearchTool() !== null,
        hasApiConfig: resolveSurfApiConfig(settings) !== null,
    };
}
