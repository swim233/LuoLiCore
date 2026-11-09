import { motionOn } from '../../lib/prefs';
import { fx } from '../../fx/client';
import { desk } from '../../state/desk';
import { faces } from '../../shell/faces';

/* 回复完成：星尘从光标的位置散开；没有光标时从顶栏的徽记或「此刻」胶囊里的徽记那里放一团 */
export function stardust(convId: string) {
  if (!motionOn()) return;
  const vis = (c: Element) => {
    const r = c.getBoundingClientRect();
    return (
      r.width > 0 &&
      r.bottom > 0 &&
      r.top < window.innerHeight &&
      !c.closest('[data-hide], [data-lifted], .fs-morph, .ghosts')
    );
  };
  let pts = [...document.querySelectorAll('.cur')]
    .filter(
      (c) =>
        (c as HTMLElement).dataset.conv === convId &&
        vis(c) &&
        (!desk.get().full || c.closest('#fs')),
    )
    .slice(0, 2)
    .map((c) => c.getBoundingClientRect());
  if (!pts.length) {
    const cand = [document.getElementById('top-badge'), faces('now').capBtn?.querySelector('.bd')]
      .filter(Boolean)
      .map((x) => (x as Element).getBoundingClientRect())
      .filter((r) => r.width > 0);
    pts = cand.slice(0, 1);
  }
  pts.forEach((r) => fx.burst(r.left + r.width / 2, r.top + r.height / 2, { n: 30 }));
}
