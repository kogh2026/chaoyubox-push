import { useEffect, useRef, useState } from 'react';

// 内嵌第三方开源项目「离线 PDF 工具箱（XCPDF）V7.1」（MIT，详见设置-关于-开源许可）。
// 单文件 HTML 位于 public/pdf-toolbox.html，完全自包含、无网络请求；
// 本页以 iframe 全屏承载，文件与处理全部在本机完成。
const SRC = 'pdf-toolbox.html';

export default function PdfToolbox() {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  // 兜底：onLoad 未触发（文件缺失等异常场景）时 8s 后报错
  useEffect(() => {
    const t = setTimeout(() => {
      setLoading((was) => {
        if (was) {
          setFailed(true);
          return false;
        }
        return was;
      });
    }, 8000);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="pdt">
      <div className="pdt-bar">
        <span className="pdt-title">PDF 工具箱</span>
        <span className="pdt-sub">离线运行 · 40 项功能 · 文件不出本机</span>
        <span className="pdt-spacer" />
        <span className="pdt-hint">面板内快捷键独立生效，保存时可选另存为位置</span>
      </div>
      <div className="pdt-frame">
        {loading && <div className="pdt-mask">正在加载 PDF 工具箱…</div>}
        {failed && (
          <div className="pdt-mask err">
            <b>加载失败</b>
            <span className="muted">请检查安装目录下 pdf-toolbox.html 是否完整，或重启软件重试。</span>
          </div>
        )}
        <iframe
          ref={frameRef}
          src={SRC}
          title="离线 PDF 工具箱"
          onLoad={() => {
            setLoading(false);
          }}
          onError={() => {
            setLoading(false);
            setFailed(true);
          }}
        />
      </div>
    </div>
  );
}
