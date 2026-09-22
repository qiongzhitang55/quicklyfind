// 法术速查填表 · Windows 桌面版
//
// 干的事很简单：把 quickref.exe（本地服务）拉起来，再用一个原生窗口把
// http://127.0.0.1:<端口> 显示出来。
// 服务端进程由这个窗口管着，窗口一关就一起收掉。
//
// 服务端找哪一份、数据读哪一套，按这个顺序定：
//   1. 本程序旁边就是一份完整的包（有 web\）→ 用包内的，数据也读包内的；
//   2. 上一层目录是这样一份包（`…\车卡小工具_windows版\桌面版\` 这种摆法）→ 同上；
//   3. 往上几层有 `实验区\quickref.exe`（开发目录）→ 用那份，让它自己认工作区；
//   4. 都没有就看自己旁边那份。
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:ui' show AppExitResponse;

import 'package:flutter/material.dart';
import 'package:webview_windows/webview_windows.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const QuickrefApp());
}

class QuickrefApp extends StatelessWidget {
  const QuickrefApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: '法术速查填表',
      debugShowCheckedModeBanner: false,
      theme: ThemeData.dark(useMaterial3: true),
      home: const QuickrefWindow(),
    );
  }
}

class QuickrefWindow extends StatefulWidget {
  const QuickrefWindow({super.key});

  @override
  State<QuickrefWindow> createState() => _QuickrefWindowState();
}

class _QuickrefWindowState extends State<QuickrefWindow> {
  final _controller = WebviewController();
  Process? _server;
  late final AppLifecycleListener _lifecycle;
  final _serverLog = <String>[];
  int? _serverExit;
  String _status = '正在启动本地服务…';
  bool _ready = false;
  bool _failed = false;

  @override
  void initState() {
    super.initState();
    _lifecycle = AppLifecycleListener(onExitRequested: () async {
      _stopServer();
      return AppExitResponse.exit;
    });
    _boot();
  }

  @override
  void dispose() {
    _lifecycle.dispose();
    _stopServer();
    _controller.dispose();
    super.dispose();
  }

  void _stopServer() {
    try {
      _server?.kill();
    } catch (_) {}
    _server = null;
  }

  /// 服务端最后几行输出（起不来的时候显示给用户看）
  String _logTail() {
    if (_serverLog.isEmpty) return '';
    final lines = _serverLog.length > 12
        ? _serverLog.sublist(_serverLog.length - 12)
        : _serverLog;
    return '\n——— 服务端说 ———\n${lines.join('\n')}';
  }

  /// 找服务端：先看有没有自包含的包（`web\` 跟 exe 同级），
  /// 再退回到开发目录里的 `实验区\quickref.exe`。
  _ServerPlan? _planServer(String appDir) {
    final sep = Platform.pathSeparator;
    String join(List<String> parts) => parts.join(sep);
    bool hasWeb(String dir) =>
        File(join([dir, 'web', 'index.html'])).existsSync();
    bool hasExe(String dir) =>
        File(join([dir, 'quickref.exe'])).existsSync();

    // 1. 本程序旁边就是一份打好的包
    if (hasWeb(appDir) && hasExe(appDir)) {
      return _ServerPlan(
        exe: join([appDir, 'quickref.exe']),
        workspace: appDir,
        why: '包内（自包含）',
      );
    }

    // 2. 上一层是包根目录：`…\车卡小工具_windows版\桌面版\xxx.exe`
    final up = Directory(appDir).parent.path;
    if (up != appDir && hasWeb(up) && hasExe(up)) {
      return _ServerPlan(
        exe: join([up, 'quickref.exe']),
        workspace: up,
        why: '上层目录的包（自包含）',
      );
    }

    // 3. 开发目录：往上几层找 `实验区\quickref.exe`
    var dir = appDir;
    for (var i = 0; i < 7; i++) {
      final c = join([dir, '实验区', 'quickref.exe']);
      if (File(c).existsSync()) {
        return _ServerPlan(exe: c, why: '工作区里的服务');
      }
      final parent = Directory(dir).parent.path;
      if (parent == dir) break;
      dir = parent;
    }

    // 4. 老习惯：写死的工作区路径
    const known = r'D:\quicklyFind\实验区\quickref.exe';
    if (File(known).existsSync()) {
      return _ServerPlan(exe: known, why: '工作区里的服务');
    }

    // 5. 兜底：自己旁边那份（可能缺 web\，服务端会给出提示）
    if (hasExe(appDir)) {
      return _ServerPlan(exe: join([appDir, 'quickref.exe']), why: '包内');
    }
    return null;
  }

