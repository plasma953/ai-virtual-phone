// lib/palace-search.ts
// 记忆宫殿 v3 —— 检索引擎
// 移植自 SullyOS hybridSearch.ts / activation.ts / consolidation.ts，适配 AIVP。
//
// 链路：
//   查询文本（最近几条消息拼接）
//     ├─ 向量支路（嵌入 API 已配置时）：余弦相似度 → 候选池
//     ├─ BM25 支路（纯本地，永远可用）：关键词精确匹配 → 候选池
//     ↓ 融合（默认向量 85% + BM25 15%）
//   房间加权（相似度/时近性/重要性，各房间侧重不同）
//     + 有效重要度（房间衰减曲线，带 floor 保底）
//     + 熟悉度加成（accessCount）
//     ↓
//   扩散激活（沿链接图联想关联记忆）
import type { ApiConfig } from "./settings-types";
import type { MemoryNode, MemoryLink, MemoryLinkType } from "./palace-types";
import { ROOM_CONFIGS, ROOM_SEARCH_WEIGHTS, isPalaceNodeActive } from "./palace-types";
import { palaceBm25Search } from "./palace-bm25";
import { generateEmbedding, cosineSimilarity } from "./memory-embedding";
import { loadPalaceNodes, loadPalaceLinks } from "./palace-storage";

// ─── 常量 ─────────────────────────────────────────────
const VECTOR_WEIGHT = 0.85;
const BM25_WEIGHT = 0.15;
const RECENCY_DECAY = 0.999;          // 每小时（基于 lastAccessedAt）
const VECTOR_SIM_FLOOR = 0.3;         // 向量候选相似度下限
const VECTOR_CANDIDATES = 30;
const BM25_CANDIDATES = 30;
const FAMILIARITY_WEIGHT = 0.05;      // 熟悉度加成轻权重
const ACTIVATION_DECAY = 0.3;         // 扩散激活衰减

/** 有效重要度 floor：记忆进得来本来就重要，衰减有保底 */
const EFFECTIVE_IMPORTANCE_FLOOR_RATIOS: Record<MemoryNode["room"], number> = {
    living_room: 0.80,
    bedroom:     0.90,
    study:       0.90,
    user_room:   0.90,
    self_room:   1.00, // 实际因 decayRate=null 不走 floor，仅作完整性
    attic:       1.00,
    windowsill:  1.00,
};

// ─── 有效重要度 ───────────────────────────────────────
/**
 * 有效重要度 = max(importance × decayRate^hours, importance × floor)
 * - 永不遗忘的房间（self_room/attic/windowsill）恒等于 importance
 * - 客厅 0.9972/h → 1天后 ~93.5%，7天后 ~62%，30天后 ~12.7%（但不低于 80% floor）
 */
export function calculatePalaceEffectiveImportance(node: MemoryNode, now: number = Date.now()): number {
    const config = ROOM_CONFIGS[node.room];
    if (config.decayRate === null) return node.importance;
    const hours = (now - node.createdAt) / (1000 * 60 * 60);
    if (hours <= 0) return node.importance;
    const decayed = node.importance * Math.pow(config.decayRate, hours);
    const floor = node.importance * EFFECTIVE_IMPORTANCE_FLOOR_RATIOS[node.room];
    return Math.max(decayed, floor);
}

/** 熟悉度加成：常被想起的话题轻度浮现（count-1)^0.3/4，封顶 1 */
function familiarityBonus(accessCount: number): number {
    const n = Math.max(0, (accessCount || 0) - 1);
    if (n === 0) return 0;
    return Math.min(1, Math.pow(n, 0.3) / 4);
}

// ─── 打分结果 ─────────────────────────────────────────
export interface ScoredPalaceNode {
    node: MemoryNode;
    finalScore: number;
    vectorSim: number;
    bm25Score: number;
    roomScore: number;
}

export interface PalaceSearchOptions {
    /** 嵌入 API 配置（已解析）；null = 无嵌入支持，纯 BM25 + 房间评分 */
    embeddingApiConfig?: ApiConfig | null;
    /** 向量权重（0-1，剩余给 BM25） */
    vectorWeight?: number;
    topK?: number;
}

/**
 * 混合搜索：向量 + BM25 + 房间加权
 *
 * @param query 查询文本（通常由最近几条消息拼接）
 * @param characterId 角色 ID
 */
