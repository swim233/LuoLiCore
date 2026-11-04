/**
 * key 可能出现的几种形式：原文，以及逐层 JSON 转义后的形式。字段写进日志时转义一层；
 * 服务端在 message 或响应体里嵌 JSON 回显 key 时又多若干层。key 含 `"`、`\` 时
 * 每层都不同，这里取到三层：终端能覆盖嵌套三层，日志（多一层）覆盖嵌套两层。
 * 长的在前，免得短的先替换掉一部分。日志、终端与请求记录共用。
 */
export function jsonEscapedForms(key: string): string[] {
  const forms = [key];
  for (let depth = 1; depth <= 3; depth++) forms.unshift(JSON.stringify(forms[0]).slice(1, -1));
  return [...new Set(forms)];
}

/** 把文字里出现的秘密（API key、bot token 等，含 JSON 转义后的形式）都换成 `***` */
export function createRedactor(
  secrets: ReadonlyArray<string | undefined>,
): (text: string) => string {
  const forms = secrets
    .filter((secret): secret is string => Boolean(secret))
    .flatMap(jsonEscapedForms)
    // 长的在前：一个秘密是另一个的一部分时，先整段替换
    .sort((a, b) => b.length - a.length);
  return (text) => forms.reduce((result, form) => result.replaceAll(form, '***'), text);
}
