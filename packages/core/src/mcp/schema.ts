import { z } from "zod";

/**
 * MCP 的入参是标准 JSON Schema，而 registry 只认 zod。此前注册时整份换成 `z.record(z.unknown())`，
 * 模型拿到的工具定义是「一个任意对象」：只能靠工具名猜参数名，猜错了 `execute()` 的 safeParse 也不拦，
 * 错误参数直接送到 MCP server —— MCP 工具在实践中不可用（docs/20 · W-MCP-01）。
 *
 * 这里只覆盖 MCP 服务器实际会产出的子集。遇到表达不了的结构（$ref / oneOf / allOf）就退回
 * `z.unknown()` 宽松放行那一个节点，而不是把整个工具打回通配——降级要发生在最小的范围上。
 *
 * **深度有上界。** `properties` / `items` 此前无界递归：一台 MCP server 回一份超深 `inputSchema`
 * 就是 `RangeError: Maximum call stack size exceeded`，而 `main.ts` 的 `await mcp.reconcile()`
 * 在启动路径上 —— 整个进程起不来（docs/27 · C-04）。超过上界按同一套策略降级成 `z.unknown()`：
 * 32 层比任何真实工具入参都深得多，撞到它说明对面在造结构而不是在描述参数。
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
        // additionalProperties 没被显式关掉时保留多余字段：删掉它们等于替 MCP server 做主。
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
