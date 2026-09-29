# card\grids —— 词条抽取的基线（别随手重导）

这里的 `<工作表名>.json` 是从一张人物卡导出来的格子快照：`{sheet, rows, cols, cells}`，
`cells` 的键是 `"行,列"`（都从 1 起数，列 1 = A）。导出工具是 `tools/card_parse.py dump`。

**词条库 `dnd-data\` 就是照这份基线复现出来的。**

| 脚本 | 读哪几份 |
|---|---|
| `tools/extract_equipment.py` | `装备.json`（另外只读打开 `card\米瑞尔.xlsx` 补公式里丢掉的名称） |
| `tools/extract_feats.py` | `专长与据点.json` |
| `tools/extract_species_class.py` | `种族.json`、`职业.json`（`主要.json` 只做交叉核对） |
| `tools/extract_magic_items.py` | 规则语料 `rules-text\` |
| `tools/card_parse.py spells` | `法术大全.json` |

## 基线是哪张卡

当前这套网格来自 **`card\米瑞尔.xlsx`（老版式）**，出处和 sha256 记在 `_source.json` 里。
米瑞尔那张卡有几张新版式没有的表（`Irene`、`背景数据`、`骰娘导入`），
新版式则有它没有的（`起源`、`魔宠`、`导入`）；同一张表里的可用区间也不一样
（例如「主要」老卡 83 行 × 85 列，新卡 91 行 × 92 列）。

所以**不能**拿新版式的卡重导一遍就当基线用——`extract_*.py` 是按固定的列区间
切块解析的，换张卡格子对不上，出来的 `dnd-data` 会和现在这份不一样。
`card_parse.py dump` 因此会在换卡时直接拒绝（要换得显式 `--force`，
或者 `--out` 导到另一个目录去对比）。

想把基线整体升级到新版式卡，是一次单独的活：重导 → 逐个脚本重跑 → 和现在的
`dnd-data\` 逐条对比 → 确认差异都是想要的 → 一起提交。

## 刷新（同一张卡）

```powershell
python tools\card_parse.py dump            # 默认就是米瑞尔.xlsx，重跑无害
python tools\card_parse.py dump --out tmp  # 导到别处看
```
