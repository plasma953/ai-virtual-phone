// lib/reading-engine.ts — LLM integration for Reading feature.
// All prompts go through the preset system via assemblePromptPayload. No extra message push.

import type { Book, BookChapter, ReadingAnnotation } from "./reading-types";
import type { ChatSession } from "./chat-storage";
import { loadChatMessages, pushChatMessage } from "./chat-storage";
import { loadCharacters } from "./character-storage";
import { loadReadingInteractionConfig } from "./reading-storage";
import {
    resolveBinding,
    loadBindingConfig,
    loadApiConfigs,
    loadPresets,
    loadWorldBooks,
    loadRegexes,
    resolveUserIdentity,
} from "./settings-storage";
import {
    assemblePromptPayload,
    type AssemblerInput,
    type LLMMessage,
} from "./llm-prompt-assembler";
import type { ApiConfig, PresetConfig, RegexConfig } from "./settings-types";
import { loadMemoryConfig } from "./memory-storage";
import { retrieveCoreMemoriesForPrompt, retrieveMemoriesForPrompt } from "./memory-service";
import { formatCoreMemories, formatLongTermMemories } from "./memory-injector";
import { prepareShortTermContext } from "./short-term-assembler";
import { previewMessagesForApi, sendLLMRequest } from "./chat-engine";
import { DEFAULT_READING_BILINGUAL_PROMPT, resolveBilingualPrompt } from "./bilingual-prompt-defaults";

export type ReadingDiscussAction =
    | { type: "add_annotation"; paragraphIndex: number; content: string }
    | { type: "delete_annotation"; annotationId: string }
    | { type: "update_annotation"; annotationId: string; content: string };

export type AnnotationTarget = {
    chapterIndex: number;
    paragraphIndex: number;
    text: string;
};

export type ReadingDiscussContext = {
    chapterTitle: string;
    chapterContent: string;
    annotations: ReadingAnnotation[];
};

function buildReadingBilingualInstruction(enabled: boolean, customPrompt?: string): string {
    return resolveBilingualPrompt(enabled, customPrompt, DEFAULT_READING_BILINGUAL_PROMPT);
}

// ── Resolve assembler input for reading context ──

async function resolveReadingInput(
    characterId: string,
    appTags: string[],
    options: {
        bookTitle: string;
        chapterTitle: string;
        chapterContent: string;
        annotationHistory: string;
        history?: ReturnType<typeof loadChatMessages>;
    },
): Promise<{ input: AssemblerInput; apiConfig: ApiConfig | null; preset: PresetConfig | null } | null> {
    const chars = loadCharacters();
    const character = chars.find(c => c.id === characterId);
    if (!character) return null;

    const bindings = loadBindingConfig();
    const slot = resolveBinding(bindings, characterId, "reading");

    const apiConfigId = slot.apiConfigId;
    const presetId = slot.presetId;
    const worldBookIds = slot.worldBookIds || [];
    const regexIds = slot.regexIds || [];
    const userIdentityId = slot.userIdentityId;

    let apiConfig: ApiConfig | null = null;
    if (apiConfigId) {
        apiConfig = loadApiConfigs().find(c => c.id === apiConfigId) ?? null;
    }
    if (!apiConfig) return null;

    const presets = loadPresets();
    let preset: PresetConfig | null = presetId
        ? presets.find(p => p.id === presetId) ?? null
        : null;
    if (!preset) preset = presets.find(p => p.builtIn) ?? presets[0] ?? null;

    const worldBooks = loadWorldBooks().filter(wb => worldBookIds.includes(wb.id));
    const regexes = loadRegexes().filter(r => regexIds.includes(r.id));

    const identities = (await import("./settings-storage")).loadUserIdentities();
    const userIdentity = userIdentityId
        ? identities.find(i => i.id === userIdentityId) || identities[0]
        : identities[0] || null;

    // Memory
    const memConfig = loadMemoryConfig();
    const coreMemories = await retrieveCoreMemoriesForPrompt(characterId, memConfig);
    const longTermMemories = await retrieveMemoriesForPrompt(characterId, options.bookTitle, memConfig);

    // Short-term context
    const { recentBlocks, truncatedHistory, unifiedRecentItems } = prepareShortTermContext(characterId, "chat", {
        history: options.history,
        userName: userIdentity?.name ?? "用户",
    });
    const readingConfig = loadReadingInteractionConfig();

    const input: AssemblerInput = {
        character,
        history: truncatedHistory,
        preset,
        worldBooks,
        regexes,
        userIdentity,
        appId: "reading",
        appTags,
        coreMemories: formatCoreMemories(coreMemories),
        longTermMemories: formatLongTermMemories(longTermMemories),
        recentBlocks,
        unifiedRecentItems,
        bookTitle: options.bookTitle,
        chapterTitle: options.chapterTitle,
        chapterContent: options.chapterContent,
        annotationHistory: options.annotationHistory,
        chatBilingualInstruction: buildReadingBilingualInstruction(
            readingConfig.bilingualTranslationEnabled === true,
            readingConfig.bilingualTranslationPrompt,
        ),
    };

    return { input, apiConfig, preset };
}

