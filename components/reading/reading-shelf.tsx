"use client";

import { useState, useRef, useEffect } from "react";
import { ChevronLeft, Palette, Settings, Trash2, RotateCcw, Download, Upload, FolderInput, FolderPlus } from "lucide-react";
import { loadBooks, addBook, deleteBook, saveChapters, loadProgress, saveRawFile, softDeleteBook, restoreBook, purgeBook, updateBook, exportReadingLibrary, importReadingLibrary } from "@/lib/reading-storage";
import { decodeTxtArrayBuffer, parseTxtContent, parseEpubFile, PDF_PAGES_PER_CHAPTER } from "@/lib/reading-parser";
import { loadReadingInteractionConfig } from "@/lib/reading-storage";
import type { Book, BookChapter } from "@/lib/reading-types";
import type { ReadingAppearance } from "@/lib/reading-appearance";
import { ReadingAppearanceDialog } from "./reading-appearance-dialog";
import { ReadingInteractionDialog } from "./reading-interaction-dialog";
import { kvGet, kvSet, kvRemove } from "@/lib/kv-db";

type Props = {
    onOpenBook: (book: Book) => void;
    onClose: () => void;
    appearance: ReadingAppearance;
    backgroundUrl: string | null;
    onSaveAppearance: (
        appearance: ReadingAppearance,
        options: { backgroundFile: File | null; clearBackground: boolean; customFontFile: File | null; clearCustomFont: boolean }
    ) => Promise<void>;
};

const IMPORT_DIAG_KEY = "reading-import-diagnostic-v1";

type ImportDiagnostic = {
    status: "running" | "failed";
    stage: string;
    fileName: string;
    fileSize: number;
    format?: Book["format"];
    detail?: string;
    updatedAt: string;
};

function buildImportError(stage: string, err: unknown, format?: Book["format"]): { summary: string; detail?: string } {
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    const lower = detail.toLowerCase();

    if (lower.includes("notfounderror") || lower.includes("object store")) {
        return {
            summary: `导入失败，阶段：${stage}。本地阅读数据库结构异常，刷新页面后重试即可自动修复。`,
            detail,
        };
    }

    if (lower.includes("quotaexceeded")) {
        return {
            summary: `导入失败，阶段：${stage}。当前浏览器可用存储空间不足，原始文件没能保存成功。`,
            detail,
        };
    }

    if (lower.includes("database") || lower.includes("indexeddb") || lower.includes("idbdatabase")) {
        return {
            summary: `导入失败，阶段：${stage}。浏览器本地数据库写入失败。`,
            detail,
        };
    }

    if (lower.includes("out of memory") || lower.includes("memory") || lower.includes("allocation") || lower.includes("unable to allocate")) {
        return {
            summary: `导入失败，阶段：${stage}。当前手机内存不足，这份${format === "pdf" ? " PDF " : ""}文件对浏览器来说太大了。`,
            detail,
        };
    }

    if (lower.includes("abort") || lower.includes("interrupted")) {
        return {
            summary: `导入失败，阶段：${stage}。浏览器中断了这次文件处理，手机上常见于切后台、内存紧张或系统回收。`,
            detail,
        };
    }

    if (lower.includes("failed to load pdf.js") || lower.includes("pdf")) {
        return {
            summary: `导入失败，阶段：${stage}。PDF 引擎没能完成这份文件的读取。`,
            detail,
        };
    }

    return {
        summary: `导入失败，阶段：${stage}。`,
        detail,
    };
}

