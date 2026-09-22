/// 自检：`dart run tool/selftest.dart`（不需要测试框架）
///
/// 覆盖：法术载入 / 检索 / 填入区查重 / 法术位识别 / xlsx 外科式写入与回读。
library;

import 'dart:convert';
import 'dart:io';

import 'package:archive/archive.dart';
import 'package:dnd_quickref/data/card_lists.dart';
import 'package:dnd_quickref/data/repository.dart';
import 'package:dnd_quickref/models/entry.dart';
import 'package:dnd_quickref/staging/tray.dart';
import 'package:dnd_quickref/xlsx/patcher.dart';
import 'package:path/path.dart' as p;

late final String workspace = p.dirname(p.dirname(p.dirname(Platform.script.toFilePath())));
late final String dataDir = p.join(workspace, 'dnd-data');
late final String cardPath = p.join(workspace, 'card', '悲灵.xlsx');
late final String templatePath = p.join(workspace, 'card', '空白卡.xlsx');
late final String outPath = p.join(workspace, '实验区', 'out', '_selftest_filled.xlsx');

int failures = 0;
int checks = 0;

void check(String name, bool ok, [String detail = '']) {
  checks++;
  if (!ok) failures++;
  stdout.writeln('${ok ? "PASS" : "FAIL"}  $name${detail.isEmpty ? "" : "  :: $detail"}');
}

bool _sameBytes(List<int> a, List<int> b) {
  if (a.length != b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if (a[i] != b[i]) return false;
  }
  return true;
}

Map<String, List<int>> _entries(List<int> bytes) {
  final out = <String, List<int>>{};
  for (final f in ZipDecoder().decodeBytes(bytes)) {
    final c = f.content;
    out[f.name] = c is List<int> ? c : utf8.encode(c as String);
  }
  return out;
}

