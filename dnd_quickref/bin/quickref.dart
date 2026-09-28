/// 法术速查填表工具（本地服务）：`dart run bin/quickref.dart`
///
/// 浏览器打开 http://127.0.0.1:8765 即为界面。左边法术列表 / 中间法术详情 /
/// 右边填入区；填入区底部可以「新建表格 / 使用已有表格」（走 Windows 原生
/// 打开/另存为对话框），点「填入表格」就把填入区里的法术写进那张表。
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:dnd_quickref/data/card_lists.dart';
import 'package:dnd_quickref/data/repository.dart';
import 'package:dnd_quickref/models/entry.dart';
import 'package:dnd_quickref/staging/tray.dart';
import 'package:dnd_quickref/util/text.dart';
import 'package:dnd_quickref/xlsx/patcher.dart';
import 'package:path/path.dart' as p;

/// 自己所在的目录。`dart run bin/quickref.dart` 时是 `…\dnd_quickref\bin`，
/// 编成 exe 之后就是那个 exe 所在的目录。
late final String _selfDir = () {
  final start = Platform.script.toFilePath();
  final isExe = start.toLowerCase().endsWith('.exe');
  return p.dirname(isExe ? start : p.dirname(start));
}();

/// 开发目录下的工作区：从自己往上找，哪一层里有 `dnd_quickref\web\index.html`。
/// 找不到就说明这是**便携版**——web / dnd-data / card 都跟自己同级。
String? _devWorkspace() {
  var dir = _selfDir;
  for (var i = 0; i < 5; i++) {
    if (File(p.join(dir, 'dnd_quickref', 'web', 'index.html')).existsSync()) return dir;
    final parent = p.dirname(dir);
    if (parent == dir) break;
    dir = parent;
  }
  return null;
}

late final String? _devRoot = _devWorkspace();

/// 自己检测出来的默认值（没给 `--workspace` 时就用它）
late final String _autoWorkspaceRoot = _devRoot ?? _selfDir;
late final String _autoAppRoot =
    _devRoot == null ? _selfDir : p.join(_autoWorkspaceRoot, 'dnd_quickref');

/// 工作区目录（`dnd-data\` `card\` 在哪儿）；便携版就是自己所在的目录
late String kWorkspaceRoot = _autoWorkspaceRoot;

/// 应用目录（`web\` 界面文件与 `.quickref.json` 在哪儿）
late String kAppRoot = _autoAppRoot;

/// 界面目录（`index.html` 在哪儿）；可用 `--web` 改
late String kWebDir = p.join(kAppRoot, 'web');

/// `--workspace <目录>`：指一个自包含的目录，省得靠目录层级猜。
///
/// 那目录里有 `web\` 就把它当应用根（打包出来的独立版就是这种），
/// 只有 `dnd_quickref\web\` 就说明给的是工作区根（开发目录）。
void kUseWorkspace(String dir) {
  kWorkspaceRoot = p.normalize(p.absolute(dir));
  kAppRoot = Directory(p.join(kWorkspaceRoot, 'web')).existsSync()
      ? kWorkspaceRoot
      : p.join(kWorkspaceRoot, 'dnd_quickref');
  kWebDir = p.join(kAppRoot, 'web');
}

/// 便携版：web / dnd-data / card 全跟自己放一起，换台电脑、拷到 U 盘都能跑
bool get kPortable => _devRoot == null;

/// 法术词条目录
late String kDataDir = p.join(kWorkspaceRoot, 'dnd-data');

/// 「新建表格」用的空白模板：`card\空白卡*.xlsx` 里**版本号最高**的那一份。
///
/// 卡是「似雨悲灵」的自动卡，文件名带版本：`空白卡v1.1.1.xlsx` 是当前基准，
/// `空白卡v1.0.12.xlsx` / `空白卡.xlsx`（v1.0.0）是旧版式，只留作参考。
/// 三个版本的「主要」表格子位置并不一样（技能表分别从 **40 / 41 / 32** 行开始，
/// 战斗块、法术块也各挪过），所以挑模板不能写死文件名——按版本号挑，
/// 以后往 `card\` 里丢一份更新的空白卡就自动升级。
String _pickTemplate(String cardDir) {
  var best = '';
  var bestKey = -1;
  try {
    for (final f in Directory(cardDir).listSync().whereType<File>()) {
      final name = p.basename(f.path);
      if (!name.toLowerCase().endsWith('.xlsx') || !name.startsWith('空白卡')) continue;
      final m = RegExp(r'v(\d+)\.(\d+)(?:\.(\d+))?').firstMatch(name);
      final key = m == null
          ? 0
          : int.parse(m.group(1)!) * 10000 +
              int.parse(m.group(2)!) * 100 +
              int.parse(m.group(3) ?? '0');
      if (key > bestKey) {
        bestKey = key;
        best = f.path;
      }
    }
  } catch (_) {}
  return best.isEmpty ? p.join(cardDir, '空白卡v1.1.1.xlsx') : best;
}

late String kTemplatePath = _pickTemplate(p.join(kWorkspaceRoot, 'card'));

/// 默认目标表格。界面里选过的表记在 `.quickref.json`，下次启动优先用它；
/// 但命令行明写了 `--card` 时以命令行为准（`--card` 是"这次就用这张"）。
/// 便携版里没有「悲灵.xlsx」，就挑 card\ 里第一张不像模板的卡；
/// 一张都没有（只有空白模板）就返回空串，由 main() 复制一张新的出来。
String _pickDefaultTable(String cardDir) {
  final preferred = p.join(cardDir, '悲灵.xlsx');
  if (File(preferred).existsSync()) return preferred;
  try {
    final xs = Directory(cardDir)
        .listSync()
        .whereType<File>()
        .where((f) => f.path.toLowerCase().endsWith('.xlsx'))
        .where((f) => !p.basename(f.path).startsWith('空白卡'))
        .toList()
      ..sort((a, b) => a.path.compareTo(b.path));
    if (xs.isNotEmpty) return xs.first.path;
  } catch (_) {}
  return '';
}

late String kDefaultTable = _pickDefaultTable(p.join(kWorkspaceRoot, 'card'));

/// 当前目标表格
late String kTable = kDefaultTable;

late Repository repo;

/// 每个词条页有自己的填入区（法术 / 职业 / 种族 / 专长 各攒各的）
final tray = Tray();
final trays = <String, Tray>{
  'class': Tray(),
  'species': Tray(),
  'feat': Tray(),
};

Tray _trayFor(Object? kind) {
  final k = kind?.toString() ?? 'spell';
  if (k == 'spell' || k.isEmpty) return tray;
  return trays.putIfAbsent(k, Tray.new);
}

/// 职业页的一切都写在「主要」表：主职业 E6 / 子职业 I6 / 等级 O6，
/// 特性名称写进主要表的名称输入列（本卡是 AX17:AX45），「职业」表只当数据源。
const kMainSheet = '主要';
const kClassSheet = '职业';

/// 本次会话里新建出来的表：写它不必再备份
final _createdThisSession = <String>{};

const filterAliases = {
  'lvl': '环阶',
  'school': '学派',
  'cls': '职业',
  'sub': '子职',
  'level': '等级',
  'src': '来源',
  'cat': 'category',
  'tag': 'tag',
  'kind': '类型',
};

const kSpellSheet = '法术书';
const kDictSheet = '法术大全';

Future<void> main(List<String> args) async {
  // 先定目录：`--workspace` 指的目录可以是「工作区根」，也可以是打包出来的
  // 独立目录（web\ dnd-data\ card\ 都跟自己同级）。
  final wsArg = _arg(args, '--workspace');
  if (wsArg != null && wsArg.isNotEmpty) kUseWorkspace(wsArg);
  final webArg = _arg(args, '--web');
  if (webArg != null && webArg.isNotEmpty) kWebDir = p.normalize(p.absolute(webArg));

  kDataDir = _arg(args, '--data') ?? kDataDir;
  kTemplatePath = _arg(args, '--template') ?? kTemplatePath;
  // 命令行明写了 `--card` 就以它为准：下面读回来那句「上次用的是哪张表」
  // 只该在没人指定目标表时生效，否则 `--card` 会被悄悄顶掉，
  // 以为在写临时副本、其实写进了上次那张卡。
  final cardArg = _arg(args, '--card');
  kDefaultTable = cardArg ?? kDefaultTable;
  kTable = kDefaultTable;
  final port = int.tryParse(_arg(args, '--port') ?? '') ?? 8765;
  final open = !args.contains('--no-open');

  final remembered = await _loadConfig();
  if (remembered != null && cardArg == null) kTable = remembered;
  // 目标表不在了（便携版第一次跑、或者卡被挪走）：拿空白模板复制一张新的出来
  if (!await File(kTable).existsSync() && await File(kTemplatePath).existsSync()) {
    final fresh = p.join(p.dirname(kTemplatePath), '新人物卡.xlsx');
    if (!await File(fresh).existsSync()) {
      try {
        await File(kTemplatePath).copy(fresh);
      } catch (_) {}
    }
    if (await File(fresh).existsSync()) kTable = fresh;
  }

  repo = await Repository.load(kDataDir);
  stdout.writeln('载入词条 ${repo.entries.length} 条  ${repo.typeCounts()}');
  stdout.writeln('目标表格 $kTable');

  final webDir = kWebDir;
  stdout.writeln('界面目录 $webDir');
  if (!await File(p.join(webDir, 'index.html')).exists()) {
    // 包没打全（少了 web\）时，服务照样起来，但别再让人对着一个光秃秃的
    // 404 发懵：下面这段会同时打到控制台和浏览器里。
    stdout.writeln(_missingWebText(webDir));
  }

  HttpServer? server;
  var actualPort = port;
  for (var candidate = port; candidate < port + 10; candidate++) {
    try {
      server = await HttpServer.bind(InternetAddress.loopbackIPv4, candidate);
      actualPort = candidate;
      break;
    } on SocketException {
      stdout.writeln('端口 $candidate 已被占用，尝试下一个…');
    }
  }
  if (server == null) {
    stderr.writeln('端口 $port ~ ${port + 9} 全部被占用。请用 --port <其它端口> 指定。');
    exit(2);
  }

  final url = 'http://127.0.0.1:$actualPort/';
  stdout.writeln('速查填表服务已启动: $url');
  stdout.writeln('按 Ctrl+C 或直接关掉这个窗口即可停止服务。');
  if (open) {
    try {
      await Process.start('cmd', ['/c', 'start', '', url],
          runInShell: true, mode: ProcessStartMode.detached);
    } catch (e) {
      stdout.writeln('（未能自动打开浏览器：$e）请手动访问上面的地址');
    }
  }

  await for (final req in server) {
    try {
      await _handle(req, webDir);
    } on FormatException catch (e) {
      await _json(req, {'error': e.message}, status: 400);
    } on ArgumentError catch (e) {
      // 里层抛出来的参数错（最常见的是「工作表不存在」）不该当成 500 内部错误甩给用户
      await _json(req,
          {'error': '这张卡里没有要写的那张表：${e.message}。换一张本系列的卡，或者别填这一页。'},
          status: 400);
    } catch (e, st) {
      stderr.writeln('请求出错 ${req.uri}: $e\n$st');
      try {
        req.response.statusCode = 500;
        req.response.write('内部错误: $e');
        await req.response.close();
      } catch (_) {}
    }
  }
}

String? _arg(List<String> args, String name) {
  final i = args.indexOf(name);
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  return null;
}

/// 写表要串行：每个写接口都是「读出整份 xlsx → 改 → 写回」，
/// 两个请求交错时后写的会把先写的覆盖掉。POST 一律排队执行。
Future<void> _writeQueue = Future<void>.value();

Future<void> _serializeWrite(Future<void> Function() body) {
  final next = _writeQueue.then((_) => body());
  _writeQueue = next.catchError((_) {});
  return next;
}

Future<void> _handle(HttpRequest req, String webDir) async {
  if (req.uri.path.startsWith('/api/')) {
    if (req.method == 'POST') {
      await _serializeWrite(() => _api(req, req.uri));
    } else {
      await _api(req, req.uri);
    }
    return;
  }
  await _static(req, webDir);
}

// ---------------------------------------------------------------- static
const _mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

Future<void> _static(HttpRequest req, String webDir) async {
  var rel = Uri.decodeComponent(req.uri.path);
  if (rel.isEmpty || rel == '/') rel = '/index.html';
  final segs = rel.split('/').where((s) => s.isNotEmpty && s != '.').toList();
  if (segs.any((s) => s == '..')) {
    req.response.statusCode = 403;
    req.response.write('403');
    await req.response.close();
    return;
  }
  final file = File(p.joinAll([webDir, ...segs]));
  if (!await file.exists()) {
    if (p.basename(file.path).toLowerCase() == 'index.html') {
      // 界面文件不在：多半是这份包没打全，说清楚比甩个 404 有用
      req.response.headers.contentType = ContentType.html;
      req.response.write(_missingWebHtml(webDir));
      await req.response.close();
      return;
    }
    req.response.statusCode = 404;
    req.response.write('404 $rel');
    await req.response.close();
    return;
  }
  req.response.headers.contentType =
      ContentType.parse(_mime[p.extension(file.path)] ?? 'application/octet-stream');
  // 本地小工具：别让浏览器留着旧的 html/js/css，改了却看不到才最坑
  req.response.headers.set('Cache-Control', 'no-store, must-revalidate');
  await req.response.addStream(file.openRead());
  await req.response.close();
}

/// 界面目录里没有 `index.html` 时，控制台里打这段。
String _missingWebText(String webDir) {
  final b = StringBuffer();
  b.writeln('');
  b.writeln('╭─ 界面文件缺失 ─────────────────────────────────────');
  b.writeln('│ 这里找不到 index.html：');
  b.writeln('│   $webDir');
  b.writeln('│');
  b.writeln('│ 多半是这份包没打全——它旁边应该有 web\\、dnd-data\\、card\\ 三个目录。');
  b.writeln('│ 或者手工指路：quickref.exe --workspace <有 web\\ 的目录>');
  b.writeln('│');
  b.writeln('│ 现在认的目录：');
  b.writeln('│   工作区 $kWorkspaceRoot');
  b.writeln('│   应用   $kAppRoot');
  b.writeln('│   词条   $kDataDir');
  b.writeln('│   模板   $kTemplatePath');
  b.writeln('╰────────────────────────────────────────────────────');
  return b.toString();
}

/// 浏览器里看到的那一版说明（比 404 页面能看懂）。
String _missingWebHtml(String webDir) {
  String esc(String s) => s
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');
  return '''
<!doctype html>
<html lang="zh-CN"><meta charset="utf-8">
<title>界面文件缺失</title>
<style>
  body{background:#1b1b1f;color:#e6e6e9;font:15px/1.7 "Microsoft YaHei",system-ui;
       margin:0;padding:48px 56px}
  h1{font-size:20px;margin:0 0 4px}
  p{margin:14px 0;color:#c9c9cf}
  code{background:#2a2a31;padding:2px 6px;border-radius:4px;
       font-family:Consolas,monospace;color:#ffd9a0}
  table{border-collapse:collapse;margin:18px 0}
  td{padding:4px 14px 4px 0;color:#c9c9cf;font-family:Consolas,monospace}
</style>
<h1>这个服务起来了，但界面文件不在</h1>
<p>找不到 <code>index.html</code>：<code>${esc(webDir)}</code></p>
<p>这份包多半没打全。一个能独立运行的包里，<code>quickref.exe</code> 旁边
   应该有 <code>web\\</code>、<code>dnd-data\\</code>、<code>card\\</code> 三个目录。</p>
<table>
  <tr><td>工作区</td><td>${esc(kWorkspaceRoot)}</td></tr>
  <tr><td>应用</td><td>${esc(kAppRoot)}</td></tr>
  <tr><td>词条</td><td>${esc(kDataDir)}</td></tr>
  <tr><td>模板</td><td>${esc(kTemplatePath)}</td></tr>
</table>
<p>也可以手工指路：<code>quickref.exe --workspace &lt;有 web\\ 的目录&gt;</code></p>
</html>
''';
}

// ---------------------------------------------------------------- 工具
Future<void> _json(HttpRequest req, Object body, {int status = 200}) async {
  req.response.statusCode = status;
  req.response.headers.contentType = ContentType('application', 'json', charset: 'utf-8');
  req.response.write(jsonEncode(body));
  await req.response.close();
}

Future<Map<String, dynamic>> _body(HttpRequest req) async {
  final text = await utf8.decoder.bind(req).join();
  if (text.trim().isEmpty) return {};
  try {
    final j = jsonDecode(text);
    return (j as Map).cast<String, dynamic>();
  } catch (e) {
    throw FormatException('请求体不是合法 JSON（Windows 路径里的反斜杠要转义）：$e');
  }
}

Map<String, String> _filters(HttpRequest req) {
  final out = <String, String>{};
  filterAliases.forEach((alias, field) {
    final v = req.uri.queryParameters[alias];
    if (v != null && v.isNotEmpty) out[field] = v;
  });
  return out;
}