export function ReadingShelf({ onOpenBook, onClose, appearance, backgroundUrl, onSaveAppearance }: Props) {
    const [books, setBooks] = useState<Book[]>([]);
    const [progressMap, setProgressMap] = useState<Record<string, {
        chapterIndex: number;
        total: number;
        hasProgress: boolean;
        fraction?: number;
        current?: number;
        pageTotal?: number;
        scope?: "book" | "chapter";
    }>>({});
    const [importing, setImporting] = useState(false);
    const [importStatus, setImportStatus] = useState<string | null>(null);
    const [importError, setImportError] = useState<{ summary: string; detail?: string } | null>(null);
    const [search, setSearch] = useState("");
    const [viewMode, setViewMode] = useState<"shelf" | "trash">("shelf");
    const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
    const [moveTarget, setMoveTarget] = useState<Book | null>(null);
    const [moveCategory, setMoveCategory] = useState("未分类");
    const [showNewCategoryDialog, setShowNewCategoryDialog] = useState(false);
    const [newCategoryName, setNewCategoryName] = useState("");
    const [exporting, setExporting] = useState(false);
    const libraryFileRef = useRef<HTMLInputElement>(null);
    const [showAppearanceDialog, setShowAppearanceDialog] = useState(false);
    const [showInteractionDialog, setShowInteractionDialog] = useState(false);
    const fileRef = useRef<HTMLInputElement>(null);

    const persistImportDiagnostic = (payload: ImportDiagnostic | null) => {
        if (typeof window === "undefined") return;
        if (!payload) {
            kvRemove(IMPORT_DIAG_KEY);
            return;
        }
        kvSet(IMPORT_DIAG_KEY, JSON.stringify(payload));
    };

    useEffect(() => {
        const allBooks = loadBooks();
        setBooks(allBooks);
        (async () => {
            const map: typeof progressMap = {};
            for (const b of allBooks) {
                const p = await loadProgress(b.id);
                map[b.id] = {
                    chapterIndex: p?.chapterIndex ?? 0,
                    total: b.totalChapters,
                    hasProgress: !!p,
                    fraction: p?.progressFraction,
                    current: p?.progressCurrent,
                    pageTotal: p?.progressTotal,
                    scope: p?.progressScope,
                };
            }
            setProgressMap(map);
        })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        if (typeof window === "undefined") return;
        try {
            const raw = kvGet(IMPORT_DIAG_KEY);
            if (!raw) return;
            const saved = JSON.parse(raw) as ImportDiagnostic;
            if (!saved?.stage || !saved?.updatedAt) return;

            const timeLabel = new Date(saved.updatedAt).toLocaleString();
            const sizeLabel = saved.fileSize > 0 ? `，文件大小约 ${(saved.fileSize / 1024 / 1024).toFixed(1)} MB` : "";
            const summary = saved.status === "running"
                ? `上次导入在「${saved.stage}」阶段中断了。文件：${saved.fileName}${sizeLabel}。时间：${timeLabel}。`
                : `上次导入在「${saved.stage}」阶段失败。文件：${saved.fileName}${sizeLabel}。时间：${timeLabel}。`;
            setImportError({ summary, detail: saved.detail });
        } catch {
            // Ignore broken diagnostics.
        }
    }, []);

    // Dismiss must also clear the persisted diagnostic — it's reloaded on every
    // mount, which is what made the old inline banner impossible to get rid of.
    const dismissImportError = () => {
        setImportError(null);
        persistImportDiagnostic(null);
    };

    const activeBooks = books.filter((b) => !b.trashedAt);
    const trashBooks = books.filter((b) => Boolean(b.trashedAt));
    const categories = useMemo(() => {
        const set = new Set<string>();
        for (const b of activeBooks) {
            const c = b.category?.trim();
            if (c) set.add(c);
        }
        return Array.from(set).sort((a, b) => a.localeCompare(b, "zh"));
    }, [activeBooks]);
    const filteredBooks = useMemo(() => {
        let list = viewMode === "trash" ? trashBooks : activeBooks;
        if (selectedCategory && viewMode === "shelf") {
            list = list.filter((b) => (b.category?.trim() || "未分类") === selectedCategory);
        }
        if (search.trim()) {
            list = list.filter(b => b.title.toLowerCase().includes(search.toLowerCase()) || b.author?.toLowerCase().includes(search.toLowerCase()));
        }
        return list;
    }, [activeBooks, trashBooks, viewMode, selectedCategory, search]);

    const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        e.target.value = "";
        setImporting(true);
        setImportError(null);
        setImportStatus("正在准备导入…");
        let importStage = "准备导入";
        const ext = file.name.split(".").pop()?.toLowerCase();
        const detectedFormat = ext === "pdf" ? "pdf" : ext === "epub" ? "epub" : "txt";
        persistImportDiagnostic({
            status: "running",
            stage: importStage,
            fileName: file.name,
            fileSize: file.size,
            format: detectedFormat,
            updatedAt: new Date().toISOString(),
        });

        try {
            let parsed;
            let format: Book["format"];
            let rawFile: Blob | null = null;

            if (ext === "txt") {
                importStage = "读取 TXT 文件";
                setImportStatus("正在读取 TXT 文件…");
                persistImportDiagnostic({
                    status: "running",
                    stage: importStage,
                    fileName: file.name,
                    fileSize: file.size,
                    format: "txt",
                    updatedAt: new Date().toISOString(),
                });
                const readingConfig = loadReadingInteractionConfig();
                const { text } = decodeTxtArrayBuffer(await file.arrayBuffer(), readingConfig.txtEncoding);
                parsed = parseTxtContent(text, file.name, readingConfig.paragraphMode);
                format = "txt";
            } else if (ext === "epub") {
                importStage = "读取 EPUB 文件";
                setImportStatus("正在读取 EPUB 文件…");
                persistImportDiagnostic({
                    status: "running",
                    stage: importStage,
                    fileName: file.name,
                    fileSize: file.size,
                    format: "epub",
                    updatedAt: new Date().toISOString(),
                });
                const buffer = await file.arrayBuffer();
                importStage = "解析 EPUB 内容";
                setImportStatus("正在解析 EPUB 内容…");
                persistImportDiagnostic({
                    status: "running",
                    stage: importStage,
                    fileName: file.name,
                    fileSize: file.size,
                    format: "epub",
                    updatedAt: new Date().toISOString(),
                });
                parsed = await parseEpubFile(buffer, file.name);
                format = "epub";
            } else if (ext === "pdf") {
                rawFile = file;
                importStage = "创建 PDF 导入记录";
                setImportStatus("正在创建 PDF 导入记录…");
                persistImportDiagnostic({
                    status: "running",
                    stage: importStage,
                    fileName: file.name,
                    fileSize: file.size,
                    format: "pdf",
                    updatedAt: new Date().toISOString(),
                });
                parsed = {
                    title: file.name.replace(/\.[^.]+$/, "") || "未命名",
                    chapters: [{ title: `第1-${PDF_PAGES_PER_CHAPTER}页`, paragraphs: [] }],
                    totalPages: 0,
                };
                format = "pdf";
            } else {
                alert("不支持的格式，请上传 TXT、EPUB 或 PDF 文件");
                persistImportDiagnostic(null);
                return;
            }

            const bookId = `book_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
            const book: Book = {
                id: bookId,
                title: parsed.title,
                author: parsed.author,
                format,
                totalChapters: parsed.chapters.length,
                createdAt: new Date().toISOString(),
            };

            const chapters: BookChapter[] = parsed.chapters.map((ch, i) => {
                if (format === "pdf") {
                    const pageStart = i * PDF_PAGES_PER_CHAPTER + 1;
                    const totalPages = "totalPages" in parsed ? (parsed as { totalPages: number }).totalPages : pageStart + PDF_PAGES_PER_CHAPTER - 1;
                    const pageEnd = Math.min(pageStart + PDF_PAGES_PER_CHAPTER - 1, totalPages);
                    return {
                        id: `${bookId}_ch${i}`,
                        bookId,
                        index: i,
                        title: ch.title,
                        paragraphs: [],
                        pageStart,
                        pageEnd,
                    };
                }
                return { id: `${bookId}_ch${i}`, bookId, index: i, title: ch.title, paragraphs: ch.paragraphs };
            });

            importStage = "写入书架数据";
            setImportStatus("正在写入书架数据…");
            persistImportDiagnostic({
                status: "running",
                stage: importStage,
                fileName: file.name,
                fileSize: file.size,
                format,
                updatedAt: new Date().toISOString(),
            });
            await addBook(book);
            await saveChapters(bookId, chapters);
            if (rawFile) {
                try {
                    importStage = format === "pdf" ? "保存原始 PDF 文件" : "保存原始文件";
                    setImportStatus(format === "pdf" ? "正在保存原始 PDF 文件…" : "正在保存原始文件…");
                    persistImportDiagnostic({
                        status: "running",
                        stage: importStage,
                        fileName: file.name,
                        fileSize: file.size,
                        format,
                        updatedAt: new Date().toISOString(),
                    });
                    await saveRawFile(bookId, rawFile);
                } catch (saveErr) {
                    await deleteBook(bookId).catch(() => {});
                    const built = buildImportError(importStage, saveErr, format);
                    setImportError(built);
                    persistImportDiagnostic({
                        status: "failed",
                        stage: importStage,
                        fileName: file.name,
                        fileSize: file.size,
                        format,
                        detail: built.detail || built.summary,
                        updatedAt: new Date().toISOString(),
                    });
                    return;
                }
            }
            setBooks(loadBooks());
            setProgressMap(prev => ({ ...prev, [bookId]: { chapterIndex: 0, total: chapters.length, hasProgress: false } }));
            setImportStatus(null);
            persistImportDiagnostic(null);
        } catch (err) {
            console.error("[Reading] Import failed:", err);
            const format = detectedFormat;
            const built = buildImportError(importStage, err, format);
            setImportError(built);
            persistImportDiagnostic({
                status: "failed",
                stage: importStage,
                fileName: file.name,
                fileSize: file.size,
                format,
                detail: built.detail || built.summary,
                updatedAt: new Date().toISOString(),
            });
        } finally {
            setImporting(false);
            setImportStatus(null);
        }
    };

    const handleDelete = async (bookId: string) => {
        if (!confirm("移入回收站？之后可在回收站恢复。")) return;
        await softDeleteBook(bookId);
        setBooks(loadBooks());
    };
    const handleRestore = async (bookId: string) => {
        await restoreBook(bookId);
        setBooks(loadBooks());
    };
    const handlePurge = async (bookId: string) => {
        if (!confirm("彻底删除这本书？此操作不可恢复！")) return;
        await purgeBook(bookId);
        setBooks(loadBooks());
    };
    const handleMoveBook = async () => {
        if (!moveTarget) return;
        const finalCat = newCategoryName.trim() || (moveCategory === "未分类" ? "" : moveCategory);
        const updated: Book = { ...moveTarget, category: finalCat || undefined };
        try {
            await updateBook(updated);
        } catch (err) {
            console.error("[Reading] move book failed:", err);
            alert("移动分类失败，请重试");
        }
        setBooks(loadBooks());
        setMoveTarget(null);
        setNewCategoryName("");
    };
    const handleCreateCategory = async () => {
        const name = newCategoryName.trim();
        if (!name) return;
        setShowNewCategoryDialog(false);
        setNewCategoryName("");
        setSelectedCategory(name);
        setViewMode("shelf");
    };
    const handleExportLibrary = async () => {
        setExporting(true);
        try {
            const data = await exportReadingLibrary();
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `ai-virtual-phone-reading-${new Date().toISOString().slice(0, 10)}.json`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 3000);
        } catch (err) {
            console.error("[Reading] export failed:", err);
            alert("导出失败，请重试");
        } finally {
            setExporting(false);
        }
    };
    const handleLibraryImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        e.target.value = "";
        try {
            const text = await file.text();
            const data = JSON.parse(text);
            const result = await importReadingLibrary(data);
            setBooks(loadBooks());
            if (result.ok) {
                alert(`导入成功：书 ${result.counts?.books ?? "?"} 本、批注 ${result.counts?.annotations ?? "?"} 条、摘要 ${result.counts?.summaries ?? "?"} 条、事实卡 ${result.counts?.facts ?? "?"} 条、感受 ${result.counts?.impressions ?? "?"} 条`);
            } else {
                alert(`导入失败：${result.error}`);
            }
        } catch (err) {
            console.error("[Reading] library import failed:", err);
            alert("导入失败：文件不是有效的书库 JSON");
        }
    };

    const formatBadge = (f: string) => f.toUpperCase();

    const coverGradients = ["linen", "mist", "graphite", "sage", "cream", "parchment"] as const;
    const coverLayouts = ["layout-1", "layout-2", "layout-3", "layout-4"] as const;

    return (
        <div className="reading-app-surface absolute inset-0 z-[100] flex flex-col">
            <header className="reading-shelf-header">
                <div className="reading-shelf-appbar">
                    <button className="reading-shelf-back" type="button" onClick={onClose} aria-label="返回">
                        <ChevronLeft size={22} strokeWidth={2.5} />
                    </button>
                    <div className="reading-shelf-actions">
                        <button className="reading-shelf-action-btn" type="button" onClick={() => { void handleExportLibrary(); }} aria-label="导出书库" disabled={exporting}>
                        {exporting ? <span style={{ fontSize: 10 }}>…</span> : <Download size={16} strokeWidth={1.7} />}
                    </button>
                    <label className="reading-shelf-action-btn" style={{ cursor: "pointer" }} aria-label="导入书库">
                        <Upload size={16} strokeWidth={1.7} />
                        <input ref={libraryFileRef} type="file" accept=".json,application/json" onChange={handleLibraryImport} className="hidden" />
                    </label>
                    <button className="reading-shelf-action-btn" type="button" onClick={() => setShowInteractionDialog(true)} aria-label="阅读设置">
                            <Settings size={16} strokeWidth={1.7} />
                        </button>
                        <button className="reading-shelf-action-btn" type="button" onClick={() => setShowAppearanceDialog(true)} aria-label="阅读外观">
                            <Palette size={16} strokeWidth={1.7} />
                        </button>
                        <label className="reading-shelf-action-btn reading-shelf-action-primary" style={{ cursor: "pointer" }}>
                            <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M12 5v14M5 12h14" />
                            </svg>
                            <input ref={fileRef} type="file" accept=".txt,.epub,.pdf" onChange={handleFileUpload} className="hidden" disabled={importing} />
                        </label>
                    </div>
                </div>
                <div className="reading-shelf-title-stack">
                    <h1 className="reading-shelf-title">{viewMode === "trash" ? "回收站" : "书架"}</h1>
                    <span className="reading-shelf-subtitle">{viewMode === "trash" ? `${trashBooks.length} BOOKS IN TRASH` : `${activeBooks.length} BOOKS IN YOUR LIBRARY`}</span>
                </div>
                <div className="reading-shelf-tabs">
                    <button
                        type="button"
                        className={`reading-shelf-tab${viewMode === "shelf" ? " reading-shelf-tab--active" : ""}`}
                        onClick={() => { setViewMode("shelf"); setSelectedCategory(null); }}
                    >
                        书架
                    </button>
                    <button
                        type="button"
                        className={`reading-shelf-tab${viewMode === "trash" ? " reading-shelf-tab--active" : ""}`}
                        onClick={() => setViewMode("trash")}
                    >
                        回收站{trashBooks.length > 0 ? ` (${trashBooks.length})` : ""}
                    </button>
                </div>
            </header>

            <div className="reading-shelf-body">
                {viewMode === "shelf" && (
                    <div className="reading-category-chips">
                        <button
                            type="button"
                            className={`reading-category-chip${!selectedCategory ? " reading-category-chip--active" : ""}`}
                            onClick={() => setSelectedCategory(null)}
                        >
                            全部
                        </button>
                        {categories.map((c) => (
                            <button
                                key={c}
                                type="button"
                                className={`reading-category-chip${selectedCategory === c ? " reading-category-chip--active" : ""}`}
                                onClick={() => setSelectedCategory(selectedCategory === c ? null : c)}
                            >
                                {c}
                            </button>
                        ))}
                        <button
                            type="button"
                            className="reading-category-chip reading-category-chip--new"
                            onClick={() => { setNewCategoryName(""); setShowNewCategoryDialog(true); }}
                        >
                            <FolderPlus size={12} strokeWidth={1.8} />新分类
                        </button>
                    </div>
                )}
                
                <div className="px-4 pb-3">
                    <div className="reading-search-bar">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                        <input
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                            placeholder={`搜索 ${books.length} 本书`}
                            className="reading-search-input"
                        />
                    </div>
                </div>

                {importing && (
                    <div className="text-center ts-13 py-2" style={{ color: "var(--reading-warm-brown, #8a5a2b)" }}>
                        {importStatus ? `导入中：${importStatus}` : "导入中..."}
                    </div>
                )}
                {importError && (
                    <div className="modal-overlay" data-ui="modal" onClick={dismissImportError}>
                        <div className="reading-import-error-card reading-import-error-dialog" onClick={(e) => e.stopPropagation()}>
                            <button type="button" className="reading-import-error-close" onClick={dismissImportError} aria-label="关闭">✕</button>
                            <div className="reading-import-error-kicker">IMPORT ERROR</div>
                            <div className="ts-13 font-medium" style={{ color: "#2f261f" }}>导入失败</div>
                            <div className="ts-12 mt-1" style={{ color: "#7f7266" }}>{importError.summary}</div>
                            {importError.detail && (
                                <div className="ts-11 mt-2 break-all reading-import-error-detail" style={{ color: "#a39487" }}>{importError.detail}</div>
                            )}
                            <button type="button" className="reading-import-error-ok" onClick={dismissImportError}>知道了</button>
                        </div>
                    </div>
                )}

                {filteredBooks.length === 0 ? (
                    <div className="py-10 text-center ts-14" style={{ color: "var(--reading-warm-ink-tertiary, #999)" }}>
                        {viewMode === "trash"
                            ? (trashBooks.length === 0 ? "回收站是空的" : "没有匹配的书籍")
                            : selectedCategory
                                ? `「${selectedCategory}」分类还没有书籍，点书籍栏的文件夹图标可移动分类`
                                : books.length === 0 ? "还没有书籍，点右上角 + 导入" : "没有匹配的书籍"}
                    </div>
                ) : (
                    <div className="reading-book-list">
                        {filteredBooks.map(book => {
                            const prog = progressMap[book.id];
                            const fallbackFraction = prog?.hasProgress && prog.total > 0
                                ? Math.min(1, Math.max(0, (prog.chapterIndex + 1) / prog.total))
                                : 0;
                            const progressFraction = prog?.hasProgress
                                ? Math.min(1, Math.max(0, prog.fraction ?? fallbackFraction))
                                : 0;
                            const progressPct = Math.round(progressFraction * 100);
                            const progressMeta = !prog?.hasProgress
                                ? null
                                : prog.scope === "book" && prog.current && prog.pageTotal
                                    ? `${prog.current}/${prog.pageTotal}`
                                    : prog.current && prog.pageTotal
                                        ? `第${Math.max(1, prog.chapterIndex + 1)}章 · ${prog.current}/${prog.pageTotal}`
                                        : `第${Math.max(1, prog.chapterIndex + 1)}/${Math.max(1, prog.total)}章`;
                            const gradient = coverGradients[book.title.length % coverGradients.length];
                            const layout = coverLayouts[(book.title.length + (book.author?.length || 0)) % coverLayouts.length];
                            return (
                                <div key={book.id} className="reading-list-item" onClick={() => onOpenBook(book)}>
                                    <div className={`reading-list-cover reading-list-cover--${gradient} reading-list-cover--${layout}`}>
                                        <span className="reading-list-cover-author">{book.author || ""}</span>
                                        <span className="reading-list-cover-title">{book.title}</span>
                                    </div>
                                    <div className="reading-list-info">
                                        <span className="reading-list-title">{book.title}</span>
                                        {book.author && <span className="reading-list-author">{book.author}</span>}
                                        <div className="reading-list-meta">
                                            <span className="reading-list-badge">{formatBadge(book.format)}</span>
                                            <span>{book.totalChapters}章</span>
                                        </div>
                                        <div className="reading-list-progress-row">
                                            <span className="reading-list-progress-label">
                                                {prog?.hasProgress ? `阅读进度 ${progressPct}%` : "未开始阅读"}
                                            </span>
                                            {progressMeta && (
                                                <span className="reading-list-progress-meta">
                                                    {progressMeta}
                                                </span>
                                            )}
                                        </div>
                                        <div className="reading-list-progress-track" aria-hidden="true">
                                            <div className="reading-list-progress-fill" style={{ width: `${prog?.hasProgress ? progressPct : 0}%` }} />
                                        </div>
                                    </div>
                                    <div className="reading-list-actions">
                                        {viewMode === "shelf" ? (
                                            <>
                                                <button
                                                    className="reading-list-delete"
                                                    onClick={(e) => { e.stopPropagation(); setMoveTarget(book); setMoveCategory(book.category?.trim() || "未分类"); }}
                                                    aria-label="移动分类"
                                                >
                                                    <FolderInput size={14} strokeWidth={1.5} />
                                                </button>
                                                <button
                                                    className="reading-list-delete"
                                                    onClick={(e) => { e.stopPropagation(); handleDelete(book.id); }}
                                                    aria-label="移入回收站"
                                                >
                                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                                        <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                                                    </svg>
                                                </button>
                                            </>
                                        ) : (
                                            <>
                                                <button
                                                    className="reading-list-delete reading-list-delete--restore"
                                                    onClick={(e) => { e.stopPropagation(); handleRestore(book.id); }}
                                                    aria-label="恢复"
                                                >
                                                    <RotateCcw size={14} strokeWidth={1.5} />
                                                </button>
                                                <button
                                                    className="reading-list-delete reading-list-delete--danger"
                                                    onClick={(e) => { e.stopPropagation(); handlePurge(book.id); }}
                                                    aria-label="彻底删除"
                                                >
                                                    <Trash2 size={14} strokeWidth={1.5} />
                                                </button>
                                            </>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}

                <div className="reading-shelf-footer">
                    {viewMode === "trash" ? `回收站 ${trashBooks.length} 本` : `共 ${activeBooks.length} 本书籍`}
                </div>
            </div>

            {showAppearanceDialog && (
                <ReadingAppearanceDialog
                    appearance={appearance}
                    backgroundUrl={backgroundUrl}
                    onClose={() => setShowAppearanceDialog(false)}
                    onSave={onSaveAppearance}
                />
            )}

            {showInteractionDialog && (
                <ReadingInteractionDialog onClose={() => setShowInteractionDialog(false)} />
            )}
            {moveTarget && (
                <div className="modal-overlay" data-ui="modal" onClick={() => setMoveTarget(null)}>
                    <div className="modal-dialog" data-ui="modal-dialog" onClick={(e) => e.stopPropagation()}>
                        <div className="modal-header" data-ui="modal-header">
                            <h3 className="modal-title">移动《{moveTarget.title}》到分类</h3>
                        </div>
                        <div className="modal-body" data-ui="modal-body" style={{ textAlign: "left", width: "100%" }}>
                            <div className="reading-move-categories">
                                <button
                                    type="button"
                                    className={`reading-move-cat${moveCategory === "未分类" ? " reading-move-cat--active" : ""}`}
                                    onClick={() => setMoveCategory("未分类")}
                                >
                                    未分类
                                </button>
                                {categories.map((c) => (
                                    <button
                                        key={c}
                                        type="button"
                                        className={`reading-move-cat${moveCategory === c ? " reading-move-cat--active" : ""}`}
                                        onClick={() => setMoveCategory(c)}
                                    >
                                        {c}
                                    </button>
                                ))}
                            </div>
                            <input
                                className="reading-category-input"
                                value={newCategoryName}
                                onChange={(e) => setNewCategoryName(e.target.value)}
                                placeholder="或输入新分类名…"
                            />
                        </div>
                        <div className="modal-footer" data-ui="modal-footer">
                            <button className="ui-btn ui-btn-outline" onClick={() => setMoveTarget(null)}>取消</button>
                            <button className="ui-btn ui-btn-primary" onClick={() => { void handleMoveBook(); }}>确定</button>
                        </div>
                    </div>
                </div>
            )}
            {showNewCategoryDialog && (
                <div className="modal-overlay" data-ui="modal" onClick={() => setShowNewCategoryDialog(false)}>
                    <div className="modal-dialog" data-ui="modal-dialog" onClick={(e) => e.stopPropagation()}>
                        <div className="modal-header" data-ui="modal-header">
                            <h3 className="modal-title">新建分类</h3>
                        </div>
                        <div className="modal-body" data-ui="modal-body" style={{ textAlign: "left", width: "100%" }}>
                            <input
                                className="reading-category-input"
                                value={newCategoryName}
                                onChange={(e) => setNewCategoryName(e.target.value)}
                                placeholder="输入分类名，如：小说 / 传记 / 工具书…"
                            />
                        </div>
                        <div className="modal-footer" data-ui="modal-footer">
                            <button className="ui-btn ui-btn-outline" onClick={() => setShowNewCategoryDialog(false)}>取消</button>
                            <button className="ui-btn ui-btn-primary" onClick={() => { void handleCreateCategory(); }}>创建</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
