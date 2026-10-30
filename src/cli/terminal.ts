import { emitKeypressEvents, type Key } from 'node:readline';
import { createInterface } from 'node:readline/promises';

/** 处理一行输入；signal 在用户按 Ctrl+C 时中止 */
export type LineHandler = (text: string, signal: AbortSignal) => Promise<void>;

/**
 * 终端模式的输入循环。
 * - 空闲：readline 读一行（行编辑、历史），Ctrl+C 有字清行、空行要连按两次才退出，Ctrl+D 退出。
 * - 忙（从回车到回复处理完）：键盘由这里接管，只认 Ctrl+C（中止），其他按键读掉丢弃、不回显。
 * 每次读行新建一个 readline：它在读行期间负责回显，忙时必须让它彻底不碰键盘。
 */
export async function runTerminal(handle: LineHandler): Promise<void> {
  emitKeypressEvents(process.stdin);
  let history: string[] = [];
  try {
    while (true) {
      const turn = await readLine(history, (next) => {
        history = next;
      });
      if (turn === undefined) return;
      const text = turn.line.trim();
      try {
        if (text === '/exit') return;
        if (!text) continue;
        // rl.close() 暂停了 stdin；忙时按的键在缓冲里，恢复后由 turn 的监听读掉
        process.stdin.resume();
        await handle(text, turn.signal);
      } finally {
        turn.release();
      }
    }
  } finally {
    // 忙时与 /exit 时 raw 模式还开着（见 readLine）
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}

/** 读到的一行，以及从回车起接管键盘的「忙」状态：signal 在 Ctrl+C 时中止，release 交还键盘 */
type Turn = { line: string; signal: AbortSignal; release: () => void };

/** 读一行；用户要求退出（Ctrl+D，或空行连按两次 Ctrl+C）时返回 undefined */
function readLine(
  history: string[],
  onHistory: (history: string[]) => void,
): Promise<Turn | undefined> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: '> ',
      terminal: true,
      history,
    });
    rl.on('history', onHistory);

    let settled = false;
    // 空行按过一次 Ctrl+C，等下一个按键：还是 Ctrl+C 就退出，别的键（含打字后删掉）重新计
    let exitArmed = false;
    const onKeypress = (_input: string | undefined, key: Key | undefined) => {
      if (!isCtrlC(key)) exitArmed = false;
    };
    process.stdin.on('keypress', onKeypress);

    const settle = (value: Turn | undefined) => {
      settled = true;
      process.stdin.off('keypress', onKeypress);
      resolve(value);
    };

    rl.on('line', (line) => {
      // 必须在这里同步接管键盘：回车与紧随其后的 Ctrl+C 可能在同一次读入里，
      // 解码器会接着同步发出后面的按键，等 Promise 回到调用方再接管就漏掉了
      settle({ line, ...captureKeyboard() });
      rl.close();
      // close 会关掉 raw 模式；马上打开，忙时 Ctrl+C 才仍是一个按键，而不是终止进程的信号
      process.stdin.setRawMode(true);
    });

    // Ctrl+D、或下面第二次 Ctrl+C 关闭时，光标还停在提示符后
    rl.on('close', () => {
      if (settled) return;
      process.stdout.write('\n');
      settle(undefined);
    });

    // raw 模式下 Ctrl+C 不产生信号，由 readline 发出这个事件
    rl.on('SIGINT', () => {
      if (rl.line) {
        // 有字：清空这一行（移到行尾，再删到行首）
        rl.write(null, { ctrl: true, name: 'e' });
        rl.write(null, { ctrl: true, name: 'u' });
        exitArmed = false;
      } else if (exitArmed) {
        rl.close();
      } else {
        exitArmed = true;
        process.stdout.write('\n');
        console.error('再按一次 Ctrl+C 退出');
        rl.prompt();
      }
    });

    rl.prompt();
  });
}

/** 接管键盘：Ctrl+C 中止，其他按键（含粘贴的多行）读掉丢弃；raw 模式下不回显 */
function captureKeyboard(): { signal: AbortSignal; release: () => void } {
  const controller = new AbortController();
  const onKeypress = (_input: string | undefined, key: Key | undefined) => {
    if (isCtrlC(key)) controller.abort();
  };
  process.stdin.on('keypress', onKeypress);
  return {
    signal: controller.signal,
    release: () => process.stdin.off('keypress', onKeypress),
  };
}

function isCtrlC(key: Key | undefined): boolean {
  return key?.ctrl === true && key.name === 'c';
}
