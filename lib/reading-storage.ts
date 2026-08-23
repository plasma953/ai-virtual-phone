// lib/reading-storage.ts — Dexie IndexedDB persistence for Reading feature.

import Dexie from "dexie";
import type { Book, BookChapter, ReadingProgress, ReadingAnnotation, UserAnnotation, ChapterSummary, BookFact, ReadingImpression } from "./reading-types";
import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import { DEFAULT_READING_BILINGUAL_PROMPT } from "./bilingual-prompt-defaults";

// ── Database ──

class ReadingDB extends Dexie {
    books!: Dexie.Table<Book, string>;
    chapters!: Dexie.Table<BookChapter, string>;
    progress!: Dexie.Table<ReadingProgress, string>;
    annotations!: Dexie.Table<ReadingAnnotation, string>;
    rawFiles!: Dexie.Table<{ bookId: string; data: Blob }, string>;
    userAnnotations!: Dexie.Table<UserAnnotation, string>;
    summaries!: Dexie.Table<ChapterSummary, string>;
    facts!: Dexie.Table<BookFact, string>;
    impressions!: Dexie.Table<ReadingImpression, string>;

    constructor() {
        super("reading-db");
        this.version(1).stores({
            books: "id",
            chapters: "id, bookId, [bookId+index]",
            progress: "bookId",
            annotations: "id, [bookId+chapterIndex]",
        });
        this.version(2).stores({
            books: "id, createdAt",
            chapters: "id, bookId, [bookId+index]",
            progress: "bookId",
            annotations: "id, [bookId+chapterIndex]",
        });
        this.version(3).stores({
            books: "id, createdAt",
            chapters: "id, bookId, [bookId+index]",
            progress: "bookId",
            annotations: "id, [bookId+chapterIndex]",
            rawFiles: "bookId",
        });
        this.version(4).stores({
            books: "id, createdAt",
            chapters: "id, bookId, [bookId+index]",
            progress: "bookId",
            annotations: "id, [bookId+chapterIndex]",
            rawFiles: "bookId",
            userAnnotations: "id, [bookId+chapterIndex]",
            summaries: "id, [bookId+chapterIndex]",
            facts: "id, bookId",
            impressions: "id",
        });
    }
}

const db = new ReadingDB();

// ── In-memory cache ──

let _booksCache: Book[] | null = null;
let _chaptersCache: Map<string, BookChapter[]> = new Map();
let _progressCache: Map<string, ReadingProgress> = new Map();
let _annotationsCache: Map<string, ReadingAnnotation[]> = new Map(); // key: bookId:chapterIndex
let _userAnnotationsCache: Map<string, UserAnnotation[]> = new Map(); // key: bookId:chapterIndex
let _summariesCache: Map<string, ChapterSummary> = new Map(); // key: bookId:chapterIndex
let _factsCache: Map<string, BookFact[]> = new Map(); // key: bookId
let _impressionsCache: Map<string, ReadingImpression> = new Map(); // key: bookId

const READING_INTERACTION_CONFIG_KEY = "ai_phone_reading_interaction_config_v1";
registerKvMigration(READING_INTERACTION_CONFIG_KEY);
const RAW_FILE_DB_NAME = "reading-raw-files";
const RAW_FILE_STORE_NAME = "files";

/** TXT 导入时的段落划分方式：auto=智能探测（默认）/ blank=空行 / indent=段首缩进 / line=每行一段 */
export type ReadingParagraphMode = "auto" | "blank" | "indent" | "line";

/** 阅读模式：page=翻页 / scroll=连续滚动 */
export type ReadingViewMode = "page" | "scroll";

