/// 统一词条模型，对应 dnd-data/SCHEMA.md
library;

import '../util/text.dart';

class Entry {
  final String id;
  final String type; // spell / classFeature / feat / species / magicItem / equipment
  final String name;
  final String en;
  final String category;
  final List<String> tags;
  final String summary;
  final String text;
  final Map<String, String> fields;
  final String source;
  final Map<String, dynamic> cardRef;

  Entry({
    required this.id,
    required this.type,
    required this.name,
    this.en = '',
    this.category = '',
    this.tags = const [],
    this.summary = '',
    this.text = '',
    this.fields = const {},
    this.source = '',
    this.cardRef = const {},
  });

  factory Entry.fromJson(Map<String, dynamic> j) => Entry(
        id: (j['id'] ?? '').toString(),
        type: (j['type'] ?? '').toString(),
        name: (j['name'] ?? '').toString(),
        en: (j['en'] ?? '').toString(),
        category: (j['category'] ?? '').toString(),
        tags: (j['tags'] as List?)?.map((e) => e.toString()).toList() ?? const [],
        summary: (j['summary'] ?? '').toString(),
        text: (j['text'] ?? '').toString(),
        fields: (j['fields'] as Map?)?.map((k, v) => MapEntry(k.toString(), v.toString())) ?? const {},
        source: (j['source'] ?? '').toString(),
        cardRef: (j['cardRef'] as Map?)?.cast<String, dynamic>() ?? const {},
      );

  /// 查重用的归一化名称：去空白、去全角/半角标点差异、统一大小写
  String get normalizedName => normalizeKey(name);

  String get normalizedEn {
    var s = en.toLowerCase();
    s = s.replaceAll(RegExp(r'[^a-z0-9]'), '');
    return s;
  }

  /// 列表里显示的一行副标题
  String get subtitle {
    if (type == 'spell') {
      final bits = <String>[];
      final lv = fields['环阶'] ?? '';
      if (lv.isNotEmpty) bits.add(lv == '0' ? '戏法' : '$lv环');
      if ((fields['学派'] ?? '').isNotEmpty) bits.add(fields['学派']!);
      if (fields['专注'] == '是') bits.add('专注');
      if (fields['仪式'] == '是') bits.add('仪式');
      final cls = (fields['职业'] ?? '');
      if (cls.isNotEmpty) bits.add(cls);
      return bits.join(' · ');
    }
    final bits = <String>[];
    if (category.isNotEmpty) bits.add(category);
    if (source.isNotEmpty) bits.add(source);
    return bits.join(' · ');
  }

  /// 全文检索用的可搜索串（小写）
  late final String searchBlob = [
    name,
    en,
    category,
    source,
    tags.join(' '),
    fields.entries.map((e) => '${e.key} ${e.value}').join(' '),
    text,
  ].join('\n').toLowerCase();

  Map<String, dynamic> toJson() => {
        'id': id,
        'type': type,
        'name': name,
        'en': en,
        'category': category,
        'tags': tags,
        'summary': summary,
        'text': text,
        'fields': fields,
        'source': source,
        'cardRef': cardRef,
      };
}
