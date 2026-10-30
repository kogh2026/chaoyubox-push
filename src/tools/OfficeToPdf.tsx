import { useEffect, useRef, useState } from 'react';
import { useHotkeyActions } from '../lib/hotkeys';

interface ElectronAPI {
  isElectron?: boolean;
  checkOffice?: (p?: string) => Promise<{ available: boolean; path: string | null }>;
  convertOffice?: (a: { files: string[]; sofficePath?: string }) => Promise<{
    ok: boolean;
    error?: string;
    results: { input: string; output: string | null; ok: boolean; error?: string }[];
  }>;
  openPath?: (p: string) => Promise<{ ok: boolean; error?: string }>;
}

const api = (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;
const isElectron = !!api?.isElectron;

const OFFICE_EXT = ['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'];
const LIBRE_URL = 'https://www.libreoffice.org/download/download-libreoffice/';

interface FileItem {
  name: string;
  path?: string;
  status: 'wait' | 'done' | 'fail';
  output?: string | null;
}

export default function OfficeToPdf() {
  const [files, setFiles] = useState<FileItem[]>([]);
  const [officeReady, setOfficeReady] = useState<null | boolean>(null);
  const [sofficePath, setSofficePath] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useHotkeyActions('office-to-pdf', 'Office 转 PDF', {
    import: () => inputRef.current?.click(),
  });

  useEffect(() => {
    if (!isElectron || !api?.checkOffice) {
      setOfficeReady(false);
      return;
    }
    api.checkOffice().then((r) => {
      setOfficeReady(r.available);
      if (r.path && r.path !== 'soffice') {
        // 已检测到非 PATH 的默认安装，可提示但不强制
      }
    });
  }, []);

  function pick(list: FileList | null) {
    if (!list) return;
    const items: FileItem[] = [];
    for (const f of Array.from(list)) {
      const lower = f.name.toLowerCase();
      if (OFFICE_EXT.some((e) => lower.endsWith(e))) {
        items.push({ name: f.name, path: (f as unknown as { path?: string }).path, status: 'wait' });
      }
    }
    if (items.length) setFiles((prev) => [...prev, ...items]);
  }

  async function convert() {
    if (!api?.convertOffice) return;
    const paths = files.map((f) => f.path).filter(Boolean) as string[];
    if (paths.length === 0) {
      setMsg('未获取到本地文件路径（请在桌面应用中拖入文件）。');
      return;
    }
    setBusy(true);
    setMsg('转换中…');
    try {
      const res = await api.convertOffice({ files: paths, sofficePath: sofficePath || undefined });
      if (!res.ok) {
        setMsg('转换失败：' + (res.error || '未知错误'));
        setBusy(false);
        return;
      }
      setFiles((prev) =>
        prev.map((f) => {
          const r = res.results.find((x) => x.input === f.path);
          return r ? { ...f, status: r.ok ? 'done' : 'fail', output: r.output } : f;
        }),
      );
      const okCount = res.results.filter((r) => r.ok).length;
      setMsg(`完成 ${okCount}/${res.results.length} 个文件`);
    } catch (e) {
      setMsg('转换异常：' + String(e));
    }
    setBusy(false);
  }

  async function openOut(p?: string | null) {
    if (p && api?.openPath) await api.openPath(p);
  }

  return (
    <div className="office-pdf">
      <header className="tool-head">
        <h1>Office 转 PDF</h1>
        <p>Word / Excel / PPT → PDF（桌面应用调用 LibreOffice 本地转换，不上传云端）</p>
      </header>

      {!isElectron && (
        <div className="warn-box">
          <b>此功能需在桌面应用中使用。</b> 当前是浏览器预览版，无法调用本地 LibreOffice。
          请用 <code>npm run build &amp;&amp; npm run electron</code> 启动桌面版。
        </div>
      )}

      {isElectron && officeReady === false && (
        <div className="warn-box">
          <b>未检测到 LibreOffice。</b> 请先安装（免费）：
          <a href={LIBRE_URL} target="_blank" rel="noreferrer"> 官方下载 </a>
          ，或手动指定 soffice 路径：
          <div className="param-row" style={{ marginTop: 8 }}>
            <input
              className="wide"
              placeholder="例如 C:\Program Files\LibreOffice\program\soffice.exe"
              value={sofficePath}
              onChange={(e) => setSofficePath(e.target.value)}
            />
            <button className="btn" onClick={() => api?.checkOffice?.(sofficePath).then((r) => setOfficeReady(r.available))}>
              检测
            </button>
          </div>
        </div>
      )}

      <section
        className="dropzone"
        onClick={() => inputRef.current?.click()}
      >
        点击选择 Word / Excel / PPT 文件（可多选）
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".doc,.docx,.xls,.xlsx,.ppt,.pptx"
          style={{ display: 'none' }}
          onChange={(e) => {
            pick(e.target.files);
            e.currentTarget.value = ''; // 同款文件重选时 change 才会再触发
          }}
        />
      </section>

      {files.length > 0 && (
        <table className="file-table">
          <thead>
            <tr>
              <th>文件名</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {files.map((f, i) => (
              <tr key={i}>
                <td className="fname">{f.name}</td>
                <td>
                  {f.status === 'wait' && <span className="tag bw">待转换</span>}
                  {f.status === 'done' && <span className="tag color">已生成 PDF</span>}
                  {f.status === 'fail' && <span className="tag dot">失败</span>}
                </td>
                <td>
                  {f.status === 'done' && (
                    <button className="link" onClick={() => openOut(f.output)}>
                      打开 PDF
                    </button>
                  )}
                  {!f.path && <span className="muted">无本地路径</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <section className="actions">
        <button className="btn primary" disabled={busy || files.length === 0 || officeReady !== true} onClick={convert}>
          {busy ? '转换中…' : '转换为 PDF'}
        </button>
      </section>

      {msg && <div className="progress-text">{msg}</div>}

      <div className="hint">
        说明：转换由本机 LibreOffice 完成（对应原版 aiyin-office.exe）。首次转换会启动 LibreOffice
        进程，可能需数秒；批量文件逐个转换。转换结果保存在系统临时目录，可点击"打开 PDF"查看。
      </div>
    </div>
  );
}