export async function palaceHybridSearch(
    query: string,
    characterId: string,
    options: PalaceSearchOptions = {},
): Promise<ScoredPalaceNode[]> {
    const topK = options.topK ?? 12;
    const vecW = Math.min(1, Math.max(0, options.vectorWeight ?? VECTOR_WEIGHT));
    const bmW = 1 - vecW;

    // 候选节点：活跃（未归档/未被推翻）
    const allNodes = await loadPalaceNodes(characterId);
    const activeNodes = allNodes.filter(isPalaceNodeActive);
    if (activeNodes.length === 0 || !query.trim()) return [];

    // 1. 向量支路（嵌入可用时）
    let vectorSims = new Map<string, number>();
    if (options.embeddingApiConfig) {
        const queryEmbedding = await generateEmbedding(query, options.embeddingApiConfig);
        if (queryEmbedding) {
            const withEmb = activeNodes.filter(n => n.embedded && n.embedding && n.embedding.length > 0);
            const scored = withEmb
                .map(n => ({ id: n.id, sim: cosineSimilarity(queryEmbedding, n.embedding!) }))
                .filter(x => x.sim >= VECTOR_SIM_FLOOR)
                .sort((a, b) => b.sim - a.sim)
                .slice(0, VECTOR_CANDIDATES);
            for (const x of scored) vectorSims.set(x.id, x.sim);
        }
    }

    // 2. BM25 支路（纯本地，永远可用）
    const bm25Results = palaceBm25Search(query, activeNodes, BM25_CANDIDATES);
    const maxBm25 = bm25Results.length > 0 ? bm25Results[0].score : 1;

    // 3. 融合
    const nodeMap = new Map(activeNodes.map(n => [n.id, n]));
    const fused = new Map<string, { node: MemoryNode; vectorSim: number; bm25Score: number }>();
    for (const [id, sim] of vectorSims) {
        const node = nodeMap.get(id);
        if (node) fused.set(id, { node, vectorSim: sim, bm25Score: 0 });
    }
    for (const br of bm25Results) {
        const normalized = maxBm25 > 0 ? br.score / maxBm25 : 0;
        const existing = fused.get(br.node.id);
        if (existing) existing.bm25Score = normalized;
        else fused.set(br.node.id, { node: br.node, vectorSim: 0, bm25Score: normalized });
    }

    // 4. 房间加权评分
    const now = Date.now();
    const results: ScoredPalaceNode[] = [];
    for (const [, entry] of fused) {
        const { node, vectorSim, bm25Score } = entry;
        const hybridSim = vecW * vectorSim + bmW * bm25Score;
        // 新近度（基于上次被访问时间）
        const hoursAgo = (now - node.lastAccessedAt) / (1000 * 60 * 60);
        const recency = Math.pow(RECENCY_DECAY, hoursAgo);
        // 有效重要度（归一化 0-1）
        const effectiveImp = calculatePalaceEffectiveImportance(node, now) / 10;
        // 房间权重
        const weights = ROOM_SEARCH_WEIGHTS[node.room];
        // 旧记忆 recency 回收：recency < 0.1 时把其权重平均还给 sim/imp
        let simW = weights.sim;
        let recW = weights.recency;
        let impW = weights.importance;
        if (weights.recency > 0 && recency < 0.1) {
            const redistribute = weights.recency / 2;
            simW += redistribute;
            impW += redistribute;
            recW = 0;
        }
        const baseScore = simW * hybridSim + recW * recency + impW * effectiveImp;
        const familiarity = familiarityBonus(node.accessCount);
        const roomScore = baseScore + FAMILIARITY_WEIGHT * familiarity;
        results.push({ node, finalScore: roomScore, vectorSim, bm25Score, roomScore });
    }
    results.sort((a, b) => b.finalScore - a.finalScore);
    return results.slice(0, topK);
}

// ─── 扩散激活 ─────────────────────────────────────────
/** 关联类型权重（中性默认；AIVP 暂无人格风格维度，后续可接入） */
const DEFAULT_LINK_TYPE_WEIGHTS: Record<MemoryLinkType, number> = {
    time:     0.8,
    causal:   0.8,
    emotion:  0.6,
    person:   0.6,
    metaphor: 0.5,
};

/**
 * 扩散激活：检索命中的种子记忆沿链接图联想关联记忆。
 *
 * 激活值 = seed_score × link_strength × type_weight × ACTIVATION_DECAY
 *
 * @param seeds 混合检索命中的记忆（带分数）
 * @param characterId 角色 ID
 * @param maxExpand 最多额外扩展条数
 */
export async function palaceSpreadActivation(
    seeds: ScoredPalaceNode[],
    characterId: string,
    maxExpand: number = 5,
): Promise<ScoredPalaceNode[]> {
    if (seeds.length === 0) return seeds;
    const [links, allNodes] = await Promise.all([
        loadPalaceLinks(characterId),
        loadPalaceNodes(characterId),
    ]);
    if (links.length === 0) return seeds;

    const nodeMap = new Map(allNodes.map(n => [n.id, n]));
    const seedIds = new Set(seeds.map(s => s.node.id));
    const activated = new Map<string, number>();

    for (const seed of seeds) {
        const neighbors = links.filter(l => l.fromId === seed.node.id || l.toId === seed.node.id);
        for (const link of neighbors) {
            const neighborId = link.fromId === seed.node.id ? link.toId : link.fromId;
            if (seedIds.has(neighborId)) continue;
            const typeWeight = DEFAULT_LINK_TYPE_WEIGHTS[link.type] ?? 0.2;
            const activationScore = seed.finalScore * link.strength * typeWeight * ACTIVATION_DECAY;
            const existing = activated.get(neighborId) || 0;
            if (activationScore > existing) activated.set(neighborId, activationScore);
        }
    }

    const sorted = [...activated.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, maxExpand);

    const expanded: ScoredPalaceNode[] = [];
    for (const [nodeId, score] of sorted) {
        const node = nodeMap.get(nodeId);
        if (node && isPalaceNodeActive(node)) {
            expanded.push({ node, finalScore: score, vectorSim: 0, bm25Score: 0, roomScore: score });
        }
    }
    return [...seeds, ...expanded];
}