/// 请求体里的名字列表：没给就用 [fallback]；顺手丢掉 null / 空白项
List<String> _nameList(Object? raw, List<String> fallback) {
  if (raw is! List) return fallback;
  final out = raw
      .where((e) => e != null)
      .map((e) => e.toString().trim())
      .where((s) => s.isNotEmpty)
      .toList();
  return out.isEmpty ? fallback : out;
}

Map<String, dynamic> _brief(Entry e) => {
      'id': e.id,
      'type': e.type,
      'typeLabel': Repository.typeLabels[e.type] ?? e.type,
      'name': e.name,
      'en': e.en,
      'category': e.category,
      'subtitle': e.subtitle,
      'summary': e.summary,
      'inTray': tray.contains(e.id),
    };

// ---------------------------------------------------------------- api
Future<void> _api(HttpRequest req, Uri uri) async {
  final path = uri.path;

  if (path == '/api/meta') {
    final facets = <String, Map<String, Map<String, int>>>{
      'spell': {
        for (final f in ['环阶', '学派', '职业']) f: repo.facet('spell', f),
        '来源': repo.facet('spell', 'source'),
      },
      'classFeature': {
        for (final f in ['职业', '等级', '子职']) f: repo.facet('classFeature', f),
        '来源': repo.facet('classFeature', 'source'),
      },
      'feat': {
        'category': repo.facet('feat', 'category'),
        '来源': repo.facet('feat', 'source'),
      },
      'species': {
        'category': repo.facet('species', 'category'),
        '来源': repo.facet('species', 'source'),
      },
    };
    return _json(req, {
      // 前端用它判断「服务端是不是刚重启过的那个版本」，对不上会直接提示重启。
      // 改了 Dart 侧的行为（新接口、新字段）就把这个数字加一。
      'api': 6,
      'total': repo.entries.length,
      'counts': repo.typeCounts(),
      'typeLabels': Repository.typeLabels,
      'facets': facets,
      'template': {'path': kTemplatePath, 'exists': await File(kTemplatePath).exists()},
      'table': kTable,
      // 出问题时第一时间要看的东西：这份服务到底认的哪几个目录
      'paths': {
        'workspace': kWorkspaceRoot,
        'app': kAppRoot,
        'web': kWebDir,
        'data': kDataDir,
        'portable': kPortable,
      },
    });
  }

  // 「致谢」那一页：这张人物卡的作者是谁、怎么联系（从卡里的「更新」表认出来）
  if (path == '/api/credits') {
    return _json(req, await _creditsJson());
  }

  if (path == '/api/search') {
    final type = uri.queryParameters['type'] ?? 'spell';
    final q = uri.queryParameters['q'] ?? '';
    final limit = int.tryParse(uri.queryParameters['limit'] ?? '') ?? 300;
    final res = repo.search(type: type, q: q, filters: _filters(req), limit: limit);
    return _json(req, {
      'total': res.total,
      'items': res.items.map(_brief).toList(),
    });
  }

  if (path == '/api/entry') {
    final id = uri.queryParameters['id'] ?? '';
    final e = repo.byId[id];
    if (e == null) return _json(req, {'error': '未找到法术 $id'}, status: 404);
    return _json(req, {
      'entry': e.toJson(),
      'inTray': _trayFor(uri.queryParameters['kind']).contains(e.id),
    });
  }

  if (path == '/api/tray') {
    return _json(req, _trayFor(uri.queryParameters['kind']).toJson());
  }

  if (path == '/api/tray/add' && req.method == 'POST') {
    final b = await _body(req);
    final t = _trayFor(b['kind']);
    final e = repo.byId[b['id']?.toString() ?? ''];
    if (e == null) return _json(req, {'error': '未找到词条'}, status: 404);
    final r = t.add(e);
    return _json(req, {
      'result': r.name,
      'clashes': t.clashesFor(e).map((x) => x.name).toList(),
      'tray': t.toJson(),
    });
  }

  if (path == '/api/tray/remove' && req.method == 'POST') {
    final b = await _body(req);
    final t = _trayFor(b['kind']);
    t.remove(b['id']?.toString() ?? '');
    return _json(req, {'tray': t.toJson()});
  }

  if (path == '/api/tray/clear' && req.method == 'POST') {
    final t = _trayFor((await _body(req))['kind']);
    t.clear();
    return _json(req, {'tray': t.toJson()});
  }

  // ---------------------------------------------------------- 卡里的条目 → 规则正文
  if (path == '/api/rule' && req.method == 'GET') {
    final kind = uri.queryParameters['kind'] ?? 'subclass';
    final cls = (uri.queryParameters['cls'] ?? '').trim();
    final name = (uri.queryParameters['sub'] ?? uri.queryParameters['name'] ?? '').trim();
    final rules = await _cardRules();
    final hit = rules['$kind|$cls|$name'];
    if (hit == null) {
      return _json(req, {
        'found': false,
        'kind': kind,
        'name': name,
        'reason': rules.isEmpty ? '规则库没加载' : '规则库里没有这一条',
      });
    }
    return _json(req, {'found': true, ...hit});
  }

  if (path == '/api/background/fill' && req.method == 'POST') {
    final b = await _body(req);
    final raw = (b['effects'] as List?) ?? const [];
    final effects = <({String label, String text})>[
      for (final x in raw)
        if (x is Map)
          (label: (x['label'] ?? '').toString(), text: (x['text'] ?? '').toString()),
    ].where((e) => e.label.isNotEmpty && e.text.isNotEmpty).toList();
    if (effects.isEmpty) return _json(req, {'error': '没有要写的内容'}, status: 400);

    final target = p.normalize(kTable);
    final src = File(target);
    if (!await src.exists()) {
      return _json(req, {'error': '目标表格不存在：$target（先在填入区底部新建或选一张）'}, status: 400);
    }
    String? backup;
    if (!_createdThisSession.contains(target)) {
      try {
        backup = await _backup(target);
      } catch (e) {
        return _json(req, {'error': '备份失败，为安全起见没有写入：$e'}, status: 500);
      }
    }
    try {
      final patcher = XlsxPatcher.open(await src.readAsBytes());
      // 技能行从这张卡里认（老版式卡在 32–53 行），写死会把「运动」的勾打到「自然」上
      final plan = planBackgroundEffects(patcher, effects,
          skillRows: _recognizeAttrAndSkills(patcher).skills);
      // 换出身时先把上一次这个来源写进去的格子还原，免得新旧堆在一起
      final undo = _planUndo(patcher, 'background');
      final all = <String, Map<String, String>>{};
      for (final e in undo.writes.entries) {
        (all[e.key] ??= {}).addAll(e.value);
      }
      for (final e in plan.writes.entries) {
        (all[e.key] ??= {}).addAll(e.value);
      }
      if (all.isNotEmpty) {
        List<int> bytes = await src.readAsBytes();
        for (final e in all.entries) {
          bytes = XlsxPatcher.open(bytes).writeCells(e.key, e.value);
        }
        await src.writeAsBytes(bytes);
      }
      await _rememberEffectWrites('background', _effectRecord(patcher, plan.written));
      _dropTableCaches();
      return await _json(req, {
        'ok': true,
        'table': target,
        'backup': backup,
        'written': plan.written,
        'undone': undo.restored,
        'unmapped': plan.unmapped,
        'note': '卡里靠公式算的格子（例如「背景收益」那几行）不会立刻跟着变，用 Excel 打开一次就会重算。',
      });
    } on FileSystemException catch (e) {
      return _json(req, {'error': '写不进去（这张表可能正在 Excel 里开着，先关掉再试）：${e.message}'},
          status: 409);
    }
  }

  if (path == '/api/class/fill' && req.method == 'POST') {
    final b = await _body(req);
    final raw = (b['effects'] as List?) ?? const [];
    final effects = <({String label, String text, bool panel})>[
      for (final x in raw)
        if (x is Map)
          (
            label: (x['label'] ?? '').toString(),
            text: (x['text'] ?? '').toString(),
            panel: x['panel'] == true,
          ),
    ].where((e) => e.label.isNotEmpty && e.text.isNotEmpty).toList();
    if (effects.isEmpty) return _json(req, {'error': '没有要写的内容'}, status: 400);

    final target = p.normalize(kTable);
    final src = File(target);
    if (!await src.exists()) {
      return _json(req, {'error': '目标表格不存在：$target（先在填入区底部新建或选一张）'}, status: 400);
    }
    String? backup;
    if (!_createdThisSession.contains(target)) {
      try {
        backup = await _backup(target);
      } catch (e) {
        return _json(req, {'error': '备份失败，为安全起见没有写入：$e'}, status: 500);
      }
    }
    try {
      final patcher = XlsxPatcher.open(await src.readAsBytes());
      final plan = planClassEffects(patcher, effects,
          skillRows: _recognizeAttrAndSkills(patcher).skills);
      // 换主职业 / 子职业时同理：先还原上一次这个来源写的格子
      final undo = _planUndo(patcher, 'class');
      final all = <String, Map<String, String>>{};
      for (final e in undo.writes.entries) {
        (all[e.key] ??= {}).addAll(e.value);
      }
      for (final e in plan.writes.entries) {
        (all[e.key] ??= {}).addAll(e.value);
      }
      if (all.isNotEmpty) {
        List<int> bytes = await src.readAsBytes();
        for (final e in all.entries) {
          bytes = XlsxPatcher.open(bytes).writeCells(e.key, e.value);
        }
        await src.writeAsBytes(bytes);
      }
      await _rememberEffectWrites('class', _effectRecord(patcher, plan.written));
      _dropTableCaches();
      return await _json(req, {
        'ok': true,
        'table': target,
        'backup': backup,
        'written': plan.written,
        'undone': undo.restored,
        'auto': plan.auto,
        'unmapped': plan.unmapped,
      });
    } on FileSystemException catch (e) {
      return _json(req, {'error': '写不进去（这张表可能正在 Excel 里开着，先关掉再试）：${e.message}'},
          status: 409);
    }
  }

  // ---------------------------------------------------------- 熟练打圈
  /// 种族特性 / 专长里那种「A、B 或 C 之一技能的熟练」——玩家在界面上挑完之后，
  /// 挑中的那个名字送到这儿打 `O`。技能表 / 属性表都是从卡里认出来的行，不写死行号。
  if (path == '/api/prof/fill' && req.method == 'POST') {
    final b = await _body(req);
    List<String> listOf(Object? v) => (v as List?)
            ?.map((x) => x.toString().trim())
            .where((s) => s.isNotEmpty)
            .toList() ??
        const <String>[];
    final skills = listOf(b['skills']);
    final saves = listOf(b['saves']);
    if (skills.isEmpty && saves.isEmpty) {
      return _json(req, {'error': '没有要打的熟练'}, status: 400);
    }
    final target = p.normalize(kTable);
    final src = File(target);
    if (!await src.exists()) {
      return _json(req, {'error': '目标表格不存在：$target（先在下面新建或选一张）'}, status: 400);
    }
    try {
      final patcher = XlsxPatcher.open(await src.readAsBytes());
      final rs = _recognizeAttrAndSkills(patcher);
      final writes = <String, String>{};
      final written = <Map<String, String>>[];
      final unmapped = <String>[];
      for (final name in skills) {
        final hit = rs.skills.entries.where((x) => x.value == name).toList();
        if (hit.isEmpty) {
          unmapped.add('技能「$name」没在技能表里找到，没打勾');
          continue;
        }
        final cell = 'B${hit.first.key}';
        writes[cell] = 'O';
        written.add({'label': '技能熟练', 'sheet': kMainSheet, 'cell': cell, 'value': 'O', 'name': name});
      }
      for (final name in saves) {
        final hit = rs.attrs.entries.where((x) => x.value == name).toList();
        if (hit.isEmpty) {
          unmapped.add('属性「$name」没在属性表里找到，没打勾');
          continue;
        }
        final cell = 'B${hit.first.key}';
        writes[cell] = 'O';
        written.add({'label': '豁免熟练', 'sheet': kMainSheet, 'cell': cell, 'value': 'O', 'name': name});
      }
      String? backup;
      if (writes.isNotEmpty) {
        if (!_createdThisSession.contains(target)) {
          try {
            backup = await _backup(target);
          } catch (e) {
            return await _json(req, {'error': '备份失败，为安全起见没有写入：$e'}, status: 500);
          }
        }
        List<int> bytes = await src.readAsBytes();
        bytes = XlsxPatcher.open(bytes).writeCells(kMainSheet, writes);
        await src.writeAsBytes(bytes);
        _dropTableCaches();
      }
      return await _json(req, {
        'ok': true,
        'table': target,
        'backup': backup,
        'written': written,
        'unmapped': unmapped,
      });
    } on FileSystemException catch (e) {
      return _json(req, {'error': '写不进去（这张表可能正在 Excel 里开着，先关掉再试）：${e.message}'},
          status: 409);
    }
  }

  // ---------------------------------------------------------- 目标表格
  if (path == '/api/table' && req.method == 'GET') {
    return _json(req, await _tableJson(refresh: uri.queryParameters['refresh'] == '1'));
  }

  if (path == '/api/table/open' && req.method == 'POST') {
    final b = await _body(req);
    final dir = (b['dir']?.toString().isNotEmpty ?? false)
        ? b['dir'].toString()
        : p.dirname(kTable);
    final picked = await _nativePick(mode: 'open', dir: dir, name: p.basename(kTable));
    if (picked == null) return _json(req, {'ok': false, 'cancelled': true});
    final err = await _setTable(picked, mustExist: true);
    if (err != null) return _json(req, {'error': err}, status: 400);
    return _json(req, {'ok': true, 'cancelled': false, 'table': await _tableJson(refresh: true)});
  }

  if (path == '/api/table/new' && req.method == 'POST') {
    final b = await _body(req);
    final dir = (b['dir']?.toString().isNotEmpty ?? false)
        ? b['dir'].toString()
        : p.dirname(kTable);
    final name = (b['name']?.toString().trim().isNotEmpty ?? false)
        ? b['name'].toString().trim()
        : '新人物卡.xlsx';
    final picked = await _nativePick(mode: 'save', dir: dir, name: name);
    if (picked == null) return _json(req, {'ok': false, 'cancelled': true});
    final created = await _createFromTemplate(picked, overwrite: true);
    if (created != null) return _json(req, {'error': created}, status: 400);
    return _json(req, {'ok': true, 'cancelled': false, 'table': await _tableJson(refresh: true)});
  }

  // 手动选择（原生对话框不可用时的退路）
  if (path == '/api/table/use' && req.method == 'POST') {
    final b = await _body(req);
    final target = (b['path'] ?? '').toString().trim();
    if (target.isEmpty) return _json(req, {'error': '缺少 path'}, status: 400);
    final err = await _setTable(target, mustExist: true);
    if (err != null) return _json(req, {'error': err}, status: 400);
    return _json(req, {'ok': true, 'table': await _tableJson(refresh: true)});
  }

  // 把这张卡初始化成空卡：
  //   · 所有可填字段清空
  //   · X/O、是/否、下拉这些选择格 → **基准空白卡里那一格的值**
  //     （熟练默认 X、是否默认 否、出身默认 自定义背景；卡自己把武器熟练
  //      预置成 O，也照跟——初始化后的卡要和基准空白卡一模一样）
  //   · 词条列清空
  // 公式格、以及卡自己的结构行（职业能力面板那几行标签等）都不碰。
  if (path == '/api/card/reset' && req.method == 'POST') {
    final target = p.normalize(kTable);
    final src = File(target);
    if (!await src.exists()) {
      return _json(req, {'error': '目标表格不存在：$target（先在下面新建或选一张）'}, status: 400);
    }
    String? backup;
    if (!_createdThisSession.contains(target)) {
      try {
        backup = await _backup(target);
      } catch (e) {
        return _json(req, {'error': '备份失败，为安全起见没有写入：$e'}, status: 500);
      }
    }
    try {
      final patcher = XlsxPatcher.open(await src.readAsBytes());
      // 空白模板：用来知道"卡自己的默认值"（比如出身那一格填的是「自定义背景」）
      XlsxPatcher? tpl;
      try {
        final tplFile = File(kTemplatePath);
        if (await tplFile.exists()) tpl = XlsxPatcher.open(await tplFile.readAsBytes());
      } catch (_) {}
      final writes = <String, Map<String, String>>{};
      final formulaCache = <String, Set<String>>{};
      Set<String> fx(String s) => formulaCache[s] ??= patcher.formulaRefs(s);
      final kept = <String>[];   // 看着像内容、但认不出是词条，没动的格子
      var skillCount = 0, yesNoCount = 0, fieldCount = 0, entryCount = 0, formulaCount = 0;

      void put(String sheet, String cell, String value) {
        if (cell.isEmpty || !patcher.hasSheet(sheet)) return;
        if (fx(sheet).contains(cell)) {
          formulaCount++;
          return;
        }
        (writes[sheet] ??= {})[cell] = value;
      }

      // 1) 所有可填字段清空；熟练打 X、是/否打「否」、选择格用模板的默认值
      for (final key in ['basic', 'origin', 'gear', 'magic']) {
        for (final f in await _formFields(key, target) ?? const <FormField>[]) {
          if (f.kind == 'readonly' || f.kind == 'label') continue;
          if (f.cell.isEmpty) continue;
          // 装备 / 魔法物品那两页的格子是按新版式写死的；老版式卡上它们根本没被认出来
          // （`detected: false`）——那种卡上这些格号落到别的东西上（`主要!B32` 是「运动」的
          // 熟练勾），一律不碰。
          if ((key == 'gear' || key == 'magic') && !f.detected) continue;
          final old = f.value.trim();
          var next = '';
          // 先看基准空白卡那一格写的是什么：它是这张卡的「空值」，照抄就对了。
          // 模板里没值（或模板读不到）才退回 X / 否。
          final tplValue = (tpl != null && f.kind != 'text' && f.kind != 'number')
              ? tpl.cellText(f.sheet, f.cell).trim()
              : '';
          if (tplValue.isNotEmpty && tplValue != '§formula§') {
            next = tplValue;
          } else if (f.kind == 'toggle' && f.options.contains('X') && f.options.contains('O')) {
            next = 'X';
          } else if (f.kind == 'toggle' && f.options.contains('是') && f.options.contains('否')) {
            next = '否';
          }
          if (next == old) continue;
          put(f.sheet, f.cell, next);
          if (next == 'X') skillCount++;
          else if (next == '否') yesNoCount++;
          else fieldCount++;
        }
      }

      // 2) 词条列 → 空。只清「内容能在对应词条库里找到」的格子，
      //    这样不会把卡里的结构行（职业能力面板那 6 行标签等）当成词条擦掉。
      //    另外以模板为准：模板里每个词条列开头那几格是卡自己的结构（标签 / 卡算出来的
      //    行标题），一律不碰。
      final dicts = <String, Set<String>>{
        'class': {for (final e in repo.ofType('classFeature')) normalizeKey(e.name)},
        'species': {for (final e in repo.ofType('species')) normalizeKey(e.name)},
        'feat': {for (final e in repo.ofType('feat')) normalizeKey(e.name)},
        'magic': {for (final e in repo.ofType('magicItem')) normalizeKey(e.name)},
      };
      for (final key in ['class', 'species', 'feat', 'magic']) {
        final plan = await _pagePlan(key, target, refresh: true);
        if (plan == null) continue;
        final allow = dicts[key] ?? const <String>{};
        final skip = _headLenFor(tpl, key, plan.blocks.isEmpty ? null : plan.blocks.first);
        for (final b in plan.blocks) {
          for (var i = 0; i < b.cells.length; i++) {
            if (i < skip) continue;   // 卡自己的结构行，不清
            final c = b.cells[i];
            final v = patcher.cellText(plan.sheet, c).trim();
            if (v.isEmpty) continue;
            if (allow.contains(normalizeKey(v))) {
              put(plan.sheet, c, '');
              entryCount++;
            }
            else if (kept.length < 20) kept.add('${plan.sheet}!$c = $v');
          }
        }
      }
      // 法术位：拿卡自己的「法术大全」当名单，清掉认得出来的法术名
      final info = await _tableInfo(target, refresh: true);
      if (info != null) {
        final spellDict = {for (final n in patcher.spellDictionary()) normalizeKey(n)};
        for (final b in info.blocks) {
          for (final c in b.cells) {
            final v = patcher.cellText('法术书', c).trim();
            if (v.isEmpty) continue;
            if (spellDict.contains(normalizeKey(v))) { put('法术书', c, ''); entryCount++; }
            else if (kept.length < 20) kept.add('法术书!$c = $v');
          }
        }
      }
      // 起源表里的工具 / 语言那几格
      for (final c in const ['B24', 'H24', 'B25', 'H25', 'B26', 'H26', 'B27', 'H27',
                             'B28', 'H28', 'B31', 'H31', 'B32', 'H32']) {
        if (patcher.hasSheet('起源') && patcher.cellText('起源', c).trim().isNotEmpty) {
          put('起源', c, '');
          entryCount++;
        }
      }

      if (writes.isNotEmpty) {
        List<int> bytes = await src.readAsBytes();
        for (final e in writes.entries) {
          bytes = XlsxPatcher.open(bytes).writeCells(e.key, e.value);
        }
        await src.writeAsBytes(bytes);
      }
      _dropTableCaches();
      return await _json(req, {
        'ok': true,
        'table': target,
        'backup': backup,
        'skills': skillCount,
        'yesNo': yesNoCount,
        'fields': fieldCount,
        'entries': entryCount,
        'keptFormula': formulaCount,
        'kept': kept,
      });
    } on FileSystemException catch (e) {
      return _json(req, {'error': '写不进去（这张表可能正在 Excel 里开着，先关掉再试）：${e.message}'},
          status: 409);
    }
  }

  // 读卡：把这张卡里已有的内容读出来，交给界面放进备选区。
  // 分两类：表单字段（身份 / 等级职业 / 起源 / 属性技能 / 装备 / 魔法物品）
  // 和词条（职业特性 / 种族特性 / 专长 / 魔法物品 / 法术）。
  if (path == '/api/card' && req.method == 'GET') {
    final target = p.normalize(kTable);
    final src = File(target);
    if (!await src.exists()) {
      return _json(req, {'error': '目标表格不存在：$target（先在下面新建或选一张）'}, status: 400);
    }
    final fields = <Map<String, dynamic>>[];
    final entries = <Map<String, dynamic>>[];

    // 空白模板当参照：值跟模板一模一样的格子不算"这张卡里填过的东西"。
    // 否则随便新建一张卡读出来都是「熟练 = X」「出身 = 自定义背景」这种默认值，
    // 一屏噪音（空白卡实测 43 条）。
    XlsxPatcher? tpl;
    try {
      final tplFile = File(kTemplatePath);
      if (await tplFile.exists()) tpl = XlsxPatcher.open(await tplFile.readAsBytes());
    } catch (_) {}

    // 1) 表单字段：非空的、能写的、且**不是模板默认值**的都要
    for (final key in ['basic', 'origin', 'gear', 'magic']) {
      for (final f in await _formFields(key, target) ?? const <FormField>[]) {
        if (f.kind == 'readonly' || f.kind == 'label') continue;
        if (f.cell.isEmpty) continue;
        final v = f.value.trim();
        if (v.isEmpty) continue;
        if (tpl != null &&
            tpl.hasSheet(f.sheet) &&
            tpl.cellText(f.sheet, f.cell).trim() == v) {
          continue;   // 跟空白模板一样 = 没填过
        }
        fields.add({
          'formKey': key,
          'page': _formTitles[key] ?? key,
          'field': f.field,
          'label': f.label,
          'section': f.section,
          // 表格版式里的行名（六项属性=力量/敏捷…，技能=运动/特技…，装备=第 1 件…）。
          // 界面拿它拼「力量 · 豁免」这种标题，不然备选区里只写"豁免 B13"看不出是哪一项。
          'row': f.row,
          'cell': f.cell,
          'value': v,
        });
      }
    }

    // 2) 词条：拿名字回词条库里找 id，找不到就用页面名 + 名字凑一个
    final byName = <String, Entry>{};
    for (final e in repo.entries) {
      final k = e.normalizedName;
      if (k.isNotEmpty) byName.putIfAbsent(k, () => e);
    }
    void addEntry(String pageKey, String pageLabel, String name) {
      final n = name.trim();
      if (n.isEmpty) return;
      final hit = byName[normalizeKey(n)];
      entries.add({
        'formKey': pageKey,
        'page': pageLabel,
        'id': hit?.id ?? '$pageKey:$n',
        'name': n,
        'subtitle': hit?.subtitle ?? '',
      });
    }

    for (final key in ['class', 'species', 'feat', 'magic']) {
      final plan = await _pagePlan(key, target, refresh: true);
      if (plan == null) continue;
      final label = pageSpecs[key]?.title ?? key;
      for (final name in plan.existing) {
        // `plan.existing` 已经滤掉卡自己的结构行（见 _pagePlan）
        addEntry(key, label, name);
      }
    }

    // 3) 法术
    final info = await _tableInfo(target, refresh: true);
    if (info != null) {
      for (final n in info.filled) {
        addEntry('spell', '法术列表', n);
      }
    }

    return _json(req, {
      'ok': true,
      'table': target,
      'name': p.basename(target),
      'fields': fields,
      'entries': entries,
    });
  }

  if (path == '/api/table/create' && req.method == 'POST') {
    final b = await _body(req);
    var dir = (b['dir'] ?? '').toString().trim();
    var name = (b['name'] ?? '').toString().trim();
    if (dir.isEmpty) return _json(req, {'error': '缺少目录'}, status: 400);
    if (name.isEmpty) name = '新人物卡.xlsx';
    if (!name.toLowerCase().endsWith('.xlsx')) name = '$name.xlsx';
    final created = await _createFromTemplate(p.normalize(p.join(dir, name)), overwrite: false);
    if (created != null) return _json(req, {'error': created}, status: 409);
    return _json(req, {'ok': true, 'table': await _tableJson(refresh: true)});
  }

  // ---------------------------------------------------------- 填入
  if (path == '/api/fill' && req.method == 'POST') {
    final target = p.normalize(kTable);
    final src = File(target);
    if (!await src.exists()) {
      return _json(req, {'error': '目标表格不存在：$target（先在填入区底部新建或选一张表）'}, status: 400);
    }
    final body = await _body(req);
    final spellNames = _nameList(body['names'], tray.items.map((e) => e.name).toList());
    if (spellNames.isEmpty) {
      return _json(req, {'error': '填入区是空的，先从左边抓几条法术'}, status: 400);
    }

    final info = await _tableInfo(target, refresh: true);
    if (info == null) return _json(req, {'error': '读不出这张表：$target'}, status: 400);
    if (info.blocks.isEmpty) {
      return _json(req, {'error': '在「${info.sheet}」里没认出法术位，这张表可能不是人物卡'}, status: 400);
    }

    String? backup;
    if (!_createdThisSession.contains(target)) {
      try {
        backup = await _backup(target);
      } catch (e) {
        return _json(req, {'error': '备份失败，为安全起见没有写入：$e'}, status: 500);
      }
    }

    try {
      final patcher = XlsxPatcher.open(await src.readAsBytes());
      final outcome = patcher.fillSpells(
        names: spellNames,
        sheet: info.sheet,
        blocks: info.blocks,
        dictionary: info.dictionary,
      );
      await src.writeAsBytes(outcome.bytes);
      _dropTableCaches();
        final after = await _tableInfo(target, refresh: true);
        return await _json(req, {
          'ok': true,
          'table': target,
          'backup': backup,
        'slotsTotal': after?.slotsTotal ?? 0,
        'slotsUsed': after?.used ?? 0,
        'slotsFree': after?.free ?? 0,
        ...outcome.toJson(),
      });
    } on FileSystemException catch (e) {
      return await _json(req, {
        'error': '写不进去（这张表可能正在 Excel 里开着，先关掉再试）：${e.message}'
      }, status: 409);
    }
  }

  // ---------------------------------------------------------- 文件系统
  // ---------------------------------------------------------- 词条页（职业 / 种族 / 专长）
  if (path == '/api/page' && req.method == 'GET') {
    final key = uri.queryParameters['key'] ?? 'class';
    return _json(req, await _pageJson(key, refresh: uri.queryParameters['refresh'] == '1'));
  }

  // ---------------------------------------------------------- 表单页（基本信息…）
  if (path == '/api/form' && req.method == 'GET') {
    final key = uri.queryParameters['key'] ?? 'basic';
    return _json(req, await _formJson(key, refresh: uri.queryParameters['refresh'] == '1'));
  }

  if (path == '/api/form/fill' && req.method == 'POST') {
    final b = await _body(req);
    final key = (b['key'] ?? 'basic').toString();
    if (!_formTitles.containsKey(key)) {
      return _json(req, {'error': '未知表单：$key'}, status: 400);
    }
    final target = p.normalize(kTable);
    final src = File(target);
    if (!await src.exists()) {
      return _json(req, {'error': '目标表格不存在：$target（先在填入区底部新建或选一张表）'}, status: 400);
    }
    final values = (b['values'] as Map?)?.map((k, v) => MapEntry(k.toString(), v?.toString() ?? '')) ?? {};
    final fields = await _formFields(key, target);
    if (fields == null) return _json(req, {'error': '读不出这张表：$target'}, status: 400);

    String? backup;
    if (!_createdThisSession.contains(target)) {
      try {
        backup = await _backup(target);
      } catch (e) {
        return _json(req, {'error': '备份失败，为安全起见没有写入：$e'}, status: 500);
      }
    }
    try {
      final patcher = XlsxPatcher.open(await src.readAsBytes());
      // 装备 / 魔法物品这两页的格子是按新版式写死的。老版式卡（空白卡.xlsx v1.0.0、
      // 米瑞尔那种）把这几块放在完全不同的位置，写了会落到技能格上（`主要!B32` 是
      // 「运动」的熟练勾）。字段照给（界面不缺东西），但这里不写，并在 missing 里说明。
      final blockPage = key == 'gear' || key == 'magic';
      final blockOk = !blockPage || _gearBlocksRecognized(patcher);
      final writes = <String, Map<String, String>>{};
      final written = <Map<String, String>>[];
      final missing = <String>[];
      for (final f in fields) {
        // 只读格（卡自己算的）和行标签列不写
        if (f.kind == 'readonly' || f.kind == 'label') continue;
        final v = (values[f.field] ?? '').trim();
        if (v.isEmpty || f.cell.isEmpty) continue;
        if (!blockOk) {
          if (!missing.contains('装备 / 奇物块（这张卡的位置认不出来）')) {
            missing.add('装备 / 奇物块（这张卡的位置认不出来）');
          }
          continue;
        }
        // 版式不同的卡可能没有这张表（比如老卡没有「起源」），如实报出来而不是写崩
        if (!patcher.hasSheet(f.sheet)) {
          final tag = '${f.label}（${f.sheet} 表）';
          if (!missing.contains(tag)) missing.add(tag);
          continue;
        }
        if ((patcher.cellText(f.sheet, f.cell) == v)) continue;
        (writes[f.sheet] ??= {})[f.cell] = v;
        written.add({'field': f.field, 'label': f.label, 'sheet': f.sheet, 'cell': f.cell, 'value': v});
      }
      if (writes.isEmpty) {
        return await _json(req, {
          'ok': true,
          'writtenCount': 0,
          'written': <Object>[],
          'missing': missing,
          'table': target,
        });
      }
      List<int> bytes = await src.readAsBytes();
      for (final e in writes.entries) {
        bytes = XlsxPatcher.open(bytes).writeCells(e.key, e.value);
      }
        await src.writeAsBytes(bytes);
        _dropTableCaches();
        return await _json(req, {
          'ok': true,
          'table': target,
          'backup': backup,
        'writtenCount': written.length,
        'written': written,
        'missing': missing,
        'form': await _formJson(key, refresh: true),
      });
    } on FileSystemException catch (e) {
      return _json(req, {
        'error': '写不进去（这张表可能正在 Excel 里开着，先关掉再试）：${e.message}'
      }, status: 409);
    }
  }

  if (path == '/api/page/fill' && req.method == 'POST') {
    final b = await _body(req);
    final key = (b['key'] ?? 'class').toString();
    final spec = pageSpecs[key];
    if (spec == null) return _json(req, {'error': '未知页面：$key'}, status: 400);
    final target = p.normalize(kTable);
    final src = File(target);
    if (!await src.exists()) {
      return _json(req, {'error': '目标表格不存在：$target（先在填入区底部新建或选一张表）'}, status: 400);
    }
    final plan = await _pagePlan(key, target, refresh: true);
    if (plan == null) return _json(req, {'error': '读不出这张表：$target'}, status: 400);
    if (plan.blocks.isEmpty) {
      return _json(req, {'error': '在「$kMainSheet」里没认出「${spec.title}」的输入格，这张表可能不是本系列人物卡'}, status: 400);
    }

    final selectors = <String, String>{};
    for (final s in plan.selectors) {
      final v = (b[s.field] ?? '').toString().trim();
      if (v.isNotEmpty) selectors[s.field] = v;
    }
    final t = _trayFor(key);
    final names = _nameList(b['names'], t.items.map((e) => e.name).toList());
    if (names.isEmpty && selectors.isEmpty) {
      return _json(req, {'error': '填入区是空的，也没填上面那几格，没东西可写'}, status: 400);
    }

    String? backup;
    if (!_createdThisSession.contains(target)) {
      try {
        backup = await _backup(target);
      } catch (e) {
        return _json(req, {'error': '备份失败，为安全起见没有写入：$e'}, status: 500);
      }
    }

    try {
      var patcher = XlsxPatcher.open(await src.readAsBytes());
      final outcome = patcher.fillSpells(
        names: names,
        sheet: plan.sheet,
        blocks: plan.blocks,
      );
      var bytes = outcome.bytes;

      // 顶上那几格（职业 / 等级 / 种族…）：只写用户真的填了的
      final edits = <String, String>{};
      for (final s in plan.selectors) {
        final v = selectors[s.field];
        if (v != null && v.isNotEmpty && s.cell.isNotEmpty) edits[s.cell] = v;
      }
      if (edits.isNotEmpty) {
        patcher = XlsxPatcher.open(bytes);
        bytes = patcher.writeCells(plan.sheet, edits);
      }
      await src.writeAsBytes(bytes);
      _dropTableCaches();

      return await _json(req, {
        'ok': true,
        'key': key,
        'table': target,
        'backup': backup,
        'sheet': plan.sheet,
        'selector': {
          for (final s in plan.selectors)
            s.field: {'cell': s.cell, 'label': s.label, 'value': selectors[s.field] ?? ''},
        },
        'slots': plan.blocks.map((b) => b.toJson()).toList(),
        'page': await _pageJson(key, refresh: true),
        ...outcome.toJson(),
      });
    } on FileSystemException catch (e) {
      return _json(req, {
        'error': '写不进去（这张表可能正在 Excel 里开着，先关掉再试）：${e.message}'
      }, status: 409);
    }
  }

  if (path == '/api/fs' && req.method == 'GET') {
    final dir = uri.queryParameters['dir'] ?? p.dirname(kTable);
    return _json(req, await _fsListing(dir));
  }

  if (path == '/api/reveal' && req.method == 'POST') {
    final b = await _body(req);
    final target = (b['path'] ?? '').toString().trim();
    final isDir = b['dir'] == true;
    if (target.isEmpty) return _json(req, {'error': '缺少 path'}, status: 400);
    final exists = isDir ? await Directory(target).exists() : await File(target).exists();
    if (!exists) return _json(req, {'error': '路径不存在：$target', 'fallback': target}, status: 404);
    try {
      await Process.start('explorer', [target], mode: ProcessStartMode.detached);
      return await _json(req, {'ok': true, 'opened': target});
    } catch (e) {
      return await _json(req, {'error': '无法自动打开（$e）', 'fallback': target}, status: 500);
    }
  }

  return _json(req, {'error': '未知接口 $path'}, status: 404);
}

