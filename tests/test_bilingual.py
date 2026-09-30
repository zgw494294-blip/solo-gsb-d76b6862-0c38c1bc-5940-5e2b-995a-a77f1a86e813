"""双语字幕合成逻辑测试：python3 tests/test_bilingual.py（无第三方依赖）。"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.bilingual import (  # noqa: E402
    build_group_text,
    ensure_full_pairing,
    pair_subtitles,
    validate_translation_axis,
)
from app.srt import build_srt, parse_srt  # noqa: E402


def make(spans, prefix):
    """spans: [(start, end, text), ...]"""
    return [
        {"id": i + 1, "start_ms": a, "end_ms": b, "text": t or f"{prefix}{i + 1}"}
        for i, (a, b, t) in enumerate(spans)
    ]


def test_endpoint_touch_is_not_overlap():
    # t1 结束于 2000、t2 开始于 2000：端点相接，允许；
    # 源 s1 [0,1000] 与 t1 [1000,2000] 端点相接：不算相交
    tr = make([(1000, 2000, "a"), (2000, 3000, "b")], "t")
    assert validate_translation_axis(tr) == []
    src = make([(0, 1000, "s")], "s")
    p = pair_subtitles(src, tr)
    assert p["groups"] == []
    assert p["unpaired_source"] == [1]
    assert p["unpaired_translation"] == [1, 2]


def test_inverted_and_overlapping_translation_rejected():
    tr = make([(5000, 4000, "inv"), (1000, 3000, "a"), (2000, 4000, "b")], "t")
    reasons = validate_translation_axis(tr)
    joined = "；".join(reasons)
    assert any("倒挂" in r for r in reasons), reasons
    assert any("重叠" in r for r in reasons), reasons
    assert "#1" in joined


def test_one_to_many_and_many_to_one_transitive():
    # 源：s1 [0,5000] 对译 t1 [0,2500] t2 [2500,5000]（端点相接，两译文各自只与 s1 交）
    src = make([(0, 5000, "s1")], "s")
    tr = make([(0, 2500, "t1"), (2500, 5000, "t2")], "t")
    p = pair_subtitles(src, tr)
    assert p["groups"] == [{"source_ids": [1], "translation_ids": [1, 2]}], p
    assert p["unpaired_source"] == [] and p["unpaired_translation"] == []

    # 传递：s1 交 t1，s2 也与 t1 交 → {s1,s2,t1} 同组（多对一，各出现一次）
    src2 = make([(0, 2000, "s1"), (1000, 3000, "s2")], "s")
    tr2 = make([(500, 2500, "t1")], "t")
    p2 = pair_subtitles(src2, tr2)
    assert p2["groups"] == [{"source_ids": [1, 2], "translation_ids": [1]}], p2


def test_transitive_chain_group_and_order():
    # s1[0,2000] - t1[1500,3500] - s2[3000,5000] - t2[4500,6500] - s3[6000,8000]
    # 相邻区间有正长度交集，传递成一大组
    src = make([(0, 2000, "s1"), (3000, 5000, "s2"), (6000, 8000, "s3"),
                (9000, 10000, "s4")], "s")
    tr = make([(1500, 3500, "t1"), (4500, 6500, "t2")], "t")
    p = pair_subtitles(src, tr)
    assert p["groups"] == [{"source_ids": [1, 2, 3], "translation_ids": [1, 2]}], p
    assert p["unpaired_source"] == [4]
    assert p["unpaired_translation"] == []
    # 分组按组内源字幕最小序号：s2(id=2) 横跨 t1、t2（二者端点外不接触，经 s2 传递成组）
    src_b = make([(9000, 10000, "s1"), (1800, 4600, "s2")], "s")
    pb = pair_subtitles(src_b, tr)
    assert pb["groups"] == [{"source_ids": [2], "translation_ids": [1, 2]}], pb
    assert pb["unpaired_source"] == [1]
    assert pb["unpaired_translation"] == []


def test_each_subtitle_appears_once():
    # 两个组互不相连，任何字幕不重复出现；s3/t3 不相交（含间隙）各自未配对
    src = make([(0, 2000, "a"), (1000, 3000, "b"), (8600, 9000, "c")], "s")
    tr = make([(500, 2500, "x"), (1500, 3500, "y"), (8000, 8500, "z")], "t")
    p = pair_subtitles(src, tr)
    seen_s, seen_t = [], []
    for g in p["groups"]:
        seen_s += g["source_ids"]
        seen_t += g["translation_ids"]
    assert sorted(seen_s) == sorted(set(seen_s))
    assert sorted(seen_t) == sorted(set(seen_t))
    assert {tuple(g["source_ids"]) for g in p["groups"]} == {(1, 2)}
    assert {tuple(g["translation_ids"]) for g in p["groups"]} == {(1, 2)}
    assert p["unpaired_source"] == [3]
    assert p["unpaired_translation"] == [3]


def test_full_pairing_required_for_export():
    src = make([(0, 2000, "s1"), (8000, 9000, "s2")], "s")
    tr = make([(0, 2000, "t1")], "t")
    p = pair_subtitles(src, tr)
    reasons = ensure_full_pairing(p)
    assert any("#2" in r and "源" in r for r in reasons), reasons
    assert len(reasons) == 1  # 只有一条未配对源


def test_group_text_layout():
    src = make([(0, 2000, "源一\n第二行"), (1000, 3000, "源二")], "s")
    tr = make([(500, 2500, "Trans one"), (2000, 3000, "Trans two")], "t")
    p = pair_subtitles(src, tr)
    assert len(p["groups"]) == 1
    g = p["groups"][0]
    src_by_id = {s["id"]: s for s in src}
    tr_by_id = {t["id"]: t for t in tr}
    text = build_group_text(g, src_by_id, tr_by_id)
    assert text == "源一\n第二行\n源二\nTrans one\nTrans two", repr(text)
    # build_srt 不产生空块分隔
    out = build_srt([{"start_ms": 0, "end_ms": 3000, "text": text}])
    assert "源一\n第二行\n源二\nTrans one\nTrans two" in out


def test_parse_real_srt_and_pair():
    src = parse_srt(
        "1\n00:00:01,000 --> 00:00:03,000\n你好\n\n"
        "2\n00:00:03,000 --> 00:00:05,000\n世界\n"
    )
    tr = parse_srt(
        "1\n00:00:01,200 --> 00:00:02,900\nHi\n\n"
        "2\n00:00:03,100 --> 00:00:04,900\nWorld\n"
    )
    p = pair_subtitles(src, tr)
    assert p["groups"] == [
        {"source_ids": [1], "translation_ids": [1]},
        {"source_ids": [2], "translation_ids": [2]},
    ], p


if __name__ == "__main__":
    import inspect

    fails = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and inspect.isfunction(fn):
            try:
                fn()
                print("ok -", name)
            except Exception:
                fails += 1
                print("FAIL -", name)
                import traceback

                traceback.print_exc()
    if fails:
        sys.exit(1)
    print("all bilingual tests passed")
