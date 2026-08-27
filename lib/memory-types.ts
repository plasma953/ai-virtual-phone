// lib/memory-types.ts

import type { ContentAppId } from "./settings-types";

export type MemoryEntry = {
    id: string;
    characterId: string;
    sourceApp: ContentAppId;
    type: "long_term" | "core";
    content: string;
    embedding?: number[];
    importance: number;         // 0-1
    createdAt: string;
    updatedAt: string;
    sourceMessageIds?: string[];
    metadata?: Record<string, unknown>;
    // ── Kiwi-style "human brain" memory fields ──
    /** 记忆热度 0-1：访问越频繁越高，随时间指数衰减（模拟人脑「记得牢」） */
    heat?: number;
    /** 上次热度更新时间（用于计算衰减） */
    heatUpdatedAt?: string;
    /** 累计被召回的次数 */
    accessCount?: number;
    /** 上次被召回的时间 */
    lastAccessedAt?: string;
    /** 是否已被 Dream 整合压缩过（压缩产物标记为 true） */
    dreamCompacted?: boolean;
    /** Dream 产物：指向被整合的源记忆 ID 列表 */
    originIds?: string[];
};

export type MemoryConfig = {
    autoSummarizeEnabled: boolean;          // whether auto-summarization runs after N events
    autoBuildCoreEnabled: boolean;          // whether core memories rebuild after long-term summarization
    vectorRecallEnabled: boolean;           // whether vector embedding recall is used for memory retrieval
    maxLongTermEntries: number;
    summarizationEventInterval: number;     // trigger summarization every N events
    coreSummarizationInterval: number;      // trigger core-memory rebuild every N new long-term memories
    shortTermTokenBudget: number;           // token limit for short-term event log
    coreMemoryTokenBudget: number;          // token limit for injected core memories
    longTermTokenBudget: number;            // token limit for injected long-term memories
    summarizationPrompt: string;            // user-editable prompt template for memory summarization
    coreMemoryPrompt: string;               // user-editable prompt template for core-memory extraction
    vnSummaryPrompt: string;                // user-editable prompt for VN chapter summarization
    // ── Kiwi-style heat system ──
    /** 热度系统开关：检索排序时叠加 heat 加权 + 召回后热度提升 */
    heatEnabled: boolean;
    /** 每次召回时热度的提升量（饱和式：heat + boost*(1-heat)） */
    heatBoostOnRecall: number;
    /** 热度半衰期（天）：热度每经过该时长自然减半（模拟遗忘曲线） */
    heatHalfLifeDays: number;
    /** 热度在检索排序中的权重 0-1（剩余的权重给向量相似度） */
    heatWeightInRanking: number;
    // ── Kiwi-style Dream consolidation ──
    /** Dream 整合开关：定期把低热度碎片记忆压缩提炼成高浓度记忆 */
    dreamEnabled: boolean;
    /** Dream 整合最小间隔（天） */
    dreamIntervalDays: number;
    /** 热度低于此值的长期记忆才有资格被 Dream 整合 */
    dreamColdHeatThreshold: number;
    /** Dream 单次整合的最小碎片数量 */
    dreamMinFragments: number;
    // ── Calendar summary injection ──
    /** 日历套娃摘要开关：注入时按 今天/本周/本月 分层摘要 */
    calendarSummaryEnabled: boolean;
    /** 日历摘要的 token 预算 */
    calendarSummaryTokenBudget: number;
    shortTermAllowedSources?: {
        chat?: boolean;
        group_chat?: boolean;
        moments?: boolean;
        checkphone?: boolean;
        diary?: boolean;
        xiaohongshu?: boolean;
        interview_magazine?: boolean;
        cocreate?: boolean;
        game?: boolean;
        story?: boolean;
        vn?: boolean;
        adventure?: boolean;
        custom_app?: boolean;
    };
};

export type MemorySearchResult = {
    entry: MemoryEntry;
    score: number;
};

/**
 * Default summarization prompt template.
 * Placeholders: {{char}}, {{earliest}}, {{latest}}, {{events}}
 */
export const DEFAULT_SUMMARIZATION_PROMPT = `你是一个记忆整理助手。根据以下事件记录，创建一段简洁的事实性总结。

角色：{{char}}
时间跨度：{{earliest}} 至 {{latest}}

事件记录：
{{events}}

要求：
- 用第三人称描述{{char}}和用户之间的互动
- 保留关键事实：提到的名字、做出的承诺、情感变化、关系里程碑
- 保留用户分享的具体信息（生日、偏好、习惯）
- 保留朋友圈等非聊天事件中的关键信息
- 100-200字
- 不要包含格式标记

总结：`;

/**
 * Default core-memory summarization prompt template.
 * Placeholders: {{char}}, {{earliest}}, {{latest}}, {{events}}
 */
export const DEFAULT_CORE_MEMORY_PROMPT = `你是一个核心记忆整理助手。请根据以下长期记忆记录，为{{char}}整理一段“核心记忆”总结。

角色：{{char}}
时间跨度：{{earliest}} 至 {{latest}}

长期记忆记录：
{{events}}

要求：
- 突出最关键、最稳定、最影响关系判断的事实
- 确认在一起 / 确认分手 / 复合
- 订婚 / 结婚 / 离婚
- 恋爱周年、结婚纪念日、在一起多久
- 明确的长期关系身份（如恋人、前任、配偶）
- 共同生活的重要里程碑（如同居、见家长、共同养宠物）
- 普通日常聊天
- 一般情绪波动
- 暂时性的矛盾或暧昧
- 普通偏好信息
- 任何不确定、推测性的内容
- 用第三人称，事实性描述
- 80-180字
- 不要使用 JSON、列表符号、标题或格式标记

核心记忆总结：`;

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
    autoSummarizeEnabled: true,
    autoBuildCoreEnabled: true,
    vectorRecallEnabled: true,
    maxLongTermEntries: 500,
    summarizationEventInterval: 80,
    coreSummarizationInterval: 5,
    shortTermTokenBudget: 100000,
    coreMemoryTokenBudget: 100000,
    longTermTokenBudget: 100000,
    summarizationPrompt: DEFAULT_SUMMARIZATION_PROMPT,
    coreMemoryPrompt: DEFAULT_CORE_MEMORY_PROMPT,
    vnSummaryPrompt: "",
    heatEnabled: true,
    heatBoostOnRecall: 0.18,
    heatHalfLifeDays: 7,
    heatWeightInRanking: 0.35,
    dreamEnabled: true,
    dreamIntervalDays: 3,
    dreamColdHeatThreshold: 0.3,
    dreamMinFragments: 5,
    calendarSummaryEnabled: false,
    calendarSummaryTokenBudget: 1500,
    shortTermAllowedSources: {
        chat: true,
        group_chat: true,
        moments: true,
        checkphone: true,
        diary: true,
        xiaohongshu: true,
        interview_magazine: true,
        cocreate: true,
        game: true,
        story: true,
        vn: true,
        adventure: true,
        custom_app: true,
    },
};
