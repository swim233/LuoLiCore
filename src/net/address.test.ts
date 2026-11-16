import { describe, expect, it } from 'vitest';
import { isBlockedAddress } from './address.js';

describe('isBlockedAddress', () => {
  // 每个范围取边界：段内第一个与最后一个拦，紧挨着的段外地址放行
  it.each([
    ['0.0.0.0', true],
    ['0.255.255.255', true],
    ['1.0.0.0', false],
    ['9.255.255.255', false],
    ['10.0.0.0', true],
    ['10.255.255.255', true],
    ['11.0.0.0', false],
    ['100.63.255.255', false],
    ['100.64.0.0', true],
    ['100.127.255.255', true],
    ['100.128.0.0', false],
    ['126.255.255.255', false],
    ['127.0.0.1', true],
    ['127.255.255.255', true],
    ['128.0.0.0', false],
    ['169.253.255.255', false],
    ['169.254.0.0', true],
    ['169.254.169.254', true],
    ['169.255.0.0', false],
    ['172.15.255.255', false],
    ['172.16.0.0', true],
    ['172.31.255.255', true],
    ['172.32.0.0', false],
    ['192.167.255.255', false],
    ['192.168.0.0', true],
    ['192.168.255.255', true],
    ['192.169.0.0', false],
    ['198.18.0.1', false],
    ['198.19.255.255', false],
    ['223.255.255.255', false],
    ['224.0.0.0', true],
    ['239.255.255.255', true],
    ['240.0.0.0', true],
    ['255.255.255.255', true],
    ['8.8.8.8', false],
    ['93.184.215.14', false],
  ])('IPv4 %s → %s', (address, blocked) => {
    expect(isBlockedAddress(address)).toBe(blocked);
  });

  it.each([
    ['::', true],
    ['::1', true],
    ['0:0:0:0:0:0:0:1', true],
    ['fbff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', false],
    ['fc00::', true],
    ['fd12:3456::1', true],
    ['fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', true],
    ['fe00::1', false],
    ['fe7f:ffff:ffff:ffff:ffff:ffff:ffff:ffff', false],
    ['fe80::', true],
    ['fe80::1%eth0', true],
    ['febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff', true],
    ['fec0::', false],
    ['ff00::', true],
    ['ff02::1', true],
    ['ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', true],
    ['2001:4860:4860::8888', false],
    ['2606:4700:4700::1111', false],
  ])('IPv6 %s → %s', (address, blocked) => {
    expect(isBlockedAddress(address)).toBe(blocked);
  });

  it.each([
    ['::ffff:127.0.0.1', true],
    ['::ffff:7f00:1', true],
    ['::ffff:10.1.2.3', true],
    ['::ffff:a01:203', true],
    ['::ffff:198.18.0.1', false],
    ['::ffff:8.8.8.8', false],
    ['::ffff:808:808', false],
    ['64:ff9b::7f00:1', true],
    ['64:ff9b::127.0.0.1', true],
    ['64:ff9b::a9fe:a9fe', true],
    ['64:ff9b::808:808', false],
    // IPv4 兼容（::/96）：:: 与 ::1 照旧按 IPv6 拦，其余按末 32 位的 IPv4
    ['::2', true],
    ['::7f00:1', true],
    ['::127.0.0.1', true],
    ['::c0a8:101', true],
    ['::808:808', false],
    ['::1:0:0', false],
    // SIIT 的 IPv4 转换地址（::ffff:0:0:0/96）
    ['::ffff:0:7f00:1', true],
    ['::ffff:0:a9fe:a9fe', true],
    ['::ffff:0:808:808', false],
    // 本地用途的 NAT64（64:ff9b:1::/48）
    ['64:ff9b:1::7f00:1', true],
    ['64:ff9b:1:ffff:ffff:ffff:7f00:1', true],
    ['64:ff9b:1::808:808', false],
    // 不在嵌入段里的，按 IPv6 本身判断
    ['::fffe:7f00:1', false],
    ['::1:ffff:0:7f00:1', false],
    ['64:ff9b:2::7f00:1', false],
  ])('嵌入 IPv4 的 IPv6 %s → %s', (address, blocked) => {
    expect(isBlockedAddress(address)).toBe(blocked);
  });

  it.each(['', 'localhost', 'example.com', '127.1', '[::1]', '1.2.3.4.5'])(
    '不是 IP 的 %j 一律拦截',
    (address) => {
      expect(isBlockedAddress(address)).toBe(true);
    },
  );
});
