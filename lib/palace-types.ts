// lib/palace-types.ts
// 心潮·念 v3 —— 记忆宫殿（Memory Palace）类型定义
// 参照 SullyOS 记忆宫殿设计，适配 AIVP 单用户助手场景。
// 设计要点：
//   1. 七个房间模拟脑区，各房间独立容量与衰减曲线
//   2. 房间门牌（Room Plates）：情景记忆固化成的语义知识，每轮常驻注入（不走召回）
//   3. 记忆链接图（时间/情绪/因果/人物/隐喻）支撑扩散激活
//   4. 事件盒（EventBox）：同一事件的散碎记忆聚盒压缩，取代 Dream 式混合总结
//   5. 保真层（Paramecium）：逐字引用锚定 + 归档永存可复活（从 v2 继承的特色）

// ─── 七个房间 ─────────────────────────────────────────
export type MemoryRoom =
    | "living_room"   // 客厅 — 日常闲聊、近期互动（海马体）
    | "bedroom"       // 卧室 — 亲密情感、深层羁绊（新皮层）
    | "study"         // 书房 — 工作学习、技能成长（前额叶）
    | "user_room"     // 用户房 — 用户个人信息、习惯（颞顶联合区）
    | "self_room"     // 自我房 — 角色/AI 自我认同演化（默认模式网络）
    | "attic"         // 阁楼 — 未消化的困惑、悬而未决（杏仁核-海马体，潜伏）
    | "windowsill";   // 窗台 — 期盼、目标、愿望（多巴胺奖赏系统）

export interface RoomConfig {
    capacity: number | null;    // null = 无限
    decayRate: number | null;   // null = 永不遗忘；数值 = 每小时衰减基数
    description: string;
}

export const ROOM_CONFIGS: Record<MemoryRoom, RoomConfig> = {
    living_room: { capacity: 200,  decayRate: 0.9972, description: "日常闲聊、近期互动" },
    bedroom:     { capacity: null, decayRate: 0.9995, description: "亲密情感、深层羁绊" },
    study:       { capacity: null, decayRate: 0.9995, description: "工作学习、技能成长" },
    user_room:   { capacity: null, decayRate: 0.9995, description: "用户个人信息、习惯" },
    self_room:   { capacity: null, decayRate: null,   description: "角色/AI 自我认同、演变" },
    attic:       { capacity: null, decayRate: null,   description: "未消化的困惑、悬而未决" },
    windowsill:  { capacity: null, decayRate: null,   description: "期盼、目标、愿望" },
};

export const ROOM_LABELS: Record<MemoryRoom, string> = {
    living_room: "客厅",
    bedroom:     "卧室",
    study:       "书房",
    user_room:   "用户房",
    self_room:   "自我房",
    attic:       "阁楼",
    windowsill:  "窗台",
};

export const ALL_ROOMS: MemoryRoom[] = [
    "living_room", "bedroom", "study", "user_room", "self_room", "attic", "windowsill",
];

/** 房间检索权重：相似度 / 时近性 / 重要性（参照 SullyOS，各脑区侧重不同） */
export const ROOM_SEARCH_WEIGHTS: Record<MemoryRoom, { sim: number; recency: number; importance: number }> = {
    living_room: { sim: 0.50, recency: 0.30, importance: 0.20 },
    bedroom:     { sim: 0.60, recency: 0.10, importance: 0.30 },
    attic:       { sim: 0.70, recency: 0.00, importance: 0.30 },
    study:       { sim: 0.55, recency: 0.15, importance: 0.30 },
    user_room:   { sim: 0.55, recency: 0.15, importance: 0.30 },
    self_room:   { sim: 0.55, recency: 0.15, importance: 0.30 },
    windowsill:  { sim: 0.55, recency: 0.15, importance: 0.30 },
};

// ─── 记忆节点 ─────────────────────────────────────────
/** 记忆中明确出现的专名实体（不收录"他/朋友/那个项目"这类泛称） */
export interface MemoryEntity {
    name: string;
    type?: "person" | "place" | "organization" | "project" | "product" | "account" | "domain" | "other";
    aliases?: string[];
}

export interface MemoryNode {
    id: string;
    characterId: string;
    /** 记忆内容：提取记忆为第三人称叙事；消化衍生为第一人称内心独白 */
    content: string;
    /** 所属房间 */
    room: MemoryRoom;
    tags: string[];
    entities?: MemoryEntity[];
    /** 重要度 1-10（越高叙事越完整：因→事→反应） */
    importance: number;
    /** 情绪标签 happy/sad/angry/anxious/tender 等 */
    mood?: string;
    /** Russell 环形情感：效价 -1(极痛苦) ~ +1(极愉悦) */
    valence?: number;
    /** Russell 环形情感：唤醒度 -1(极平静) ~ +1(极激烈) */
    arousal?: number;
    embedded: boolean;
    embedding?: number[];
    /** 时间戳（毫秒） */
    createdAt: number;
    lastAccessedAt: number;
    accessCount: number;
    /** 便利贴置顶截止时间（ms），null/undefined = 不置顶 */
    pinnedUntil?: number | null;
    /** 消化衍生记忆的源记忆 ID */
    sourceId?: string | null;
    origin?: "extraction" | "digestion" | "split" | "import" | "system";
    /** 消化已消费标记（不再进入候选池） */
    digestedAt?: number | null;
    // ─── 保真层（v2 继承） ───
    /** 状态：active 参与召回注入；archived 已压入盒/归档；superseded 被矛盾新记忆取代 */
    status?: "active" | "archived" | "superseded";
    /** 逐字引用锚点：从源事件原文机械校验过的原句（一字不差） */
    quote?: string;
    quoteSource?: string;
    // ─── 事件盒绑定 ───
    eventBoxId?: string | null;
    /** 此节点是某事件盒的压缩总结 */
    isBoxSummary?: boolean;
}

