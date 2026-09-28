'use strict';
// 法术速查填表：左（列表）→ 中（详情）→ 抓进最右的备选区 → 从那儿选表 → 一键填入

// 前端期望的服务端接口版本：对不上说明服务没重启（比如还开着旧窗口）
const API_VERSION = 6;

const state = {
  q: '',
  filters: {},          // {环阶:'3', 学派:'塑能', 职业:'法师', 来源:'玩家手册'}
  items: [],
  total: 0,
  current: null,
  tray: { count: 0, items: [], duplicates: [] },
  table: null,
  meta: null,
};

const $ = (id) => document.getElementById(id);
const esc = (s) => (s == null ? '' : String(s)).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// 与服务端 normalizeKey 保持一致：去空白与常见标点、统一小写
function norm(s) {
  return String(s == null ? '' : s)
    .replace(/\s+/g, '')
    .replace(/[·・．.\-—–_（）()\[\]【】「」《》]/g, '')
    .toLowerCase();
}

async function api(path, opts) {
  const r = await fetch(path, opts);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}

const post = (path, body) => api(path, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body || {}),
});

function msg(text, cls) {
  // 页内填入区没了，所有提示都落到备选区那一句上
  const m = $('stageMsg');
  if (!m) return;
  m.className = 'msg ' + (cls || '');
  m.textContent = text || '';
}

// ---------------------------------------------------------------- 元数据
// ---------------------------------------------------------------- 可拖的长宽
// 设计树 / 列表 / 备选区 / 速查块的大小都能拖，松手存进 localStorage，下次打开还是这个尺寸。
const SIZES_KEY = 'quickref.sizes';
let sizes = {};
try { sizes = JSON.parse(localStorage.getItem(SIZES_KEY) || '{}') || {}; } catch (e) { sizes = {}; }

function saveSizes() {
  try { localStorage.setItem(SIZES_KEY, JSON.stringify(sizes)); } catch (e) {}
}

function applySizes() {
  const root = document.documentElement.style;
  if (sizes.tree) root.setProperty('--tree-w', sizes.tree + 'px');
  if (sizes.stage) root.setProperty('--stage-w', sizes.stage + 'px');
  if (sizes.list) root.setProperty('--list-w', sizes.list + 'px');
  if (sizes.lookupW) $('fmLookup').style.width = sizes.lookupW + 'px';
  if (sizes.lookupH) $('lkList').style.maxHeight = sizes.lookupH + 'px';
}

const clampNum = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/// 拖一条分隔条：onStart() 给出起始值，onMove(dx, dy, start, ev) 里自己算并写回
function dragResize(handle, onStart, onMove) {
  if (!handle) return;
  handle.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    const start = onStart();
    const sx = ev.clientX, sy = ev.clientY;
    document.body.classList.add('dragging');
    const move = (e) => onMove(e.clientX - sx, e.clientY - sy, start, e);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('dragging');
      saveSizes();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
}

function wireResizers() {
  // 设计树 / 备选区：拖的是外面的两条竖线
  dragResize($('splitTree'),
    () => $('tree').getBoundingClientRect().width,
    (dx, _dy, w0) => {
      const w = clampNum(w0 + dx, 130, 520);
      document.documentElement.style.setProperty('--tree-w', w + 'px');
      sizes.tree = Math.round(w);
    });
  dragResize($('splitStage'),
    () => $('stage').getBoundingClientRect().width,
    (dx, _dy, w0) => {
      const w = clampNum(w0 - dx, 220, 720);
      document.documentElement.style.setProperty('--stage-w', w + 'px');
      sizes.stage = Math.round(w);
    });
  // 列表 / 详情之间那条（法术页和词条页各有一条，共用同一个宽度）
  document.querySelectorAll('.hv-list').forEach((el) => {
    dragResize(el,
      () => ($('list') || $('cfList')).getBoundingClientRect().width,
      (dx, _dy, w0) => {
        const w = clampNum(w0 + dx, 200, 760);
        document.documentElement.style.setProperty('--list-w', w + 'px');
        sizes.list = Math.round(w);
      });
  });
  // 速查块：右边调宽、下边调高
  dragResize($('lkResizeE'),
    () => $('fmLookup').getBoundingClientRect().width,
    (dx, _dy, w0) => {
      const w = clampNum(w0 + dx, 380, 2400);
      $('fmLookup').style.width = w + 'px';
      sizes.lookupW = Math.round(w);
    });
  dragResize($('lkResizeS'),
    () => parseInt(getComputedStyle($('lkList')).maxHeight, 10) || 300,
    (_dx, dy, h0) => {
      const h = clampNum(h0 + dy, 80, 900);
      $('lkList').style.maxHeight = h + 'px';
      sizes.lookupH = Math.round(h);
    });
}

async function loadMeta() {
  state.meta = await api('/api/meta');
  const c = state.meta.counts || {};
  if (state.meta.api !== API_VERSION) {
    $('staleWarn').hidden = false;
  } else {
    $('staleWarn').hidden = true;
  }
  renderFilters();
  renderCfFilters();
}

// ---------------------------------------------------------------- 顶栏：车卡进度
// 「哪些填了 / 哪些还没填 / 还能选什么」——点一下就跳到对应的页面。
// 数据全从已有接口拿：基本信息 + 属性技能两张表单、专长页、当前表格。
const PG_TARGET = {
  '角色名': 'basic', '玩家': 'basic', '种族': 'basic', '亚种': 'basic',
  '出身': 'basic', '阵营': 'basic', '主职业': 'basic', '子职业': 'basic', '等级': 'basic',
  '六项属性': 'basic', '技能熟练': 'basic', '豁免熟练': 'basic',
  '专长': 'feat', '法术位': 'spell.list', '工具熟练': 'origin',
};

/// 上面那些格子各属于哪一块：悬浮窗第二页「待办事项」按这个分组排
const PG_GROUP = {
  '角色名': '基本信息', '种族': '基本信息', '亚种': '基本信息', '出身': '基本信息', '阵营': '基本信息',
  '主职业': '职业', '子职业': '职业', '等级': '职业',
  '六项属性': '属性与技能', '技能熟练': '属性与技能', '豁免熟练': '属性与技能',
  '专长': '专长', '法术位': '法术', '工具熟练': '出身',
};

function formFieldsMap(info) {
  const out = new Map();
  for (const s of (info && info.sections) || []) {
    for (const f of (s.fields || [])) {
      out.set(f.field, (f.value == null ? '' : String(f.value)).trim());
      if (f.cell) out.set('@' + f.cell, (f.value == null ? '' : String(f.value)).trim());
    }
  }
  return out;
}

/// 把备选区里攒着、还没写进表的字段值盖到表单映射上。
///
/// 进度算的是「这个人卡现在定了什么」，所以攒在备选区里的那些也算数 ——
/// 不然填完一整页、只要还没点「填入表格」，待办就还全报「未填」。
function applyStagedFields(map, formKey) {
  for (const e of stageState.items) {
    if (e.kind !== 'field') continue;
    if (formKey && e.formKey !== formKey) continue;
    const v = String(e.value == null ? '' : e.value).trim();
    if (e.field) map.set(e.field, v);
    if (e.cell) map.set('@' + e.cell, v);
  }
}

/// 等级 → 该有的专长数（2024：4/8/12/16 级各一次属性值提升 / 专长，19 级传奇恩惠）
function featsByLevel(lv) {
  return [4, 8, 12, 16, 19].filter((x) => x <= lv).length;
}

async function loadProgress() {
  if (!state.table || !state.table.exists) { renderProgress([]); return; }
  try {
    const [basic, attrs, feat, table] = await Promise.all([
      api('/api/form?key=basic'),
      api('/api/form?key=attrs'),
      api('/api/page?key=feat'),
      api('/api/table'),
    ]);
    const b = formFieldsMap(basic);
    const a = formFieldsMap(attrs);
    applyStagedFields(b, 'basic');
    applyStagedFields(a, 'basic');
    const lv = parseInt(b.get('level') || '0', 10) || 0;
    const rows = [];
    const add = (label, value, ok, hint) => rows.push({ label, value, ok, hint: hint || '' });
    const ask = (label, v, hint) => add(label, v ? v : '未填', !!v, hint);

    ask('角色名', b.get('name'));
    ask('种族', b.get('race'));
    ask('亚种', b.get('subrace'));
    // 「自定义背景」是占位，等于还没选
    const bg = b.get('background') || '';
    add('出身', bg && bg !== '自定义背景' ? bg : '未定', !!bg && bg !== '自定义背景');
    ask('阵营', b.get('alignment'));
    ask('主职业', b.get('cls'));
    if (b.get('cls')) ask('子职业', b.get('sub'));
    add('等级', lv ? lv + ' 级' : '未填', !!lv);

    // 六项属性的初始值：六个都填了才算过
    // 卡里模板预填的 10 算「还没动」——真填过的一定跟 10 不一样
    // 格子从表单里认，别写死 13–18 行（老版式卡的技能表整块会挪，属性块虽然稳，但同源的东西一起认更保险）
    const attrCells = [];
    // 格子从表单里认，别写死 13–18 行。注意这里要看 attrs.sections —— a 是
    // formFieldsMap() 出来的 Map，没有 .sections，写成 a.sections 会永远取到空表，
    // 于是这一行恒定显示「0/6 有值」还判成已完成。
    for (const s of (attrs.sections || [])) {
      if (s.title !== '六项属性') continue;
      for (const f of (s.fields || [])) {
        if (f.label === '初始值' && f.cell) attrCells.push(f.cell);
      }
    }
    const filled = attrCells.filter((c) => {
      const v = a.get('@' + c) || '';
      return v && v !== '10';
    }).length;
    add('六项属性', `${filled}/6 有值`, filled === attrCells.length);

    // 技能熟练：卡里打 O 的条数；职业正文里写着「选择 N 项」就一起报
    // 技能行同样从卡里认：v1.1.1 在 40–61 行、v1.0.12 在 41–62 行、米瑞尔那种老卡在 32–53 行，
    // 写死会把法术块、属性分组标题也数进去。
    // 每行连技能名一起记下来：备选区里排队等着打 O 的那几条也要数（还没写进表）。
    const skillRows = [];
    for (const s of (attrs.sections || [])) {
      if (s.title !== '技能') continue;
      let rowName = '';
      for (const f of (s.fields || [])) {
        if (f.kind === 'label' && f.cell && f.value) rowName = String(f.value).trim();
        if (f.kind === 'toggle' && f.label === '熟练' && f.cell) {
          skillRows.push({ cell: f.cell, name: rowName });
        }
      }
    }
    // 「技能熟练」那几条：表单字段（勾选）是 kind=field、出身/职业给的整句是
    // kind=effect、种族/专长挑出来的单条是 kind=prof —— 三种都算。整句那种
    // （「运动和威吓」）按名字包含来认。
    const stagedSkillText = stageState.items
      .filter((e) => e.label === '技能熟练')
      .map((e) => String(e.kind === 'prof' ? (e.value || '') : (e.text || '')).trim())
      .filter((t) => t);
    const skills = skillRows.filter((r) => {
      if ((a.get('@' + r.cell) || '').toUpperCase() === 'O') return true;
      return !!r.name && stagedSkillText.some((t) => t.includes(r.name));
    }).length;
    let need = 0;
    let spellRule = null;      // 职业特性表里那张「该等级要选几个戏法 / 几个法术」的规则
    if (b.get('cls')) {
      try {
        const r = await api('/api/rule?kind=class&name=' + encodeURIComponent(b.get('cls')));
        if (r.found) {
          const t = (parseClassTraits(r.text) || []).find((x) => x.label === '技能熟练');
          const menu = t ? classMenu(t.text) : null;
          need = menu ? menu.pick : 0;
          spellRule = classSpellTable(r.text, lv);
        }
      } catch (e) {}
    }
    add('技能熟练', need ? `${skills}/${need}` : `${skills} 项`, need ? skills >= need : skills > 0);
    add('豁免熟练', b.get('cls') ? '看职业' : '未定', !!b.get('cls'));

    // 专长：卡里已经写了几个，按等级还差几个
    const got = (feat.existing || []).length;
    const want = featsByLevel(lv);
    const left = Math.max(0, want - got);
    add('专长', left ? `还能选 ${left} 个` : `${got} 个`, !left && got > 0,
      lv ? `${lv} 级：4·8·12·16·19 级各一个` : '等级还没填（基本信息里选了等级就按 4·8·12·16·19 算）');

    const freeSlots = Math.max(0, (table.slotsTotal || 0) - (table.used || 0));
    add('法术位', freeSlots ? `空 ${freeSlots} 格` : '已满', true,
      `卡里一共 ${table.slotsTotal || 0} 格（已占 ${table.used || 0}）`);
    // 规则配额给「已选」那一栏用（只是提示，不拦）
    state.progress = {
      lv: lv,
      cls: b.get('cls') || '',
      skillNeed: need,
      skills: skills,
      featExisting: (feat.existing || []).length,
      featNames: (feat.existing || []).slice(),
      slotUsed: table.used || 0,
      slotTotal: table.slotsTotal || 0,
      spellRule: spellRule,
    };
    // 每条进度挂上「属于哪一块 / 点了跳哪一页」：悬浮窗第二页「待办」直接拿去排版
    for (const r of rows) {
      r.group = PG_GROUP[r.label] || '其它';
      r.go = PG_TARGET[r.label] || '';
    }
    renderPickedPanes();     // 配额（上限）跟着进度一起刷新
    renderProgress(rows);
    // 卡里已经填了哪些法术（带环阶）——「已选几个」要用它，顶栏和待办页都得等这份数据
    loadTodoCard().catch(() => {});
  } catch (e) {
    renderProgress([]);
  }
}

function renderProgress(baseRows) {
  state.progressRows = baseRows || [];   // 基础那几条；法术那两行按规则书现算（见 todoRowsAll）
  const rows = todoRowsAll();
  const hasTable = !!(state.table && state.table.exists);
  const miss = rows.filter((r) => !r.ok).length;
  // 顶栏那排进度格子删了（太占地方）；现在只在「备选区」标题行留一颗入口，
  // 缺几项就挂在它旁边，点开就是悬浮窗第二页的完整清单。
  const btn = $('btnTodo');
  if (btn) {
    const bad = hasTable && miss > 0;
    btn.innerHTML = bad ? `📋 待办<b class="n">${miss}</b>` : '📋 待办';
    btn.classList.toggle('miss', bad);
    btn.title = !hasTable
      ? '打开悬浮窗第二页「待办事项」（先选一张目标表格）'
      : (bad ? `打开悬浮窗第二页「待办事项」：还差 ${miss} 项没定` : '打开悬浮窗第二页「待办事项」：该定的都定了');
  }
  renderTodoPop();      // 悬浮窗第二页开着的话，跟着进度一起刷新
}

const FACETS = [
  ['环阶', (v) => (v === '0' ? '戏法' : v + '环'), ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']],
  ['学派', null, null],
  ['职业', null, null],
  ['来源', null, null],
];

function filterQuery() {
  const alias = { '环阶': 'lvl', '学派': 'school', '职业': 'cls', '来源': 'src' };
  const parts = [];
  for (const [k, v] of Object.entries(state.filters)) {
    if (v) parts.push(`${alias[k] || k}=${encodeURIComponent(v)}`);
  }
  return parts.join('&');
}

function renderFilters() {
  const box = $('filters');
  box.innerHTML = '';
  const counts = (state.meta && state.meta.facets && state.meta.facets.spell) || {};
  for (const [field, label, fixedOrder] of FACETS) {
    const c = counts[field];
    if (!c) continue;
    let values = fixedOrder ? fixedOrder.filter((v) => c[v]) : Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 24).map(([k]) => k);
    if (!values.length) continue;
    const g = document.createElement('div');
    g.className = 'fgroup';
    g.innerHTML = `<h4>${esc(field)}</h4>`;
    const opts = document.createElement('div');
    opts.className = 'opts';
    for (const v of values) {
      const b = document.createElement('button');
      b.className = state.filters[field] === v ? 'on' : '';
      b.textContent = label ? label(v) : v;
      b.onclick = () => {
        state.filters[field] = state.filters[field] === v ? '' : v;
        renderFilters();
        search();
      };
      opts.appendChild(b);
    }
    g.appendChild(opts);
    box.appendChild(g);
  }
}

// ---------------------------------------------------------------- 检索
async function search() {
  hidePop();              // 列表要重画了，旧的那条词条窗先收掉（「待办」那页是常驻的，不收）
  const url = `/api/search?q=${encodeURIComponent(state.q)}&limit=400` + (filterQuery() ? '&' + filterQuery() : '');
  const r = await api(url);
  state.items = r.items;
  state.total = r.total;
  $('resCount').textContent = r.total > r.items.length ? `${r.items.length} / ${r.total} 条` : `${r.total} 条`;
  const list = $('list');
  list.innerHTML = r.items.map((e, i) => `
    <div class="item" data-i="${i}">
      <div class="t">${esc(e.name)}<span class="en">${esc(e.en)}</span></div>
      ${stageHasEntry(e.id) ? '<span class="intray">已在备选区</span>' : '<button class="add" title="抓进备选区">+</button>'}
      <div class="s">${esc(e.subtitle)}</div>
    </div>`).join('') || '<div class="empty">没有匹配结果</div>';
  [...list.querySelectorAll('.item')].forEach((el) => {
    const brief = r.items[+el.dataset.i];
    el.onclick = (ev) => {
      if (ev.target.classList.contains('add')) {
        ev.stopPropagation();
        addStageEntry('spell', brief, '法术', () => search());
        return;
      }
      openEntry(brief, el);
    };
  });
}

// ---------------------------------------------------------------- 词条效果悬浮窗
/// 列表里点哪一条（法术 / 职业特性 / 种族特性 / 专长 / 魔法物品），效果都在这个悬浮窗里看；
/// 悬停也会自动弹一个（点一下会「钉住」，再点别处 / 按 Esc 关掉）。
///
/// 中间那一栏因此空出来了，改成「已选」清单——那是给你看清自己挑了哪些东西的，
/// 跟右下角的备选区不是一回事：**备选区是待写队列，写表走「填入表格」**。
/// 悬浮窗就两页：`entry` = 词条详解（点哪条看哪条），`todo` = 待办事项（还差什么、还能选什么）。
/// `todo` 那页是常驻的：列表重画、点到别处都不收，要关就按 Esc 或点 ✕。
const popState = { seq: 0, id: '', kind: '', onAdd: null, onChoice: null, tab: 'entry', last: null };

function popTags(e, kind) {
  const f = e.fields || {};
  const tags = [];
  if (kind === 'spell') {
    const lv = f['环阶'];
    if (lv != null && lv !== '') tags.push(lv === '0' ? '戏法' : lv + '环');
    for (const k of ['学派', '来源']) if (f[k]) tags.push(f[k]);
    if (f['专注'] === '是') tags.push('专注');
    if (f['仪式'] === '是') tags.push('仪式');
    return tags;
  }
  for (const k of ['职业', '子职']) if (f[k]) tags.push(f[k]);
  if (f['等级']) tags.push(f['等级'] + '级');
  if (f['类别']) tags.push(f['类别']);
  if (f['稀有度']) tags.push(f['稀有度']);
  if (e.source) tags.push(e.source);
  return tags;
}

