/* bilingual.js 浏览器接线冒烟测试（Node + 极简 DOM mock，无第三方依赖）。
 * node tests/test_bilingual_ui_smoke.js
 *
 * 覆盖：初始禁用 → 导入译文（fetch mock 返回配对）→ 分组按源顺序渲染、
 * 未配对条目展示 → 未配对/预览冲突时禁止导出 → 锚点变化后 setPreview
 * 更新组时间并放开导出 → 双语导出请求载荷与文件名 → 重新导入源 SRT（reset）清空。
 */
"use strict";

const path = require("path");
const fs = require("fs");

/* ---------------- 极简 DOM mock（精简自 typeset 冒烟测试） ---------------- */
function makeFakeChild(sel, parent) {
  return {
    selector: sel,
    parent,
    children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    _listeners: {},
    _text: "",
    set textContent(v) { this._text = v; },
    get textContent() { return this._text; },
    _html: "",
    set innerHTML(v) { this._html = v; },
    get innerHTML() { return this._html; },
    addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
    dispatch(t, ev) { (this._listeners[t] || []).forEach((fn) => fn(ev || {})); },
    querySelector(sel) { return makeFakeChild(sel, this); },
    appendChild(c) { this.children.push(c); return c; },
    insertBefore(c) { this.children.push(c); return c; },
    remove() {},
  };
}

function makeEl(tag) {
  const el = {
    tagName: tag,
    children: [],
    style: {},
    dataset: {},
    classList: {
      _set: new Set(),
      add(...c) { c.forEach((x) => this._set.add(x)); },
      remove(...c) { c.forEach((x) => this._set.delete(x)); },
      toggle(c, on) { (on === undefined ? !this._set.has(c) : on) ? this.add(c) : this.remove(c); },
      contains(c) { return this._set.has(c); },
    },
    _listeners: {},
    _childBySelector: {},
    _innerHTML: "",
    set innerHTML(v) {
      this._innerHTML = v;
      this.children = [];
      this._childBySelector = {};
      const classRe = /class="([^"]+)"/g;
      let m;
      while ((m = classRe.exec(v))) {
        for (const cls of m[1].split(/\s+/)) {
          if (!cls) continue;
          const sel = "." + cls;
          if (!this._childBySelector[sel]) {
            const child = makeFakeChild(sel, this);
            this._childBySelector[sel] = child;
            this.children.push(child);
          }
        }
      }
    },
    get innerHTML() { return this._innerHTML; },
    _text: "",
    set textContent(v) { this._text = v; },
    get textContent() { return this._text; },
    addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
    dispatch(t, ev) { (this._listeners[t] || []).forEach((fn) => fn(ev || {})); },
    querySelector(sel) {
      if (!this._childBySelector[sel]) this._childBySelector[sel] = makeFakeChild(sel, this);
      return this._childBySelector[sel];
    },
    querySelectorAll() { return []; },
    insertBefore(child) { this.children.push(child); return child; },
    setAttribute(k, v) { this._attrs[k] = v; },
    appendChild(child) {
      this.children.push(child);
      this._innerHTML += child.innerHTML || "";
      return child;
    },
    remove() {},
    click() {},
    title: "",
  };
  el.value = "";
  return el;
}

/* ---------------- 全局 mock ---------------- */
const els = {};
const ids = ["bl-file", "bl-clear", "bl-export", "bl-status", "bl-paste", "bl-parse", "bl-list"];
for (const id of ids) els["#" + id] = makeEl("div");

global.document = {
  querySelector: (s) => {
    if (els[s]) return els[s];
    return makeEl("div");
  },
  createElement: (tag) => {
    const e = makeEl(tag);
    if (tag === "a") e.click = () => { downloaded = e.download; };
    return e;
  },
  body: makeEl("body"),
};
global.window = { addEventListener() {} };
let downloaded = null;
global.URL = { createObjectURL: () => "blob:x", revokeObjectURL() {} };
global.Blob = class { constructor(parts) { this.parts = parts; } };

