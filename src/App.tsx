import { useEffect, useMemo, useState } from 'react';
import { APP_VERSION } from './lib/appVersion';
import BatchPrint from './tools/BatchPrint';
import CardLayout from './tools/CardLayout';
import IdPhoto from './tools/IdPhoto';
import OfficeToPdf from './tools/OfficeToPdf';
import ImageLayout from './tools/ImageLayout';
import BatchCard from './tools/BatchCard';
import PdfPrep from './tools/PdfPrep';
import PdfTools from './tools/pdf/PdfTools';
import Settings from './tools/Settings';
import { useSettings } from './lib/appSettings';
import {
  HOTKEY_ACTIONS,
  isTypingTarget,
  loadBindings,
  matchCombo,
  stepZoom,
  type HotkeyAction,
} from './lib/hotkeys';
import { computeUiZoom } from './lib/uiScale';
import { evaluateHealth, STATUS_COLOR, STATUS_LABEL, type HealthReport } from './lib/healthCheck';
import { probeHealth } from './lib/healthIpc';

type Cat = 'id' | 'card' | 'print';

interface Tool {
  id: string;
  name: string;
  desc: string;
  ready: boolean;
  cat: Cat;
  icon: string;
  tags: string[];
  py: string; // 拼音首字母，供搜索
}

const TOOLS: Tool[] = [
  { id: 'batch-print', name: '批量打印', desc: '按页数自动拆分黑白/点彩/彩色，按价格表报价', ready: true, cat: 'print', icon: '🖨', tags: ['自动识别', '报价'], py: 'pldy' },
  { id: 'id-card', name: '证卡拼版助手', desc: '自动边缘检测+手动角点校正，正反面配对排版，支持色彩与水印', ready: true, cat: 'card', icon: '🪪', tags: ['边缘检测', 'A4排版'], py: 'zkpzzs' },
  { id: 'id-photo', name: '证件照批量处理', desc: '一键替换红、蓝、白背景，适配报名、考试与签证场景', ready: true, cat: 'id', icon: '📷', tags: ['批量换底', '排版打印'], py: 'zjzplcl' },
  { id: 'ai-id-photo', name: 'AI 证件照', desc: '拍摄随意的生活照，AI 换正装、去眼镜反光、换正装', ready: false, cat: 'id', icon: '✨', tags: ['换正装', '美颜'], py: 'aizjz' },
  { id: 'photo-restore', name: 'AI 照片修复', desc: '老照片一键导入（手机翻拍的也行），AI 去折痕、划痕、磨损和褪色', ready: false, cat: 'id', icon: '🛠', tags: ['修复翻新', '黑白上色'], py: 'aizpxf' },
  { id: 'group-shoot', name: '团拍助手', desc: '相机联机拍摄，自动按名单对名归档', ready: false, cat: 'id', icon: '👥', tags: ['联机拍摄'], py: 'tpzs' },
  { id: 'image-layout', name: '图片拼版', desc: '多图网格拼版 / 拼接长图，打印不浪费纸', ready: true, cat: 'card', icon: '🧩', tags: ['网格拼版'], py: 'tppz' },
  { id: 'batch-card', name: '批量制卡', desc: 'Excel 名单套打席卡、工作证、参会证', ready: true, cat: 'card', icon: '🗂', tags: ['名单套打'], py: 'plzk' },
  { id: 'office-to-pdf', name: 'Office 转 PDF', desc: 'Word / Excel / PPT 转 PDF（桌面版，需 LibreOffice）', ready: true, cat: 'print', icon: '📄', tags: ['格式转换'], py: 'officepdf' },
  { id: 'pdf-toolbox', name: 'PDF 工具箱', desc: '离线 PDF 全能处理：合并、拆分、转图片、加密、水印、压缩等 40 项功能', ready: true, cat: 'print', icon: '📔', tags: ['离线', '40 项'], py: 'pdfgjx' },
  { id: 'pdf-prep', name: 'PDF 预处理', desc: '合并、拆分、旋转、统一页面大小，结果直接进批量打印', ready: true, cat: 'print', icon: '🛠', tags: ['打印前处理'], py: 'pdfycl' },
  { id: 'file-transfer', name: '文件互传', desc: '手机扫码传文件到电脑（局域网直传）', ready: false, cat: 'print', icon: '📲', tags: ['扫码传输'], py: 'wjhc' },
];