function entryPopHtml(e, kind) {
  const fields = Object.entries(e.fields || {});
  const tags = popTags(e, kind);
  const has = e.id ? stageHasEntry(e.id) : false;
  return popBarHtml(POP_KIND_LABEL[kind] || '词条') + `
    <div class="pop-body">
      <h2>${esc(e.name)}</h2>
      <div class="en">${esc(e.en)}</div>
      <div class="tagline">${tags.map((t, i) => `<span class="tag${i === 0 ? ' hot' : ''}">${esc(t)}</span>`).join('')}</div>
      ${(e.choices && e.choices.length)
        ? `<div class="choices"><div class="choices-t">${esc(e.choicesHint || '这条要你挑一个：')}</div>` +
          e.choices.map((c) => `<button class="pop-choice" data-v="${esc(c)}">${esc(c)}</button>`).join('') + '</div>'
        : ''}
      ${e.hideAdd ? '' : `<div class="add"><button class="primary" id="popAdd" ${has ? 'disabled' : ''}>${has ? '已在备选区' : '+ 抓进备选区'}</button></div>`}
      ${fields.length ? `<table>${fields.map(([k, v]) => `<tr><td class="k">${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>` : ''}
      <pre>${esc(e.text || '')}</pre>
    </div>
    ${POP_GRIP}`;
}

const POP_KIND_LABEL = {
  spell: '法术', classFeature: '职业特性', species: '种族特性', feat: '专长', magicItem: '魔法物品',
  equipment: '装备',
  // 备选区里点非词条的行时会用到（效果 / 普通字段 / 规则库条目）
  effect: '规则效果', field: '表格字段',
  class: '职业', subclass: '子职业', background: '出身',
  prof: '熟练项',
};

const POP_GRIP = '<div class="pop-grip" title="拖动调整大小"></div>';

/// 悬浮窗顶上那一条 + 两个页签（① 词条详解 ② 待办事项）
function popBarHtml(kindLabel) {
  const tab = (key, label) =>
    `<button class="pop-tab${popState.tab === key ? ' on' : ''}" data-tab="${key}">${esc(label)}</button>`;
  return `<div class="pop-bar" title="按住这里拖动">
      <span class="pop-kind">${esc(kindLabel)}</span>
      <span class="pop-hint">可拖动</span>
      <button class="pop-x" title="关闭（Esc 也行）">✕ 关闭</button>
    </div>
    <div class="pop-tabs">${tab('entry', '词条详解')}${tab('todo', '待办事项')}</div>`;
}

/// 悬浮窗里那些固定控件（关闭 / 切页 / 待办行跳转 / 「抓进备选区」）统一在这儿接线
function wirePopChrome() {
  const pop = $('pop');
  const x = pop.querySelector('.pop-x');
  if (x) x.onclick = (e) => { e.stopPropagation(); hidePop(true); };
  [...pop.querySelectorAll('.pop-tab')].forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); switchPopTab(b.dataset.tab); };
  });
  [...pop.querySelectorAll('.todo-go')].forEach((el) => {
    el.onclick = (e) => { e.stopPropagation(); selectNode(el.dataset.go); };
  });
  // 「……之一」那种熟练的候选按钮
  [...pop.querySelectorAll('.pop-choice')].forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      const fn = popState.onChoice;
      hidePop(true);
      if (fn) fn(b.dataset.v || '');
    };
  });
  const add = $('popAdd');
  if (add && !add.disabled && popState.onAdd) {
    add.onclick = () => {
      popState.onAdd();
      add.textContent = '已在备选区';
      add.disabled = true;
    };
  }
}

function paintEntryPop(data) {
  popState.last = data;
  $('pop').innerHTML = entryPopHtml(data, data.kind || '');
  wirePopChrome();
}

/// 切页签：词条那页拿最近看过的那条重画（没有就提示点一条），待办那页现算
function switchPopTab(tab) {
  if (tab === popState.tab) return;
  popState.tab = tab;
  if (tab === 'todo') {
    renderTodoPop();
    loadProgress().catch(() => {});     // 顺手刷一遍进度，画完会自己重画
    loadTodoCard().catch(() => {});     // 卡里已经填了哪些法术（带环阶）
  } else if (popState.last) {
    paintEntryPop(popState.last);
  } else {
    $('pop').innerHTML = popBarHtml('词条') +
      `<div class="pop-body"><div class="empty">左边点一条词条（法术 / 职业特性 / 种族特性 / 专长 / 魔法物品），<br>效果就显示在这里。</div></div>${POP_GRIP}`;
    wirePopChrome();
  }
}

// ------------------------------------------------------------ 待办事项（悬浮窗第二页）
/// 副标题里的环阶：'戏法' → '0'，'2环 · 塑能…' → '2'，认不出来给 ''
function spellLevelOf(subtitle) {
  const m = /(戏法|(\d+)\s*环)/.exec(String(subtitle || ''));
  if (!m) return '';
  return m[1].charAt(0) === '戏' ? '0' : m[2];
}

/// 你手上已经挑了的法术：卡里填的（/api/card）+ 备选区里的，按名字去重，尽量认出环阶
function pickedSpellLevels() {
  const seen = new Map();          // 归一化名 → 环阶
  const put = (name, subtitle) => {
    const k = norm(name);
    if (!k) return;
    const lv = spellLevelOf(subtitle);
    if (!seen.has(k) || (seen.get(k) === '' && lv !== '')) seen.set(k, lv);
  };
  for (const e of (todoCard.entries || [])) if (e.formKey === 'spell') put(e.name, e.subtitle);
  for (const e of (stageState.items || [])) {
    if (e.kind === 'entry' && e.formKey === 'spell') put(e.name, e.subtitle);
  }
  return [...seen.values()];
}

/// 职业正文里那张「职业特性表」→ 这个等级要选几个戏法 / 几个法术 / 最高能选到几环。
///
/// 表是一格一个 token 竖着排下来的，表头就是列名：
///   等级 / 熟练加值(PB) / 职业特性 / [职业自己的列…] / 戏法 / 准备法术 / 一环…九环
/// 所以按表头名字定位列号就够了 —— 吟游诗人多一列「诗人骰」、牧师多一列「引导神力」、
/// 圣武士 / 游侠根本没有「戏法」那一列、魔契师的法术位写在「法术位环阶」里，这些都不用特判。
function classSpellTable(text, lv) {
  if (!text || !lv) return null;
  const lines = String(text).split(/\r?\n/).map((s) => s.trim());
  let i = lines.findIndex((l, k) => l === '等级' && (lines[k + 1] || '').indexOf('熟练加值') === 0);
  if (i < 0) return null;
  const hdr = [];
  while (i < lines.length && !/^\d+$/.test(lines[i])) hdr.push(lines[i++]);
  // 去掉「——每环法术位——」那种占一整行的分组标题（真列名不会以破折号开头），
  // 顺手把 UA 里「戏法*」这种带星号的列名还原
  const cols = hdr.filter((h) => h && !/^[-—–]/.test(h)).map((h) => h.replace(/\*/g, '').trim());
  const n = cols.length;
  if (!n) return null;
  const table = [];
  while (i + n <= lines.length && /^\d+$/.test(lines[i])) { table.push(lines.slice(i, i + n)); i += n; }
  const row = table[lv - 1];
  if (!row) return null;
  const at = (name) => { const k = cols.indexOf(name); return k < 0 ? null : row[k]; };
  const num = (v) => (v != null && /^\d+$/.test(v) ? +v : 0);
  const RING = '一二三四五六七八九';
  let maxLevel = 0;
  for (let k = 0; k < 9; k++) {
    const v = at(RING[k] + '环');
    if (v != null && v !== '—' && v !== '-') maxLevel = k + 1;
  }
  if (!maxLevel) {
    // 魔契师：法术位只到 5 环，环阶单独写一列
    const v = String(at('法术位环阶') || '');
    const k = RING.indexOf(v.charAt(0));
    if (k >= 0) maxLevel = k + 1;
  }
  const label = cols.includes('已知法术') ? '已知法术' : '准备法术';
  const prepared = at(label);
  if (prepared == null) return null;   // 这张职业表不是施法职业的写法
  return {
    hasCantrips: cols.includes('戏法'),
    cantrips: cols.includes('戏法') ? num(at('戏法')) : 0,
    label: label,
    prepared: num(prepared),
    maxLevel: maxLevel,
  };
}

/// 法术那两行：戏法 / 法术 —— 按规则书算「还要选几个、几环」（← 「还能选几个几环法术」）
function spellTodoRows() {
  const t = state.table || {};
  if (!t.exists) return [];
  const p = state.progress || {};
  const levels = pickedSpellLevels();
  const tally = new Map();
  let haveC = 0, haveS = 0, unknown = 0;
  for (const l of levels) {
    tally.set(l, (tally.get(l) || 0) + 1);
    if (l === '0') haveC++;
    else if (l === '') unknown++;
    else haveS++;
  }
  const parts = [];
  if (tally.size) parts.push('已选：' + tallyText(tally));
  if (unknown) parts.push(`另有 ${unknown} 条认不出环阶`);
  if (todoCard.loading) parts.push('正在读卡里已有的法术…');
  parts.push(`卡里「法术书」${t.slotsTotal || 0} 格，已填 ${t.used || 0}`);
  const detail = parts.join('；');

  const rule = p.spellRule;
  if (!rule) {
    // 认不出这张职业表（第三方职业 / 规则书里没有）：退回「卡里还剩几个格」
    const free = Math.max(0, (t.slotsTotal || 0) - (t.used || 0));
    return [{
      group: '法术', label: '法术位', value: free ? `空 ${free} 格` : '已满', ok: true,
      go: 'spell.list', hint: '没从规则书里认出这张职业的施法表，先按卡里还剩多少格看', detail: detail,
    }];
  }
  const cls = p.cls || '本职';
  const rows = [];
  if (rule.hasCantrips) {
    const left = Math.max(0, rule.cantrips - haveC);
    rows.push({
      group: '法术', label: '戏法', ok: left === 0, go: 'spell.list',
      value: left ? `还要选 ${left} 个（已选 ${haveC} / ${rule.cantrips}）` : `已选 ${haveC} / ${rule.cantrips}`,
      hint: `${cls} ${p.lv} 级：戏法 ${rule.cantrips} 个`, detail: '',
    });
  }
  const leftS = Math.max(0, rule.prepared - haveS);
  rows.push({
    group: '法术', label: '法术', ok: leftS === 0, go: 'spell.list',
    value: leftS
      ? `还要选 ${leftS} 个${rule.maxLevel ? `（1–${rule.maxLevel} 环）` : ''}`
      : `已选 ${haveS} / ${rule.prepared}`,
    hint: `${cls} ${p.lv} 级：${rule.label} ${rule.prepared} 个` + (rule.maxLevel ? `，最高能选到 ${rule.maxLevel} 环` : ''),
    detail: detail,
  });
  return rows;
}

/// 顶栏和「待办」页共用的一份行：基础那几条 + 按规则算出来的法术行
function todoRowsAll() {
  const base = (state.progressRows || []).filter((r) => r.group !== '法术');
  return [...base, ...spellTodoRows()];
}

function spellLvName(k) { return k === '0' ? '戏法' : k + '环'; }

function tallyText(tally) {
  const keys = [...tally.keys()].filter((k) => k !== '').sort((a, b) => (+a) - (+b));
  const parts = keys.map((k) => `${spellLvName(k)} ×${tally.get(k)}`);
  if (tally.get('')) parts.push(`环阶未知 ×${tally.get('')}`);
  return parts.join('、');
}

/// 卡里现在填了哪些东西（带环阶）——待办页靠它把「已经填的法术」按环阶列出来。
/// 服务端读一整张卡不便宜，所以按「路径 + 修改时间 + 大小」缓存，卡一改就自动作废。
const todoCard = { key: '', entries: [], loading: false };
async function loadTodoCard() {
  const t = state.table || {};
  if (!t.exists) return;
  const key = `${t.path}|${t.mtime}|${t.size}`;
  if (todoCard.key === key) return;
  todoCard.key = key;                 // 先占住：万一读失败也别反复重试（卡变了自然会重来）
  todoCard.loading = true;
  renderTodoPop();
  let r;
  try {
    r = await api('/api/card');
  } catch (e) {
    todoCard.loading = false;
    renderTodoPop();
    return;
  }
  todoCard.loading = false;
  if (todoCard.key !== key) return;   // 读的这段时间里又换卡了，这份结果丢掉
  todoCard.entries = r.entries || [];
  renderProgress(state.progressRows);  // 顶栏的「法术」和待办页一起重画
}

const TODO_GROUPS = ['基本信息', '职业', '属性与技能', '专长', '法术'];

function todoRowDetail(r) {
  if (r.label === '专长') {
    const names = (state.progress && state.progress.featNames) || [];
    if (names.length) return '卡里已经写了：' + names.map((n) => esc(n)).join('、');
  }
  return '';
}

function todoBodyHtml() {
  const t = state.table || {};
  if (!t.exists) {
    return `<div class="empty">还没有目标表格。<br>右边备选区下面点「新建表格 / 使用已有表格」先选一张，<br>这里就会列出还差什么、还能选什么。</div>`;
  }
  const rows = todoRowsAll();
  const miss = rows.filter((r) => !r.ok).length;
  const staged = stageState.items || [];
  const stagedEnt = staged.filter((e) => e.kind === 'entry');
  const stagedFld = staged.length - stagedEnt.length;

  const parts = [`<div class="todo-sum">${miss ? `还差 <b>${miss}</b> 项没定` : '该定的都定了'}` +
    `<span class="sep">·</span>备选区 <b>${staged.length}</b> 条待写入` +
    `（词条 ${stagedEnt.length} / 字段 ${stagedFld}）</div>`];

  const seen = [];
  for (const g of [...TODO_GROUPS, ...rows.map((r) => r.group)]) {
    if (seen.includes(g)) continue;
    seen.push(g);
    const rs = rows.filter((r) => r.group === g);
    if (!rs.length) continue;
    parts.push(`<div class="todo-group"><h4>${esc(g)}</h4>` +
      rs.map((r) => {
        const d = todoRowDetail(r) || r.detail || '';
        return `<div class="todo-item ${r.ok ? 'done' : 'miss'}">
          <div class="todo-row"${r.hint ? ` title="${esc(r.hint)}"` : ''}>
            <span class="mk">${r.ok ? '✓' : '○'}</span>
            <span class="lb">${esc(r.label)}</span>
            <span class="vl">${esc(r.value)}</span>
            ${r.go ? `<button class="todo-go" data-go="${esc(r.go)}">去填 ›</button>` : ''}
          </div>
          ${d ? `<div class="todo-d">${d}</div>` : ''}
        </div>`;
      }).join('') + '</div>');
  }
  return parts.join('');
}

/// 重画待办页（没开着就什么都不做）。写一条就会重画一次，滚动位置留着
function renderTodoPop() {
  const pop = $('pop');
  if (pop.hidden || popState.tab !== 'todo') return;
  const body = pop.querySelector('.pop-body');
  const keep = body ? body.scrollTop : 0;
  pop.innerHTML = popBarHtml('待办事项') + `<div class="pop-body">${todoBodyHtml()}</div>${POP_GRIP}`;
  wirePopChrome();
  const nb = pop.querySelector('.pop-body');
  if (nb) nb.scrollTop = keep;
}

/// 打开悬浮窗第二页「待办事项」（顶栏那颗「📋 待办」点进来）
async function openTodoPop(anchor) {
  popState.tab = 'todo';
  popState.seq++;                    // 还挂在路上的词条请求作废，别把待办页顶掉
  const pop = $('pop');
  pop.hidden = false;
  renderTodoPop();                   // 先用手上这份数据画出来
  placePop(anchor);
  loadProgress().catch(() => {});    // 再刷一遍进度（画完会自己重画）
  loadTodoCard().catch(() => {});    // 卡里的法术带上环阶
}

// 悬浮窗的位置 / 大小记在 localStorage 里：拖到哪儿下次还在这儿
const POP_RECT_KEY = 'quickref.popRect';
let popRect = (() => {
  try {
    const r = JSON.parse(localStorage.getItem(POP_RECT_KEY) || 'null');
    if (r && typeof r.left === 'number' && typeof r.top === 'number') return r;
  } catch (e) {}
  return null;
})();

function savePopRect() {
  const pop = $('pop');
  if (pop.hidden) return;
  const r = pop.getBoundingClientRect();
  popRect = { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
  try { localStorage.setItem(POP_RECT_KEY, JSON.stringify(popRect)); } catch (e) {}
}

/// 第一次打开时找个位置（列表右边）；以后就用你拖到的地方
/// 位置收一下，别让标题条跑到屏幕外（窗口比视口还高时至少把标题条留在里面）
function clampPop(x, y, w, h) {
  const maxX = Math.max(0, window.innerWidth - Math.min(w, window.innerWidth));
  const maxY = Math.max(0, window.innerHeight - Math.min(h, window.innerHeight - 44));
  return { x: Math.max(0, Math.min(x, maxX)), y: Math.max(0, Math.min(y, maxY)) };
}

function placePop(anchor) {
  const pop = $('pop');
  if (popRect) {
    if (popRect.width) pop.style.width = popRect.width + 'px';
    if (popRect.height) pop.style.height = popRect.height + 'px';
    const c = clampPop(popRect.left, popRect.top, pop.offsetWidth, pop.offsetHeight);
    pop.style.left = c.x + 'px';
    pop.style.top = c.y + 'px';
    return;
  }
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  let x = 16;
  let y = 16;
  if (anchor && anchor.getBoundingClientRect) {
    const a = anchor.getBoundingClientRect();
    const stage = anchor.closest && anchor.closest('.stage');
    if (stage) {
      // 入口在右边的「备选区」标题行：窗口开在它左边，别盖住备选区
      const sr = stage.getBoundingClientRect();
      const c0 = clampPop(sr.left - w - 10, a.top - 6, w, h);
      pop.style.left = c0.x + 'px';
      pop.style.top = c0.y + 'px';
      return;
    }
    const host = anchor.closest('.pane-list') || anchor.closest('.pane-detail') ||
                 anchor.closest('.lookup') || anchor.parentElement;
    const hr = host ? host.getBoundingClientRect() : a;
    x = hr.right + 10;
    y = a.top - 6;
  }
  const c = clampPop(x, y, w, h);
  pop.style.left = c.x + 'px';
  pop.style.top = c.y + 'px';
}

// 拖：按住标题条拖、右下角缩放角改大小，位置随手记下来
//
// `popDrag.drag` / `popDrag.size` 是模块级状态，`hidePop()` 关窗时会一起清掉：
// 有些外壳（WebView2 离屏合成）里 mouseup 会丢，状态留着的话窗口会一直"粘"在鼠标上，
// 于是看起来就是「关不掉」。mousemove 里再兜一道：按键都松了（buttons === 0）就算拖完了。
const popDrag = { drag: null, size: null };
(function wirePopDrag() {
  document.addEventListener('mousedown', (e) => {
    // 右下角那个角：改大小
    if (e.target.closest && e.target.closest('.pop-grip')) {
      const pop = $('pop');
      const r = pop.getBoundingClientRect();
      popDrag.size = { w: r.width, h: r.height, x: e.clientX, y: e.clientY };
      e.preventDefault();
      return;
    }
    const bar = e.target.closest && e.target.closest('.pop-bar');
    // 标题条上的按钮（关闭等）不算拖
    if (!bar || (e.target.closest && e.target.closest('button'))) return;
    const pop = $('pop');
    const r = pop.getBoundingClientRect();
    popDrag.drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if ((popDrag.drag || popDrag.size) && e.buttons === 0) {
      popDrag.drag = null;      // 鼠标早就松了，只是 mouseup 没送到
      popDrag.size = null;
      savePopRect();
      return;
    }
    if (popDrag.size) {
      const pop = $('pop');
      const s = popDrag.size;
      const w = Math.max(300, Math.min(s.w + (e.clientX - s.x), window.innerWidth - pop.offsetLeft - 8));
      const h = Math.max(180, Math.min(s.h + (e.clientY - s.y), window.innerHeight - pop.offsetTop - 8));
      pop.style.width = w + 'px';
      pop.style.height = h + 'px';
      savePopRect();
      return;
    }
    if (!popDrag.drag) return;
    const pop = $('pop');
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    const c = clampPop(e.clientX - popDrag.drag.dx, e.clientY - popDrag.drag.dy, w, h);
    pop.style.left = c.x + 'px';
    pop.style.top = c.y + 'px';
    // 每拖一下就顺手记一次（有的外壳里 mouseup 会丢，别指望它）
    savePopRect();
  });
  document.addEventListener('mouseup', () => {
    const was = popDrag.drag || popDrag.size;
    popDrag.drag = null;
    popDrag.size = null;
    if (was) savePopRect();     // 拉右下角改大小也走这儿
  });
  window.addEventListener('blur', () => { popDrag.drag = null; popDrag.size = null; });
})();

/// 直接拿一份数据画悬浮窗（职业特性页那些「N级：特性」条目的 id 不是词条 id，
/// 走不了 /api/entry，就用本地解析出来的正文）
function showPopData(data, anchor, opts) {
  const o = opts || {};
  popState.seq++;
  popState.id = data.id || '';
  popState.kind = data.kind || '';
  popState.onAdd = o.onAdd || null;
  popState.onChoice = o.onChoice || null;
  if (!o.keepTab) popState.tab = 'entry';   // 点词条就回到「词条详解」那一页
  const pop = $('pop');
  pop.hidden = false;
  paintEntryPop(data);
  placePop(anchor);
}

async function showPop(id, kind, anchor, opts) {
  const o = opts || {};
  const seq = ++popState.seq;             // 悬停扫过去时，慢的那个结果直接丢掉
  let r;
  try {
    r = await api('/api/entry?kind=' + encodeURIComponent(kind || 'spell') + '&id=' + encodeURIComponent(id));
  } catch (e) {
    return;
  }
  if (seq !== popState.seq) return;
  showPopData(Object.assign({ kind: kind }, r.entry), anchor, o);
}

/// 关掉悬浮窗（里面存的位置不丢，下次点词条还在你拖到的地方）
function hidePop(force) {
  // 待办那一页是常驻的：列表重画、点到别处都不把它收掉（要关就按 Esc 或点 ✕）
  if (!force && popState.tab === 'todo') return;
  popDrag.drag = null;                     // 拖到一半关掉也得把拖拽状态清掉
  popDrag.size = null;
  popState.id = '';
  popState.onAdd = null;
  popState.onChoice = null;
  popState.tab = 'entry';
  popState.seq++;                          // 让还在路上的请求作废
  $('pop').hidden = true;
}

/// 点一条词条：把效果送进悬浮窗（不再往中间那一栏写东西——那一栏现在列「已选」）
async function openEntry(brief, el) {
  [...document.querySelectorAll('.item.on')].forEach((x) => x.classList.remove('on'));
  if (el) el.classList.add('on');
  await showPop(brief.id, 'spell', el, {
    onAdd: () => addStageEntry('spell', brief, '法术', () => search()),
  });
}

/// 「已选」那一栏：把备选区里属于这一类的词条列出来（点一条看效果，× 从备选区拿掉）
function renderPickedInto(host, formKeys, label, pageKey) {
  if (!host) return;
  const items = stageState.items.filter((e) => e.kind === 'entry' && formKeys.includes(e.formKey));
  const quota = quotaHtml(quotasFor(pageKey || ''));
  if (!items.length) {
    host.innerHTML = quota + `<div class="empty">还没挑${esc(label)}。<br>` +
      `左边点一条 → 效果在那个能拖动的小窗里 → 按「+ 抓进备选区」，<br>` +
      `这里就会把你挑的列出来（写表还是走右下角的「填入表格」）。</div>`;
    return;
  }
  host.innerHTML = `<div class="picked-head">已选${esc(label)} <b>${items.length}</b> 条　` +
    `<span class="hint">点一条看效果（可拖动的小窗）；写表走右下角「填入表格」</span></div>` +
    quota +
    items.map((e) => `
      <div class="picked" data-id="${esc(e.id)}" data-kind="${esc(typeOfFormKey(e.formKey))}">
        <div class="t">
          <div><span class="nm">${esc(e.name)}</span>${e.subtitle ? `<span class="en">${esc(e.subtitle)}</span>` : ''}</div>
          <div class="s">${esc(e.page || '')}</div>
        </div>
        <button class="del" data-kill="${esc(e.id)}" title="从备选区拿掉">×</button>
      </div>`).join('');
  [...host.querySelectorAll('.picked')].forEach((el) => {
    const id = el.dataset.id;
    const kind = el.dataset.kind;
    const item = items.find((x) => x.id === id) || {};
    // 带正文的（职业特性页那些「N级：特性」）直接用本地正文画；其余回词条库查
    const show = (anchor) => {
      if (item.text != null && item.text !== '') {
        showPopData({
          id: id, kind: kind, name: item.name, en: item.subtitle || '',
          tags: item.tags || [], fields: {}, text: item.text,
        }, anchor);
      } else {
        showPop(id, kind, anchor);
      }
    };
    el.onclick = (ev) => {
      if (ev.target.closest('[data-kill]')) return;
      show(el);
    };
  });
  [...host.querySelectorAll('[data-kill]')].forEach((b) => {
    b.onclick = (ev) => { ev.stopPropagation(); removeStageEntry(b.dataset.kill); };
  });
}

const FORMKEY_TYPE = { spell: 'spell', class: 'classFeature', species: 'species', feat: 'feat', magic: 'magicItem' };
function typeOfFormKey(k) { return FORMKEY_TYPE[k] || k; }

/// 现在这一页是不是「词条列表页」——是的话，中间那一栏列「已选」
const PICKED_PAGES = {
  species: ['species'],
  feat: ['feat'],
  classlevel: ['class'],     // 职业特性页：抓的是「N级：特性」
  all: ['spell', 'classFeature', 'feat', 'species', 'magicItem'],
};
const PICKED_LABEL = { species: '种族特性', feat: '专长', classlevel: '职业特性', all: '词条' };

const TYPE_FORMKEY = { spell: 'spell', classFeature: 'class', species: 'species', feat: 'feat', magicItem: 'magic' };

function pickedCount(formKeys) {
  return stageState.items.filter((e) => e.kind === 'entry' && formKeys.includes(e.formKey)).length;
}

/// 这一页的**规则配额**：`{label, used, cap, note}`，`cap = 0` 表示规则上不数个数。
///
/// 只用来做提示 —— 到上限了照样能加（自定义规则经常要超），写表也不受影响。
function quotasFor(pageKey) {
  const p = state.progress || {};
  const t = state.table || {};
  const lv = p.lv || parseInt((formInput('level') || {}).value || '0', 10) || 0;
  const out = [];
  if (pageKey === 'spell') {
    const total = (p.slotTotal != null ? p.slotTotal : (t.slotsTotal || 0));
    const usedCard = (p.slotUsed != null ? p.slotUsed : (t.used || 0));
    out.push({
      label: '法术位', used: usedCard + pickedCount(['spell']), cap: total,
      note: `卡里一共 ${total} 格（已占 ${usedCard}）`,
    });
  } else if (pageKey === 'feat') {
    out.push({
      label: '专长', used: (p.featExisting || 0) + pickedCount(['feat']),
      cap: lv ? featsByLevel(lv) : 0,
      // 4 级才有第一个专长：等级不到时 cap 就是 0，别让「0 上限」显示成「无上限」
      zero: lv ? `${lv} 级还没有专长` : '等级还没填',
      note: lv ? `${lv} 级：4·8·12·16·19 级各一个` : '等级还没填（基本信息里选了等级就按 4·8·12·16·19 算）',
    });
  } else if (pageKey === 'classlevel') {
    out.push({ label: '职业特性', used: pickedCount(['class']), cap: 0, note: '等级到了就有，规则上不数个数' });
  } else if (pageKey === 'species') {
    out.push({ label: '种族特性', used: pickedCount(['species']), cap: 0, note: '种族给多少就是多少，规则上不数个数' });
  } else if (pageKey === 'magic') {
    // 卡里已经打了同调 O 的（武器 / 护甲 / 盾 / 奇物）：规则上最多同调 3 件
    let attuned = 0;
    for (const s of ((formState.info || {}).sections || [])) {
      for (const f of (s.fields || [])) {
        if (f.label === '同调' && String(f.value || '').trim().toUpperCase() === 'O') attuned++;
      }
    }
    out.push({ label: '同调', used: attuned, cap: 3, note: '规则：最多同调 3 件魔法物品' });
  } else if (pageKey === 'all') {
    for (const [type, name] of [['spell', '法术'], ['classFeature', '职业特性'], ['feat', '专长'],
                                ['species', '种族特性'], ['magicItem', '魔法物品']]) {
      out.push({ label: name, used: pickedCount([TYPE_FORMKEY[type]]), cap: 0 });
    }
  }
  return out;
}

function quotaHtml(rows) {
  if (!rows.length) return '';
  return '<div class="quota">' + rows.map((r) => {
    const state = r.cap > 0 ? (r.used > r.cap ? 'over' : (r.used === r.cap ? 'full' : '')) : '';
    const num = (r.cap > 0 || r.zero) ? `${r.used} / ${r.cap}` : `${r.used}`;
    const tail = r.cap > 0
      ? (r.used > r.cap ? '超出上限' : (r.used === r.cap ? '已到上限' : ''))
      : (r.zero || '无上限');
    return `<span class="q ${state}"${r.note ? ` title="${esc(r.note)}"` : ''}>` +
      `${esc(r.label)} <b>${esc(num)}</b>${tail ? ` <i>${esc(tail)}</i>` : ''}</span>`;
  }).join('') + '</div>';
}

/// 抓进备选区之后，看看是不是超了规则配额 —— 只提示，不加限制
function warnQuota(pageKey, pageLabel) {
  const over = quotasFor(pageKey).filter((r) => r.cap > 0 && r.used > r.cap);
  if (!over.length) return;
  const first = over[0];
  msgCf(`提示：${pageLabel ? pageLabel + '的' : ''}${first.label}已到规则上限（${first.cap} 个），多的这条照样加上了 —— ` +
    `超出的部分只是提示，写表不受影响。`, 'warn');
}

function renderPickedPanes() {
  if (!$('viewSpell').hidden) {
    renderPickedInto($('detail'), ['spell'], '法术', 'spell');
    return;
  }
  if (!$('viewClass').hidden && PICKED_PAGES[activePage]) {
    renderPickedInto($('cfDetail'), PICKED_PAGES[activePage], PICKED_LABEL[activePage] || '', activePage);
  }
}

/// 从备选区里拿掉一条词条（中间那一栏的 × 和右边备选区的 × 走同一个口）
function removeStageEntry(id) {
  stageState.items = stageState.items.filter((e) => !(e.kind === 'entry' && e.id === id));
  renderStage();                       // 里面会连带把「已选」那一栏重画
  if (!$('viewSpell').hidden) search().catch(() => {});
  else if (activePage === 'classlevel') renderLevelList().catch(() => {});
  else cfSearch().catch(() => {});
}

// ---------------------------------------------------------------- 目标表格
// 页内填入区已经取消：抓到的法术 / 职业特性 / 种族特性统一进最右边的备选区，
// 表格也从那儿新建、切换、写入。这几个函数只留最薄的一层。

async function loadTable(refresh) {
  state.table = await api('/api/table' + (refresh ? '?refresh=1' : ''));
  renderStage();
  loadProgress().catch(() => {});
}

/// 把「当前这张卡」从工作区里彻底拿出去：备选区、表单、各页缓存、卡内技能清单全清掉。
///
/// 换卡 / 初始化 / 读卡之前都必须先做这一步，否则上一张卡的东西会串进来
/// （最典型的：备选区里还留着上一张卡挑的词条，一填就写进新卡）。
function unloadCardState() {
  stageState.items = [];          // 备选区
  hidePop();                      // 词条效果悬浮窗也收掉（「待办」那页留着，换完卡自己会重画）
  state.current = null;
  formState.info = null;          // 表单数据
  formState.loaded = false;
  for (const k of Object.keys(pageStates)) pageStates[k].info = null;
  lkState.items = [];             // 魔法物品速查
  lkState.loaded = false;
  cardSkills = null;              // 卡里的技能清单
  cf = null;                      // 当前词条页的状态
  renderStage();
}

/// 换卡 / 导入卡：先把上一张卡拿出去，挂上新卡，**顺手把新卡读进备选区**，
/// 最后把当前这一页对着新卡重读。
///
/// 「导入」和「读卡」在这里是一件事：换到哪张卡，备选区里就是哪张卡的内容，
/// 不需要再单独点一次「读卡」。
async function afterTableChange(t, note) {
  unloadCardState();              // 1) 先把上一张卡从工作区拿出去
  state.table = t || state.table; // 2) 再挂上新卡
  await loadTable(true);          // 3) 读新卡（loadTable 里会连带 renderStage 和进度条）
  renderTree();
  let read = { fields: 0, entries: 0 };
  let readErr = '';
  try {
    read = await readCardIntoStage();   // 4) 导入即读卡：这张卡里填过的东西进备选区
  } catch (e) {
    readErr = e.message;
  }
  renderStage();
  await reloadCurrentView();      // 5) 当前这一页对着新卡重读
  const total = read.fields + read.entries;
  const tail = total
    ? '，并把这张卡里的 ' + total + ' 项读进备选区'
    : '（这张卡是空的，备选区没东西）';
  if (readErr) msg(note ? note + '；但这张卡读不出来：' + readErr : '换卡了，但这张卡读不出来：' + readErr, 'err');
  else msg((note || '已换卡') + tail, 'ok');
}

/// 当前显示的是哪一页，就把它重新读一遍（换卡后调用）
async function reloadCurrentView() {
  try {
    if (!$('viewForm').hidden) {
      await loadForm(true);
      return;
    }
    if (!$('viewClass').hidden) {
      await loadPageInfo();
      if (activePage === 'background') await renderBackgroundList();
      else if (activePage === 'classlevel') await renderLevelList();
      else if (activePage === 'classinfo') await renderClassList();
      else await cfSearch();
      return;
    }
    // 换卡之后致谢页也要跟着重读：作者信息是从卡里认的
    if (!$('viewThanks').hidden) {
      await renderThanks();
      return;
    }
    await search();
  } catch (e) {
    msg('刷新当前页失败：' + e.message, 'err');
  }
}

async function tableOp(kind) {
  const t = state.table || {};
  const dir = (t.path || '').replace(/[\\/][^\\/]*$/, '');
  const say = (text, cls) => msg(text, cls);
  say(kind === 'new' ? '正在打开「另存为」对话框…' : '正在打开「打开文件」对话框…');
  try {
    const r = await post(kind === 'new' ? '/api/table/new' : '/api/table/open', { dir, name: kind === 'new' ? '新人物卡.xlsx' : t.name });
    if (r.cancelled) { say('已取消'); return; }
    await afterTableChange(r.table, kind === 'new' ? '已新建表格' : '已切换目标表格');
  } catch (e) {
    say('操作失败：' + e.message + '\n（可以点「手动选择」用内置的文件浏览挑表）', 'err');
  }
}

async function reveal(target, isDir) {
  try {
    await post('/api/reveal', { path: target, dir: !!isDir });
  } catch (e) {
    msg('没能自动打开，请手动打开：\n' + target, 'err');
  }
}

// ---------------------------------------------------------------- 手动选择
let pkDir = '';

function openPicker(dir) {
  $('picker').hidden = false;
  $('pkMsg').textContent = '';
  browse(dir || (state.table && state.table.path ? state.table.path.replace(/[\\/][^\\/]*$/, '') : ''));
}

async function browse(dir) {
  try {
    const r = await api('/api/fs?dir=' + encodeURIComponent(dir || ''));
    pkDir = r.dir;
    $('pkPath').value = r.dir;
    $('pkRoots').innerHTML = (r.roots || []).map((d) => {
      const label = /^[A-Za-z]:\\$/.test(d) ? d.slice(0, 2) : d;
      return `<button data-dir="${esc(d)}">${esc(label)}</button>`;
    }).join('');
    [...$('pkRoots').querySelectorAll('button')].forEach((b) => { b.onclick = () => browse(b.dataset.dir); });
    if (!r.exists) {
      $('pkList').innerHTML = `<div class="empty">${esc(r.error || '目录不存在')}</div>`;
      return;
    }
    $('pkList').innerHTML = (r.entries || []).map((e) => `
      <div class="pk-row ${e.isTable ? 'current' : ''}" data-path="${esc(e.path)}" data-dir="${e.isDir ? 1 : 0}">
        <span>${e.isDir ? '📁 ' : '📄 '}${esc(e.name)}${e.isTable ? '（当前）' : ''}</span>
        <span class="meta">${e.isDir ? '' : Math.round(e.size / 1024) + ' KB'}</span>
        <span class="meta">${esc(e.mtime)}</span>
      </div>`).join('') || '<div class="empty">这个目录里没有 xlsx</div>';
    [...$('pkList').querySelectorAll('.pk-row')].forEach((row) => {
      row.onclick = () => {
        if (row.dataset.dir === '1') browse(row.dataset.path);
        else useTable(row.dataset.path);
      };
    });
  } catch (e) {
    $('pkMsg').textContent = '读取目录失败：' + e.message;
  }
}

async function useTable(path) {
  try {
    const r = await post('/api/table/use', { path });
    $('picker').hidden = true;
    await afterTableChange(r.table, '已切换目标表格：' + r.table.name);
  } catch (e) {
    $('pkMsg').textContent = e.message;
  }
}

async function createTable() {
  const name = $('pkName').value.trim() || '新人物卡.xlsx';
  try {
    const r = await post('/api/table/create', { dir: pkDir, name });
    $('picker').hidden = true;
    await afterTableChange(r.table, '已新建表格：' + r.table.name);
  } catch (e) {
    $('pkMsg').textContent = e.message;
  }
}

// ---------------------------------------------------------------- 职业页
// 职业页要写的东西全在「主要」表：主职业 / 子职业 / 等级 + 特性名称列。
// 三个词条页（职业 / 种族 / 专长）共用一套 DOM 与逻辑，各自留一份状态
const pageStates = {};
let activePage = 'class';
let cf = null;   // 当前页面的状态；下面所有 cf.xxx 都指向它

function initPageState(key) {
  activePage = key;
  cf = pageStates[key] || (pageStates[key] = {
    key,
    q: '',
    filters: {},        // {职业:'法师', 等级:'3', 子职:'', 来源:''}
    items: [],
    current: null,
    tray: { count: 0, items: [], duplicates: [] },
    info: null,
    loaded: false,
  });
  return cf;
}

initPageState('class');   // 启动时先兜一个默认页，避免后面的渲染拿到 null

function cfFilterQuery() {
  // 键名是服务端 filterAliases 里的别名，别直接用字段名（category 服务端只认 cat）
  const alias = { '职业': 'cls', '等级': 'level', '子职': 'sub', '来源': 'src', 'category': 'cat', '类型': 'kind' };
  const parts = [];
  for (const [k, v] of Object.entries(cf.filters)) {
    if (v) parts.push(`${alias[k] || k}=${encodeURIComponent(v)}`);
  }
  return parts.join('&');
}

async function loadPageInfo() {
  // 「背景」页没有词条库，内容全来自规则书：借种族页的接口拿卡里的种族 / 亚种 / 出身
  if (activePage === 'background') {
    const sp = await api('/api/page?key=species');
    cf.info = { ...sp, key: 'background', title: '背景', type: '', slots: [], slotCount: 0, free: 0 };
    renderCfTarget();
    renderCfFilters();
    return;
  }
  // 「职业」下那两页跟背景页一个路子：内容全来自规则书，卡里的信息借职业页的接口拿
  if (activePage === 'classinfo' || activePage === 'classlevel') {
    const cl = await api('/api/page?key=class');
    cf.info = {
      ...cl,
      key: activePage,
      title: activePage === 'classinfo' ? '主职业 / 子职业' : '职业特性',
      locked: true,
      slots: [],
      slotCount: 0,
      free: 0,
    };
    renderCfTarget();
    renderCfFilters();
    return;
  }
  cf.info = await api('/api/page?key=' + encodeURIComponent(activePage));
  renderCfTarget();
  renderCfFilters();
}

function renderCfTarget() {
  const i = cf.info || {};
  if (i.title) $('cfQ').placeholder = `搜索${i.title}（名称 / 英文名 / 正文）…`;
  // 「已选」那一栏（种族 / 专长 / 全部速查）不是占位提示，别被这里改掉
  const ph = PICKED_PAGES[activePage] ? null : $('cfDetail').querySelector('.empty');
  if (ph) ph.textContent = `从左边点一条${i.title || '条目'}，这里显示完整规则`;
  if (!i.exists) {
    $('cfLocked').hidden = true;
    return;
  }

  // 只读页（种族 / 背景）：种族 / 亚种 / 出身在「基本信息」里定，这里只显示；
  // 页内填入区也收起来，抓的东西走最右边的备选区。
  if (i.locked) {
    const parts = lockedPartsHtml(i);
    const slots = (i.slots || []).length
      ? `<div class="locked-sub">特性槽位 <b>${i.slotCount}</b>（已用 ${i.slotCount - i.free} / 空 ${i.free}）　写进 ${esc((i.slots || []).map((s) => s.range).join('、'))}</div>`
      : '';
    $('cfLocked').hidden = false;
    $('cfLocked').innerHTML =
      `<div>${parts.join(' · ')}<span class="locked-hint">在「基本信息」里定</span></div>${slots}`;

    if (activePage === 'background') {
      $('cfQ').hidden = true;
      $('cfFilters').hidden = true;
      $('cfClear').hidden = true;
      renderBackgroundList().catch(() => {});
      return;
    }

    // 职业页的两个子页：主职业 / 子职业 / 等级同样在「基本信息」里定，这边只显示
    if (activePage === 'classinfo' || activePage === 'classlevel') {
      $('cfQ').hidden = true;
      $('cfFilters').hidden = true;
      $('cfClear').hidden = true;
      $('cfFilters').innerHTML = '';
      // 锁定行由这两个渲染器自己写（等级页还要显示算出来的熟练加值）
      $('cfLocked').innerHTML = '';
      if (activePage === 'classinfo') renderClassList().catch(() => {});
      else renderLevelList().catch(() => {});
      return;
    }

    // 种族页：只看「我选的那个种族」的特性。
    // 种族已经锁定了，那排「分类」筛选就没用了，收起来——过滤照旧生效。
    $('cfQ').hidden = false;
    $('cfFilters').hidden = true;
    $('cfClear').hidden = false;
    const race = effectiveRace(i);
    if ((cf.filters['category'] || '') !== race) {
      cf.filters = race ? { category: race } : {};
    }
    $('cfFilters').innerHTML = '';
    $('cfQ').placeholder = race
      ? `在「${race}」里搜种族特性…`
      : '还没定种族——先在「基本信息」里填，这里就会只剩它的特性';
    return;
  }
  $('cfLocked').hidden = true;
  $('cfQ').hidden = false;
  $('cfFilters').hidden = false;
  $('cfClear').hidden = false;

  if (!i.slots.length) {
    return;
  }
}

/// 把规则书里那条出身的正文拆成「属性值 / 专长 / 技能熟练 / 工具熟练 / 装备 / 描述」
function parseBackgroundEffects(text) {
  const out = [];
  const desc = [];
  const lines = (text || '').split('\n').map((s) => s.trim()).filter(Boolean);
  lines.forEach((line, i) => {
    // 第一行通常是「侍僧 Acolyte」这种标题
    if (i === 0 && /[A-Za-z]/.test(line) && line.length <= 40) return;
    const m = line.match(/^([^：:]{2,8})[：:](.+)$/);
    if (m) out.push({ label: m[1].trim(), text: m[2].trim() });
    else desc.push(line);
  });
  if (desc.length) out.push({ label: '描述', text: desc.join('\n') });
  return out;
}

/// 这条效果是不是已经在备选区里了（同一页上，标签和内容都一样才算）
function effectStaged(e, key = 'background') {
  return stageState.items.some(
    (x) => x.kind === 'effect' && x.formKey === key && x.label === e.label && x.text === e.text);
}

/// 「工具熟练 / 语言」这两样，规则书给的常常是一句让你自己挑的指令
/// （`选择一种工匠工具（参见第六章）`、`一门你自选的语言`），不是具体名字。
/// 这种整句不能写进卡里的值格（值格只放 `书法工具`、`龙语` 这种），
/// 得先让用户挑好具体的一样。判定的正则与服务端 `isConcreteAssignment` 保持一致。
const PICK_ONE_LABELS = ['工具熟练', '语言'];
const MENU_HINT = /(选择|任选|自选|挑选|所选|参见|见第|一种|一门|一项|一套|两个|两门|两项|但不能说|你所说|理解|或者一)/;
function isPickOneEffect(e) {
  if (!PICK_ONE_LABELS.includes(e.label)) return false;
  const t = (e.text || '').trim().replace(/[。．.]+$/, '');
  return !t || MENU_HINT.test(t);
}

/// 把一条效果抓进备选区（出身效果、职业效果共用；写表时按 formKey 分流）。
/// `panel: true` 表示「这一整条是职业核心特质」，写表时进卡片「职业能力」面板。
function addStageEffect(e, key = 'background', page = '背景', panel = false) {
  if (effectStaged(e, key)) return;
  stageState.items.push({
    kind: 'effect',
    formKey: key,
    page,
    label: e.label,
    text: e.text,
    panel: !!panel,
  });
  renderStage();
  if (key === 'class') renderClassList().catch(() => {});
  else renderBackgroundList().catch(() => {});
}

/// 从备选区里撤掉一条效果（技能熟练勾选时取消勾选用）
function dropStageEffect(e, key = 'background') {
  stageState.items = stageState.items.filter(
    (x) => !(x.kind === 'effect' && x.formKey === key && x.label === e.label && x.text === e.text));
  renderStage();
}

/// 背景页：把固定下来的那条出身的全部效果列出来（内容来自规则书）
async function renderBackgroundList() {
  const bg = (((cf.info || {}).elsewhere) || []).find((x) => x.label === '出身');
  // 出身也优先用「基本信息」里刚选的（哪怕还没写进表）
  const name = pendingValue('basic', 'background', (bg && bg.value) || '').value.trim();
  const list = $('cfList');
  if (!name || name === '自定义背景') {
    $('cfCount').textContent = '—';
    list.innerHTML = '<div class="empty">出身还是「自定义背景」——先到「基本信息」里选一个具体出身。</div>';
    $('cfDetail').innerHTML = '<div class="empty">出身定好之后，这一栏列出它给你的全部效果（属性值 / 专长 / 技能熟练 / 工具熟练 / 装备）。</div>';
    return;
  }
  list.innerHTML = '<div class="empty">正在读规则书…</div>';
  const r = await api('/api/rule?kind=background&name=' + encodeURIComponent(name));
  if (!r.found) {
    $('cfCount').textContent = name;
    list.innerHTML = `<div class="empty">规则库里没有「${esc(name)}」这一条。</div>`;
    $('cfDetail').innerHTML = '<div class="empty">换一个出身，或者到「基本信息」里改。</div>';
    return;
  }
  const effects = parseBackgroundEffects(r.text);
  $('cfCount').textContent = `${name} · ${effects.length} 项`;
  const pickHint = (label) =>
    (label === '语言' ? '写具体语言，例如：龙语' : '写具体工具，例如：铁匠工具');
  list.innerHTML = effects.map((e, i) => {
    // 要自己挑的那种（`选择一种工匠工具`）不给「+」，改给一个小输入框：
    // 挑好的具体名字才进备选区，卡里的值格也就不会被整句指令占住
    let act = '<button class="add" title="抓进备选区">+</button>';
    if (effectStaged(e)) act = '<span class="intray">已在备选区</span>';
    else if (isPickOneEffect(e)) {
      act = `<span class="pickone">
        <input class="pickin" value="" placeholder="${esc(pickHint(e.label))}"
               title="规则书给的是要你自己挑的，把挑好的具体名字写这里，再按 +">
        <button class="add pick" title="把挑好的这一样写进备选区">+</button>
      </span>`;
    }
    return `
    <div class="item" data-i="${i}">
      <div class="t">${esc(e.label)}</div>
      ${act}
      <div class="s">${esc(e.text)}</div>
    </div>`;
  }).join('') || '<div class="empty">这条出身没有分条的效果。</div>';

  const show = (i) => {
    [...list.querySelectorAll('.item')].forEach((x) => x.classList.toggle('on', +x.dataset.i === i));
    const e = effects[i];
    $('cfDetail').innerHTML = `
      <div class="detail-head">${esc(e.label)}<span class="en">${esc(name)}</span></div>
      <div class="detail-text">${esc(e.text)}</div>
      <div class="rule-meta">${esc(r.book || '')}${(r.crumbs || []).length ? ' · ' + esc(r.crumbs.join(' › ')) : ''}</div>`;
  };
  [...list.querySelectorAll('.item')].forEach((el) => {
    el.onclick = (ev) => {
      if (ev.target.classList.contains('add')) {
        ev.stopPropagation();
        const e = effects[+el.dataset.i];
        // 「要自己挑」的那条：把输入框里挑好的具体名字抓走，空的就退回输入框
        if (ev.target.classList.contains('pick')) {
          const box = el.querySelector('.pickin');
          const v = ((box && box.value) || '').trim();
          if (!v) { if (box) box.focus(); return; }
          addStageEffect({ label: e.label, text: v });
          return;
        }
        addStageEffect(e);
        return;
      }
      show(+el.dataset.i);
    };
    const box = el.querySelector('.pickin');
    if (box) {
      box.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter') return;
        ev.preventDefault();
        const btn = el.querySelector('.add.pick');
        if (btn) btn.click();
      });
    }
  });
  show(0);
}

// ---------------------------------------------------------------- 职业页（照「起源」那套做）
// 「主职业 / 子职业」和「职业特性」两页里，主职业 / 子职业 / 等级都是在
// 「基本信息」里定的，这里只显示；正文来自规则书（card_rules.json 的 class / subclass），
// 拆成一条条：卡里没有的格子就明说，要挑的那几样勾一下就能抓进备选区。

/// 职业正文最上面那块「核心特质」的标签，顺序就是书里的顺序
const CLASS_TRAIT_LABELS = ['主要属性', '生命值骰', '豁免熟练', '技能熟练', '武器熟练', '工具熟练', '护甲受训', '起始装备'];
function isAsciiLine(s) {
  return !!s && !/[\u4e00-\u9fff]/.test(s);
}

/// 职业正文 → [{label, text}]：就是「这个职业给我什么」那张核心特质表。
/// 书里标签是中英黏在一起的（`生命值骰Hit Point Die`），英文还会另起一行，跳过即可。
function parseClassTraits(text) {
  const lines = (text || '').split('\n').map((s) => s.trim()).filter(Boolean);
  const head = lines.findIndex((l) => l.indexOf('核心特质') >= 0);
  const out = [];
  let cur = null;
  for (let i = head < 0 ? 0 : head + 1; i < lines.length; i++) {
    const line = lines[i];
    const label = CLASS_TRAIT_LABELS.find((x) => line.indexOf(x) === 0);
    if (label) {
      cur = { label, text: '' };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    if (!cur.text && isAsciiLine(line)) continue;                       // 标签的英文换行
    if (/^（见第[一二三四五六七八九十\d]+章）$/.test(line)) continue;    // 「（见第一章）」这类跨页注释
    if (/[。！？]$/.test(line) && line.indexOf('（') !== 0) break;        // 正文段落开始了
    cur.text += line;
  }
  return out.filter((e) => e.text);
}

/// 职业正文里的「N级：特性名」。书里断行会把英文名切到下一行（`战斗风格 Fighting` / `Style`）。
function parseClassFeatures(text) {
  const lines = (text || '').split('\n').map((s) => s.trim()).filter(Boolean);
  const out = [];
  let cur = null;
  for (const line of lines) {
    const m = line.match(/^(\d+)级[：:](.+)$/);
    if (m) {
      cur = { level: +m[1], name: m[2].trim(), text: '' };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    if (!cur.text && /^[A-Za-z][A-Za-z\s'’\-]{0,24}$/.test(line)) {
      cur.name += ' ' + line;
      continue;
    }
    cur.text += (cur.text ? '\n' : '') + line;
  }
  // 书里的章节标题也长成「3级：野蛮人子职 Barbarian Subclass」，别把它当成一条特性
  return out.filter((f) => !/子职|Subclass/i.test(f.name));
}

/// 「选择2项：特技、驯兽、运动」这种菜单拆开；`任选3项` 没列候选就返回空
function classMenu(text) {
  const m = String(text || '').match(/^(选择|任选)\s*(\d+)\s*项[：:]?\s*(.*)$/);
  if (!m) return null;
  const names = [];
  for (const part of m[3].split(/[、,，/]/)) {
    for (const piece of part.split('和')) {
      const t = piece.trim();
      if (t && names.indexOf(t) < 0) names.push(t);
    }
  }
  // 「任选3项乐器」这种后面只跟了个名词，凑不出候选，当成"没有候选"
  return { pick: +m[2], names: names.length > 1 ? names : [] };
}

/// 卡里的技能清单（给「任选N项」这种书里没列候选的菜单兜底用）
let cardSkills = null;
async function loadCardSkills() {
  if (cardSkills) return cardSkills;
  try {
    const f = await api('/api/form?key=basic');
    const names = [];
    for (const s of (f.sections || [])) {
      for (const x of (s.fields || [])) {
        if (x.label === '技能' && x.value) names.push(x.value);
      }
    }
    cardSkills = names;
  } catch (e) { cardSkills = []; }
  return cardSkills;
}

/// 「选择2项：…」「任选3项乐器」这种整条就是一串选项的
function isMenuLine(text) {
  return /^(选择|任选)\s*\d+\s*项/.test(String(text || '').trim());
}

/// 这一条怎么落卡：
///   menu  = 技能熟练的菜单，先在这页上勾选
///   panel = 核心特质，写进卡片「职业能力」面板那一行（没有就占空槽）
///   pick  = 一条条抓（具体技能 / 具体工具 / 语言）
///   none  = 卡里没有对应格子
function classItemKind(e) {
  if (e.label === '技能熟练') {
    const menu = classMenu(e.text);
    if (!menu) return 'pick';
    // 有候选名单的正常当菜单；「任选3项」这种书里没列候选的，
    // 现在也用卡里的技能表兜底了，所以同样给勾选框
    if (menu.names.length > menu.pick || menu.names.length === 0) return 'menu';
    return 'pick';
  }
  if (e.label === '工具熟练' || e.label === '语言') return isMenuLine(e.text) ? 'panel' : 'pick';
  return 'panel';
}

/// 这两页要看的主职业 / 子职业 / 等级：优先用「基本信息」里刚选的（哪怕还没写进表）
function classCtx() {
  const sel = (cf.info && cf.info.selectors) || [];
  const one = (f) => {
    const card = ((sel.find((s) => s.field === f) || {}).value) || '';
    return pendingValue('basic', f, card);
  };
  return { cls: one('cls'), sub: one('sub'), level: one('level') };
}

function lockedLine(label, p) {
  return `<b>${esc(label)}</b> ${esc(p.value || '（未定）')}` +
    (p.pending ? '<i class="pending">还没写进表</i>' : '');
}

function ruleQuery(kind, cls, name) {
  return kind === 'class'
    ? `kind=class&name=${encodeURIComponent(name)}`
    : `kind=subclass&cls=${encodeURIComponent(cls)}&sub=${encodeURIComponent(name)}`;
}

/// 职业页：这个主职业 / 子职业在规则书里是什么样，哪些东西要落到卡上
async function renderClassList() {
  const list = $('cfList');
  const ctx = classCtx();
  // 记住当前选中哪一条：勾一个技能会重画列表，别把详情面板弹回第一条
  const keepEl = document.querySelector('#cfList .item.on');
  const keep = keepEl ? keepEl.dataset.i : null;
  await loadCardSkills();
  $('cfLocked').innerHTML = lockedLine('主职业', ctx.cls) + lockedLine('子职业', ctx.sub) + lockedLine('等级', ctx.level);
  const say = (html) => {
    $('cfCount').textContent = '—';
    list.innerHTML = `<div class="empty">${html}</div>`;
  };
  cf.classItems = [];
  cf.classSub = null;
  if (!ctx.cls.value) {
    $('cfDetail').innerHTML = '<div class="empty">主职业定好之后，这里列出它给你的东西。</div>';
    return say('还没定主职业——先到「基本信息」里选一个，这里就会摊开它的职业正文。');
  }
  list.innerHTML = '<div class="empty">正在读规则书…</div>';
  const r = await ruleQuery0('class', '', ctx.cls.value);
  if (!r.found) {
    $('cfDetail').innerHTML = '<div class="empty">规则库里没有这个职业的正文。</div>';
    return say(`规则库里没有「${esc(ctx.cls.value)}」——换一个主职业，或者到「基本信息」里改。`);
  }
  if (ctx.sub.value) {
    const s = await ruleQuery0('subclass', ctx.cls.value, ctx.sub.value);
    if (s.found) cf.classSub = { name: ctx.sub.value, rule: s };
  }
  const traits = parseClassTraits(r.text);
  cf.classItems = traits;
  cf.classRule = r;
  cf.className = ctx.cls.value;
  $('cfCount').textContent = `${ctx.cls.value} · ${traits.length} 项`;
  list.innerHTML = traits.map(classItemHtml).join('') +
    (cf.classSub
      ? `<div class="item" data-i="sub"><div class="t">子职 · ${esc(cf.classSub.name)}</div>` +
        '<span class="auto">看正文</span>' +
        `<div class="s">${esc((cf.classSub.rule.text || '').split('\n')[0])}</div></div>`
      : '');
  [...list.querySelectorAll('.item')].forEach((el) => {
    el.onclick = (ev) => {
      const i = el.dataset.i;
      if (ev.target.classList.contains('add')) {
        ev.stopPropagation();
        const e = (cf.classItems || [])[+i];
        if (e) addStageEffect(e, 'class', '职业', true);
        return;
      }
      showClassItem(i);
    };
  });
  showClassItem(keep != null ? keep : '0');
}

function ruleQuery0(kind, cls, name) {
  return api('/api/rule?' + ruleQuery(kind, cls, name));
}

function classItemHtml(e, i) {
  const kind = classItemKind(e);
  const staged = effectStaged(e, 'class');
  const add = staged ? '<span class="intray">已在备选区</span>'
    : '<button class="add" title="抓进备选区">+</button>';
  let right = '<span class="auto">卡里没有格子</span>';
  if (kind === 'menu') right = '<span class="auto">勾选</span>' + add;
  else if (kind === 'pick' || kind === 'panel') right = add;
  return `<div class="item" data-i="${i}">
      <div class="t">${esc(e.label)}</div>
      ${right}
      <div class="s">${esc(e.text)}</div>
    </div>`;
}

/// 详情栏：普通条目给正文；「选择N项」那种给一排勾选框，勾中的直接进备选区
function showClassItem(i) {
  const list = $('cfList');
  [...list.querySelectorAll('.item')].forEach((x) => x.classList.toggle('on', x.dataset.i === String(i)));
  const r = (cf.classRule || {});
  const meta = `<div class="rule-meta">${esc(r.book || '')}${(r.crumbs || []).length ? ' · ' + esc(r.crumbs.join(' › ')) : ''}</div>`;
  if (i === 'sub') {
    const s = cf.classSub;
    $('cfDetail').innerHTML = `
      <div class="detail-head">${esc(s.name)}<span class="en">子职</span></div>
      <div class="detail-text">${esc(s.rule.text || '')}</div>
      <div class="rule-meta">${esc(s.rule.book || '')}${(s.rule.crumbs || []).length ? ' · ' + esc(s.rule.crumbs.join(' › ')) : ''}</div>`;
    return;
  }
  const e = (cf.classItems || [])[+i];
  if (!e) return;
  const kind = classItemKind(e);
  const note = {
    panel: '「+」把这一整条写进卡片的「职业能力」面板：卡里已经有同名的那一行就补它的描述，没有就占下面第一个空槽（名称 + 描述一起写）。',
    pick: '点右边的「+」抓进备选区，再从备选区一并写进表。',
    menu: '勾中你要的那几项，勾中的会一条条进备选区（写表时在技能表上打熟练）；「+」是把这一整条写进卡片「职业能力」面板那一行。',
  }[kind];
  const base = kind === 'menu' ? classMenu(e.text) : null;
  // 书里只写「任选3项」、没把候选列出来的（吟游诗人的技能熟练就是）：用卡里的技能表兜底
  const menu = base && base.pick > 0 && base.names.length === 0 && e.label.indexOf('技能') >= 0
    ? { pick: base.pick, names: (cardSkills || []).slice() }
    : base;
  const picker = menu
    ? `<div class="cf-pick">${menu.names.map((n) => `
        <label class="chk"><input type="checkbox" data-skill="${esc(n)}" ${effectStaged({ label: e.label, text: n }, 'class') ? 'checked' : ''}>
        <span>${esc(n)}</span></label>`).join('')}
      </div>`
    : '';
  $('cfDetail').innerHTML = `
    <div class="detail-head">${esc(e.label)}<span class="en">${esc(cf.className || '')}</span></div>
    <div class="detail-text">${esc(e.text)}</div>
    ${picker}
    <div class="rule-meta">${esc(note || '')}</div>
    ${meta}`;
  [...$('cfDetail').querySelectorAll('input[data-skill]')].forEach((el) => {
    el.onchange = () => {
      // 标签跟着这一条走：技能熟练 / 工具熟练 / 语言 各写各的落点
      const eff = { label: e.label, text: el.dataset.skill };
      if (el.checked) {
        // 「选择2项」这类菜单是有上限的：勾过头就把这一次撤回来，别写进备选区
        const need = menu ? menu.pick : 0;
        const picked = [...$('cfDetail').querySelectorAll('input[data-skill]')]
          .filter((b) => b.checked).length;
        if (need > 0 && picked > need) {
          el.checked = false;
          msg(`「${e.label}」只能选 ${need} 项，先取消一个再勾`, 'err');
          return;
        }
        addStageEffect(eff, 'class', '职业', false);
      } else {
        dropStageEffect(eff, 'class');
        renderClassList().catch(() => {});
      }
    };
  });
}

/// 等级页：到这一级为止，职业和子职一共给了哪些特性（能一条条抓进备选区）
async function renderLevelList() {
  const list = $('cfList');
  const ctx = classCtx();
  const lv = parseInt(ctx.level.value, 10) || 0;
  const pb = lv ? 2 + Math.floor((lv - 1) / 4) : 0;
  $('cfLocked').innerHTML = lockedLine('等级', ctx.level) + lockedLine('主职业', ctx.cls) + lockedLine('子职业', ctx.sub) +
    `<b>熟练加值</b> ${pb ? '+' + pb : '—'}<span class="locked-hint">卡里自己算</span>`;
  const say = (html) => {
    $('cfCount').textContent = '—';
    list.innerHTML = `<div class="empty">${html}</div>`;
  };
  cf.levelFeats = [];
  if (!ctx.cls.value) {
    $('cfDetail').innerHTML = '<div class="empty">主职业定好之后，这里按等级列出该有的特性。</div>';
    return say('还没定主职业——先到「基本信息」里选一个。');
  }
  list.innerHTML = '<div class="empty">正在读规则书…</div>';
  const feats = [];
  const r = await ruleQuery0('class', '', ctx.cls.value);
  if (r.found) for (const f of parseClassFeatures(r.text)) feats.push({ ...f, from: ctx.cls.value, kind: 'class', rule: r });
  if (ctx.sub.value) {
    const s = await ruleQuery0('subclass', ctx.cls.value, ctx.sub.value);
    if (s.found) for (const f of parseClassFeatures(s.text)) feats.push({ ...f, from: ctx.sub.value, kind: 'sub', rule: s });
  }
  feats.sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));
  const mine = lv ? feats.filter((f) => f.level <= lv) : feats;
  cf.levelFeats = mine;
  $('cfCount').textContent = lv
    ? `${ctx.cls.value} · 到 ${lv} 级 ${mine.length} 条特性`
    : `${ctx.cls.value} · 全书 ${mine.length} 条特性（等级还没填）`;
  list.innerHTML = mine.map((f, i) => {
    const staged = stageState.items.some((x) => x.kind === 'entry' && x.id === levelFeatId(f));
    return `<div class="item" data-i="${i}">
      <div class="t">${esc(f.name)}<span class="en">${f.level}级${f.kind === 'sub' ? ' · 子职' : ''}</span></div>
      ${staged ? '<span class="intray">已在备选区</span>' : '<button class="add" title="抓进备选区">+</button>'}
      <div class="s">${esc(f.from)}</div>
    </div>`;
  }).join('') || '<div class="empty">没抽出这一级的特性，规则书里没写？</div>';
  [...list.querySelectorAll('.item')].forEach((el) => {
    const f = mine[+el.dataset.i];
    const popData = {
      id: levelFeatId(f),
      kind: 'classFeature',
      name: f.name,
      en: `${f.level}级 · ${f.from}${f.kind === 'sub' ? ' · 子职' : ''}`,
      tags: [f.from, `${f.level}级`, f.kind === 'sub' ? '子职' : '职业', (f.rule || {}).book || ''],
      fields: {},
      text: f.text || '',
    };
    el.onclick = (ev) => {
      if (ev.target.classList.contains('add')) {
        ev.stopPropagation();
        addStageFeature(f);
        return;
      }
      showPopData(popData, el, { onAdd: () => addStageFeature(f) });
    };
  });
  renderPickedPanes();
}

const levelFeatId = (f) => `lv:${f.level}:${f.name}`;


/// 把一条特性抓进备选区（写表时走「职业特性」那一列，跟职业特性页同一个落点）
function addStageFeature(f) {
  const id = levelFeatId(f);
  if (stageState.items.some((x) => x.kind === 'entry' && x.id === id)) return;
  stageState.items.push({
    kind: 'entry',
    formKey: 'class',
    page: '职业',
    id,
    name: f.name,
    subtitle: `${f.level}级 · ${f.from}`,
    // 正文也一起带上：这一条的 id 不是词条库里的 id（`lv:等级:名字`），
    // 「已选」那一栏点它看效果时走不了 /api/entry，得用这份本地正文
    text: f.text || '',
    tags: [f.from, `${f.level}级`, f.kind === 'sub' ? '子职' : '职业', (f.rule || {}).book || ''],
  });
  renderStage();
  msgCf('已加入备选区', 'ok');
  warnQuota('classlevel', '职业特性');
  renderLevelList().catch(() => {});
}

function renderCfFilters() {
  const box = $('cfFilters');
  box.innerHTML = '';
  const counts = (cf.info && cf.info.facets) || {};
  for (const field of Object.keys(counts)) {
    const c = counts[field];
    if (!c) continue;
    const values = Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 24).map(([k]) => k);
    if (!values.length) continue;
    const g = document.createElement('div');
    g.className = 'fgroup';
    g.innerHTML = `<h4>${esc(field === 'category' ? '分类' : field)}</h4>`;
    const opts = document.createElement('div');
    opts.className = 'opts';
    for (const v of values) {
      const b = document.createElement('button');
      b.className = cf.filters[field] === v ? 'on' : '';
      b.textContent = field === '等级' ? v + '级' : v;
      b.onclick = () => {
        cf.filters[field] = cf.filters[field] === v ? '' : v;
        renderCfFilters();
        cfSearch();
      };
      opts.appendChild(b);
    }
    g.appendChild(opts);
    box.appendChild(g);
  }
}

async function cfSearch() {
  // 背景 / 职业这两个只看规则书，没有词条库可搜，列表由各自的渲染器写
  if (activePage === 'background' || activePage === 'classinfo' || activePage === 'classlevel') return;
  hidePop();
  const type = (cf.info && cf.info.type) || 'classFeature';
  const url = `/api/search?type=${encodeURIComponent(type)}&q=${encodeURIComponent(cf.q)}&limit=400` +
    (cfFilterQuery() ? '&' + cfFilterQuery() : '');
  const r = await api(url);
  // 旧版服务端会忽略 type，把法术当成职业特性返回——这里挡一下，免得串台
  const expect = { classFeature: 'classFeature:', species: 'species:', feat: 'feat:', magicItem: 'magicItem:', spell: 'spell:' }[type];
  if (expect && r.items.length && !r.items.every((e) => String(e.id || '').startsWith(expect))) {
    $('cfCount').textContent = '—';
    $('cfList').innerHTML = '<div class="empty">服务端返回的不是本页的词条（多半是服务端没重启）。<br>关掉启动窗口，重新双击 实验区\\start.bat 再刷新。</div>';
    return;
  }
  cf.items = r.items;
  $('cfCount').textContent = r.total > r.items.length ? `${r.items.length} / ${r.total} 条` : `${r.total} 条`;
  const list = $('cfList');
  list.innerHTML = r.items.map((e, i) => `
    <div class="item" data-i="${i}">
      <div class="t">${esc(e.name)}<span class="en">${esc(e.en)}</span>${isAllPage() ? `<span class="kind">${esc(e.typeLabel || '')}</span>` : ''}</div>
      ${stageHasEntry(e.id) ? '<span class="intray">已在备选区</span>'
                            : '<button class="add" title="抓进备选区">+</button>'}
      <div class="s">${esc(e.subtitle)}</div>
    </div>`).join('') || '<div class="empty">没有匹配结果</div>';
  [...list.querySelectorAll('.item')].forEach((el) => {
    const brief = r.items[+el.dataset.i];
    el.onclick = (ev) => {
      if (ev.target.classList.contains('add')) {
        ev.stopPropagation();
        cfAddToTray(brief.id);
        offerProficiencies(brief, el);   // 这条要是给熟练（尤其「……之一」），顺手处理
        return;
      }
      cfOpenEntry(brief, el);
    };
  });
  renderPickedPanes();     // 列表画完，把「已选」那一栏也对着现在的备选区重画一遍
}

/// 点一条词条：钉住悬浮窗（效果不再往中间那一栏写——那一栏现在列「已选」）
async function cfOpenEntry(brief, el) {
  [...document.querySelectorAll('#cfList .item.on')].forEach((x) => x.classList.remove('on'));
  if (el) el.classList.add('on');
  await showPop(brief.id, typeOfFormKey(ENTRY_PAGE[(brief.type || '')] || activePage), el, {
    pinned: true,
    onAdd: () => cfAddToTray(brief.id),
  });
}

/// 词条页的「+」：一律抓进最右边的备选区（页内填入区已经取消）
async function cfAddToTray(id) {
  const e = cf.items.find((x) => x.id === id) || { id, name: id };
  // 「全部速查」页里的每一条属于哪一类，就按那一类走（写表时各走各的落点）
  const key = ENTRY_PAGE[e.type] || activePage;
  addStageEntry(key, e,
    (cf.info && cf.info.title) || activePage, () => cfSearch());
}

function msgCf(text, cls) {
  msg(text, cls);
}

// ---------------------------------------------------------------- 设计树
// ---------------------------------------------------------------- 表单页（基本信息…）
// 跟词条页完全不同的排版：一格一个字段，按分组卡片排，控件按字段类型给。
const formState = { key: 'basic', info: null, loaded: false, seq: 0 };

async function loadForm(refresh) {
  // 每次请求编个号：慢的请求回来晚了（刚点「基本信息」又点了别的页）就丢掉，
  // 不然旧结果会把当前这一页覆盖掉——看起来就像"点基本信息跳到了别处"。
  const seq = ++formState.seq;
  const key = formState.key;
  const info = await api(
    '/api/form?key=' + encodeURIComponent(key) + (refresh ? '&refresh=1' : ''));
  if (seq !== formState.seq || key !== formState.key) return;
  formState.info = info;
  formState.loaded = true;
  renderForm();
}

/// 换到另一张表单时先把上一张清掉：接口没回来之前别让人看到别的页
function formPlaceholder() {
  $('fmTitle').textContent = '载入中…';
  $('fmSub').textContent = '';
  $('fmSections').innerHTML = '<div class="empty">正在读这张卡…</div>';
  $('fmLookup').hidden = true;
}

function renderForm() {
  const i = formState.info || {};
  $('fmTitle').textContent = i.title || '—';
  $('fmSub').innerHTML = i.exists
    ? `写入 <b>${esc(i.name || '')}</b> 的「${esc(i.sheet || '主要')}」表 —— 填好的字段进右边备选区，再从那儿一并写进表`
    : '还没有目标表格，先到法术页或职业页底部新建 / 选一张。';
  $('fmSections').innerHTML = (i.sections || []).map(sectionHtml).join('') +
    (RULES_ON_PAGE[formState.key] ? '<div class="fcard" id="fmRule" hidden></div>' : '');
  comboInit($('fmSections'));
  applyStageToForm();
  refreshAllDependents();
  loadRuleCard();
  // 魔法物品页顶上带一个速查：搜规则书里的魔法物品，抓进备选区再写进表
  const withLookup = formState.key === 'magic';
  $('fmLookup').hidden = !withLookup;
  if (withLookup) lkSearch().catch(() => {});
}

// ---------------------------------------------------------------- 速查（魔法物品）
const lkState = { q: '', filters: {}, items: [], loaded: false };

async function lkSearch() {
  hidePop();
  if (!lkState.loaded) {
    lkState.loaded = true;
    try { lkState.info = await api('/api/page?key=magic'); } catch (e) { lkState.info = {}; }
    renderLkFilters();
  }
  const alias = { '类别': 'category', '稀有度': 'tag', '来源': 'src' };
  const parts = [];
  for (const [k, v] of Object.entries(lkState.filters)) {
    if (v) parts.push(`${alias[k] || k}=${encodeURIComponent(v)}`);
  }
  const url = `/api/search?type=magicItem&q=${encodeURIComponent(lkState.q)}&limit=300` +
    (parts.length ? '&' + parts.join('&') : '');
  const r = await api(url);
  lkState.items = r.items;
  $('lkCount').textContent = r.total > r.items.length ? `${r.items.length} / ${r.total} 条` : `${r.total} 条`;
  $('lkQuota').innerHTML = quotaHtml(quotasFor('magic'));
  $('lkList').innerHTML = r.items.map((e, i) => `
    <div class="item" data-i="${i}">
      <div class="t">${esc(e.name)}<span class="en">${esc(e.en)}</span></div>
      ${stageHasEntry(e.id) ? '<span class="intray">已在备选区</span>'
                            : '<button class="add" title="抓进备选区">+</button>'}
      <div class="s">${esc(e.subtitle)}</div>
    </div>`).join('') || '<div class="empty">没有匹配的魔法物品</div>';
  [...$('lkList').querySelectorAll('.item')].forEach((el) => {
    const brief = lkState.items[+el.dataset.i];
    const addLk = () => addStageEntry('magic',
      { id: brief.id, name: brief.name, subtitle: brief.subtitle || '' }, '魔法物品', () => lkSearch());
    el.onclick = async (ev) => {
      if (ev.target.classList.contains('add')) {
        ev.stopPropagation();
        addLk();
        return;
      }
      // 点一下把效果送进悬浮窗（原来是把正文塞在行下面，列表会被撑得很乱）
      await showPop(brief.id, 'magicItem', el, { onAdd: addLk });
    };
  });
}

function renderLkFilters() {
  const box = $('lkFilters');
  const facets = (lkState.info && lkState.info.facets) || {};
  box.innerHTML = Object.keys(facets).filter((f) => f !== '来源').map((field) => {
    const counts = facets[field] || {};
    const values = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k]) => k);
    if (!values.length) return '';
    return `<div class="fgroup"><h4>${esc(field)}</h4><div class="opts">` +
      values.map((v) => `<button data-field="${esc(field)}" data-v="${esc(v)}" class="${lkState.filters[field] === v ? 'on' : ''}">${esc(v)}</button>`).join('') +
      '</div></div>';
  }).join('');
  [...box.querySelectorAll('button[data-v]')].forEach((b) => {
    b.onclick = () => {
      const f = b.dataset.field;
      lkState.filters[f] = lkState.filters[f] === b.dataset.v ? '' : b.dataset.v;
      renderLkFilters();
      lkSearch().catch(() => {});
    };
  });
}

/// 哪一页要看规则正文：基本信息看子职业 + 出身，起源页看出身
const RULES_ON_PAGE = { basic: ['subclass', 'background'], origin: ['background'] };

// ---------------------------------------------------------------- 备选区（应用级）
// 跟设计树同级：哪一页都在。表单页填的字段、词条页抓的词条，都先攒到这里，
// 攒齐了从这儿一并写进表。每条记着自己来自哪一页，跨页攒的也能一次写完。
const stageState = { items: [] };

/// 卡里的值；备选区里攒着这个字段的新值时就用新的，并标一下「还没写进表」
function pendingValue(formKey, field, cardValue) {
  const e = stageState.items.find((x) => x.kind === 'field' && x.formKey === formKey && x.field === field);
  const v = (e && e.value) || '';
  if (v && v !== cardValue) return { value: v, pending: true };
  return { value: cardValue, pending: false };
}

/// 只读行：种族 / 亚种 / 出身 —— 优先用「基本信息」里刚选的（哪怕还没写进表）
function lockedPartsHtml(info) {
  const out = [];
  for (const s of (info.selectors || [])) {
    const p = pendingValue('basic', s.field, s.value || '');
    out.push(`<b>${esc(s.label)}</b> ${esc(p.value || '（未定）')}${p.pending ? '<i class="pending">还没写进表</i>' : ''}`);
  }
  for (const x of (info.elsewhere || [])) {
    const field = x.label === '出身' ? 'background' : '';
    const p = field ? pendingValue('basic', field, x.value || '') : { value: x.value || '', pending: false };
    out.push(`<b>${esc(x.label)}</b> ${esc(p.value || '（未定）')}${p.pending ? '<i class="pending">还没写进表</i>' : ''}`);
  }
  return out;
}

/// 种族页用来过滤的那个种族（同样优先用刚选的）
function effectiveRace(info) {
  const card = ((info.selectors || []).find((s) => s.field === 'race') || {}).value || '';
  return pendingValue('basic', 'race', card).value.trim();
}

/// 列表条目上的「已在备选区」标记
function stageHasEntry(id) {
  return stageState.items.some((x) => x.kind === 'entry' && x.id === id);
}

/// 当前是不是「全部速查」页（列表里要标出每条的类别）
function isAllPage() {
  return !!(cf && cf.info && cf.info.type === 'all');
}

/// 「全部速查」页：某一条词条属于哪一类 → 写表时走哪一页
const ENTRY_PAGE = {
  spell: 'spell',
  classFeature: 'class',
  feat: 'feat',
  species: 'species',
  magicItem: 'magic',
};

/// 「+」：抓一条词条 / 法术进备选区。后两个参数是显示用的页名和抓完要重画的列表。
function addStageEntry(pageKey, brief, pageLabel, after) {
  if (stageState.items.some((x) => x.kind === 'entry' && x.id === brief.id)) {
    msgCf('这条已经在备选区里了', 'err');
    return;
  }
  stageState.items.push({
    kind: 'entry',
    formKey: pageKey,
    page: pageLabel || (cf.info && cf.info.title) || pageKey,
    id: brief.id,
    name: brief.name,
    subtitle: brief.subtitle || '',
  });
  renderStage();
  msgCf('已加入备选区', 'ok');
  warnQuota(pageKey, pageLabel);
  if (after) after();
}

/// 当前表单页所有可填字段（只读格和行标签不算）
function stageFormFields() {
  const out = [];
  ((formState.info || {}).sections || []).forEach((s) => (s.fields || []).forEach((f) => out.push(f)));
  return out;
}

function stageFormInputs() {
  return new Map([...$('fmSections').querySelectorAll('[data-field]')].map((el) => [el.dataset.field, el]));
}

/// 这一页填了的字段自动进备选区；跟卡里当前值一样（或清空）的就撤下来
function syncStage() {
  const key = formState.key;
  const page = (formState.info || {}).title || key;
  const inputs = stageFormInputs();
  const mine = new Map(
    stageState.items.filter((e) => e.kind === 'field' && e.formKey === key).map((e) => [e.field, e]));
  for (const f of stageFormFields()) {
    if (f.kind === 'readonly' || f.kind === 'label' || !f.cell) continue;
    const el = inputs.get(f.field);
    if (!el) continue;
    const v = (el.value || '').trim();
    if (v && v !== (f.value || '')) {
      mine.set(f.field, {
        kind: 'field', formKey: key, page,
        field: f.field, label: f.label, section: f.section, row: f.row || '',
        cell: f.cell, value: v,
      });
    } else {
      mine.delete(f.field);
    }
  }
  stageState.items = [...stageState.items.filter((e) => !(e.kind === 'field' && e.formKey === key)), ...mine.values()];
  renderStage();
}

/// 从备选区回填到当前这一页的输入框：切页面回来时，之前填的还在
function applyStageToForm() {
  const mine = new Map(
    stageState.items.filter((e) => e.kind === 'field' && e.formKey === formState.key)
        .map((e) => [e.field, e.value]));
  if (!mine.size) return;
  stageFormInputs().forEach((el, field) => {
    const v = mine.get(field);
    if (v !== undefined) el.value = v;
  });
}

function stageRowHtml(e) {
  if (e.kind === 'effect') {
    return `<div class="trow" data-kind="effect" data-key="${esc(e.formKey)}" data-id="${esc(e.label)}">
      <div class="n"><b>${esc(e.label)}</b><small>${esc(e.text)}</small></div>
      <button class="link danger" data-del="${esc(e.label)}" title="从备选区移除">×</button>
    </div>`;
  }
  if (e.kind === 'entry') {
    return `<div class="trow" data-kind="entry" data-key="${esc(e.formKey)}" data-id="${esc(e.id)}">
      <div class="n"><b>${esc(e.name)}</b><small>${esc(e.subtitle)}</small></div>
      <button class="link danger" data-del="${esc(e.id)}" title="从备选区移除">×</button>
    </div>`;
  }
  if (e.kind === 'prof') {
    return `<div class="trow" data-kind="prof" data-key="${esc(e.label)}" data-id="${esc(e.value)}">
      <div class="n"><b>${esc(e.label)} · ${esc(e.value)}</b><small>写进卡里：这一行打 O</small></div>
      <button class="link danger" data-del="${esc(e.value)}" title="从备选区移除">×</button>
    </div>`;
  }
  return `<div class="trow" data-kind="field" data-key="${esc(e.formKey)}" data-field="${esc(e.field)}">
      <div class="n"><b>${esc(fieldTitle(e))}</b><small>${esc(e.section)} · ${esc(e.cell)} → ${esc(e.value)}</small></div>
      <button class="link danger" data-del="${esc(e.field)}" title="从备选区移除">×</button>
    </div>`;
}

/// 表格版式里的字段，光有列名不够——「豁免」「初始值」「熟练」在六项属性 / 技能里
/// 每行各一个，必须带上行名才认得出是哪一个：`力量 · 豁免`、`运动 · 熟练`。
/// 单行字段（角色名、故乡…）没有 row，就照旧只显示列名。
function fieldTitle(e) {
  const row = (e.row || '').trim();
  return row ? row + ' · ' + e.label : e.label;
}

function renderStage() {
  const t = state.table || {};
  const n = stageState.items.length;
  $('stageTable').textContent = t.name || '—';
  $('stageTable').className = 'target-name' + (t.exists ? '' : ' missing');
  $('stagePath').textContent = t.path || '';
  $('stageMeta').textContent = t.exists
    ? `法术位 ${t.slotsTotal}（已用 ${t.used} / 空 ${t.free}）`
    : '还没有目标表格，先到法术页底部新建 / 选一张。';
  $('stageCount').textContent = n;
  $('stageBadge').textContent = n ? `${n} 项待填` : '空';
  $('stageBadge').className = 'badge ' + (n ? 'warn' : 'ok');
  $('stageFill').disabled = !n;
  renderTodoPop();          // 「待办」那页的备选区计数跟着走
  if (!n) {
    $('stageList').innerHTML = '<div class="empty">表单填的字段、词条页抓的词条都会进到这里，攒齐了一次性写进表。</div>';
    renderPickedPanes();
    return;
  }
  const pages = [...new Set(stageState.items.map((e) => e.page))];
  $('stageList').innerHTML = pages.length > 1
    ? pages.map((p) => `<div class="stage-group">${esc(p)}</div>` +
        stageState.items.filter((e) => e.page === p).map(stageRowHtml).join('')).join('')
    : stageState.items.map(stageRowHtml).join('');
  // 点备选区里任意一条（× 除外）→ 弹那个能拖的悬浮窗介绍它是什么。
  // 三类都管：词条、效果（出身 / 职业给的）、表单字段。
  [...$('stageList').querySelectorAll('.trow')].forEach((el) => {
    el.onclick = (ev) => {
      if (ev.target.closest('[data-del]')) return;
      const kind = el.dataset.kind;
      const key = el.dataset.key;
      const item = stageState.items.find((x) => {
        if (x.kind !== kind) return false;
        if (kind === 'entry') return x.id === el.dataset.id;
        if (kind === 'effect') return x.formKey === key && x.label === el.dataset.id;
        return x.formKey === key && x.field === el.dataset.field;
      });
      if (item) showStagePop(item, el);
    };
  });
  // 中间那一栏（法术页 / 种族 / 专长 / 全部速查）列的是「已选」，跟着备选区一起变
  renderPickedPanes();
}

/// 备选区里点一条 → 弹悬浮窗说明它是什么。三类都走这儿：
///   词条（法术 / 职业特性 / 种族特性 / 专长 / 魔法物品）→ 照词条库画
///   效果（出身 / 职业给的那几条）→ 就是那条效果的正文
///   表单字段（力量·初始值、武器名、出身…）→ 值要是件装备 / 魔法物品 / 职业 / 子职 / 出身，
///     就弹那一条的正文；都不是（纯数字、名字…）就说明这一格是什么、写进卡里哪儿
async function showStagePop(item, anchor) {
  if (item.kind === 'entry') return showStagedEntry(item, anchor);
  if (item.kind === 'effect') {
    showPopData({
      kind: 'effect', hideAdd: true, name: item.label, en: '',
      tags: [item.page || ''].filter(Boolean),
      fields: {}, text: item.text || '（这条效果没有正文）',
    }, anchor);
    return;
  }
  if (item.kind === 'prof') {
    showPopData({
      kind: 'prof', hideAdd: true, name: item.label + ' · ' + item.value, en: '',
      tags: ['备选区'],
      fields: {
        '打在哪': '卡里技能表「' + item.value + '」那一行的熟练格（B 列）',
        '写成什么': 'O（卡里 X = 没有，O = 有）',
      },
      text: '点右下角「填入表格」才会写进卡里。',
    }, anchor);
    return;
  }
  const v = String(item.value == null ? '' : item.value).trim();
  // 纯数字 / 打勾值不用去库里翻，翻也翻不到
  const worthLooking = v && !/^[\d\s.,+\-]+$/.test(v) && !['X', 'O', '是', '否'].includes(v);
  const hit = worthLooking ? await lookupByName(v) : null;
  if (hit) { showPopData(hit, anchor); return; }
  showPopData({
    kind: 'field', hideAdd: true, name: fieldTitle(item), en: '',
    tags: [item.page || '', item.section || ''].filter(Boolean),
    fields: { '当前值': v || '（空）', '写进': (item.cell || '未识别') + (item.page ? '（' + item.page + '）' : '') },
    text: '这是表单里改过的一格：点右下角「填入表格」，它才写进卡里。',
  }, anchor);
}

/// 备选区里点一条词条 → 弹悬浮窗介绍它是什么。
/// 词条库里有就照库里的画；没有（比如从卡里读出来的生名字）就用手上这份凑一条，
/// 免得点了半天什么反应都没有。
// ------------------------------------------------------------ 熟练项（种族 / 专长 / 背景给的）
/// 卡里技能表那 18 个技能名（从「基本信息」表单里读，不写死）。
let skillNameCache = null;
async function cardSkillNames() {
  if (skillNameCache) return skillNameCache;
  const names = [];
  try {
    const info = await api('/api/form?key=basic');
    for (const s of (info.sections || [])) {
      if (s.title !== '技能') continue;
      for (const f of (s.fields || [])) {
        if (f.kind === 'label' && f.value) names.push(f.value);
      }
    }
  } catch (e) { /* 读不到就先不认 */ }
  skillNameCache = names;
  return names;
}

/// 从一条词条的正文里认出它给的**技能**熟练：
///   「你具有洞悉、察觉或求生之一技能的熟练」→ {choose:true,  names:[洞悉,察觉,求生]}
///   「你具有察觉技能的熟练」              → {choose:false, names:[察觉]}
/// 只认技能表里真有的名字，认不出（武器 / 护甲 / 工具那种，卡里也没有勾选格）就返回 null。
async function proficiencyPick(text) {
  const t = String(text || '');
  if (!t.includes('熟练')) return null;
  const skills = await cardSkillNames();
  if (!skills.length) return null;
  // 「……之一 / 其一」：候选就是它前面那句话里出现的技能名
  const one = /([^。；\n]{0,60}?)(?:之一|其一)/.exec(t);
  if (one) {
    const names = skills.filter((s) => one[1].includes(s));
    if (names.length) return { choose: true, names: names };
  }
  // 固定给的：句子里说了「技能的熟练」，把出现的技能名都算上
  if (/技能的熟练|技能熟练/.test(t)) {
    const names = skills.filter((s) => t.includes(s));
    if (names.length) return { choose: false, names: names };
  }
  return null;
}

/// 抓一条熟练进备选区（点「填入表格」时才真写进卡里打 O）
function addStageProf(name, label) {
  const lab = label || '技能熟练';
  if (!name) return;
  if (stageState.items.some((x) => x.kind === 'prof' && x.label === lab && x.value === name)) return;
  stageState.items.push({ kind: 'prof', formKey: 'prof', page: '熟练', label: lab, value: name });
  renderStage();
}

/// 抓一条词条时顺手看它给不给熟练：固定给的直接进备选区；写「……之一」的
/// 把候选摆到悬浮窗里让玩家挑，挑完再进备选区。
async function offerProficiencies(brief, anchor) {
  const kind = typeOfFormKey(ENTRY_PAGE[brief.type || ''] || activePage);
  let entry = null;
  try {
    entry = (await api('/api/entry?kind=' + encodeURIComponent(kind) + '&id=' + encodeURIComponent(brief.id))).entry;
  } catch (e) {
    return;
  }
  if (!entry) return;
  const pick = await proficiencyPick((entry.summary || '') + '\n' + (entry.text || ''));
  if (!pick) return;
  if (!pick.choose) {
    pick.names.forEach((n) => addStageProf(n));
    msgCf('这条给的技能熟练已经抓进备选区：' + pick.names.join('、'), 'ok');
    return;
  }
  showPopData(Object.assign({}, entry, {
    kind: kind,
    choices: pick.names,
    choicesHint: '这条要你挑一个技能熟练，挑完会进备选区，点「填入表格」再写进卡里：',
  }), anchor, { onChoice: (v) => addStageProf(v) });
}

async function showStagedEntry(item, anchor) {
  const kind = typeOfFormKey(item.formKey);
  try {
    const r = await api('/api/entry?kind=' + encodeURIComponent(kind) + '&id=' + encodeURIComponent(item.id));
    showPopData(Object.assign({ kind: kind }, r.entry), anchor);
    return;
  } catch (e) { /* 词条库里没这条，下面兜一条 */ }
  showPopData({
    id: item.id, kind: kind, name: item.name, en: item.subtitle || '',
    tags: [], fields: {}, text: '',
  }, anchor);
}

/// 拿一个名字去两套库里找：先装备 / 魔法物品（词条库），再职业 / 子职 / 出身（规则库）。
/// 找到就返回一份能直接画进悬浮窗的数据，找不到回 null。
async function lookupByName(name) {
  for (const kind of ['equipment', 'magicItem']) {
    try {
      const r = await api('/api/entry?kind=' + kind + '&id=' + encodeURIComponent(kind + ':' + name));
      return Object.assign({ kind: kind, hideAdd: true }, r.entry);
    } catch (e) { /* 这一类里没有 */ }
  }
  // 子职业要连主职业一起查（规则库的键是 `subclass|主职业|子职业`）
  const cls = (stageState.items.find((x) => x.kind === 'field' && x.field === 'cls') || {}).value || '';
  for (const [kind, withCls] of [['class', false], ['background', false], ['subclass', true]]) {
    try {
      const q = '/api/rule?kind=' + kind + (withCls && cls ? '&cls=' + encodeURIComponent(cls) : '') +
        '&name=' + encodeURIComponent(name);
      const r = await api(q);
      if (r.found) {
        return {
          kind: kind, hideAdd: true,
          name: r.title || r.name || name, en: '',
          tags: [r.book || ''].filter(Boolean),
          fields: {}, text: r.text || '',
        };
      }
    } catch (e) { /* 规则库里没有 */ }
  }
  return null;
}

/// 把备选区里的东西一并写进表：字段走 /api/form/fill，词条走 /api/page/fill
async function fillStage() {
  if (!stageState.items.length) return;
  const byForm = new Map();
  const byPage = new Map();
  const byEffect = new Map();     // 效果按来源分：出身效果走 /api/background/fill，职业效果走 /api/class/fill
  for (const e of stageState.items) {
    if (e.kind === 'effect') {
      const key = e.formKey || 'background';
      if (!byEffect.has(key)) byEffect.set(key, []);
      byEffect.get(key).push({ label: e.label, text: e.text, panel: !!e.panel });
    } else if (e.kind === 'entry') {
      if (!byPage.has(e.formKey)) byPage.set(e.formKey, []);
      byPage.get(e.formKey).push(e.name);
    } else if (e.kind === 'prof') {
      // 熟练单独走 /api/prof/fill（下面统一发一次），别当成表单字段
    } else {
      if (!byForm.has(e.formKey)) byForm.set(e.formKey, {});
      byForm.get(e.formKey)[e.field] = e.value;
    }
  }
  $('stageAfter').hidden = true;
  $('stageMsg').className = 'msg';
  $('stageMsg').textContent = '正在写入…';
  try {
    const lines = [];
    let backup = '';
    let count = 0;
    for (const [key, values] of byForm) {
      const r = await post('/api/form/fill', { key, values });
      count += r.writtenCount || 0;
      (r.written || []).forEach((w) => lines.push(`${w.label}：${w.cell} = ${w.value}`));
      (r.missing || []).forEach((m) => lines.push('· 这张卡里没有这张表，没写：' + m));
      if (r.backup) backup = r.backup;
      if (key === formState.key && r.form) formState.info = r.form;
    }
    for (const [key, names] of byPage) {
      if (key === 'spell') {
        // 法术走 /api/fill（认法术位那一套）
        const r = await post('/api/fill', { names });
        count += r.writtenCount || 0;
        (r.written || []).forEach((w) => lines.push(`法术：${w.cell}`));
        if (r.alreadyInTable && r.alreadyInTable.length) lines.push(`（表里已有，跳过：${r.alreadyInTable.join('、')}）`);
        if (r.duplicateInBatch && r.duplicateInBatch.length) lines.push(`（本批重复，跳过：${r.duplicateInBatch.join('、')}）`);
        if (r.notInCard && r.notInCard.length) lines.push(`（卡内「法术大全」里没有：${r.notInCard.join('、')}）`);
        if (r.overflow && r.overflow.length) lines.push(`（法术位不够，没写：${r.overflow.join('、')}）`);
        if (r.backup) backup = r.backup;
        continue;
      }
      const r = await post('/api/page/fill', { key, names });
      count += r.writtenCount || 0;
      (r.written || []).forEach((w) => lines.push(`${w.name}：${w.cell}`));
      if (r.alreadyInTable && r.alreadyInTable.length) lines.push(`（表里已有，跳过：${r.alreadyInTable.join('、')}）`);
      if (r.overflow && r.overflow.length) lines.push(`（槽位不够，没写：${r.overflow.join('、')}）`);
      if (r.backup) backup = r.backup;
      if (key === activePage && r.page) {
        cf.info = r.page;
        renderCfTarget();
        cfSearch().catch(() => {});
      }
    }
    for (const [key, list] of byEffect) {
      const r = await post(key === 'class' ? '/api/class/fill' : '/api/background/fill', { effects: list });
      count += (r.written || []).length;
      (r.written || []).forEach((w) => lines.push(`${w.label}：${w.sheet}!${w.cell} = ${w.value}`));
      (r.auto || []).forEach((a) => lines.push('· 卡里自己算：' + a));
      (r.undone || []).forEach((u) => lines.push('· 已还原上一次写进去的：' + u));
      (r.unmapped || []).forEach((u) => lines.push('· 没写的：' + u));
      if (r.note) lines.push('· ' + r.note);
      if (r.backup) backup = r.backup;
    }
    // 熟练项（种族特性 / 专长里挑出来的）单独走 /api/prof/fill，先把它们抄下来
    const profs = stageState.items.filter((e) => e.kind === 'prof');
    stageState.items = [];
    if (profs.length) {
      const r = await post('/api/prof/fill', {
        skills: profs.filter((e) => e.label !== '豁免熟练').map((e) => e.value),
        saves: profs.filter((e) => e.label === '豁免熟练').map((e) => e.value),
      });
      count += (r.written || []).length;
      (r.written || []).forEach((w) => lines.push(`${w.label}：${w.cell} 打 O（${w.name}）`));
      (r.unmapped || []).forEach((u) => lines.push('· ' + u));
      if (r.backup) backup = r.backup;
    }
    // 写完必须重新问服务端要一份再画：renderForm() 用的是写入前拉到的那份数据，
    // 页面会停在旧值上（看着像"没写进去"）。
    if (formState.info) await loadForm(true);
    // 写完之后，只读页上那句「还没写进表」要跟着消失
    if (cf.info && cf.info.locked) {
      await loadPageInfo();
      cfSearch().catch(() => {});
    }
    await loadTable(true);
    loadProgress().catch(() => {});
    if (!count) {
      $('stageMsg').className = 'msg';
      $('stageMsg').textContent = '没有需要改的（和卡里一致）。';
      return;
    }
    $('stageMsg').textContent = '';
    $('stageAfterTitle').textContent = `已写入 ${count} 项`;
    $('stageAfterDetail').textContent =
      lines.join('\n') +
      (backup ? `\n· 写入前的备份：${backup}` : '');
    $('stageAfter').hidden = false;
  } catch (e) {
    $('stageMsg').className = 'msg err';
    $('stageMsg').textContent = '写入失败：' + e.message;
  }
}

function sectionHtml(s) {
  const fields = s.fields || [];
  const isTable = fields.some((f) => f.row);
  if (!isTable) {
    return `<div class="fcard"><h3>${esc(s.title)}</h3>
      <div class="fgrid">${fields.map((f) => fieldHtml(f)).join('')}</div></div>`;
  }
  // 表格版式：同一 row 的字段合成一行，列按 col 排
  const cols = [...new Set(fields.map((f) => f.col))].sort((a, b) => a - b);
  const head = cols
    .map((c) => fields.find((f) => f.col === c && f.kind !== 'label' && f.col > 0) || fields.find((f) => f.col === c))
    .map((f) => `<th>${esc(f ? f.label : '')}</th>`)
    .join('');
  const rows = [...new Set(fields.map((f) => f.row))];
  const body = rows.map((r) => {
    const cells = cols.map((c) => {
      const f = fields.find((x) => x.row === r && x.col === c);
      return `<td>${f ? fieldHtml(f, true) : ''}</td>`;
    }).join('');
    return `<tr>${cells}</tr>`;
  }).join('');
  return `<div class="fcard"><h3>${esc(s.title)}</h3>
    <table class="ftable"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

// ---------------------------------------------------------------- 自绘下拉
// 原生 <select> / <datalist> 的候选列表是浏览器另开一个窗口画的，桌面版外壳
// 用的 WebView2 离屏合成模式里这类弹出层根本不显示（能聚焦，点了没反应）。
// 所以控件一律用页面内的 .combo：值还是挂在那个 [data-field] 的 <input> 上，
// 触发的事件也还是 input / change，别处照旧。
let comboOpen = null;

function comboOptionsHtml(options, value, emptyLabel) {
  // 卡里现在的值如果不在下拉选项里（比如「着装」那格卡自己的下拉只有 是/否，
  // 而我们把空白值写成 X），也把它列出来——不然改选过别的就再也选不回 X 了。
  const list = value && !options.includes(value) ? [value].concat(options) : options;
  return [''].concat(list).map((o) => {
    const label = o === '' ? (emptyLabel || '—') : o;
    const tip = o === '' ? ' title="留空 = 这一格不动"' : '';
    return `<div class="combo-opt${o === value ? ' on' : ''}" data-v="${esc(o)}"${tip}>${esc(label)}</div>`;
  }).join('');
}

/// editable=true 时输入框可以自己打字（原来挂 datalist 的那批字段）
function comboHtml({ field, value = '', options = [], editable = false, type = 'text', emptyLabel = '', id = '', title = '', narrow = false, label = '' }) {
  return `<span class="combo${narrow ? ' narrow' : ''}"${title ? ` title="${esc(title)}"` : ''}${label ? ` data-label="${esc(label)}"` : ''}>
    <input ${id ? `id="${id}"` : ''}data-field="${esc(field)}" value="${esc(value)}"
      ${type === 'number' ? 'type="number" min="0"' : 'type="text"'}
      placeholder="${editable ? '' : '选择…'}" ${editable ? '' : 'readonly'} autocomplete="off" spellcheck="false">
    <button type="button" class="combo-btn" tabindex="-1" aria-label="展开">▾</button>
    <div class="combo-pop" hidden>${comboOptionsHtml(options, value, emptyLabel)}</div>
  </span>`;
}

function comboInit(root) {
  for (const box of root.querySelectorAll('.combo')) {
    if (box.dataset.wired) continue;
    box.dataset.wired = '1';
    const input = box.querySelector('input');
    const btn = box.querySelector('.combo-btn');
    const pop = box.querySelector('.combo-pop');
    input.addEventListener('focus', () => comboOpenList(box));
    input.addEventListener('click', () => comboOpenList(box));
    input.addEventListener('input', () => comboFilter(box));
    input.addEventListener('keydown', (ev) => comboKey(box, ev));
    input.addEventListener('blur', () => setTimeout(() => comboClose(box), 150));
    btn.addEventListener('mousedown', (ev) => { ev.preventDefault(); ev.stopPropagation(); });
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (box.classList.contains('open')) comboClose(box);
      else { input.focus(); comboOpenList(box); }
    });
    // 用 mousedown 选，别等 click：blur 会先把列表收掉
    pop.addEventListener('mousedown', (ev) => {
      const opt = ev.target.closest('.combo-opt');
      if (!opt) return;
      ev.preventDefault();
      comboPick(box, opt.dataset.v || '');
    });
  }
}