// ---------------------------------------------------------------- 表格状态
/// 卡里的子职 / 出身 → 规则书正文（tools/link_card_rules.py 生成，卡换了要重跑）
Map<String, Map<String, dynamic>>? _ruleIndex;
String _ruleIndexKey = '';

Future<Map<String, Map<String, dynamic>>> _cardRules() async {
  final f = File(p.join(kDataDir, 'card_rules.json'));
  if (!await f.exists()) return const {};
  final key = '${f.path}|${(await f.stat()).modified.millisecondsSinceEpoch}';
  if (_ruleIndex != null && _ruleIndexKey == key) return _ruleIndex!;
  final out = <String, Map<String, dynamic>>{};
  try {
    final j = jsonDecode(await f.readAsString());
    for (final it in (j is Map ? (j['items'] as List? ?? const []) : const [])) {
      final m = (it as Map).cast<String, dynamic>();
      out['${m['kind']}|${m['class'] ?? ''}|${m['name']}'] = m;
    }
  } catch (e) {
    stderr.writeln('规则库读不出来：$e');
    return const {};
  }
  _ruleIndex = out;
  _ruleIndexKey = key;
  return out;
}

/// 「洞悉和宗教」「书法工具」→ 拆成一条条
List<String> splitEffectList(String text) {
  final out = <String>[];
  for (final part in text.split(RegExp(r'[、,，/]'))) {
    for (final piece in part.split('和')) {
      final t = piece.trim();
      if (t.isNotEmpty) out.add(t);
    }
  }
  return out;
}

