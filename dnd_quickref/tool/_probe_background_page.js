/**
 * 背景页探针：不用浏览器，把 web/app.js 挂进极简 DOM 桩，连真服务跑一遍。
 *
 *   node tool/_probe_background_page.js [端口]
 *
 * 先起服务（dart run bin/quickref.dart --port 8799 --no-open），再跑这个。
 *
 * 查的是「工具熟练 / 语言」这条线：规则书给的很常是一句让你自己挑的指令
 * （工匠 → `选择一种工匠工具（参见第六章）`），这种应该给一个输入框让你写具体名字，
 * 而不是把整句指令抓进备选区、再写进卡里的值格（bugs/已知问题.md 的 O4）。
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const PORT = process.argv[2] || "8799";
const BASE = `http://127.0.0.1:${PORT}`;
const APP = path.resolve(__dirname, "..", "web", "app.js");

// ---------------------------------------------------------------- DOM 桩
function el(id) {
  const node = {
    id,
    value: "",
    checked: false,
    hidden: false,
    disabled: false,
    textContent: "",
    innerHTML: "",
    placeholder: "",
    className: "",
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {},
    removeEventListener() {},
    appendChild() {},
    removeChild() {},
    insertBefore() {},
    setAttribute() {},
    getAttribute: () => null,
    contains: () => false,
    remove() {},
    focus() {},
    select() {},
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  return node;
}

const byId = new Map();
const styleStub = () => ({
  setProperty() {}, removeProperty() {}, getPropertyValue: () => "",
});
const document = {
  documentElement: { style: styleStub(), dataset: {}, classList: el("html").classList },
  body: el("body"),
  head: el("head"),
  getElementById(id) {
    if (!byId.has(id)) byId.set(id, el(id));
    return byId.get(id);
  },
  createElement: (tag) => el("new-" + tag),
  querySelector: () => null,
  addEventListener() {},
  removeEventListener() {},
  querySelectorAll: () => [],
};

const sandbox = {
  document,
  console,
  // 页面里用的都是相对路径（/api/xxx），这里补上前缀指向真服务
  fetch: (url, opts) => fetch(url.startsWith("/") ? BASE + url : url, opts),
  setTimeout,
  clearTimeout,
  Promise,
  String,
  Object,
  Array,
  RegExp,
  Math,
  JSON,
  Number,
  Boolean,
  Error,
  encodeURIComponent,
  location: { href: BASE + "/" },
  localStorage: { getItem: () => null, setItem() {} },
  addEventListener() {},
  removeEventListener() {},
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

const ctx = vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(APP, "utf8"), ctx, { filename: APP });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 把列表 HTML 拆成一行行，报告每条的标签 / 是不是给了输入框 / 有没有「+」 */
function rowSummary(html) {
  const out = [];
  const re = /<div class="item"[\s\S]*?(?=<div class="item"|$)/g;
  for (const chunk of html.match(re) || []) {
    const label = (chunk.match(/<div class="t">([\s\S]*?)<\/div>/) || [, "?"])[1];
    const text = (chunk.match(/<div class="s">([\s\S]*?)<\/div>/) || [, ""])[1];
    out.push({
      label,
      text,
      picker: chunk.includes('class="pickin"'),
      plus: chunk.includes('title="抓进备选区"'),
      intray: chunk.includes("已在备选区"),
    });
  }
  return out;
}

async function showBackground(name) {
  vm.runInContext(
    `cf.info = { key: 'background', elsewhere: [{ label: '出身', value: ${JSON.stringify(name)} }], selectors: [] };`,
    ctx);
  vm.runInContext("renderBackgroundList()", ctx);
  await wait(1200);
  const list = byId.get("cfList") || el("cfList");
  console.log(`\n=== 出身「${name}」（${(byId.get("cfCount") || {}).textContent}）===`);
  for (const r of rowSummary(list.innerHTML)) {
    const how = r.picker ? "输入框（要你自己挑）" : r.plus ? "「+」直接抓" : r.intray ? "已在备选区" : "无入口";
    console.log(`   ${r.label.padEnd(6, "　")} → ${how}   规则原文：${r.text}`);
  }
  return rowSummary(list.innerHTML);
}

async function main() {
  await wait(4500); // 等 init() 把 meta / table / tray / 设计树都拉完（它会覆盖 cf.info）
  const expectPicker = { 工匠: true, 艺人: true, 警卫: true, 贵族: true, 士兵: true, 侍僧: false, 智者: false, 骗子: false };
  let bad = 0;
  for (const name of Object.keys(expectPicker)) {
    const rows = await showBackground(name);
    const tool = rows.find((r) => r.label === "工具熟练");
    if (!tool) { console.log(`   !! 没渲染出「工具熟练」这一条`); bad++; continue; }
    const want = expectPicker[name];
    const got = tool.picker;
    if (want !== got) {
      console.log(`   !! 期望${want ? "有" : "没有"}输入框，实际${got ? "有" : "没有"}`);
      bad++;
    }
  }
  console.log(`\n${bad === 0 ? "全部符合预期" : bad + " 条不符合预期"}`);
  process.exit(bad === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("探针挂了：", e);
  process.exit(1);
});
