/// xlsx 外科式读写：只改目标单元格，其余 zip 条目（图片 / 公式 / 其它工作表）原样搬运。
///
/// 两个刻意为之的点：
/// 1. 自己扫描 `<c>` 标签，不用一条大正则跨标签匹配。自闭合写法 `<c r="X3" s="1"/>`
///    会让「匹配到下一个 </c>」的正则把后一个单元格一起吞掉（人物卡里 X3 右边紧挨着
///    Y3 的公式，踩中就会静默删掉公式）。
/// 2. 法术位不是写死的，而是从卡内公式里认出来：凡是
///    `=IFERROR(VLOOKUP(<某列><某行>,法术大全!…,2,…))`，就说明「<某列><某行> 是法术名输入格」。
///    换一张卡、格子挪了位置，都不用改代码。
library;

import 'dart:convert';
import 'dart:typed_data';

import 'package:archive/archive.dart';

import '../util/text.dart';

/// XML 1.0 只允许 \t \n \r 三个控制字符，其余 U+0000–U+0008 / U+000B / U+000C /
/// U+000E–U+001F 都是非法的。直接写进去会让整个 sheet 变成不合法的 XML，
/// Excel 打不开（从网页 / PDF / Word 复制文字时很容易夹带这类不可见字符）。
final RegExp _xmlIllegal = RegExp(r'[\u0000-\u0008\u000B\u000C\u000E-\u001F]');

