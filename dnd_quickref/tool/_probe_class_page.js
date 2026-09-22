/**
 * 职业页探针：不用浏览器，把 web/app.js 挂进极简 DOM 桩，连真服务跑一遍。
 *
 *   node tool/_probe_class_page.js [端口]
 *
 * 先起服务（dart run bin/quickref.dart --port 8799 --no-open），再跑这个。
 * 它做两件事：
 *   1. 拿规则书真的职业正文，检查「核心特质」「N级：特性」两套解析
 *   2. 走一遍 selectNode('class.main') / selectNode('class.level')，把渲染出来的 HTML 打出来看
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const PORT = process.argv[2] || "8799";
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(__dirname, "..", "..");
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
    classList: {
      add() {}, remove() {}, toggle() {}, contains: () => false,
    },
    addEventListener() {},
    appendChild() {},
    focus() {},
    select() {},
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  return node;
}

const byId = new Map();
const document = {
  getElementById(id) {
    if (!byId.has(id)) byId.set(id, el(id));
    return byId.get(id);
  },
  createElement: (tag) => el("new-" + tag),
  addEventListener() {},
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
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

const ctx = vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(APP, "utf8"), ctx, { filename: APP });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // init() 在文件末尾跑，先等它把 meta / table / tray 拉完
  await wait(2500);

  const rules = JSON.parse(
    fs.readFileSync(path.join(ROOT, "dnd-data", "card_rules.json"), "utf8")).items;
  const byName = (kind, name) => rules.find((r) => r.kind === kind && r.name === name);

  console.log("=== 核心特质解析 ===");
  for (const name of ["战士", "吟游诗人", "牧师", "法师", "野蛮人"]) {
    const it = byName("class", name);
    if (!it) { console.log(`${name}: 规则库里没有`); continue; }
    const traits = vm.runInContext(`parseClassTraits(${JSON.stringify(it.text)})`, ctx);
    console.log(`${name}（${it.book}）`);
    for (const t of traits) console.log(`   ${t.label} → ${t.text.slice(0, 60)}`);
    const menu = traits.filter((t) => vm.runInContext(`classItemKind(${JSON.stringify(t)})`, ctx) === "menu");
    for (const m of menu) {
      console.log(`   勾选菜单：${JSON.stringify(vm.runInContext(`classMenu(${JSON.stringify(m.text)})`, ctx))}`);
    }
  }

  console.log("\n=== 等级特性解析（战士，取前 6 条）===");
  const warrior = byName("class", "战士");
  const feats = vm.runInContext(`parseClassFeatures(${JSON.stringify(warrior.text)})`, ctx);
  for (const f of feats.slice(0, 6)) console.log(`   ${f.level}级 ${f.name} → ${f.text.split("\n")[0].slice(0, 40)}`);
  console.log(`   共 ${feats.length} 条`);
  const sub = byName("subclass", "战斗大师");
  const subFeats = vm.runInContext(`parseClassFeatures(${JSON.stringify(sub.text)})`, ctx);
  console.log(`   子职「战斗大师」共 ${subFeats.length} 条：${subFeats.map((f) => f.level + "级" + f.name).join("、")}`);

  console.log("\n=== 页面渲染（走 selectNode）===");
  for (const nodeId of ["class.main", "class.level"]) {
    vm.runInContext(`selectNode(${JSON.stringify(nodeId)})`, ctx);
    await wait(1200);
    const list = byId.get("cfList") || el("cfList");
    const head = byId.get("cfLocked") || el("cfLocked");
    console.log(`--- ${nodeId} ---`);
    console.log("   锁定行：" + head.innerHTML.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    console.log("   计数：" + (byId.get("cfCount") || {}).textContent);
    console.log("   列表：" + list.innerHTML.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 260));
  }

  // 加 --fill 就真写一次：备选区里攒一条职业效果 + 一条职业特性，走一次「填入表格」
  if (process.argv.indexOf("--fill") < 0) return;
  console.log("\n=== 备选区 → 填入表格（真写进探针卡）===");
  vm.runInContext(`
    stageState.items.push({ kind: 'effect', formKey: 'class', page: '职业', label: '技能熟练', text: '宗教' });
    stageState.items.push({ kind: 'effect', formKey: 'class', page: '职业', label: '工具熟练', text: '书法工具' });
    stageState.items.push({ kind: 'entry', formKey: 'class', page: '职业', id: 'lv:1:回气', name: '回气', subtitle: '1级 · 战士' });
    fillStage();
  `, ctx);
  await wait(3000);
  console.log("   " + (byId.get("stageAfterTitle") || {}).textContent);
  console.log("   " + String((byId.get("stageAfterDetail") || {}).textContent).split("\n").join("\n   "));
  console.log("   提示：" + ((byId.get("stageMsg") || {}).textContent || "（无）"));
}

main().catch((e) => {
  console.error("探针挂了：", e);
  process.exit(1);
});
