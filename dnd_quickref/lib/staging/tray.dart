/// 备用区：速查时抓进来的词条暂存于此，支持一键查重与导出。
library;

import '../models/entry.dart';

enum AddResult { added, duplicateInTray, unknown }

class DuplicateHit {
  final Entry entry;
  final List<Entry> clashesWith; // 与它在备用区里重名的其它条目
  DuplicateHit(this.entry, this.clashesWith);
  bool get isDuplicate => clashesWith.isNotEmpty;
}

class Tray {
  final List<Entry> _items = [];
  final Map<String, Entry> _byId = {};

  List<Entry> get items => List.unmodifiable(_items);
  int get length => _items.length;
  bool contains(String id) => _byId.containsKey(id);

  AddResult add(Entry e) {
    if (_byId.containsKey(e.id)) return AddResult.duplicateInTray;
    _items.add(e);
    _byId[e.id] = e;
    return AddResult.added;
  }

  bool remove(String id) {
    if (!_byId.containsKey(id)) return false;
    _byId.remove(id);
    _items.removeWhere((e) => e.id == id);
    return true;
  }

  void clear() {
    _items.clear();
    _byId.clear();
  }

  /// 一键查重：按归一化中文名 / 英文名分组，返回所有重名的组。
  ///
  /// 只报「组内条目数 > 1」的组；同一组按加入顺序排列，第一个视为保留项。
  List<List<Entry>> findDuplicateGroups() {
    final buckets = <String, List<Entry>>{};
    for (final e in _items) {
      final key = e.normalizedName.isNotEmpty ? e.normalizedName : e.normalizedEn;
      buckets.putIfAbsent(key, () => []).add(e);
    }
    final dupes = buckets.values.where((g) => g.length > 1).toList();
    // 英文名交叉查重：中文名不同但英文名相同（同一法术的不同译名/版本）
    final enBuckets = <String, List<Entry>>{};
    for (final e in _items) {
      if (e.normalizedEn.isEmpty) continue;
      enBuckets.putIfAbsent(e.normalizedEn, () => []).add(e);
    }
    final seenIds = dupes.expand((g) => g.map((e) => e.id)).toSet();
    for (final g in enBuckets.values) {
      if (g.length > 1 && !g.every((e) => seenIds.contains(e.id))) {
        dupes.add(g);
        seenIds.addAll(g.map((e) => e.id));
      }
    }
    return dupes;
  }

  /// 返回备用区里所有与给定词条重名的条目（不含它自己）
  List<Entry> clashesFor(Entry target) {
    return _items.where((e) {
      if (e.id == target.id) return false;
      if (e.normalizedName == target.normalizedName && target.normalizedName.isNotEmpty) return true;
      if (e.normalizedEn.isNotEmpty && e.normalizedEn == target.normalizedEn) return true;
      return false;
    }).toList();
  }

  Map<String, dynamic> toJson() => {
        'count': _items.length,
        'items': _items.map((e) => e.toJson()).toList(),
        'duplicates': findDuplicateGroups()
            .map((g) => g.map((e) => {'id': e.id, 'name': e.name, 'source': e.source}).toList())
            .toList(),
      };
}
