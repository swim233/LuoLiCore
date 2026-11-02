import { isIP } from 'node:net';

type Range = { base: bigint; bits: number };

// 不许连的地址段（ADR-0007「安全」）。198.18.0.0/15 不拦：fake-ip 模式的代理会把所有域名
// 解析到这一段，拦了 fetch 就全部失效
const blockedIPv4 = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10', // 运营商级 NAT
  '127.0.0.0/8',
  '169.254.0.0/16', // 链路本地，含云主机的元数据服务
  '172.16.0.0/12',
  '192.168.0.0/16',
  '224.0.0.0/4', // 组播
  '240.0.0.0/4', // 保留，含 255.255.255.255
].map((cidr) => range(cidr, parseIPv4));

const blockedIPv6 = [
  '::/128',
  '::1/128',
  'fc00::/7', // 唯一本地地址
  'fe80::/10', // 链路本地
  'ff00::/8', // 组播
].map((cidr) => range(cidr, parseIPv6));

// 嵌入 IPv4 的 IPv6 段：按末 32 位的 IPv4 判断。后三段不常见，但部署环境里有对应的
// 转换网关时同样能通到 IPv4 内网
const embeddingIPv4 = [
  '::ffff:0:0/96', // IPv4 映射
  '64:ff9b::/96', // NAT64
  '::/96', // IPv4 兼容（已废弃）；其中的 :: 与 ::1 先按上面的 IPv6 范围判断
  '::ffff:0:0:0/96', // SIIT 的 IPv4 转换地址
  '64:ff9b:1::/48', // 本地用途的 NAT64
].map((cidr) => range(cidr, parseIPv6));

/**
 * 这个地址是否在拦截范围内（内网、本机、链路本地、组播、保留）。输入是 IP 地址字符串，
 * IPv6 可以带 `%网卡` 后缀；不是 IP 的一律算拦截
 */
export function isBlockedAddress(address: string): boolean {
  switch (isIP(address)) {
    case 4:
      return inRanges(parseIPv4(address), 32, blockedIPv4);
    case 6: {
      const value = parseIPv6(address);
      if (inRanges(value, 128, blockedIPv6)) return true;
      return inRanges(value, 128, embeddingIPv4) && inRanges(value & 0xffff_ffffn, 32, blockedIPv4);
    }
    default:
      return true;
  }
}

function range(cidr: string, parse: (address: string) => bigint): Range {
  const [address = '', bits = ''] = cidr.split('/');
  return { base: parse(address), bits: Number(bits) };
}

function inRange(value: bigint, width: number, { base, bits }: Range): boolean {
  const shift = BigInt(width - bits);
  return value >> shift === base >> shift;
}

function inRanges(value: bigint, width: number, ranges: Range[]): boolean {
  return ranges.some((r) => inRange(value, width, r));
}

// 以下两个函数只处理 isIP 认可的写法
function parseIPv4(address: string): bigint {
  return address.split('.').reduce((value, part) => (value << 8n) | BigInt(part), 0n);
}

function parseIPv6(address: string): bigint {
  let text = address.split('%')[0] ?? '';
  // 末尾写成点分 IPv4 的（如 ::ffff:127.0.0.1），换成两组十六进制
  if (text.includes('.')) {
    const at = text.lastIndexOf(':') + 1;
    const ipv4 = parseIPv4(text.slice(at));
    text = `${text.slice(0, at)}${(ipv4 >> 16n).toString(16)}:${(ipv4 & 0xffffn).toString(16)}`;
  }
  // `::` 最多出现一次，代表若干组 0
  const [head = '', tail] = text.split('::');
  const groups = (part: string) => (part === '' ? [] : part.split(':'));
  const left = groups(head);
  const right = tail === undefined ? [] : groups(tail);
  const zeros = tail === undefined ? [] : Array<string>(8 - left.length - right.length).fill('0');
  return [...left, ...zeros, ...right].reduce(
    (value, group) => (value << 16n) | BigInt(parseInt(group, 16)),
    0n,
  );
}
