import { generateKeyPairSync, verify, type KeyObject } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ServiceConfigError, type ServiceEnv } from '../../src/plugin-api.js';
import { qweatherPlugin, qweatherService } from './index.js';
import { backdateSeconds, qweatherAuth, renewSeconds, tokenSeconds } from './jwt.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 写到临时目录里的一个文件，返回路径 */
function tempFile(name: string, content: string | Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), 'luoli-qweather-'));
  dirs.push(dir);
  const file = join(dir, name);
  writeFileSync(file, content);
  return file;
}

/** 现生成一对 Ed25519 密钥，私钥写成 PEM 文件 */
function ed25519(): { publicKey: KeyObject; file: string; pem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  return { publicKey, file: tempFile('ed25519.pem', pem), pem };
}

function envWith(file: string): ServiceEnv {
  return {
    QWEATHER_API_HOST: 'abc123.def.qweatherapi.com',
    QWEATHER_DEVELOPER_ID: 'DEVELOPER01',
    QWEATHER_PROJECT_ID: 'PROJECT0001',
    QWEATHER_KEY_ID: 'KEYID00001',
    QWEATHER_PRIVATE_KEY_FILE: file,
  };
}

/** 拆开 Authorization 里的 token：三段的原文与解出来的头、内容 */
function parse(headers: Record<string, string>) {
  const match = /^Bearer (.+)$/.exec(headers.Authorization ?? '');
  expect(match).not.toBeNull();
  const token = match![1]!;
  const [header, payload, signature] = token.split('.') as [string, string, string];
  const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  return { token, header, payload, signature, head: decode(header), body: decode(payload) };
}