async function callReadingLLM(
    config: ApiConfig,
    preset: PresetConfig | null,
    messages: LLMMessage[],
    characterName: string,
    regexes?: RegexConfig[],
    appTags?: string[],
    userName?: string,
): Promise<string> {
    return sendLLMRequest(
        config,
        preset,
        messages,
        regexes ?? [],
        { characterName, userName },
        { appId: "reading", appTags },
    );
}

// ── Format helpers ──

function formatChapterContent(paragraphs: string[]): string {
    return paragraphs.map((p, i) => `[${i + 1}] ${p}`).join("\n\n");
}

function formatAnnotationHistory(annotations: ReadingAnnotation[]): string {
    if (annotations.length === 0) return "（暂无批注）";
    return annotations.map(a => `[批注:${a.paragraphIndex + 1}] ${a.content}`).join("\n");
}

function formatBatchChapterContent(targets: AnnotationTarget[]): string {
    return targets.map((target, index) => `[${index + 1}] ${target.text}`).join("\n\n");
}

function formatBatchAnnotationHistory(annotations: ReadingAnnotation[], targets: AnnotationTarget[]): string {
    if (annotations.length === 0) return "（暂无批注）";

    const targetIndexMap = new Map<string, number>();
    targets.forEach((target, index) => {
        targetIndexMap.set(`${target.chapterIndex}:${target.paragraphIndex}`, index + 1);
    });

    const lines = annotations.flatMap((annotation) => {
        const relativeIndex = targetIndexMap.get(`${annotation.chapterIndex}:${annotation.paragraphIndex}`);
        if (!relativeIndex) return [];
        return [`[批注:${relativeIndex}][角色:${annotation.characterName}] ${annotation.content}`];
    });

    return lines.length > 0 ? lines.join("\n") : "（暂无批注）";
}

function formatAnnotationActionContext(annotations: ReadingAnnotation[]): string {
    if (annotations.length === 0) return "（当前范围暂无批注）";
    return annotations
        .map((annotation) => `- ID=${annotation.id} | 段落=${annotation.paragraphIndex + 1} | 角色=${annotation.characterName} | 内容=${annotation.content}`)
        .join("\n");
}

function isDiscussActionLine(line: string): boolean {
    return /^【(?:新增批注\s+段落\s*=\s*\d+|删除批注\s+ID\s*=\s*[^\s】]+|修改批注\s+ID\s*=\s*[^\s】]+)】/.test(line);
}

