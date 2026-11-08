import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useChat } from '@ai-sdk/react';
import { Hl, Spin, Thumb } from '../../components/Hl';
import { StreamText } from '../../components/stream';
import { VirtualLog } from '../../components/VirtualLog';
import type { LogItem } from '../../components/VirtualLog';
import { IconChat } from '../../components/icons';
import { motionOn } from '../../lib/prefs';
import { useStore } from '../../lib/store';
import { fmtDay, fmtShort } from '../../lib/util';
import { bus } from '../../model/bus';
import { db } from '../../model/db';
import { useBusRev } from '../../model/rev';
import { colorOf, LUOLI } from '../../model/who';
import { toast } from '../../state/ui';
import { ConvList } from '../sessions/ConvList';
import { chatCur, chatState, draftOf, newWebConv, switchTo, webConvs } from './chatState';
import type { Att } from './chatState';
import { abortChat, getRec, partsOf, sendChat } from './chatCore';
import type { ChatMsg } from './chatCore';
import type { ViewProps, WidgetDef } from '../types';

/* 网页自己的会话：@ai-sdk/react 的 useChat 接本地模拟的 /api/chat（server/chat-mock.ts）。
   气泡里的思考、工具调用、逐字落下的正文、末尾一颗星星光标都是从 useChat 的消息流画出来的 */
const seenAt = new Map<string, number>();
const atOf = (m: ChatMsg) =>
  m.metadata?.at ?? seenAt.get(m.id) ?? (seenAt.set(m.id, Date.now()), seenAt.get(m.id)!);