/// 把出身的「效果」落成卡里的写入计划。
///
/// 属性值和装备不用手填——卡里 `起源!S4:S7` 本来就是按出身 VLOOKUP 出来的。
/// 真正要动手的是这几样：
/// - 技能熟练 → 技能表的熟练格打 `O`（卡里 `X=无熟练 O=有熟练`）
/// - 工具熟练 → 「起源」表「熟练工具」下面那几格（标签 B30，值 B31/H31/B32/H32）
/// - 语言     → 「起源」表「语言」下面那几格（标签 B23，值 B24/H24…B28/H28）
/// - 专长     → 「主要」表的专长列，哪一列靠卡内公式反推，换版式不用改代码
({Map<String, Map<String, String>> writes, List<Map<String, String>> written, List<String> unmapped})
    planBackgroundEffects(
  XlsxPatcher p,
  List<({String label, String text})> effects, {
  required Map<int, String> skillRows,
}) {
  const origin = '起源';
  const languageSlots = ['B24', 'H24', 'B25', 'H25', 'B26', 'H26', 'B27', 'H27', 'B28', 'H28'];
  const toolSlots = ['B31', 'H31', 'B32', 'H32'];
  // 老版式 / 别人的卡可能根本没有「起源」表，先问一下，别等到写的时候抛异常
  final hasOrigin = p.hasSheet(origin);

  final featBlocks = p.hasSheet('专长与据点')
      ? (p.linkedBlocks(sheet: '专长与据点', sourceSheet: kMainSheet, minRun: 3)
        ..sort((a, b) => b.slots.compareTo(a.slots)))
      : <SpellBlock>[];
  final featCells = featBlocks.isEmpty ? const <String>[] : featBlocks.first.cells;
  // 卡里已经有的专长名，用来查重（原来只看格子空不空，卡里已有的会被再写一遍）
  final featExisting = <String>{};
  if (featBlocks.isNotEmpty) {
    final b = featBlocks.first;
    for (final v in p.columnValues(kMainSheet, b.column, b.startRow, b.endRow).values) {
      final t = v.trim();
      if (t.isNotEmpty) featExisting.add(normalizeKey(t));
    }
  }

  final writes = <String, Map<String, String>>{};
  final written = <Map<String, String>>[];
  final unmapped = <String>[];

  String? freeIn(String sheet, List<String> slots) {
    for (final c in slots) {
      if (writes[sheet]?.containsKey(c) ?? false) continue;
      if (p.cellText(sheet, c).trim().isEmpty) return c;
    }
    return null;
  }

  void put(String label, String sheet, String cell, String value) {
    (writes[sheet] ??= {})[cell] = value;
    written.add({'label': label, 'sheet': sheet, 'cell': cell, 'value': value});
  }

  for (final e in effects) {
    switch (e.label) {
      case '技能熟练':
        for (final name in splitEffectList(e.text)) {
          final hit = skillRows.entries.where((x) => x.value == name).toList();
          if (hit.isEmpty) {
            unmapped.add('技能「$name」没在技能表里找到，没写');
            continue;
          }
          put('技能熟练', kMainSheet, 'B${hit.first.key}', 'O');
        }
      case '工具熟练':
      case '语言':
        if (!hasOrigin) {
          unmapped.add('${e.label}：「${origin}」表不存在，这张卡写不了（${e.text}）');
          continue;
        }
        // 规则书给的是"要你自己挑"的指令时，别把整句话抄进值格（O4）。
        // 值格只放具体名字，剩下的等玩家挑好再写。
        if (!isConcreteAssignment(e.text)) {
          unmapped.add(
              '${e.label}：规则书给的是「${e.text}」，要你自己挑具体的一样——'
              '挑好之后把它当${e.label}写进备选区（或直接填「起源」表的「熟练工具」/「语言」那几格）');
          continue;
        }
        final cell = freeIn(origin, e.label == '语言' ? languageSlots : toolSlots);
        if (cell == null) {
          unmapped.add('${e.label}的格子满了，没写：${e.text}');
          continue;
        }
        put(e.label, origin, cell, e.text);
      case '专长':
        final name = splitEffectList(e.text).first
            .replaceAll(RegExp(r'[（(][^）)]*[）)]'), '')
            .trim();
        if (featExisting.contains(normalizeKey(name))) {
          unmapped.add('专长「$name」卡里已经有了，跳过');
          continue;
        }
        final cell = freeIn(kMainSheet, featCells);
        if (cell == null) {
          unmapped.add('专长列没有空格了，没写：$name');
          continue;
        }
        put('专长', kMainSheet, cell, name);
      default:
        unmapped.add('${e.label}：卡里没有对应格子，没写（${e.text}）');
    }
  }
  return (writes: writes, written: written, unmapped: unmapped);
}

/// 把「主职业」正文里的条目落成卡里的写入计划。
///
/// 三个落点：
/// - 核心特质（主要属性 / 生命值骰 / 豁免熟练 / 武器熟练 / 护甲受训 / 起始装备…）
///   → 卡里「职业能力」面板：有同名行就补那一行的描述，没有就占下面第一个空槽
///   （名称 + 描述一起写），把卡里那几行空位填满
/// - 技能熟练 → 技能表的熟练格打 `O`（卡里 `X=无熟练 O=有熟练`）
/// - 工具熟练 / 语言 → 「起源」表那几格（跟出身共用）
///
/// 页面抓「主要属性」这一整条时带 `panel: true`，勾选出来的具体技能带 `false`——
/// 前者写面板那一行，后者只打 `O`。
({Map<String, Map<String, String>> writes,
  List<Map<String, String>> written,
  List<String> unmapped,
  List<String> auto})
    planClassEffects(
  XlsxPatcher p,
  List<({String label, String text, bool panel})> effects, {
  required Map<int, String> skillRows,
}) {
  const origin = '起源';
  const languageSlots = ['B24', 'H24', 'B25', 'H25', 'B26', 'H26', 'B27', 'H27', 'B28', 'H28'];
  const toolSlots = ['B31', 'H31', 'B32', 'H32'];
  // 卡里的职业表自己算这几样，面板上没有它们的行，也不用写
  const autoLabels = {'职业特性'};

  final writes = <String, Map<String, String>>{};
  final written = <Map<String, String>>[];
  final unmapped = <String>[];
  final auto = <String>[];

  String? freeIn(String sheet, List<String> slots) {
    for (final c in slots) {
      if (writes[sheet]?.containsKey(c) ?? false) continue;
      if (p.cellText(sheet, c).trim().isEmpty) return c;
    }
    return null;
  }

  void put(String label, String sheet, String cell, String value) {
    (writes[sheet] ??= {})[cell] = value;
    written.add({'label': label, 'sheet': sheet, 'cell': cell, 'value': value});
  }

  // 卡里「职业能力」面板：名称列 = 职业特性那一列（靠卡内公式反推出来的），
  // 描述列 = 表头那一行写着「描述」的那一列；标签行（豁免熟练 / 技能熟练 / …）
  // 就在同一列上，空槽在它们下面。名字和描述都一次读出来，别一个格子一个格子问。
  final panelBlocks = p.linkedBlocks(sheet: '职业', sourceSheet: kMainSheet, minRun: 3)
    ..sort((a, b) => b.slots.compareTo(a.slots));
  final panelCol = panelBlocks.isEmpty ? '' : panelBlocks.first.column;
  final panelStart = panelBlocks.isEmpty ? 0 : panelBlocks.first.startRow;
  final panelEnd = panelBlocks.isEmpty ? 0 : panelBlocks.first.endRow;
  final panelNames = panelCol.isEmpty
      ? <int, String>{}
      : p.columnValues(kMainSheet, panelCol, 1, panelEnd);
  final panelDescs = <int, String>{};

  int colIndex(String col) => col.codeUnits.fold(0, (a, c) => a * 26 + (c - 64));

  // 表头行：名称列往上、附近列里写着「名称 / Lv / 等级」的那一行；描述列是同一行的「描述」
  var headerRow = 0;
  if (panelCol.isNotEmpty) {
    final near = colIndex(panelCol);
    for (final c in p.cells(kMainSheet)) {
      if (c.row > panelStart) continue;
      if (c.row <= headerRow) continue;
      if ((colIndex(c.column) - near).abs() > 20) continue;
      final t = (p.cellValue(kMainSheet, c) ?? '').trim();
      if (t == '名称' || t == 'Lv' || t == '等级') headerRow = c.row;
    }
  }
  var panelDescCol = '';
  if (headerRow > 0) {
    for (final c in p.cells(kMainSheet)) {
      if (c.row != headerRow) continue;
      if ((p.cellValue(kMainSheet, c) ?? '').trim() == '描述') {
        panelDescCol = c.column;
        break;
      }
    }
  }
  if (panelCol.isNotEmpty && panelDescCol.isNotEmpty) {
    panelDescs.addAll(p.columnValues(kMainSheet, panelDescCol, 1, panelEnd));
  }

  /// 把一条核心特质写进「职业能力」面板：有同名行就补描述，没有就占第一个空槽
  void putPanel(String label, String value) {
    if (panelCol.isEmpty || panelDescCol.isEmpty) {
      unmapped.add('$label：没认出卡里的「职业能力」面板，没写（$value）');
      return;
    }
    var row = 0;
    for (final e in panelNames.entries) {
      if (e.value == label) {
        row = e.key;
        break;
      }
    }
    if (row == 0) {
      for (var r = panelStart; r <= panelEnd; r++) {
        if (!panelNames.containsKey(r) && !panelDescs.containsKey(r)) {
          row = r;
          break;
        }
      }
    }
    if (row == 0) {
      unmapped.add('「职业能力」面板的空位用完了，$label 没写（$value）');
      return;
    }
    if (!panelNames.containsKey(row)) {
      panelNames[row] = label;
      (writes[kMainSheet] ??= {})['$panelCol$row'] = label;
      written.add({
        'label': '职业能力 · 名称',
        'sheet': kMainSheet,
        'cell': '$panelCol$row',
        'value': label,
      });
    }
    panelDescs[row] = value;
    put('职业能力 · $label', kMainSheet, '$panelDescCol$row', value);
  }

  /// 「选择2项：特技、驯兽…」里的那个 2；不是菜单就是 0
  int pickCount(String text) {
    final m = RegExp(r'^(选择|任选)\s*([0-9]+)\s*项').firstMatch(text.trim());
    return m == null ? 0 : (int.tryParse(m.group(2)!) ?? 0);
  }

  /// 菜单里的候选（把「选择2项：」这类前缀去掉，再按顿号 / 逗号 / 和 / 或拆开）
  List<String> candidates(String text) {
    var body = text.trim().replaceFirst(RegExp(r'^(选择|任选)\s*[0-9]+\s*项?[：:]?'), '');
    final out = <String>[];
    for (final part in body.split(RegExp(r'[、,，/]'))) {
      for (final piece in part.split('和').expand((x) => x.split('或'))) {
        final t = piece.trim();
        if (t.isNotEmpty && t != '者' && !out.contains(t)) out.add(t);
      }
    }
    return out;
  }

  for (final e in effects) {
    switch (e.label) {
      case '技能熟练':
        // 整条菜单（`选择2项：特技、驯兽…`）→ 写进面板那一行，再提醒去勾选；
        // 勾出来的具体技能（`历史`）→ 技能表打 O
        final pick = pickCount(e.text);
        final names = pick > 0 ? candidates(e.text) : splitEffectList(e.text);
        if (pick > 0 && names.length > pick) {
          if (e.panel) putPanel('技能熟练', e.text);
          unmapped.add('技能熟练是「从 ${names.length} 项里挑 $pick 项」，先在页面上勾选要的那几项');
          continue;
        }
        if (names.isEmpty) {
          unmapped.add('技能熟练：「${e.text}」看不出具体是哪几项，没写');
          continue;
        }
        if (e.panel) putPanel('技能熟练', e.text);
        for (final name in names) {
          final hit = skillRows.entries.where((x) => x.value == name).toList();
          if (hit.isEmpty) {
            unmapped.add('技能「$name」没在技能表里找到，没写');
            continue;
          }
          put('技能熟练', kMainSheet, 'B${hit.first.key}', 'O');
        }
      case '工具熟练':
      case '语言':
        // 整条职业特质（`任选3项乐器`）→ 只写面板：具体挑哪几件是玩家的事；
        // 一条条抓进来的（出身给的那几样、勾出来的）→ 写「起源」表那几格
        if (e.panel) {
          putPanel(e.label, e.text);
          if (e.label == '工具熟练') {
            unmapped.add('工具熟练：挑好的具体工具到「起源」表「熟练工具」那几格里填（${e.text}）');
          }
          continue;
        }
        // 同上：指令句不落值格，只提示（O4）
        if (!isConcreteAssignment(e.text)) {
          unmapped.add(
              '${e.label}：规则书给的是「${e.text}」，要你自己挑具体的一样——'
              '挑好之后再抓进备选区（或直接填「起源」表的「熟练工具」/「语言」那几格）');
          continue;
        }
        final cell = freeIn(origin, e.label == '语言' ? languageSlots : toolSlots);
        if (cell == null) {
          unmapped.add('${e.label}的格子满了，没写：${e.text}');
          continue;
        }
        put(e.label, origin, cell, e.text);
      default:
        if (autoLabels.contains(e.label)) {
          auto.add('${e.label}：卡里的职业表自己算，不用手填');
        } else if (e.panel) {
          putPanel(e.label, e.text);
        } else {
          unmapped.add('${e.label}：卡里没有对应格子，没写（${e.text}）');
        }
    }
  }
  return (writes: writes, written: written, unmapped: unmapped, auto: auto);
}

class TableInfo {
  final String path;
  final String sheet;
  final List<SpellBlock> blocks;
  final List<String> filled;
  final Set<String> dictionary;
  final int dictionaryCount;
  final String mtime;
  final int size;

  TableInfo({
    required this.path,
    required this.sheet,
    required this.blocks,
    required this.filled,
    required this.dictionary,
    required this.dictionaryCount,
    required this.mtime,
    required this.size,
  });

  String get fileName => p.basename(path);
  int get slotsTotal => blocks.fold(0, (a, b) => a + b.slots);
  int get used => filled.length;
  int get free => slotsTotal - used;
}

