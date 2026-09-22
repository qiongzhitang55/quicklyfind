# quicklyFind — D&D 5e 规则数据 · 速查应用 · 实验区

数据来源：**5E 不全书** <https://5echm.kagangtuya.top/>（WinCHM 导出的 webhelp，以 2024 版规则为主干）
人物卡：`米瑞尔.xlsx`（D&D 5E 2024 自动车卡，18 张工作表）

---

## 从哪开始

| 我想… | 去这里 |
|---|---|
| **拷走 / 发给别人单独用** | `法术速查填表-便携版.zip`（18.9 MB，解压后双击 exe，不依赖本机任何环境） |
| **装在自己电脑上** | `法术速查填表-便携版\法术速查填表.exe`（或 `桌面版\法术速查填表.exe`，那个读工作区数据） |
| **自己重打一份 Windows 包** | `packaging\pack_windows.ps1`（重编服务端 + 外壳，组装出 `车卡小工具_windows版\` 和同名 zip） |
| **开桌面版（推荐）** | 双击 `桌面版\法术速查填表.exe`（原生窗口，自己起服务、关窗即停） |
| **打开速查填表工具** | 双击 `实验区\start.bat` → 浏览器打开 <http://127.0.0.1:8765/> |
| 换要填的人物卡 | 界面最右「备选区」底部「新建表格 / 使用已有表格」 |
| 拿规则纯文本喂给别的工具 | `rules-text\`（7017 个 txt + corpus.jsonl） |
| 改词条数据 | `dnd-data\`，格式规范见 `dnd-data\SCHEMA.md` |
| 重新抽一遍数据 | `tools\` 里的脚本，全部可重跑 |

---

## 目录结构

```
D:\quicklyFind\                                    约 240 MB
│
├─ 实验区\                     ★ 启动入口
│  ├─ start.bat                双击启动速查填表工具
│  ├─ quickref.exe             服务端（`dart compile exe` 编出来的，桌面版也用它）
│  ├─ reset-card.ps1/.bat      实验卡重置为原始卡副本
│  ├─ cards\miriel-lab.xlsx    旧实验卡副本
│  ├─ out\                     自检产物与日志
│  └─ 说明.md
│
├─ 桌面版\                     ★ Windows 桌面版（Flutter 壳 + WebView2）
│  ├─ 法术速查填表.exe         双击即用；壳会拉起 quickref.exe 再显示界面
│  ├─ quickref.exe             服务端副本（找不到工作区那份时用它）
│  └─ 说明.txt                 用法 / 怎么重编
│
├─ 法术速查填表-便携版\        ★ 便携版：整个文件夹拷走就能独立运行
│  ├─ 法术速查填表.exe         双击即用
│  ├─ quickref.exe             服务端（AOT 编好，不用装 Dart）
│  ├─ web\ dnd-data\ card\     界面 + 词条库 + 人物卡模板（自带，不读工作区）
│  └─ 说明.txt
├─ 法术速查填表-便携版.zip      上面那份的压缩包（约 18.9 MB，发给别人用这个）
│
├─ 车卡小工具_windows版\       ★ 打包产物：自包含，拷到哪儿都能跑（41.7 MB）
│  ├─ 车卡小道具.exe           双击即用（桌面窗口）
│  ├─ quickref.exe             服务端（每次打包时用工作区源码重编）
│  ├─ web\ dnd-data\ card\     界面 + 词条库 + 空白模板
│  ├─ 开浏览器版.bat           不想开窗口就直接用浏览器看
│  └─ 说明.txt                 给使用者看的
├─ 车卡小工具_windows版.zip    上面那份的压缩包
├─ packaging\                  打包用的东西：pack_windows.ps1 + names.txt + 说明模板
│
├─ desktop_app\                Flutter 桌面壳的源码（windows/ 里是 C++ 那层）
│
├─ dnd_quickref\               ★ 法术速查填表工具（纯 Dart）
│  ├─ bin/quickref.dart        本地服务 + REST API
│  ├─ lib/models|data|staging|util|xlsx/
│  ├─ web/                     界面（法术列表 / 详情 + 最右备选区）
│  ├─ tool/selftest.dart       53 项自检
│  └─ README.md                用法与 API 文档
│
├─ dnd-data\                   词条库（3839 条，SCHEMA.md 定义格式）
│  ├─ spells.json              798   法术
│  ├─ equipment.json           239   装备与物品
│  ├─ feats.json               229   专长
│  ├─ species.json             493   种族特性
│  ├─ class_features.json      2080  职业特性
│  └─ card_rules.json          210   子职 / 出身 → 规则书正文（tools 生成）
│
├─ rules-text\                 纯文本语料（1108 万字）
│  ├─ pages\**.txt             7017 个文件，保留原站目录层级
│  ├─ corpus.jsonl             结构化语料
│  └─ manifest.tsv
│
├─ card\                       人物卡
│  ├─ 悲灵.xlsx                ★ 当前在用的卡（从 Downloads 拷进来的工作副本）
│  ├─ 米瑞尔.xlsx              原始素材，不要当填表目标
│  ├─ 空白卡.xlsx              「新建表格」的模板
│  └─ grids\                   18 张工作表的网格 JSON（解析用）
│
├─ 5echm\                      网站镜像（中间产物，160 MB）
│  ├─ mirror\                  全站 HTML，7777 文件
│  ├─ search\ + 搜索.html      网页版离线全文搜索
│  └─ _crawl\                  抓取记录：manifest / failed / linkcheck / toc.json
│
├─ tools\                      全部脚本（Python + 1 个 Node 测试）
├─ .pub-cache\                 Dart 依赖（沙箱外写不了，所以放工作区内）
├─ _chm_extract\               空目录（你早先建的，未动）
└─ README.md                   本文件
```

---

## 应用

**纯 Dart 实现**：`dart:io` 起本地服务，浏览器当界面，依赖只有 `archive` + `xml`。

> 为什么不用 Flutter：本机沙箱只允许写工作区，而 Flutter 运行时必须写 `C:\flutter\bin\cache` → `flutter --version` 直接挂死（已实测）。Dart SDK 本体完全可用。模型层、仓库层、备用区逻辑、xlsx 写入器与界面无关，将来做 Flutter 桌面版可原样搬。

```powershell
$env:PUB_CACHE='D:\quicklyFind\.pub-cache'   # 必须，默认 pub 缓存在沙箱外
cd D:\quicklyFind\dnd_quickref
dart pub get
dart run bin/quickref.dart                   # 默认用真卡；实验区用 start.bat
```

启动参数：`--port` `--no-open` `--data <词条目录>` `--card <初始表格>` `--template <空白模板>`

界面两栏 + 备选区：**左法术列表 → 中法术详情，最右一栏是备选区**。备选区底部可以「新建表格 / 使用已有表格」
（走系统原生打开/另存为对话框），点「填入表格」就把备选区里的法术写进那张表，
卡里已有的同名法术自动跳过。

载入法术 / 职业特性 / 专长 / 种族特性四类词条。**车卡时的下拉选项不用这些数据**——
职业、子职、种族、亚种、武器一律读人物卡自己的表（卡里没开的扩展，卡里那格就是空），
词条库只在卡里查不到时才兜底。装备类的 `equipment.json` 仍未载入。

界面最右那一栏是**备选区**（跟设计树同级，哪一页都在）：表单页里填的字段先进备选区，
攒齐了从备选区一次写进表。

---

## 数据可靠性

| 项 | 结论 |
|---|---|
| 网站镜像完整性 | 目录 6085 条目仅 1 条缺失，且该页在源站本身就是 404；8.4 万条相对链接中 401 条无法解析，全部源于源站自身断链 |
| 纯文本质量 | 7017 文件，HTML 残留 0、乱码 0 |
| 人物卡 | 全程只读，SHA256 始终为 `B542F20C…` |
| xlsx 回写 | 外科式改 XML：zip 条目数不变、仅目标单元格差异（实测 4 段法术位共 200 格）、图片/公式/数据验证/条件格式字节级保留，写入前自动备份 |
| 词条提取 | 装备/专长/种族/职业四类由子代理提取，均带可重跑脚本与独立 QA 脚本 |

**已知问题**（详见 `dnd_quickref\README.md`）：职业子职的 `source` 不可靠；圣武士有 1 组子职标签左移；装备/专长/种族的 `en`、`source` 多为空（卡里本就没有这两列）。

---

## tools 脚本

| 脚本 | 作用 |
|---|---|
| `crawl_5echm.py` | 全站镜像爬虫（10 线程、断点续传、链接发现） |
| `extract_text.py` | 镜像 → 纯文本语料（17 秒） |
| `qa_text.py` | 文本库质检（HTML 残留 / 乱码 / 空页 / 重复） |
| `check_links.py` | 镜像内 8.4 万条相对链接完整性校验 |
| `verify_mirror.py` | 镜像完整性 + 搜索索引覆盖率 |
| `build_search.py` | 网页搜索索引分片 |
| `test_search_ui.js` | 网页搜索端到端测试（无需浏览器） |
| `card_parse.py` | 人物卡 xlsx → 网格 JSON / 法术词条 |
| `normalize_spells.py` | 法术词条规范到 SCHEMA 格式 |
| `extract_equipment.py` / `extract_feats.py` / `extract_species_class.py` | 装备 / 专长 / 种族与职业特性提取 |
| `link_card_rules.py` | 把卡里的主职业 / 子职 / 出身对到规则库条目上（生成 `dnd-data\card_rules.json`） |
| `extract_magic_items.py` | 规则书里的魔法物品 → `dnd-data\magic_items.json`（307 条，给「魔法物品」页的速查用） |
| `xlsx_patch.py` | 外科式 xlsx 写入的**参考实现 + 独立验证器**（Dart 版的对照物） |

---

## 下一步

- [ ] 填入区持久化（现在关掉服务就清空）
- [ ] 7 条法术的名称与 v1.0.12 卡不一致（对方改过译名），需要时做一张译名对照表
- [ ] 若以后要回到装备/专长，把 `repository.dart` 的 `dataFiles` 加回去即可
- [ ] 可选：上 Flutter 桌面版（需授权越界写 `C:\flutter`，并先确认 Visual Studio C++ 工具链）
