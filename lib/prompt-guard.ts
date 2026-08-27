/**
 * prompt-guard —— Prompt 组装末端硬性防线
 *
 * 背景：2026-08 排查 Network Error 时发现，单条 user 消息体积达 3MB /
 * 约 105 万 token。根因链：
 *   1. 短记忆预算配置异常（KV 中 shortTermTokenBudget 为 0）时，
 *      池截断被 `budget > 0` 守卫完全旁路 → 全量注入；
 *   2. 统一池逐条丢弃算法无法处理"单条巨型消息"——它永远存活到最后；
 *   3. 富媒体渲染路径（appHistoryText / media_file 的 msg.content /
 *      app_card 正文等）无长度上限，外部桥接塞入百万字符畅通无阻；
 *   4. 相邻同角色块在最终 payload 阶段被合并成一条消息，把零散溢出
 *      聚合成单条 3MB 巨物，超出 Nginx client_body_buffer / fetch 缓冲。
 *
 * 本模块提供三层兜底：
 *   A. clampHistoryBodyChars：单条历史正文钳制（软阈值降级摘要、硬上限截断）
 *   B. 池预算消毒：shortTermTokenBudget ∈ [1000, 150000]（在 short-term-assembler 内联）
 *   C. guardFinalPayloadTotal：发往 API 前的总量硬帽（超限从最旧开始裁剪）
 */

/** 单条块安全长度：超过则折叠为引用摘要 */
export const PROMPT_GUARD_SOFT_LIMIT_CHARS = 12000;

/** 单条块绝对上限：任何情况下不得超过（防止极端行/不可折叠内容） */
export const PROMPT_GUARD_HARD_LIMIT_CHARS = 24000;

/** 合并后的单条消息钳制目标：多块合并时整体收拢到该值附近 */
export const PROMPT_GUARD_MERGE_TARGET_CHARS = 20000;

/** 单条消息硬性天花板：合并后也绝不越过的红线 */
export const PROMPT_GUARD_MAX_MESSAGE_CHARS = 32000;

/** 整个 payload 总量硬帽（字符数）。约 1.8MB，
 * 按 0.75 token/char 折算约 135 万 token 上界，再留出系统区与回复余量。
 * 正常对话应远低于此值；触发即说明上游治理失效，此处只保证"能发出去"。*/
export const PROMPT_GUARD_TOTAL_BUDGET_CHARS = 1800000;

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

/**
 * A. 单条内容钳制：
 * - <= SOFT_LIMIT 原样返回（零开销快路径）；
 * - <= HARD_LIMIT 折叠中段为 "[内容过长已省略 N 字符]"；
 * - > HARD_LIMIT 截取头部 + 提示行 + 尾部。
 */
export function clampHistoryBodyChars(text: string): string {
    if (typeof text !== "string") return "";
    if (text.length <= PROMPT_GUARD_SOFT_LIMIT_CHARS) return text;
    if (text.length <= PROMPT_GUARD_HARD_LIMIT_CHARS) {
        const head = Math.floor(PROMPT_GUARD_SOFT_LIMIT_CHARS * 0.8);
        const omitted = text.length - head;
        const preview = text.slice(head, head + 60).split("\n")[0];
        return (
            text.slice(0, head) +
            `\n[内容过长已省略 ${omitted} 字符 …${preview}]`
        );
    }
    const headLen = PROMPT_GUARD_SOFT_LIMIT_CHARS;
    const tail =
        text.length > TAIL_KEEP_CHARS ? text.slice(-TAIL_KEEP_CHARS) : "";
    return (
        text.slice(0, headLen) +
        `\n…[本条内容高达 ${text.length} 字符（约 ${estimateTokensLoose(text)} token），为保护请求链路已强制裁剪；如需完整内容请让角色重新提供或通过文件发送]…` +
        tail
    );
}

/** 记录一次性告警，避免刷屏 */
const warnedKeys = new Set<string>();
function warnOnce(key: string, msg: string) {
    if (warnedKeys.has(key)) return;
    warnedKeys.add(key);
    console.warn(`[prompt-guard] ${msg}`);
}

/**
 * C. 发送前总闸：对字符串 content 的消息统计并执行全局尾部裁剪。
 * 从 index 0（最旧）开始，直到总长回落到预算内；
 * 刚刚注入的最新消息（数组末尾）永不动刀。
 * @returns 实际裁掉的字符总数（用于日志观测）
 */
export function guardFinalPayloadTotal<T extends { role: string; content: unknown }>(
    payload: T[],
): number {
    if (!Array.isArray(payload)) return 0;
    const CHAR_BUDGET = PROMPT_GUARD_TOTAL_BUDGET_CHARS;
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
        `payload 文本总量 ${total} 字符超出硬帽 ${CHAR_BUDGET}，将从最旧的消息开始裁剪`,
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