TableInfo? _tableCache;
String _tableCacheKey = '';

/// 目标表的解析结果（按「路径 + 修改时间 + 大小」缓存）。
///
/// 一次 `/api/card` 或「读卡」要读同一张表好几遍（4 张表单 + 4 个词条页 + 法术位），
/// 每遍都 `XlsxPatcher.open` 解一次 zip；卡 1.5 MB，攒起来就是几秒。卡文件一改
/// （mtime / 大小变了）缓存自然失效，写完代码里统一 `_dropTableCaches()`。
XlsxPatcher? _tablePatcherCache;
String _tablePatcherKey = '';

XlsxPatcher? _tablePatcher(String path) {
  try {
    final f = File(path);
    if (!f.existsSync()) return null;
    final st = f.statSync();
    final key = '$path|${st.modified.millisecondsSinceEpoch}|${st.size}';
    if (_tablePatcherCache != null && _tablePatcherKey == key) return _tablePatcherCache;
    final p = XlsxPatcher.open(f.readAsBytesSync());
    _tablePatcherCache = p;
    _tablePatcherKey = key;
    return p;
  } catch (_) {
    return null;
  }
}

/// 卡里的作者信息 —— 在「更新」工作表里。按**内容**认、不钉格子：
///   · 名字写在「修订者」那格下面一两行、同一列
///   · 带「QQ：」的是 QQ，带「群…：」的是反馈群
///   · 「特别鸣谢」「不禁止二次修改」原样带出来
/// 「致谢」那一页拿这份数据画，换一张卡（或作者改了更新表）都不用动代码。
Future<Map<String, dynamic>> _creditsJson() async {
  final out = <String, dynamic>{
    'found': false,
    'sheet': '更新',
    'author': '',
    'qq': '',
    'group': '',
    'thanks': '',
    'note': '',
  };
  if (kTable.isEmpty) return out;
  final patcher = _tablePatcher(kTable);
  const sheet = '更新';
  if (patcher == null || !patcher.hasSheet(sheet)) return out;

  final qqRe = RegExp(r'QQ\s*[：:]\s*(\d{5,})');
  final groupRe = RegExp(r'群[^：:\n]{0,12}[：:]\s*(\d{5,})');
  for (final c in patcher.cells(sheet)) {
    final t = (patcher.cellValue(sheet, c) ?? '').trim();
    if (t.isEmpty) continue;
    if (out['qq'] == '') {
      final m = qqRe.firstMatch(t);
      if (m != null) out['qq'] = m.group(1)!;
    }
    if (out['group'] == '') {
      final m = groupRe.firstMatch(t);
      if (m != null) out['group'] = m.group(1)!;
    }
    if (out['thanks'] == '' && t.startsWith('特别鸣谢')) out['thanks'] = t;
    if (out['note'] == '' && t.contains('不禁止二次修改')) out['note'] = t;
    if (out['author'] == '' && t == '修订者') {
      for (var r = c.row + 1; r <= c.row + 3; r++) {
        final n = patcher.cellText(sheet, '${c.column}$r');
        if (n.isEmpty) continue;
        if (RegExp(r'^(QQ|反馈|特别鸣谢|辅助)').hasMatch(n)) break;
        out['author'] = n;
        break;
      }
    }
  }
  out['found'] = (out['author'] as String).isNotEmpty || (out['qq'] as String).isNotEmpty;
  return out;
}

Future<TableInfo?> _tableInfo(String path, {bool refresh = false}) async {
  final f = File(path);
  if (!await f.exists()) return null;
  final st = await f.stat();
  final key = '$path|${st.modified.millisecondsSinceEpoch}|${st.size}';
  if (!refresh && _tableCache != null && _tableCacheKey == key) return _tableCache;

  final patcher = _tablePatcher(path) ?? XlsxPatcher.open(await f.readAsBytes());
  // 优先「法术书」；找不到就挑一张能认出法术位的表
  var sheet = kSpellSheet;
  var blocks = patcher.spellBlocks(sheet: kSpellSheet, lookupSheet: kDictSheet);
  if (blocks.isEmpty) {
    for (final s in patcher.sheetNames) {
      final b = patcher.spellBlocks(sheet: s, lookupSheet: kDictSheet);
      if (b.isNotEmpty) {
        sheet = s;
        blocks = b;
        break;
      }
    }
  }
  final filled = <String>[];
  for (final b in blocks) {
    filled.addAll(patcher.columnValues(sheet, b.column, b.startRow, b.endRow).values);
  }
  final dict = patcher.spellDictionary(sheet: kDictSheet);
  final info = TableInfo(
    path: p.normalize(path),
    sheet: sheet,
    blocks: blocks,
    filled: filled,
    dictionary: dict,
    dictionaryCount: dict.length,
    mtime: st.modified.toIso8601String().substring(0, 16).replaceAll('T', ' '),
    size: st.size,
  );
  _tableCache = info;
  _tableCacheKey = key;
  return info;
}

Future<Map<String, dynamic>> _tableJson({bool refresh = false}) async {
  final info = await _tableInfo(kTable, refresh: refresh);
  return {
    'path': kTable,
    'name': p.basename(kTable),
    'exists': info != null,
    'sheet': info?.sheet ?? '',
    'blocks': info?.blocks.map((b) => b.toJson()).toList() ?? [],
    'slotsTotal': info?.slotsTotal ?? 0,
    'used': info?.used ?? 0,
    'free': info?.free ?? 0,
    'filled': info?.filled ?? [],
    'dictionary': info?.dictionary.toList() ?? [],
    'dictionaryCount': info?.dictionaryCount ?? 0,
    'mtime': info?.mtime ?? '',
    'size': info?.size ?? 0,
    'template': {'path': kTemplatePath, 'exists': await File(kTemplatePath).exists()},
  };
}

// ---------------------------------------------------------------- 词条页识别
/// 一个「词条页」= 一类词条 + 卡里对应的输入位置。
///
/// 写入一律落在「主要」表；驱动它的那张数据表（职业 / 种族 / 专长与据点…）
/// 只用来看它是怎么引用主要表的，格子全靠卡内公式反推，换版本不用改代码。
class PageSpec {
  final String key;
  final String type;
  final String title;
  final String drivingSheet;
  /// 顶上那几个选择格：第几组、组内第几格（职业页第一组就是 主职业/子职业/等级）
  final List<({String field, String label, int group, int index})> selectors;
  /// 这一页的筛选面
  final List<String> facets;
  /// 选择格只读：种族这一类在「基本信息」里定过就不该在这里改
  final bool locked;

  const PageSpec({
    required this.key,
    required this.type,
    required this.title,
    required this.drivingSheet,
    required this.selectors,
    required this.facets,
    this.locked = false,
  });
}

const pageSpecs = <String, PageSpec>{
  'class': PageSpec(
    key: 'class',
    type: 'classFeature',
    title: '职业特性',
    drivingSheet: '职业',
    selectors: [
      (field: 'cls', label: '主职业', group: 0, index: 0),
      (field: 'sub', label: '子职业', group: 0, index: 1),
      (field: 'level', label: '等级', group: 0, index: 2),
    ],
    facets: ['职业', '等级', '子职'],
  ),
  'species': PageSpec(
    key: 'species',
    type: 'species',
    title: '种族背景',
    drivingSheet: '种族',
    selectors: [
      (field: 'race', label: '种族', group: 0, index: 0),
      (field: 'subrace', label: '亚种', group: 1, index: 0),
    ],
    facets: ['category'],
    // 种族 / 亚种在「基本信息」里定，这里只显示，不给改
    locked: true,
  ),
  'feat': PageSpec(
    key: 'feat',
    type: 'feat',
    title: '专长',
    drivingSheet: '专长与据点',
    selectors: [],
    facets: ['category'],
  ),
  'magic': PageSpec(
    key: 'magic',
    type: 'magicItem',
    title: '魔法物品',
    drivingSheet: '主要',
    selectors: [],
    facets: ['类别', '稀有度'],
  ),
  'all': PageSpec(
    key: 'all',
    type: 'all',
    title: '全部速查',
    drivingSheet: '主要',
    selectors: [],
    facets: ['类型'],
  ),
};

class PagePlan {
  final String key;
  final String table;
  final String sheet;
  final List<({String field, String label, String cell})> selectors;
  final List<SpellBlock> blocks;
  final List<String> existing;
  final int slotCount;
  final int freeCount;
  final String mtime;

  PagePlan({
    required this.key,
    required this.table,
    required this.sheet,
    required this.selectors,
    required this.blocks,
    required this.existing,
    required this.slotCount,
    required this.freeCount,
    required this.mtime,
  });
}

final _pageCache = <String, PagePlan>{};
final _pageCacheKey = <String, String>{};

/// 基准空白卡（`kTemplatePath`）的解析结果，按「路径 + 修改时间 + 大小」缓存。
/// 「哪些格子算卡自己的结构」要拿它当参照。
XlsxPatcher? _tplCache;
String _tplCacheKey = '';

XlsxPatcher? _templatePatcher() {
  try {
    final f = File(kTemplatePath);
    if (!f.existsSync()) return null;
    final key = '$kTemplatePath|${f.lastModifiedSync().millisecondsSinceEpoch}|${f.lengthSync()}';
    if (_tplCache != null && _tplCacheKey == key) return _tplCache;
    _tplCache = XlsxPatcher.open(f.readAsBytesSync());
    _tplCacheKey = key;
    return _tplCache;
  } catch (_) {
    return null;
  }
}

/// 卡里某个表头（「奇物」`L41`、「消耗品」`L51`…）下面的**输入列**：
/// 从表头下一行起，一直走到下一个非空表头为止。
///
/// **别把格数写死**：v1.0.12 的奇物是 `L42:L51`（10 格），v1.1.1 少一格
/// （`L42:L50`，`L51` 已经变成「消耗品」的表头）——照 10 格写会把「消耗品」
/// 这个名字当成第 10 件奇物读出来、还能写进去。同一套认法也用来找消耗品（`L52:L56`）。
SpellBlock? _blockUnderHeader(
  XlsxPatcher p,
  String header, {
  int minRow = 30,
  int maxRow = 60,
  int maxSlots = 12,
}) {
  if (!p.hasSheet(kMainSheet)) return null;
  for (final c in p.cells(kMainSheet)) {
    if (c.row < minRow || c.row > maxRow) continue;
    if ((p.cellValue(kMainSheet, c) ?? '').trim() != header) continue;
    var last = c.row + 1;
    while (last < c.row + maxSlots &&
        p.cellText(kMainSheet, '${c.column}${last + 1}').trim().isEmpty) {
      last++;
    }
    return SpellBlock(c.column, c.row + 1, last);
  }
  return null;
}

/// 卡里「奇物」那一块（表头 `L41`；v1.0.12 是 10 格，v1.1.1 是 9 格）。
/// 认不出来就按 v1.0.12 的位置兜底。
SpellBlock _magicItemBlock(XlsxPatcher p) =>
    _blockUnderHeader(p, '奇物') ?? SpellBlock('L', 42, 51);

/// 卡里「消耗品」那一块（表头 `L51`，5 行：名称 / 稀有度 / 描述 / 数量）。
SpellBlock? _consumableBlock(XlsxPatcher p) => _blockUnderHeader(p, '消耗品', maxRow: 60);

Future<PagePlan?> _pagePlan(String pageKey, String path, {bool refresh = false}) async {
  final spec = pageSpecs[pageKey];
  if (spec == null) return null;
  final f = File(path);
  if (!await f.exists()) return null;
  final st = await f.stat();
  final stamp = '$path|${st.modified.millisecondsSinceEpoch}|${st.size}';
  if (!refresh && _pageCache[pageKey] != null && _pageCacheKey[pageKey] == stamp) {
    return _pageCache[pageKey];
  }

  final patcher = _tablePatcher(path) ?? XlsxPatcher.open(await f.readAsBytes());
  // 名称输入列：驱动表里成段引用「主要」的那些列，挑最长的一条
  var blocks = patcher.linkedBlocks(sheet: spec.drivingSheet, sourceSheet: kMainSheet, minRun: 3);
  if (blocks.isEmpty) blocks = patcher.linkedBlocks(sourceSheet: kMainSheet, minRun: 3);
  // 魔法物品那一块（奇物名）没有被别的表引用，认不出来，只能靠「奇物」这个表头往下找
  if (pageKey == 'magic') {
    blocks = [_magicItemBlock(patcher)];
  }
  // 全部速查没有自己的输入列：抓到哪一条，就按那一条的类别走各自的页
  if (pageKey == 'all') {
    blocks = const <SpellBlock>[];
  }
  if (blocks.length > 1) {
    int score(SpellBlock b) => b.slots;
    blocks.sort((a, b) => score(b).compareTo(score(a)));
    blocks = [blocks.first];
  }

  // 基准空白卡当参照：每个词条列开头那几格是卡自己的结构（标签 / 卡算出来的行标题，
  // 比如职业面板的「豁免熟练…起始装备」六行、种族页的「生物种类 / 体型 / 速度」），
  // 空白卡上它们也有字，但不是玩家填的词条，别读成「这张卡里已有这些」。
  // 只在「目标卡这一块和基准卡的同一块对得上」时才跳——别版式的卡（米瑞尔那类）
  // 块的位置完全不同，跳前几格会把真词条吃掉。
  final skipHead = _headLenFor(_templatePatcher(), pageKey, blocks.isEmpty ? null : blocks.first);

  final existing = <String>[];
  var slotCount = 0;
  var freeCount = 0;
  for (final b in blocks) {
    final vals = patcher.columnValues(kMainSheet, b.column, b.startRow, b.endRow);
    for (var i = 0; i < b.slots; i++) {
      final r = b.startRow + i;
      slotCount++;
      final v = (vals[r] ?? '').trim();
      if (v.isEmpty) {
        freeCount++;
      } else if (i >= skipHead) {
        existing.add(v);
      }
    }
  }

  // 选择格 = 空判公式（`IF(主要!X="",0,主要!X)`）指向的格子，但要排掉已经认作
  // 「名称输入列」的那一列（种族表里 BZ 列也是这个写法，指的是特性名而不是种族）。
  final nameColumns = blocks.map((b) => b.column).toSet();
  var groups = patcher
      .selectorGroups(sheet: spec.drivingSheet, sourceSheet: kMainSheet)
      .map((g) => g.where((c) => !nameColumns.contains(c.column)).toList())
      .where((g) => g.isNotEmpty)
      .toList();
  if (groups.isEmpty) groups = patcher.selectorGroups(sourceSheet: kMainSheet);
  final selectors = <({String field, String label, String cell})>[];
  for (final s in spec.selectors) {
    var cell = '';
    if (s.group < groups.length && s.index < groups[s.group].length) {
      final c = groups[s.group][s.index];
      cell = '${c.column}${c.row}';
    }
    selectors.add((field: s.field, label: s.label, cell: cell));
  }

  final plan = PagePlan(
    key: pageKey,
    table: p.normalize(path),
    sheet: kMainSheet,
    selectors: selectors,
    blocks: blocks,
    existing: existing,
    slotCount: slotCount,
    freeCount: freeCount,
    mtime: st.modified.toIso8601String().substring(0, 16).replaceAll('T', ' '),
  );
  _pageCache[pageKey] = plan;
  _pageCacheKey[pageKey] = stamp;
  return plan;
}

/// 词条库的筛选面，按条目数从多到少（卡里没有这份清单时兜底用）
Map<String, int> _facetDesc(String type, String field) {
  final m = repo.facet(type, field);
  return Map.fromEntries(m.entries.toList()..sort((a, b) => b.value.compareTo(a.value)));
}

/// 选择格的可选值（下拉用）。
///
/// 先问卡自己：职业 / 子职来自 `职业` 表，种族 / 亚种来自 `种族` 表，而且
/// 子职跟着当前主职业走、亚种跟着当前种族走（卡就是这么联动的）。
/// 卡里没有这份清单时，才退回词条库的筛选面。
List<String> _optionsFor(String pageKey, String field, CardLists? lists, Map<String, String> values) {
  final card = lists ?? CardLists.empty;
  switch ('$pageKey.$field') {
    case 'class.cls':
      return card.classes.isNotEmpty ? card.classes : _facetDesc('classFeature', '职业').keys.toList();
    case 'class.sub':
      if (card.subclassesByClass.isNotEmpty) return card.subclassesOf(values['cls'] ?? '');
      return _facetDesc('classFeature', '子职').keys.take(120).toList();
    case 'class.level':
      return [for (var i = 1; i <= 20; i++) '$i'];
    case 'species.race':
      return card.races.isNotEmpty ? card.races : _facetDesc('species', 'category').keys.toList();
    case 'species.subrace':
      return card.subracesOf(values['race'] ?? '');
    default:
      return const [];
  }
}

/// 选择格之间的联动：哪个字段变了，这个字段的选项就跟着换
String _parentOf(String pageKey, String field) => switch ('$pageKey.$field') {
      'class.sub' => 'cls',
      'species.subrace' => 'race',
      _ => '',
    };

