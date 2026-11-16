import { useState } from 'react';
import { ListEdit, cleanList } from '../../../src/forms';
import { Stage } from '../../components/Stage';
import { Block } from './shared';

/* 「列表编辑」一块：一行一个输入框加删除钮，末尾「添加」；增、删有动画，摆一个能连着加、连着删的样例 */
export function ListEditBlock() {
  const [groups, setGroups] = useState(['-100000000001', '-100000000002', '-100000000003']);
  const [words, setWords] = useState(['nori', '洛璃']);
  return (
    <Block id="fm-list" title="列表编辑" sub="ListEdit · list-edit.ts · list-rows.ts">
      <p className="sc-note">
        一组能增、删的文字（以后设置里的唤醒词、白名单的群和用户）。值是 <code>string[]</code>
        ，受控、不受控都认。一行一个输入框加删除钮，末尾「添加」：点「添加」多出一个空行并聚焦它，在行里按回车下面多出一个空行，重复的行标红；焦点离开整个列表时空行自己消失（键盘
        Tab
        出去马上消失，鼠标点别处的等这一下点完再消失，点击不会丢）；每一行的输入框给读屏的名字默认是「第
        N 项」（<code>itemLabel</code> 能改）。
        <b>增、删有动画</b>：新的一行从 0
        高长出来、同时淡入，下面的行被平滑地推下去；删的那一行淡出、同时收到 0
        高，下面的平滑地补上来（时长曲线同折叠）。点删除的那一刻 <code>onChange</code>{' '}
        就给出新数组，不等动画；收起中的那一行不能点、不能聚焦、读屏读不到。连着快点（连加、连删、加了马上删、删到一半再加）不乱。
        焦点：添加以后进新的一行；删除以后到下一行，没有下一行到上一行，都没有到「添加」钮。顶栏把动画关掉以后不长不收，直接出现、消失。
        规则：不许重复（默认）、最多几项（<code>rules.max</code>
        ）、是否区分大小写。增删的逻辑是纯函数（<code>list-edit.ts</code>、<code>list-rows.ts</code>
        ，有测试）。
      </p>
      <div className="sc-fm-two">
        <Stage kind="sky">
          <p className="sc-fm-cap">白名单的群（最多 5 个）：连着点「添加」和删除钮试试</p>
          <ListEdit
            aria-label="白名单的群"
            value={groups}
            onChange={setGroups}
            rules={{ max: 5 }}
            placeholder="群 id"
          />
          <p className="sc-fm-out" data-out="list-rows">
            {JSON.stringify(cleanList(groups))}
          </p>
        </Stage>
        <Stage kind="sky">
          <p className="sc-fm-cap">唤醒词（不区分大小写，不许重复）</p>
          <ListEdit
            aria-label="唤醒词"
            value={words}
            onChange={setWords}
            placeholder="一个唤醒词"
          />
          <p className="sc-fm-out" data-out="list-words">
            {JSON.stringify(cleanList(words))}
          </p>
        </Stage>
      </div>
      <h4 className="sc-h4">空的、禁用、三档尺寸</h4>
      <div className="sc-fm-two">
        <Stage kind="sky">
          <p className="sc-fm-cap">空的、禁用</p>
          <div className="sc-fm-live">
            <ListEdit aria-label="空的" defaultValue={[]} placeholder="还没有" />
            <ListEdit aria-label="禁用" defaultValue={['甲', '乙']} disabled />
          </div>
        </Stage>
        <Stage kind="sky">
          <p className="sc-fm-cap">sm、md、lg</p>
          <div className="sc-fm-live">
            <ListEdit aria-label="sm" size="sm" defaultValue={['甲', '乙']} />
            <ListEdit aria-label="md" size="md" defaultValue={['甲', '乙']} />
            <ListEdit aria-label="lg" size="lg" defaultValue={['甲', '乙']} />
          </div>
        </Stage>
      </div>
    </Block>
  );
}