export type ReadingInteractionConfig = {
    bilingualTranslationEnabled: boolean;
    collapseBilingualTranslation: boolean;
    bilingualTranslationPrompt: string;
    /** 导入 TXT 时如何划分段落（默认自动探测书格式） */
    paragraphMode: ReadingParagraphMode;
    /** TXT 编码解析：auto=自动探测（默认）/ utf-8 / gb18030 / gbk / big5 / utf-16le / utf-16be */
    txtEncoding: "auto" | "utf-8" | "gb18030" | "gbk" | "big5" | "utf-16le" | "utf-16be";
    /** 阅读模式：翻页 / 连续滚动 */
    readingMode: ReadingViewMode;
    /** 自动批注失败时的静默重试次数（0=不重试） */
    annotationRetryCount: number;
    /** TXT 预批注：读到上一批批注阈值时提前生成下一批（TXT 按段落分批）；默认关闭，由用户手动开启 */
    autoAnnotatePrefetch: boolean;
    /** PDF 预批注：同上，但针对 PDF（按页分批）；默认关闭，由用户手动开启 */
    autoAnnotatePrefetchPdf: boolean;
    /** 批注预生成触发时机：读到上一批批注的多少比例时提前生成下一批（0-1，默认 2/3） */
    annotationPrefetchThreshold: number;
    /** 共读讨论悬浮窗展开时是否自动滚动到最新消息（默认开启；用户可随后自由滑动打断） */
    chatAutoScrollOnOpen: boolean;
    /** PDF 渲染：页面缩放率（1=按容器宽度原样，>1 放大；配合「一屏一页」使用） */
    pdfZoom: number;
    /** PDF 渲染：当前页前后各预渲染几页（懒加载粒度；过小会导致滚动到未渲染页反复渲染闪烁） */
    pdfPreloadRadius: number;
    /** PDF 预加载：开启后阅读时提前渲染后续页，滚动更平滑 */
    pdfPreloadEnabled: boolean;
};

export const DEFAULT_READING_INTERACTION_CONFIG: ReadingInteractionConfig = {
    bilingualTranslationEnabled: true,
    collapseBilingualTranslation: true,
    bilingualTranslationPrompt: DEFAULT_READING_BILINGUAL_PROMPT,
    paragraphMode: "auto",
    txtEncoding: "auto",
    readingMode: "page",
    annotationRetryCount: 3,
    autoAnnotatePrefetch: false,
    autoAnnotatePrefetchPdf: false,
    annotationPrefetchThreshold: 2 / 3,
    chatAutoScrollOnOpen: true,
    pdfZoom: 1,
    pdfPreloadRadius: 3,
    pdfPreloadEnabled: true,
};