/// 「父字段的值 → 这个字段能选什么」那张表（子职跟主职业、亚种跟种族）
Map<String, List<String>> _optionsByParent(String pageKey, String field, CardLists? lists) {
  final card = lists ?? CardLists.empty;
  switch ('$pageKey.$field') {
    case 'class.sub':
      return card.subclassesByClass;
    case 'species.subrace':
      return card.subracesByRace;
    default:
      return const {};
  }
}

Future<Map<String, dynamic>> _pageJson(String pageKey, {bool refresh = false}) async {
  final spec = pageSpecs[pageKey];
  if (spec == null) return {'error': '未知页面：$pageKey'};
  final plan = await _pagePlan(pageKey, kTable, refresh: refresh);
  final patcher = plan == null ? null : _tablePatcher(kTable);
  final lists = patcher == null ? null : CardLists.from(patcher);

  // 选择格现在的值：子职要看主职业、亚种要看种族，所以先把值都读出来
  final values = <String, String>{};
  for (final s in plan?.selectors ?? const <({String field, String label, String cell})>[]) {
    values[s.field] =
        (patcher != null && s.cell.isNotEmpty) ? patcher.cellText(kMainSheet, s.cell) : '';
  }

  final selectors = <Map<String, dynamic>>[];
  for (final s in plan?.selectors ?? const <({String field, String label, String cell})>[]) {
    selectors.add({
      'field': s.field,
      'label': s.label,
      'cell': s.cell,
      'value': values[s.field] ?? '',
      'options': _optionsFor(pageKey, s.field, lists, values),
      'parent': _parentOf(pageKey, s.field),
      'optionsByParent': _optionsByParent(pageKey, s.field, lists),
    });
  }

  final facets = <String, Map<String, int>>{};
  for (final f in spec.facets) {
    facets[f] = repo.facet(spec.type, f);
  }
  facets['来源'] = repo.facet(spec.type, 'source');

  return {
    'key': pageKey,
    'title': spec.title,
    'type': spec.type,
    'table': kTable,
    'name': p.basename(kTable),
    'exists': plan != null,
    'sheet': kMainSheet,
    'locked': spec.locked,
    // 锁定页把「来自别处的字段」也报出来：种族页顺带显示出身
    'elsewhere': spec.locked && patcher != null
        ? [
            {'label': '出身', 'cell': '起源!E6', 'value': patcher.cellText('起源', 'E6')},
          ]
        : const [],
    'selectors': selectors,
    'slots': plan?.blocks.map((b) => b.toJson()).toList() ?? [],
    'existing': plan?.existing ?? [],
    'slotCount': plan?.slotCount ?? 0,
    'free': plan?.freeCount ?? 0,
    'mtime': plan?.mtime ?? '',
    'facets': facets,
    'total': repo.typeCounts()[spec.type] ?? 0,
  };
}

// ---------------------------------------------------------------- 表单页
/// 表单页和词条页不是一回事：这里一个格子一个字段，每个字段有自己的控件，
/// 选项优先用卡里自带的下拉（比如阵营），没有就用词条库里的名称表。
class FormField {
  final String field;
  final String label;
  final String section;
  final String kind; // text / number / select / toggle / readonly
  final String cell;
  final String value;
  final List<String> options;
  final bool detected;
  /// 这个字段写进哪张表（默认「主要」，起源页是「起源」）
  final String sheet;
  /// 表格版式用：同一 [row] 的字段排成一行，按 [col] 从左到右
  final String row;
  final int col;
  /// 这个字段的选项跟着哪个字段走（子职业 ← 主职业、亚种 ← 种族）
  final String parent;
  /// 跟着 [parent] 的值变的那份清单：值 → 该值下的可选项
  final Map<String, List<String>> optionsByParent;

  FormField({
    required this.field,
    required this.label,
    required this.section,
    required this.kind,
    required this.cell,
    required this.value,
    required this.options,
    required this.detected,
    this.sheet = kMainSheet,
    this.row = '',
    this.col = 0,
    this.parent = '',
    this.optionsByParent = const {},
  });

  Map<String, dynamic> toJson() => {
        'field': field,
        'label': label,
        'section': section,
        'kind': kind,
        'cell': cell,
        'value': value,
        'options': options,
        'detected': detected,
        'sheet': sheet,
        'row': row,
        'col': col,
        'parent': parent,
        'optionsByParent': optionsByParent,
      };
}

final _formCache = <String, List<FormField>>{};
final _formCacheKey = <String, String>{};

const _formTitles = {
  'basic': '基本信息',
  'attrs': '属性与技能',
  'origin': '起源',
  'gear': '武器 / 护甲 / 盾',
  'bag': '背包',
  'magic': '魔法物品',
};

/// 技能表：B 列勾熟练、C 列技能名、F 列额外修正、I 列是卡算出来的总值
const _skillRows = <int, String>{
  41: '运动', 43: '特技', 44: '巧手', 45: '隐匿',
  47: '调查', 48: '奥秘', 49: '历史', 50: '自然', 51: '宗教',
  53: '察觉', 54: '洞悉', 55: '驯兽', 56: '医药', 57: '求生',
  59: '游说', 60: '欺瞒', 61: '威吓', 62: '表演',
};
const _attrRows = <int, String>{13: '力量', 14: '敏捷', 15: '体质', 16: '智力', 17: '感知', 18: '魅力'};

/// 18 个技能的标准名字（卡里用的就是这一套），顺序 = 显示顺序
const _skillNames = <String>[
  '运动', '特技', '巧手', '隐匿', '调查', '奥秘', '历史', '自然', '宗教',
  '察觉', '洞悉', '驯兽', '医药', '求生', '游说', '欺瞒', '威吓', '表演',
];
const _attrNames = <String>['力量', '敏捷', '体质', '智力', '感知', '魅力'];

/// 从卡里认「六项属性」和「技能」各在哪几行。
///
/// 行号写死会踩别的版式，三个版本的技能表起止行都不一样：
///
/// | 卡 | 技能表 |
/// |---|---|
/// | `空白卡v1.1.1.xlsx`（当前基准）/ 悲灵 v1.1.1 | **40–61**（表头在 39） |
/// | `空白卡v1.0.12.xlsx` | 41–62（表头在 40，上面还有一行「万事通」） |
/// | `空白卡.xlsx` v1.0.0 / 米瑞尔 | **32–53** |
///
/// 拿 41–62 去读米瑞尔，读到的是法术块和属性分组标题，界面上就冒出一堆
/// 「技能 / 关键属性 / 法术 / 职业归属 / 主职业 / 环阶」；往那张卡写技能熟练更糟——
/// 以为在给「运动」打勾，实际落在了「自然」那一行。
///
/// 认法：C 列写着标准名、B 列是那个 `X/O` 熟练勾（空白卡的勾是空的，空也算）。
/// 实在认不出来（怪版式）就退回写死的那一份，保证还能用。
({Map<int, String> attrs, Map<int, String> skills}) _recognizeAttrAndSkills(XlsxPatcher p) {
  String at(String col, int r) => p.cellText(kMainSheet, '$col$r').trim();
  final attrs = <int, String>{};
  final skills = <int, String>{};
  for (var r = 1; r <= 250; r++) {
    final mark = at('B', r);
    if (mark.isNotEmpty && mark != 'X' && mark != 'O') continue;  // 不是熟练勾，跳过
    final name = at('C', r);
    if (name.isEmpty) continue;
    if (_attrNames.contains(name)) {
      if (!attrs.containsValue(name)) attrs[r] = name;
    } else if (_skillNames.contains(name)) {
      if (!skills.containsValue(name)) skills[r] = name;
    }
  }
  if (attrs.length < _attrNames.length) {
    attrs
      ..clear()
      ..addAll(_attrRows);
  }
  if (skills.isEmpty) {
    skills
      ..clear()
      ..addAll(_skillRows);
  }
  return (attrs: attrs, skills: skills);
}

/// 装备 / 魔法物品那几块（武器 / 护甲 / 盾 / 奇物）的格子位置是按**新版式**写死的：
/// 武器名 `B32:B36`、护甲名 `L40`、盾牌名 `AL40`、奇物名 `L42:L51`。
/// v1.1.1 与 v1.0.12 这几块的位置一致（`装备` 表引用的还是 `主要!L40` / `P40` /
/// `B32:B36` / `P42:P51`），所以这套格子两个版本都能用。
///
/// 老版式（`空白卡.xlsx` v1.0.0、米瑞尔那种）把这几块整块挤在 **L 列**（表头 `L32`），
/// 位置完全不同——照写就会写到技能格上：`主要!B32` 在老卡上是「运动」的熟练勾，
/// `B33` 是「敏捷」那个属性分组标题（都实测过）。
///
/// 认法：新版式「武器」块表头在 `B30`、「奇物」块表头在 `L41`。认不出来就别把这些
/// 格子给出去——少一个页面，好过把数据写到别的地方。
bool _gearBlocksRecognized(XlsxPatcher p) {
  if (!p.hasSheet(kMainSheet)) return false;
  return p.cellText(kMainSheet, 'B30').trim() == '武器' &&
      p.cellText(kMainSheet, 'L41').trim() == '奇物';
}

/// 基本信息页的字段：格子先靠卡内公式认，认不出再用这一版卡固定的位置兜底。
const _basicFallback = {
  'name': 'E3',
  'player': 'E4',
  'xp': 'E9',
  'alignment': 'T8',
  'faith': 'T9',
};

/// 勾选 / 下拉的可选项：先问卡里的数据验证（`X,O`、`是,否`、稀有度那一串…），
/// 问不到再退回默认值。数据验证常写成范围（`F32:F36`、`R42:T51`），格子落在范围里也算。
List<String> _cardOptions(XlsxPatcher p, String sheet, String cell, List<String> fallback) {
  if (cell.isEmpty) return fallback;
  final v = p.validationOptions(sheet, cell);
  return v.isNotEmpty ? v : fallback;
}

/// 「属性与技能」那两块：六项属性 + 技能表。
/// B 列是熟练勾选（X/O），I/K/M/O 是玩家填的，F（总值）R（调整值）T（豁免）是卡自己算的，只读展示。
/// 以前是单独一页，现在直接并进「基本信息」第一页里（那一页也还在，两处用同一份数据）。
List<FormField> _attrAndSkillFields(XlsxPatcher patcher) {
  final fields = <FormField>[];
  FormField f0(String label, String section, String kind, String cell,
      {List<String> options = const [], String row = '', int col = 0}) {
    final exists = _cellExists(patcher, cell);
    return FormField(
      field: '$section/$row/$col/$cell'.replaceAll('/', '_'),
      label: label,
      section: section,
      kind: kind,
      cell: cell,
      value: patcher.cellText(kMainSheet, cell),
      options: options,
      detected: exists,
      row: row,
      col: col,
    );
  }

  // 属性 / 技能各在哪几行都从卡里认：老版式卡技能表在 32–53 行，写死 41–62 会读错
  final rs = _recognizeAttrAndSkills(patcher);
  for (final e in rs.attrs.entries) {
    final r = e.key;
    final row = e.value;
    fields.add(f0('属性', '六项属性', 'label', 'C$r', row: row, col: 0));
    // 这个勾不是"属性有熟练"，是**豁免**：卡里 `豁免 = 调整值 + IF(B="O", 熟练加值, 0) + 修正`。
    // 所以叫「豁免」；右边 T 列那个算出来的结果改叫「豁免总值」，免得同一行两个「豁免」。
    fields.add(f0('豁免', '六项属性', 'toggle', 'B$r', options: const ['X', 'O'], row: row, col: 1));
    fields.add(f0('初始值', '六项属性', 'number', 'I$r', row: row, col: 2));
    fields.add(f0('背景', '六项属性', 'number', 'K$r', row: row, col: 3));
    fields.add(f0('成长', '六项属性', 'number', 'M$r', row: row, col: 4));
    fields.add(f0('修正', '六项属性', 'number', 'O$r', row: row, col: 5));
    fields.add(f0('总值', '六项属性', 'readonly', 'F$r', row: row, col: 6));
    fields.add(f0('调整值', '六项属性', 'readonly', 'R$r', row: row, col: 7));
    fields.add(f0('豁免总值', '六项属性', 'readonly', 'T$r', row: row, col: 8));
  }
  for (final e in rs.skills.entries) {
    final r = e.key;
    final row = e.value;
    fields.add(f0('技能', '技能', 'label', 'C$r', row: row, col: 0));
    fields.add(f0('熟练', '技能', 'toggle', 'B$r', options: const ['X', 'O'], row: row, col: 1));
    fields.add(f0('额外修正', '技能', 'number', 'F$r', row: row, col: 2));
    fields.add(f0('总值', '技能', 'readonly', 'I$r', row: row, col: 3));
  }
  return fields;
}

