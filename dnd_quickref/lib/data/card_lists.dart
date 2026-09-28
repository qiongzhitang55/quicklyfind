/// 卡自身的「可选项」：车卡时每个下拉能选什么，一律以这张卡自己的表为准。
///
/// 卡里的 VLOOKUP 只认自己列出的名字——选了卡里没有的种族 / 子职，算出来就是
/// 空值。所以清单从卡里读，不再拿词条库的条数去猜。
///
/// 定位全部靠表头，不写死格子：
/// - 职业：`职业` 表里表头为「职业」的那一列
/// - 子职：同一张表里竖排写完职业名的那块矩阵，一行一个职业
/// - 种族 / 亚种：`种族` 表里表头为「种族」的那一列，右邻格是它的亚种
/// - 武器：`装备` 表里表头为「名称」的那一列
///
/// 没开扩展的行，卡里本来就是空串（`IF(自定义调整栏!…="O",…,"")`），
/// 读出来自然就没有——扩展开关由卡自己管，这里不另立一套。
library;

import '../xlsx/patcher.dart';

/// 2024 核心出身的名字（玩家手册2024 第四章）。
///
/// 卡里一共挂着上百条出身（含各扩展书的），下拉塞不下也不该塞；只放这一份，
/// 其余的照样能手输——写表看的始终是卡里的名字，不是这个清单。
const coreBackgrounds = [
  '侍僧', '工匠', '骗子', '罪犯', '艺人', '农民', '警卫', '向导',
  '隐士', '商人', '贵族', '智者', '水手', '抄写员', '士兵', '流浪者',
];

class CardLists {
  /// 主职业（`职业` 表竖排的职业清单）
  final List<String> classes;

  /// 每个职业自己的子职（`职业` 表 B3:M21 那种矩阵，按行合并）
  final Map<String, List<String>> subclassesByClass;

  /// 种族（`种族` 表竖排的种族清单）
  final List<String> races;

  /// 每个种族的亚种（种族名右边那一排）
  final Map<String, List<String>> subracesByRace;

  /// 武器 / 装备名（`装备` 表的名称列）
  final List<String> weapons;

  /// 出身 / 背景（`背景` 表的背景列，去掉「自定义背景」那条占位）
  final List<String> backgrounds;

  CardLists({
    required this.classes,
    required this.subclassesByClass,
    required this.races,
    required this.subracesByRace,
    required this.weapons,
    required this.backgrounds,
  });

  static final CardLists empty = CardLists(
    classes: const [],
    subclassesByClass: const {},
    races: const [],
    subracesByRace: const {},
    weapons: const [],
    backgrounds: const [],
  );

  /// 这个职业能选的子职。职业没选（或卡里没这个职业）时给全部子职，
  /// 让用户至少有的选，而不是空下拉。
  List<String> subclassesOf(String cls) {
    final own = subclassesByClass[cls.trim()];
    if (own != null && own.isNotEmpty) return own;
    return allSubclasses;
  }

  /// 这个种族能选的亚种（没有亚种的种族返回空表）
  List<String> subracesOf(String race) => subracesByRace[race.trim()] ?? const [];

  bool get isEmpty => classes.isEmpty && races.isEmpty;

  /// 只要武器 / 护甲名清单时用这个，免得为了一个下拉把整套清单都建出来
  static List<String> weaponsFrom(XlsxPatcher p) => _columnNames(p, '装备', '名称');

  /// 盾牌 / 护甲清单：`装备` 表里表头为「装备名称」的那一列（v1.1.1 是 `AU`、
  /// v1.0.12 是 `AP`、v1.0.0 是 `AQ`）。这一列前半段是盾牌，`护甲名称` 那个小标题
  /// 之后才是护甲清单 —— `装备!BA12` 的 `VLOOKUP(主要!L40, AU12:AY48, …)` 查的
  /// 就是后面这段。
  ///
  /// 不能写死列号：v1.0.12 上 `AP` 是「装备名称」，到 v1.1.1 上 `AP` 已经变成武器的
  /// 「词条」列了 —— 写死就会把「轻型 / 双手 / 投掷（射程 20/60）…」当成护甲名。
  static ({List<String> armors, List<String> shields}) equipNames(XlsxPatcher p) {
    const sheet = '装备';
    const none = (armors: <String>[], shields: <String>[]);
    final column = _headerColumn(p, sheet, '装备名称');
    if (column == null) return none;
    final byRow = _byRow(scanCells(p.sheetXml(sheet)), column);

    // `护甲名称` 那个小标题在第几行
    var headerRow = 0;
    for (var r = 2; r <= 120; r++) {
      if (_textAt(p, sheet, byRow[r]) == '护甲名称') {
        headerRow = r;
        break;
      }
    }

    final armors = <String>[];
    final shields = <String>[];
    if (headerRow == 0) {
      // 认不出这个小标题（别的版式）：整列都当护甲，盾牌退回卡里的固定名
      for (var r = 2; r <= 120; r++) {
        final t = _textAt(p, sheet, byRow[r]);
        if (_isEquipName(t) && !armors.contains(t)) armors.add(t);
      }
    } else {
      // 护甲：小标题往下，连着 5 个空格算到头
      var gap = 0;
      for (var r = headerRow + 1; r <= 120; r++) {
        final t = _textAt(p, sheet, byRow[r]);
        if (t.isEmpty) {
          if (++gap >= 5) break;
          continue;
        }
        gap = 0;
        if (_isEquipName(t) && !armors.contains(t)) armors.add(t);
      }
      // 盾牌：小标题**上面紧挨着**的那一段 —— 再往上还有武器名 / 「武器命中」那些块，
      // 别一起收进来（卡里盾牌和护甲之间隔着一个 `FALSE` 占位，正好在这儿断开）
      for (var r = headerRow - 1; r >= 2; r--) {
        final t = _textAt(p, sheet, byRow[r]);
        if (!_isEquipName(t)) break;
        if (!shields.contains(t)) shields.insert(0, t);
      }
    }
    if (armors.isEmpty) return (armors: shields, shields: const ['盾牌']);
    if (shields.isEmpty) shields.add('盾牌');
    return (armors: armors, shields: shields);
  }

