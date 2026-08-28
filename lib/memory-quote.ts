// lib/memory-quote.ts
// Paramecium 式原文锚定（保真层）：逐字引用解析与机械校验。
// 总结 / Dream 产物必须附带 [引用: "原文片段"]，且每条引用必须逐字存在于
// 喂给 LLM 的源文本中。校验失败时先重试纠错，仍失败则剥离非法引用保留正文。

/** 引用块解析结果：body = 剥离引用块后的正文，quotes = 提取到的引用原文 */
export type QuoteParseResult = {
    body: string;
    quotes: string[];
};

/** 追加到总结/整合 prompt 末尾的引用要求（统一机制，不受自定义模板影响） */
export const QUOTE_REQUIREMENT_SUFFIX = `

【逐字引用要求（必须遵守）】
在总结正文之后，另起一行输出「引用」区块，每行一条，格式：
[引用: "原文片段"]
- 每条引用必须一字不差地复制自上方源文本（事件记录/碎片），不得改写、增删字、加省略号或换词
- 每条引用 10-40 字，至少 1 条，最多 3 条
- 只抄事实性原文（人名、承诺、偏好、关键事件），不要包含"事件""私聊"等格式前缀
- 宁可少写，绝不编造`;

/** 生成重试纠错说明（列出非法引用，要求 LLM 重新输出） */
export function buildQuoteRetrySuffix(invalidQuotes: string[]): string {
    const list = invalidQuotes.map(q => `- ${q}`).join("\n");
    return `

【引用校验失败，请重新输出】
你上一次输出中的以下引用无法在源文本中找到逐字匹配（属于编造或改写）：
${list}
请重新完整输出总结正文和引用区块。引用必须逐字复制自源文本原文，其余要求不变。`;
}

/** 剥离引用包裹符（中英文引号 / 书名号式括号） */
function stripQuoteWrappers(value: string): string {
    let t = value.trim();
    if (t.length < 2) return t;
    const pairs: Array<[string, string]> = [
        ['"', '"'], ['"', '"'], ['“', '”'], ['「', '」'], ['『', '』'],
    ];
    for (const [open, close] of pairs) {
        if (t.startsWith(open) && t.endsWith(close)) {
            t = t.slice(open.length, t.length - close.length).trim();
            break;
        }
    }
    return t;
}

/**
 * 从 LLM 输出中解析 [引用: "..."] 区块。
 * 兼容全角/半角冒号、中英文引号、引用与正文同行等常见写法。
 */
export function extractQuoteBlocks(raw: string): QuoteParseResult {
    const quotes: string[] = [];
    const re = /\[\s*(?:引用|quote)\s*[:：]\s*([^\]]{4,160})\s*\]/gi;
    const body = raw.replace(re, (_full, content: string) => {
        const q = stripQuoteWrappers(content);
        if (q) quotes.push(q);
        return "";
    });
    return { body: body.trim(), quotes };
}

/** 规范化文本用于机械匹配：折叠所有连续空白为单个空格 */
export function normalizeForMatch(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

/** 机械校验：引用（规范化后）是否逐字存在于源文本（规范化后）中 */
export function verifyQuoteAgainstSource(quote: string, sourceText: string): boolean {
    const q = normalizeForMatch(quote);
    if (q.length < 6) return false;
    return normalizeForMatch(sourceText).includes(q);
}

/** 批量校验：返回合法与非法两组引用 */
export function verifyQuotes(
    quotes: string[],
    sourceText: string,
): { valid: string[]; invalid: string[] } {
    const valid: string[] = [];
    const invalid: string[] = [];
    for (const q of quotes) {
        (verifyQuoteAgainstSource(q, sourceText) ? valid : invalid).push(q);
    }
    return { valid, invalid };
}