export async function hydrateReadingStorage(): Promise<void> {
    _booksCache = await db.books.toArray();
    _booksCache.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

// ── Books ──

export function loadBooks(): Book[] {
    return _booksCache || [];
}

export async function addBook(book: Book): Promise<void> {
    await db.books.put(book);
    _booksCache = null;
    _booksCache = await db.books.orderBy("createdAt").reverse().toArray();
}

export async function updateBook(book: Book): Promise<void> {
    await db.books.put(book);
    _booksCache = null;
    _booksCache = await db.books.orderBy("createdAt").reverse().toArray();
}

export async function deleteBook(bookId: string): Promise<void> {
    await db.books.delete(bookId);
    await db.chapters.where("bookId").equals(bookId).delete();
    await db.progress.delete(bookId);
    await db.annotations.where("[bookId+chapterIndex]").between([bookId, Dexie.minKey], [bookId, Dexie.maxKey]).delete();
    await deleteRawFile(bookId).catch(() => {});
    _booksCache = null;
    _booksCache = await db.books.orderBy("createdAt").reverse().toArray();
    _chaptersCache.delete(bookId);
    _progressCache.delete(bookId);
    // Clear annotation cache for this book
    for (const key of _annotationsCache.keys()) {
        if (key.startsWith(bookId + ":")) _annotationsCache.delete(key);
    }
}

// ── Chapters ──

export async function saveChapters(bookId: string, chapters: BookChapter[]): Promise<void> {
    await db.chapters.bulkPut(chapters);
    const existing = _chaptersCache.get(bookId) ?? await db.chapters.where("bookId").equals(bookId).toArray();
    const merged = new Map(existing.map((chapter) => [chapter.id, chapter]));
    for (const chapter of chapters) {
        merged.set(chapter.id, chapter);
    }
    const next = [...merged.values()].sort((a, b) => a.index - b.index);
    _chaptersCache.set(bookId, next);
}

export async function loadChapters(bookId: string): Promise<BookChapter[]> {
    if (_chaptersCache.has(bookId)) return _chaptersCache.get(bookId)!;
    const chapters = await db.chapters.where("bookId").equals(bookId).sortBy("index");
    _chaptersCache.set(bookId, chapters);
    return chapters;
}

// ── Progress ──

export async function loadProgress(bookId: string): Promise<ReadingProgress | null> {
    if (_progressCache.has(bookId)) return _progressCache.get(bookId)!;
    const p = await db.progress.get(bookId);
    if (p) _progressCache.set(bookId, p);
    return p || null;
}

export async function saveProgress(progress: ReadingProgress): Promise<void> {
    await db.progress.put(progress);
    _progressCache.set(progress.bookId, progress);
}

// ── Annotations ──

function annotationKey(bookId: string, chapterIndex: number): string {
    return `${bookId}:${chapterIndex}`;
}

export async function loadAnnotations(bookId: string, chapterIndex: number): Promise<ReadingAnnotation[]> {
    const key = annotationKey(bookId, chapterIndex);
    if (_annotationsCache.has(key)) return _annotationsCache.get(key)!;
    const annots = await db.annotations.where("[bookId+chapterIndex]").equals([bookId, chapterIndex]).toArray();
    _annotationsCache.set(key, annots);
    return annots;
}

export async function saveAnnotation(annotation: ReadingAnnotation): Promise<void> {
    await db.annotations.put(annotation);
    const key = annotationKey(annotation.bookId, annotation.chapterIndex);
    const cached = _annotationsCache.get(key) || [];
    const existingIndex = cached.findIndex((item) => item.id === annotation.id);
    if (existingIndex >= 0) cached[existingIndex] = annotation;
    else cached.push(annotation);
    _annotationsCache.set(key, cached);
}

export async function saveAnnotations(annotations: ReadingAnnotation[]): Promise<void> {
    if (annotations.length === 0) return;
    await db.annotations.bulkPut(annotations);
    // Refresh cache for affected chapters
    const affected = new Set(annotations.map(a => annotationKey(a.bookId, a.chapterIndex)));
    for (const key of affected) {
        const [bookId, chapterIdx] = key.split(":");
        _annotationsCache.set(key, await db.annotations.where("[bookId+chapterIndex]").equals([bookId, Number(chapterIdx)]).toArray());
    }
}

export async function deleteAnnotation(annotationId: string): Promise<void> {
    const existing = await db.annotations.get(annotationId);
    if (!existing) return;

    await db.annotations.delete(annotationId);
    const key = annotationKey(existing.bookId, existing.chapterIndex);
    const cached = _annotationsCache.get(key);
    if (cached) {
        _annotationsCache.set(key, cached.filter((annotation) => annotation.id !== annotationId));
    }
}

// ── Reading Interaction Config ──

export function loadReadingInteractionConfig(): ReadingInteractionConfig {
    if (typeof window === "undefined") return DEFAULT_READING_INTERACTION_CONFIG;
    try {
        const raw = kvGet(READING_INTERACTION_CONFIG_KEY);
        if (!raw) return DEFAULT_READING_INTERACTION_CONFIG;
        return {
            ...DEFAULT_READING_INTERACTION_CONFIG,
            ...JSON.parse(raw),
        };
    } catch {
        return DEFAULT_READING_INTERACTION_CONFIG;
    }
}

export function saveReadingInteractionConfig(config: ReadingInteractionConfig): void {
    if (typeof window === "undefined") return;
    kvSet(READING_INTERACTION_CONFIG_KEY, JSON.stringify(config));
}

// ── Raw Files (for PDF native rendering) ──

function openRawFileDatabaseAt(version?: number): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        let request: IDBOpenDBRequest;
        try {
            request = version ? indexedDB.open(RAW_FILE_DB_NAME, version) : indexedDB.open(RAW_FILE_DB_NAME);
        } catch (err) {
            reject(err);
            return;
        }

        request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains(RAW_FILE_STORE_NAME)) {
                request.result.createObjectStore(RAW_FILE_STORE_NAME);
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(request.error);
    });
}

async function openRawFileDatabase(): Promise<IDBDatabase> {
    let idb: IDBDatabase;
    try {
        idb = await openRawFileDatabaseAt(1);
    } catch (err) {
        if (err instanceof DOMException && err.name === "VersionError") {
            idb = await openRawFileDatabaseAt(undefined);
        } else {
            throw err;
        }
    }

    if (!idb.objectStoreNames.contains(RAW_FILE_STORE_NAME)) {
        const nextVersion = idb.version + 1;
        idb.close();
        idb = await openRawFileDatabaseAt(nextVersion);
    }

    return idb;
}