Future<List<FormField>?> _formFields(String key, String path) async {
  if (key != 'basic' && key != 'attrs' && key != 'origin' && key != 'gear' && key != 'bag' && key != 'magic') {
    return null;
  }
  final f = File(path);
  if (!await f.exists()) return null;
  final st = await f.stat();
  final stamp = '$key|$path|${st.modified.millisecondsSinceEpoch}|${st.size}';
  if (_formCache[key] != null && _formCacheKey[key] == stamp) return _formCache[key];

  final patcher = _tablePatcher(path) ?? XlsxPatcher.open(await f.readAsBytes());

  if (key == 'attrs') {
    final fields = _attrAndSkillFields(patcher);
    _formCache[key] = fields;
    _formCacheKey[key] = stamp;
    return fields;
  }

  if (key == 'origin') {
    // 起源 · 其它：写在「起源」表。出身（E6）已经挪到「基本信息」，
    // 这里只剩故乡 / 外观 / 个性这些，以及卡按出身反查出来的收益（只读）。
    const sh = '起源';
    FormField g(String field, String label, String kind, String cell,
        {List<String> options = const [], String section = '角色'}) {
      final ok = patcher.cellText(sh, cell) != '§formula§' && patcher.hasSheet(sh);
      return FormField(
        field: field,
        label: label,
        section: section,
        kind: kind,
        cell: cell,
        value: patcher.hasSheet(sh) ? patcher.cellText(sh, cell) : '',
        options: options,
        detected: ok,
        sheet: sh,
      );
    }

    final fields = <FormField>[
      // 角色名 / 玩家 已经删掉：卡里「起源」表那两个格子没有任何表引用它们
      // （真正在用的是 主要!E3 / E4，基本信息页填的就是那儿），
      // 留在这里只会让人以为填了有用。
      g('hometown', '故乡', 'text', 'E5'),
      // 出身（E6）在「基本信息」里填，这一页不再重复给一个入口
      g('age', '年龄', 'text', 'E8', section: '人物形象'),
      g('gender', '性别', 'text', 'E9', section: '人物形象'),
      g('height', '身高', 'text', 'K8', section: '人物形象'),
      g('weight', '体重', 'text', 'K9', section: '人物形象'),
      g('bio', '人物形象', 'text', 'B12', section: '人物形象'),
      g('trait', '个性', 'text', 'S11', section: '人物形象'),
      // 卡里这两块右侧还留着理念 / 羁绊 / 缺陷 / 背景故事四个空格子，一并给上入口
      g('ideal', '理念', 'text', 'S13', section: '人物形象'),
      g('bond', '羁绊', 'text', 'S14', section: '人物形象'),
      g('flaw', '缺陷', 'text', 'S15', section: '人物形象'),
      g('story', '背景故事', 'text', 'S17', section: '人物形象'),
      // 卡按背景反查出来的收益，只读
      g('ability', '属性值', 'readonly', 'S4', section: '背景收益'),
      g('skills', '技能熟练', 'readonly', 'S5', section: '背景收益'),
      g('tools', '工具熟练', 'readonly', 'S6', section: '背景收益'),
      g('gear', '背景装备', 'readonly', 'S7', section: '背景收益'),
    ];
    _formCache[key] = fields;
    _formCacheKey[key] = stamp;
    return fields;
  }

  if (key == 'gear') {
    // 「装备」这一页按卡自己的三块来，一块一张表：
    //
    //   武器   `B30` 表头，行 32–36（5 行）——名字 `B`（卡里 `装备!AU2` 就是拿它查表的），
    //          同调 `F`、加值 `L`、熟练 `W`、弹药/充能计数 `AP` 是填的，
    //          精通 `AN`、攻击 `Z`、伤害 `AB` 是卡算的（公式）。
    //   护甲   `L38`「装备」块，行 40 左半——名字 `L40`（`装备!AZ12 = 主要!L40` 查防具表，
    //          AC `AF40 = 装备!BA12 + U40`）、同调 `P40`、加值 `U40`，
    //          AC `AF40`、敏捷加值 `AI40`、特性 `V40` 都是公式。
    //   盾牌   行 40 右半——名字 `AL40`、同调 `AP40`、AC `AQ40`（卡里是手填的数字）、
    //          **着装 `AS40`**。
    //
    // 以前把护甲 / 盾牌塞在武器那张表里接着排，列头对不上：护甲的「着装」其实写的是
    // 盾牌那一格（`AS40`，卡里 `C23 = SUM(…, IF(AS40="是", AQ40, 0))` 管的是盾牌算不算 AC），
    // 护甲的 AC 又跑到「攻击」列下面去了。
    const sh = kMainSheet;
    // 武器名候选：直接用卡里「装备」表自带的武器清单（跟阵营下拉一个思路），
    // 词条库那边的 equipment.json 没有 category，凑不出这份清单。
    final names = CardLists.weaponsFrom(patcher);
    final equip = CardLists.equipNames(patcher);
    final fields = <FormField>[];
    // 这几块的格子位置是按新版式写死的。老版式卡上位置不同，那就在字段上打
    // `detected: false`（界面会标 ⚠），写入时服务器会拦住并如实报告——但**不删字段**。
    final gearOk = _gearBlocksRecognized(patcher);
    FormField m(String label, String kind, String cell,
        {String section = '武器',
        String row = '',
        int col = 0,
        List<String> options = const []}) {
      final exists = _writable(patcher, cell) || _cellExists(patcher, cell);
      return FormField(
        field: 'gear_${cell}_$col',
        label: label,
        section: section,
        kind: kind,
        cell: cell,
        value: patcher.cellText(sh, cell),
        options: options,
        detected: gearOk && exists,
        sheet: sh,
        row: row,
        col: col,
      );
    }

    for (var r = 32; r <= 36; r++) {
      final row = '第 ${r - 31} 件';
      fields.add(m('武器名', 'text', 'B$r', row: row, col: 0, options: names));
      fields.add(m('同调', 'toggle', 'F$r', row: row, col: 1,
          options: _cardOptions(patcher, sh, 'F$r', const ['X', 'O'])));
      fields.add(m('加值', 'number', 'L$r', row: row, col: 2));
      fields.add(m('熟练', 'toggle', 'W$r', row: row, col: 3,
          options: _cardOptions(patcher, sh, 'W$r', const ['X', 'O'])));
      // 精通 `AN` / 攻击 `Z` / 伤害 `AB` 都是卡按武器名算出来的公式格，不是给人填的：
      // 工具读不到算式的结果（卡没在 Excel 里打开存过一次，这些格就是空的），
      // 摆出来只会是一列空白，还让人以为该填。所以只有真能写的格才摆。
      if (patcher.isWritableCell(sh, 'AN$r')) {
        fields.add(m('精通', 'text', 'AN$r', row: row, col: 4));
      }
      if (patcher.isWritableCell(sh, 'Z$r')) {
        fields.add(m('攻击', 'number', 'Z$r', row: row, col: 5));
      }
      if (patcher.isWritableCell(sh, 'AB$r')) {
        fields.add(m('伤害', 'text', 'AB$r', row: row, col: 6));
      }
      // 「弹药/充能」也一样：v1.1.1 的 `AP31` 表头是「弹药/充能计数」（能填），
      // 老版式（v1.0.12 / 悲灵）同一列的 `AP31` 是「效果」、`AP32` 是精通说明的公式 ——
      // 照着格子摆一个输入框，一填就把卡里那条公式盖掉了。
      if (patcher.isWritableCell(sh, 'AP$r')) {
        fields.add(m('弹药/充能', 'number', 'AP$r', row: row, col: 7));
      }
    }
    // 护甲：卡里 40 行左半那张表
    fields.add(m('护甲名', 'text', 'L40', section: '护甲', row: '护甲', col: 0,
        options: equip.armors));
    fields.add(m('同调', 'toggle', 'P40', section: '护甲', row: '护甲', col: 1,
        options: _cardOptions(patcher, sh, 'P40', const ['X', 'O'])));
    fields.add(m('加值', 'number', 'U40', section: '护甲', row: '护甲', col: 2));
    // AC `AF40` / 敏捷加值 `AI40` / 特性 `V40` 同理：卡按护甲名 + 敏捷算的，不用填
    if (patcher.isWritableCell(sh, 'AF40')) {
      fields.add(m('AC', 'number', 'AF40', section: '护甲', row: '护甲', col: 3));
    }
    if (patcher.isWritableCell(sh, 'AI40')) {
      fields.add(m('敏捷加值', 'number', 'AI40', section: '护甲', row: '护甲', col: 4));
    }
    if (patcher.isWritableCell(sh, 'V40')) {
      fields.add(m('特性', 'text', 'V40', section: '护甲', row: '护甲', col: 5));
    }
    // 盾牌：卡里 40 行右半那张表（着装是盾牌这一格，不是护甲的）
    fields.add(m('盾牌名', 'text', 'AL40', section: '盾牌', row: '盾牌', col: 0,
        options: equip.shields));
    fields.add(m('同调', 'toggle', 'AP40', section: '盾牌', row: '盾牌', col: 1,
        options: _cardOptions(patcher, sh, 'AP40', const ['X', 'O'])));
    fields.add(m('AC', 'number', 'AQ40', section: '盾牌', row: '盾牌', col: 2));
    fields.add(m('着装', 'toggle', 'AS40', section: '盾牌', row: '盾牌', col: 3,
        options: _cardOptions(patcher, sh, 'AS40', const ['是', '否'])));
    _formCache[key] = fields;
    _formCacheKey[key] = stamp;
    return fields;
  }

  if (key == 'bag') {
    // 「背包」这一页只写卡里 `背包` 表那几块存货格子；武器 / 护甲 / 盾是**另一批格子**，
    // 在「武器 / 护甲 / 盾」那一页，两边不重叠。
    //
    // 几个存货区是**认出来的**：卡里给「稀有度」配了一串下拉
    // （`普通,非普通,珍稀,极珍稀,传说,神器`），它的 sqref 正好只盖住真正的存货格
    // ——v1.1.1 和悲灵都是 `AC5:AD14`、`AC16:AD25`、`AC29:AD38`、`AC40:AD49`。
    // 拿这些范围切区块，表头行 = 区块上面那一行，按表头文字找「名称 / 描述 / lb / 数量」列；
    // 区块往上第一个非空的「名称」格就是背包自己的名字（背包1 / 次元袋…）。换版式不用改代码。
    const sh = '背包';
    final fields = <FormField>[];
    final perCol = <String, List<int>>{};
    for (final r in patcher.validationRanges(sh, '非普通')) {
      final m = RegExp(r'^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$').firstMatch(r);
      if (m == null) continue;
      final r1 = int.parse(m.group(2)!);
      final r2 = m.group(4) != null ? int.parse(m.group(4)!) : r1;
      (perCol[m.group(1)!] ??= []).addAll([for (var i = r1; i <= r2; i++) i]);
    }
    if (perCol.isNotEmpty) {
      final rar = perCol.entries.reduce((a, b) => b.value.length > a.value.length ? b : a);
      final rows = rar.value.toSet().toList()..sort();
      final blocks = <List<int>>[];
      for (final r in rows) {
        if (blocks.isNotEmpty && r == blocks.last.last + 1) {
          blocks.last.add(r);
        } else {
          blocks.add([r]);
        }
      }
      // 表头行里按文字找列：只认离稀有度列最近的那一个（同一行别处也有「lb」之类）
      String nearCol(int headerRow, List<String> names, {required bool right}) {
        final want = colNum(rar.key);
        String best = '';
        var bestD = 1 << 20;
        for (final c in patcher.cells(sh)) {
          if (c.row != headerRow) continue;
          if (!names.contains((patcher.cellValue(sh, c) ?? '').trim())) continue;
          final d = colNum(c.column) - want;
          if (right ? d < 0 : d > 0) continue;
          if (d.abs() < bestD) {
            bestD = d.abs();
            best = c.column;
          }
        }
        return best;
      }
      final seen = <String, int>{};
      for (final blk in blocks) {
        final headerRow = blk.first - 1;
        final nameCol = nearCol(headerRow, const ['名称'], right: false);
        if (nameCol.isEmpty) continue;
        final descCol = nearCol(headerRow, const ['描述'], right: true);
        final lbCol = nearCol(headerRow, const ['lb', '磅', '重量'], right: true);
        final qtyCol = nearCol(headerRow, const ['数量'], right: true);
        var title = '';
        for (var r = headerRow - 1; r >= 1 && title.isEmpty; r--) {
          final t = patcher.cellText(sh, '$nameCol$r').trim();
          if (t.isNotEmpty && t != '名称') title = t;
        }
        if (title.isEmpty) title = '背包';
        seen[title] = (seen[title] ?? 0) + 1;
        final section = seen[title]! > 1 ? '$title（${seen[title]}）' : title;
        var n = 0;
        for (final r in blk) {
          n++;
          final row = '第 $n 件';
          FormField f(String label, String cell, String kind, int col, {List<String> options = const []}) =>
              FormField(
                field: 'bag_${cell}_$col',
                label: label,
                section: section,
                kind: kind,
                cell: cell,
                value: patcher.cellText(sh, cell),
                options: options,
                detected: patcher.isWritableCell(sh, cell),
                sheet: sh,
                row: row,
                col: col,
              );
          fields.add(f('名称', '$nameCol$r', 'text', 0));
          fields.add(f('稀有度', '${rar.key}$r', 'select', 1,
              options: _cardOptions(patcher, sh, '${rar.key}$r', const [])));
          if (descCol.isNotEmpty) fields.add(f('描述', '$descCol$r', 'text', 2));
          if (lbCol.isNotEmpty) fields.add(f('lb', '$lbCol$r', 'number', 3));
          if (qtyCol.isNotEmpty) fields.add(f('数量', '$qtyCol$r', 'number', 4));
        }
      }
    }
    if (fields.isEmpty) {
      // 认不出来就问清楚（老版式卡没有「稀有度」那串下拉，切不出区块）。
      // 宁可在页面上说一句，也不要给一个空白页让人以为卡坏了。
      fields.add(FormField(
        field: 'bag_unrecognized',
        label: '没认出这张卡的背包格子',
        section: '背包',
        kind: 'readonly',
        cell: '',
        value: '卡里 `背包` 表的「稀有度」列没有配下拉（老版式卡就没有），'
            '认不出存货区在哪几行，所以这页先不给格子 —— 用新模板新卡会有。',
        options: const [],
        sheet: sh,
        detected: true,
      ));
    }
    _formCache[key] = fields;
    _formCacheKey[key] = stamp;
    return fields;
  }

  if (key == 'magic') {
    // 「魔法物品」这一页只放卡里属于它的两块：
    //
    //   奇物   `L41` 表头（v1.1.1 行 42–50 九行）——名称 `L`、同调 `P`、
    //          稀有度 `R`（卡里那张 普通/非普通/… 下拉是 `R42:T50`）、部位 `U`、特性 `W`
    //   消耗品 `L51` 表头（行 52–56 五行）——名称 `L`、稀有度 `R`、描述 `U`、数量 `AP`
    //
    // 武器 / 护甲 / 盾 属于「装备」那一页（写的是同一批格子），不在这里再抄一遍——
    // 两边都摆一遍，改哪边都一样、读卡还会把同一件东西读出来两次。
    const sh = kMainSheet;
    final fields = <FormField>[];
    // 跟装备页同一个道理：老版式卡上这几块位置不同 → 字段照样给（界面别缺东西），
    // 但打上 `detected: false`，写入时服务器拦住并如实报告，不会写到技能格上。
    final gearOk = _gearBlocksRecognized(patcher);
    FormField m(String label, String kind, String cell,
        {String section = '奇物', String row = '', int col = 0, List<String> options = const []}) {
      return FormField(
        field: 'magic_${cell}_$col',
        label: label,
        section: section,
        kind: kind,
        cell: cell,
        value: patcher.cellText(sh, cell),
        options: options,
        detected: gearOk && (_writable(patcher, cell) || _cellExists(patcher, cell)),
        sheet: sh,
        row: row,
        col: col,
      );
    }

    // 奇物那一块有多少格从卡里认：v1.0.12 是 L42:L51（10 格），v1.1.1 是 L42:L50
    // （9 格，L51 已经是「消耗品」的表头）。写死 10 格会把表头当第 10 件奇物。
    final curioBlock = _magicItemBlock(patcher);
    final firstCurio = curioBlock.startRow;
    final rarity = patcher.validationOptions(sh, 'R$firstCurio');
    final attuneOpts = _cardOptions(patcher, sh, 'P$firstCurio', const ['X', 'O']);
    // 奇物名的候选：词条库里的 307 条魔法物品（跟上面那个「魔法物品速查」同一份数据）
    final curios = repo.ofType('magicItem').map((e) => e.name).toList()..sort();
    for (var r = curioBlock.startRow; r <= curioBlock.endRow; r++) {
      final row = '第 ${r - firstCurio + 1} 件';
      fields.add(m('奇物名', 'text', '${curioBlock.column}$r', row: row, col: 0, options: curios));
      fields.add(m('同调', 'toggle', 'P$r', row: row, col: 1,
          options: attuneOpts));
      fields.add(m('稀有度', 'select', 'R$r', row: row, col: 2, options: rarity));
      fields.add(m('部位', 'text', 'U$r', row: row, col: 3));
      // 特性那一列：卡里是公式就是只读（卡自己算），空白的就让你自己写
      fields.add(m('特性', _writable(patcher, 'W$r') ? 'text' : 'readonly', 'W$r', row: row, col: 4));
    }
    // 消耗品：卡里紧挨着奇物的另一块（名称 / 稀有度 / 描述 / 数量）
    final consumables = _consumableBlock(patcher);
    if (consumables != null) {
      for (var r = consumables.startRow; r <= consumables.endRow; r++) {
        final row = '第 ${r - consumables.startRow + 1} 件';
        fields.add(m('名称', 'text', '${consumables.column}$r',
            section: '消耗品', row: row, col: 0));
        fields.add(m('稀有度', 'select', 'R$r', section: '消耗品', row: row, col: 1, options: rarity));
        fields.add(m('描述', 'text', 'U$r', section: '消耗品', row: row, col: 2));
        fields.add(m('数量', 'number', 'AP$r', section: '消耗品', row: row, col: 3));
      }
    }
    _formCache[key] = fields;
    _formCacheKey[key] = stamp;
    return fields;
  }

  // 职业三格（主职业 / 子职业 / 等级）：跟职业页同一套识别
  final clsSel = patcher.linkedSelectors(sheet: kClassSheet, sourceSheet: kMainSheet);
  String clsCell(int i) => i < clsSel.length ? '${clsSel[i].column}${clsSel[i].row}' : '';
  // 兼职两行就在主职业下面一行/两行
  String downOne(String cell, int n) {
    if (cell.isEmpty) return '';
    final m = RegExp(r'^([A-Z]+)(\d+)$').firstMatch(cell);
    if (m == null) return '';
    return '${m.group(1)}${int.parse(m.group(2)!) + n}';
  }
  // 种族 / 亚种：种族表里成段引用「主要」的那一列要排除掉
  final speciesCols = patcher
      .linkedBlocks(sheet: '种族', sourceSheet: kMainSheet, minRun: 3)
      .map((b) => b.column)
      .toList();
  final speciesSel = patcher
      .selectorGroups(sheet: '种族', sourceSheet: kMainSheet)
      .map((g) => g.where((c) => !speciesCols.contains(c.column)).toList())
      .where((g) => g.isNotEmpty)
      .toList();
  String speciesCell(int i) => i < speciesSel.length && speciesSel[i].isNotEmpty
      ? '${speciesSel[i][0].column}${speciesSel[i][0].row}'
      : '';

  String pick(String detected, String fallback) {
    if (detected.isNotEmpty && _writable(patcher, detected)) return detected;
    if (!_writable(patcher, fallback)) return '';
    return fallback;
  }

  // 选项一律先问卡自己：卡里没列的名字，填进去卡也查不出结果。
  // 词条库只在卡里找不到这份清单时兜底。
  final lists = CardLists.from(patcher);
  final cls0 = pick(clsCell(0), 'E6');
  final cls1 = pick(downOne(clsCell(0), 1), 'E7');
  final race0 = pick(speciesCell(0), 'T6');
  final curCls = cls0.isEmpty ? '' : patcher.cellText(kMainSheet, cls0);
  final curCls2 = cls1.isEmpty ? '' : patcher.cellText(kMainSheet, cls1);
  final curRace = race0.isEmpty ? '' : patcher.cellText(kMainSheet, race0);
  final classOptions = lists.classes.isNotEmpty
      ? lists.classes
      : _facetDesc('classFeature', '职业').keys.toList();
  final subOptions = lists.subclassesByClass.isNotEmpty
      ? lists.subclassesOf(curCls)
      : _facetDesc('classFeature', '子职').keys.take(120).toList();
  final sub2Options = lists.subclassesByClass.isNotEmpty ? lists.subclassesOf(curCls2) : subOptions;
  final raceOptions = lists.races.isNotEmpty
      ? lists.races
      : _facetDesc('species', 'category').keys.toList();
  final subraceOptions = lists.subracesOf(curRace);
  final bgOptions = lists.backgrounds.isNotEmpty
      ? lists.backgrounds
      : patcher.columnValues('背景', 'B', 2, 80).values.toList();
  final alignCell = pick('', _basicFallback['alignment']!);
  final alignOptions = alignCell.isEmpty
      ? const <String>[]
      : patcher.validationOptions(kMainSheet, alignCell);

  FormField mk(String field, String label, String section, String kind, String cell,
          {List<String> options = const [],
          bool? detected,
          String parent = '',
          Map<String, List<String>> optionsByParent = const {},
          String sheet = kMainSheet}) =>
      FormField(
        field: field,
        label: label,
        section: section,
        kind: kind,
        cell: cell,
        value: cell.isEmpty ? '' : patcher.cellText(sheet, cell),
        options: options,
        // 没明说「识别到没有」的字段（角色名 / 玩家 / 经验值 / 兼职 / 阵营 / 信仰）
        // 按格子自己判断：找得到且能写就是认出来了。以前这里默认 false，界面于是
        // 给这些字段永远挂一个 ⚠，看着像没认出来，其实写入是正常的。
        detected: detected ?? (cell.isNotEmpty && patcher.isWritableCell(sheet, cell)),
        parent: parent,
        optionsByParent: optionsByParent,
        sheet: sheet,
      );

  final fields = <FormField>[
    mk('name', '角色名', '身份', 'text', pick('', _basicFallback['name']!)),
    mk('player', '玩家', '身份', 'text', pick('', _basicFallback['player']!)),
    mk('cls', '主职业', '等级与职业', 'select', pick(clsCell(0), 'E6'),
        options: classOptions, detected: clsSel.isNotEmpty),
    mk('sub', '子职业', '等级与职业', 'select', pick(clsCell(1), 'I6'),
        options: subOptions, detected: clsSel.length > 1,
        parent: 'cls', optionsByParent: lists.subclassesByClass),
    mk('level', '等级', '等级与职业', 'number', pick(clsCell(2), 'O6'),
        options: [for (var i = 1; i <= 20; i++) '$i'], detected: clsSel.length > 2),
    mk('xp', '经验值', '等级与职业', 'number', pick('', _basicFallback['xp']!)),
    mk('cls2', '兼职1 职业', '兼职', 'select', pick(downOne(clsCell(0), 1), 'E7'),
        options: classOptions),
    mk('sub2', '兼职1 子职', '兼职', 'select', pick(downOne(clsCell(1), 1), 'I7'),
        options: sub2Options, parent: 'cls2', optionsByParent: lists.subclassesByClass),
    mk('lv2', '兼职1 等级', '兼职', 'number', pick(downOne(clsCell(2), 1), 'O7')),
    mk('race', '种族', '起源', 'select', pick(speciesCell(0), 'T6'),
        options: raceOptions, detected: speciesSel.isNotEmpty),
    mk('subrace', '亚种', '起源', 'select', pick(speciesCell(1), 'T7'),
        options: subraceOptions, detected: speciesSel.length > 1,
        parent: 'race', optionsByParent: lists.subracesByRace),
    // 出身写在「起源」表，不在「主要」表里
    mk('background', '出身', '起源', 'select', 'E6',
        options: bgOptions, detected: patcher.hasSheet('起源'), sheet: '起源'),
    mk('alignment', '阵营', '起源', 'select', alignCell, options: alignOptions),
    mk('faith', '信仰', '起源', 'text', pick('', _basicFallback['faith']!)),
    // 「属性与技能」那一页的内容直接并进第一页：六项属性 + 技能表都在这儿填
    ..._attrAndSkillFields(patcher),
  ];
  _formCache[key] = fields;
  _formCacheKey[key] = stamp;
  return fields;
}

