/**
 * prompt-guard —— 体积裁剪防线
 *
 * 2026-08-27 用户指令：体积裁剪限制全部删除。
 * 理由：正常聊天到不了百万字符量级；生产实测体积也不是 #sym:500 的诱因。
 * 此前裁剪会把「[早期上下文已因体积过大被系统裁剪]」这类占位标记注入
 * 发送出去的历史消息，污染对话且破坏角色扮演沉浸感。
 *
 * 现状：单条折叠（clampHistoryBodyChars）与总量总闸（guardFinalPayloadTotal）
 * 均已改为直通（pass-through），不再对任何消息动刀。
 * 仅保留 shortTermTokenBudget 的合法性消毒（sanitizeShortTermBudget）——
 * 那是记忆系统对非法配置值（0/NaN/负数）的纠偏，不裁剪内容。
 */

/**
 * A. 单条历史正文钳制 —— 已禁用，直通返回原文。
 */
export function clampHistoryBodyChars(text: string): string {
    return typeof text === "string" ? text : "";
}

/**
 * C. 发送前总闸 —— 已禁用，不再裁剪任何消息。
 * @returns 恒为 0（表示没有裁剪任何字符）
 */
export function guardFinalPayloadTotal<T extends { role: string; content: unknown }>(
    payload: T[],
): number {
    void payload;
    return 0;
}

/**
 * B. 池预算消毒：供 short-term-assembler 使用（保留）。
 * UI 允许 1000~100000 token 自由设置；KV 可能存入 0/NaN/负数，
 * 此处强制纠偏到 [1000, 150000] 合法区间。不涉及内容裁剪。
 */
export function sanitizeShortTermBudget(raw: unknown): number {
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n)) return 100000;
    return Math.min(150000, Math.max(1000, n));
}