const CATS: { id: Cat | 'all'; name: string }[] = [
  { id: 'all', name: '全部' },
  { id: 'id', name: '证件照' },
  { id: 'card', name: '证卡与拼版' },
  { id: 'print', name: '打印与文档' },
];

type Route = { page: 'home' } | { page: 'tool'; id: string } | { page: 'settings'; tab?: string };

const WEEK_CN = ['日', '一', '二', '三', '四', '五', '六'];

function greeting(now: Date): string {
  const h = now.getHours();
  if (h < 6) return '夜深了';
  if (h < 12) return '上午好';
  if (h < 14) return '中午好';
  if (h < 18) return '下午好';
  return '晚上好';
}

// 日期与星期一律按系统时间动态计算，严禁硬编码
function todayText(now: Date): string {
  return `${now.getMonth() + 1}月${now.getDate()}日 星期${WEEK_CN[now.getDay()]}`;
}

export default function App() {
  const [route, setRoute] = useState<Route>({ page: 'home' });
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<Cat | 'all'>('all');
  const [s, update] = useSettings();
  // 当前时间：每 30 秒刷新一次，保证长时间开机（跨小时/跨天）问候语与日期星期保持正确
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 30000);
    return () => window.clearInterval(t);
  }, []);

  // 启动体检：仅在桌面版（有桥）跑一次，结论非「健康」时弹出可关闭的横幅。
  const [healthReport, setHealthReport] = useState<HealthReport | null>(null);
  const [healthDismissed, setHealthDismissed] = useState(false);
  useEffect(() => {
    let alive = true;
    void probeHealth().then((p) => {
      if (alive && p) setHealthReport(evaluateHealth(p));
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const apply = () => {
      const dark =
        s.theme === 'dark' ||
        (s.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    };
    apply();
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [s.theme]);

  // 界面缩放 = 用户手动缩放（设置/Ctrl+加减号） × 跟随窗口的自动适配系数。
  // 根 zoom 不改变 window.innerWidth，所以按窗口尺寸反算不会形成回环；
  // 同时把系数写进 --ui-zoom，供 CSS 里 `100vh` 换算用（见 index.css 顶部注释）。
  useEffect(() => {
    const el = document.documentElement;
    let raf = 0;
    const apply = () => {
      const z = computeUiZoom(
        s.zoom,
        { width: window.innerWidth, height: window.innerHeight },
        s.autoFitZoom,
      );
      if (el.dataset.uiZoom !== String(z)) {
        el.dataset.uiZoom = String(z);
        el.style.setProperty('--ui-zoom', String(z));
        el.style.zoom = String(z);
      }
    };
    apply();
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(apply);
    };
    window.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('resize', schedule);
    return () => {
      window.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('resize', schedule);
      cancelAnimationFrame(raf);
    };
  }, [s.zoom, s.autoFitZoom]);

  // 全局快捷键派发：按绑定表匹配；app 级动作直接执行，工具级动作派发事件
  const runAppAction = (action: HotkeyAction) => {
    if (action === 'search') {
      setRoute({ page: 'home' });
      setTimeout(() => document.getElementById('app-search')?.focus(), 0);
    } else if (action === 'zoomIn') {
      update({ zoom: stepZoom(s.zoom, 1) });
    } else if (action === 'zoomOut') {
      update({ zoom: stepZoom(s.zoom, -1) });
    } else if (action === 'zoomReset') {
      update({ zoom: 100 });
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return; // 打字时不触发
      const bindings = loadBindings(); // 每次读最新（设置页可能刚改）
      for (const a of HOTKEY_ACTIONS) {
        const combo = bindings[a.id];
        if (combo && matchCombo(e, combo)) {
          e.preventDefault();
          if (a.scope === 'app') runAppAction(a.id);
          else window.dispatchEvent(new CustomEvent('chaoyu-hotkey', { detail: { action: a.id } }));
          return;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [s.zoom, update]);

  // 搜索：名称 / 描述 / 拼音首字母
  const filtered = useMemo(() => {
    const k = q.trim().toLowerCase();
    let list = TOOLS;
    if (cat !== 'all') list = list.filter((t) => t.cat === cat);
    if (k)
      list = list.filter(
        (t) => t.name.toLowerCase().includes(k) || t.desc.toLowerCase().includes(k) || t.py.includes(k),
      );
    return list;
  }, [q, cat]);

  const freqTools = TOOLS.filter((t) => t.ready && ['id-card', 'id-photo', 'batch-print'].includes(t.id));

  function openSettings(tab?: string) {
    setRoute({ page: 'settings', tab });
  }

  const wizardRows = [
    {
      icon: '🏪',
      title: '店铺信息',
      desc: '店名、电话印在打印报价单上，二维码印在证件照相纸页面上',
      action: '填写',
      skip: '跳过',
      go: () => openSettings('shop'),
    },
    {
      icon: '¥',
      title: '打印价格',
      desc: '批量打印按它报价',
      action: '设置',
      skip: '默认A4执行',
      go: () => openSettings('price'),
    },
    {
      icon: '🖨',
      title: '打印机',
      desc: '选一个常用的打印预设，或者直接用系统默认',
      action: '去设置',
      skip: '用系统默认',
      go: () => openSettings('print-preset'),
    },
    {
      icon: '💬',
      title: '微信登录',
      desc: '登录每台电脑同步同一份店铺信息和价格；开通会员、邀请朋友也要先登录',
      action: '登录',
      skip: '以后再说',
      go: () => openSettings('account'),
    },
  ];

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          🖨 超誉工作台
          <span className="brand-ver">v{APP_VERSION}</span>
        </div>

        <button className={'side-home' + (route.page === 'home' ? ' on' : '')} onClick={() => setRoute({ page: 'home' })}>
          首页
        </button>
        <div className="side-search">
          <input
            id="app-search"
            placeholder="搜索工具"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setRoute({ page: 'home' });
            }}
          />
          <kbd>Ctrl K</kbd>
        </div>

        <div className="side-group">常用</div>
        <div className="side-tools">
          {freqTools.map((t) => (
            <button
              key={t.id}
              className={'side-tool' + (route.page === 'tool' && route.id === t.id ? ' on' : '')}
              onClick={() => setRoute({ page: 'tool', id: t.id })}
            >
              <span className="side-tool-ic">{t.icon}</span>
              <span className="side-tool-name">{t.name}</span>
            </button>
          ))}
        </div>

        <div className="side-group">文档</div>
        <div className="side-tools">
          <button
            className={'side-tool' + (route.page === 'tool' && route.id === 'pdf-toolbox' ? ' on' : '')}
            onClick={() => setRoute({ page: 'tool', id: 'pdf-toolbox' })}
          >
            <span className="side-tool-ic">📔</span>
            <span className="side-tool-name">PDF 工具箱</span>
          </button>
          {/* 后续新增的文档类功能继续在本分组下追加；侧栏为可滚动弹性列布局，不会与下方「系统」区重叠 */}
        </div>

        <div className="side-group">系统</div>
        <button className={'side-tool' + (route.page === 'settings' ? ' on' : '')} onClick={() => openSettings()}>
          <span className="side-tool-ic">⚙</span>
          <span className="side-tool-name">设置</span>
        </button>

        <div className="sidebar-foot">
          <button className="side-login" onClick={() => openSettings('account')}>
            👤 登录 / 注册
          </button>
        </div>
      </aside>

      <main className="main">
        {healthReport && healthReport.overall !== 'ok' && !healthDismissed && (
          <div
            className="health-banner"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '10px 14px',
              margin: '0 0 12px',
              borderRadius: 8,
              border: `1px solid ${STATUS_COLOR[healthReport.overall] === 'green' ? '#16a34a' : STATUS_COLOR[healthReport.overall] === 'yellow' ? '#d97706' : '#dc2626'}`,
              background: STATUS_COLOR[healthReport.overall] === 'yellow' ? '#fffbeb' : '#fef2f2',
            }}
          >
            <span style={{ fontWeight: 600, color: STATUS_COLOR[healthReport.overall] === 'green' ? '#16a34a' : STATUS_COLOR[healthReport.overall] === 'yellow' ? '#d97706' : '#dc2626' }}>
              {STATUS_LABEL[healthReport.overall]}：运行环境体检提示
            </span>
            <span style={{ flex: 1, fontSize: 13, color: '#444' }}>
              {healthReport.items.filter((i) => i.severity !== 'ok').map((i) => i.label).join('、')} 异常，建议前往「设置 → 维护」查看并清理。
            </span>
            <button className="btn" onClick={() => setRoute({ page: 'settings', tab: 'maintenance' })}>
              去处理
            </button>
            <button className="link" onClick={() => setHealthDismissed(true)}>
              忽略
            </button>
          </div>
        )}
        {route.page === 'home' && (
          <div className="home">
            {/* 开始前设置一下 */}
            {!s.wizardDone && (
              <div className="wizard">
                <div className="wizard-head">
                  <h2>开始前设置一下</h2>
                  <div className="wizard-uses">
                    {['打印店 / 照相馆', '摄影师 / 工作室', '公司 / 个人自用'].map((u) => (
                      <span key={u} className="wizard-use">
                        {u}
                      </span>
                    ))}
                  </div>
                  <button className="wizard-x" onClick={() => update({ wizardDone: true })} title="不再显示">
                    ✕
                  </button>
                </div>
                {wizardRows.map((w) => (
                  <div key={w.title} className="wizard-row">
                    <span className="wizard-ic">{w.icon}</span>
                    <div className="wizard-tx">
                      <b>{w.title}</b>
                      <span className="muted">{w.desc}</span>
                    </div>
                    <div className="wizard-act">
                      <button className="btn" onClick={() => update({ wizardDone: true })}>
                        {w.skip}
                      </button>
                      <button className="btn primary" onClick={w.go}>
                        {w.action}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <h1 className="home-greet">
              {greeting(now)} <small className="muted">{todayText(now)}</small>
            </h1>

            <div className="home-search">
              <span className="home-search-ic">🔍</span>
              <input
                placeholder="搜索工具：名称、用途或拼音首字母，如「拼版」 [pb]"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
              <kbd>Ctrl K</kbd>
            </div>

            <div className="home-freq">
              <div className="home-freq-h">
                <b>常用</b>
                <span className="muted">把常用的工具固定在这里，随手就能打开</span>
              </div>
              <div className="home-freq-row">
                {freqTools.map((t) => (
                  <button key={t.id} className="freq-chip" onClick={() => setRoute({ page: 'tool', id: t.id })}>
                    <span className="freq-ic">{t.icon}</span>
                    {t.name}
                  </button>
                ))}
              </div>
            </div>

            <div className="home-cats">
              {CATS.map((c) => (
                <button key={c.id} className={'cat-chip' + (cat === c.id ? ' on' : '')} onClick={() => setCat(c.id)}>
                  {c.name}
                  {c.id === 'all' ? ` ${TOOLS.length}` : ` ${TOOLS.filter((t) => t.cat === c.id).length}`}
                </button>
              ))}
            </div>

            <h2 className="home-cat-title">
              {CATS.find((c) => c.id === cat)?.name ?? '全部'} <small className="muted">{filtered.length}</small>
            </h2>
            <div className="home-cards">
              {filtered.map((t) => (
                <button
                  key={t.id}
                  className={'toolcard' + (t.ready ? '' : ' disabled')}
                  onClick={() => t.ready && setRoute({ page: 'tool', id: t.id })}
                >
                  <span className="toolcard-ic">{t.icon}</span>
                  <span className="toolcard-body">
                    <span className="toolcard-name">
                      {t.name}
                      {!t.ready && <em className="badge">待开发</em>}
                    </span>
                    <span className="toolcard-tags">
                      {t.tags.map((tg) => (
                        <i key={tg}>{tg}</i>
                      ))}
                    </span>
                    <span className="toolcard-desc">{t.desc}</span>
                  </span>
                </button>
              ))}
              {filtered.length === 0 && <p className="muted">没有匹配的工具</p>}
            </div>
            <p className="muted home-foot">
              Web 原型 · 批量打印/证卡拼版/证件照/图片拼版/批量制卡/Office转PDF 可用 · 设置中心与首页已对齐原版界面
            </p>
          </div>
        )}
        {route.page === 'tool' && route.id === 'batch-print' && (
          <BatchPrint onOpenPrice={() => setRoute({ page: 'settings', tab: 'price' })} />
        )}
        {route.page === 'tool' && route.id === 'id-card' && <CardLayout />}
        {route.page === 'tool' && route.id === 'id-photo' && <IdPhoto />}
        {route.page === 'tool' && route.id === 'office-to-pdf' && <OfficeToPdf />}
        {route.page === 'tool' && route.id === 'image-layout' && <ImageLayout />}
        {route.page === 'tool' && route.id === 'batch-card' && <BatchCard />}
        {route.page === 'tool' && route.id === 'pdf-toolbox' && <PdfTools />}
        {route.page === 'tool' && route.id === 'pdf-prep' && <PdfPrep />}
        {route.page === 'settings' && <Settings initialTab={route.tab as never} />}
      </main>
    </div>
  );
}