export function parseReadingDiscussResponse(raw: string): {
    reply: string;
    actions: ReadingDiscussAction[];
} {
    const normalized = raw.replace(/\r\n/g, "\n").trimEnd();
    if (!normalized) return { reply: "", actions: [] };

    const lines = normalized.split("\n");
    const actionLines: string[] = [];
    let actionStart = lines.length;
    let foundActionTail = false;

    for (let i = lines.length - 1; i >= 0; i -= 1) {
        const trimmed = lines[i].trim();
        if (!foundActionTail) {
            if (!trimmed) continue;
            if (!isDiscussActionLine(trimmed)) break;
            foundActionTail = true;
            actionStart = i;
            actionLines.unshift(trimmed);
            continue;
        }

        if (!trimmed) {
            actionStart = i;
            continue;
        }
        if (!isDiscussActionLine(trimmed)) break;
        actionStart = i;
        actionLines.unshift(trimmed);
    }

    if (!foundActionTail) return { reply: normalized.trim(), actions: [] };

    const actions: ReadingDiscussAction[] = [];
    for (const line of actionLines) {
        let match = line.match(/^【新增批注\s+段落\s*=\s*(\d+)】([\s\S]+)$/);
        if (match) {
            const paragraphIndex = Number(match[1]) - 1;
            const content = match[2].trim();
            if (Number.isInteger(paragraphIndex) && paragraphIndex >= 0 && content) {
                actions.push({ type: "add_annotation", paragraphIndex, content });
            }
            continue;
        }

        match = line.match(/^【删除批注\s+ID\s*=\s*([^\s】]+)】$/);
        if (match) {
            actions.push({ type: "delete_annotation", annotationId: match[1] });
            continue;
        }

        match = line.match(/^【修改批注\s+ID\s*=\s*([^\s】]+)】([\s\S]+)$/);
        if (match) {
            const content = match[2].trim();
            if (content) {
                actions.push({ type: "update_annotation", annotationId: match[1], content });
            }
        }
    }

    const reply = lines.slice(0, actionStart).join("\n").trim();
    return { reply, actions };
}

// ── Public API ──

/** Generate annotations for a chapter. */
export async function generateAnnotations(
    book: Book,
    chapter: BookChapter,
    existingAnnotations: ReadingAnnotation[],
    characterId: string,
): Promise<ReadingAnnotation[]> {
    return generateAnnotationBatch(
        book,
        chapter.title,
        chapter.paragraphs.map((text, paragraphIndex) => ({
            chapterIndex: chapter.index,
            paragraphIndex,
            text,
        })),
        existingAnnotations,
        characterId,
    );
}

