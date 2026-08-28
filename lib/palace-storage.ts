// lib/palace-storage.ts
// 记忆宫殿 v3 —— IndexedDB 持久化
// 五个 store：nodes（记忆节点）/ links（链接图）/ plates（房间门牌）/
// boxes（事件盒）/ digest_reports（消化日志）。
// 与 v2 的 ai_phone_memory_db_v1 完全独立，互不影响；
// 迁移通过 migrateLegacyEntriesToPalace 显式执行（幂等，按角色打完成标记）。
import type {
    MemoryNode,
    MemoryLink,
    PlateEntry,
    EventBox,
    DigestReport,
    PlateRoom,
    MemoryRoom,
} from "./palace-types";
import { mapLegacyTypeToRoom, mapLegacyImportance } from "./palace-types";
import type { MemoryEntry } from "./memory-types";
import { loadMemoryEntriesByType } from "./memory-storage";
import { kvGet, kvSet } from "./kv-db";
import { openIndexedDbAtLeast } from "./idb-open";

const DB_NAME = "ai_phone_palace_db_v1";
const DB_VERSION = 1;
const NODES = "nodes";
const LINKS = "links";
const PLATES = "plates";
const BOXES = "boxes";
const DIGEST_REPORTS = "digest_reports";
const MIGRATION_KEY = "palace_migrated_v3_";

function hasBrowserApi(): boolean {
    return typeof window !== "undefined" && typeof indexedDB !== "undefined";
}

function ensureIndex(store: IDBObjectStore, name: string, keyPath: string | string[]): void {
    if (!store.indexNames.contains(name)) {
        store.createIndex(name, keyPath, { unique: false });
    }
}

async function openDb(): Promise<IDBDatabase | null> {
    if (!hasBrowserApi()) return null;
    return openIndexedDbAtLeast(DB_NAME, DB_VERSION, (db, _oldVersion, tx) => {
        const ensure = (name: string, indexes: Array<[string, string | string[]]>) => {
            let store: IDBObjectStore;
            if (!db.objectStoreNames.contains(name)) {
                store = db.createObjectStore(name, { keyPath: "id" });
            } else {
                store = tx!.objectStore(name);
            }
            for (const [idxName, keyPath] of indexes) ensureIndex(store, idxName, keyPath);
        };
        ensure(NODES, [["by_character", "characterId"], ["by_character_room", ["characterId", "room"]], ["by_character_created", ["characterId", "createdAt"]]]);
        ensure(LINKS, [["by_character", "characterId"], ["by_character_from", ["characterId", "fromId"]], ["by_character_to", ["characterId", "toId"]]]);
        ensure(PLATES, [["by_character", "characterId"], ["by_character_room", ["characterId", "plateRoom"]]]);
        ensure(BOXES, [["by_character", "characterId"]]);
        ensure(DIGEST_REPORTS, [["by_character", "characterId"]]);
    }).catch(() => null);
}