  /// 把服务端的 stdout / stderr 收着，出问题时好显示
  void _pumpServerOutput(Process p) {
    void collect(Stream<List<int>> s) {
      s.transform(utf8.decoder).transform(const LineSplitter()).listen(
        (line) {
          final t = line.trim();
          if (t.isEmpty) return;
          _serverLog.add(t);
          if (_serverLog.length > 60) _serverLog.removeAt(0);
        },
        onError: (_) {},
        cancelOnError: false,
      );
    }

    collect(p.stdout);
    collect(p.stderr);
    p.exitCode.then((code) {
      _serverExit = code;
      if (!mounted || _ready || _failed) return;
      // 还没就绪就退了：别干等 20 秒
      setState(() {
        _failed = true;
        _status = '本地服务退出了（代码 $code）。$_logTail()';
      });
    });
  }

  Future<int> _freePort() async {
    final s = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    final port = s.port;
    await s.close();
    return port;
  }

  Future<bool> _waitForServer(int port,
      {Duration timeout = const Duration(seconds: 20)}) async {
    final deadline = DateTime.now().add(timeout);
    final client = HttpClient();
    while (DateTime.now().isBefore(deadline)) {
      if (_serverExit != null) return false; // 服务端已经退了，别等了
      try {
        final req =
            await client.getUrl(Uri.parse('http://127.0.0.1:$port/api/meta'));
        final res = await req.close();
        await res.drain<void>();
        if (res.statusCode == 200) return true;
      } catch (_) {
        // 还没起来，等一会儿再试
      }
      await Future<void>.delayed(const Duration(milliseconds: 250));
    }
    return false;
  }

  Future<void> _boot() async {
    final appDir = File(Platform.resolvedExecutable).parent.path;
    final plan = _planServer(appDir);
    if (plan == null) {
      setState(() {
        _failed = true;
        _status = '没找到 quickref.exe。\n\n'
            '一个能独立运行的包，应该是这个摆法：\n'
            '  法术速查填表.exe（或车卡小道具.exe）\n'
            '  quickref.exe\n'
            '  web\\   dnd-data\\   card\\\n\n'
            '开发目录里跑的话，先编一份：\n'
            r'dart compile exe bin\quickref.dart -o 实验区\quickref.exe';
      });
      return;
    }
    final port = await _freePort();
    final args = <String>['--port', '$port', '--no-open'];
    if (plan.workspace != null) {
      // 自包含的包：直接把目录指给服务端，省得它靠层级去猜
      args.addAll(['--workspace', plan.workspace!]);
    }
    try {
      _server = await Process.start(plan.exe, args,
          workingDirectory: File(plan.exe).parent.path);
    } catch (e) {
      setState(() {
        _failed = true;
        _status = '服务起不来（${plan.why}：${plan.exe}）：$e';
      });
      return;
    }
    _pumpServerOutput(_server!);
    setState(() => _status = '正在等本地服务就绪…');
    final ok = await _waitForServer(port);
    if (!ok) {
      if (_failed) return; // 退出码那条路已经写了原因
      setState(() {
        _failed = true;
        _status = '本地服务没起来（20 秒没响应）。$_logTail()';
      });
      return;
    }
    try {
      await _controller.initialize();
    } catch (e) {
      setState(() {
        _failed = true;
        _status = '窗口组件起不来：$e\n\n'
            '这东西靠系统的 WebView2（Win11 自带；Win10 没装的话，'
            '去微软官网装一个「WebView2 Runtime」）。';
      });
      return;
    }
    await _controller.loadUrl('http://127.0.0.1:$port/');
    if (!mounted) return;
    setState(() {
      _ready = true;
      _status = '';
    });
  }

  @override
  Widget build(BuildContext context) {
    if (!_ready) {
      return Scaffold(
        body: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (!_failed)
                const SizedBox(
                  width: 28,
                  height: 28,
                  child: CircularProgressIndicator(strokeWidth: 2.5),
                ),
              const SizedBox(height: 16),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 40),
                child: Text(_status, textAlign: TextAlign.center),
              ),
            ],
          ),
        ),
      );
    }
    return Scaffold(body: Webview(_controller));
  }
}

/// 该怎么起服务：用哪个 exe，要不要把目录直接指给它
class _ServerPlan {
  const _ServerPlan({required this.exe, this.workspace, required this.why});

  /// quickref.exe 的完整路径
  final String exe;

  /// 自包含的包：把包目录当 `--workspace` 传给服务端
  final String? workspace;

  /// 这一份是从哪儿找来的（出错时显示给用户）
  final String why;
}