const comboOpts = (box) => [...box.querySelectorAll('.combo-opt')];
const comboShown = (box) => comboOpts(box).filter((el) => el.style.display !== 'none');

function comboFilter(box) {
  const q = (box.querySelector('input').value || '').trim().toLowerCase();
  for (const opt of comboOpts(box)) {
    const v = opt.dataset.v || '';
    const show = !q || v.toLowerCase().includes(q);
    opt.style.display = show ? '' : 'none';
  }
  comboOpenList(box);
}

function comboHighlight(box, dir) {
  const vis = comboShown(box);
  if (!vis.length) return;
  let i = vis.findIndex((el) => el.classList.contains('hover'));
  i = dir > 0 ? (i + 1) % vis.length : (i <= 0 ? vis.length - 1 : i - 1);
  vis.forEach((el) => el.classList.remove('hover'));
  vis[i].classList.add('hover');
  vis[i].scrollIntoView({ block: 'nearest' });
}

function comboKey(box, ev) {
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    ev.preventDefault();
    if (!box.classList.contains('open')) comboOpenList(box);
    comboHighlight(box, ev.key === 'ArrowDown' ? 1 : -1);
    return;
  }
  if (ev.key === 'Enter') {
    const hover = comboShown(box).find((el) => el.classList.contains('hover'));
    if (hover) { ev.preventDefault(); comboPick(box, hover.dataset.v || ''); }
    else comboClose(box);
    return;
  }
  if (ev.key === 'Escape' || ev.key === 'Tab') comboClose(box);
}