function configError(run: () => unknown): string {
  let error: unknown;
  try {
    run();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(ServiceConfigError);
  return (error as ServiceConfigError).message;
}

describe('JWT', () => {
  it('三段：头是 EdDSA 和凭据 ID，内容是开发者 ID、项目 ID、iat、exp，不带别的；用公钥验得过；都是 Base64URL', () => {
    const { publicKey, file } = ed25519();
    const sign = qweatherAuth(envWith(file));
    const now = new Date('2026-11-16T08:00:00Z');
    const { token, header, payload, signature, head, body } = parse(sign({ now }));

    expect(head).toEqual({ alg: 'EdDSA', kid: 'KEYID00001' });
    const iat = now.getTime() / 1000 - backdateSeconds;
    expect(body).toEqual({ iss: 'DEVELOPER01', sub: 'PROJECT0001', iat, exp: iat + tokenSeconds });
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(
      verify(
        null,
        Buffer.from(`${header}.${payload}`),
        publicKey,
        Buffer.from(signature, 'base64url'),
      ),
    ).toBe(true);
    // 别的公钥验不过
    expect(
      verify(
        null,
        Buffer.from(`${header}.${payload}`),
        generateKeyPairSync('ed25519').publicKey,
        Buffer.from(signature, 'base64url'),
      ),
    ).toBe(false);
  });

  it('iat、exp 跟着给的时间走；没快过期时复用，剩不到 1 分钟时重签；时间往回拨到签发之前也重签', () => {
    const { file } = ed25519();
    const sign = qweatherAuth(envWith(file));
    const start = Date.parse('2026-11-16T08:00:00Z');
    const at = (seconds: number) => parse(sign({ now: new Date(start + seconds * 1000) }));

    const first = at(0);
    expect(first.body.iat).toBe(start / 1000 - backdateSeconds);
    // exp = start + 870 秒；剩不到 60 秒（过了 start + 810 秒）才重签
    const reuseUntil = tokenSeconds - backdateSeconds - renewSeconds;
    expect(at(1).token).toBe(first.token);
    expect(at(reuseUntil).token).toBe(first.token);

    const renewed = at(reuseUntil + 1);
    expect(renewed.token).not.toBe(first.token);
    expect(renewed.body.iat).toBe(start / 1000 + reuseUntil + 1 - backdateSeconds);
    expect(renewed.body.exp).toBe(renewed.body.iat + tokenSeconds);
    expect(at(reuseUntil + 2).token).toBe(renewed.token);

    const back = at(-3600);
    expect(back.body.iat).toBe(start / 1000 - 3600 - backdateSeconds);
  });

  it('私钥文件不存在、不是私钥、不是 Ed25519 时报配置有误；说明里没有路径和密钥的内容', () => {
    const missing = join(tmpdir(), 'luoli-qweather-no-such-dir', 'none.pem');
    const noFile = configError(() => qweatherAuth(envWith(missing)));
    expect(noFile).toBe('QWEATHER_PRIVATE_KEY_FILE 指向的私钥文件读不了（ENOENT）');

    const garbage = tempFile('garbage.pem', '这不是私钥');
    expect(configError(() => qweatherAuth(envWith(garbage)))).toBe(
      'QWEATHER_PRIVATE_KEY_FILE 指向的文件不是 PEM 格式的私钥',
    );

    const { privateKey: ec } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const ecPem = ec.export({ type: 'pkcs8', format: 'pem' }).toString();
    const ecFile = tempFile('ec.pem', ecPem);
    const wrongType = configError(() => qweatherAuth(envWith(ecFile)));
    expect(wrongType).toBe('QWEATHER_PRIVATE_KEY_FILE 指向的私钥不是 Ed25519 的（是 ec）');

    const { publicKey } = ed25519();
    const publicFile = tempFile('public.pem', publicKey.export({ type: 'spki', format: 'pem' }));
    expect(configError(() => qweatherAuth(envWith(publicFile)))).toBe(
      'QWEATHER_PRIVATE_KEY_FILE 指向的文件不是 PEM 格式的私钥',
    );

    for (const message of [noFile, wrongType]) {
      expect(message).not.toContain(missing);
      expect(message).not.toContain(ecFile);
      expect(message).not.toContain(ecPem.split('\n')[1]!);
    }
  });
});

describe('和风天气的声明', () => {
  it('插件只有这一个服务，没有自己的工具', () => {
    expect(qweatherPlugin.name).toBe('qweather');
    expect(qweatherPlugin.tools).toEqual([]);
    expect(qweatherPlugin.services).toEqual([qweatherService]);
  });

  it('五个必需的环境变量；每天最多 1500 次，可以用 QWEATHER_MAX_REQUESTS_PER_DAY 改；最短间隔 300 秒', () => {
    expect(qweatherService.env).toEqual([
      'QWEATHER_API_HOST',
      'QWEATHER_DEVELOPER_ID',
      'QWEATHER_PROJECT_ID',
      'QWEATHER_KEY_ID',
      'QWEATHER_PRIVATE_KEY_FILE',
    ]);
    expect(qweatherService.limits).toEqual({
      minIntervalSeconds: 300,
      maxRequestsPerDay: 1500,
      maxRequestsPerDayEnv: 'QWEATHER_MAX_REQUESTS_PER_DAY',
    });
  });

  it('五个接口的 id、路径、查询参数', () => {
    expect(
      qweatherService.endpoints.map(({ id, path, query }) => [id, path, query.join(',')]),
    ).toEqual([
      ['city_lookup', '/geo/v2/city/lookup', 'location,adm,range,number,lang'],
      ['weather_now', '/weather/v1/current/{latitude}/{longitude}', 'localTime,lang'],
      ['weather_hourly', '/weather/v1/hourly/{latitude}/{longitude}', 'hours,localTime,lang'],
      ['weather_daily', '/weather/v1/daily/{latitude}/{longitude}', 'days,localTime,lang'],
      ['weather_alert', '/weatheralert/v1/current/{latitude}/{longitude}', 'localTime,lang'],
    ]);
  });

  it('地址：主机名前面加 https://；带了 https://、结尾的 / 也认；不是主机名时报配置有误', () => {
    const baseUrl = qweatherService.baseUrl as (env: ServiceEnv) => string;
    const of = (host: string) => baseUrl({ ...envWith('/x'), QWEATHER_API_HOST: host });
    expect(of('abc123.def.qweatherapi.com')).toBe('https://abc123.def.qweatherapi.com');
    expect(of(' https://abc123.def.qweatherapi.com/ ')).toBe('https://abc123.def.qweatherapi.com');
    expect(configError(() => of('abc.qweatherapi.com/v7'))).toBe(
      'QWEATHER_API_HOST 要写账号专属的主机名，如 abc123.def.qweatherapi.com',
    );
    expect(configError(() => of('http://abc.qweatherapi.com'))).toBe(
      'QWEATHER_API_HOST 要写账号专属的主机名，如 abc123.def.qweatherapi.com',
    );
  });

  it('认证是自己写的那种，装配时用的就是 qweatherAuth', () => {
    const { file } = ed25519();
    const auth = qweatherService.auth;
    if (auth?.type !== 'custom') throw new Error('应当是自己写的认证');
    const headers = auth.setup(envWith(file))({ now: new Date('2026-11-16T08:00:00Z') });
    expect(parse(headers).head.alg).toBe('EdDSA');
  });
});