/// 能写吗：格子要存在，而且不能是公式（公式格是卡自己算的，不能覆盖）
bool _writable(XlsxPatcher patcher, String cell) {
  if (cell.isEmpty) return false;
  return patcher.isWritableCell(kMainSheet, cell);
}

/// 格子在不在（只读展示用，公式格也算存在）
bool _cellExists(XlsxPatcher patcher, String cell) {
  if (cell.isEmpty) return false;
  return patcher.hasCell(kMainSheet, cell);
}

Future<Map<String, dynamic>> _formJson(String key, {bool refresh = false}) async {
  final title = _formTitles[key];
  if (title == null) return {'error': '未知表单：$key'};
  if (refresh) _formCacheKey[key] = '';
  final fields = await _formFields(key, kTable);
  final sections = <Map<String, dynamic>>[];
  for (final f in fields ?? const <FormField>[]) {
    var s = sections.where((x) => x['title'] == f.section).toList();
    if (s.isEmpty) {
      final m = <String, dynamic>{'title': f.section, 'fields': <Object>[]};
      sections.add(m);
      s = [m];
    }
    (s.first['fields'] as List).add(f.toJson());
  }
  return {
    'key': key,
    'title': title,
    'sheet': kMainSheet,
    'table': kTable,
    'name': p.basename(kTable),
    'exists': fields != null,
    'sections': sections,
  };
}

/// 模板里每个词条列开头有几格是「卡自己的结构」（标签 / 卡算出来的行标题），
/// 这些既不该在初始化时被清掉，读卡时也不该当成玩家填的词条。
Map<String, int> _templateHeadLen(XlsxPatcher tpl) {
  final out = <String, int>{};
  for (final key in ['class', 'species', 'feat', 'magic']) {
    final b = _templateBlock(tpl, key);
    if (b == null) continue;
    var n = 0;
    for (final c in b.cells) {
      if (tpl.cellText(kMainSheet, c).trim().isEmpty) break;
      n++;
    }
    out[key] = n;
  }
  return out;
}

/// 基准卡里这一页对应的名称输入列（跟服务端认目标卡用的是同一套识别）
SpellBlock? _templateBlock(XlsxPatcher tpl, String key) {
  final spec = pageSpecs[key];
  if (spec == null) return null;
  var bs = tpl.linkedBlocks(sheet: spec.drivingSheet, sourceSheet: kMainSheet, minRun: 3);
  if (bs.isEmpty) bs = tpl.linkedBlocks(sourceSheet: kMainSheet, minRun: 3);
  if (key == 'magic') bs = [_magicItemBlock(tpl)];
  if (bs.isEmpty) return null;
  bs.sort((a, b) => b.slots.compareTo(a.slots));
  return bs.first;
}

/// 「目标卡这一块开头有几格是卡自己的结构」。
///
/// 只有当目标卡的块和基准卡的块**位置一致**（同列同起始行）时才认——认得出的
/// 情况下两边的结构行也一致；对不上就返回 0，宁可多读几条，也别把玩家的词条吃掉。
int _headLenFor(XlsxPatcher? tpl, String key, SpellBlock? block) {
  if (tpl == null || block == null) return 0;
  final tb = _templateBlock(tpl, key);
  if (tb == null || tb.column != block.column || tb.startRow != block.startRow) return 0;
  return _templateHeadLen(tpl)[key] ?? 0;
}

/// 换卡（换目标表）之后，所有按表缓存的都得丢掉：
/// 表信息、各表单、各词条页的槽位识别结果都属于"上一张卡"。
void _dropTableCaches() {
  _tableCacheKey = '';
  _formCacheKey.clear();
  _pageCacheKey.clear();
  // 目标表的解析结果也一起丢：卡刚被写过，重新解一份才读得到新值
  _tablePatcherCache = null;
  _tablePatcherKey = '';
}

Future<String?> _setTable(String path, {bool mustExist = true}) async {
  final target = p.normalize(path);
  if (mustExist && !await File(target).exists()) return '文件不存在：$target';
  if (!target.toLowerCase().endsWith('.xlsx')) return '只能选 .xlsx 文件：$target';
  kTable = target;
  await _saveConfig();
  _dropTableCaches();
  return null;
}

/// 从空白模板复制一张新卡。
/// 用模板新建一张表；成功返回 null，失败返回原因
Future<String?> _createFromTemplate(String target, {required bool overwrite}) async {
  final path = p.normalize(target);
  if (!await File(kTemplatePath).exists()) return '找不到空白模板：$kTemplatePath（可用 --template 指定）';
  if (await File(path).exists() && !overwrite) return '同名文件已存在：$path';
  try {
    await Directory(p.dirname(path)).create(recursive: true);
    await File(kTemplatePath).copy(path);
  } catch (e) {
    return '新建失败：$e';
  }
  _createdThisSession.add(path);
  kTable = path;
  await _saveConfig();
  _dropTableCaches();
  return null;
}

/// 写入前备份：返回备份文件路径
Future<String?> _backup(String path) async {
  final f = File(path);
  if (!await f.exists()) return null;
  final dir = p.dirname(path);
  final base = p.basenameWithoutExtension(path);
  final now = DateTime.now();
  String two(int n) => n.toString().padLeft(2, '0');
  final stamp = '${now.year}${two(now.month)}${two(now.day)}-${two(now.hour)}${two(now.minute)}${two(now.second)}';
  final target = p.join(dir, '$base.备份-$stamp.xlsx');
  await f.copy(target);
  // 只留最近 10 份备份，免得目录越堆越乱
  try {
    final backups = (await Directory(dir).list().toList())
        .whereType<File>()
        .where((x) => p.basename(x.path).startsWith('$base.备份-'))
        .toList()
      ..sort((a, b) => a.path.compareTo(b.path));
    for (final old in backups.take(backups.length - 10)) {
      await old.delete();
    }
  } catch (_) {}
  return target;
}

// ---------------------------------------------------------------- 配置
File get _configFile => File(p.join(kAppRoot, '.quickref.json'));

/// 整个 .quickref.json 的内容。除了记住的表格，还存「上次从出身 / 职业效果写过哪些格」，
/// 好让换出身时能把上一次写进去的东西还原回去。
Map<String, dynamic> _cfg = {};

/// 上一次从某个来源（`background` / `class`）写进这张表的格子。
/// 每条记着：写到哪一格、写的是什么、写之前那一格是什么。
List<Map<String, String>> _lastEffectWrites(String source) {
  final all = _cfg['effectWrites'];
  if (all is! Map) return const [];
  final list = all['${p.normalize(kTable).toLowerCase()}|$source'];
  if (list is! List) return const [];
  final out = <Map<String, String>>[];
  for (final x in list) {
    if (x is! Map) continue;
    out.add({
      'sheet': (x['sheet'] ?? '').toString(),
      'cell': (x['cell'] ?? '').toString(),
      'value': (x['value'] ?? '').toString(),
      'old': (x['old'] ?? '').toString(),
    });
  }
  return out;
}

Future<void> _rememberEffectWrites(String source, List<Map<String, String>> rows) async {
  final all = <String, dynamic>{};
  final prev = _cfg['effectWrites'];
  if (prev is Map) for (final e in prev.entries) all[e.key.toString()] = e.value;
  all['${p.normalize(kTable).toLowerCase()}|$source'] = rows;
  _cfg['effectWrites'] = all;
  await _saveConfig();
}

/// 换出身 / 换职业时，先把上一次同一来源写进去的格子还原。
/// 只还原「现在的内容还等于我们上次写的那个值」的格子——用户后来自己改过的就不动。
({Map<String, Map<String, String>> writes, List<String> restored}) _planUndo(
    XlsxPatcher p, String source) {
  final writes = <String, Map<String, String>>{};
  final restored = <String>[];
  for (final r in _lastEffectWrites(source)) {
    final sheet = r['sheet'] ?? '';
    final cell = r['cell'] ?? '';
    if (sheet.isEmpty || cell.isEmpty) continue;
    if (!p.hasSheet(sheet)) continue;
    if (p.cellText(sheet, cell).trim() != (r['value'] ?? '').trim()) continue;
    (writes[sheet] ??= {})[cell] = r['old'] ?? '';
    restored.add('$sheet!$cell');
  }
  return (writes: writes, restored: restored);
}

/// 把这次的写入记成「下次要撤销的清单」（连同写入前每一格的旧值）
List<Map<String, String>> _effectRecord(XlsxPatcher p, List<Map<String, String>> written) => [
      for (final e in written)
        {
          'sheet': e['sheet'] ?? '',
          'cell': e['cell'] ?? '',
          'value': e['value'] ?? '',
          'old': p.cellText(e['sheet'] ?? '', e['cell'] ?? ''),
        },
    ];

Future<void> _saveConfig() async {
  try {
    _cfg['table'] = kTable;
    await _configFile.writeAsString(jsonEncode(_cfg));
  } catch (_) {}
}

Future<String?> _loadConfig() async {
  try {
    if (!await _configFile.exists()) return null;
    final j = jsonDecode(await _configFile.readAsString());
    if (j is Map) _cfg = j.cast<String, dynamic>();
    final t = (j is Map ? (j['table'] ?? j['card']) : null)?.toString();
    if (t != null && t.isNotEmpty && await File(t).exists()) return t;
  } catch (_) {}
  return null;
}

// ---------------------------------------------------------------- 目录浏览
Future<Map<String, dynamic>> _fsListing(String dir) async {
  String norm;
  try {
    norm = p.normalize(dir);
  } catch (_) {
    // 手动选择那个框里手打的路径可能是坏的，别让整个接口 500
    return {'dir': dir, 'exists': false, 'error': '这个路径不对：$dir', 'entries': <Object>[], 'table': kTable};
  }
  final d = Directory(norm);
  if (!await d.exists()) {
    return {'dir': norm, 'exists': false, 'entries': <Object>[], 'table': kTable};
  }
  final entries = <Map<String, dynamic>>[];
  await for (final e in d.list(followLinks: false)) {
    final name = p.basename(e.path);
    if (name.startsWith('.') || name.startsWith('~')) continue;
    try {
      final st = await e.stat();
      final isDir = st.type == FileSystemEntityType.directory;
      if (!isDir && !name.toLowerCase().endsWith('.xlsx')) continue;
      if (!isDir && p.basenameWithoutExtension(name).contains('.备份-')) continue;
      entries.add({
        'name': name,
        'path': p.normalize(e.path),
        'isDir': isDir,
        'size': st.size,
        'mtime': st.modified.toIso8601String().substring(0, 16).replaceAll('T', ' '),
        'isTable': p.equals(p.normalize(e.path), p.normalize(kTable)),
      });
    } catch (_) {}
  }
  entries.sort((a, b) {
    if (a['isDir'] != b['isDir']) return a['isDir'] == true ? -1 : 1;
    return (a['name'] as String).toLowerCase().compareTo((b['name'] as String).toLowerCase());
  });
  return {
    'dir': norm,
    'exists': true,
    'parent': p.dirname(norm),
    'entries': entries,
    'table': kTable,
    'roots': await _roots(),
  };
}

Future<List<String>> _roots() async {
  final out = <String>[];
  final home = Platform.environment['USERPROFILE'];
  if (home != null && home.isNotEmpty) {
    for (final sub in ['Desktop', 'Documents', 'Downloads']) {
      final d = p.join(home, sub);
      if (await Directory(d).exists()) out.add(p.normalize(d));
    }
  }
  out.add(p.normalize(kWorkspaceRoot));
  out.add(p.normalize(p.join(kWorkspaceRoot, 'card')));
  // 所有盘符
  for (var c = 'A'.codeUnitAt(0); c <= 'Z'.codeUnitAt(0); c++) {
    final root = '${String.fromCharCode(c)}:\\';
    try {
      if (await Directory(root).exists()) out.add(root);
    } catch (_) {}
  }
  return out;
}

/// 弹原生对话框；取消返回 null。
/// folder=选文件夹 / open=打开文件 / save=另存为。
/// 结果经临时文件回传，避免控制台代码页把中文路径搞乱。
Future<String?> _nativePick({
  required String mode,
  required String dir,
  String name = '',
}) async {
  final tmp = p.join(Directory.systemTemp.path, 'dnd_quickref_pick.txt');
  final tmpFile = File(tmp);
  if (await tmpFile.exists()) await tmpFile.delete();
  final sq = (String s) => s.replaceAll("'", "''");
  final filter = 'Excel 人物卡 (*.xlsx)|*.xlsx|所有文件 (*.*)|*.*';

  String body;
  if (mode == 'folder') {
    body = '''
\$d = New-Object System.Windows.Forms.FolderBrowserDialog
\$d.Description = 'Choose folder'
\$d.ShowNewFolderButton = \$true
if ('${sq(dir)}' -ne '') { \$d.SelectedPath = '${sq(dir)}' }
if (\$d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { \$p = \$d.SelectedPath }
''';
  } else if (mode == 'open') {
    body = '''
\$d = New-Object System.Windows.Forms.OpenFileDialog
\$d.Title = '选择要填入的人物卡'
\$d.Filter = '${sq(filter)}'
\$d.InitialDirectory = '${sq(dir)}'
if (\$d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { \$p = \$d.FileName }
''';
  } else {
    body = '''
\$d = New-Object System.Windows.Forms.SaveFileDialog
\$d.Title = '新建人物卡'
\$d.Filter = '${sq(filter)}'
\$d.InitialDirectory = '${sq(dir)}'
\$d.FileName = '${sq(name.isEmpty ? '新人物卡.xlsx' : name)}'
\$d.OverwritePrompt = \$true
if (\$d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { \$p = \$d.FileName }
''';
  }

  final script = '''
Add-Type -AssemblyName System.Windows.Forms | Out-Null
\$p = ''
$body
if (\$p -ne '') { [IO.File]::WriteAllText('${sq(tmp)}', \$p, [Text.Encoding]::UTF8) }
''';
  try {
    await Process.run('powershell', ['-NoProfile', '-STA', '-Command', script]);
  } catch (e) {
    stderr.writeln('原生对话框失败: $e');
    return null;
  }
  if (!await tmpFile.exists()) return null;
  final picked = (await tmpFile.readAsString()).trim();
  return picked.isEmpty ? null : p.normalize(picked);
}
