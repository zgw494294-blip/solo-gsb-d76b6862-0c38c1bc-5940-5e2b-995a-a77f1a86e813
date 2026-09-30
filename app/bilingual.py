"""双语字幕合成：原文/译文按时间正长度交集配对分组。

规则：
- 配对只看两侧字幕的**原始**时间区间：区间正长度相交
  （max(start) < min(end)）才算相交；端点相接（[..,t) 与 [t,..]）不算；
- 相交关系具有传递性：A 交 B、B 交 C 即同属一组，因此允许多对一、一对多，
  每条字幕在结果中至多出现一次；
- 译文字幕必须是良好时间轴：不得时间倒挂（end <= start）、
  相邻（按时间排序后）区间不得正长度重叠，否则整份译文拒绝导入；
- 输出分组按组内源字幕在源 SRT 中的最小序号排列；
  两侧均可能存在未配对条目，各自按原顺序返回；
- 导出时每组生成一条双语字幕：组内源文按源顺序换行拼接、
  译文按译文顺序换行拼接，两段上下排列；时间取该组源字幕
  **当前校准预览**的最早开始与最晚结束（译文时间只参与配对）。
"""
from __future__ import annotations

from .srt import format_timecode


def validate_translation_axis(translation: list[dict]) -> list[str]:
    """检查译文时间轴：逐条正长度 + 任意两条不得正长度重叠。

    返回全部问题的中文说明列表（空列表表示通过）。
    """
    reasons: list[str] = []
    for t in translation:
        if t["end_ms"] <= t["start_ms"]:
            reasons.append(
                f"译文 #{t['id']} 时间倒挂："
                f"{format_timecode(t['start_ms'])} --> {format_timecode(t['end_ms'])}"
            )
    ordered = sorted(
        translation, key=lambda t: (t["start_ms"], t["end_ms"], t["id"])
    )
    for prev, cur in zip(ordered, ordered[1:]):
        # 端点相接（cur.start == prev.end）允许；仅正长度重叠拒绝
        if cur["start_ms"] < prev["end_ms"]:
            reasons.append(
                f"译文 #{prev['id']} 与 #{cur['id']} 时间重叠（"
                f"{format_timecode(prev['start_ms'])} --> {format_timecode(prev['end_ms'])}"
                f" 与 {format_timecode(cur['start_ms'])} --> {format_timecode(cur['end_ms'])}）"
            )
    return reasons


class DSU:
    """极简并查集。"""

    def __init__(self, n: int) -> None:
        self.parent = list(range(n))

    def find(self, x: int) -> int:
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a: int, b: int) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[rb] = ra


def _sweep_intersect_pairs(
    source: list[dict], translation: list[dict]
) -> list[tuple[int, int]]:
    """扫描线求所有跨侧正长度相交的 (source_id, translation_id) 对。

    同一起点的事件，结束事件排在开始事件之前，
    因此端点相接（前一区间恰好在 t 结束、后一区间在 t 开始）不会配对。
    """
    events: list[tuple[int, int, int, int]] = []
    # 事件元组：(时间, 类别[0=结束, 1=开始], 侧[0=源, 1=译], 字幕id)
    for s in source:
        if s["end_ms"] > s["start_ms"]:
            events.append((s["start_ms"], 1, 0, s["id"]))
            events.append((s["end_ms"], 0, 0, s["id"]))
    for t in translation:
        if t["end_ms"] > t["start_ms"]:
            events.append((t["start_ms"], 1, 1, t["id"]))
            events.append((t["end_ms"], 0, 1, t["id"]))
    events.sort()

    pairs: list[tuple[int, int]] = []
    active: dict[int, set[int]] = {0: set(), 1: set()}
    for _, kind, side, sub_id in events:
        if kind == 1:  # 开始：与对侧所有活动区间正长度相交
            for other_id in active[1 - side]:
                if side == 0:
                    pairs.append((sub_id, other_id))
                else:
                    pairs.append((other_id, sub_id))
            active[side].add(sub_id)
        else:  # 结束
            active[side].discard(sub_id)
    return pairs


def pair_subtitles(source: list[dict], translation: list[dict]) -> dict:
    """按正长度交集 + 传递闭包分组，返回 groups 与两侧未配对条目。

    返回：
    {
      "groups": [{"source_ids": [...], "translation_ids": [...]}, ...],
      "unpaired_source": [id, ...],
      "unpaired_translation": [id, ...],
    }
    列表均按源 SRT / 译文 SRT 的原始顺序；分组按组内源字幕最小序号排序。
    """
    src_index = {s["id"]: i for i, s in enumerate(source)}
    tr_index = {t["id"]: i for i, t in enumerate(translation)}
    n_src, n_tr = len(source), len(translation)
    dsu = DSU(n_src + n_tr)

    for src_id, tr_id in _sweep_intersect_pairs(source, translation):
        dsu.union(src_index[src_id], n_src + tr_index[tr_id])

    comp_src: dict[int, list[int]] = {}
    comp_tr: dict[int, list[int]] = {}
    for s in source:
        root = dsu.find(src_index[s["id"]])
        comp_src.setdefault(root, []).append(s["id"])
    for t in translation:
        root = dsu.find(n_src + tr_index[t["id"]])
        comp_tr.setdefault(root, []).append(t["id"])

    groups: list[dict] = []
    unpaired_source: list[int] = []
    unpaired_translation: list[int] = []
    for root, src_ids in comp_src.items():
        tr_ids = comp_tr.get(root, [])
        if tr_ids:
            # 两侧 id 都在文件顺序中追加，天然保持原顺序
            groups.append({"source_ids": src_ids, "translation_ids": tr_ids})
        else:
            unpaired_source.extend(src_ids)
    for root, tr_ids in comp_tr.items():
        if root not in comp_src:
            unpaired_translation.extend(tr_ids)

    groups.sort(key=lambda g: min(src_index[i] for i in g["source_ids"]))
    unpaired_source.sort(key=lambda i: src_index[i])
    unpaired_translation.sort(key=lambda i: tr_index[i])
    return {
        "groups": groups,
        "unpaired_source": unpaired_source,
        "unpaired_translation": unpaired_translation,
    }


def ensure_full_pairing(pairing: dict) -> list[str]:
    """导出前检查：任一侧存在未配对条目都不允许双语导出。"""
    reasons: list[str] = []
    for sid in pairing["unpaired_source"]:
        reasons.append(f"源字幕 #{sid} 没有时间相交的译文，无法合成双语条目")
    for tid in pairing["unpaired_translation"]:
        reasons.append(f"译文 #{tid} 没有时间相交的源字幕，无法合成双语条目")
    return reasons


def build_group_text(
    group: dict,
    source_by_id: dict[int, dict],
    translation_by_id: dict[int, dict],
) -> str:
    """组内正文：源文各条按原顺序换行拼接，译文各条按原顺序换行拼接，上下排列。

    多条原文 / 多条译文内部均按各自 SRT 原顺序以换行相接；
    源文段最后一行之后换行即接译文段首行（同属一个 SRT 块，不插空行）。
    """
    src_lines: list[str] = []
    for sid in group["source_ids"]:
        text = source_by_id.get(sid, {}).get("text", "")
        if text:
            src_lines.extend(text.split("\n"))
    tr_lines: list[str] = []
    for tid in group["translation_ids"]:
        text = translation_by_id.get(tid, {}).get("text", "")
        if text:
            tr_lines.extend(text.split("\n"))
    return "\n".join(src_lines + tr_lines)
