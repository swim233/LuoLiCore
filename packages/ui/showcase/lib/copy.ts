/* 复制到剪贴板：优先用 navigator.clipboard（127.0.0.1 是安全环境），不行就退回 execCommand */
export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      /* 复制不了就算了 */
    }
    ta.remove();
    return ok;
  }
}
