// lib/palace-plates.ts
// 记忆宫殿 v3 —— 房间门牌（情景 → 语义固化层）
// 移植自 SullyOS roomPlateCore.ts / roomPlates.ts，适配 AIVP。
//
// 门牌解决的核心问题：情景记忆走召回是"抽卡"，对用户的了解永远碎片化。
// 门牌把沉淀出的稳定认知**每轮常驻注入 System Prompt**——不走召回、不衰减，
// 注入框架把它定位为 constraint（认知底色）而非 topic（话题）。
//
// 四块门牌：
//   - user_room「TA的事」：用户基础信息、家庭、重要他人、重大节点（≤12）
//   - self_room「我是谁」：角色/AI 对自己的稳定认知（≤10）
//   - bedroom「我们之间」：关系的质地，禁止命名（≤10）
//   - study「我的领域」：会什么、在学什么（≤8）
import type { PlateRoom, PlateEntry } from "./palace-types";
import { PLATE_META, PLATE_ROOMS } from "./palace-types";
import { loadPalacePlates, savePalacePlate, deletePalacePlate } from "./palace-storage";

// ─── 常量与规则 ───────────────────────────────────────
/** 单条门牌条目硬上限（字符） */
export const PLATE_ENTRY_HARD_MAX_CHARS = 200;

/** LLM 输出里 basedOn 引用的标签前缀（U0/U1…） */
const PLATE_LABEL_PREFIX: Record<PlateRoom, string> = {
    user_room: "U",
    self_room: "S",
    bedroom:   "B",
    study:     "D",
};

/**
 * 卧室门牌禁命名栅栏：窄匹配，只拦"我们是××"这种明确命名句式。
 * 主约束在 prompt 层，这里只是最后一道兜底——宁可漏过不可误杀。
 */
const BEDROOM_LABEL_RE = /我们(?:现在|如今|已经)?(?:是|算是|成了|成为|变成)[^，。；！？]{0,8}(?:恋人|情侣|男女朋友|男朋友|女朋友|夫妻|朋友|兄妹|姐弟|家人|知己|暧昧)/;

export function violatesBedroomRule(text: string): boolean {
    return BEDROOM_LABEL_RE.test(text);
}