function comboPick(box, value) {
  const input = box.querySelector('input');
  const old = input.value;
  input.value = value;
  comboOpts(box).forEach((el) => el.classList.toggle('on', (el.dataset.v || '') === value));
  comboClose(box);
  input.focus();
  if (old !== value) {
    // 只发 change。input 事件会被输入框自己的 comboFilter 接住，
    // 把候选列表筛成"只剩刚选的那一项"，下次就什么都点不到了。
    input.dispatchEvent(new Event('change', { bubbles: true }));
    showItemPop(box, value);
  }
}

/// 「装备与背包」里挑完装备的名字（武器 / 护甲）→ 在悬浮窗里介绍一下这件东西是什么。
/// 词条库里装备的 id 就是 `equipment:名字`，魔法物品是 `magicItem:名字`；
/// 两边都没有（「—轻甲—」那种分组标题、武僧 / 野蛮人那种职业行、自填的名字）就什么都不弹。
const ITEM_FIELD_LABELS = ['武器名', '护甲名', '盾牌名'];

async function showItemPop(box, name) {
  if (!ITEM_FIELD_LABELS.includes(box.dataset.label || '')) return;
  const v = String(name || '').trim();
  if (!v || v.startsWith('—')) return;
  for (const kind of ['equipment', 'magicItem']) {
    try {
      const r = await api('/api/entry?kind=' + kind + '&id=' + encodeURIComponent(kind + ':' + v));
      const e = Object.assign({ kind: kind, hideAdd: true }, r.entry);
      // 「武僧 / 野蛮人 / 龙术 / 舞蹈诗…」这一批不是真装备，是职业给的替代 AC
      // （10 + 某调整值 + 敏捷调整值）。数据里那条「护甲等级 / 敏捷加值」是抽取时
      // 存下的旧数字，跟公式对不上，显示出来只会误导 —— 只留公式那一行。
      if (e.fields && String(e.fields['属性'] || '').includes('调整值')) {
        delete e.fields['护甲等级'];
        delete e.fields['敏捷加值'];
      }
      showPopData(e, box);
      return;
    } catch (e) { /* 这一类里没有这条，试下一类 */ }
  }
}

