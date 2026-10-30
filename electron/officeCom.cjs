// 本机 Office COM 转 PDF（P2 备选路径，对应原版 aiyin-office.exe 的做法）。
// 装了 Word/Excel/PowerPoint 时用官方导出接口，字体、表格、艺术字、中文排版保真度高于
// LibreOffice headless；任一环节不可用/失败都返回失败，由调用方回退 soffice。
// 纯 Node 模块（不依赖 electron），便于用 check 脚本单独验证。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

/** 扩展名 → COM 程序 + 导出方式 */
const COM_APPS = {
  '.doc': { progId: 'Word.Application', kind: 'word' },
  '.docx': { progId: 'Word.Application', kind: 'word' },
  '.xls': { progId: 'Excel.Application', kind: 'excel' },
  '.xlsx': { progId: 'Excel.Application', kind: 'excel' },
  '.ppt': { progId: 'PowerPoint.Application', kind: 'powerpoint' },
  '.pptx': { progId: 'PowerPoint.Application', kind: 'powerpoint' },
};

function appFor(file) {
  const ext = path.extname(String(file || '')).toLowerCase();
  return COM_APPS[ext] ? { ext, ...COM_APPS[ext] } : null;
}

/**
 * 生成 PowerShell 转换脚本（纯函数，便于断言）。
 * 输出路径用绝对路径；脚本末尾统一释放 COM 对象，避免 WINWORD 残留进程。
 */
function buildScript(kind, input, output) {
  const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  const head = '$ErrorActionPreference = "Stop"\n';
  if (kind === 'word') {
    return (
      head +
      `$app = New-Object -ComObject Word.Application\n` +
      `$app.Visible = $false\n` +
      `$app.DisplayAlerts = 0\n` +
      `try {\n` +
      `  $doc = $app.Documents.Open(${q(input)}, $false, $true)\n` +
      `  $doc.ExportAsFixedFormat(${q(output)}, 17)\n` +
      `  $doc.Close(0)\n` +
      `} finally {\n` +
      `  $app.Quit(0)\n` +
      `  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($app) | Out-Null\n` +
      `}\n`
    );
  }
  if (kind === 'excel') {
    return (
      head +
      `$app = New-Object -ComObject Excel.Application\n` +
      `$app.Visible = $false\n` +
      `$app.DisplayAlerts = $false\n` +
      `try {\n` +
      `  $wb = $app.Workbooks.Open(${q(input)}, 0, $true)\n` +
      `  $wb.ExportAsFixedFormat(0, ${q(output)})\n` +
      `  $wb.Close($false)\n` +
      `} finally {\n` +
      `  $app.Quit()\n` +
      `  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($app) | Out-Null\n` +
      `}\n`
    );
  }
  return (
    head +
    `$app = New-Object -ComObject PowerPoint.Application\n` +
    `try {\n` +
    `  $pres = $app.Presentations.Open(${q(input)}, $true, $false, $false)\n` +
    `  $pres.SaveAs(${q(output)}, 32)\n` +
    `  $pres.Close()\n` +
    `} finally {\n` +
    `  $app.Quit()\n` +
    `  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($app) | Out-Null\n` +
    `}\n`
  );
}

function runPowerShell(script, timeoutMs = 180000) {
  return new Promise((resolve) => {
    const tmp = path.join(os.tmpdir(), `chaoyu-officecom-${process.pid}-${Date.now()}.ps1`);
    try {
      // PowerShell 5.1 读脚本按 ANSI 解码，含中文路径必须写 UTF-8 BOM
      fs.writeFileSync(tmp, '\uFEFF' + script, 'utf8');
    } catch (e) {
      resolve({ ok: false, error: 'write-script: ' + String(e) });
      return;
    }
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmp],
      { timeout: timeoutMs, windowsHide: true },
      (err, stdout, stderr) => {
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* 临时文件留给系统清理 */
        }
        if (err) resolve({ ok: false, error: (stderr || err.message || '').trim().slice(0, 400) });
        else resolve({ ok: true, stdout: String(stdout || '').trim() });
      },
    );
  });
}

const availCache = new Map();

/** COM 程序是否可用（按 progId 缓存；不会启动 Office 进程） */
async function comAvailable(progId) {
  if (availCache.has(progId)) return availCache.get(progId);
  if (process.platform !== 'win32') {
    availCache.set(progId, false);
    return false;
  }
  const script =
    `$t = [Type]::GetTypeFromProgID('${String(progId).replace(/'/g, "''")}')\n` +
    `if ($t -ne $null) { 'yes' } else { 'no' }\n`;
  const r = await runPowerShell(script, 15000);
  const ok = r.ok && /yes/i.test(r.stdout || '');
  availCache.set(progId, ok);
  return ok;
}

/**
 * 用本机 Office 把一个文件转成 PDF。
 * @returns {Promise<{ok:boolean, output?:string, error?:string, skipped?:boolean}>}
 * skipped=true 表示这类文件/这台机器不走 COM（调用方应回退 LibreOffice）。
 */
async function convertWithCom(input, output) {
  const app = appFor(input);
  if (!app) return { ok: false, skipped: true, error: 'unsupported-for-com' };
  if (!(await comAvailable(app.progId))) return { ok: false, skipped: true, error: 'office-not-installed' };
  const script = buildScript(app.kind, path.resolve(input), path.resolve(output));
  const r = await runPowerShell(script);
  if (!r.ok) return { ok: false, error: r.error || 'com-convert-failed' };
  try {
    if (!fs.existsSync(output) || fs.statSync(output).size === 0) {
      return { ok: false, error: 'com-output-missing' };
    }
  } catch (e) {
    return { ok: false, error: 'com-output-check: ' + String(e) };
  }
  return { ok: true, output };
}

/** 测试用：清空可用性缓存 */
function resetCache() {
  availCache.clear();
}

module.exports = { COM_APPS, appFor, buildScript, comAvailable, convertWithCom, resetCache };
