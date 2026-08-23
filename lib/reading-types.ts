// lib/reading-types.ts — Type definitions for the Reading (阅读) feature.

export type Book = {
    id: string;
    title: string;
    author?: string;
    format: "txt" | "epub" | "pdf";
    totalChapters: number;
    createdAt: string;
    /** 书籍分类（coread 风格书库管理） */
    category?: string;
    /** 书籍标签列表 */
    tags?: string[];
    /** 回收站：非空表示已移入回收站（记录删除时间），可恢复 */
    trashedAt?: string | null;
};

export type BookChapter = {
    id: string;
    bookId: string;
    index: number;
    title: string;
    paragraphs: string[];
    /** PDF only: synthetic page chunk start (1-based) */
    pageStart?: number;
    /** PDF only: synthetic page chunk end (1-based) */
    pageEnd?: number;
    /** PDF only: page number (1-based) for each paragraph */
    paragraphPages?: number[];
    /** PDF only: vertical position (0-1 ratio) within page for each paragraph */
    paragraphYPositions?: number[];
};

export type ReadingProgress = {
    bookId: string;
    chapterIndex: number;
    scrollPosition: number;
    companionCharacterId?: string;
    progressFraction?: number;
    progressCurrent?: number;
    progressTotal?: number;
    progressScope?: "book" | "chapter";
    /** 保存进度时的阅读模式；滚动模式下 scrollPosition 存的是章节内滚动比例(0-1) */
    readingMode?: "page" | "scroll";
    lastReadAt: string;
};

export type ReadingAnnotation = {
    id: string;
    bookId: string;
    chapterIndex: number;
    paragraphIndex: number;
    characterId: string;
    characterName: string;
    content: string;
    createdAt: string;
};

// ── 用户批注体系（移植自 coread：高亮 / 波浪线 / 评论 / 收藏）──

export type UserAnnotationKind = "highlight" | "underline" | "comment" | "favorite";

export type UserAnnotation = {
    id: string;
    bookId: string;
    chapterIndex: number;
    paragraphIndex: number;
    /** 选区在段落文本内的字符偏移（包含式 [startOffset, endOffset)） */
    startOffset: number;
    endOffset: number;
    /** 选区原文快照 */
    text: string;
    kind: UserAnnotationKind;
    /** comment 类型时的评论内容 */
    note?: string;
    createdAt: string;
};

// ── AI 阅读智能（移植自 coread：章节摘要 / 读后感受 / 事实卡）──

export type ChapterSummary = {
    id: string;
    bookId: string;
    chapterIndex: number;
    title: string;
    summary: string;
    keyPoints: string[];
    createdAt: string;
    updatedAt: string;
};

export type BookFact = {
    id: string;
    bookId: string;
    chapterIndex: number;
    text: string;
    /** 重要性 1-5（coread importance levels 简化版） */
    importance: number;
    /** 追加式修订历史（append-only） */
    history: { text: string; at: string }[];
    createdAt: string;
    updatedAt: string;
};

export type ReadingImpression = {
    id: string;
    bookId: string;
    content: string;
    createdAt: string;
    updatedAt: string;
};