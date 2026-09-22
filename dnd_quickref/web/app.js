'use strict';
// 法术速查填表：左（列表）→ 中（详情）→ 抓进最右的备选区 → 从那儿选表 → 一键填入

// 前端期望的服务端接口版本：对不上说明服务没重启（比如还开着旧窗口）
const API_VERSION = 5;

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
    const attrCells = ['I13', 'I14', 'I15', 'I16', 'I17', 'I18'];
    const filled = attrCells.filter((c) => {
      const v = a.get('@' + c) || '';
      return v && v !== '10';
    }).length;
    add('六项属性', `${filled}/6 有值`, filled === attrCells.length);

    // 技能熟练：卡里打 O 的条数；职业正文里写着「选择 N 项」就一起报
    const skills = ['B41', 'B43', 'B44', 'B45', 'B47', 'B48', 'B49', 'B50', 'B51', 'B53',
      'B54', 'B55', 'B56', 'B57', 'B59', 'B60', 'B61', 'B62']
      .filter((c) => (a.get('@' + c) || '').toUpperCase() === 'O').length;
    let need = 0;
    if (b.get('cls')) {
      try {
        const r = await api('/api/rule?kind=class&name=' + encodeURIComponent(b.get('cls')));
        if (r.found) {
          const t = (parseClassTraits(r.text) || []).find((x) => x.label === '技能熟练');
          const menu = t ? classMenu(t.text) : null;
          need = menu ? menu.pick : 0;
        }
      } catch (e) {}
    }
    add('技能熟练', need ? `${skills}/${need}` : `${skills} 项`, need ? skills >= need : skills > 0);
    add('豁免熟练', b.get('cls') ? '看职业' : '未定', !!b.get('cls'));

    // 专长：卡里已经写了几个，按等级还差几个
    const got = (feat.existing || []).length;
    const want = featsByLevel(lv);
    const left = Math.max(0, want - got);
    add('专长', left ? `还能选 ${left} 个` : `${got} 个`, !left && got > 0);

    const freeSlots = Math.max(0, (table.slotsTotal || 0) - (table.used || 0));
    add('法术位', freeSlots ? `空 ${freeSlots} 格` : '已满', true);
    renderProgress(rows);
  } catch (e) {
    renderProgress([]);
  }
}

