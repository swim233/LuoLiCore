/* @luoli/ui/md：Markdown 的纯逻辑（词法分析、会话列表的一行预览），不带组件、不碰 DOM。
   用的项目的模型层只要预览之类的纯函数时从这里引，不用连带加载聊天组件（@luoli/ui/chat）。 */
export { IncrementalLexer, lexMarkdown, plainPreview } from './markdown';
