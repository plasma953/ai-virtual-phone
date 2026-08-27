/**
 * prompt-guard —— Prompt 组装末端硬性防线
 *
 * 背景：2026-08 排查 Network Error / 上游 #sym:500 时发现，聊天请求携带
 * 单条 3MB / 约 105 万 token 的巨型消息体（超过 Gemini 1M 上下文红线），
 * 导致任何小请求正常、真实聊天必炸的现象。
 *
 * 三层防线：
 *   A. clampHistoryBodyChars：单条历史正文钳制（软阈值折叠摘要、硬上限强裁）
 *   B. 池预算消毒：shortTermTokenBudget ∈ [1000, 150000]（在 short-term-assembler 调用）
 *   C. guardFinalPayloadTotal：发往 API 前的总量硬帽（超限从最旧开始裁剪）
 *
 * 阈值来源（2026-08-27 改造）：全部由用户在「记忆银行 → 设置」页正向调整，
 * 存于 MemoryConfig.promptGuardTotalChars / promptGuardSoftChars。
 * 本模块只在读到非法值（0/NaN/越界）时按绝对护栏纠偏，绝不覆盖合法自定义值。
 */

import { loadMemoryConfig } from "./memory-storage";

// ── 绝对护栏（用户无法越过，防止误设再次炸穿上游或彻底失效） ──
/** 总量硬帽的合法区间：低于 15 万字符连基本对话都装不下；
 *  事故复盘（bodySize≈3.14M 字符 ≈ 105 万 token 触发 #sym:500）证明
 *  300 万字符上限已逼近上游 1M token 红线，绝对上限收紧至 100 万字符，
 *  按 0.75 token/字符宽松估算 ≈ 75 万 token，留足安全余量。 */
export const PROMPT_GUARD_TOTAL_ABS_MIN = 150000;
export const PROMPT_GUARD_TOTAL_ABS_MAX = 1000000;

/** 单条软限的合法区间 */
export const PROMPT_GUARD_SOFT_ABS_MIN = 2000;
export const PROMPT_GUARD_SOFT_ABS_MAX = 500000;

/** 用户未配置时的默认值 */
const DEFAULT_TOTAL_CHARS = 900000;
const DEFAULT_SOFT_CHARS = 12000;

/** 巨型消息截断后保留的尾部长度 */
const TAIL_KEEP_CHARS = 400;

/** 总闸裁剪时写回的占位标记（计入发送体积的记账） */
const GUARD_EVICTED_MARK = "[早期上下文已因体积过大被系统裁剪]";

/** 最新消息兜底裁剪时写回的占位标记 */
const GUARD_TRIMMED_NEWEST_MARK = "[本次请求超出硬帽：最新消息的超长部分已被强制裁剪]";

/** 宽松 token 估算（仅用于日志/诊断，不参与业务逻辑） */
export function estimateTokensLoose(text: string): number {
    return Math.ceil(text.length * 0.75);
}