  /// 出身下拉只放**核心那十几条**（玩家手册2024 第四章的出身）。
  ///
  /// 卡里还挂着几十条扩展书的出身（剑湾、拉尼卡、斯翠海文、被遗忘的国度…），
  /// 那些照样能填——手输进去卡一样查得到，只是不进下拉，免得一列一百多条。
  /// 跟「职业」下拉只放卡自己列的那一份是一个道理。
  static List<String> backgroundsFrom(XlsxPatcher p) =>
      _columnNames(p, '背景', '背景').where(coreBackgrounds.contains).toList();

  List<String> get allSubclasses {
    final out = <String>[];
    for (final list in subclassesByClass.values) {
      for (final name in list) {
        if (!out.contains(name)) out.add(name);
      }
    }
    return out;
  }

  factory CardLists.from(XlsxPatcher p) {
    var classes = _columnNames(p, '职业', '职业', stopAtNumber: true);
    final matrix = _subclassMatrix(p, classes);
    // 矩阵有几行，职业就该有几个：扩展职业的标签格在卡里可能是空的，但它右边
    // 的子职一定填着，所以用矩阵行数把清单裁准，别把下面的别的内容也吞进来。
    if (matrix.rows > 0 && matrix.rows < classes.length) {
      classes = classes.take(matrix.rows).toList();
    }
    final races = _columnNames(p, '种族', '种族', stopAtNumber: true, maxGap: 200);
    return CardLists(
      classes: classes,
      subclassesByClass: matrix.byClass,
      races: races,
      subracesByRace: _subraces(p, '种族', '种族', races),
      weapons: weaponsFrom(p),
      backgrounds: backgroundsFrom(p),
    );
  }
}

// ---------------------------------------------------------------- 取列

bool _looksNumeric(String s) => RegExp(r'^\d+([.,]\d+)?$').hasMatch(s);

/// 一个名字该不该收：别把分隔行、说明文字、数字当选项
bool _isName(String t) =>
    t.isNotEmpty && t.length <= 24 && !t.contains('\n') && !_looksNumeric(t) && !t.startsWith('—');

/// 装备 / 护甲名那种清单的一格：在 [_isName] 之上再要求有中文或字母，
/// 免得把卡里公式还没算出来的占位（`-` / `FALSE`）当成名字。
bool _isEquipName(String t) =>
    _isName(t) &&
    RegExp(r'[\u4e00-\u9fffA-Za-z]').hasMatch(t) &&
    !RegExp(r'^(TRUE|FALSE|N/A)$', caseSensitive: false).hasMatch(t);

Map<int, CellNode> _byRow(List<CellNode> cells, String column) {
  final out = <int, CellNode>{};
  for (final c in cells) {
    if (c.column == column) out[c.row] = c;
  }
  return out;
}

String _textAt(XlsxPatcher p, String sheet, CellNode? c) =>
    c == null ? '' : (p.cellValue(sheet, c) ?? '').trim();

/// 第 1 行里文本等于 [header] 的那一列。
///
/// 卡里同一个词会同时出现在好几处（`种族` 表 A1 和 AY1 都叫「种族」，但 A 列
/// 是辅助列、右邻全是行号；AY 列才是种族清单，右邻是亚种），所以先看「右邻列
/// 像不像一份子清单」，再看内容多少。
String? _headerColumn(XlsxPatcher p, String sheet, String header) {
  if (!p.hasSheet(sheet)) return null;
  final cells = scanCells(p.sheetXml(sheet));
  final heads =
      cells.where((c) => c.row == 1 && _textAt(p, sheet, c) == header).toList();
  if (heads.isEmpty) return null;

  String? best;
  var bestScore = -1;
  for (final h in heads) {
    final own = _byRow(cells, h.column);
    final next = _byRow(cells, colLetter(colNum(h.column) + 1));
    var count = 0;
    var sideNames = 0;
    for (var r = 2; r <= 120; r++) {
      if (_textAt(p, sheet, own[r]).isNotEmpty) count++;
      if (_isName(_textAt(p, sheet, next[r]))) sideNames++;
    }
    final score = (sideNames >= 3 ? 1000 : 0) + count;
    if (score > bestScore) {
      bestScore = score;
      best = h.column;
    }
  }
  return best;
}

