import type { CommitInfo } from '@shared/types'

// 提交图(commit graph)布局算法。GitLogViewer 用本模块产出的 row 列表在每条
// commit 左侧画 lane 圆点 + 上下连接线。
//
// 算法思路:维护 `lanes` —— 当前每条 lane "正在等待哪个 parent hash 出现"。
// 按 commit 顺序(最新→最旧)迭代:
//   1. 找到当前 commit.hash 在 lanes 中所占的位置(ownLane);第一次出现就分配空位
//   2. 上半段画线:每条 prev lane 都是从 (i, 顶) → (i, 中心) 的竖线 —— lane 槽
//      位绝不重排,所以"穿过"的 lane 自然就是竖线
//   3. 把 lanes[ownLane] 替换为 commit.parents[0] —— 主线继承同 lane
//   4. 其它 parents 找空 lane 或复用已有等待者(merge 收回)
//   5. 下半段画线:主 parent 是竖线、其它 parent 是从 ownLane → parentLane 的
//      斜线 —— 这就是经典 merge 图形
//
// 颜色:lane 索引循环 → EL 语义色 token + 一组固定补色。每条 lane 一旦分配颜色
// 就保持到 lane 终结,主线 + 分支线视觉一致。

export interface GraphSegment {
  fromLane: number
  toLane: number
  color: string
}

export interface GraphRow {
  /** 圆点所在 lane index。 */
  ownLane: number
  /** 圆点颜色 = 该 lane 的颜色。 */
  dotColor: string
  /** 上半段(顶 → 中心)绘制的线段。 */
  topSegments: GraphSegment[]
  /** 下半段(中心 → 底)绘制的线段。 */
  bottomSegments: GraphSegment[]
  /** 本行需要展示的 lane 总数(决定 SVG 宽度)。 */
  laneCount: number
  /** parents.length > 1 —— merge commit,圆点用空心表达。 */
  isMerge: boolean
  /** 通过 commit hash 反查所属 commit,方便上层渲染时 zip 起来。 */
  hash: string
}

// lane 颜色循环。前 5 个是 EL 语义色 token,后面是固定补色 —— EL 没有更多语义
// 槽位,用补色保证 6+ lane 仍能区分。固定补色在 dark/light 主题下都可读。
const LANE_COLORS = [
  'var(--el-color-primary)',
  'var(--el-color-success)',
  'var(--el-color-warning)',
  'var(--el-color-danger)',
  'var(--el-color-info)',
  '#7c4dff',
  '#ff8a65',
  '#26a69a',
  '#ec407a',
  '#9ccc65'
]

function colorForLane(idx: number): string {
  return LANE_COLORS[idx % LANE_COLORS.length]
}

export function computeGraph(commits: CommitInfo[]): GraphRow[] {
  const rows: GraphRow[] = []
  const lanes: Array<{ hash: string; color: string } | null> = []

  for (const commit of commits) {
    // ---- 找到 / 分配 ownLane ----
    let ownLane = lanes.findIndex((l) => l?.hash === commit.hash)
    let ownColor: string
    if (ownLane < 0) {
      const empty = lanes.findIndex((l) => l === null)
      ownLane = empty >= 0 ? empty : lanes.length
      if (empty < 0) lanes.push(null)
      ownColor = colorForLane(ownLane)
    } else {
      ownColor = lanes[ownLane]!.color
    }

    // 拍照 prev lanes 用于上半段绘制 —— 必须在 mutate lanes 之前。
    const prevLanes = lanes.slice()

    // ---- 更新 lanes ----
    lanes[ownLane] = commit.parents[0] ? { hash: commit.parents[0], color: ownColor } : null

    // 其它 parents 进新 lane(或者复用已有 lane —— merge 收回到现存)
    for (let pi = 1; pi < commit.parents.length; pi++) {
      const p = commit.parents[pi]
      const existing = lanes.findIndex((l) => l?.hash === p)
      if (existing >= 0) continue
      const empty2 = lanes.findIndex((l) => l === null)
      const idx = empty2 >= 0 ? empty2 : lanes.length
      if (empty2 < 0) lanes.push(null)
      lanes[idx] = { hash: p, color: colorForLane(idx) }
    }

    // 截短尾部 null —— 防止 lane 数无限增长(merge 之后 lane 减少时)
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop()

    // ---- 上半段:prevLanes 里每个 non-null 的 lane 画一条竖线 ----
    const topSegments: GraphSegment[] = []
    for (let i = 0; i < prevLanes.length; i++) {
      const prev = prevLanes[i]
      if (!prev) continue
      topSegments.push({ fromLane: i, toLane: i, color: prev.color })
    }

    // ---- 下半段 ----
    // 1) 主 parent (parents[0]):圆点同 lane 直接竖线下去
    // 2) 其它 parent:圆点到该 parent 所在 lane 的斜线
    // 3) 其它穿过的 lane:本身竖线
    const bottomSegments: GraphSegment[] = []
    if (commit.parents[0]) {
      bottomSegments.push({ fromLane: ownLane, toLane: ownLane, color: ownColor })
    }
    for (let pi = 1; pi < commit.parents.length; pi++) {
      const p = commit.parents[pi]
      const parentLane = lanes.findIndex((l) => l?.hash === p)
      if (parentLane < 0) continue // 不应该发生,防御性
      bottomSegments.push({
        fromLane: ownLane,
        toLane: parentLane,
        color: lanes[parentLane]!.color
      })
    }
    for (let i = 0; i < lanes.length; i++) {
      const l = lanes[i]
      if (!l) continue
      // 已经被上面两条路径加进去的不重复加
      if (i === ownLane && commit.parents[0]) continue
      if (commit.parents.slice(1).some((p) => p === l.hash)) continue
      bottomSegments.push({ fromLane: i, toLane: i, color: l.color })
    }

    rows.push({
      ownLane,
      dotColor: ownColor,
      topSegments,
      bottomSegments,
      laneCount: Math.max(prevLanes.length, lanes.length, ownLane + 1),
      isMerge: commit.parents.length > 1,
      hash: commit.hash
    })
  }

  return rows
}

// 绘制参数 —— GitLogViewer 共享这些常量,所以宽度计算 / 圆点定位用同一套数。
export const GRAPH = {
  /** lane 间距(像素) */
  laneStep: 14,
  /** 第一条 lane 中心的左偏移 */
  leftPad: 8,
  /** 单行 graph SVG 高度 = commit row 高度。覆盖单行 padding,与 .gl-row 同步。 */
  rowHeight: 36,
  /** 圆点半径 */
  dotRadius: 4
}

/** 计算 lane i 中心的 x 坐标。 */
export function laneCenterX(i: number): number {
  return GRAPH.leftPad + i * GRAPH.laneStep
}