function comboOpenList(box) {
  if (comboOpen && comboOpen !== box) comboClose(comboOpen);
  const input = box.querySelector('input');
  const pop = box.querySelector('.combo-pop');
  if (!input || !pop) return;
  // 打开时按当前值刷新一下高亮（备选区回填会直接改 input.value）
  comboOpts(box).forEach((el) => el.classList.toggle('on', (el.dataset.v || '') === input.value));
  box.classList.add('open');
  pop.hidden = false;
  comboOpen = box;
  const r = input.getBoundingClientRect();
  pop.style.minWidth = Math.max(Math.round(r.width), 120) + 'px';
  pop.style.maxHeight = Math.min(300, Math.max(120, window.innerHeight - 20)) + 'px';
  pop.style.left = Math.round(r.left) + 'px';
  pop.style.top = '0px'; // 先量高度再定位
  const h = pop.offsetHeight;
  const below = window.innerHeight - r.bottom - 8;
  pop.style.top = Math.round((below >= h || below >= r.top - 8) ? r.bottom + 3 : r.top - h - 3) + 'px';
}

function comboClose(box) {
  if (!box) return;
  box.classList.remove('open');
  const pop = box.querySelector('.combo-pop');
  if (pop) {
    pop.hidden = true;
    pop.querySelectorAll('.hover').forEach((el) => el.classList.remove('hover'));
  }
  if (comboOpen === box) comboOpen = null;
}