export async function generateAnnotationBatch(
    book: Book,
    batchTitle: string,
    targets: AnnotationTarget[],
    existingAnnotations: ReadingAnnotation[],
    characterId: string,
): Promise<ReadingAnnotation[]> {
    const character = loadCharacters().find(c => c.id === characterId);
    if (!character) throw new Error("角色不存在");
    if (targets.length === 0) return [];

    const resolved = await resolveReadingInput(characterId, ["reading", "annotate"], {
        bookTitle: book.title,
        chapterTitle: batchTitle,
        chapterContent: formatBatchChapterContent(targets),
        annotationHistory: formatBatchAnnotationHistory(existingAnnotations, targets),
    });
    if (!resolved) throw new Error("未找到 API 配置，请在设置中绑定 API");

    const { input, apiConfig, preset } = resolved;
    const llmMessages = assemblePromptPayload(input);
    const responseText = await callReadingLLM(
        apiConfig!,
        preset,
        llmMessages,
        character.name,
        input.regexes,
        input.appTags,
        input.userIdentity?.name,
    );
    if (!responseText) throw new Error("API 返回空内容");
    if (responseText.includes("[无批注]")) return [];

    // Parse [批注:N]...[/批注]
    const pattern = /\[批注[:：](\d+)\]([\s\S]*?)\[\/批注\]/g;
    const results: ReadingAnnotation[] = [];
    let match;
    while ((match = pattern.exec(responseText)) !== null) {
        const relativeIndex = parseInt(match[1], 10) - 1;
        const content = match[2].trim();
        const target = targets[relativeIndex];
        if (content && target) {
            results.push({
                id: `ra_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                bookId: book.id,
                chapterIndex: target.chapterIndex,
                paragraphIndex: target.paragraphIndex,
                characterId,
                characterName: character.name,
                content,
                createdAt: new Date().toISOString(),
            });
        }
    }
    return results;
}

export async function previewReadingAnnotationPrompt(
    book: Book,
    chapter: BookChapter,
    existingAnnotations: ReadingAnnotation[],
    characterId: string,
): Promise<{ messages: LLMMessage[]; characterName: string; model: string; presetName: string }> {
    const character = loadCharacters().find(c => c.id === characterId);
    if (!character) throw new Error("角色不存在");

    const targets = chapter.paragraphs.map((text, paragraphIndex) => ({
        chapterIndex: chapter.index,
        paragraphIndex,
        text,
    }));
    const resolved = await resolveReadingInput(characterId, ["reading", "annotate"], {
        bookTitle: book.title,
        chapterTitle: chapter.title,
        chapterContent: formatBatchChapterContent(targets),
        annotationHistory: formatBatchAnnotationHistory(existingAnnotations, targets),
    });
    if (!resolved?.apiConfig) throw new Error("未找到 API 配置，请在设置中绑定 API");

    const llmMessages = assemblePromptPayload(resolved.input);
    return {
        messages: previewMessagesForApi(resolved.apiConfig, resolved.preset, llmMessages),
        characterName: `阅读:${character.name}`,
        model: resolved.apiConfig.defaultModel,
        presetName: resolved.preset?.name ?? "默认预设",
    };
}

export async function previewReadingDiscussPrompt(
    session: ChatSession,
    book: Book,
    context: ReadingDiscussContext,
    characterId: string,
): Promise<{ messages: LLMMessage[]; characterName: string; model: string; presetName: string }> {
    const character = loadCharacters().find(c => c.id === characterId);
    if (!character) throw new Error("角色不存在");

    const history = loadChatMessages(session.id);
    const resolved = await resolveReadingInput(characterId, ["reading", "discuss"], {
        bookTitle: book.title,
        chapterTitle: context.chapterTitle,
        chapterContent: context.chapterContent,
        annotationHistory: formatAnnotationActionContext(context.annotations),
        history,
    });
    if (!resolved?.apiConfig) throw new Error("未找到 API 配置，请在设置中绑定 API");

    const llmMessages = assemblePromptPayload(resolved.input);
    return {
        messages: previewMessagesForApi(resolved.apiConfig, resolved.preset, llmMessages),
        characterName: `阅读对话:${character.name}`,
        model: resolved.apiConfig.defaultModel,
        presetName: resolved.preset?.name ?? "默认预设",
    };
}

/** Generate a chat response in reading discuss mode. */
export async function generateReadingChat(
    session: ChatSession,
    book: Book,
    context: ReadingDiscussContext,
    characterId: string,
): Promise<string | null> {
    const character = loadCharacters().find(c => c.id === characterId);
    if (!character) return null;

    const history = loadChatMessages(session.id);

    const resolved = await resolveReadingInput(characterId, ["reading", "discuss"], {
        bookTitle: book.title,
        chapterTitle: context.chapterTitle,
        chapterContent: context.chapterContent,
        annotationHistory: formatAnnotationActionContext(context.annotations),
        history,
    });
    if (!resolved) return null;

    const { input, apiConfig, preset } = resolved;
    const llmMessages = assemblePromptPayload(input);
    const responseText = await callReadingLLM(
        apiConfig!,
        preset,
        llmMessages,
        character.name,
        input.regexes,
        input.appTags,
        input.userIdentity?.name,
    );
    if (!responseText) return null;

    // Return raw text — caller is responsible for parsing and saving (like chat-room's splitAndSaveAIMessages)
    return responseText;
}

// ── AI 阅读智能（移植自 coread：章节摘要 / 读后感受 / 事实卡）──

export type ChapterSummaryResult = {
    summary: string;
    keyPoints: string[];
};

/** 生成章节摘要（要点+正文）。复用阅读绑定的 API 与角色人设。 */
export async function generateChapterSummary(
    book: Book,
    chapter: BookChapter,
    characterId: string,
): Promise<ChapterSummaryResult> {
    const character = loadCharacters().find(c => c.id === characterId);
    if (!character) throw new Error("角色不存在");
    const chapterContent = chapter.paragraphs.slice(0, 120).join("\n");
    const resolved = await resolveReadingInput(characterId, ["reading", "summarize", ...(chapter.index >= 0 ? ["chapter"] : [])], {
        bookTitle: book.title,
        chapterTitle: chapter.title,
        chapterContent,
        annotationHistory: "",
    });
    if (!resolved) throw new Error("未找到 API 配置，请在设置中绑定 API");
    const { input, apiConfig, preset } = resolved;
    const llmMessages = assemblePromptPayload(input);
    llmMessages.push({
        role: "user",
        content: `请为《${book.title}》第 ${chapter.index + 1} 章「${chapter.title}」生成章节摘要。要求：\n- 用读书伙伴的口吻，150 字以内概括本章讲了什么（情节/信息/情感走向）\n- 提取 3-5 个关键点\n- 严格输出格式：\n【摘要】\n<正文>\n【要点】\n- <要点1>\n- <要点2>\n...`,
    });
    const responseText = await callReadingLLM(
        apiConfig!,
        preset,
        llmMessages,
        character.name,
        input.regexes,
        input.appTags,
        input.userIdentity?.name,
    );
    if (!responseText) throw new Error("API 返回空内容");
    const summaryMatch = /【摘要】([\s\S]*?)(?:【要点】|$)/.exec(responseText);
    const pointsMatch = /【要点】([\s\S]*)$/.exec(responseText);
    const summary = (summaryMatch?.[1] || responseText).trim();
    const keyPoints = (pointsMatch?.[1] || "")
        .split(/\n+/)
        .map(line => line.replace(/^[-\s*•]+/, "").trim())
        .filter(Boolean)
        .slice(0, 8);
    return { summary, keyPoints };
}

/** 生成读后感受（整本书读完后的整体印象）。 */
export async function generateReadingImpression(
    book: Book,
    chapterTitles: string[],
    characterId: string,
): Promise<string> {
    const character = loadCharacters().find(c => c.id === characterId);
    if (!character) throw new Error("角色不存在");
    const resolved = await resolveReadingInput(characterId, ["reading", "impression"], {
        bookTitle: book.title,
        chapterTitle: "整本书",
        chapterContent: `章节结构：${chapterTitles.join(" → ")}`,
        annotationHistory: "",
    });
    if (!resolved) throw new Error("未找到 API 配置，请在设置中绑定 API");
    const { input, apiConfig, preset } = resolved;
    const llmMessages = assemblePromptPayload(input);
    llmMessages.push({
        role: "user",
        content: `你刚和用户一起读完了《${book.title}》。请以读书伙伴的口吻写一段读后感受（150-250字）：印象最深的部分、整体情绪、有没有想吐槽或回味的地方，像看完和好朋友聊书一样自然，不要写成书评。`,
    });
    const responseText = await callReadingLLM(
        apiConfig!,
        preset,
        llmMessages,
        character.name,
        input.regexes,
        input.appTags,
        input.userIdentity?.name,
    );
    if (!responseText) throw new Error("API 返回空内容");
    return responseText.trim();
}

/** 生成章节「事实卡」：需要记住的关键信息（1-5 条，含重要性分级）。 */
export async function generateBookFacts(
    book: Book,
    chapter: BookChapter,
    characterId: string,
): Promise<Array<{ text: string; importance: number }>> {
    const character = loadCharacters().find(c => c.id === characterId);
    if (!character) throw new Error("角色不存在");
    const chapterContent = chapter.paragraphs.slice(0, 120).join("\n");
    const resolved = await resolveReadingInput(characterId, ["reading", "facts"], {
        bookTitle: book.title,
        chapterTitle: chapter.title,
        chapterContent,
        annotationHistory: "",
    });
    if (!resolved) throw new Error("未找到 API 配置，请在设置中绑定 API");
    const { input, apiConfig, preset } = resolved;
    const llmMessages = assemblePromptPayload(input);
    llmMessages.push({
        role: "user",
        content: `从《${book.title}》第 ${chapter.index + 1} 章「${chapter.title}」中提取值得记住的关键信息（人物关系/关键情节/伏笔/设定），最多 5 条。严格按行输出：\n重要度:1-5 | 一句话事实\n（重要度 5=必须记住，1=锦上添花；不要输出其他内容）`,
    });
    const responseText = await callReadingLLM(
        apiConfig!,
        preset,
        llmMessages,
        character.name,
        input.regexes,
        input.appTags,
        input.userIdentity?.name,
    );
    if (!responseText) throw new Error("API 返回空内容");
    const results: Array<{ text: string; importance: number }> = [];
    for (const line of responseText.split(/\n+/)) {
        const m = /重要度\s*[:：]\s*([1-5])\s*\|\s*(.+)/.exec(line.trim());
        if (m) {
            results.push({ text: m[2].trim(), importance: parseInt(m[1], 10) });
        }
    }
    return results;
}