/// 写进 XML 的文本一律先过这里：先剔掉非法控制字符，再做标记字符转义。
String xmlEscape(String s) => s
    .replaceAll(_xmlIllegal, '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

String xmlUnescape(String s) => s
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');

/// 列号：'X' -> 24，'AC' -> 29
int colNum(String ref) {
  var n = 0;
  for (final ch in ref.toUpperCase().codeUnits) {
    if (ch >= 65 && ch <= 90) {
      n = n * 26 + (ch - 64);
    } else {
      break;
    }
  }
  return n;
}

/// 列名：24 -> 'X'
String colLetter(int n) {
  var s = '';
  while (n > 0) {
    final r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = (n - 1) ~/ 26;
  }
  return s;
}

String columnOf(String ref) =>
    RegExp(r'^[A-Za-z]+').firstMatch(ref)?.group(0)!.toUpperCase() ?? '';

int rowOf(String ref) {
  final m = RegExp(r'(\d+)').firstMatch(ref);
  if (m == null) throw ArgumentError('单元格引用不合法: $ref');
  return int.parse(m.group(1)!);
}

/// xml 里的一个 `<c>` 单元格
class CellNode {
  final String ref;
  final String column;
  final int row;
  final String attrs;
  final String body;
  final bool selfClosing;
  final int start;
  final int end;

  CellNode({
    required this.ref,
    required this.column,
    required this.row,
    required this.attrs,
    required this.body,
    required this.selfClosing,
    required this.start,
    required this.end,
  });

  bool get hasFormula => body.contains('<f');
}

/// 扫描一张工作表 xml 里所有 `<c>` 单元格。
///
/// 只认 `<c r="…">` 这种形状：`<cols>` / `<col …>` / `<cf …>` 都不会被误当成单元格。
List<CellNode> scanCells(String xml) {
  final out = <CellNode>[];
  final re = RegExp(r'<c\s+r="([A-Za-z]+)(\d+)"([^>]*)>');
  for (final m in re.allMatches(xml)) {
    final column = m.group(1)!.toUpperCase();
    final row = int.parse(m.group(2)!);
    final attrs = m.group(3)!;
    final selfClosing = attrs.trimRight().endsWith('/');
    final bodyStart = m.end;
    var bodyEnd = bodyStart;
    if (!selfClosing) {
      final close = xml.indexOf('</c>', bodyStart);
      if (close < 0) continue;
      bodyEnd = close;
    }
    out.add(CellNode(
      ref: '$column$row',
      column: column,
      row: row,
      attrs: selfClosing ? attrs.substring(0, attrs.lastIndexOf('/')) : attrs,
      body: selfClosing ? '' : xml.substring(bodyStart, bodyEnd),
      selfClosing: selfClosing,
      start: m.start,
      end: selfClosing ? m.end : bodyEnd + 4,
    ));
  }
  return out;
}

/// 一个可写入的法术位区段（同一列里连续的一段行）
class SpellBlock {
  final String column;
  final int startRow;
  final int endRow;
  SpellBlock(this.column, this.startRow, this.endRow);

  String get range => '$column$startRow:$column$endRow';
  int get slots => endRow - startRow + 1;
  List<String> get cells => [for (var r = startRow; r <= endRow; r++) '$column$r'];

  Map<String, dynamic> toJson() => {
        'column': column,
        'startRow': startRow,
        'endRow': endRow,
        'range': range,
        'slots': slots,
      };
}

/// 一条写进卡里的法术
class FilledSlot {
  final String cell;
  final String name;
  FilledSlot(this.cell, this.name);
  Map<String, dynamic> toJson() => {'cell': cell, 'name': name};
}

class FillOutcome {
  final String sheet;
  final List<int> bytes;
  final List<SpellBlock> blocks;
  final List<FilledSlot> written;

  /// 卡里已经有同名法术（跳过）
  final List<String> alreadyInTable;

  /// 本次填入区里重名的（跳过）
  final List<String> duplicateInBatch;

  /// 没在本卡「法术大全」里找到（仍会写入，但卡内反查出的列会是空的）
  final List<String> notInCard;

  /// 法术位不够，没写进去的
  final List<String> overflow;
  final int freeBefore;

  FillOutcome({
    required this.sheet,
    required this.bytes,
    required this.blocks,
    required this.written,
    required this.alreadyInTable,
    required this.duplicateInBatch,
    required this.notInCard,
    required this.overflow,
    required this.freeBefore,
  });

  int get skipped => alreadyInTable.length + duplicateInBatch.length;

  Map<String, dynamic> toJson() => {
        'sheet': sheet,
        'blocks': blocks.map((b) => b.toJson()).toList(),
        'written': written.map((w) => w.toJson()).toList(),
        'writtenCount': written.length,
        'alreadyInTable': alreadyInTable,
        'duplicateInBatch': duplicateInBatch,
        'skippedCount': skipped,
        'notInCard': notInCard,
        'overflow': overflow,
        'freeBefore': freeBefore,
      };
}

class _Edit {
  final int start;
  final int end;
  final String text;
  _Edit(this.start, this.end, this.text);
}

class XlsxPatcher {
  final Archive _archive;
  final List<int> _originalBytes;
  final Map<String, String> _sheetToPath;
  final Map<String, String> _xmlCache = {};
  List<String>? _sst;
  final Map<String, Map<int, String>> _columnCache = {};

  XlsxPatcher._(this._archive, this._originalBytes, this._sheetToPath);

  static XlsxPatcher open(List<int> bytes) {
    final archive = ZipDecoder().decodeBytes(bytes);
    final byName = <String, ArchiveFile>{};
    for (final f in archive) {
      byName[f.name] = f;
    }
    final wbFile = byName['xl/workbook.xml'];
    final relFile = byName['xl/_rels/workbook.xml.rels'];
    if (wbFile == null || relFile == null) {
      throw StateError('不是有效的 xlsx：缺少 workbook.xml 或 rels');
    }
    final wb = utf8.decode(_bytesOf(wbFile), allowMalformed: true);
    final rels = utf8.decode(_bytesOf(relFile), allowMalformed: true);

    final relMap = <String, String>{};
    for (final m in RegExp(r'<Relationship\b[^>]*>').allMatches(rels)) {
      final tag = m.group(0)!;
      final id = RegExp(r'Id="([^"]*)"').firstMatch(tag)?.group(1);
      final target = RegExp(r'Target="([^"]*)"').firstMatch(tag)?.group(1);
      if (id != null && target != null) relMap[id] = target;
    }
    final sheetToPath = <String, String>{};
    for (final m in RegExp(r'<sheet\b[^>]*>').allMatches(wb)) {
      final tag = m.group(0)!;
      final name = RegExp(r'name="([^"]*)"').firstMatch(tag)?.group(1);
      final rid = RegExp(r'r:id="([^"]*)"').firstMatch(tag)?.group(1);
      if (name == null || rid == null) continue;
      final t = relMap[rid];
      if (t == null) continue;
      sheetToPath[xmlUnescape(name)] =
          t.startsWith('xl/') ? t : 'xl/${t.replaceFirst(RegExp(r'^/'), '')}';
    }
    return XlsxPatcher._(archive, bytes, sheetToPath);
  }

  static List<int> _bytesOf(ArchiveFile f) {
    final c = f.content;
    if (c is Uint8List) return c;
    if (c is List<int>) return c;
    if (c is String) return utf8.encode(c);
    throw StateError('无法读取 zip 条目 ${f.name} 的内容 (${c.runtimeType})');
  }

  List<String> get sheetNames => _sheetToPath.keys.toList();
  bool hasSheet(String sheet) => _sheetToPath.containsKey(sheet);

  String sheetXml(String sheet) {
    final path = _sheetToPath[sheet];
    if (path == null) {
      throw ArgumentError('工作表不存在: $sheet（有 ${sheetNames.join("、")}）');
    }
    return _xmlCache.putIfAbsent(path, () {
      for (final f in _archive) {
        if (f.name == path) return utf8.decode(_bytesOf(f), allowMalformed: true);
      }
      throw StateError('zip 里找不到 $path');
    });
  }

  // ------------------------------------------------------------ 读
  static String _allText(String inner) {
    // 去掉注音（rPh）再取所有 <t>；富文本多个 run 直接拼起来
    final cleaned = inner.replaceAll(RegExp(r'<rPh\b.*?</rPh>', dotAll: true), '');
    return RegExp(r'<t[^>]*>(.*?)</t>', dotAll: true)
        .allMatches(cleaned)
        .map((m) => xmlUnescape(m.group(1)!))
        .join();
  }

  List<String> get _sharedStrings {
    return _sst ??= () {
      ArchiveFile? f;
      for (final x in _archive) {
        if (x.name == 'xl/sharedStrings.xml') f = x;
      }
      if (f == null) return <String>[];
      final xml = utf8.decode(_bytesOf(f), allowMalformed: true);
      return RegExp(r'<si>(.*?)</si>', dotAll: true)
          .allMatches(xml)
          .map((m) => _allText(m.group(1)!))
          .toList();
    }();
  }

  String? cellValue(String sheet, CellNode c) {
    if (c.selfClosing) return null;
    final t = RegExp(r't="([^"]*)"').firstMatch(c.attrs)?.group(1) ?? '';
    if (t == 'inlineStr') {
      final inner = RegExp(r'<is>(.*?)</is>', dotAll: true).firstMatch(c.body)?.group(1);
      return _allText(inner ?? c.body);
    }
    final v = RegExp(r'<v[^>]*>(.*?)</v>', dotAll: true).firstMatch(c.body)?.group(1) ?? '';
    if (t == 's') {
      final idx = int.tryParse(v.trim());
      if (idx == null || idx < 0 || idx >= _sharedStrings.length) return null;
      return _sharedStrings[idx];
    }
    return xmlUnescape(v);
  }

  Map<int, String> columnValues(String sheet, String column, int fromRow, int toRow) {
    final key = '$sheet|$column|$fromRow|$toRow';
    final cached = _columnCache[key];
    if (cached != null) return cached;
    final out = <int, String>{};
    for (final c in scanCells(sheetXml(sheet))) {
      if (c.column != column.toUpperCase()) continue;
      if (c.row < fromRow || c.row > toRow) continue;
      final v = cellValue(sheet, c);
      if (v == null) continue;
      final t = v.trim();
      if (t.isEmpty) continue;
      out[c.row] = t;
    }
    _columnCache[key] = out;
    return out;
  }

  /// 某一列里所有非空文本值（不限行范围）
  List<String> columnAll(String sheet, String column) {
    final out = <String>[];
    for (final c in scanCells(sheetXml(sheet))) {
      if (c.column != column.toUpperCase()) continue;
      final v = cellValue(sheet, c);
      if (v == null) continue;
      final t = v.trim();
      if (t.isNotEmpty) out.add(t);
    }
    return out;
  }

  // ------------------------------------------------------------ 认法术位
  /// 从卡内公式认出所有「法术名输入格」组成的区段。
  ///
  /// 判定条件：公式里含 `VLOOKUP(<单元格>,<lookupSheet>!…,2,…)`，且同一列上
  /// 形成一段连续的行（>= [minRun] 行）。零星的「当前选中法术」详情公式
  /// （引用格只有一行）会被这条规则挡掉。
  List<SpellBlock> spellBlocks({
    String sheet = '法术书',
    String lookupSheet = '法术大全',
    int minRun = 10,
  }) {
    if (!hasSheet(sheet)) return const [];
    final byColumn = <String, List<int>>{};
    for (final c in scanCells(sheetXml(sheet))) {
      final f = RegExp(r'<f[^>]*>(.*?)</f>', dotAll: true).firstMatch(c.body)?.group(1);
      if (f == null) continue;
      for (final m in RegExp(r'VLOOKUP\(([^)]*)\)', caseSensitive: false).allMatches(f)) {
        final args = m.group(1)!.split(',');
        if (args.length < 3) continue;
        if (!args[1].contains(lookupSheet)) continue;
        if (args[2].replaceAll(r'$', '').trim() != '2') continue;
        final ref = RegExp(r'^\$?([A-Za-z]+)\$?(\d+)$').firstMatch(args[0].trim());
        if (ref == null) continue;
        final col = ref.group(1)!.toUpperCase();
        byColumn.putIfAbsent(col, () => []).add(int.parse(ref.group(2)!));
      }
    }

    final blocks = <SpellBlock>[];
    final cols = byColumn.keys.toList()..sort((a, b) => colNum(a).compareTo(colNum(b)));
    for (final col in cols) {
      final rows = byColumn[col]!.toSet().toList()..sort();
      var i = 0;
      while (i < rows.length) {
        var j = i;
        while (j + 1 < rows.length && rows[j + 1] == rows[j] + 1) {
          j++;
        }
        if (j - i + 1 >= minRun) blocks.add(SpellBlock(col, rows[i], rows[j]));
        i = j + 1;
      }
    }
    return blocks;
  }

  /// 卡内「法术大全」的法术名（归一化），用于提示「卡里没有这条法术」
  Set<String> spellDictionary({String sheet = '法术大全', String column = 'A'}) {
    if (!hasSheet(sheet)) return <String>{};
    final header = normalizeKey('法术名');
    return columnAll(sheet, column)
        .map(normalizeKey)
        .where((s) => s.isNotEmpty && s != header)
        .toSet();
  }

  // ------------------------------------------------------------ 通用「填名字」区段
  // 人物卡里凡是「在 A 表填个名字，卡内自动反查」的地方都长这样：
  //     IF(源表!BX17="","",源表!BX17)
  // 法术书用的是一条 VLOOKUP 公式，职业用的是这种 IF 空判公式。两条路都认，
  // 换卡版本（格子挪到别的列/行）都不用改代码。

  static final _zeroPair = RegExp(r'IF\(\s*([^,=]+?)\s*=\s*""\s*,\s*0\s*,\s*([^),]+?)\s*\)');
  /// 公式里对某张表的单元格引用（含 `'表名'!$A$1` 这种写法）
  static final _refAny =
      RegExp(r"(?:'([^']+)'|([A-Za-z\u4e00-\u9fff_]+))!\$?([A-Za-z]{1,3})\$?(\d+)");

  /// 收集某张表里所有指向 [sourceSheet] 的单元格引用
  List<({String sheet, String column, int row})> _refsTo(
    String sheet,
    String sourceSheet,
  ) {
    final out = <({String sheet, String column, int row})>[];
    for (final c in scanCells(sheetXml(sheet))) {
      final f = RegExp(r'<f[^>]*>(.*?)</f>', dotAll: true).firstMatch(c.body)?.group(1);
      if (f == null) continue;
      for (final m in _refAny.allMatches(f)) {
        final name = (m.group(1) ?? m.group(2) ?? '').replaceAll("''", "'");
        if (name != sourceSheet) continue;
        out.add((
          sheet: sourceSheet,
          column: m.group(3)!.toUpperCase(),
          row: int.parse(m.group(4)!),
        ));
      }
    }
    return out;
  }

  /// 解析 `源表!$BX$17` / `'源 表'!BX17` 这类引用
  static ({String sheet, String column, int row})? parseRef(String raw) {
    var s = raw.trim().replaceAll(r'$', '');
    String sheet;
    final bang = s.lastIndexOf('!');
    if (bang < 0) {
      sheet = '';
      s = s.trim();
    } else {
      sheet = s.substring(0, bang).trim();
      if (sheet.startsWith("'") && sheet.endsWith("'")) {
        sheet = sheet.substring(1, sheet.length - 1).replaceAll("''", "'");
      }
      s = s.substring(bang + 1).trim();
    }
    final m = RegExp(r'^([A-Za-z]{1,3})(\d+)$').firstMatch(s);
    if (m == null) return null;
    return (sheet: sheet, column: m.group(1)!.toUpperCase(), row: int.parse(m.group(2)!));
  }

  /// 收集所有「填名字 → 自动反查」的输入格。
  ///
  /// 判据是「数据表里成段地引用源表某一列」——不挑公式写法，
  /// 因为卡里空值判定的默认值有 `""`、`0`、`"-"` 好几种。
  List<({String sheet, String column, int row})> linkedInputs({
    String? sheet,
    required String sourceSheet,
  }) {
    final out = <({String sheet, String column, int row})>[];
    for (final s in (sheet == null ? sheetNames : [sheet])) {
      if (!hasSheet(s)) continue;
      out.addAll(_refsTo(s, sourceSheet));
    }
    return out;
  }

  /// 把 [linkedInputs] 收出来的格子按列聚成连续区段（默认只认每段 >= minRun 格）
  List<SpellBlock> linkedBlocks({
    String? sheet,
    required String sourceSheet,
    String? column,
    int minRun = 3,
  }) {
    final byColumn = <String, List<int>>{};
    for (final ref in linkedInputs(sheet: sheet, sourceSheet: sourceSheet)) {
      if (column != null && ref.column != column.toUpperCase()) continue;
      byColumn.putIfAbsent('${ref.sheet}|${ref.column}', () => []).add(ref.row);
    }
    final blocks = <SpellBlock>[];
    for (final entry in byColumn.entries) {
      final col = entry.key.split('|').last;
      final rows = entry.value.toSet().toList()..sort();
      var i = 0;
      while (i < rows.length) {
        var j = i;
        while (j + 1 < rows.length && rows[j + 1] == rows[j] + 1) {
          j++;
        }
        if (j - i + 1 >= minRun) blocks.add(SpellBlock(col, rows[i], rows[j]));
        i = j + 1;
      }
    }
    blocks.sort((a, b) {
      final c = colNum(a.column).compareTo(colNum(b.column));
      return c != 0 ? c : a.startRow.compareTo(b.startRow);
    });
    return blocks;
  }

  /// 职业选择格（主职业 / 子职业 / 等级）。
  ///
  /// 卡里长这样：`IF(主要!E6="",0,主要!E6)`，三格一组排在「职业」表里，
  /// 第一组是主职业，后面几组是兼职。返回按列升序的三格（职业、子职业、等级）。
  List<List<({String sheet, String column, int row})>> selectorGroups({
    String? sheet,
    required String sourceSheet,
  }) {
    final groups = <String, List<({String sheet, String column, int row})>>{};
    for (final s in (sheet == null ? sheetNames : [sheet])) {
      if (!hasSheet(s)) continue;
      for (final c in scanCells(sheetXml(s))) {
        final f = RegExp(r'<f[^>]*>(.*?)</f>', dotAll: true).firstMatch(c.body)?.group(1);
        if (f == null) continue;
        for (final m in _zeroPair.allMatches(f)) {
          final a = m.group(1)!.trim(), b = m.group(2)!.trim();
          if (a != b) continue;
          final ref = parseRef(a);
          if (ref == null || ref.sheet != sourceSheet) continue;
          groups.putIfAbsent('${ref.sheet}|${ref.row}', () => []).add(ref);
        }
      }
    }
    if (groups.isEmpty) return const [];
    final rows = groups.keys.map((k) => int.parse(k.split('|').last)).toList()..sort();
    final out = <List<({String sheet, String column, int row})>>[];
    for (final r in rows) {
      final g = groups['$sourceSheet|$r']!;
      g.sort((a, b) => colNum(a.column).compareTo(colNum(b.column)));
      out.add(g);
    }
    return out;
  }

  /// 取第一组（职业的 主职业/子职业/等级 就在第一组里）
  List<({String sheet, String column, int row})> linkedSelectors({
    String? sheet,
    required String sourceSheet,
  }) {
    final g = selectorGroups(sheet: sheet, sourceSheet: sourceSheet);
    return g.isEmpty ? const [] : g.first;
  }

  /// 读单个格子的文本（没有内容返回空串）
  String cellText(String sheet, String ref) {
    if (!hasSheet(sheet)) return '';
    for (final c in scanCells(sheetXml(sheet))) {
      if (c.ref != ref.toUpperCase()) continue;
      return (cellValue(sheet, c) ?? '').trim();
    }
    return '';
  }

  /// 读卡里给某个格子配的下拉选项（`<dataValidation sqref="T8"><formula1>"a,b,c"</formula1>`）。
  /// `sqref` 经常写成**范围**（`R42:T51`、`F32:F36`、`B13:B18` 这种），所以按「格子落在范围里」判，
  /// 不能只比字符串相等——不然卡里明明有下拉，界面上选出来是空的。
  List<String> validationOptions(String sheet, String ref) {
    if (!hasSheet(sheet)) return const [];
    final xml = sheetXml(sheet);
    for (final m in RegExp(r'<dataValidation\b[^>]*>.*?</dataValidation>', dotAll: true).allMatches(xml)) {
      final block = m.group(0)!;
      final sqref = RegExp(r'sqref="([^"]*)"').firstMatch(block)?.group(1) ?? '';
      if (!sqref.split(' ').any((r) => _sqrefCovers(r.trim(), ref))) continue;
      final f = RegExp(r'<formula1>(.*?)</formula1>', dotAll: true).firstMatch(block)?.group(1) ?? '';
      final t = xmlUnescape(f).trim();
      if (!t.startsWith('"')) continue;
      return t
          .replaceAll(RegExp(r'^"|"$'), '')
          .split(',')
          .map((s) => s.trim())
          .where((s) => s.isNotEmpty)
          .toList();
    }
    return const [];
  }

  /// `R42:T51` 里包不包含 `R42`？（单个格子、范围、多段都认）
  static bool _sqrefCovers(String range, String ref) {
    final target = ref.toUpperCase().replaceAll(r'$', '');
    for (final part in range.toUpperCase().replaceAll(r'$', '').split(RegExp(r'[,\s]+'))) {
      if (part.isEmpty) continue;
      if (part == target) return true;
      final m = RegExp(r'^([A-Z]+)(\d+):([A-Z]+)(\d+)$').firstMatch(part);
      if (m == null) continue;
      final t = RegExp(r'^([A-Z]+)(\d+)$').firstMatch(target);
      if (t == null) continue;
      final c1 = _colNum(m.group(1)!), c2 = _colNum(m.group(3)!);
      final r1 = int.parse(m.group(2)!), r2 = int.parse(m.group(4)!);
      final c = _colNum(t.group(1)!), r = int.parse(t.group(2)!);
      if (c >= c1 && c <= c2 && r >= r1 && r <= r2) return true;
    }
    return false;
  }

  static int _colNum(String letters) {
    var n = 0;
    for (final ch in letters.codeUnits) {
      n = n * 26 + (ch - 64);
    }
    return n;
  }

  /// 找「整段直接引用源表某列」的公式，例如
  /// `专长与据点!F4 = 主要!BU19`、`F5 = 主要!BU20` … 这一串说明
  /// 主要!BU19:BU28 就是「专长名称」的输入列。
  ///
  /// 要求公式就是一条纯引用（`=<源表>!<格>`），避免把 SUM/VLOOKUP 里的引用也算进来。
  List<SpellBlock> referencedRuns({
    String? sheet,
    required String sourceSheet,
    int minRun = 3,
  }) {
    final direct = RegExp(r'^=\s*([^=,()+\-*/&]+?)\s*$');
    final byColumn = <String, List<int>>{};
    for (final s in (sheet == null ? sheetNames : [sheet])) {
      if (!hasSheet(s)) continue;
      for (final c in scanCells(sheetXml(s))) {
        final f = RegExp(r'<f[^>]*>(.*?)</f>', dotAll: true).firstMatch(c.body)?.group(1);
        if (f == null) continue;
        if (!direct.hasMatch(f)) continue;
        final ref = parseRef(f.substring(1));
        if (ref == null || ref.sheet != sourceSheet) continue;
        byColumn.putIfAbsent(ref.column, () => []).add(ref.row);
      }
    }
    final blocks = <SpellBlock>[];
    for (final entry in byColumn.entries) {
      final rows = entry.value.toSet().toList()..sort();
      var i = 0;
      while (i < rows.length) {
        var j = i;
        while (j + 1 < rows.length && rows[j + 1] == rows[j] + 1) {
          j++;
        }
        if (j - i + 1 >= minRun) blocks.add(SpellBlock(entry.key, rows[i], rows[j]));
        i = j + 1;
      }
    }
    blocks.sort((a, b) {
      final c = colNum(a.column).compareTo(colNum(b.column));
      return c != 0 ? c : a.startRow.compareTo(b.startRow);
    });
    return blocks;
  }

  // ------------------------------------------------------------ 写
  String _cellXml(String ref, String value, String keep) =>
      '<c r="$ref"${keep.isEmpty ? '' : ' $keep'} t="inlineStr">'
      '<is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>';

  /// 批量改单元格：一次重打包，比逐格 patch 快得多
  List<int> writeCells(String sheet, Map<String, String> values) {
    final path = _sheetToPath[sheet];
    if (path == null) throw ArgumentError('工作表不存在: $sheet');
    var xml = sheetXml(sheet);
    final edits = <_Edit>[];
    final inserts = <MapEntry<String, String>>[];
    final byRef = {for (final c in scanCells(xml)) c.ref: c};

    values.forEach((ref, value) {
      final c = byRef[ref];
      if (c == null) {
        inserts.add(MapEntry(ref, value));
        return;
      }
      // 保留原有样式号，字色/边框/条件格式才不会丢
      final keep = RegExp(r'\b(?:s|cm|vm)="[^"]*"')
          .allMatches(c.attrs)
          .map((m) => m.group(0)!)
          .join(' ');
      edits.add(_Edit(c.start, c.end, _cellXml(ref, value, keep)));
    });

    edits.sort((a, b) => b.start.compareTo(a.start));
    for (final e in edits) {
      xml = xml.replaceRange(e.start, e.end, e.text);
    }
    for (final ins in inserts) {
      xml = _insertCell(xml, ins.key, ins.value);
    }
    return _rebuild(path, utf8.encode(xml));
  }

  String _insertCell(String xml, String ref, String value) {
    final row = rowOf(ref);
    final newCell =
        '<c r="$ref" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>';
    final rowM = RegExp('<row r="$row"[^>]*?(/>|>.*?</row>)', dotAll: true).firstMatch(xml);
    if (rowM != null) {
      final block = rowM.group(0)!;
      String newBlock;
      if (block.endsWith('/>')) {
        newBlock = '${block.substring(0, block.length - 2)}>$newCell</row>';
      } else {
        final cells = RegExp('<c r="([A-Z]+)$row"').allMatches(block).toList();
        int? pos;
        for (final m in cells) {
          if (colNum(m.group(1)!) > colNum(ref)) {
            pos = m.start;
            break;
          }
        }
        newBlock = pos != null
            ? block.replaceRange(pos, pos, newCell)
            : block.replaceAll('</row>', '$newCell</row>');
      }
      return xml.replaceRange(rowM.start, rowM.end, newBlock);
    }
    final rows = RegExp('<row r="(\d+)"').allMatches(xml).toList();
    int? pos;
    for (final m in rows) {
      if (int.parse(m.group(1)!) > row) {
        pos = m.start;
        break;
      }
    }
    final newRow = '<row r="$row">$newCell</row>';
    return pos != null
        ? xml.replaceRange(pos, pos, newRow)
        : xml.replaceAll('</sheetData>', '$newRow</sheetData>');
  }

  List<int> _rebuild(String changedPath, List<int> newContent) {
    final out = Archive();
    for (final f in _archive) {
      final data = f.name == changedPath ? newContent : _bytesOf(f);
      out.addFile(ArchiveFile(f.name, data.length, data));
    }
    final encoded = ZipEncoder().encode(out);
    if (encoded == null) throw StateError('zip 重新打包失败');
    return encoded;
  }

  // ------------------------------------------------------------ 填入
  /// 把 [names] 依次写进法术位的空位。
  ///
  /// - 卡里已经有同名法术 → 跳过（[FillOutcome.alreadyInTable]）
  /// - 本批里重复 → 跳过（[FillOutcome.duplicateInBatch]）
  /// - 只有「不含公式的空格」才算空位，格子里本来有公式的一律不碰
  /// - 位置不够 → 如实报告，不静默丢弃
  FillOutcome fillSpells({
    required List<String> names,
    String sheet = '法术书',
    List<SpellBlock>? blocks,
    String lookupSheet = '法术大全',
    Set<String>? dictionary,
  }) {
    final bs = blocks ?? spellBlocks(sheet: sheet, lookupSheet: lookupSheet);
    if (bs.isEmpty) {
      throw StateError('在「$sheet」里没认出法术位（需要卡内有 VLOOKUP(单元格,$lookupSheet!…,2,…) 形式的公式）');
    }
    final dict = dictionary ?? spellDictionary(sheet: lookupSheet);

    final takenKeys = <String>{};
    final freeSlots = <String>[];
    final formulaCells = <String>{
      for (final c in scanCells(sheetXml(sheet))) if (c.hasFormula) c.ref,
    };
    for (final b in bs) {
      final vals = columnValues(sheet, b.column, b.startRow, b.endRow);
      for (var r = b.startRow; r <= b.endRow; r++) {
        final cell = '${b.column}$r';
        final v = (vals[r] ?? '').trim();
        if (v.isEmpty && !formulaCells.contains(cell)) {
          freeSlots.add(cell);
        } else if (v.isNotEmpty) {
          takenKeys.add(normalizeKey(v));
        }
      }
    }

    final writes = <String, String>{};
    final written = <FilledSlot>[];
    final already = <String>[];
    final inBatch = <String>[];
    final overflow = <String>[];
    final seen = <String>{...takenKeys};
    var slot = 0;
    for (final raw in names) {
      final name = raw.trim();
      if (name.isEmpty) continue;
      final key = normalizeKey(name);
      if (seen.contains(key)) {
        (takenKeys.contains(key) ? already : inBatch).add(name);
        continue;
      }
      if (slot >= freeSlots.length) {
        overflow.add(name);
        continue;
      }
      seen.add(key);
      final cell = freeSlots[slot++];
      writes[cell] = name;
      written.add(FilledSlot(cell, name));
    }

    final bytes = writes.isEmpty ? _originalBytes : writeCells(sheet, writes);
    return FillOutcome(
      sheet: sheet,
      bytes: bytes,
      blocks: bs,
      written: written,
      alreadyInTable: already,
      duplicateInBatch: inBatch,
      notInCard: dict.isEmpty
          ? const []
          : written
              .where((w) => !dict.contains(normalizeKey(w.name)))
              .map((w) => w.name)
              .toList(),
      overflow: overflow,
      freeBefore: freeSlots.length,
    );
  }

  /// 单格写入（自检与调试用）
  List<int> patchCell(String sheet, String cell, String value) =>
      writeCells(sheet, {cell: value});
}