export async function saveRawFile(bookId: string, data: ArrayBuffer | Blob): Promise<void> {
    const idb = await openRawFileDatabase();
    await new Promise<void>((resolve, reject) => {
        const tx = idb.transaction(RAW_FILE_STORE_NAME, "readwrite");
        tx.objectStore(RAW_FILE_STORE_NAME).put(data instanceof Blob ? data : new Blob([data]), bookId);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
    idb.close();
}

export async function deleteRawFile(bookId: string): Promise<void> {
    const idb = await openRawFileDatabase();
    await new Promise<void>((resolve, reject) => {
        const tx = idb.transaction(RAW_FILE_STORE_NAME, "readwrite");
        tx.objectStore(RAW_FILE_STORE_NAME).delete(bookId);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
    idb.close();
}

/** 逐条列出原始文件的 bookId 与大小（blob.size 只读元数据，不载入内容）。 */
export async function listRawFileSummaries(): Promise<Array<{ bookId: string; bytes: number }>> {
    try {
        const idb = await openRawFileDatabase();
        const out: Array<{ bookId: string; bytes: number }> = [];
        await new Promise<void>((resolve, reject) => {
            const tx = idb.transaction(RAW_FILE_STORE_NAME, "readonly");
            const req = tx.objectStore(RAW_FILE_STORE_NAME).openCursor();
            req.onsuccess = () => {
                const cursor = req.result;
                if (!cursor) return resolve();
                const blob = cursor.value as Blob | undefined;
                out.push({ bookId: String(cursor.primaryKey), bytes: blob?.size ?? 0 });
                cursor.continue();
            };
            req.onerror = () => reject(req.error);
        });
        idb.close();
        return out;
    } catch {
        return [];
    }
}

export async function loadRawFile(bookId: string): Promise<ArrayBuffer | null> {
    const blob = await loadRawFileBlob(bookId);
    if (!blob) return null;
    return blob.arrayBuffer();
}

export async function loadRawFileBlob(bookId: string): Promise<Blob | null> {
    try {
        const idb = await openRawFileDatabase();
        const blob = await new Promise<Blob | null>((resolve, reject) => {
            const tx = idb.transaction(RAW_FILE_STORE_NAME, "readonly");
            const req = tx.objectStore(RAW_FILE_STORE_NAME).get(bookId);
            req.onsuccess = () => resolve(req.result as Blob || null);
            req.onerror = () => reject(req.error);
        });
        idb.close();
        return blob;
    } catch {
        return null;
    }
}

// ── User Annotations（用户批注：高亮/波浪线/评论/收藏，移植自 coread）──

export async function loadUserAnnotations(bookId: string, chapterIndex: number): Promise<UserAnnotation[]> {
    const key = `${bookId}:${chapterIndex}`;
    if (_userAnnotationsCache.has(key)) return _userAnnotationsCache.get(key)!;
    const items = await db.userAnnotations.where("[bookId+chapterIndex]").equals([bookId, chapterIndex]).toArray();
    _userAnnotationsCache.set(key, items);
    return items;
}

export async function loadAllUserAnnotations(bookId: string): Promise<UserAnnotation[]> {
    const items = await db.userAnnotations.where("[bookId+chapterIndex]").between(
        [bookId, Dexie.minKey], [bookId, Dexie.maxKey]
    ).toArray();
    for (const key of _userAnnotationsCache.keys()) {
        if (key.startsWith(bookId + ":")) _userAnnotationsCache.delete(key);
    }
    return items;
}

export async function saveUserAnnotation(annotation: UserAnnotation): Promise<void> {
    await db.userAnnotations.put(annotation);
    const key = `${annotation.bookId}:${annotation.chapterIndex}`;
    const cached = _userAnnotationsCache.get(key) || [];
    const existingIndex = cached.findIndex((item) => item.id === annotation.id);
    if (existingIndex >= 0) cached[existingIndex] = annotation;
    else cached.push(annotation);
    _userAnnotationsCache.set(key, cached);
}

export async function deleteUserAnnotation(annotationId: string): Promise<void> {
    const existing = await db.userAnnotations.get(annotationId);
    if (!existing) return;
    await db.userAnnotations.delete(annotationId);
    const key = `${existing.bookId}:${existing.chapterIndex}`;
    const cached = _userAnnotationsCache.get(key);
    if (cached) {
        _userAnnotationsCache.set(key, cached.filter((item) => item.id !== annotationId));
    }
}

// ── Chapter Summaries（章节摘要，移植自 coread）──

export async function loadChapterSummary(bookId: string, chapterIndex: number): Promise<ChapterSummary | null> {
    const key = `${bookId}:${chapterIndex}`;
    if (_summariesCache.has(key)) return _summariesCache.get(key)!;
    const item = await db.summaries.get(key);
    if (item) _summariesCache.set(key, item);
    return item || null;
}

export async function saveChapterSummary(summary: ChapterSummary): Promise<void> {
    await db.summaries.put(summary);
    _summariesCache.set(`${summary.bookId}:${summary.chapterIndex}`, summary);
}

// ── Book Facts（事实卡：重要性 1-5 + append-only 修订历史）──

export async function loadBookFacts(bookId: string): Promise<BookFact[]> {
    if (_factsCache.has(bookId)) return _factsCache.get(bookId)!;
    const items = await db.facts.where("bookId").equals(bookId).toArray();
    _factsCache.set(bookId, items);
    return items;
}

export async function saveBookFact(fact: BookFact): Promise<void> {
    const existing = await db.facts.get(fact.id);
    if (existing && existing.text !== fact.text) {
        // append-only 修订历史
        fact.history = [...(existing.history || []), { text: existing.text, at: existing.updatedAt }];
        fact.createdAt = existing.createdAt;
    }
    await db.facts.put(fact);
    const cached = _factsCache.get(fact.bookId) || [];
    const idx = cached.findIndex((item) => item.id === fact.id);
    if (idx >= 0) cached[idx] = fact;
    else cached.push(fact);
    _factsCache.set(fact.bookId, cached);
}

export async function deleteBookFact(factId: string): Promise<void> {
    const existing = await db.facts.get(factId);
    if (!existing) return;
    await db.facts.delete(factId);
    const cached = _factsCache.get(existing.bookId);
    if (cached) {
        _factsCache.set(existing.bookId, cached.filter((item) => item.id !== factId));
    }
}

// ── Reading Impression（读后感受，移植自 coread impressions）──

export async function loadImpression(bookId: string): Promise<ReadingImpression | null> {
    if (_impressionsCache.has(bookId)) return _impressionsCache.get(bookId)!;
    const item = await db.impressions.get(bookId);
    if (item) _impressionsCache.set(bookId, item);
    return item || null;
}

export async function saveImpression(impression: ReadingImpression): Promise<void> {
    await db.impressions.put(impression);
    _impressionsCache.set(impression.bookId, impression);
}

// ── Trash（回收站：软删除 / 恢复 / 彻底删除）──

export async function softDeleteBook(bookId: string): Promise<void> {
    const book = await db.books.get(bookId);
    if (!book) return;
    await updateBook({ ...book, trashedAt: new Date().toISOString() });
}

export async function restoreBook(bookId: string): Promise<void> {
    const book = await db.books.get(bookId);
    if (!book) return;
    await updateBook({ ...book, trashedAt: null });
}

/** 彻底删除（回收站清空）：书 + 章节 + 进度 + 批注 + 用户批注 + 摘要 + 事实 + 感受 + 原始文件 */
export async function purgeBook(bookId: string): Promise<void> {
    await db.books.delete(bookId);
    await db.chapters.where("bookId").equals(bookId).delete();
    await db.progress.delete(bookId);
    await db.annotations.where("[bookId+chapterIndex]").between([bookId, Dexie.minKey], [bookId, Dexie.maxKey]).delete();
    await db.userAnnotations.where("[bookId+chapterIndex]").between([bookId, Dexie.minKey], [bookId, Dexie.maxKey]).delete();
    await db.summaries.where("[bookId+chapterIndex]").between([bookId, Dexie.minKey], [bookId, Dexie.maxKey]).delete();
    await db.facts.where("bookId").equals(bookId).delete();
    await db.impressions.delete(bookId);
    await deleteRawFile(bookId).catch(() => {});
    _booksCache = null;
    _booksCache = await db.books.orderBy("createdAt").reverse().toArray();
    _chaptersCache.delete(bookId);
    _progressCache.delete(bookId);
    _factsCache.delete(bookId);
    _impressionsCache.delete(bookId);
    for (const key of _annotationsCache.keys()) {
        if (key.startsWith(bookId + ":")) _annotationsCache.delete(key);
    }
    for (const key of _userAnnotationsCache.keys()) {
        if (key.startsWith(bookId + ":")) _userAnnotationsCache.delete(key);
    }
    for (const key of _summariesCache.keys()) {
        if (key.startsWith(bookId + ":")) _summariesCache.delete(key);
    }
}

// ── 导出 / 备份（移植自 coread export/backup：全量 JSON，不含原始文件）──

export type ReadingLibraryExport = {
    app: "ai-virtual-phone-reading";
    version: 1;
    exportedAt: string;
    books: Book[];
    chapters: BookChapter[];
    progress: ReadingProgress[];
    annotations: ReadingAnnotation[];
    userAnnotations: UserAnnotation[];
    summaries: ChapterSummary[];
    facts: BookFact[];
    impressions: ReadingImpression[];
};

export async function exportReadingLibrary(): Promise<ReadingLibraryExport> {
    const [books, chapters, progress, annotations, userAnnotations, summaries, facts, impressions] = await Promise.all([
        db.books.toArray(),
        db.chapters.toArray(),
        db.progress.toArray(),
        db.annotations.toArray(),
        db.userAnnotations.toArray(),
        db.summaries.toArray(),
        db.facts.toArray(),
        db.impressions.toArray(),
    ]);
    return {
        app: "ai-virtual-phone-reading",
        version: 1,
        exportedAt: new Date().toISOString(),
        books, chapters, progress, annotations, userAnnotations, summaries, facts, impressions,
    };
}

/** 从备份 JSON 恢复（覆盖当前本地书库；不含原始文件，恢复后 TXT/EPUB/PDF 原始文件需重新导入或重建） */
export async function importReadingLibrary(data: unknown): Promise<{ ok: boolean; error?: string; counts?: Record<string, number> }> {
    try {
        const parsed = data as ReadingLibraryExport;
        if (!parsed || parsed.app !== "ai-virtual-phone-reading" || !Array.isArray(parsed.books)) {
            return { ok: false, error: "不是有效的阅读备份文件（缺少 app 标识或 books）" };
        }
        await db.transaction("rw", db.books, db.chapters, db.progress, db.annotations, db.userAnnotations, db.summaries, db.facts, db.impressions, async () => {
            await Promise.all([
                db.books.clear(),
                db.chapters.clear(),
                db.progress.clear(),
                db.annotations.clear(),
                db.userAnnotations.clear(),
                db.summaries.clear(),
                db.facts.clear(),
                db.impressions.clear(),
            ]);
            await db.books.bulkPut(parsed.books || []);
            await db.chapters.bulkPut(parsed.chapters || []);
            await db.progress.bulkPut(parsed.progress || []);
            await db.annotations.bulkPut(parsed.annotations || []);
            await db.userAnnotations.bulkPut(parsed.userAnnotations || []);
            await db.summaries.bulkPut(parsed.summaries || []);
            await db.facts.bulkPut(parsed.facts || []);
            await db.impressions.bulkPut(parsed.impressions || []);
        });
        // 刷新全部缓存
        _booksCache = await db.books.orderBy("createdAt").reverse().toArray();
        _chaptersCache.clear();
        _progressCache.clear();
        _annotationsCache.clear();
        _userAnnotationsCache.clear();
        _summariesCache.clear();
        _factsCache.clear();
        _impressionsCache.clear();
        return {
            ok: true,
            counts: {
                books: (parsed.books || []).length,
                chapters: (parsed.chapters || []).length,
                userAnnotations: (parsed.userAnnotations || []).length,
            },
        };
    } catch (e) {
        return { ok: false, error: String((e as Error).message || e) };
    }
}
