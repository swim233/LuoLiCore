import { SectionHead } from '../components/SectionHead';
import { useCssRev } from '../lib/css-read';
import { FontScale } from './scale/FontScale';
import { RadiusScale } from './scale/RadiusScale';
import { SpaceScale } from './scale/SpaceScale';

/* 第二节「刻度」：字号、间距、圆角的档位（提案），每组加一张「现在的数字并到哪一档」的对照表，
   用户要看着它定刻度。档位从页面上读（tokens.css 里的 --ll-text-*、--ll-space-*、--ll-radius-*），改了 tokens.css 对照表跟着变。
   层级（z-index）和专用值（窗口 22、气泡 16 和 5）在「变量」一节和这里的圆角里 */
export function Scale() {
  useCssRev();
  return (
    <>
      <SectionHead title="刻度">
        字号、间距、圆角三组刻度，加上「面板现在的数字会被并到哪一档」。这一步只是摆出来给你看，不套用到面板上。
      </SectionHead>
      <FontScale />
      <SpaceScale />
      <RadiusScale />
    </>
  );
}