Future<void> main() async {
  // ---------------------------------------------------------------- 法术库
  final repo = await Repository.load(dataDir);
  final counts = repo.typeCounts();
  stdout.writeln('载入词条: ${repo.entries.length} 条  $counts\n');
  check('载入五类词条', counts.length == 5, counts.keys.join('、'));
  check('魔法物品词条 > 250', (counts['magicItem'] ?? 0) > 250, '${counts['magicItem']}');
  check('法术词条数 > 700', (counts['spell'] ?? 0) > 700, '${counts['spell']}');
  check('id 全局唯一', repo.byId.length == repo.entries.length);

  // ---------------------------------------------------------------- 检索
  final fireball = repo.search(type: 'spell', q: '火球术');
  check('搜「火球术」第一条就是火球术', fireball.items.isNotEmpty && fireball.items.first.name == '火球术',
      fireball.items.isEmpty ? '' : fireball.items.first.name);
  final lv3 = repo.search(type: 'spell', filters: {'环阶': '3'});
  check('筛「3环」全部是 3 环', lv3.items.isNotEmpty && lv3.items.every((e) => e.fields['环阶'] == '3'), '${lv3.total} 条');
  final wizard = repo.search(type: 'spell', filters: {'职业': '法师'});
  check('筛「法师」法术全部含法师',
      wizard.items.isNotEmpty && wizard.items.every((e) => e.fields['职业']?.contains('法师') ?? false), '${wizard.total} 条');
  check('职业筛选面生成', repo.facet('spell', '职业').length >= 8);

  // ---------------------------------------------------------------- 填入区
  final tray = Tray();
  final e1 = repo.byId['spell:火球术']!;
  final e3 = repo.search(type: 'spell', q: '闪电').items.first;
  check('加入填入区', tray.add(e1) == AddResult.added);
  check('重复加入被识别', tray.add(e1) == AddResult.duplicateInTray);
  tray.add(e3);
  tray.add(Entry(id: 'spell:火球术#副本', type: 'spell', name: '火球术 ', en: 'Fireball'));
  check('按归一化名称查重', tray.findDuplicateGroups().isNotEmpty && tray.length == 3);

  // ---------------------------------------------------------------- 认法术位
  final cardBytes = File(cardPath).readAsBytesSync();
  final patcher = XlsxPatcher.open(cardBytes);
  check('能打开人物卡', patcher.sheetNames.contains('法术书') && patcher.sheetNames.contains('法术大全'),
      '${patcher.sheetNames.length} 张表');

  final blocks = patcher.spellBlocks();
  stdout.writeln('     认出法术位: ${blocks.map((b) => b.range).join("、")}');
  check('认出 4 段法术位', blocks.length == 4, blocks.map((b) => b.range).join('、'));
  check('法术位 = X/AC/AH/AM 第3-52行',
      blocks.map((b) => '${b.column}${b.startRow}-${b.endRow}').join(',') == 'X3-52,AC3-52,AH3-52,AM3-52',
      blocks.map((b) => b.range).join('、'));
  check('法术位共 200 格', blocks.fold<int>(0, (a, b) => a + b.slots) == 200);

  final dict = patcher.spellDictionary();
  check('卡内法术大全 > 800 条', dict.length > 800, '${dict.length}');
  check('卡内已有法术被读到', patcher.columnValues('法术书', 'X', 3, 52).isEmpty, '本卡 X 列当前为空');

  // 卡里 Y3 是公式，紧挨 X3：这是最容易写坏的地方
  check('X3 的右邻 Y3 是公式（写入不能碰它）',
      RegExp(r'<c r="Y3"[^>]*>.*?<f>数据表!D2</f>', dotAll: true).hasMatch(patcher.sheetXml('法术书')));

  // ---------------------------------------------------------------- 填入
  final outcome = XlsxPatcher.open(cardBytes).fillSpells(
    names: ['火球术', '闪电束', '火球术', '护盾术'],
    blocks: blocks,
    dictionary: dict,
  );
  stdout.writeln('     填入结果: 写入 ${outcome.written.map((w) => "${w.cell}=${w.name}").join("、")}'
      '；跳过 ${outcome.skipped}；卡内没有 ${outcome.notInCard.length}');
  check('写入 3 条', outcome.written.length == 3, outcome.written.map((w) => w.cell).join(','));
  check('写到了 X3 / X4 / X5', outcome.written.map((w) => w.cell).join(',') == 'X3,X4,X5');
  check('批内重复被跳过', outcome.duplicateInBatch.length == 1 && outcome.duplicateInBatch.first == '火球术');
  check('没有溢出', outcome.overflow.isEmpty);

  Directory(p.dirname(outPath)).createSync(recursive: true);
  File(outPath).writeAsBytesSync(outcome.bytes);

  final after = XlsxPatcher.open(outcome.bytes);
  final writtenBack = after.columnValues('法术书', 'X', 3, 52);
  check('回读 X3 / X4 / X5', writtenBack[3] == '火球术' && writtenBack[4] == '闪电束' && writtenBack[5] == '护盾术',
      writtenBack.toString());
  check('X3 的右邻 Y3 公式还在',
      RegExp(r'<c r="Y3"[^>]*>.*?<f>数据表!D2</f>', dotAll: true).hasMatch(after.sheetXml('法术书')));

  final before = _entries(cardBytes);
  final now = _entries(outcome.bytes);
  check('zip 条目数不变', before.length == now.length, '${before.length} -> ${now.length}');
  final changed = now.keys.where((k) => !_sameBytes(before[k]!, now[k]!)).toList();
  check('只有「法术书」的 xml 变了', changed.length == 1 && changed.first == 'xl/worksheets/sheet13.xml', changed.join('、'));
  check('图片等其它条目字节级不变', now.keys.where((k) => k.contains('media/')).every((k) => _sameBytes(before[k]!, now[k]!)),
      now.keys.where((k) => k.contains('media/')).join('、'));
  check('原卡文件没被改', _sameBytes(cardBytes, File(cardPath).readAsBytesSync()));

  // 二次填入：全部应被当成「卡里已有」
  final again = XlsxPatcher.open(outcome.bytes).fillSpells(
    names: ['火球术', '闪电束', 'new 不存在的法术'],
    blocks: blocks,
    dictionary: dict,
  );
  check('再填同样的法术 → 全部跳过', again.written.length == 1 && again.alreadyInTable.length == 2,
      '写入 ${again.written.length} / 跳过 ${again.alreadyInTable.length}');
  check('卡内没有的法术被标出来', again.notInCard.length == 1, again.notInCard.join('、'));
  check('新法术继续往后排到 X6', again.written.length == 1 && again.written.first.cell == 'X6',
      again.written.map((w) => w.cell).join(','));

  // ---------------------------------------------------------------- 模板
  final tpl = XlsxPatcher.open(File(templatePath).readAsBytesSync());
  final tplBlocks = tpl.spellBlocks();
  check('空白模板也能认出法术位', tplBlocks.length == 4, tplBlocks.map((b) => b.range).join('、'));

  // ---------------------------------------------------------------- 职业页
  // 职业页要写的东西全在「主要」表，靠卡内公式认位置（换卡版本也不用改代码）
  final clsPatcher = XlsxPatcher.open(cardBytes);
  final sel = clsPatcher.linkedSelectors(sheet: '职业', sourceSheet: '主要');
  stdout.writeln('     职业选择格: ${sel.map((c) => "${c.column}${c.row}").join("、")}');
  check('认出主职业 / 子职业 / 等级 三个选择格',
      sel.length == 3 && sel.map((c) => '${c.column}${c.row}').join(',') == 'E6,I6,O6',
      sel.map((c) => '${c.column}${c.row}').join(','));
  check('选择格里读得出当前职业 / 等级',
      clsPatcher.cellText('主要', 'E6').isEmpty && clsPatcher.cellText('主要', 'O6') == '1',
      '主职业=${clsPatcher.cellText('主要', 'E6')} 等级=${clsPatcher.cellText('主要', 'O6')}');

  final clsBlocks = clsPatcher.linkedBlocks(sheet: '职业', sourceSheet: '主要', minRun: 3)
    ..sort((a, b) => b.slots.compareTo(a.slots));
  stdout.writeln('     主要表里的名称输入列: ${clsBlocks.map((b) => b.range).join("、")}');
  check('认出职业特性输入列（取最长的一段）', clsBlocks.isNotEmpty && clsBlocks.first.column == 'AX',
      clsBlocks.map((b) => b.range).join('、'));

  final clsExisting = clsBlocks.isEmpty
      ? <String>[]
      : clsPatcher
          .columnValues('主要', clsBlocks.first.column, clsBlocks.first.startRow, clsBlocks.first.endRow)
          .values
          .toList();
  check('槽位里前几格是职业基础六项', clsExisting.take(6).join('、') == '豁免熟练、技能熟练、武器熟练、工具熟练、护甲受训、起始装备',
      clsExisting.take(6).join('、'));

  // 填 3 条职业特性 + 主职业 / 等级（写到主要表里）
  final cfBytes = File(outPath).parent.path;
  final clsOut = p.join(cfBytes, '_selftest_class.xlsx');
  final cfOutcome = XlsxPatcher.open(cardBytes).fillSpells(
    names: ['施法', '戏法', '法术位'],
    sheet: '主要',
    blocks: clsBlocks,
  );
  var cfBytes2 = cfOutcome.bytes;
  cfBytes2 = XlsxPatcher.open(cfBytes2).writeCells('主要', {'E6': '法师', 'O6': '5'});
  File(clsOut).writeAsBytesSync(cfBytes2);
  stdout.writeln('     职业填入: ${cfOutcome.written.map((w) => "${w.cell}=${w.name}").join("、")} -> $clsOut');
  check('职业特性写进主要表的空槽（前 6 格被占，从第 7 格开始）',
      cfOutcome.written.length == 3 &&
          cfOutcome.written[0].cell == 'AX17' &&
          cfOutcome.written[2].cell == 'AX19',
      cfOutcome.written.map((w) => w.cell).join(','));

  final cfBack = XlsxPatcher.open(cfBytes2);
  check('回读职业选择格', cfBack.cellText('主要', 'E6') == '法师' && cfBack.cellText('主要', 'O6') == '5');
  check('回读职业特性', cfBack.columnValues('主要', 'AX', 17, 19).values.join('、') == '施法、戏法、法术位');
  check('职业表的反查公式没被破坏',
      cfBack.sheetXml('职业').contains('IF(主要!AX17="","",主要!AX17)'));
  final cfBefore = _entries(cardBytes);
  final cfNow = _entries(cfBytes2);
  check('职业填入后 zip 条目数不变', cfBefore.length == cfNow.length, '${cfBefore.length} -> ${cfNow.length}');
  final cfChanged = cfNow.keys.where((k) => !_sameBytes(cfBefore[k]!, cfNow[k]!)).toList();
  check('只有「主要」表变了', cfChanged.length == 1 && cfChanged.first == 'xl/worksheets/sheet2.xml',
      cfChanged.join('、'));
  check('原卡没被改（职业）', _sameBytes(cardBytes, File(cardPath).readAsBytesSync()));

  // 空白模板是另一版式：职业特性在 BU 列，选择格同样是 E6/I6/O6
  final tplSel = tpl.linkedSelectors(sheet: '职业', sourceSheet: '主要');
  final tplClsBlocks = tpl.linkedBlocks(sheet: '职业', sourceSheet: '主要', minRun: 3);
  stdout.writeln('     空白模板职业槽位: ${tplClsBlocks.map((b) => b.range).join("、")}'
      '  选择格 ${tplSel.map((c) => "${c.column}${c.row}").join("、")}');
  check('空白模板也认得出职业槽位与选择格',
      tplClsBlocks.isNotEmpty && tplSel.length == 3,
      tplClsBlocks.map((b) => b.range).join('、'));

  // ---------------------------------------------------------------- 卡内可填位置总览
  // 「主要」表里所有「填名字 → 卡内反查」的列，后面接别的页面直接照这个接
  for (final entry in [('悲灵', cardBytes), ('空白卡', File(templatePath).readAsBytesSync())]) {
    final p2 = XlsxPatcher.open(entry.$2);
    final all = p2.linkedBlocks(sourceSheet: '主要', minRun: 3);
    stdout.writeln('     【${entry.$1}】主要表可填列: ${all.map((b) => b.range).join("、")}');
    final allSel = p2.linkedSelectors(sourceSheet: '主要');
    stdout.writeln('     【${entry.$1}】选择格: ${allSel.map((c) => "${c.column}${c.row}").join("、")}');
    for (final probe in ['职业', '种族', '专长与据点', '装备']) {
      if (!p2.hasSheet(probe)) continue;
      final byIf = p2.linkedBlocks(sheet: probe, sourceSheet: '主要', minRun: 3);
      final byRef = p2.referencedRuns(sheet: probe, sourceSheet: '主要', minRun: 3);
      stdout.writeln('     【${entry.$1}】$probe → 空判: ${byIf.map((b) => b.range).join("、")}'
          ' / 纯引用: ${byRef.map((b) => b.range).join("、")}');
    }
  }

  // 其他词条页的落点（专长 / 种族）也是同一套识别
  final featBlocks = XlsxPatcher.open(cardBytes)
      .linkedBlocks(sheet: '专长与据点', sourceSheet: '主要', minRun: 3)
    ..sort((a, b) => b.slots.compareTo(a.slots));
  check('认出专长名称列（主要!BU19 起）',
      featBlocks.isNotEmpty && featBlocks.first.column == 'BU',
      featBlocks.map((b) => b.range).join('、'));
  final speciesBlocks = XlsxPatcher.open(cardBytes)
      .linkedBlocks(sheet: '种族', sourceSheet: '主要', minRun: 3)
    ..sort((a, b) => b.slots.compareTo(a.slots));
  check('认出种族特性名称列（主要!BT3 起）',
      speciesBlocks.isNotEmpty && speciesBlocks.first.column == 'BT',
      speciesBlocks.map((b) => b.range).join('、'));
  // 页面只认最长的一段当名称列，这里也照这个口径
  final speciesNameCols = {speciesBlocks.first.column};
  final speciesSel = XlsxPatcher.open(cardBytes)
      .selectorGroups(sheet: '种族', sourceSheet: '主要')
      .map((g) => g.where((c) => !speciesNameCols.contains(c.column)).toList())
      .where((g) => g.isNotEmpty)
      .map((g) => g.map((c) => '${c.column}${c.row}').join(','))
      .toList();
  check('认种族页的种族 / 亚种格（排除特性名那一列）',
      speciesSel.length >= 2 && speciesSel[0] == 'T6' && speciesSel[1] == 'T7',
      speciesSel.join(' | '));

  // ---------------------------------------------------------------- 卡自己的选项
  // 车卡时能选什么一律以卡为准：卡里没列的种族 / 子职，填进去也查不出结果。
  final lists = CardLists.from(XlsxPatcher.open(cardBytes));
  stdout.writeln('     卡里可选: 职业 ${lists.classes.length} 个、种族 ${lists.races.length} 个、'
      '武器 ${lists.weapons.length} 个');
  check('职业清单来自卡（野蛮人打头）',
      lists.classes.length == 19 && lists.classes.first == '野蛮人', lists.classes.join('、'));
  check('子职跟着主职业走（战士 → 战斗大师 / 勇士 / 奥法骑士）',
      lists.subclassesOf('战士').take(3).join('、') == '战斗大师、勇士、奥法骑士',
      lists.subclassesOf('战士').join('、'));
  check('没选的职业给全部子职（不是空下拉）',
      lists.subclassesOf('').length > 20, '${lists.subclassesOf('').length} 个');
  check('种族清单来自卡（阿斯莫 / 提夫林在列，且不是词条库那 151 个）',
      lists.races.contains('阿斯莫') && lists.races.contains('提夫林') && lists.races.length < 100,
      '${lists.races.length} 个: ${lists.races.take(12).join('、')}');
  check('亚种跟着种族走（精灵 → 卓尔 / 高等精灵 / 木精灵 / 洛温精灵 / 暗影荒原精灵）',
      lists.subracesOf('精灵').join('、') == '卓尔、高等精灵、木精灵、洛温精灵、暗影荒原精灵',
      lists.subracesOf('精灵').join('、'));
  check('没有亚种的种族给空表', lists.subracesOf('人类').isEmpty);
  check('武器清单来自卡（表头「名称」那一列）',
      lists.weapons.contains('长剑') && lists.weapons.length > 20,
      '${lists.weapons.length} 个: ${lists.weapons.take(8).join('、')}');
  check('出身下拉只放核心那一份（16 条，扩展书的不进下拉）',
      lists.backgrounds.length == 16 &&
          lists.backgrounds.first == '侍僧' &&
          !lists.backgrounds.contains('巨人养子'),
      '${lists.backgrounds.length} 个: ${lists.backgrounds.join('、')}');

  stdout.writeln('\n$checks 项检查，$failures 项失败');
  exit(failures == 0 ? 0 : 1);
}
