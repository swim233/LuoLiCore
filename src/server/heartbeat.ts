/** SSE 的注释行：解析的一方（AI SDK 的 useChat、CLI、EventSource）都跳过它 */
const ping = new TextEncoder().encode(': ping\n\n');

/**
 * 给 SSE 格式的响应体加心跳：每 intervalMs 在两个事件之间插一行注释（`: ping`），
 * 让客户端能用一个有限的「两段数据之间最多等多久」发现服务卡住，又不会把正常的长时间没有数据
 * （排队等别人的回复结束）误判成断开。原来的响应体是一块一个完整的事件，所以插在块与块之间
 * 不会切开事件。原来的流结束时停；对面不读了时取消原来的流（断开照旧算中止）
 */
export function withHeartbeat(
  body: ReadableStream<Uint8Array>,
  intervalMs: number,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let timer: NodeJS.Timeout | undefined;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setInterval(() => {
        try {
          controller.enqueue(ping);
        } catch {
          // 已经结束
        }
      }, intervalMs);
      timer.unref();
    },
    async pull(controller) {
      let read;
      try {
        read = await reader.read();
      } catch (error) {
        clearInterval(timer);
        controller.error(error);
        return;
      }
      if (read.done) {
        clearInterval(timer);
        controller.close();
        return;
      }
      controller.enqueue(read.value);
    },
    async cancel(reason) {
      clearInterval(timer);
      await reader.cancel(reason);
    },
  });
}
