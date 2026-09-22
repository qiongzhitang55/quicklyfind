import 'dart:io';
import 'package:path/path.dart' as p;
Future<void> main() async {
  final tmp = p.join(Directory.systemTemp.path, 'enc_probe.txt');
  final script = "Add-Type -AssemblyName System.Windows.Forms | Out-Null; " +
      "[IO.File]::WriteAllText('${tmp.replaceAll("'", "''")}', 'D:\\quicklyFind\\实验区\\cards', [Text.Encoding]::UTF8)";
  await Process.run('powershell', ['-NoProfile', '-STA', '-Command', script]);
  final v = (await File(tmp).readAsString()).trim();
  print('  读回: $v');
  print('  中文路径是否正确: ${v.contains("实验区")}');
  print('  WinForms 可加载: ${(await Process.run("powershell", ["-NoProfile","-STA","-Command", r"Add-Type -AssemblyName System.Windows.Forms; 'ok'"])).stdout.toString().trim()}');
}
