import { useEffect, useState } from 'react';
import { APP_VERSION } from '../lib/appVersion';
import { jsPDF } from 'jspdf';
import { useSettings, type PriceRow, type PrinterPreset, type AppSettings } from '../lib/appSettings';
import { canListPrinters, listSystemPrinters, type SysPrinter } from '../lib/printers';
import { pickSaveDir, canSaveToDisk } from '../lib/exporter';
import {
  DEFAULT_BINDINGS,
  HOTKEY_ACTIONS,
  comboLabel,
  findConflict,
  normalizeCombo,
  resolveBindings,
  useHotkeys,
  useToolCaps,
  type HotkeyAction,
} from '../lib/hotkeys';

type Tab =
  | 'account'
  | 'shop'
  | 'price'
  | 'general'
  | 'print-preset'
  | 'shortcut'
  | 'lab'
  | 'about';

const NAV: { group: string; items: { id: Tab; name: string; icon: string }[] }[] = [
  { group: '账号', items: [{ id: 'account', name: '账号', icon: '👤' }] },
  {
    group: '店铺',
    items: [
      { id: 'shop', name: '店铺信息', icon: '🏪' },
      { id: 'price', name: '打印价格', icon: '¥' },
    ],
  },
  {
    group: '偏好',
    items: [
      { id: 'general', name: '通用', icon: '⚙' },
      { id: 'print-preset', name: '打印预设', icon: '🖨' },
      { id: 'shortcut', name: '快捷键', icon: '⌨' },
    ],
  },
  { group: '', items: [{ id: 'lab', name: '实验功能', icon: '🧪' }, { id: 'about', name: '关于', icon: 'ⓘ' }] },
];

export default function Settings({ initialTab }: { initialTab?: Tab }) {
  const [tab, setTab] = useState<Tab>(initialTab ?? 'general');
  const [s, update] = useSettings();

  return (
    <div className="st">
      <aside className="st-nav">
        {NAV.map((g, gi) => (
          <div key={gi}>
            {g.group && <div className="st-nav-g">{g.group}</div>}
            {g.items.map((it) => (
              <button
                key={it.id}
                className={'st-nav-i' + (tab === it.id ? ' on' : '')}
                onClick={() => setTab(it.id)}
              >
                <span className="st-nav-ic">{it.icon}</span>
                {it.name}
              </button>
            ))}
            {gi < NAV.length - 1 && <div className="st-nav-sep" />}
          </div>
        ))}
      </aside>
      <section className="st-body">
        {tab === 'account' && <AccountPage />}
        {tab === 'shop' && <ShopPage s={s} update={update} />}
        {tab === 'price' && <PricePage s={s} update={update} />}
        {tab === 'general' && <GeneralPage s={s} update={update} />}
        {tab === 'print-preset' && <PrintPresetPage s={s} update={update} />}
        {tab === 'shortcut' && <ShortcutPage />}
        {tab === 'lab' && <LabPage s={s} update={update} />}
        {tab === 'about' && <AboutPage />}
      </section>
    </div>
  );
}

/* ===== 账号 ===== */
function AccountPage() {
  return (
    <div className="st-page">
      <h1>账号</h1>
      <p className="muted">克隆版暂未接入账号体系（原版需微信扫码登录，用于同步店铺信息与积分）。</p>
      <div className="st-card">
        <p className="muted">所有设置当前只存在这台电脑的浏览器本地。桌面版可接入 electron-store 与微信登录。</p>
      </div>
    </div>
  );
}

/* ===== 店铺信息 ===== */
function ShopPage({ s, update }: { s: AppSettings; update: (p: Partial<AppSettings>) => void }) {
  return (
    <div className="st-page">
      <h1>店铺信息</h1>
      <p className="muted">用于打印测试页、宣传二维码等场景的落款。</p>
      <div className="st-card st-form">
        <label>
          <span>店名</span>
          <input value={s.shopName} onChange={(e) => update({ shopName: e.target.value })} placeholder="如：向阳图文快印" />
        </label>
        <label>
          <span>电话</span>
          <input value={s.shopPhone} onChange={(e) => update({ shopPhone: e.target.value })} placeholder="如：13800000000" />
        </label>
        <label>
          <span>地址</span>
          <input value={s.shopAddress} onChange={(e) => update({ shopAddress: e.target.value })} placeholder="店铺地址" />
        </label>
      </div>
    </div>
  );
}

