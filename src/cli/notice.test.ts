import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { flushed } from './notice.js';

describe('等输出写完', () => {
  it('下游没读走时一直等，读完了才算写完；已经关掉的流马上算写完', async () => {
    // 一个缓冲很小的流，下游先不读：写进去的大段卡在缓冲里，像读得慢的管道
    const pipe = new PassThrough({ highWaterMark: 16 });
    const stream = pipe as unknown as NodeJS.WriteStream;
    stream.write('x'.repeat(1000));
    let done = false;
    const waiting = flushed(stream).then(() => (done = true));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(done).toBe(false);

    let received = 0;
    pipe.on('data', (chunk: Buffer) => (received += chunk.length));
    await waiting;
    expect(received).toBe(1000);

    pipe.destroy();
    await flushed(stream);
  });
});
