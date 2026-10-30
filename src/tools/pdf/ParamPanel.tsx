// 通用参数渲染引擎：按 defs.ts 的 schema 渲染控件。
// 复用工作台既有类名（.param-row / .btn 等），视觉与其它工具一致。
import type { ParamDef, ParamValue } from './defs';

interface RowProps {
  def: ParamDef;
  value: ParamValue;
  onChange: (key: string, v: ParamValue) => void;
}

function Control({ def, value, onChange }: RowProps) {
  switch (def.kind) {
    case 'select':
      return (
        <select className="pdfx-select" value={String(value)} onChange={(e) => onChange(def.key, e.target.value)}>
          {def.options.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
      );
    case 'check':
      return (
        <label className="pdfx-chk">
          <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(def.key, e.target.checked)} />
          {def.label}
        </label>
      );
    case 'number':
      return (
        <span className="pdfx-num">
          <input
            type="number"
            className="pdfx-input narrow"
            value={Number(value)}
            min={def.min}
            max={def.max}
            step={def.step}
            onChange={(e) => onChange(def.key, Number(e.target.value))}
          />
          {def.unit && <span className="muted">{def.unit}</span>}
        </span>
      );
    case 'color':
      return (
        <span className="pdfx-color">
          <input type="color" value={String(value)} onChange={(e) => onChange(def.key, e.target.value)} />
          <input
            type="text"
            className="pdfx-input"
            value={String(value)}
            onChange={(e) => onChange(def.key, e.target.value)}
          />
        </span>
      );
    case 'password':
      return (
        <input
          type="password"
          className="pdfx-input"
          style={{ width: 200 }}
          value={String(value)}
          placeholder={def.placeholder}
          onChange={(e) => onChange(def.key, e.target.value)}
        />
      );
    case 'range':
      return (
        <input
          type="text"
          className="pdfx-input"
          style={{ width: 220 }}
          value={String(value)}
          placeholder={def.placeholder}
          onChange={(e) => onChange(def.key, e.target.value)}
        />
      );
    case 'text':
    default:
      return (
        <input
          type="text"
          className="pdfx-input"
          style={{ width: 200 }}
          value={String(value)}
          placeholder={def.placeholder}
          onChange={(e) => onChange(def.key, e.target.value)}
        />
      );
  }
}

export function ParamRows({
  params,
  values,
  onChange,
}: {
  params?: ParamDef[];
  values: Record<string, ParamValue>;
  onChange: (key: string, v: ParamValue) => void;
}) {
  if (!params || params.length === 0) return <div className="muted pdfx-noparams">该工具没有可调参数</div>;
  return (
    <>
      {params.map((p) => (
        <div className="param-row" key={p.key}>
          <label>{p.label}</label>
          <Control def={p} value={values[p.key] ?? p.def} onChange={onChange} />
        </div>
      ))}
    </>
  );
}