/* ===== 打印价格 ===== */
function PricePage({ s, update }: { s: AppSettings; update: (p: Partial<AppSettings>) => void }) {
  const [ladderPaper, setLadderPaper] = useState<string | null>(null);

  function editRow(paper: string, patch: Partial<PriceRow>) {
    update({ prices: s.prices.map((r) => (r.paper === paper ? { ...r, ...patch } : r)) });
  }

  return (
    <div className="st-page st-wide">
      <h1>打印价格</h1>
      <p className="muted">批量打印按它报价，单位是元 / 面；在批量打印的「预计」里也能改，是同一份。</p>
      <div className="st-card">
        <div className="st-dot-th">
          <b>点彩</b>：彩色占比低于
          <input
            type="number"
            min={0}
            max={100}
            value={s.dotThreshold}
            onChange={(e) => update({ dotThreshold: Math.min(100, Math.max(0, Number(e.target.value) || 0)) })}
          />
          % 的页
        </div>
        <p className="muted">
          红章、彩色标题、小 logo 这类只有一点色彩的页按点彩收；彩色更多的按彩色，几乎看不出颜色的（不到 0.05%）按黑白。
        </p>

        <div className="st-markup">
          全局加价
          <input
            type="number"
            min={0}
            value={s.markupPercent}
            onChange={(e) => update({ markupPercent: Math.max(0, Number(e.target.value) || 0) })}
          />
          %（在所有单价上统一上调，店铺临时调价用）
        </div>

        <table className="st-price">
          <thead>
            <tr>
              <th rowSpan={2}>纸张</th>
              <th colSpan={2}>黑白</th>
              <th colSpan={2}>点彩</th>
              <th colSpan={2}>彩色</th>
              <th rowSpan={2}></th>
            </tr>
            <tr>
              <th>单面</th>
              <th>双面</th>
              <th>单面</th>
              <th>双面</th>
              <th>单面</th>
              <th>双面</th>
            </tr>
          </thead>
          <tbody>
            {s.prices.map((r) => (
              <tr key={r.paper}>
                <td className="st-paper">
                  <b>{r.paper}</b>
                  <button className="link" onClick={() => setLadderPaper(ladderPaper === r.paper ? null : r.paper)}>
                    {r.ladder ? '阶梯价 ✓' : '+ 阶梯价'}
                  </button>
                </td>
                <PCell v={r.bw1} on={(v) => editRow(r.paper, { bw1: v })} />
                <PCell v={r.bw2} on={(v) => editRow(r.paper, { bw2: v })} />
                <PCell v={r.dot1} on={(v) => editRow(r.paper, { dot1: v })} />
                <PCell v={r.dot2} on={(v) => editRow(r.paper, { dot2: v })} />
                <PCell v={r.color1} on={(v) => editRow(r.paper, { color1: v })} />
                <PCell v={r.color2} on={(v) => editRow(r.paper, { color2: v })} />
                <td>
                  <button
                    className="link danger"
                    onClick={() => update({ prices: s.prices.filter((x) => x.paper !== r.paper) })}
                    title="删除该纸张"
                  >
                    删
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {ladderPaper &&
          (() => {
            const row = s.prices.find((x) => x.paper === ladderPaper);
            if (!row) return null;
            const tiers = row.ladder ?? [];
            const setTiers = (t: { minFaces: number; unit: number }[]) =>
              editRow(row.paper, { ladder: t.length ? t : null });
            return (
              <div className="st-ladder">
                <b>{row.paper} 阶梯价（多档，越印越便宜）</b>
                <p className="muted">
                  满 N 面后每面单价封顶：同一档对黑白 / 点彩 / 彩色都生效，与各自基础单价取低。按「满面数」升序、封顶价递减最合理。
                </p>
                {tiers.map((t, i) => (
                  <div key={i} className="st-ladder-row">
                    满
                    <input
                      type="number"
                      min={0}
                      value={t.minFaces}
                      onChange={(e) =>
                        setTiers(tiers.map((x, j) => (j === i ? { ...x, minFaces: Number(e.target.value) || 0 } : x)))
                      }
                    />
                    面，每面封顶
                    <input
                      type="number"
                      min={0}
                      step={0.1}
                      value={t.unit}
                      onChange={(e) =>
                        setTiers(tiers.map((x, j) => (j === i ? { ...x, unit: Number(e.target.value) || 0 } : x)))
                      }
                    />
                    元
                    <button
                      className="link danger"
                      onClick={() => setTiers(tiers.filter((_, j) => j !== i))}
                    >
                      删
                    </button>
                  </div>
                ))}
                <div className="st-ladder-actions">
                  <button
                    className="link"
                    onClick={() =>
                      setTiers([
                        ...tiers,
                        { minFaces: (tiers[tiers.length - 1]?.minFaces ?? 0) + 100, unit: row.bw1 * 0.8 },
                      ])
                    }
                  >
                    + 加一档
                  </button>
                  {tiers.length > 0 && (
                    <button className="link danger" onClick={() => setTiers([])}>
                      移除全部阶梯价
                    </button>
                  )}
                </div>
              </div>
            );
          })()}

        <p className="muted st-foot-note">双面按每一面计价。</p>
        <button
          className="btn"
          onClick={() => {
            const name = window.prompt('新纸张名称（如 B5、16K）：');
            if (!name) return;
            if (s.prices.some((r) => r.paper === name)) return;
            update({
              prices: [...s.prices, { paper: name, bw1: 0.5, bw2: 0.4, dot1: 0.7, dot2: 0.6, color1: 1, color2: 0.8, ladder: null }],
            });
          }}
        >
          + 添加纸张
        </button>
      </div>
      <p className="muted st-only-local">只存在这台电脑上。<a>微信登录</a>后，店里每台电脑用同一份。</p>
    </div>
  );
}

function PCell({ v, on }: { v: number; on: (v: number) => void }) {
  return (
    <td>
      <input
        type="number"
        min={0}
        step={0.1}
        value={v}
        onChange={(e) => on(Math.max(0, Number(e.target.value) || 0))}
      />
    </td>
  );
}

/* ===== 通用 ===== */
const ZOOMS = [80, 90, 100, 110, 125, 150];

function GeneralPage({ s, update }: { s: AppSettings; update: (p: Partial<AppSettings>) => void }) {
  // E12：进入设置页时把已保存的开机自启状态同步到系统登录项，保证首次也一致
  useEffect(() => {
    (window as unknown as { electronAPI?: { setAutoStart?: (b: boolean) => void } }).electronAPI?.setAutoStart?.(
      s.autoStart,
    );
    // 仅在挂载时同步一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function pickFolder() {
    // 主进程 pick-save-dir IPC 由方案 C 补齐；之前只有 UI 没有桥接，一直退回 window.prompt
    const dir = await pickSaveDir(s.exportDir || undefined);
    if (dir) update({ exportDir: dir });
    else if (!canSaveToDisk()) {
      const input = window.prompt('输入默认保存目录（桌面版可直接选择文件夹）：', s.exportDir);
      if (input !== null) update({ exportDir: input });
    }
  }

  return (
    <div className="st-page">
      <h1>通用</h1>
      <p className="muted">外观与桌面端行为。</p>

      <div className="st-sec">
        <h2>外观主题</h2>
        <p className="muted">主题色会立即在软件本体生效。</p>
        <div className="st-seg">
          {(
            [
              ['system', '跟随系统'],
              ['light', '浅色'],
              ['dark', '深色'],
            ] as const
          ).map(([v, label]) => (
            <button key={v} className={s.theme === v ? 'on' : ''} onClick={() => update({ theme: v })}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="st-sec">
        <h2>界面缩放</h2>
        <p className="muted">
          整体放大文字、图标和按钮；适合高分屏展示。也可用 Ctrl+加号 缩放，Ctrl+0 恢复 100%。
        </p>
        <select value={s.zoom} onChange={(e) => update({ zoom: Number(e.target.value) })}>
          {ZOOMS.map((z) => (
            <option key={z} value={z}>
              {z}%
            </option>
          ))}
        </select>
        <h3>跟随窗口大小自动缩放</h3>
        <p className="muted">
          开启后，窗口变小时界面整体等比缩小（避免出现横向滚动条、按钮被挤成竖排、右侧面板被裁掉），
          窗口变大时按同比例放大，各工具在三档宽度下的间距与视觉层级保持一致；缩放下限 72%、上限 120%。
        </p>
        <Toggle on={s.autoFitZoom} onchg={(v) => update({ autoFitZoom: v })} />
      </div>

      <div className="st-sec">
        <h2>开机自动启动</h2>
        <p className="muted">登录桌面后自动运行扫瞄工具箱。</p>
        <Toggle
          on={s.autoStart}
          onchg={(v) => {
            update({ autoStart: v });
            // E12：同步到系统登录项，开关才真正生效
            (window as unknown as { electronAPI?: { setAutoStart?: (b: boolean) => void } }).electronAPI?.setAutoStart?.(
              v,
            );
          }}
        />
      </div>

      <div className="st-sec">
        <h2>关闭时最小化到托盘</h2>
        <p className="muted">关闭主窗口时点击后不显示退出，可从托盘图标重新打开或退出。</p>
        <Toggle on={s.closeToTray} onchg={(v) => update({ closeToTray: v })} />
      </div>

      <div className="st-sec">
        <h2>新版本提示</h2>
        <p className="muted">有新版本时在导航页提示，点击后自动下载安装；不会自动下载或重启。</p>
        <span className={'st-flag' + (s.updateNotify ? ' on' : '')}>{s.updateNotify ? '已开启' : '已关闭'}</span>
      </div>

      <div className="st-sec">
        <h2>导出</h2>
        <p className="muted">文件存在与处理设置。</p>
        <h3>默认保存位置</h3>
        <p className="muted">每次导出后自动选择到该位置。</p>
        <div className="st-row">
          <span className="muted">{s.exportDir || '未设置（导出时手动选择）'}</span>
          <button className="btn" onClick={pickFolder}>
            选择文件夹
          </button>
        </div>
        <h3>证件照使用原文件名</h3>
        <p className="muted">
          导出的单张照片可直接与该证件照图片合并；不用照时尺寸、DPI 或单张。修改方为 JPG / PDF；多人合照以第姓名+张数命名。重名或重新导出时自动命名。
        </p>
        <Toggle on={s.idPhotoUseOrigName} onchg={(v) => update({ idPhotoUseOrigName: v })} />
        <h3>导出后打开所在文件夹</h3>
        <p className="muted">导出成功后自动打开保存位置；PDF 在文件夹中显示，照片文件直接打开。</p>
        <Toggle on={s.exportOpenFolder} onchg={(v) => update({ exportOpenFolder: v })} />
      </div>

      <div className="st-sec">
        <h2>批量打印</h2>
        <h3>按文件名自动识别份数、颜色、单双面</h3>
        <p className="muted">
          文件名或所在文件夹名里带了「(5份)」「(彩色)」「黑白」「双面」「单面」等标记，加入时被测设置，添加后若点错，失败点选项结果，可以在列表里改或清空文件名重新导入。
        </p>
        <Toggle on={s.bpAutoDetect} onchg={(v) => update({ bpAutoDetect: v })} />
      </div>

      <div className="st-sec">
        <h2>Word/PPT/Excel 转 PDF</h2>
        <h3>转换完成后打开</h3>
        <Toggle on={s.officeOpenAfter} onchg={(v) => update({ officeOpenAfter: v })} />
        <p className="muted">桌面版依赖本机 LibreOffice；Web 版此设置不生效。</p>
      </div>
    </div>
  );
}

function Toggle({ on, onchg }: { on: boolean; onchg: (v: boolean) => void }) {
  return (
    <label className="st-switch">
      <input type="checkbox" checked={on} onChange={(e) => onchg(e.target.checked)} />
      <i />
    </label>
  );
}

/* ===== 打印预设 ===== */
function PrintPresetPage({ s, update }: { s: AppSettings; update: (p: Partial<AppSettings>) => void }) {
  const [selId, setSelId] = useState(0);
  const sel = s.printPresets.find((p) => p.id === selId) ?? s.printPresets[0];

  // 系统打印机枚举（桌面版经 list-printers IPC；浏览器预览不可用，为空并给出提示）
  const [printers, setPrinters] = useState<SysPrinter[]>([]);
  const [pLoading, setPLoading] = useState(true);

  async function refreshPrinters() {
    setPLoading(true);
    try {
      setPrinters(await listSystemPrinters());
    } finally {
      setPLoading(false);
    }
  }
  useEffect(() => {
    void refreshPrinters();
  }, []);

  function editSel(patch: Partial<PrinterPreset>) {
    update({ printPresets: s.printPresets.map((p) => (p.id === sel.id ? { ...p, ...patch } : p)) });
  }

  function add() {
    const np: PrinterPreset = {
      id: s.printPresets.reduce((m, p) => Math.max(m, p.id), 0) + 1,
      name: '我的预设',
      printer: 'auto',
      paper: 'follow',
      color: 'ask',
      duplex: 'ask',
      driver: 'windows',
    };
    update({ printPresets: [...s.printPresets, np] });
    setSelId(np.id);
  }

  function del(id: number) {
    const next = s.printPresets.filter((p) => p.id !== id);
    update({ printPresets: next });
    setSelId(next[0]?.id ?? 0);
  }

  return (
    <div className="st-page">
      <h1>打印预设</h1>
      <p className="muted">把常用的打印机、纸张、颜色和打印首选项存成预设，各个工具打印时直接选用。</p>
      <div className="st-pp">
        <aside className="st-pp-list">
          {s.printPresets.map((p) => (
            <button
              key={p.id}
              className={'st-pp-i' + (sel?.id === p.id ? ' on' : '')}
              onClick={() => setSelId(p.id)}
            >
              <span className="st-pp-name">
                {p.name}
                {p.builtin && <em>内置</em>}
              </span>
              <span className="muted">
                {p.builtin ? '打印时选打印机，首选项跟随 Windows' : '固定打印机与首选项'}
              </span>
            </button>
          ))}
          <div className="st-pp-add">
            <button className="link" onClick={add}>
              + 新增
            </button>
          </div>
          <div className="st-pp-mine">
            <div className="st-nav-g">我的预设</div>
            <p className="muted">{s.printPresets.filter((p) => !p.builtin).length === 0 ? '还没有自己的预设' : `${s.printPresets.filter((p) => !p.builtin).length} 个`}</p>
          </div>
        </aside>

        {sel && (
          <div className="st-pp-detail">
            <h2>
              {sel.name} <em className="muted">{sel.builtin ? '内置' : ''}</em>
            </h2>
            {sel.builtin ? (
              <p className="muted">不选预设时就按它打印。内置，不能修改或删除。</p>
            ) : (
              <input className="st-name" value={sel.name} onChange={(e) => editSel({ name: e.target.value })} />
            )}
            <dl className="st-dl">
              <dt>打印机</dt>
              <dd>{sel.builtin ? '打印时选，记住上次用的' : sel.printer === 'auto' ? '打印时选' : sel.printer}</dd>
              <dt>纸张</dt>
              <dd>{sel.builtin ? '跟着拼版' : sel.paper === 'follow' ? '跟着拼版' : sel.paper}</dd>
              <dt>颜色、单双面</dt>
              <dd>{sel.builtin ? '打印时选' : sel.color === 'ask' ? '打印时选' : sel.color === 'bw' ? '黑白' : '彩色'} / {sel.duplex === 'ask' ? '打印时选' : sel.duplex === 'duplex' ? '双面' : '单面'}</dd>
              <dt>打印首选项</dt>
              <dd>
                {sel.builtin
                  ? '跟随 Windows：用这台打印机在 Windows 里的设置（介质、质量、色彩）。打印时点「Windows 打印首选项」可以改，但其他软件也会跟着变。'
                  : sel.driver === 'windows'
                    ? '跟随 Windows'
                    : sel.driver}
              </dd>
            </dl>
            {!sel.builtin && (
              <>
                <div className="st-pp-edit">
                  <label>
                    打印机
                    <select
                      value={sel.printer === 'auto' ? '' : sel.printer}
                      onChange={(e) => editSel({ printer: e.target.value || 'auto' })}
                    >
                      <option value="">留空 = 打印时选</option>
                      {printers.map((p) => (
                        <option key={p.name} value={p.name}>
                          {p.displayName}
                          {p.isDefault ? '（默认）' : ''}
                        </option>
                      ))}
                      {sel.printer !== 'auto' && !printers.some((p) => p.name === sel.printer) && (
                        <option value={sel.printer}>{sel.printer}（当前不在线）</option>
                      )}
                    </select>
                  </label>
                  <label>
                    纸张
                    <select value={sel.paper} onChange={(e) => editSel({ paper: e.target.value })}>
                      <option value="follow">跟着拼版</option>
                      {['A4', 'A3', 'A5', '6寸', 'R6', '5寸'].map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    颜色
                    <select
                      value={sel.color}
                      onChange={(e) => editSel({ color: e.target.value as PrinterPreset['color'] })}
                    >
                      <option value="ask">打印时选</option>
                      <option value="bw">黑白</option>
                      <option value="color">彩色</option>
                    </select>
                  </label>
                  <label>
                    单双面
                    <select
                      value={sel.duplex}
                      onChange={(e) => editSel({ duplex: e.target.value as PrinterPreset['duplex'] })}
                    >
                      <option value="ask">打印时选</option>
                      <option value="simplex">单面</option>
                      <option value="duplex">双面</option>
                    </select>
                  </label>
                </div>
                <div className="st-pp-printer-status">
                  {pLoading ? (
                    <span className="muted">正在检测本机打印机…</span>
                  ) : (
                    <span className="muted">
                      {printers.length > 0
                        ? `检测到 ${printers.length} 台打印机${printers.find((p) => p.isDefault) ? ` · 默认：${printers.find((p) => p.isDefault)!.displayName}` : ''}`
                        : canListPrinters()
                          ? '未检测到打印机：请检查打印机电源与连接，或在 Windows 设置里确认驱动正常后点「刷新」'
                          : '浏览器预览无法检测打印机，请在桌面版中设置（安装后本项自动可用）'}
                    </span>
                  )}
                  <button className="link" onClick={() => void refreshPrinters()} disabled={pLoading}>
                    刷新
                  </button>
                </div>
                <div className="st-row">
                  <button className="btn danger" onClick={() => del(sel.id)}>
                    删除此预设
                  </button>
                </div>
              </>
            )}
            <p className="muted st-pp-tip">
              想固定用某台打印机、照片纸张和质量，又不暗改 Windows 的设置：点左边「新增」建一份预设，单独设置它的打印首选项。
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

/* ===== 快捷键（可自定义：录制 / 冲突检测 / 恢复默认） ===== */
function ShortcutPage() {
  const [bindings, setBindings] = useHotkeys();
  const caps = useToolCaps();
  const [recording, setRecording] = useState<HotkeyAction | null>(null);
  const [conflictWith, setConflictWith] = useState<HotkeyAction | null>(null);

  const nameOf = (a: HotkeyAction) => HOTKEY_ACTIONS.find((x) => x.id === a)?.name ?? a;

  // 录制态：capture 阶段抓组合，优先于 App 的派发监听
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setRecording(null);
        setConflictWith(null);
        return;
      }
      const combo = normalizeCombo(e);
      if (!combo) return; // 纯修饰键：保持捕获态
      const clash = findConflict(bindings, recording, combo);
      if (clash) {
        setConflictWith(clash); // 冲突：不落库，行内提示
        return;
      }
      setBindings({ ...bindings, [recording]: combo });
      setRecording(null);
      setConflictWith(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording, bindings, setBindings]);

  return (
    <div className="st-page">
      <h1>快捷键</h1>
      <div className="st-card">
        <p className="muted st-hint">
          点「录制」后直接按新组合即可改键；Esc 取消。带 <span className="st-scope-tag">工具</span> 的动作在对应工具页面内生效。
        </p>
        <table className="st-keys">
          <thead>
            <tr>
              <th>动作</th>
              <th style={{ width: 130 }}>当前键位</th>
              <th style={{ width: 170 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {HOTKEY_ACTIONS.map((a) => {
              const isRec = recording === a.id;
              const isDefault = bindings[a.id] === DEFAULT_BINDINGS[a.id];
              return (
                <tr key={a.id} className={isRec ? 'rec' : ''}>
                  <td>
                    {a.name}
                    {a.scope === 'tool' && <span className="st-scope-tag">工具</span>}
                  </td>
                  <td>
                    {isRec ? (
                      <span className="st-rec-hint">按下新组合…（Esc 取消）</span>
                    ) : (
                      <kbd>{comboLabel(bindings[a.id])}</kbd>
                    )}
                    {isRec && conflictWith && (
                      <span className="st-conflict">与「{nameOf(conflictWith)}」冲突，请换一个</span>
                    )}
                  </td>
                  <td>
                    {isRec ? (
                      <button className="btn" onClick={() => setRecording(null)}>
                        取消
                      </button>
                    ) : (
                      <>
                        <button className="btn" onClick={() => { setRecording(a.id); setConflictWith(null); }}>
                          录制
                        </button>
                        <button
                          className="btn"
                          disabled={isDefault}
                          title="恢复为该动作的默认键位"
                          onClick={() => setBindings({ ...bindings, [a.id]: DEFAULT_BINDINGS[a.id] })}
                        >
                          恢复默认
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="st-keys-foot">
          <button className="btn" onClick={() => setBindings(resolveBindings(null))}>
            全部恢复默认
          </button>
          <span className="muted">修改后立即生效，重启软件后仍保留。</span>
        </div>
      </div>
      <div className="st-card">
        <h3>当前工具支持情况</h3>
        {caps && caps.actions.length > 0 ? (
          <p className="muted st-caps-line">
            最近使用：<b className="st-caps-tool">{caps.toolName}</b>
            {caps.actions.map((a) => (
              <span key={a} className="st-caps-item">
                {nameOf(a)}
                <kbd>{comboLabel(bindings[a])}</kbd>
                <span className="st-caps-ok">✓</span>
              </span>
            ))}
          </p>
        ) : (
          <p className="muted st-caps-line">
            还没有工具登记快捷键能力。打开任一工具（批量打印、证卡拼版、证件照、图片拼版、批量制卡、Office
            转 PDF）后，这里会显示它支持的快捷键和当前键位。
          </p>
        )}
      </div>
    </div>
  );
}

/* ===== 实验功能 ===== */
const TEST_SIZES: [string, number, number][] = [
  ['6 寸', 102, 152],
  ['R6', 127, 89],
  ['5 寸', 89, 127],
  ['A4', 210, 297],
  ['A3', 297, 420],
];

function LabPage({ s, update }: { s: AppSettings; update: (p: Partial<AppSettings>) => void }) {
  const [size, setSize] = useState('6 寸');

  function genTestPage() {
    const [, pw, ph] = TEST_SIZES.find((x) => x[0] === size) ?? TEST_SIZES[0];
    const doc = new jsPDF({ unit: 'mm', format: [pw, ph] });
    const M = 6; // 标注红框距纸边
    // 四周红框：标注靠纸边的毫米数
    doc.setDrawColor(226, 61, 61);
    doc.setLineWidth(0.3);
    doc.rect(M, M, pw - 2 * M, ph - 2 * M);
    doc.setFontSize(7);
    doc.setTextColor(226, 61, 61);
    doc.text(`${M}mm`, pw / 2, M - 1.5, { align: 'center' });
    doc.text(`${M}mm`, pw / 2, ph - M + 3, { align: 'center' });
    doc.saveGraphicsState();
    doc.text(`${M}mm`, M - 1.5, ph / 2, { align: 'center', angle: 90 });
    doc.restoreGraphicsState?.();
    // 中央标准证件卡轮廓 85.6 x 54
    const cw = 85.6;
    const ch = 54;
    const cx = (pw - cw) / 2;
    const cy = (ph - ch) / 2;
    doc.setDrawColor(31, 35, 41);
    doc.setLineWidth(0.25);
    doc.rect(cx, cy, cw, ch);
    doc.setFontSize(8);
    doc.setTextColor(31, 35, 41);
    doc.text('标准证件卡轮廓 85.6 x 54 mm', pw / 2, cy - 2, { align: 'center' });
    doc.setFontSize(6.5);
    doc.setTextColor(120, 126, 134);
    const lines = [
      `打印测试页 · ${size}（${pw} x ${ph} mm）`,
      '放大说明页可被缩小了；四周红框标着靠纸边的毫米数，被切掉几圈就把「安全边距」设成最外侧完整可见的那个数字。',
      s.shopName ? `${s.shopName}${s.shopPhone ? ' · ' + s.shopPhone : ''}` : '超誉工作台',
    ];
    lines.forEach((t, i) => doc.text(t, pw / 2, ph - M + 5.5 + i * 3, { align: 'center' }));
    doc.save('打印测试页.pdf');
  }

  return (
    <div className="st-page">
      <h1>实验功能</h1>
      <p className="muted">按需开启试用功能，开关状态会保存到本机。</p>

      <div className="st-sec">
        <h3>添加宣传二维码与条码单号</h3>
        <p className="muted">
          开启后，证件照批量处理将显示「添加二维码」和「条码单号」，用于添加在排版版上添加宣传二维码和条形码。
        </p>
        <Toggle on={s.labQrBarcode} onchg={(v) => update({ labQrBarcode: v })} />
      </div>

      <div className="st-sec">
        <h3>磨皮方式对比</h3>
        <p className="muted">
          开启后，证件照批量处理的「手动微调」底部显示「磨皮方式」，可在 AI 匀肤 + 平滑 / 仅 AI 匀肤 / 仅平滑之间切换，用于对比匀肤模式的效果。关闭时按默认的 AI 匀肤 + 平滑处理。
        </p>
        <Toggle on={s.labSkinCompare} onchg={(v) => update({ labSkinCompare: v })} />
      </div>

      <div className="st-sec">
        <h3>拍摄质量检查</h3>
        <p className="muted">
          开启后，证件照批量处理会在每张照片上标出美颜修不了拍摄问题（露齿、闭眼、戴帽子、刘海遮眉、仰拍等）；缩略图角上另个标记，是停看全部说明，判定还在打着，误报偏多，关闭时完全检测。
        </p>
        <Toggle on={s.labShootCheck} onchg={(v) => update({ labShootCheck: v })} />
      </div>

      <div className="st-sec">
        <h3>打印测试页</h3>
        <p className="muted">
          一次查打印尺寸为什么不对：中间是标准证件卡轮廓（85.6 x 54 mm），放张身份证上去比对—证件要说明页可被缩小了；四周红框标着靠纸边的毫米数，被切掉几圈就把「安全边距」设成最外侧完整可见的那个数字。
        </p>
        <div className="st-row">
          <select value={size} onChange={(e) => setSize(e.target.value)}>
            {TEST_SIZES.map(([n]) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <button className="btn primary" onClick={genTestPage}>
            生成并保存
          </button>
        </div>
      </div>
    </div>
  );
}

/* ===== 关于 ===== */
function AboutPage() {
  return (
    <div className="st-page">
      <h1>关于</h1>
      <div className="st-card">
        <p>
          <b>超誉工作台</b> · v{APP_VERSION}
        </p>
        <p className="muted">
          对 aiyinbox.com 桌面端的学习性复刻：批量打印报价、证卡拼版、证件照批量处理、图片拼版、批量制卡、Office 转
          PDF 与设置中心。与原版无从属关系。
        </p>
      </div>
      <div className="st-card">
        <h3>开源许可</h3>
        <p className="muted">
          「PDF 工具箱」为本项目自研的离线工具集，全部处理在本机完成、无网络请求，依赖：
        </p>
        <p className="st-caps-line">
          · pdf-lib（MIT）— PDF 结构读写
          <br />· pdf.js（Apache-2.0）— 渲染与大纲解析
          <br />· JSZip（MIT/GPL 双许可，取 MIT）— 多文件打包
        </p>
      </div>
    </div>
  );
}
