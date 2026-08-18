import { crc32, deflateRawSync } from 'node:zlib';

/**
 * 手搓一个 zip。**不用 `zip` 命令、也不引打包库**：要测的正是正常打包工具产不出来的东西 ——
 * 名字里带 `../`、绝对路径、符号链接条目、以及谎报 `uncompressedSize` 的压缩炸弹。
 * 用真实打包器只能测到「正常包能装上」，而那一半恰好是不需要防线的那一半。
 *
 * 只实现最小子集：无 zip64、无数据描述符、无额外字段。够解包器读。
 */
export interface ZipFixtureEntry {
  /** 以 `/` 结尾表示目录条目。 */
  name: string;
  content?: Buffer | string;
  /** Unix 模式（`0o100755` 之类）。落进外部属性的高 16 位，解包器按它判执行位与符号链接。 */
  mode?: number;
  deflate?: boolean;
  /** 头里声明的解压后大小。与真实大小不符时用来测「信头就等于不设防」。 */
  declaredSize?: number;
}

export function zipFixture(entries: ZipFixtureEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const isDirectory = entry.name.endsWith('/');
    const raw = isDirectory ? Buffer.alloc(0) : Buffer.from(entry.content ?? '');
    const payload = entry.deflate ? deflateRawSync(raw) : raw;
    const name = Buffer.from(entry.name, 'utf8');
    // yauzl 不校验 crc32（README 明说没实现），但填对了不吃亏。
    const checksum = crc32(raw);
    const declared = entry.declaredSize ?? raw.length;
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x0403_4b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6);
    local.writeUInt16LE(entry.deflate ? 8 : 0, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12);
    local.writeUInt32LE(checksum, 14); local.writeUInt32LE(payload.length, 18); local.writeUInt32LE(declared, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28); name.copy(local, 30);
    locals.push(local, payload);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x0201_4b50, 0);
    central.writeUInt16LE(0x031e, 4);          // version made by：高字节 3 = UNIX，外部属性才是权限位
    central.writeUInt16LE(20, 6); central.writeUInt16LE(0, 8);
    central.writeUInt16LE(entry.deflate ? 8 : 0, 10); central.writeUInt16LE(0, 12); central.writeUInt16LE(0, 14);
    central.writeUInt32LE(checksum, 16); central.writeUInt32LE(payload.length, 20); central.writeUInt32LE(declared, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36);
    central.writeUInt32LE((((entry.mode ?? (isDirectory ? 0o040755 : 0o100644)) >>> 0) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42); name.copy(central, 46);
    centrals.push(central);
    offset += local.length + payload.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x0605_4b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, directory, end]);
}