/** 节点是否参与召回与注入 */
export function isPalaceNodeActive(node: MemoryNode): boolean {
    return node.status !== "archived" && node.status !== "superseded";
}

// ─── 记忆链接（扩散激活的边） ─────────────────────────
export type MemoryLinkType = "time" | "emotion" | "causal" | "person" | "metaphor";

export interface MemoryLink {
    id: string;
    characterId: string;
    fromId: string;
    toId: string;
    type: MemoryLinkType;
    /** 强度 0-1 */
    strength: number;
    createdAt: number;
}

export const LINK_TYPE_LABELS: Record<MemoryLinkType, string> = {
    time:     "时间链",
    emotion:  "情绪链",
    causal:   "因果链",
    person:   "人物链",
    metaphor: "隐喻链",
};

// ─── 房间门牌（情景 → 语义固化层，常驻注入） ──────────
export type PlateRoom = "user_room" | "self_room" | "bedroom" | "study";

export const PLATE_ROOMS: PlateRoom[] = ["user_room", "self_room", "bedroom", "study"];

export const PLATE_META: Record<PlateRoom, { title: string; cap: number; desc: string }> = {
    user_room: { title: "TA的事", cap: 12, desc: "用户的基础信息、家庭结构、重要他人、人格冲击级的重大节点" },
    self_room: { title: "我是谁", cap: 10, desc: "角色/AI 对自己的稳定认知" },
    bedroom:   { title: "我们之间", cap: 10, desc: "关系的质地（只描述现象，禁止给关系命名）" },
    study:     { title: "我的领域", cap: 8,  desc: "会什么、在学什么" },
};

export interface PlateEntry {
    id: string;
    characterId: string;
    plateRoom: PlateRoom;
    content: string;
    /** 首次得知时间（ms） */
    firstLearnedAt: number;
    /** 被印证次数 */
    sourceCount: number;
    /** 基于哪些旧条目合并而来 */
    basedOn?: string[];
    createdAt: number;
    updatedAt: number;
}

// ─── 事件盒（同一事件的散碎记忆聚盒） ─────────────────
export interface EventBox {
    id: string;
    characterId: string;
    title: string;
    /** 盒摘要（压缩总结，封盒后生成） */
    summary?: string;
    status: "open" | "closed";
    /** 事件时间范围（ms） */
    startAt: number;
    endAt: number;
    /** 活跃子节点 ID（参与召回） */
    nodeIds: string[];
    /** 被压入摘要的归档节点数 */
    archivedCount: number;
    createdAt: number;
    updatedAt: number;
}

// ─── 认知消化（状态机产物） ───────────────────────────
export type DigestVerdict =
    | "worry"      // 担忧 → 上阁楼，进入状态机循环
    | "aspire"     // 期盼 → 上窗台，进入期盼生命周期
    | "distill"    // 二次领悟 → 提交门牌
    | "keep";      // 只是经历，保持原样

export interface DigestResult {
    /** 回顾窗口内的源节点 */
    reviewedIds: string[];
    worries: { content: string; room: "attic"; importance: number; mood: string; sourceId: string }[];
    aspirations: { content: string; room: "windowsill"; importance: number; mood: string; sourceId: string }[];
    distillations: { content: string; plateRoom: PlateRoom; sourceId: string }[];
    keptCount: number;
    /** 各门牌本次是否更新 */
    plateUpdates: Partial<Record<PlateRoom, number>>;
    timestamp: number;
}

export interface DigestReport {
    id: string;
    characterId: string;
    result: DigestResult;
    timestamp: number;
}

// ─── 宫殿配置 ─────────────────────────────────────────
export interface PalaceConfig {
    /** 缓冲触发阈值：保留最近 N 条原文在上下文，缓冲达到 M 条触发提取 */
    bufferKeepRaw: number;
    bufferTrigger: number;
    /** 处理比例：处理 85%，留 15% 尾部保持上下文连续 */
    processRatio: number;
    /** 混合检索中向量权重（剩余给 BM25） */
    hybridVectorWeight: number;
    /** 房间门牌常驻注入开关 */
    platesInjectionEnabled: boolean;
    /** 认知消化间隔（聊天轮数） */
    digestionIntervalRounds: number;
    /** 扩散激活最多追加条数 */
    spreadingActivationMax: number;
}

export const DEFAULT_PALACE_CONFIG: PalaceConfig = {
    bufferKeepRaw: 200,
    bufferTrigger: 100,
    processRatio: 0.85,
    hybridVectorWeight: 0.85,
    platesInjectionEnabled: true,
    digestionIntervalRounds: 50,
    spreadingActivationMax: 5,
};

// ─── 旧系统（v2 心潮·念）迁移映射 ─────────────────────
/** 旧 type → 新房间：core（用户核心事实）→ 用户房；long_term → 客厅（近期互动） */
export function mapLegacyTypeToRoom(legacyType: "long_term" | "core"): MemoryRoom {
    return legacyType === "core" ? "user_room" : "living_room";
}

/** 旧重要度 0-1 → 新 1-10 */
export function mapLegacyImportance(legacy: number): number {
    return Math.min(10, Math.max(1, Math.round(legacy * 10)));
}