document.addEventListener('mousedown', (ev) => {
  if (comboOpen && !(ev.target.closest && ev.target.closest('.combo'))) comboClose(comboOpen);
});
window.addEventListener('resize', () => comboClose(comboOpen));
document.addEventListener('scroll', (ev) => {
  if (!comboOpen) return;
  // 候选列表自己滚动（滚轮 / 拖滚动条）不该把下拉关掉——只有别的地方滚才关
  const t = ev.target;
  if (t && t.closest && t.closest('.combo') === comboOpen) return;
  comboClose(comboOpen);
}, true);

function fieldHtml(f, inTable) {
  if (f.kind === 'label') return `<span class="fname">${esc(f.value || f.label)}</span>`;
  if (f.kind === 'readonly') return `<span class="fval ro" title="${esc(f.cell)}">${esc(f.value)}</span>`;
  if (f.kind === 'toggle') {
    return comboHtml({
      field: f.field, value: f.value, options: f.options || ['X', 'O'],
      emptyLabel: '·', title: f.cell, narrow: true,
    });
  }
  if (inTable) {
    // 表格里表头已经写了字段名，格子里只放控件，格子位置放 tooltip
    const t = `title="${esc(f.label)} ${esc(f.cell)}"`;
    if (asSelect(f)) {
      return comboHtml({
        field: f.field, value: f.value, options: f.options,
        emptyLabel: '·', title: `${f.label} ${f.cell}`, narrow: true,
      });
    }
    if (f.options && f.options.length) {
      // 能自己打字、但也有候选（武器名 / 护甲名那种）→ 照样给下拉，别把候选丢了
      return comboHtml({
        field: f.field, value: f.value, options: f.options, editable: true,
        type: f.kind === 'number' ? 'number' : 'text',
        title: `${f.label} ${f.cell}`, narrow: true, label: f.label,
      });
    }
    return `<input data-field="${esc(f.field)}" value="${esc(f.value)}" ${t}
      ${f.kind === 'number' ? 'type="number"' : 'type="text"'} spellcheck="false">`;
  }
  const id = 'fm_' + f.field;
  const cls = 'ffield' + (f.cell ? '' : ' miss');
  // detected=false：这一格没从卡里认出来，用的是兜底位置，标一下免得用户以为它是准的
  const guess = f.detected === false;
  const hint = `<i class="fcell"${guess ? ' title="这一格没从卡里认出来，是兜底位置，可能不对"' : ''}>${esc(f.cell || '未识别')}${guess ? ' ⚠' : ''}</i>`;
  if (asSelect(f)) {
    return `<label class="${cls}"><span class="flabel">${esc(f.label)}${hint}</span>
      ${comboHtml({ id, field: f.field, value: f.value, options: f.options })}</label>`;
  }
  if (f.options.length) {
    // 有候选值的输入框：照样能自己打字，只是候选走页面内的列表
    return `<label class="${cls}"><span class="flabel">${esc(f.label)}${hint}</span>
      ${comboHtml({ id, field: f.field, value: f.value, options: f.options, editable: true, type: f.kind === 'number' ? 'number' : 'text' })}</label>`;
  }
  return `<label class="${cls}"><span class="flabel">${esc(f.label)}${hint}</span>
    <input id="${id}" data-field="${esc(f.field)}" value="${esc(f.value)}"
      ${f.kind === 'number' ? 'type="number" min="0"' : 'type="text"'} spellcheck="false"></label>`;
}

