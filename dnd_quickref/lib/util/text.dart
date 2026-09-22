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