/* ---------------- Workspace（app.js 暴露给 bilingual.js 的接口） ---------------- */
const SUBTITLES = [
  { id: 1, start_ms: 1000, end_ms: 3000, text: "源一\n第二行" },
  { id: 2, start_ms: 4000, end_ms: 6000, text: "源二" },
  { id: 3, start_ms: 8000, end_ms: 9000, text: "源三（无译文）" },
];
const TRANSLATION = [
  { id: 1, start_ms: 1100, end_ms: 4800, text: "Trans one two" },
  { id: 2, start_ms: 9000, end_ms: 9500, text: "Trans lonely" },
];
global.window.Workspace = {
  get subtitles() { return SUBTITLES; },
  anchors: [{ id: 1, subtitle_id: 1, original_ms: 1000, target_ms: 1100 }],
  locks: [],
  fileNameBase: "sample.calibrated",
};

/* ---------------- fetch 桩 ---------------- */
let importCalls = 0;
let exportCalls = [];
let nextImportMode = "ok"; // "ok" | "bad"
global.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  if (url === "/api/bilingual/import") {
    importCalls++;
    if (nextImportMode === "bad") {
      return {
        ok: false,
        status: 400,
        async json() {
          return {
            detail: {
              code: "translation_axis_invalid",
              message: "译文时间轴存在倒挂或重叠，已拒绝导入",
              reasons: ["译文 #2 时间倒挂：00:00:05,000 --> 00:00:04,000"],
            },
          };
        },
      };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          count: 2,
          translation: TRANSLATION,
          // t1 与 s1、s2 正长度相交（1100-4800）→ 一组多源；s3 与 t2 不相交（间隙）
          groups: [{ source_ids: [1, 2], translation_ids: [1] }],
          unpaired_source: [3],
          unpaired_translation: [2],
          can_export_bilingual: false,
        };
      },
    };
  }
  if (url === "/api/bilingual/export") {
    exportCalls.push(body);
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'attachment; filename="bilingual.srt"' },
      async json() { return {}; },
      async blob() { return new global.Blob(["SRT-BYTES"]); },
    };
  }
  throw new Error("未预期的请求：" + url);
};

/* ---------------- 加载 bilingual.js（IIFE） ---------------- */
const src = fs.readFileSync(
  path.join(__dirname, "..", "app", "static", "bilingual.js"), "utf8"
);
new Function(src)();
const BilingualUI = global.window.BilingualUI;
const assert = require("assert");