/// 要不要渲染成「只读下拉」（只能从列表里挑，不能自己打字）：
/// 选项不多、或者跟别的字段联动的（子职业跟主职业、亚种跟种族）。
/// 注：现在控件一律是页面自绘的 .combo，已经没有原生 <select> 了。
function asSelect(f) {
  if (f.kind !== 'select') return false;
  if (f.parent) return true;
  return !!(f.options && f.options.length && f.options.length <= 30);
}

/// 表单里的控件（按字段名找）
function formInput(field) {
  return [...$('fmSections').querySelectorAll('[data-field]')]
    .find((el) => el.dataset.field === field) || null;
}

/// 父字段一改，跟着它的那份选项就换（子职业跟主职业、亚种跟种族）
function refreshDependent(parentField) {
  for (const f of stageFormFields()) {
    if (f.parent !== parentField) continue;
    const el = formInput(f.field);
    if (!el) continue;
    const pe = formInput(f.parent);
    const val = pe ? (pe.value || '').trim() : '';
    const list = ((val && f.optionsByParent) ? f.optionsByParent[val] : null) || f.options || [];
    const box = el.closest ? el.closest('.combo') : null;
    const pop = box ? box.querySelector('.combo-pop') : null;
    if (!pop) continue; // 没有候选的普通输入框，不用管
    const keep = el.value;
    if (comboOpts(box).map((o) => o.dataset.v || '').join('\u0000') === ['', ...list].join('\u0000')) continue;
    pop.innerHTML = comboOptionsHtml(list, keep);
    // 换了主职业之后，原来那个子职业已经不属于它了，就别留着
    if (!list.includes(keep)) el.value = '';
  }
}

function refreshAllDependents() {
  const parents = [...new Set(stageFormFields().map((f) => f.parent).filter(Boolean))];
  parents.forEach(refreshDependent);
}

/// 表单底部那张只读规则卡：卡负责「叫什么」（写表用它），规则库负责「是什么」
let ruleTimer = null;
function scheduleRuleCard() {
  clearTimeout(ruleTimer);
  ruleTimer = setTimeout(loadRuleCard, 180);
}

/// 当前这一页要看哪几条规则正文
function ruleQueries() {
  const kinds = RULES_ON_PAGE[formState.key] || [];
  const out = [];
  if (kinds.includes('subclass')) {
    const cls = (formInput('cls') || {}).value || '';
    const sub = (formInput('sub') || {}).value || '';
    if (sub) {
      out.push({
        label: '子职业规则',
        name: sub,
        url: '/api/rule?kind=subclass&cls=' + encodeURIComponent(cls) + '&sub=' + encodeURIComponent(sub),
      });
    }
  }
  if (kinds.includes('background')) {
    const bg = (formInput('background') || {}).value || '';
    if (bg) {
      out.push({ label: '出身规则', name: bg, url: '/api/rule?kind=background&name=' + encodeURIComponent(bg) });
    }
  }
  return out;
}

async function loadRuleCard() {
  const box = document.getElementById('fmRule');
  if (!box) return;
  const queries = ruleQueries();
  if (!queries.length) { box.hidden = true; box.innerHTML = ''; return; }
  const blocks = await Promise.all(queries.map(async (q) => {
    try {
      const r = await api(q.url);
      if (!r.found) {
        return `<div class="rule-block"><h3>${q.label}</h3>
          <div class="rule-meta">${esc(r.reason || '规则库里没有这一条')}：「${esc(q.name)}」</div></div>`;
      }
      const alias = r.title && r.title !== q.name ? ` · 卡里写作「${esc(q.name)}」` : '';
      return `<div class="rule-block"><h3>${q.label} · ${esc(r.title)}</h3>
        <div class="rule-meta">${esc(r.book || '')}${(r.crumbs || []).length ? ' · ' + esc(r.crumbs.join(' › ')) : ''}${alias}</div>
        <div class="rule-body">${esc(r.text || '')}</div></div>`;
    } catch (e) {
      return '';
    }
  }));
  const html = blocks.filter(Boolean).join('');
  box.innerHTML = html;
  box.hidden = !html;
}

// 顺序按车卡流程走：基本信息（含属性与技能）→ 起源 → 职业 → 专长 → 装备与背包
//                  → 法术 → 伙伴与据点 → 其他
// sheet 字段是对应卡里的实际工作表名，下一步做各个页面时照这个接。
// 目前只有「法术 → 法术列表」是真页面，其余节点点进去是空白占位。
const TREE = [
  // 基本信息就一个节点，点开就是那张表单（原来拆的两条其实是同一张表）
  { id: 'basic', title: '基本信息', sheet: '主要', view: 'form', form: 'basic', done: true },
  // 上级节点也点得开：直接落到这一块那张表单 / 那一页上，别停在一块「空白占位」上
  { id: 'origin', title: '起源', sheet: '起源', view: 'form', form: 'origin', children: [
    // 种族和背景在设计树里分成上下两行；两个页面里的种族 / 亚种 / 出身都是只读的。
    // 「其它」那一栏删了——它的内容就是上面这个「起源」表单本身，点上一级就是它。
    { id: 'origin.race', title: '种族', sheet: '主要', view: 'page', page: 'species', done: true },
    { id: 'origin.background', title: '背景', sheet: '起源', view: 'page', page: 'background', done: true },
  ] },
  { id: 'class', title: '职业', sheet: '主要', view: 'page', page: 'class', children: [
    // 「职业特性」那一栏删了——点上一级「职业」就是这个页面；
    // 按等级看特性在下面这一栏「职业特性」里
    { id: 'class.main', title: '主职业 / 子职业', sheet: '主要', view: 'page', page: 'classinfo', done: true },
    { id: 'class.level', title: '职业特性', sheet: '主要', view: 'page', page: 'classlevel', done: true },
  ] },
  // 「属性与技能」这一支整个删了：六项属性 / 豁免 / 技能 / 工具都并进第一页「基本信息」，
  // 不需要第二个入口（那一页的表单还在，走 /api/form?key=attrs，留给以后要拆回来用）
  // 「专长」下面那条「专长 / 属性提升」删了——上级点开就是同一个页面，
  // 不再挂一个只有一个子项、还指着同一页的子菜单
  { id: 'feat', title: '专长', sheet: '主要', view: 'page', page: 'feat', done: true },
  // 「装备与背包」这一级点开就是**背包**那一页（写卡里 `背包` 表的存货格子）；
  // 武器 / 护甲 / 盾写的是另一批格子（`主要` 表），单独挂在下面，别和背包混成一页。
  { id: 'gear', title: '装备与背包', sheet: '背包', view: 'form', form: 'bag', done: true, children: [
    { id: 'gear.weapon', title: '武器 / 护甲 / 盾', sheet: '主要', view: 'form', form: 'gear', done: true },
    // 魔法物品挂在「装备与背包」下面：它写的还是「主要」表那几块（武器 / 护甲 / 盾 / 奇物），
    // 跟装备是一家的东西，只是多一个上面那块规则书速查
    { id: 'gear.magic', title: '魔法物品', sheet: '主要', view: 'form', form: 'magic', done: true },
  ] },
  { id: 'spell', title: '法术', sheet: '法术书', view: 'spell', children: [
    { id: 'spell.list', title: '法术列表', view: 'spell', done: true },
  ] },
  // 最末尾：全部速查——法术 / 职业特性 / 专长 / 种族 / 魔法物品一起搜。
  // 抓进备选区的每一条记着自己属于哪一类，写表时各走各的页。
  { id: 'all', title: '全部速查', view: 'page', page: 'all', done: true },
  // 速查后面接一栏致谢：这张卡是「似雨悲灵」做的，署名 / QQ / 反馈群就写在卡的
  // 「更新」工作表里，这一页直接从卡里读出来显示（服务端按内容认，不认格子）。
  { id: 'thanks', title: '致谢', sheet: '更新', view: 'thanks', done: true },
  // 「伙伴与据点」「其他」两条删了——里面那几张表还没做页面，先不占设计树的位置
];