function clampNum(raw: unknown, fallback: number, min: number, max: number): number {
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

/** 当前生效的用户阈值（每次调用实时读取，滑块拖动立即生效） */
function readUserThresholds(): { totalChars: number; softChars: number; hardChars: number } {
    try {
        const cfg = loadMemoryConfig();
        const totalChars = clampNum(
            cfg.promptGuardTotalChars, DEFAULT_TOTAL_CHARS,
            PROMPT_GUARD_TOTAL_ABS_MIN, PROMPT_GUARD_TOTAL_ABS_MAX,
        );
        const softChars = clampNum(
            cfg.promptGuardSoftChars, DEFAULT_SOFT_CHARS,
            PROMPT_GUARD_SOFT_ABS_MIN, PROMPT_GUARD_SOFT_ABS_MAX,
        );
        // 硬限派生自软限（约2倍），保证恒有折叠缓冲带
        const hardChars = softChars * 2 + 4000;
        return { totalChars, softChars, hardChars };
    } catch {
        return {
            totalChars: DEFAULT_TOTAL_CHARS,
            softChars: DEFAULT_SOFT_CHARS,
            hardChars: DEFAULT_SOFT_CHARS * 2 + 4000,
        };
    }
}

/**
 * B. 池预算消毒：供 short-term-assembler 使用。
 * UI 允许 1000~100000 token 自由设置；KV 可能存入 0/NaN/负数（事故根因#1），
 * 此处强制纠偏到 [1000, 150000] 合法区间。
 */
export function sanitizeShortTermBudget(raw: unknown): number {
    return clampNum(raw, 100000, 1000, 150000);
}

/**
 * A. 单条内容钳制（阈值由用户设置驱动）：
 * - <= 软限：历史原样返回（零开销快路径）；
 * - <= 硬限：折叠中段为 "[内容过长已省略 N 字符]"；
 * - > 硬限：截取头部 + 提示行 + 尾部。
 */
export function clampHistoryBodyChars(text: string): string {
    if (typeof text !== "string") return "";
    const t = readUserThresholds();
    if (text.length <= t.softChars) return text;
    if (text.length <= t.hardChars) {
        const head = Math.floor(t.softChars * 0.8);
        const omitted = text.length - head;
        const preview = text.slice(head, head + 60).split("\n")[0];
        return (
            text.slice(0, head) +
            "\n[内容过长已省略 " + omitted + " 字符 …" + preview + "]"
        );
    }
    const tail = text.length > TAIL_KEEP_CHARS ? text.slice(-TAIL_KEEP_CHARS) : "";
    return (
        text.slice(0, t.softChars) +
        "\n…[本条内容高达 " + text.length + " 字符（约 " + estimateTokensLoose(text) + " token），为保护请求链路已强制裁剪；如需完整内容请让角色重新提供或通过文件发送]…" +
        tail
    );
}

/** 记录一次性告警，避免刷屏 */
const warnedKeys = new Set<string>();
function warnOnce(key: string, msg: string) {
    if (warnedKeys.has(key)) return;
    warnedKeys.add(key);
    console.warn("[prompt-guard] " + msg);
}

/**
 * C. 发送前总闸：对字符串 content 的消息统计并执行全局尾部裁剪。
 * 从 index 0（最旧）开始，直到总长回落到用户设定的预算内；
 * 刚刚注入的最新消息（数组末尾）永不动刀。
 * @returns 实际裁掉的字符总数（用于日志观测）
 */
export function guardFinalPayloadTotal<T extends { role: string; content: unknown }>(
    payload: T[],
): number {
    if (!Array.isArray(payload)) return 0;
    const CHAR_BUDGET = readUserThresholds().totalChars;
    const indices: number[] = [];
    let total = 0;
    for (let i = 0; i < payload.length; i++) {
        const m = payload[i];
        if (m && typeof m.content === "string") {
            indices.push(i);
            total += m.content.length;
        }
        // image_url 多部件内容与 tool 载荷不计入（由视觉管线单独控制）
    }
    if (total <= CHAR_BUDGET) return 0;
    warnOnce(
        "total_overflow",
        "payload 文本总量 " + total + " 字符超出硬帽 " + CHAR_BUDGET + "，将从最旧的消息开始裁剪",
    );
    let cut = 0;
    // 已写入占位标记的膨胀量。标记本身是要发出去的真实字节，
    // 不纳入记账就会让最终总量越过硬帽（冒烟测试 T2/T3 抓到的 bug）。
    let marked = 0;
    // 保护最后一条消息（通常是本次输入）不被裁剪
    const protectIdx = payload.length - 1;
    // 允许在仅剩少数索引时继续裁剪；遇到受保护的最新消息才提前终止。
    // 覆盖"payload 中只有一条 3MB 巨物"的极端场景：照样动刀，保住链路。
    // 真实当前总量 = total - cut + marked。
    while (total - cut + marked > CHAR_BUDGET && indices.length > 0) {
        const idx = indices.shift()!;
        if (idx === protectIdx) break;
        const m = payload[idx] as { content: string };
        // 多切掉一个"即将写入的标记长度"，抵消替换造成的回填
        const need = total - cut + marked - CHAR_BUDGET + GUARD_EVICTED_MARK.length;
        const remove = Math.min(m.content.length, Math.max(0, need));
        m.content = GUARD_EVICTED_MARK + m.content.slice(remove);
        cut += remove;
        marked += GUARD_EVICTED_MARK.length;
    }
    // 收尾：若保护对象（最新消息）本身超预算导致循环提前终止，
    // 对其做一次性裁剪，确保总量必然回落到硬帽之内（同样计入标记膨胀）。
    const overflowAfterLoop = total - cut + marked - CHAR_BUDGET;
    if (
        overflowAfterLoop > 0 &&
        payload.length > 0 &&
        typeof (payload[payload.length - 1] as { content?: unknown })?.content === "string" &&
        ((payload[payload.length - 1] as { content: string }).content.length >
            GUARD_TRIMMED_NEWEST_MARK.length)
    ) {
        const last = payload[payload.length - 1] as { content: string };
        const origLen = last.content.length;
        const keep = Math.max(
            0,
            origLen - overflowAfterLoop - GUARD_TRIMMED_NEWEST_MARK.length,
        );
        last.content = GUARD_TRIMMED_NEWEST_MARK + last.content.slice(last.content.length - keep);
        cut += origLen - keep;
    }
    return cut;
}