(async () => {
  // 初始：未导入译文，导出禁用
  assert.strictEqual(els["#bl-export"].disabled, true);
  assert.strictEqual(els["#bl-clear"].disabled, true);

  // 1) 模拟粘贴导入
  els["#bl-paste"].value = "1\n00:00:01,100 --> 00:00:04,800\nTrans one two";
  els["#bl-parse"].dispatch("click");
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(importCalls, 1);
  const html = els["#bl-list"].innerHTML;
  assert.ok(html.includes("源 #1、#2"), "组应列出源 id：" + html);
  assert.ok(html.includes("译 #1"), "组应列出译 id");
  assert.ok(html.includes("源 #3 未配对"), "未配对源字幕按源顺序展示");
  assert.ok(html.includes("未配对的译文字幕（1）"), "未配对译文列在最后");
  assert.ok(html.includes("源一"), "组内应保留源文正文（含多行）");
  assert.ok(els["#bl-status"].innerHTML.includes("禁止双语导出"), "状态应提示未配对");
  assert.strictEqual(els["#bl-export"].disabled, true, "有未配对条目禁止导出");
  assert.strictEqual(els["#bl-clear"].disabled, false);

  // 2) 即使预览无冲突，未配对仍禁止导出
  BilingualUI.setPreview(
    SUBTITLES.map((s) => ({ id: s.id, new_start_ms: s.start_ms, new_end_ms: s.end_ms })),
    true
  );
  assert.strictEqual(els["#bl-export"].disabled, true);

  // 3) 模拟「全部配对」的导入（组 #1 + 组 #2，无未配对）
  // 实际流程中锚点预览不断刷新，这里继续下发当前预览（can_export=false 时禁止导出）
  BilingualUI.setPreview(
    SUBTITLES.map((s) => ({ id: s.id, new_start_ms: s.start_ms, new_end_ms: s.end_ms })),
    false
  );
  nextImportMode = "ok";
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (url === "/api/bilingual/import") {
      importCalls++;
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            count: 2,
            translation: TRANSLATION,
            groups: [
              { source_ids: [1, 2], translation_ids: [1] },
              { source_ids: [3], translation_ids: [2] },
            ],
            unpaired_source: [],
            unpaired_translation: [],
            can_export_bilingual: true,
          };
        },
      };
    }
    if (url === "/api/bilingual/export") {
      exportCalls.push(body);
      return {
        ok: true,
        status: 200,
        async json() { return {}; },
        async blob() { return new global.Blob(["SRT-BYTES"]); },
      };
    }
    throw new Error("未预期的请求：" + url);
  };
  els["#bl-parse"].dispatch("click");
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(!els["#bl-list"].innerHTML.includes("bl-unpaired"), "应无未配对分组");
  assert.ok(!els["#bl-list"].innerHTML.includes("禁止双语导出"));
  // 预览 can_export=false（有冲突）→ 即便全配对仍禁止导出
  assert.strictEqual(els["#bl-export"].disabled, true);

  // 4) 锚点变化 → app.js 下发新预览（映射 +100ms），组时间取最早开始/最晚结束
  BilingualUI.setPreview(
    SUBTITLES.map((s, i) => ({
      id: s.id,
      new_start_ms: s.start_ms + 100,
      new_end_ms: s.end_ms + 100,
      locked: i === 2,
    })),
    true
  );
  assert.strictEqual(els["#bl-export"].disabled, false, "无未配对且预览无冲突应允许导出");
  const envHtml = els["#bl-list"].innerHTML;
  assert.ok(envHtml.includes("00:00:01,100 → 00:00:06,100"), "组时间应为源预览包络：" + envHtml);

  // 5) 预览出现冲突 → 立即禁止双语导出
  BilingualUI.setPreview(
    SUBTITLES.map((s) => ({ id: s.id, new_start_ms: s.start_ms, new_end_ms: s.end_ms })),
    false
  );
  assert.strictEqual(els["#bl-export"].disabled, true);
  BilingualUI.setPreview(
    SUBTITLES.map((s, i) => ({
      id: s.id, new_start_ms: s.start_ms + 100, new_end_ms: s.end_ms + 100,
    })),
    true
  );

  // 6) 导出双语 SRT：校验载荷
  els["#bl-export"].dispatch("click");
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(exportCalls.length, 1);
  const payload = exportCalls[0];
  assert.strictEqual(payload.subtitles.length, 3);
  assert.strictEqual(payload.translation.length, 2);
  assert.strictEqual(payload.anchors.length, 1);
  assert.deepStrictEqual(payload.locks, []);
  assert.strictEqual(downloaded, "sample.bilingual.srt", "文件名应走 bilingual 后缀");

  // 7) 译文时间倒挂/重叠：后端拒绝导入，旧配对保留不动（导入失败不落地）
  nextImportMode = "bad";
  global.fetch = async (url) => {
    if (url === "/api/bilingual/import") {
      importCalls++;
      return {
        ok: false,
        status: 400,
        async json() {
          return {
            detail: {
              code: "translation_axis_invalid",
              message: "译文时间轴存在倒挂或重叠，已拒绝导入",
              reasons: ["译文 #2 时间倒挂：00:00:05,000 --> 00:00:04,000"],
            },
          };
        },
      };
    }
    throw new Error("未预期的请求：" + url);
  };
  els["#bl-parse"].dispatch("click");
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(els["#bl-status"].innerHTML.includes("已拒绝导入"), els["#bl-status"].innerHTML);
  assert.ok(els["#bl-status"].innerHTML.includes("时间倒挂"));
  // 旧配对仍可导出
  assert.strictEqual(els["#bl-export"].disabled, false);

  // 8) 重新导入源 SRT → reset 清空译文与配对
  BilingualUI.reset();
  assert.strictEqual(els["#bl-export"].disabled, true);
  assert.strictEqual(els["#bl-clear"].disabled, true);
  assert.ok(els["#bl-list"].innerHTML.includes("导入对应译文"));
  // reset 后即便有（陈旧的）预览下发，也不会放开导出
  BilingualUI.setPreview(
    SUBTITLES.map((s) => ({ id: s.id, new_start_ms: 0, new_end_ms: 1 })),
    true
  );
  assert.strictEqual(els["#bl-export"].disabled, true);

  console.log("ok - bilingual.js 接线冒烟全部通过");
})().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