const treeState = { selected: 'spell.list', open: new Set(['spell']) };

/// 合并 / 删掉过的老节点：localStorage 里还记着的话，回到合并后那一条，
/// 别让「上次停在这一页」的人一点开就掉到别的页去。
const TREE_ALIASES = { 'feat.pick': 'feat', 'gear.item': 'gear', 'magic': 'gear.magic' };

function findNode(id, nodes = TREE) {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.children) {
      const hit = findNode(id, n.children);
      if (hit) return hit;
    }
  }
  return null;
}

function pathTo(id, nodes = TREE, chain = []) {
  for (const n of nodes) {
    const next = [...chain, n];
    if (n.id === id) return next;
    if (n.children) {
      const hit = pathTo(id, n.children, next);
      if (hit) return hit;
    }
  }
  return null;
}

function nodeHtml(node) {
  const kids = node.children || [];
  const open = treeState.open.has(node.id);
  const on = treeState.selected === node.id;
  const cls = ['tree-node', on ? 'on' : '', node.done ? 'done' : ''].filter(Boolean).join(' ');
  // 还没做的节点标一下，免得点进去一片空白让人以为坏了
  const pending = !node.done && !node.view
    ? '<span class="todo">待做</span>'
    : '';
  const head = `<div class="${cls}" data-id="${esc(node.id)}">
      <span class="caret">${kids.length ? (open ? '▾' : '▸') : ''}</span>
      <span class="label">${esc(node.title)}</span>
      ${pending || (node.sheet ? `<span class="sheet">${esc(node.sheet)}</span>` : '')}
    </div>`;
  if (!kids.length) return head;
  return head + `<div class="tree-kids"${open ? '' : ' hidden'}>${kids.map(nodeHtml).join('')}</div>`;
}

function renderTree() {
  $('tree').innerHTML = '<div class="tree-head">设计树 · 车卡顺序</div>' + TREE.map(nodeHtml).join('');
  [...$('tree').querySelectorAll('.tree-node')].forEach((el) => {
    el.onclick = (ev) => {
      const id = el.dataset.id;
      const node = findNode(id);
      if (!node) return;
      if (node.children && node.children.length) {
        // 只有点小三角才折叠；点名字 = 选中并展开（免得手一抖把「法术列表」藏起来）
        if (ev.target.classList.contains('caret')) {
          if (treeState.open.has(id)) treeState.open.delete(id);
          else treeState.open.add(id);
        } else {
          treeState.open.add(id);
        }
      }
      selectNode(id);
    };
  });
}

function selectNode(id) {
  const node = findNode(id);
  if (!node) return;
  treeState.selected = id;
  renderTree();
  if (node.view === 'spell') {
    $('viewSpell').hidden = false;
    $('viewForm').hidden = true;
    $('viewClass').hidden = true;
    $('viewBlank').hidden = true;
    $('viewThanks').hidden = true;
    // 中间那一栏列「已选法术」：这是给你看自己挑了哪些的，写表还是走备选区
    renderPickedPanes();
    // 列表上的「已在备选区」是按当时的备选区算出来的，回来时重画一次才准
    search().catch(() => {});
  } else if (node.view === 'form') {
    $('viewSpell').hidden = true;
    $('viewClass').hidden = true;
    $('viewBlank').hidden = true;
    $('viewThanks').hidden = true;
    $('viewForm').hidden = false;
    const key = node.form || 'basic';
    // 同一张表单已经画好了就别重画（会把刚填一半的输入冲掉，也没必要）；
    // 换了页才去读，读之前先把上一页的 DOM 换掉。
    const sameForm = formState.key === key && formState.info && !formState.info.error;
    formState.key = key;
    if (!sameForm) {
      formState.info = null;
      formPlaceholder();
      loadForm().catch(() => {});
    }
  } else if (node.view === 'page') {
    $('viewSpell').hidden = true;
    $('viewClass').hidden = false;
    $('viewForm').hidden = true;
    $('viewBlank').hidden = true;
    $('viewThanks').hidden = true;
    initPageState(node.page || 'class');
    // 每个页面首次进来才去读卡（省启动时间）
    renderPickedPanes();
    if (!cf.loaded) {
      cf.loaded = true;
      loadPageInfo().then(() => cfSearch()).catch(() => {});
    } else {
      renderCfTarget();
      renderCfFilters();
      cfSearch().catch(() => {});
    }
  } else if (node.view === 'thanks') {
    $('viewSpell').hidden = true;
    $('viewClass').hidden = true;
    $('viewForm').hidden = true;
    $('viewBlank').hidden = true;
    $('viewThanks').hidden = false;
    renderThanks().catch(() => {});
  } else {
    $('viewSpell').hidden = true;
    $('viewClass').hidden = true;
    $('viewForm').hidden = true;
    $('viewThanks').hidden = true;
    $('viewBlank').hidden = false;
    $('phCrumb').textContent = (pathTo(id) || []).map((n) => n.title).join(' › ');
    $('phTitle').textContent = node.title;
    $('phHint').textContent = node.sheet
      ? `对应卡里的「${node.sheet}」工作表 · 这一步还没做，先占位`
      : '这一步还没做，先占位';
  }
  try { localStorage.setItem('quickref.node', id); } catch (e) {}
}

/// 「致谢」那一页。
///
/// 人物卡的作者 / QQ / 反馈群从卡里的「更新」表读 —— 服务端按内容认、不钉格子。
/// 作者改了更新表（或者换了署名），这一页跟着变，不用动代码。
/// 规则数据来源和「这工具是怎么做的」那两段是写死的。
async function renderThanks() {
  const box = $('thanksBody');
  if (!box) return;
  if (!box.dataset.ready) {
    box.innerHTML = '<p class="th-p dim">正在读卡里的作者信息…</p>';
  }
  let c = {};
  try { c = (await api('/api/credits')) || {}; } catch (e) { c = {}; }

  const rows = [];
  if (c.author) rows.push(['作者', `<b>${esc(c.author)}</b>`]);
  if (c.qq) rows.push(['QQ', `<code>${esc(c.qq)}</code>`]);
  if (c.group) rows.push(['反馈兼交流群', `<code>${esc(c.group)}</code>`]);
  if (c.thanks) {
    const body = esc(String(c.thanks).replace(/^特别鸣谢[：:]?\s*/, '')).replace(/\r?\n/g, '<br>');
    rows.push(['其它协助者', body]);
  }

  box.dataset.ready = '1';
  box.innerHTML = `
    <h2 class="th-title">致谢</h2>

    <div class="th-sec">
      <h3>人物卡</h3>
      <p class="th-p">这个工具用的车卡模板出自 <b>${esc(c.author || '似雨悲灵')}</b>
        （《DND 5.5E 人物卡〈悲灵ver.〉》），由作者提供使用、并经同意做过二次修改。</p>
      ${rows.map(([k, v]) => `<div class="th-row"><span class="th-k">${esc(k)}</span>` +
        `<span class="th-v">${v}</span></div>`).join('')}
    </div>

    <div class="th-sec">
      <h3>规则数据</h3>
      <p class="th-p">词条正文（法术 / 职业特性 / 专长 / 种族特性 / 魔法物品）来自
        <a href="https://5echm.kagangtuya.top/" target="_blank" rel="noreferrer">5E 不全书</a>。</p>
    </div>`;
}

// ---------------------------------------------------------------- 事件
$('q').addEventListener('input', (e) => {
  clearTimeout(window._t);
  window._t = setTimeout(() => { state.q = e.target.value.trim(); search(); }, 180);
});
$('btnClear').onclick = () => { state.filters = {}; state.q = ''; $('q').value = ''; renderFilters(); search(); };
// 速查块（魔法物品页）
$('lkQ').addEventListener('input', (e) => {
  clearTimeout(window._lk);
  window._lk = setTimeout(() => { lkState.q = e.target.value.trim(); lkSearch().catch(() => {}); }, 180);
});
$('lkClear').onclick = () => {
  lkState.filters = {};
  lkState.q = '';
  $('lkQ').value = '';
  renderLkFilters();
  lkSearch().catch(() => {});
};
$('btnNewTable').onclick = () => tableOp('new');
$('btnOpenTable').onclick = () => tableOp('open');
$('btnManual').onclick = () => openPicker();

// ---------------------------------------------------------------- 确认框
// 危险操作（比如初始化这张卡）先问一句。不用原生 confirm：桌面版外壳里弹不出来。
let confirmAction = null;
function askConfirm(title, text, onYes) {
  $('confirmTitle').textContent = title;
  $('confirmText').textContent = text;
  confirmAction = onYes;
  $('confirm').hidden = false;
}
function closeConfirm() {
  $('confirm').hidden = true;
  confirmAction = null;
}
$('confirmNo').onclick = closeConfirm;
$('confirmYes').onclick = async () => {
  const fn = confirmAction;
  closeConfirm();
  if (fn) await fn();
};

// ---------------------------------------------------------------- 初始化这张卡
async function doResetCard() {
  // 先清空工作区，再动卡——别让上一张卡留在备选区里的东西掺和进来
  unloadCardState();
  msg('正在初始化…');
  try {
    const r = await post('/api/card/reset', {});
    const lines = [
      '已初始化：字段 ' + (r.fields || 0) + ' 格清空、熟练 ' + (r.skills || 0) + ' 格打 X、' +
        '是否 ' + (r.yesNo || 0) + ' 格打「否」、词条 ' + (r.entries || 0) + ' 格清空',
    ];
    if (r.keptFormula) lines.push('· 公式格 ' + r.keptFormula + ' 个没动');
    if (r.kept && r.kept.length) {
      lines.push('· 有 ' + r.kept.length + ' 格认不出是词条，没动：' + r.kept.slice(0, 5).join('、'));
    }
    if (r.backup) lines.push('· 写入前的备份：' + r.backup);
    // 一次改了一大片格子，所有按卡缓存的东西都要重来
    await afterTableChange(state.table, lines.join('\n'));
  } catch (e) {
    msg('初始化失败：' + e.message, 'err');
  }
}

$('btnResetCard').onclick = () => {
  const t = state.table || {};
  if (!t.exists) {
    msg('还没有目标表格，先新建或选一张', 'err');
    return;
  }
  askConfirm('初始化这张卡',
    '目标：' + (t.name || '') + '\n\n' +
    '会把这张卡清成空卡：\n' +
    '· 所有填过的字段清空：角色名 / 种族 / 职业 / 等级 / 属性值 / 人物形象 / 装备名…\n' +
    '· 所有「熟练」格打 X（卡里的约定：X = 无熟练、O = 有熟练）\n' +
    '· 所有「是 / 否」格打「否」\n' +
    '· 所有词条清空：法术 / 职业特性 / 种族特性 / 专长 / 魔法物品\n' +
    '· 起源表里的工具熟练、语言也清掉\n\n' +
    '备选区会先清空；卡里的公式和结构行（比如职业能力面板那几行）不动。\n' +
    '写入前会自动备份一份。',
    doResetCard);
};

// ---------------------------------------------------------------- 读卡
/// 读卡 = 用「这张卡里现有的内容」**替换**备选区，再让页面把「已在备选区」反映出来。
/// 所以先把上一张卡的东西清出去，读进来的就是干净的这一张卡。
/// 把当前卡里填过的东西读进备选区。**只管往里放**，不动页面、不动提示——
/// 「读卡」按钮和「换卡/导入」都要用它，但两者的提示、重画不一样。
/// 返回 `{fields, entries}` 两个数。注意：跟空白模板一样的默认值（熟练 X、出身
/// 自定义背景…）服务端已经滤掉了，所以新建的空卡读出来就是 0 项。
async function readCardIntoStage() {
  const r = await api('/api/card');
  for (const f of (r.fields || [])) {
    stageState.items.push({
      kind: 'field', formKey: f.formKey, page: f.page,
      field: f.field, label: f.label, section: f.section, row: f.row || '',
      cell: f.cell, value: f.value,
    });
  }
  for (const e of (r.entries || [])) {
    stageState.items.push({
      kind: 'entry', formKey: e.formKey, page: e.page,
      id: e.id, name: e.name, subtitle: e.subtitle || '',
    });
  }
  return { fields: (r.fields || []).length, entries: (r.entries || []).length };
}

/// 页面上的「已在备选区」标记、表单里的值，跟着备选区重画一遍
function refreshStagedMarks() {
  if (!$('viewForm').hidden) renderForm();
  if (!$('viewSpell').hidden) search().catch(() => {});
  if (!$('viewClass').hidden) {
    if (activePage === 'classinfo') renderClassList().catch(() => {});
    else if (activePage === 'classlevel') renderLevelList().catch(() => {});
    else if (activePage === 'background') renderBackgroundList().catch(() => {});
    else cfSearch().catch(() => {});
  }
}

async function doReadCard() {
  unloadCardState();
  msg('正在读卡…');
  try {
    const n = await readCardIntoStage();
    renderStage();
    refreshStagedMarks();
    msg('已读卡：' + n.fields + ' 个字段、' + n.entries + ' 条词条，都放进备选区了', 'ok');
  } catch (e) {
    msg('读卡失败：' + e.message, 'err');
  }
}

$('btnReadCard').onclick = () => {
  const t = state.table || {};
  if (!t.exists) {
    msg('还没有目标表格，先新建或选一张', 'err');
    return;
  }
  if (stageState.items.length) {
    askConfirm('读卡',
      '备选区里现在有 ' + stageState.items.length + ' 项，读卡会把它们换成这张卡里的内容。\n继续？',
      doReadCard);
    return;
  }
  doReadCard();
};

// ---- 职业页 ----
$('cfQ').addEventListener('input', (e) => {
  clearTimeout(window._t2);
  window._t2 = setTimeout(() => { cf.q = e.target.value.trim(); cfSearch(); }, 180);
});
$('cfClear').onclick = () => { cf.filters = {}; cf.q = ''; $('cfQ').value = ''; renderCfFilters(); cfSearch(); };
$('pkClose').onclick = () => { $('picker').hidden = true; };
$('pkUp').onclick = () => browse((pkDir || '').replace(/[\\/][^\\/]*$/, '') || pkDir);
$('pkGo').onclick = () => browse($('pkPath').value.trim());
$('pkPath').addEventListener('keydown', (e) => { if (e.key === 'Enter') browse($('pkPath').value.trim()); });
$('pkRoot').onclick = () => browse('');
$('pkCreate').onclick = createTable;
// 备选区：表单页填的先进这儿，再从这儿一并填表
$('fmSections').addEventListener('input', () => {
  clearTimeout(window._fmt);
  window._fmt = setTimeout(syncStage, 150);
});
$('fmSections').addEventListener('input', (ev) => {
  const f = ev.target && ev.target.dataset ? ev.target.dataset.field : '';
  if (f) refreshDependent(f);
  if (f === 'cls' || f === 'sub' || f === 'background') scheduleRuleCard();
});
$('fmSections').addEventListener('change', (ev) => {
  const f = ev.target && ev.target.dataset ? ev.target.dataset.field : '';
  if (f) refreshDependent(f);
  if (f === 'cls' || f === 'sub' || f === 'background') scheduleRuleCard();
  syncStage();
});
$('stageList').addEventListener('click', (ev) => {
  const btn = ev.target.closest('[data-del]');
  if (!btn) return;
  const row = btn.closest('.trow');
  if (!row) return;
  const key = row.dataset.key;
  // data-del 挂在按钮上，不是挂在行上（行上只有 data-id / data-field）
  const del = btn.dataset.del;
  if (row.dataset.kind === 'effect') {
    stageState.items = stageState.items
      .filter((e) => !(e.kind === 'effect' && e.label === del && e.formKey === key));
    if (activePage === 'background') renderBackgroundList().catch(() => {});
    else if (activePage === 'classinfo') renderClassList().catch(() => {});
  } else if (row.dataset.kind === 'entry') {
    stageState.items = stageState.items.filter((e) => !(e.kind === 'entry' && e.id === del));
    if (activePage === key) cfSearch().catch(() => {});
    else if (activePage === 'classlevel' && key === 'class') renderLevelList().catch(() => {});
  } else if (row.dataset.kind === 'prof') {
    stageState.items = stageState.items.filter((e) => !(e.kind === 'prof' && e.value === del && e.label === key));
  } else {
    stageState.items = stageState.items
      .filter((e) => !(e.kind === 'field' && e.formKey === key && e.field === del));
    if (key === formState.key) {
      const meta = stageFormFields().find((f) => f.field === del);
      const el = stageFormInputs().get(del);
      if (el && meta) el.value = meta.value || '';
    }
  }
  renderStage();
});
$('stageClear').onclick = () => {
  stageState.items = [];
  if (formState.info) renderForm(); // 表单里填着的也一起退回卡里的值
  // 只读页上的「已在备选区」也跟着撤掉
  if (activePage === 'classinfo') renderClassList().catch(() => {});
  else if (activePage === 'classlevel') renderLevelList().catch(() => {});
  else if (activePage === 'background') renderBackgroundList().catch(() => {});
  renderStage();
};
$('stageFill').onclick = fillStage;
// 「备选区」标题行那颗「📋 待办」：打开悬浮窗第二页
$('btnTodo').onclick = (e) => { e.stopPropagation(); openTodoPop($('btnTodo')); };
$('stageReveal').onclick = () => {
  const t = (state.table || {}).path;
  if (t) reveal(t.replace(/[\\/][^\\/]*$/, ''), true);
};
$('picker').addEventListener('click', (e) => { if (e.target === $('picker')) $('picker').hidden = true; });
$('confirm').addEventListener('click', (e) => { if (e.target === $('confirm')) closeConfirm(); });
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('q').focus(); $('q').select(); }
  if (e.key === 'Escape') hidePop(true);
  if (e.key === 'Escape' && !$('picker').hidden) $('picker').hidden = true;
  if (e.key === 'Escape' && !$('confirm').hidden) closeConfirm();
});
// 点到别处就关掉悬浮窗（点列表行自己会重新钉一条）
document.addEventListener('mousedown', (e) => {
  if ($('pop').hidden) return;
  if ($('pop').contains(e.target)) return;
  if (e.target.closest && e.target.closest('.item')) return;
  hidePop();
});

(async function init() {
  applySizes();
  wireResizers();
  await loadMeta();
  await loadTable();
  await search();
  // 设计树：默认停在「法术 → 法术列表」，上次离开的节点会被记住
  let startNode = 'spell.list';
  try {
    let saved = localStorage.getItem('quickref.node') || '';
    if (saved && TREE_ALIASES[saved]) saved = TREE_ALIASES[saved];
    if (saved && findNode(saved)) startNode = saved;
  } catch (e) {}
  const chain = pathTo(startNode) || [];
  for (const n of chain) treeState.open.add(n.id);
  selectNode(startNode);
})();