function runRequest<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function withStore<T>(
    storeName: string,
    mode: IDBTransactionMode,
    fn: (store: IDBObjectStore) => IDBRequest<T> | Promise<T>,
): Promise<T | null> {
    const db = await openDb();
    if (!db) return null;
    try {
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
        const raw = await fn(store);
        const result: T = raw && typeof raw === "object" && "onsuccess" in raw && "result" in raw
            ? await runRequest(raw as IDBRequest<T>)
            : raw;
        await new Promise<void>((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
        return result;
    } finally {
        db.close();
    }
}

// ─── 记忆节点 CRUD ────────────────────────────────────
export async function savePalaceNode(node: MemoryNode): Promise<void> {
    await withStore(NODES, "readwrite", s => s.put(node));
}

export async function bulkPutPalaceNodes(nodes: MemoryNode[]): Promise<void> {
    if (nodes.length === 0) return;
    await withStore(NODES, "readwrite", async s => {
        for (const n of nodes) {
            await runRequest(s.put(n));
        }
    });
}

export async function loadPalaceNodes(characterId: string): Promise<MemoryNode[]> {
    const res = await withStore<MemoryNode[]>(NODES, "readonly", s =>
        runRequest(s.index("by_character").getAll(characterId) as IDBRequest<MemoryNode[]>)
    );
    return res ?? [];
}

export async function loadPalaceNodesByRoom(characterId: string, room: MemoryRoom): Promise<MemoryNode[]> {
    const res = await withStore<MemoryNode[]>(NODES, "readonly", s =>
        runRequest(s.index("by_character_room").getAll([characterId, room]) as IDBRequest<MemoryNode[]>)
    );
    return res ?? [];
}

export async function deletePalaceNode(id: string): Promise<void> {
    await withStore(NODES, "readwrite", s => s.delete(id));
}

export async function deletePalaceNodes(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await withStore(NODES, "readwrite", async s => {
        for (const id of ids) await runRequest(s.delete(id));
    });
}

// ─── 链接图 CRUD ──────────────────────────────────────
export async function savePalaceLink(link: MemoryLink): Promise<void> {
    await withStore(LINKS, "readwrite", s => s.put(link));
}

export async function bulkPutPalaceLinks(links: MemoryLink[]): Promise<void> {
    if (links.length === 0) return;
    await withStore(LINKS, "readwrite", async s => {
        for (const l of links) await runRequest(s.put(l));
    });
}

export async function loadPalaceLinks(characterId: string): Promise<MemoryLink[]> {
    const res = await withStore<MemoryLink[]>(LINKS, "readonly", s =>
        runRequest(s.index("by_character").getAll(characterId) as IDBRequest<MemoryLink[]>)
    );
    return res ?? [];
}

export async function deletePalaceLinksByNode(characterId: string, nodeId: string): Promise<void> {
    const links = await loadPalaceLinks(characterId);
    const dead = links.filter(l => l.fromId === nodeId || l.toId === nodeId);
    if (dead.length === 0) return;
    await withStore(LINKS, "readwrite", async s => {
        for (const l of dead) await runRequest(s.delete(l.id));
    });
}

// ─── 房间门牌 CRUD ────────────────────────────────────
export async function savePalacePlate(plate: PlateEntry): Promise<void> {
    await withStore(PLATES, "readwrite", s => s.put(plate));
}

export async function loadPalacePlates(characterId: string): Promise<PlateEntry[]> {
    const res = await withStore<PlateEntry[]>(PLATES, "readonly", s =>
        runRequest(s.index("by_character").getAll(characterId) as IDBRequest<PlateEntry[]>)
    );
    return res ?? [];
}

export async function loadPalacePlatesByRoom(characterId: string, plateRoom: PlateRoom): Promise<PlateEntry[]> {
    const res = await withStore<PlateEntry[]>(PLATES, "readonly", s =>
        runRequest(s.index("by_character_room").getAll([characterId, plateRoom]) as IDBRequest<PlateEntry[]>)
    );
    return res ?? [];
}

export async function replacePalacePlates(characterId: string, plateRoom: PlateRoom, plates: PlateEntry[]): Promise<void> {
    const existing = await loadPalacePlatesByRoom(characterId, plateRoom);
    const keepIds = new Set(plates.map(p => p.id));
    const toDelete = existing.filter(p => !keepIds.has(p.id));
    await withStore(PLATES, "readwrite", async s => {
        for (const d of toDelete) await runRequest(s.delete(d.id));
        for (const p of plates) await runRequest(s.put(p));
    });
}

export async function deletePalacePlate(id: string): Promise<void> {
    await withStore(PLATES, "readwrite", s => s.delete(id));
}

// ─── 事件盒 CRUD ──────────────────────────────────────
export async function savePalaceBox(box: EventBox): Promise<void> {
    await withStore(BOXES, "readwrite", s => s.put(box));
}

export async function loadPalaceBoxes(characterId: string): Promise<EventBox[]> {
    const res = await withStore<EventBox[]>(BOXES, "readonly", s =>
        runRequest(s.index("by_character").getAll(characterId) as IDBRequest<EventBox[]>)
    );
    return res ?? [];
}

export async function deletePalaceBox(id: string): Promise<void> {
    await withStore(BOXES, "readwrite", s => s.delete(id));
}

// ─── 消化日志 ─────────────────────────────────────────
export async function saveDigestReport(report: DigestReport): Promise<void> {
    await withStore(DIGEST_REPORTS, "readwrite", s => s.put(report));
}

export async function loadDigestReports(characterId: string, limit = 30): Promise<DigestReport[]> {
    const res = await withStore<DigestReport[]>(DIGEST_REPORTS, "readonly", s =>
        runRequest(s.index("by_character").getAll(characterId) as IDBRequest<DigestReport[]>)
    );
    const all = res ?? [];
    all.sort((a, b) => b.timestamp - a.timestamp);
    return all.slice(0, limit);
}

// ─── 清理 ─────────────────────────────────────────────
export async function clearPalaceData(characterId: string): Promise<void> {
    for (const storeName of [NODES, LINKS, PLATES, BOXES, DIGEST_REPORTS]) {
        await withStore(storeName, "readwrite", async s => {
            const all = await runRequest(s.index("by_character").getAllKeys(characterId) as IDBRequest<IDBValidKey[]>);
            for (const key of all ?? []) await runRequest(s.delete(key));
        });
    }
}

// ─── v2 → v3 迁移 ─────────────────────────────────────
/** 单条 v2 MemoryEntry → v3 MemoryNode */
export function legacyEntryToPalaceNode(entry: MemoryEntry): MemoryNode {
    const createdAtMs = new Date(entry.createdAt).getTime();
    const now = Date.now();
    return {
        id: entry.id,
        characterId: entry.characterId,
        content: entry.content,
        room: mapLegacyTypeToRoom(entry.type),
        tags: [],
        entities: undefined,
        importance: mapLegacyImportance(entry.importance),
        mood: undefined,
        embedded: Boolean(entry.embedding && entry.embedding.length > 0),
        embedding: entry.embedding,
        createdAt: Number.isFinite(createdAtMs) ? createdAtMs : now,
        lastAccessedAt: entry.lastAccessedAt ? new Date(entry.lastAccessedAt).getTime() : now,
        accessCount: entry.accessCount ?? 0,
        pinnedUntil: null,
        sourceId: null,
        origin: "import",
        digestedAt: null,
        status: entry.status ?? "active",
        quote: entry.quote,
        quoteSource: entry.quoteSource,
        eventBoxId: null,
        isBoxSummary: false,
    };
}

/**
 * 把 v2 全部记忆迁移进宫殿（幂等：同一角色只迁移一次）。
 * - core → 用户房；long_term → 客厅
 * - heat → 由房间衰减曲线接管（accessCount/lastAccessedAt 保留）
 * - 保真层字段（status/quote）原样携带
 * 迁移后不删除 v2 数据（可回退）；宫殿开关开启后 v2 不再参与注入。
 */
export async function migrateLegacyEntriesToPalace(characterId: string): Promise<{ migrated: number }> {
    const done = kvGet(`${MIGRATION_KEY}${characterId}`);
    if (done === "1") return { migrated: 0 };
    const longTerm = await loadMemoryEntriesByType(characterId, "long_term");
    const core = await loadMemoryEntriesByType(characterId, "core");
    const all = [...longTerm, ...core];
    if (all.length === 0) {
        kvSet(`${MIGRATION_KEY}${characterId}`, "1");
        return { migrated: 0 };
    }
    const nodes = all.map(legacyEntryToPalaceNode);
    await bulkPutPalaceNodes(nodes);
    kvSet(`${MIGRATION_KEY}${characterId}`, "1");
    return { migrated: nodes.length };
}

export function isPalaceMigrated(characterId: string): boolean {
    return kvGet(`${MIGRATION_KEY}${characterId}`) === "1";
}