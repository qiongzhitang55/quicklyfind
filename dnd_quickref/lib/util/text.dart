/// 名称归一化：界面、备用区、卡内查重都走这里，保证口径一致。
library;

/// 去掉空白与常见分隔符/标点，统一小写。
///
/// 例：「火球术 」「火·球术」「火球术(旧版)」→ 归一化后可比对。
String normalizeKey(String input) {
  var s = input.replaceAll(RegExp(r'\s+'), '');
  s = s.replaceAll(RegExp(r'[·・．.\-—–_（）()\[\]【】「」《》]'), '');
  return s.toLowerCase();
}

/// 「工具熟练 / 语言」里那些"要你自己挑"的指令的识别词。
///
/// 规则书写的是 `选择一种工匠工具（参见第六章）`、`一门你自选的语言` 这种句子，
/// 而不是 `书法工具`、`龙语` 这种能直接进值格的具体名字。
/// 界面那边（`web/app.js` 的 `MENU_HINT`）有一份同样的正则，改的时候两边一起改。
const menuHintPattern =
    r'(选择|任选|自选|挑选|所选|参见|见第|一种|一门|一项|一套|两个|两门|两项|但不能说|你所说|理解|或者一)';
final _menuHint = RegExp(menuHintPattern);

/// 这条「工具熟练 / 语言」是可以直接写进值格的具体名字，还是要玩家自己挑的指令？
///
/// 指令句不能抄进值格——那样格子里躺着的是「选择一种工匠工具（参见第六章）」这种句子，
/// 会永久占掉一格、换出身也不还原（见 `bugs/已知问题.md` 的 O4）。
bool isConcreteAssignment(String text) {
  final t = text.trim().replaceAll(RegExp(r'[。．.]+$'), '');
  if (t.isEmpty) return false;
  const blanks = {'-', '—', '——', '–', '－', '/', '无'};
  if (blanks.contains(t)) return false;
  return !_menuHint.hasMatch(t);
}
