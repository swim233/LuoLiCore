import { useEffect, useRef, useState } from 'react';
import { Star4, IconSettings } from '../../components/icons';
import { Seg } from '../../components/Seg';
import { chooseMotion, usePrefs } from '../../lib/prefs';
import type { Prefs } from '../../lib/prefs';
import { resetLayoutToDefault, setCollapse, setFps, setHover } from '../../state/appearance';
import type { ViewProps, WidgetDef } from '../types';

/* 设置：「外观」是浏览器里的偏好，现在就能改（存 localStorage，不经服务）；
   其余各组还是骨架，现在不能修改，只有分组和空的表单位置 */
const SET_GROUPS: [string, [string, boolean?][]][] = [
  ['人设', [['人设文件'], ['人设内容', true]]],
  ['内置提示词', [['消息格式说明', true], ['摘要指令', true], ['工具收尾提示']]],
  ['白名单', [['允许的群'], ['允许私聊的用户']]],
  [
    '行为参数',
    [
      ['唤醒词'],
      ['等待合并（秒）'],
      ['离线积压的时限（分钟）'],
      ['最多步数'],
      ['回复时限（秒）'],
      ['请求记录保留天数'],
    ],
  ],
  ['工具', [['已装的工具'], ['各工具的开关']]],
  ['模型与服务', [['模型'], ['Base URL'], ['重试次数'], ['超时（秒）']]],
  ['密钥', [['API key（只能替换，不显示）'], ['Telegram bot token（只能替换，不显示）']]],
];
const APPEARANCE = '外观';
const NAV_GROUPS = [APPEARANCE, ...SET_GROUPS.map(([g]) => g)];

const ON_OFF: [string, string][] = [
  ['on', '开'],
  ['off', '关'],
];
const HOVER_ITEMS: [Prefs['hover'], string, string][] = [
  ['B', 'B 流光', '边缘流光'],
  ['C', 'C 边光', '边缘发光：鼠标附近的那段边框被照亮'],
  ['D', 'D 倾斜', '卡牌倾斜'],
];
const COLLAPSE_ITEMS: [string, string][] = [
  ['30', '30 秒'],
  ['5', '5 秒'],
];

/* 恢复默认布局：两步点击。第一次点，按钮变成「再点一次恢复」；3 秒内再点才真的恢复，
   超时、点了别处或焦点离开，按钮恢复原样 */
const CONFIRM_MS = 3000;
function ResetLayoutButton() {
  const [armed, setArmed] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), CONFIRM_MS);
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setArmed(false);
    };
    document.addEventListener('pointerdown', away, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('pointerdown', away, true);
    };
  }, [armed]);
  return (
    <button
      ref={ref}
      className={'chip' + (armed ? ' is-armed' : '')}
      type="button"
      onBlur={() => setArmed(false)}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        resetLayoutToDefault();
      }}
    >
      {armed ? '再点一次恢复' : '恢复默认布局'}
    </button>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="set-field" title={hint}>
      <span className="set-label">{label}</span>
      {children}
      {hint && <p className="set-hint">{hint}</p>}
    </div>
  );
}

/* 「外观」的各项：桌面卡片和全屏里是同一份。改了立刻生效（顶栏的动画开关、帧率、悬停、「此刻」的缩回），
   状态在 lib/prefs.ts，开发模式的演示面板也是它，所以两处同步 */
function AppearanceFields() {
  const p = usePrefs((x) => x);
  const hint = HOVER_ITEMS.find(([v]) => v === p.hover)?.[2];
  return (
    <>
      <Field
        label="动画"
        hint="装饰性的动画，顶栏也有这个开关。没有拨过时，跟随系统的「减少动态效果」"
      >
        <Seg
          label="动画"
          value={p.motion ? 'on' : 'off'}
          items={ON_OFF}
          onPick={(v) => chooseMotion(v === 'on')}
        />
      </Field>
      <Field label="帧率显示" hint="在左下角显示当前帧率，以及最近一次转场的最长帧和掉帧数">
        <Seg
          label="帧率显示"
          value={p.fps ? 'on' : 'off'}
          items={ON_OFF}
          onPick={(v) => setFps(v === 'on')}
        />
      </Field>
      <Field label="悬停效果" hint={hint}>
        <Seg
          label="悬停效果"
          value={p.hover}
          items={HOVER_ITEMS}
          onPick={(v) => setHover(v as Prefs['hover'])}
        />
      </Field>
      <Field label="「此刻」自动缩回" hint="回复都结束后，浮起的「此刻」等这么久再自动缩回">
        <Seg
          label="「此刻」自动缩回"
          value={String(p.collapse)}
          items={COLLAPSE_ITEMS}
          onPick={(v) => setCollapse(Number(v) as Prefs['collapse'])}
        />
      </Field>
      <Field label="布局" hint="部件的排列、大小和显示都恢复成默认。点一下后要再点一次才会恢复">
        <ResetLayoutButton />
      </Field>
    </>
  );
}

function SettingsView({ mode }: ViewProps) {
  const [cur, setCur] = useState(0);
  if (mode !== 'full') {
    return (
      <div className="skel">
        <div className="skel-note">
          <Star4 />
          <span>外观可以改，其余还不能在这里修改设置</span>
        </div>
        <section className="skel-live" aria-label={APPEARANCE}>
          <b>{APPEARANCE}</b>
          <AppearanceFields />
        </section>
        {SET_GROUPS.map(([g], i) => (
          <div className="skel-group" key={g}>
            <b>{g}</b>
            <span className="skel-bar" style={{ maxWidth: `${60 + ((i * 37) % 40)}%` }} />
          </div>
        ))}
      </div>
    );
  }
  const name = NAV_GROUPS[cur];
  const fields = cur === 0 ? null : SET_GROUPS[cur - 1][1];
  return (
    <div className="set-full">
      <nav className="set-nav" aria-label="设置分组">
        {NAV_GROUPS.map((g, i) => (
          <button key={g} type="button" aria-current={i === cur} onClick={() => setCur(i)}>
            {g}
          </button>
        ))}
      </nav>
      <div className="set-main">
        <h3>{name}</h3>
        {fields ? (
          <>
            <span className="ribbon">还不能在这里修改设置：这里以后放表单</span>
            {fields.map(([label, tall]) => (
              <div className="set-field" key={label}>
                <label>{label}</label>
                <div className={'set-input' + (tall ? ' is-tall' : '')} aria-hidden="true" />
              </div>
            ))}
          </>
        ) : (
          <>
            <p className="set-note">存在这个浏览器里，改了立刻生效，不经过服务。</p>
            <AppearanceFields />
          </>
        )}
      </div>
    </div>
  );
}
export const SETTINGS_DEF: WidgetDef = {
  id: 'settings',
  name: '设置',
  icon: IconSettings,
  defaultSize: '1x1',
  thumb: () => '外观可以改，其余还不能改',
  View: SettingsView,
};
