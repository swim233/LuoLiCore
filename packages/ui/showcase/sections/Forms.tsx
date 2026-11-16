import { SectionHead } from '../components/SectionHead';
import { FieldBlock } from './forms/FieldBlock';
import { CheckBlock, RadioBlock, SliderBlock } from './forms/ChoiceBlocks';
import { IndexNav } from './forms/IndexNav';
import { InputBlock, NumberBlock, PasswordBlock, TextareaBlock } from './forms/InputBlocks';
import { ListEditBlock } from './forms/ListEditBlock';
import { SampleBlock } from './forms/SampleBlock';
import { SelectBlock } from './forms/SelectBlock';

/* 「表单」一节：输入框、密码、数字、多行、下拉选择、复选框、单选、滑块、表单项和错误提示、列表编辑，加一张设置表单的样例。
   表单里的控件默认用 lg 档（高 32、字 13），sm、md 两档留着能用（每块底下有三档尺寸那一排）。 */
export function Forms() {
  return (
    <>
      <SectionHead title="表单">
        输入框（单行、密码、数字、多行）、下拉选择、复选框、单选、滑块、表单项和错误提示、列表编辑。入口以后是{' '}
        <code>@luoli/ui/forms</code>；Base UI
        打底（键盘、焦点、读屏的属性、校验、表单提交都是它给的），库只加类名和样子。
        输入类的底用「槽」（下拉钮的 slot：<code>--ll-inset-bg</code>{' '}
        加细线），放在一起像一家；尺寸三档（高 22、28、32）和按钮同档对齐， 表单里默认用 32
        那档。焦点是细线变强调色、里面一圈淡光（没有外圈）；出错是红线、一点红底、下面一行带图标的红字。
      </SectionHead>
      <IndexNav />
      <InputBlock />
      <PasswordBlock />
      <NumberBlock />
      <TextareaBlock />
      <SelectBlock />
      <CheckBlock />
      <RadioBlock />
      <SliderBlock />
      <FieldBlock />
      <ListEditBlock />
      <SampleBlock />
    </>
  );
}
