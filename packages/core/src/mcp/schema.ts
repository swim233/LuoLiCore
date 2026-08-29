import { z } from "zod";

/**
 * MCP 的入参是标准 JSON Schema，而 registry 只接受 zod。此前注册时整份替换成 `z.record(z.unknown())`，
 * 模型拿到的工具定义是一个任意对象：只能依据工具名推测参数名，推测错误时 `execute()` 的 safeParse 也不拦截，
 * 错误参数直接送达 MCP server，导致 MCP 工具在实践中不可用（docs/20 · W-MCP-01）。
 *
 * 这里只覆盖 MCP 服务器实际会产出的子集。遇到无法表达的结构（$ref / oneOf / allOf）时退回
 * `z.unknown()` 宽松放行该节点，而不是把整个工具打回通配：降级应发生在最小范围内。
 *
 * 深度设有上界。`properties` / `items` 此前无界递归：一台 MCP server 返回超深 `inputSchema`
 * 即触发 `RangeError: Maximum call stack size exceeded`，而 `main.ts` 的 `await mcp.reconcile()`
 * 位于启动路径上，整个进程无法启动（docs/27 · C-04）。超过上界按同一策略降级为 `z.unknown()`：
 * 32 层远深于任何真实工具入参，触及该上界说明对方在构造结构而非描述参数。
 */
const MAX_SCHEMA_DEPTH = 32;
export function jsonSchemaToZod(schema: unknown, depth = 0): z.ZodTypeAny {
  if (depth > MAX_SCHEMA_DEPTH) return z.unknown();
  if (!schema || typeof schema !== "object" || Array.isArray(schema))
    return z.unknown();
  const node = schema as Record<string, unknown>;
  const described = (type: z.ZodTypeAny): z.ZodTypeAny => {
    const withDescription =
      typeof node.description === "string"
        ? type.describe(node.description)
        : type;
    return node.default === undefined
      ? withDescription
      : withDescription.default(node.default);
  };
  if (Array.isArray(node.enum) && node.enum.length) {
    const literals: z.ZodTypeAny[] = node.enum.map((value) =>
      z.literal(value as string | number | boolean),
    );
    return described(
      literals.length === 1
        ? literals[0]!
        : z.union(
            literals as unknown as [
              z.ZodTypeAny,
              z.ZodTypeAny,
              ...z.ZodTypeAny[],
            ],
          ),
    );
  }
  const declared = Array.isArray(node.type)
    ? node.type.filter((entry): entry is string => typeof entry === "string")
    : typeof node.type === "string"
      ? [node.type]
      : [];
  const nullable = declared.includes("null");
  const type =
    declared.find((entry) => entry !== "null") ??
    (node.properties ? "object" : undefined);
  const base = ((): z.ZodTypeAny => {
    switch (type) {
      case "object": {
        const properties =
          node.properties && typeof node.properties === "object"
            ? (node.properties as Record<string, unknown>)
            : null;
        if (!properties) return z.record(z.unknown());
        const required = new Set(
          Array.isArray(node.required)
            ? node.required.filter(
                (entry): entry is string => typeof entry === "string",
              )
            : [],
        );
        const shape = Object.fromEntries(
          Object.entries(properties).map(([key, child]) => {
            const converted = jsonSchemaToZod(child, depth + 1);
            return [key, required.has(key) ? converted : converted.optional()];
          }),
        );
        // additionalProperties 未被显式关闭时保留多余字段：删除它们等于代替 MCP server 做决定。
        return node.additionalProperties === false
          ? z.object(shape)
          : z.object(shape).passthrough();
      }
      case "array":
        return z.array(jsonSchemaToZod(node.items, depth + 1));
      case "string":
        return z.string();
      case "integer":
        return z.number().int();
      case "number":
        return z.number();
      case "boolean":
        return z.boolean();
      default:
        return z.unknown();
    }
  })();
  return described(nullable ? base.nullable() : base);
}
