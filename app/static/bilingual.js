"use strict";

/* 双语字幕合成（第 7 步）—— 浏览器侧。
 *
 * 在当前源 SRT 上导入译文 SRT，由后端按两侧原始时间区间的正长度交集
 * （端点相接不算）配对，相交关系按传递闭包成组（多对一 / 一对多，
 * 每条字幕只出现一次）。译文时间倒挂或重叠会被后端整份拒绝。
 *
 * 本模块只持有译文与配对结果，不改写源工作区：
 *   - 组时间实时取源字幕「当前校准预览」（app.js 在每次预览后通过
 *     setPreview 下发），译文时间只参与配对；
 *   - 存在未配对条目或预览冲突时禁止双语导出；
 *   - 重新导入源 SRT 时由 app.js 调用 reset() 清空旧配对；
 *   - 普通导出、排版版导出与 .stc 工程均不读取本模块状态。
 */
(function () {
  const W = window.Workspace;
  const $ = (sel) => document.querySelector(sel);

  const bl = {
    translation: null, // 译文字幕 [{id, start_ms, end_ms, text}]
    groups: [], // [{source_ids:[], translation_ids:[]}]，已按源顺序排序
    unpairedSource: [],
    unpairedTranslation: [],
    previewById: new Map(), // 源字幕 id -> 当前校准预览 {new_start_ms, new_end_ms}
    canTimelineExport: false, // 当前源时间轴是否无冲突（/api/preview 的 can_export）
  };

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  function fmtMs(ms) {
    ms = Math.max(0, Math.round(ms));
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const milli = ms % 1000;
    const pad = (n, w = 2) => String(n).padStart(w, "0");
    return `${pad(h)}:${pad(m)}:${pad(s)},${pad(milli, 3)}`;
  }

  function setStatus(html, bad) {
    const el = $("#bl-status");
    el.innerHTML = html || "";
    el.classList.toggle("bad", Boolean(bad));
    el.classList.toggle("good", Boolean(html && !bad && html.indexOf("✔") === 0));
  }

  function hasUnpaired() {
    return bl.unpairedSource.length > 0 || bl.unpairedTranslation.length > 0;
  }

  /* ================= 重置（重新导入源 SRT 时由 app.js 调用） ================= */
  function reset() {
    bl.translation = null;
    bl.groups = [];
    bl.unpairedSource = [];
    bl.unpairedTranslation = [];
    bl.previewById = new Map();
    bl.canTimelineExport = false;
    $("#bl-clear").disabled = true;
    $("#bl-export").disabled = true;
    $("#bl-list").innerHTML =
      '<div class="bl-empty">先在第 1 步导入源 SRT，再在此导入对应译文 SRT，配对分组将按源字幕顺序展示在这里。</div>';
    setStatus("", false);
  }

  /* ================= 导入译文 ================= */
  async function importTranslation(content) {
    if (!W.subtitles || !W.subtitles.length) {
      setStatus("✖ 请先在第 1 步导入源 SRT，再导入译文。", true);
      return;
    }
    setStatus("正在配对…", false);
    let data;
    try {
      const res = await fetch("/api/bilingual/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subtitles: W.subtitles, content }),
      });
      data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const d = data.detail;
        if (d && typeof d === "object" && Array.isArray(d.reasons) && d.reasons.length) {
          setStatus("✖ " + escapeHtml(d.message || "译文被拒绝") + "：" +
            d.reasons.map((x) => escapeHtml(x)).join("；"), true);
        } else {
          setStatus("✖ " + escapeHtml(typeof d === "string" ? d : "译文导入失败"), true);
        }
        return;
      }
    } catch (e) {
      setStatus("✖ 译文导入请求失败：" + escapeHtml(e.message), true);
      return;
    }

    bl.translation = data.translation;
    bl.groups = data.groups;
    bl.unpairedSource = data.unpaired_source;
    bl.unpairedTranslation = data.unpaired_translation;
    $("#bl-clear").disabled = false;
    if (hasUnpaired()) {
      setStatus(
        `✔ 已导入 ${data.count} 条译文，配成 ${bl.groups.length} 组；` +
        `但有 ${bl.unpairedSource.length} 条源字幕、${bl.unpairedTranslation.length} 条译文未配对，禁止双语导出。`,
        true
      );
    } else {
      setStatus(`✔ 已导入 ${data.count} 条译文，全部配成 ${bl.groups.length} 组。`, false);
    }
    render();
  }

  $("#bl-file").addEventListener("change", (ev) => {
    const f = ev.target.files[0];
    ev.target.value = ""; // 允许再次选择同一文件
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => importTranslation(reader.result);
    reader.onerror = () => setStatus("✖ 文件读取失败", true);
    reader.readAsText(f, "utf-8");
  });

  $("#bl-parse").addEventListener("click", () => {
    const text = $("#bl-paste").value;
    if (!text.trim()) {
      setStatus("✖ 请先粘贴译文 SRT 内容", true);
      return;
    }
    importTranslation(text);
  });

  $("#bl-clear").addEventListener("click", () => {
    reset();
  });

  /* ================= 渲染（按源字幕顺序：分组 + 源侧未配对，译文未配对列在最后） ================= */
  function entriesHtml(items, sideCls) {
    return items
      .map(
        (it) =>
          `<li><span class="bl-eid">${sideCls === "src" ? "源" : "译"} #${it.id}</span>` +
          `<span class="tc">${fmtMs(it.start_ms)} → ${fmtMs(it.end_ms)}</span>` +
          `<pre>${escapeHtml(it.text)}</pre></li>`
      )
      .join("");
  }

  function render() {
    const list = $("#bl-list");
    if (!bl.translation) {
      list.innerHTML =
        '<div class="bl-empty">先在第 1 步导入源 SRT，再在此导入对应译文 SRT，配对分组将按源字幕顺序展示在这里。</div>';
      $("#bl-export").disabled = true;
      return;
    }

    const srcById = new Map(W.subtitles.map((s) => [s.id, s]));
    const trById = new Map(bl.translation.map((t) => [t.id, t]));

    // 按源字幕顺序产生行：组由其在源侧的最小位置定位；未配对源字幕各占一行
    const groupByFirstSrc = new Map(
      bl.groups.map((g) => [Math.min(...g.source_ids), g])
    );
    const unpairedSrcSet = new Set(bl.unpairedSource);
    const parts = [];

    for (const s of W.subtitles) {
      const g = groupByFirstSrc.get(s.id);
      if (g) parts.push(renderGroup(g, srcById, trById));
      else if (unpairedSrcSet.has(s.id)) parts.push(renderUnpairedSource(s));
    }

    if (bl.unpairedTranslation.length) {
      const items = bl.unpairedTranslation.map((id) => trById.get(id)).filter(Boolean);
      parts.push(
        `<div class="bl-unpaired-tr"><h3>未配对的译文字幕（${items.length}）</h3>` +
          `<ul>${entriesHtml(items, "tr")}</ul></div>`
      );
    }

    list.innerHTML = parts.join("");
    updateExportBtn();
  }

  function renderGroup(g, srcById, trById) {
    const srcItems = g.source_ids.map((id) => srcById.get(id)).filter(Boolean);
    const trItems = g.translation_ids.map((id) => trById.get(id)).filter(Boolean);

    // 组时间 = 组内源字幕当前校准预览的最早开始 / 最晚结束
    let startMs = null;
    let endMs = null;
    let previewMissing = false;
    for (const id of g.source_ids) {
      const p = bl.previewById.get(id);
      if (!p) {
        previewMissing = true;
        continue;
      }
      startMs = startMs == null ? p.new_start_ms : Math.min(startMs, p.new_start_ms);
      endMs = endMs == null ? p.new_end_ms : Math.max(endMs, p.new_end_ms);
    }
    const envelope =
      startMs == null || previewMissing
        ? "—"
        : `${fmtMs(startMs)} → ${fmtMs(endMs)}`;

    const ids =
      `源 #${g.source_ids.join("、#")}` +
      (g.translation_ids.length ? ` ｜ 译 #${g.translation_ids.join("、#")}` : "");

    return (
      `<div class="bl-group">` +
      `<div class="bl-head"><span class="bl-gid">${escapeHtml(ids)}</span>` +
      `<span class="bl-env ${bl.canTimelineExport ? "" : "bl-bad"}">双语时间（当前预览）：${envelope}</span></div>` +
      `<div class="bl-pair">` +
      `<div class="bl-col bl-src"><h4>源文（${srcItems.length} 条，原顺序）</h4><ul>${entriesHtml(srcItems, "src")}</ul></div>` +
      `<div class="bl-col bl-tr"><h4>译文（${trItems.length} 条，原顺序）</h4><ul>${entriesHtml(trItems, "tr")}</ul></div>` +
      `</div></div>`
    );
  }

  function renderUnpairedSource(s) {
    return (
      `<div class="bl-group bl-unpaired">` +
      `<div class="bl-head"><span class="bl-gid">源 #${s.id} 未配对</span>` +
      `<span class="bl-env bl-bad">禁止双语导出</span></div>` +
      `<div class="bl-pair"><div class="bl-col bl-src"><ul>${entriesHtml([s], "src")}</ul></div>` +
      `<div class="bl-col bl-tr"><h4>无相交译文</h4></div></div></div>`
    );
  }

  /* ================= 导出按钮状态 ================= */
  function updateExportBtn() {
    const btn = $("#bl-export");
    const ok =
      Boolean(bl.translation) &&
      bl.groups.length > 0 &&
      !hasUnpaired() &&
      bl.canTimelineExport &&
      bl.previewById.size >= (W.subtitles ? W.subtitles.length : 0);
    btn.disabled = !ok;
    if (!bl.translation) {
      btn.title = "请先导入译文 SRT";
    } else if (hasUnpaired()) {
      btn.title = "存在未配对条目，请调整 / 重新导入译文后再导出";
    } else if (!bl.canTimelineExport) {
      btn.title = "当前校准预览存在冲突，请先在第 4 步消除冲突";
    } else {
      btn.title = "每组一条，源文在上译文在下，时间取组内源字幕当前预览的最小包络";
    }
  }

  /* ================= 下载双语 SRT ================= */
  $("#bl-export").addEventListener("click", async () => {
    if (!bl.translation || hasUnpaired() || !bl.canTimelineExport) return;
    try {
      const res = await fetch("/api/bilingual/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subtitles: W.subtitles,
          translation: bl.translation,
          anchors: W.anchors,
          locks: W.locks,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert("双语导出被拒绝：" + (typeof err.detail === "string" ? err.detail : "存在冲突或未配对条目"));
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = W.fileNameBase.replace(/\.calibrated$/, "") + ".bilingual.srt";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setStatus(
        `✔ 已下载双语 SRT（${bl.groups.length} 组，每组一条；源文在上、译文在下）。普通导出与排版版导出不受影响。`,
        false
      );
    } catch (e) {
      alert("双语导出失败：" + e.message);
    }
  });

  /* ================= 对外接口（由 app.js 刷新预览后调用） ================= */
  window.BilingualUI = {
    reset,
    // items：/api/preview 返回的 [{id, new_start_ms, new_end_ms, locked}]
    // canExport：该响应的 can_export（有冲突即 false）
    setPreview(items, canExport) {
      bl.previewById = new Map((items || []).map((it) => [it.id, it]));
      bl.canTimelineExport = Boolean(canExport);
      if (bl.translation) render();
      else updateExportBtn();
    },
  };

  reset();
})();
