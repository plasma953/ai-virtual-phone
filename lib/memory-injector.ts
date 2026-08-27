// lib/memory-injector.ts
// Formats long-term memory entries into injectable prompt text.
// Kiwi-style calendar matryoshka: when enabled, memories are presented in
// time-granular layers (今天 → 本周 → 本月 → 更早), like nested dolls.
import type { MemoryEntry } from "./memory-types";
import { loadMemoryConfig } from "./memory-storage";

/** 计算某条记忆所在的日历层级。 */
function calendarLayerOf(createdAt: string): "today" | "week" | "month" | "older" {
    const t = new Date(createdAt).getTime();
    if (Number.isNaN(t)) return "older";
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startOfWeek = startOfToday - ((now.getDay() + 6) % 7) * 86_400_000; // 周一为周起点（与检索层一致）
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    if (t >= startOfToday) return "today";
    if (t >= startOfWeek) return "week";
    if (t >= startOfMonth) return "month";
    return "older";
}

const LAYER_LABELS: Record<"today" | "week" | "month" | "older", string> = {
    today: "今天",
    week: "本周",
    month: "本月",
    older: "更早",
};

/**
 * Format long-term memories for prompt injection.
 * The service layer already handles token-budget filtering,
 * so this just formats the selected entries.
 * 日历套娃摘要开启时：按 今天/本周/本月/更早 分层呈现（近层在前、最详细）。
 */
export function formatLongTermMemories(memories: MemoryEntry[]): string {
    if (memories.length === 0) return "";

    if (loadMemoryConfig().calendarSummaryEnabled) {
        const layers: ("today" | "week" | "month" | "older")[] = ["today", "week", "month", "older"];
        const lines: string[] = [];
        for (const layer of layers) {
            const group = memories.filter(m => calendarLayerOf(m.createdAt) === layer);
            if (group.length === 0) continue;
            lines.push(`【${LAYER_LABELS[layer]}记忆】`);
            for (const entry of group) {
                lines.push(`- ${entry.content}`);
            }
        }
        return lines.join("\n");
    }

    const lines: string[] = [];
    for (const entry of memories) {
        lines.push(`- ${entry.content}`);
    }
    return lines.join("\n");
}

export function formatCoreMemories(memories: MemoryEntry[]): string {
    if (memories.length === 0) return "";
    const lines: string[] = [];
    for (const entry of memories) {
        lines.push(`- ${entry.content}`);
    }
    return lines.join("\n");
}