function generatePlateEntryId(): string {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return `plate_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    }
    return `plate_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// ─── 合并逻辑（纯函数，可测） ─────────────────────────
/**
 * 把 LLM 输出的完整新列表合并进现有门牌条目。
 *
 * - basedOn 命中现有标签 → 继承 id/firstLearnedAt，sourceCount+1，
 *   文本未变时连 updatedAt 也不动（纯保留不算更新）
 * - 无 basedOn → 新条目
 * - 现有条目未被引用且未被原样保留 → 淘汰（容量压力语义，硬上限挤出边界判错项）
 */
export function mergePalacePlateEntries(
    room: PlateRoom,
    existing: PlateEntry[],
    items: Array<{ content: string; basedOn?: string | null }>,
    now: number,
): PlateEntry[] {
    const prefix = PLATE_LABEL_PREFIX[room];
    const byLabel = new Map<string, PlateEntry>();
    existing.forEach((e, i) => byLabel.set(`${prefix}${i}`, e));

    const merged: PlateEntry[] = [];
    const usedIds = new Set<string>();
    for (const item of items) {
        let content = (item.content || "").replace(/\s+/g, " ").trim();
        if (!content) continue;
        if (content.length > PLATE_ENTRY_HARD_MAX_CHARS) {
            content = content.slice(0, PLATE_ENTRY_HARD_MAX_CHARS);
        }
        if (room === "bedroom" && violatesBedroomRule(content)) {
            console.warn(`🚪 [PalacePlate] 卧室门牌拦截关系命名条目: "${content.slice(0, 40)}"`);
            continue;
        }
        const base = item.basedOn ? byLabel.get(String(item.basedOn).trim().toUpperCase()) : undefined;
        if (base && !usedIds.has(base.id)) {
            usedIds.add(base.id);
            const changed = base.content !== content;
            merged.push({
                ...base,
                content,
                updatedAt: changed ? now : base.updatedAt,
                sourceCount: base.sourceCount + 1,
            });
        } else {
            // 同文本条目已存在但 LLM 忘了标 basedOn → 原样保留，不重开新条目
            const sameText = existing.find(e => e.content === content && !usedIds.has(e.id));
            if (sameText) {
                usedIds.add(sameText.id);
                merged.push({ ...sameText, sourceCount: sameText.sourceCount + 1 });
            } else {
                merged.push({
                    id: generatePlateEntryId(),
                    characterId: existing[0]?.characterId ?? "",
                    plateRoom: room,
                    content,
                    firstLearnedAt: now,
                    sourceCount: 1,
                    createdAt: now,
                    updatedAt: now,
                });
            }
        }
    }
    return merged.slice(0, PLATE_META[room].cap);
}

/**
 * 机械兜底并入：LLM 整理失败/输出为空时，把消化提交的候选直接并进门牌，
 * 绝不静默蒸发。去重/容量/卧室规则照常。
 */
export async function fallbackMergePlateSubmissions(
    characterId: string,
    submissions: Partial<Record<PlateRoom, string[]>>,
    now: number = Date.now(),
): Promise<PlateRoom[]> {
    const plates = await loadPalacePlates(characterId);
    const updated: PlateRoom[] = [];
    for (const room of PLATE_ROOMS) {
        const lines = submissions[room];
        if (!lines || lines.length === 0) continue;
        const existing = plates.filter(p => p.plateRoom === room);
        const merged = mergePalacePlateEntries(room, existing, lines.map(l => ({ content: l })), now);
        for (const e of merged) await savePalacePlate(e);
        // 淘汰：现有但未出现在 merged 的条目
        const mergedIds = new Set(merged.map(m => m.id));
        for (const old of existing) {
            if (!mergedIds.has(old.id)) await deletePalacePlate(old.id);
        }
        updated.push(room);
    }
    return updated;
}

// ─── 注入格式化 ───────────────────────────────────────
/**
 * 格式化门牌注入段。
 * 定位为 constraint 而非 topic：早已知道的背景，不主动提起，只在相关时自然影响反应。
 */
export function formatPalacePlatesSection(plates: PlateEntry[], userName?: string): string {
    const userLabel = userName || "用户";
    const byRoom = new Map<PlateRoom, PlateEntry[]>();
    for (const p of plates) {
        const list = byRoom.get(p.plateRoom) ?? [];
        list.push(p);
        byRoom.set(p.plateRoom, list);
    }
    const sections: string[] = [];
    for (const room of PLATE_ROOMS) {
        const entries = (byRoom.get(room) ?? []).sort((a, b) => a.createdAt - b.createdAt);
        if (entries.length === 0) continue;
        const title = room === "user_room" ? `关于${userLabel}` : PLATE_META[room].title;
        const suffix = room === "bedroom" ? "（没有名字，也不需要名字——只有质地）" : "";
        sections.push(
            `**${title}**${suffix}\n` +
            entries.map(e => `- ${e.content}`).join("\n")
        );
    }
    if (sections.length === 0) return "";
    return `### 底色认知 (Resident Knowledge)
以下是你早已知道的背景。它们是你认知的底色，不是话题——不要主动提起，也不要逐条复述，只在相关时让它们自然影响你的反应、措辞与温度。
${sections.join("\n\n")}
`;
}

/** 加载某角色全部门牌并格式化（纯 IDB 读，不调 LLM，供每轮注入用） */
export async function buildPalacePlatesInjection(characterId: string, userName?: string): Promise<string> {
    try {
        const plates = await loadPalacePlates(characterId);
        return formatPalacePlatesSection(plates, userName);
    } catch (e) {
        console.warn(`🚪 [PalacePlate] 加载门牌失败: ${(e as Error)?.message || e}`);
        return "";
    }
}