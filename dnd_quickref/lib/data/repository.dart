/// 词条仓库：载入 dnd-data 里的词条，提供检索与筛选。
///
/// 实际加载哪几类看 [dataFiles]。装备（`equipment.json`）也在这里面：
/// 「装备与背包」表单里点武器 / 护甲的名字时，要弹悬浮窗介绍它是什么。
library;

import 'dart:convert';
import 'dart:io';

import 'package:path/path.dart' as p;

import '../models/entry.dart';

class SearchHit {
  final Entry entry;
  final int score;
  SearchHit(this.entry, this.score);
}

class SearchResult {
  final List<Entry> items;
  final int total;
  SearchResult(this.items, this.total);
}

class Repository {
  final List<Entry> entries;
  final Map<String, Entry> byId;

  Repository._(this.entries)
      : byId = {for (final e in entries) e.id: e};

  static const dataFiles = [
    'spells.json',
    'class_features.json',
    'feats.json',
    'species.json',
    'magic_items.json',
    'equipment.json',
  ];

  static const typeLabels = {
    'spell': '法术',
    'classFeature': '职业特性',
    'feat': '专长',
    'species': '种族特性',
    'magicItem': '魔法物品',
    'equipment': '装备',
  };

  static Future<Repository> load(String dir) async {
    final all = <Entry>[];
    for (final name in dataFiles) {
      final f = File(p.join(dir, name));
      if (!await f.exists()) continue;
      final raw = jsonDecode(await f.readAsString());
      if (raw is! List) continue;
      for (final item in raw) {
        all.add(Entry.fromJson((item as Map).cast<String, dynamic>()));
      }
    }
    return Repository._(all);
  }

  List<Entry> ofType(String type) => entries.where((e) => e.type == type).toList();

  /// 各类型的条目数（只列存在的类型）
  Map<String, int> typeCounts() {
    final m = <String, int>{};
    for (final e in entries) {
      m[e.type] = (m[e.type] ?? 0) + 1;
    }
    return m;
  }

  /// 某一字段的所有取值 + 计数，用于生成筛选下拉
  Map<String, int> facet(String type, String field) {
    final m = <String, int>{};
    final wantType = (type.isEmpty || type == 'all') ? null : type;
    for (final e in entries) {
      if (wantType != null && e.type != wantType) continue;
      final vals = <String>[];
      if (field == 'type' || field == '类型') {
        vals.add(typeLabels[e.type] ?? e.type);
      } else if (field == 'category') {
        vals.add(e.category);
      } else if (field == 'source') {
        vals.add(e.source);
      } else if (field == 'tag') {
        vals.addAll(e.tags);
      } else {
        final v = e.fields[field];
        if (v != null && v.isNotEmpty) vals.add(v);
      }
      for (final v in vals) {
        if (v.isEmpty) continue;
        // 职业是多值「术士、法师」，拆开统计
        for (final part in v.split(RegExp(r'[、,，/]'))) {
          final t = part.trim();
          if (t.isEmpty) continue;
          m[t] = (m[t] ?? 0) + 1;
        }
      }
    }
    return m;
  }

  bool _matchesFilters(Entry e, Map<String, String> filters) {
    for (final f in filters.entries) {
      final want = f.value;
      if (want.isEmpty) continue;
      switch (f.key) {
        case '类型':
          if ((typeLabels[e.type] ?? e.type) != want) return false;
          break;
        case 'category':
          if (e.category != want) return false;
          break;
        case 'source':
          if (e.source != want) return false;
          break;
        case 'tag':
          if (!e.tags.contains(want)) return false;
          break;
        case '职业':
          final v = e.fields['职业'] ?? '';
          final has = e.tags.contains(want) || v.split(RegExp(r'[、,，/]')).map((s) => s.trim()).contains(want);
          if (!has) return false;
          break;
        default:
          if ((e.fields[f.key] ?? '') != want) return false;
      }
    }
    return true;
  }

  int _score(Entry e, String q, List<String> terms) {
    final name = e.name.toLowerCase();
    final en = e.en.toLowerCase();
    var score = 0;
    if (q.isNotEmpty) {
      if (name == q) {
        score += 1000;
      } else if (name.startsWith(q)) {
        // 「火球术」要排在「延迟爆裂火球」前面
        score += 600;
      } else if (name.contains(q)) {
        score += 300;
      }
      if (en.isNotEmpty && en.contains(q)) score += 150;
      final first = terms.isEmpty ? q : terms.first;
      if (first.isNotEmpty) {
        var count = 0;
        var idx = e.text.toLowerCase().indexOf(first);
        while (idx >= 0 && count < 20) {
          count++;
          idx = e.text.toLowerCase().indexOf(first, idx + first.length);
        }
        score += count * 5;
      }
    }
    // 条目越短越可能是「专门讲这个」的条目
    score -= (e.text.length / 2000).floor();
    return score;
  }

  SearchResult search({
    String? type,
    String q = '',
    Map<String, String> filters = const {},
    int limit = 200,
    int offset = 0,
  }) {
    final query = q.trim().toLowerCase();
    final terms = query.isEmpty ? <String>[] : query.split(RegExp(r'\s+')).where((t) => t.isNotEmpty).toList();
    final hits = <SearchHit>[];
    // type 为空或 'all' = 全部速查，不分类型
    final wantType = (type == null || type.isEmpty || type == 'all') ? null : type;
    for (final e in entries) {
      if (wantType != null && e.type != wantType) continue;
      if (!_matchesFilters(e, filters)) continue;
      if (terms.isNotEmpty) {
        var ok = true;
        for (final t in terms) {
          if (!e.searchBlob.contains(t)) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
      }
      hits.add(SearchHit(e, _score(e, query, terms)));
    }
    hits.sort((a, b) {
      final c = b.score.compareTo(a.score);
      return c != 0 ? c : a.entry.name.compareTo(b.entry.name);
    });
    final total = hits.length;
    final items = hits.skip(offset).take(limit).map((h) => h.entry).toList();
    return SearchResult(items, total);
  }
}