function renderProgress(rows) {
  const box = $('stat');
  box.innerHTML = rows.map((r) => {
    const go = PG_TARGET[r.label] || '';
    const cls = 'pg ' + (r.ok ? 'ok' : 'todo');
    return `<span class="${cls}"${go ? ` data-goto="${esc(go)}"` : ''} title="${esc(r.hint || '')}">${esc(r.label)}<b>${esc(r.value)}</b></span>`;
  }).join('');
  [...box.querySelectorAll('.pg[data-goto]')].forEach((el) => {
    el.onclick = () => selectNode(el.dataset.goto);
  });
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

async function openEntry(brief, el) {
  const r = await api('/api/entry?id=' + encodeURIComponent(brief.id));
  state.current = r.entry;
  [...document.querySelectorAll('.item.on')].forEach((x) => x.classList.remove('on'));
  if (el) el.classList.add('on');
  const e = r.entry;
  const fields = Object.entries(e.fields || {});
  const tags = [];
  const lv = e.fields && e.fields['环阶'];
  if (lv != null && lv !== '') tags.push(lv === '0' ? '戏法' : lv + '环');
  for (const k of ['学派', '来源']) if (e.fields && e.fields[k]) tags.push(e.fields[k]);
  if (e.fields && e.fields['专注'] === '是') tags.push('专注');
  if (e.fields && e.fields['仪式'] === '是') tags.push('仪式');
  $('detail').innerHTML = `
    <h2>${esc(e.name)}</h2>
    <div class="en">${esc(e.en)}</div>
    <div class="tagline">${tags.map((t, i) => `<span class="tag${i === 0 ? ' hot' : ''}">${esc(t)}</span>`).join('')}</div>
    <div class="add"><button class="primary" id="btnAdd" ${stageHasEntry(e.id) ? 'disabled' : ''}>${stageHasEntry(e.id) ? '已在备选区' : '+ 抓进备选区'}</button></div>
    ${fields.length ? `<table>${fields.map(([k, v]) => `<tr><td class="k">${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>` : ''}
    <pre>${esc(e.text)}</pre>`;
  const btn = $('btnAdd');
  if (btn && !stageHasEntry(e.id)) btn.onclick = () => addStageEntry('spell', { id: e.id, name: e.name, subtitle: e.en || '' }, '法术', () => search());
}

// ---------------------------------------------------------------- 目标表格
// 页内填入区已经取消：抓到的法术 / 职业特性 / 种族特性统一进最右边的备选区，
// 表格也从那儿新建、切换、写入。这几个函数只留最薄的一层。

async function loadTable(refresh) {
  state.table = await api('/api/table' + (refresh ? '?refresh=1' : ''));
  renderStage();
  loadProgress().catch(() => {});
}

async function tableOp(kind) {
  const t = state.table || {};
  const dir = (t.path || '').replace(/[\\/][^\\/]*$/, '');
  const say = (text, cls) => msg(text, cls);
  say(kind === 'new' ? '正在打开「另存为」对话框…' : '正在打开「打开文件」对话框…');
  try {
    const r = await post(kind === 'new' ? '/api/table/new' : '/api/table/open', { dir, name: kind === 'new' ? '新人物卡.xlsx' : t.name });
    if (r.cancelled) { say('已取消'); return; }
    state.table = r.table;
    renderStage();
    say(kind === 'new' ? '已新建表格' : '已切换目标表格', 'ok');
    for (const k of Object.keys(pageStates)) pageStates[k].info = null;
    if (!$('viewClass').hidden) loadPageInfo().catch(() => {});
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
      $('pkList').innerHTML = '<div class="empty">目录不存在</div>';
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
    state.table = r.table;
    renderStage();
    $('picker').hidden = true;
    msg('已切换目标表格：' + r.table.name, 'ok');
    for (const k of Object.keys(pageStates)) pageStates[k].info = null;
    if (!$('viewClass').hidden) loadPageInfo().catch(() => {});
  } catch (e) {
    $('pkMsg').textContent = e.message;
  }
}

async function createTable() {
  const name = $('pkName').value.trim() || '新人物卡.xlsx';
  try {
    const r = await post('/api/table/create', { dir: pkDir, name });
    state.table = r.table;
    renderStage();
    $('picker').hidden = true;
    msg('已新建表格：' + r.table.name, 'ok');
    for (const k of Object.keys(pageStates)) pageStates[k].info = null;
    if (!$('viewClass').hidden) loadPageInfo().catch(() => {});
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
  const ph = $('cfDetail').querySelector('.empty');
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
  list.innerHTML = effects.map((e, i) => `
    <div class="item" data-i="${i}">
      <div class="t">${esc(e.label)}</div>
      ${effectStaged(e) ? '<span class="intray">已在备选区</span>' : '<button class="add" title="抓进备选区">+</button>'}
      <div class="s">${esc(e.text)}</div>
    </div>`).join('') || '<div class="empty">这条出身没有分条的效果。</div>';

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
        addStageEffect(effects[+el.dataset.i]);
        return;
      }
      show(+el.dataset.i);
    };
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
  return out;
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
  return { pick: +m[2], names };
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
    if (menu && menu.names.length > menu.pick) return 'menu';
    if (isMenuLine(e.text)) return 'panel';       // 「任选3项」这种没列候选的，整条进面板
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
  showClassItem('0');
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
  const menu = kind === 'menu' ? classMenu(e.text) : null;
  const picker = menu
    ? `<div class="cf-pick">${menu.names.map((n) => `
        <label class="chk"><input type="checkbox" data-skill="${esc(n)}" ${effectStaged({ label: '技能熟练', text: n }, 'class') ? 'checked' : ''}>
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
      const eff = { label: '技能熟练', text: el.dataset.skill };
      if (el.checked) addStageEffect(eff, 'class', '职业', false);
      else { dropStageEffect(eff, 'class'); renderClassList().catch(() => {}); }
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
    el.onclick = (ev) => {
      const f = mine[+el.dataset.i];
      if (ev.target.classList.contains('add')) {
        ev.stopPropagation();
        addStageFeature(f);
        return;
      }
      showLevelFeat(f, el);
    };
  });
  if (mine.length) showLevelFeat(mine[0], list.querySelector('.item'));
}

const levelFeatId = (f) => `lv:${f.level}:${f.name}`;

/// 等级页的详情栏（正文来自哪本、目录怎么走，一并标出来）
function showLevelFeat(f, el) {
  [...$('cfList').querySelectorAll('.item')].forEach((x) => x.classList.toggle('on', x === el));
  const r = f.rule || {};
  $('cfDetail').innerHTML = `
    <div class="detail-head">${esc(f.name)}<span class="en">${f.level}级 · ${esc(f.from)}</span></div>
    <div class="detail-text">${esc(f.text)}</div>
    <div class="rule-meta">${esc(r.book || '')}${(r.crumbs || []).length ? ' · ' + esc(r.crumbs.join(' › ')) : ''}</div>`;
}

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
  });
  renderStage();
  msgCf('已加入备选区', 'ok');
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
        return;
      }
      cfOpenEntry(brief, el);
    };
  });
}

async function cfOpenEntry(brief, el) {
  const r = await api('/api/entry?kind=' + encodeURIComponent(activePage) + '&id=' + encodeURIComponent(brief.id));
  cf.current = r.entry;
  [...document.querySelectorAll('#cfList .item.on')].forEach((x) => x.classList.remove('on'));
  if (el) el.classList.add('on');
  const e = r.entry;
  const f = e.fields || {};
  const tags = [];
  if (f['职业']) tags.push(f['职业']);
  if (f['子职']) tags.push(f['子职']);
  if (f['等级']) tags.push(f['等级'] + '级');
  if (e.source) tags.push(e.source);
  $('cfDetail').innerHTML = `
    <h2>${esc(e.name)}</h2>
    <div class="en">${esc(e.en)}</div>
    <div class="tagline">${tags.map((t, i) => `<span class="tag${i === 0 ? ' hot' : ''}">${esc(t)}</span>`).join('')}</div>
    <div class="add"><button class="primary" id="cfAdd" ${stageHasEntry(e.id) ? 'disabled' : ''}>${stageHasEntry(e.id) ? '已在备选区' : '+ 抓进备选区'}</button></div>
    <pre>${esc(e.text)}</pre>`;
  const btn = $('cfAdd');
  if (btn && !stageHasEntry(e.id)) btn.onclick = () => cfAddToTray(e.id);
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
const formState = { key: 'basic', info: null, loaded: false };

async function loadForm(refresh) {
  formState.info = await api(
    '/api/form?key=' + encodeURIComponent(formState.key) + (refresh ? '&refresh=1' : ''));
  renderForm();
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
  $('lkList').innerHTML = r.items.map((e, i) => `
    <div class="item" data-i="${i}">
      <div class="t">${esc(e.name)}<span class="en">${esc(e.en)}</span></div>
      ${stageHasEntry(e.id) ? '<span class="intray">已在备选区</span>'
                            : '<button class="add" title="抓进备选区">+</button>'}
      <div class="s">${esc(e.subtitle)}</div>
    </div>`).join('') || '<div class="empty">没有匹配的魔法物品</div>';
  [...$('lkList').querySelectorAll('.item')].forEach((el) => {
    const brief = lkState.items[+el.dataset.i];
    el.onclick = async (ev) => {
      if (ev.target.classList.contains('add')) {
        ev.stopPropagation();
        addStageEntry('magic', { id: brief.id, name: brief.name, subtitle: brief.subtitle || '' },
          '魔法物品', () => lkSearch());
        return;
      }
      const old = el.querySelector('pre');
      if (old) { old.remove(); return; }
      el.insertAdjacentHTML('beforeend', '<pre>正在读规则书…</pre>');
      try {
        const d = await api('/api/entry?kind=magic&id=' + encodeURIComponent(brief.id));
        el.querySelector('pre').textContent = (d.entry && d.entry.text) || '';
      } catch (e) {
        el.querySelector('pre').textContent = '读不出来：' + e.message;
      }
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
        field: f.field, label: f.label, section: f.section, cell: f.cell, value: v,
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
  return `<div class="trow" data-kind="field" data-key="${esc(e.formKey)}" data-field="${esc(e.field)}">
      <div class="n"><b>${esc(e.label)}</b><small>${esc(e.section)} · ${esc(e.cell)} → ${esc(e.value)}</small></div>
      <button class="link danger" data-del="${esc(e.field)}" title="从备选区移除">×</button>
    </div>`;
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
  if (!n) {
    $('stageList').innerHTML = '<div class="empty">表单填的字段、词条页抓的词条都会进到这里，攒齐了一次性写进表。</div>';
    return;
  }
  const pages = [...new Set(stageState.items.map((e) => e.page))];
  $('stageList').innerHTML = pages.length > 1
    ? pages.map((p) => `<div class="stage-group">${esc(p)}</div>` +
        stageState.items.filter((e) => e.page === p).map(stageRowHtml).join('')).join('')
    : stageState.items.map(stageRowHtml).join('');
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
      (r.unmapped || []).forEach((u) => lines.push('· 没写的：' + u));
      if (r.backup) backup = r.backup;
    }
    stageState.items = [];
    renderForm();
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
  return [''].concat(options).map((o) => {
    const label = o === '' ? (emptyLabel || '—') : o;
    const tip = o === '' ? ' title="留空 = 这一格不动"' : '';
    return `<div class="combo-opt${o === value ? ' on' : ''}" data-v="${esc(o)}"${tip}>${esc(label)}</div>`;
  }).join('');
}

/// editable=true 时输入框可以自己打字（原来挂 datalist 的那批字段）
function comboHtml({ field, value = '', options = [], editable = false, type = 'text', emptyLabel = '', id = '', title = '', narrow = false }) {
  return `<span class="combo${narrow ? ' narrow' : ''}"${title ? ` title="${esc(title)}"` : ''}>
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
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
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
document.addEventListener('scroll', () => comboClose(comboOpen), true);

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
    return `<input data-field="${esc(f.field)}" value="${esc(f.value)}" ${t}
      ${f.kind === 'number' ? 'type="number"' : 'type="text"'} spellcheck="false">`;
  }
  const id = 'fm_' + f.field;
  const cls = 'ffield' + (f.cell ? '' : ' miss');
  const hint = `<i class="fcell">${esc(f.cell || '未识别')}</i>`;
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

/// 要不要渲染成下拉框：选项不多就走 <select>；跟别的字段联动的（子职业 / 亚种）
/// 也走 <select>，这样父字段一改就能就地换掉整份选项。
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
  { id: 'feat', title: '专长', sheet: '主要', view: 'page', page: 'feat', children: [
    { id: 'feat.pick', title: '专长 / 属性提升', sheet: '主要', view: 'page', page: 'feat', done: true },
  ] },
  { id: 'gear', title: '装备与背包', sheet: '背包', view: 'form', form: 'gear', children: [
    { id: 'gear.weapon', title: '武器 / 护甲 / 盾', sheet: '主要', view: 'form', form: 'gear', done: true },
    { id: 'gear.item', title: '物品 / 货币' },
    { id: 'gear.load', title: '负重', sheet: '主要', view: 'form', form: 'gear', done: true },
  ] },
  // 魔法物品区在「主要」表：武器行30-36(F31 同调) / 护甲盾行38-40 / 奇物行41 /
  // 右侧 AM38「已同调的装备」汇总。空白卡是老版本，这一块的位置不一样。
  // 「魔法物品」下面那四条（武器 / 护甲 / 盾 / 奇物 / 已同调）去掉了：
  // 它们本来就是这个页面的几块，点这一条就是整块（上面速查 + 下面编辑格）
  { id: 'magic', title: '魔法物品', sheet: '主要', view: 'form', form: 'magic', done: true },
  { id: 'spell', title: '法术', sheet: '法术书', view: 'spell', children: [
    { id: 'spell.list', title: '法术列表', view: 'spell', done: true },
  ] },
  // 最末尾：全部速查——法术 / 职业特性 / 专长 / 种族 / 魔法物品一起搜。
  // 抓进备选区的每一条记着自己属于哪一类，写表时各走各的页。
  { id: 'all', title: '全部速查', view: 'page', page: 'all', done: true },
  // 「伙伴与据点」「其他」两条删了——里面那几张表还没做页面，先不占设计树的位置
];

const treeState = { selected: 'spell.list', open: new Set(['spell']) };

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
  } else if (node.view === 'form') {
    $('viewSpell').hidden = true;
    $('viewClass').hidden = true;
    $('viewBlank').hidden = true;
    $('viewForm').hidden = false;
    formState.key = node.form || 'basic';
    if (!formState.loaded) { formState.loaded = true; loadForm().catch(() => {}); }
    else loadForm(true).catch(() => {});
  } else if (node.view === 'page') {
    $('viewSpell').hidden = true;
    $('viewClass').hidden = false;
    $('viewForm').hidden = true;
    $('viewBlank').hidden = true;
    initPageState(node.page || 'class');
    // 每个页面首次进来才去读卡（省启动时间）
    if (!cf.loaded) {
      cf.loaded = true;
      loadPageInfo().then(() => cfSearch()).catch(() => {});
    } else {
      renderCfTarget();
      renderCfFilters();
      cfSearch().catch(() => {});
    }
  } else {
    $('viewSpell').hidden = true;
    $('viewClass').hidden = true;
    $('viewForm').hidden = true;
    $('viewBlank').hidden = false;
    $('phCrumb').textContent = (pathTo(id) || []).map((n) => n.title).join(' › ');
    $('phTitle').textContent = node.title;
    $('phHint').textContent = node.sheet
      ? `对应卡里的「${node.sheet}」工作表 · 这一步还没做，先占位`
      : '这一步还没做，先占位';
  }
  try { localStorage.setItem('quickref.node', id); } catch (e) {}
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
  const key = row.dataset.key;
  const del = row.dataset.del;
  if (row.dataset.kind === 'effect') {
    stageState.items = stageState.items
      .filter((e) => !(e.kind === 'effect' && e.label === del && e.formKey === key));
    if (activePage === 'background') renderBackgroundList().catch(() => {});
    else if (activePage === 'classinfo') renderClassList().catch(() => {});
  } else if (row.dataset.kind === 'entry') {
    stageState.items = stageState.items.filter((e) => !(e.kind === 'entry' && e.id === del));
    if (activePage === key) cfSearch().catch(() => {});
    else if (activePage === 'classlevel' && key === 'class') renderLevelList().catch(() => {});
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
$('stageReveal').onclick = () => {
  const t = (state.table || {}).path;
  if (t) reveal(t.replace(/[\\/][^\\/]*$/, ''), true);
};
$('picker').addEventListener('click', (e) => { if (e.target === $('picker')) $('picker').hidden = true; });
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('q').focus(); $('q').select(); }
  if (e.key === 'Escape' && !$('picker').hidden) $('picker').hidden = true;
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
    const saved = localStorage.getItem('quickref.node');
    if (saved && findNode(saved)) startNode = saved;
  } catch (e) {}
  const chain = pathTo(startNode) || [];
  for (const n of chain) treeState.open.add(n.id);
  selectNode(startNode);
})();
