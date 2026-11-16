/* 这一节里的块的索引：点一下滚过去 */
const INDEX: readonly (readonly [string, string])[] = [
  ['fm-input', '单行输入'],
  ['fm-password', '密码'],
  ['fm-number', '数字'],
  ['fm-textarea', '多行'],
  ['fm-select', '下拉选择'],
  ['fm-check', '复选框'],
  ['fm-radio', '单选'],
  ['fm-slider', '滑块'],
  ['fm-field', '表单项和错误'],
  ['fm-list', '列表编辑'],
  ['fm-sample', '设置表单样例'],
];

export function IndexNav() {
  return (
    <div className="sc-ctl-bar">
      <nav className="sc-ctl-index" aria-label="这一节里的块" data-index="">
        {INDEX.map(([id, name]) => (
          <button
            key={id}
            type="button"
            onClick={() =>
              document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }
          >
            {name}
          </button>
        ))}
      </nav>
    </div>
  );
}