/// 一列的清单（从第 2 行往下）。空行连着 [maxGap] 个才算结束——关掉的扩展项
/// 在卡里就是空串，中间空一段不能当结尾。
///
/// [stopAtNumber] 用来掐掉列尾接着的另一段内容：卡里 `职业` 列的清单写完后，
/// 下面隔一段又接着「豁免熟练 / 技能熟练 / …」那类别处的表，中间隔着个数字，
/// 遇到数字就收手正好。
List<String> _columnNames(XlsxPatcher p, String sheet, String header,
    {bool stopAtNumber = false, int maxGap = 60}) {
  final column = _headerColumn(p, sheet, header);
  if (column == null) return const [];
  final byRow = _byRow(scanCells(p.sheetXml(sheet)), column);
  final out = <String>[];
  var gap = 0;
  var started = false;
  for (var r = 2; r <= 120; r++) {
    final t = _textAt(p, sheet, byRow[r]);
    if (t.isEmpty) {
      if (++gap >= maxGap) break;
      continue;
    }
    gap = 0;
    if (stopAtNumber && started && _looksNumeric(t)) break;
    if (_isName(t) && !out.contains(t)) out.add(t);
    started = true;
  }
  return out;
}

/// 一个种族 / 职业右边的那些格子（亚种、子职都这么挂）
List<String> _rowAfter(XlsxPatcher p, List<CellNode> cells, String sheet, int row, String from,
    {int maxCols = 12}) {
  final start = colNum(from);
  final out = <String>[];
  for (final c in cells) {
    if (c.row != row) continue;
    final n = colNum(c.column);
    if (n <= start || n > start + maxCols) continue;
    final t = _textAt(p, sheet, c);
    if (_isName(t) && !out.contains(t)) out.add(t);
  }
  return out;
}

// ---------------------------------------------------------------- 亚种

Map<String, List<String>> _subraces(XlsxPatcher p, String sheet, String header, List<String> rows) {
  if (rows.isEmpty) return const {};
  final column = _headerColumn(p, sheet, header);
  if (column == null) return const {};
  final cells = scanCells(p.sheetXml(sheet));
  final byRow = _byRow(cells, column);

  final out = <String, List<String>>{};
  for (var r = 2; r <= 120; r++) {
    final name = _textAt(p, sheet, byRow[r]);
    if (name.isEmpty || !rows.contains(name)) continue;
    final subs = _rowAfter(p, cells, sheet, r, column);
    if (subs.isNotEmpty) out[name] = subs;
  }
  return out;
}

// ---------------------------------------------------------------- 子职矩阵

/// `职业` 表里那块「职业 × 出处」的子职矩阵：某一列竖着写完全部职业名，
/// 右边每格就是该职业的子职。行序和 `职业` 表竖排的职业清单一致，
/// 所以按行号对齐即可（扩展职业的标签格在卡里是空的，不影响对齐）。
({Map<String, List<String>> byClass, int rows}) _subclassMatrix(
    XlsxPatcher p, List<String> classes) {
  const sheet = '职业';
  final empty = (byClass: <String, List<String>>{}, rows: 0);
  if (classes.isEmpty || !p.hasSheet(sheet)) return empty;

  final cells = scanCells(p.sheetXml(sheet));
  final byRow = <int, Map<int, CellNode>>{};
  for (final c in cells) {
    (byRow[c.row] ??= {})[colNum(c.column)] = c;
  }
  String at(int row, int col) {
    final c = byRow[row]?[col];
    return c == null ? '' : (p.cellValue(sheet, c) ?? '').trim();
  }

  // 找出和职业清单对得最齐的那一列；扩展职业的标签在卡里是空格，
  // 所以按「命中数最多」挑，而不是要求全部相等。
  var bestRow = 0, bestCol = 0, bestHit = 0;
  for (var col = 2; col <= 40; col++) {
    for (var row = 2; row <= 30; row++) {
      var hit = 0;
      for (var i = 0; i < classes.length; i++) {
        if (at(row + i, col) == classes[i]) hit++;
      }
      if (hit > bestHit) {
        bestHit = hit;
        bestRow = row;
        bestCol = col;
      }
    }
  }
  if (bestHit < 5) return empty;

  final out = <String, List<String>>{};
  var rows = 0;
  for (var i = 0; i < classes.length; i++) {
    final names = <String>[];
    for (var k = 1; k <= 12; k++) {
      final t = at(bestRow + i, bestCol + k);
      if (_isName(t) && !names.contains(t)) names.add(t);
    }
    if (names.isEmpty) break; // 矩阵到头了
    out[classes[i]] = names;
    rows++;
  }
  return (byClass: out, rows: rows);
}
