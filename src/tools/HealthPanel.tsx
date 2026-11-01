import { useEffect, useMemo, useState } from 'react';
import {
  evaluateHealth,
  formatBytes,
  STATUS_COLOR,
  STATUS_LABEL,
  type HealthProbe,
  type HealthReport,
  type Severity,
} from '../lib/healthCheck';
import { cleanupHealth, getAppTempRoot, probeHealth, setAppTempRoot } from '../lib/healthIpc';

const DOT: React.CSSProperties = {
  display: 'inline-block',
  width: 10,
  height: 10,
  borderRadius: '50%',
  marginRight: 8,
  verticalAlign: 'middle',
};
const COLOR_HEX: Record<string, string> = { green: '#16a34a', yellow: '#d97706', red: '#dc2626' };

function SeverityTag({ severity }: { severity: Severity }) {
  return (
    <span style={{ fontWeight: 600, color: COLOR_HEX[STATUS_COLOR[severity]] }}>
      <span style={{ ...DOT, background: COLOR_HEX[STATUS_COLOR[severity]] }} />
      {STATUS_LABEL[severity]}
    </span>
  );
}

/**
 * 启动体检面板：复用 ci_gate 的红/黄/绿裁决，把运行环境健康度（临时文件、缓存、磁盘、
 * 模型完整性）可视化，并提供「一键清理临时文件」与「临时目录迁移到 D 盘」两个内置能力。
 *
 * 顶部入口（App 启动横幅）只展示总体结论 + 进入按钮；完整面板在「设置 → 维护」。
 */
export default function HealthPanel({ embedded = false }: { embedded?: boolean }) {
  const [probe, setProbe] = useState<HealthProbe | null>(null);
  const [report, setReport] = useState<HealthReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [cleanMsg, setCleanMsg] = useState('');
  const [tempRoot, setTempRoot] = useState('');
  const [tempInput, setTempInput] = useState('');
  const [tempMsg, setTempMsg] = useState('');

  const refresh = async () => {
    setBusy(true);
    const p = await probeHealth();
    setProbe(p);
    setReport(p ? evaluateHealth(p) : null);
    setBusy(false);
  };

  useEffect(() => {
    void refresh();
    void getAppTempRoot().then((r) => {
      setTempRoot(r);
      setTempInput(r);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doClean = async () => {
    setBusy(true);
    setCleanMsg('清理中…');
    const r = await cleanupHealth();
    setCleanMsg(`已释放 ${formatBytes(r.freedBytes)}（${r.removed.length} 项）`);
    await refresh();
    setBusy(false);
  };

  const doMigrate = async () => {
    setTempMsg('');
    const r = await setAppTempRoot(tempInput);
    if (r.ok) {
      setTempRoot(r.root);
      setTempMsg(`已设置，重启后生效：临时目录将落在 ${r.effective}`);
    } else {
      setTempMsg(`设置失败：${r.error ?? '未知错误'}`);
    }
  };

  const missingModels = useMemo(
    () => (probe ? probe.models.filter((m) => !m.exists || m.bytes < 1_000_000) : []),
    [probe],
  );

  if (!probe || !report) {
    return (
      <div className="icw-sec">
        <h4>启动体检</h4>
        {busy ? <p className="hint">检测中…</p> : <p className="hint">当前环境不支持体检（仅桌面版可用）。</p>}
      </div>
    );
  }

  return (
    <div className="icw-sec">
      <h4>
        启动体检
        <span style={{ marginLeft: 10 }}>
          <SeverityTag severity={report.overall} />
        </span>
      </h4>

      <p className="hint" style={{ marginTop: 0 }}>
        临时根：<code>{probe.tempRoot}</code>
        {tempRoot && tempRoot !== '' ? '（已迁移到自定义目录）' : '（系统临时目录）'}
      </p>

      {report.items.map((it) => (
        <div
          key={it.name}
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '8px 0',
            borderBottom: '1px solid rgba(128,128,128,0.18)',
          }}
        >
          <div>
            <div style={{ fontWeight: 600 }}>{it.label}</div>
            <div className="hint" style={{ marginTop: 2 }}>{it.detail}</div>
          </div>
          <SeverityTag severity={it.severity} />
        </div>
      ))}

      {missingModels.length > 0 && (
        <div className="icw-sec" style={{ marginTop: 10 }}>
          <h4>缺失 / 异常的模型</h4>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {missingModels.map((m) => (
              <li key={m.id}>
                {m.label}
                {m.critical ? '（关键）' : ''} —— {m.exists ? `体积异常 ${formatBytes(m.bytes)}` : '未找到'}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div style={{ marginTop: 14, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <button className="btn primary" disabled={busy} onClick={doClean}>
          一键清理临时文件
        </button>
        {cleanMsg && <span className="hint" style={{ alignSelf: 'center' }}>{cleanMsg}</span>}
      </div>

      <div className="icw-sec" style={{ marginTop: 16 }}>
        <h4>临时目录迁移到 D 盘</h4>
        <p className="hint" style={{ marginTop: 0 }}>
          把应用临时写盘（Office 输出、自检、缓存）指向 D 盘目录，重启后生效。避免 C 盘被撑爆需手动清理。
        </p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            className="wm-text"
            style={{ flex: 1, minWidth: 200 }}
            placeholder="例如 D:\\chaoyu-tmp"
            value={tempInput}
            onChange={(e) => setTempInput(e.target.value)}
          />
          <button className="btn" disabled={busy} onClick={doMigrate}>
            应用
          </button>
          <button
            className="btn"
            disabled={busy}
            onClick={async () => {
              setTempInput('');
              const r = await setAppTempRoot('');
              setTempRoot('');
              setTempMsg(r.ok ? '已恢复使用系统临时目录' : '恢复失败');
            }}
          >
            恢复默认
          </button>
        </div>
        {tempMsg && <p className="hint" style={{ marginTop: 6 }}>{tempMsg}</p>}
      </div>

      {!embedded && (
        <p className="hint" style={{ marginTop: 12 }}>
          体检逻辑复用像素门禁（ci_gate）的「阈值 → 三档裁决 → 总体结论」思路：每项按阈值判 健康/注意/严重，
          总体取最严重一档。
        </p>
      )}
    </div>
  );
}