/* 正文：正在逐字出的那条用命令式的小岛（每个字各自落下），出完后光标再停一会儿，淡出，换成静态的高亮文字 */
function LiveText({
  convId,
  text,
  streaming,
}: {
  convId: string;
  text: string;
  streaming: boolean;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const st = useRef<StreamText | null>(null);
  const [done, setDone] = useState(false);
  const rec = getRec(convId);
  useLayoutEffect(() => {
    const el = ref.current!;
    st.current = new StreamText(el, text, convId);
    return () => {
      st.current = null;
      el.textContent = '';
    };
  }, []);
  /* 新的字：落下 */
  const len = useRef(Array.from(text).length);
  useEffect(() => {
    const cs = Array.from(text);
    if (st.current && cs.length > len.current) {
      st.current.delta(cs.slice(len.current).join(''), text);
      len.current = cs.length;
    }
  }, [text]);
  /* 流结束：光标停一会儿（中止、出错 .3 秒，正常 2 秒），淡出，换成静态 */
  useEffect(() => {
    if (streaming || !st.current) return;
    const wait = Math.max(0, rec.lingerUntil - Date.now());
    const c = st.current.finish(wait, 520, () => setDone(true));
    return c;
  }, [streaming, rec]);
  /* 两个分支要有不同的 key：React 看两个都是同一位置的 span 会复用同一个节点，StreamText 命令式插进去的逐字节点（.ch）还留在里面，
     换成静态文字时就追加在后面，正文出现两份。有了 key 就整个换掉 */
  if (done)
    return (
      <span key="static">
        <Hl text={text} hits={false} />
      </span>
    );
  return <span key="stream" ref={ref} style={{ whiteSpace: 'pre-wrap' }} />;
}

const ChatItem = memo(function ChatItem({
  convId,
  m,
  live,
  streaming,
  isNew,
}: {
  convId: string;
  m: ChatMsg;
  live: boolean;
  streaming: boolean;
  isNew: boolean;
}) {
  const you = m.role === 'user';
  const meta: Partial<NonNullable<ChatMsg['metadata']>> = m.metadata ?? {};
  const aborted = !!meta.aborted,
    failed = !!meta.failed;
  const parts = partsOf(m);
  const imgs = parts.filter((p) => p.type === 'file');
  const text = parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('');
  const label = live && streaming ? '正在回复' : fmtDay(atOf(m));
  return (
    <div
      className={
        'msg ' + (you ? 'is-you is-me' : 'is-luoli is-me') + (isNew && motionOn() ? ' is-new' : '')
      }
      style={you ? { '--who': colorOf(meta.name || '你') } : undefined}
    >
      <div className="msg-meta">
        <b>{you ? meta.name || '你' : LUOLI}</b>
        <time>{label}</time>
      </div>
      <div className="bubble">
        {parts.map((p, i) => {
          if (p.type === 'reasoning') {
            if (p.state === 'done')
              return (
                <details className="fold" key={i}>
                  <summary>
                    <span>{`思考了 ${p.sec || p.demo?.sec || 2} 秒`}</span>
                  </summary>
                  <div className="fold-body">{p.text}</div>
                </details>
              );
            if (aborted || failed)
              return (
                <div className="fold" key={i}>
                  <span className="fold-tag">{failed ? '思考中断' : '思考被中止'}</span>
                </div>
              );
            return (
              <details className="fold" key={i}>
                <summary>
                  <span>思考中…</span>
                </summary>
              </details>
            );
          }
          if (p.type === 'tool-fetch') {
            if (p.state === 'output-available') {
              return (
                <details className="fold" key={i}>
                  <summary>
                    <span>◇ fetch · 读完了</span>
                    <span className="ok">
                      {'✓ ' + (((p.output?.ms ?? p.demo?.ms) || 800) / 1000).toFixed(1) + 's'}
                    </span>
                  </summary>
                  <div className="fold-body">
                    {p.output?.summary}
                    {p.demo?.image && (
                      <div className="msg-imgs" style={{ marginTop: 6 }}>
                        <Thumb part={p.demo.image} />
                      </div>
                    )}
                  </div>
                </details>
              );
            }
            return (
              <details className="fold" key={i}>
                <summary>
                  <span>{`◇ 正在读 ${p.input?.url ?? ''}…`}</span>
                  {!aborted && !failed && <Spin />}
                </summary>
              </details>
            );
          }
          return null;
        })}
        {imgs.length > 0 && (
          <div className="msg-imgs">
            {imgs.map((p, i) => (
              <Thumb key={i} part={p.demo ? p : { blob: p.url, name: p.filename }} />
            ))}
          </div>
        )}
        {text &&
          (live ? (
            <LiveText convId={convId} text={text} streaming={streaming} />
          ) : (
            <span>
              <Hl text={text} hits={you} />
            </span>
          ))}
        {aborted && <span className="mark">（已中止）</span>}
        {failed && <span className="mark is-err">（回复出错中断）</span>}
      </div>
    </div>
  );
});

function SegLine({ convId }: { convId: string }) {
  const seg = db.segs(convId)[0];
  if (!seg) return null;
  return (
    <div className="seg">
      <div className="seg-line">
        <span>{`会话开始 · ${fmtDay(Date.parse(seg.created_at))}`}</span>
      </div>
    </div>
  );
}

/* 消息列表：虚拟滚动；useChat 的消息 */
function ChatLog({ convId }: { convId: string }) {
  const rec = getRec(convId);
  const { messages, status } = useChat<ChatMsg>({ chat: rec.chat, throttle: 30 });
  useBusRev(['conv:update']);
  const busy = status === 'submitted' || status === 'streaming';
  const seen = useRef<{ conv: string; ids: Set<string> }>({
    conv: convId,
    ids: new Set(messages.map((m) => m.id)),
  });
  if (seen.current.conv !== convId)
    seen.current = { conv: convId, ids: new Set(messages.map((m) => m.id)) };
  const items: LogItem[] = [{ key: 'seg', est: 40, node: <SegLine convId={convId} /> }];
  if (!messages.length)
    items.push({
      key: 'empty',
      node: (
        <div className="empty">
          <b>还没有消息</b>在下面说点什么吧
        </div>
      ),
    });
  messages.forEach((m, i) => {
    const isNew = !seen.current.ids.has(m.id);
    seen.current.ids.add(m.id);
    const isLast = i === messages.length - 1 && m.role === 'assistant';
    const live = isLast && rec.liveMsg === m.id && partsOf(m).some((p) => p.type === 'text');
    items.push({
      key: m.id,
      node: <ChatItem convId={convId} m={m} live={live} streaming={busy && isLast} isNew={isNew} />,
    });
  });
  return <VirtualLog items={items} resetKey={convId} label="对话" live />;
}

/* 输入：Enter 发送、Shift+Enter 换行（输入法组词中不发送）；粘贴或拖入图片；生成中按 Esc 中止并阻止冒泡 */
function Composer({ convId, fullId }: { convId: string | null; fullId: string }) {
  const gen = useStore(chatState, (s) => !!s.gen && s.gen === convId);
  const [text, setText] = useState(() => (convId ? draftOf(convId).text : ''));
  const [atts, setAtts] = useState<Att[]>(() => (convId ? draftOf(convId).atts.slice() : []));
  const [drop, setDrop] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ta.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = Math.min(140, el.scrollHeight) + 'px';
    }
  }, [text]);
  const syncAtts = (id: string) => setAtts(draftOf(id).atts.slice());
  const addFiles = (files: File[]) => {
    const id = convId || newWebConv();
    const d = draftOf(id);
    let n = 0;
    for (const f of files) {
      if (!f.type || !f.type.startsWith('image/')) continue;
      d.atts.push({ url: URL.createObjectURL(f), name: f.name || '粘贴的图片', type: f.type });
      n++;
    }
    if (!n && files.length) toast('只能放图片');
    syncAtts(id);
  };
  const send = () => {
    const t = text.trim();
    if (convId) draftOf(convId).text = text;
    if (sendChat(convId, t)) {
      setText('');
      if (convId) setAtts([]);
    }
  };
  return (
    <div
      className={'chat-in' + (drop ? ' is-drop' : '')}
      onDragOver={(e) => {
        if ([...e.dataTransfer.types].includes('Files')) {
          e.preventDefault();
          setDrop(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrop(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDrop(false);
        addFiles([...e.dataTransfer.files]);
      }}
    >
      <div className="chat-atts">
        {atts.map((a, i) => (
          <span className="att" key={a.url}>
            <Thumb part={{ blob: a.url, name: a.name }} w={56} h={56} />
            <button
              type="button"
              title="移除这张图片"
              aria-label={'移除图片 ' + a.name}
              onClick={() => {
                if (convId) {
                  draftOf(convId).atts.splice(i, 1);
                  syncAtts(convId);
                }
                ta.current?.focus();
              }}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="chat-row">
        <textarea
          ref={ta}
          className="chat-ta"
          rows={1}
          id={fullId}
          placeholder="和洛璃说点什么…"
          aria-label="给洛璃的消息"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (convId) draftOf(convId).text = e.target.value;
          }}
          onKeyDown={(e) => {
            if (
              e.key === 'Enter' &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing &&
              e.keyCode !== 229
            ) {
              e.preventDefault();
              if (!gen) send();
            } else if (e.key === 'Escape' && gen) {
              e.preventDefault();
              e.stopPropagation();
              e.nativeEvent.stopImmediatePropagation();
              abortChat(chatState.get().gen!);
            }
          }}
          onPaste={(e) => {
            const fs = [...(e.clipboardData?.files || [])].filter((f) =>
              f.type.startsWith('image/'),
            );
            if (fs.length) {
              e.preventDefault();
              addFiles(fs);
            }
          }}
        />
        <button
          className={'chat-send' + (gen ? ' is-stop' : '')}
          type="button"
          title={gen ? '中止生成（Esc）' : '发送（Enter）'}
          onClick={() => {
            if (gen) abortChat(chatState.get().gen!);
            else send();
          }}
        >
          {gen ? '中止' : '发送'}
        </button>
      </div>
      <div className="chat-hint">
        <span>Enter 发送 · Shift+Enter 换行 · 可以粘贴或拖入图片</span>
        <span>{gen ? '生成中 · Esc 中止' : ''}</span>
      </div>
    </div>
  );
}

function ChatView({ mode }: ViewProps) {
  const full = mode === 'full';
  useBusRev(['chat:switch', 'conv:add', 'conv:update', 'conv:remove', 'data:reset', 'message']);
  useStore(chatState, (s) => s.cur);
  const cur = chatCur();
  const c = db.conv(cur);
  const [menu, setMenu] = useState(false);
  const [detail, setDetail] = useState(true);
  const barRef = useRef<HTMLDivElement>(null);
  const pickRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!menu) return;
    const outside = (e: PointerEvent) => {
      const t = e.target as Node;
      if (barRef.current?.querySelector('.chat-menu')?.contains(t) || pickRef.current?.contains(t))
        return;
      setMenu(false);
    };
    document.addEventListener('pointerdown', outside, true);
    const off = bus.on('chat:switch', () => setMenu(false));
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      off();
    };
  }, [menu]);
  const convs = webConvs();
  const body = cur ? (
    <ChatLog key={'log-' + cur} convId={cur} />
  ) : (
    <div className="tline" role="log" aria-live="polite" aria-label="对话">
      <div className="empty">
        <b>还没有对话</b>点「＋ 新对话」开始，或者直接在下面输入
      </div>
    </div>
  );
  const composer = (
    <Composer
      key={'input-' + (cur || 'none')}
      convId={cur}
      fullId={full ? 'chat-input-full' : 'chat-input'}
    />
  );
  if (!full) {
    return (
      <div className="chat">
        <div className="chat-bar" ref={barRef}>
          <button
            className="chat-pick"
            ref={pickRef}
            type="button"
            aria-haspopup="true"
            aria-expanded={menu}
            title="切换对话"
            onClick={() => setMenu(!menu)}
          >
            <span>{c ? c.title : '还没有对话'}</span>
          </button>
          <button
            className="chat-new"
            type="button"
            onClick={() => {
              newWebConv();
              setTimeout(() => document.getElementById('chat-input')?.focus());
            }}
          >
            ＋ 新对话
          </button>
          {menu && (
            <div className="chat-menu" role="menu">
              {convs.map((x) => (
                <button
                  key={x.id}
                  type="button"
                  role="menuitem"
                  aria-current={x.id === cur}
                  onClick={() => {
                    setMenu(false);
                    switchTo(x.id);
                  }}
                >
                  <span>{x.title}</span>
                  <time>{fmtShort(db.lastAt(x.id))}</time>
                </button>
              ))}
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenu(false);
                  newWebConv();
                }}
              >
                <span style={{ color: 'var(--gold-pale)' }}>＋ 新对话</span>
              </button>
            </div>
          )}
        </div>
        {body}
        {composer}
      </div>
    );
  }
  return (
    <div className={'chat-full' + (detail ? ' is-detail' : '')}>
      <aside className="sess-side">
        <div className="sess-side-head">
          <span>网页对话</span>
          <span>{convs.length} 个</span>
        </div>
        <button
          className="chat-new"
          type="button"
          style={{ margin: '8px 12px 2px', alignSelf: 'flex-start' }}
          onClick={() => {
            newWebConv();
            setDetail(true);
            setTimeout(() => document.getElementById('chat-input-full')?.focus());
          }}
        >
          ＋ 新对话
        </button>
        <ConvList
          convs={convs}
          selectedId={cur}
          onPick={(id) => {
            switchTo(id);
            setDetail(true);
          }}
          rev={db.rev}
          label="对话列表"
        />
      </aside>
      <div className="chat sess-main">
        <div className="chat-bar">
          <button
            className="w-btn sess-back"
            type="button"
            title="返回列表"
            aria-label="返回列表"
            onClick={() => setDetail(false)}
          >
            ‹
          </button>
          <h3
            style={{
              margin: 0,
              fontSize: 15,
              fontWeight: 600,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              minWidth: 0,
            }}
          >
            {c ? c.title : '还没有对话'}
          </h3>
        </div>
        {body}
        {composer}
      </div>
    </div>
  );
}

export const CHAT_DEF: WidgetDef = {
  id: 'chat',
  name: '对话',
  icon: IconChat,
  defaultSize: '1x2',
  refreshOn: [
    'conv:add',
    'conv:remove',
    'conv:update',
    'data:reset',
    'chat:switch',
    'reply:end',
    'reply:abort',
    'reply:error',
    'message',
  ],
  thumb() {
    const n = webConvs().length;
    if (chatState.get().gen)
      return (
        <>
          <em>正在回复</em> · {n} 个对话
        </>
      );
    return n ? `${n} 个对话` : '还没有对话';
  },
  sub() {
    const id = chatCur();
    return id ? db.conv(id)!.title : '';
  },
  View: ChatView,
};
