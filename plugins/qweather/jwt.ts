import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ServiceConfigError, type ServiceEnv } from '../../src/plugin-api.js';

// 和风天气的 JWT 认证（Ed25519）：只用 Node 自带的 node:crypto。
// 头 {"alg":"EdDSA","kid":凭据 ID}，内容 {"iss":开发者 ID,"sub":项目 ID,"iat","exp"}，不带别的字段
// （官方文档说 typ、aud、nbf 最好不带）。两段各做 Base64URL，用点连起来签名，签名也做 Base64URL

/** 签出的 token 管多久（秒） */
export const tokenSeconds = 900;
/** iat 往前拨多少秒，免得两边的时钟差一点就被拒 */
export const backdateSeconds = 30;
/** 剩不到这么多秒就重新签 */
export const renewSeconds = 60;

/**
 * 装配时调用一次：读私钥文件（读不了、不是 Ed25519 私钥时抛 ServiceConfigError，说明里不带路径和密钥），
 * 返回每次请求前调用的函数：按给的时间签 token，没快过期时复用上一个。私钥只留在内存里
 */
export function qweatherAuth(env: ServiceEnv): (request: { now: Date }) => Record<string, string> {
  const key = loadKey(env.QWEATHER_PRIVATE_KEY_FILE!);
  const header = encode({ alg: 'EdDSA', kid: env.QWEATHER_KEY_ID });
  let cached: { token: string; iat: number; exp: number } | undefined;
  return ({ now }) => {
    const seconds = Math.floor(now.getTime() / 1000);
    // 快过期了，或者时间往回拨到了签发之前：重新签
    if (!cached || cached.exp - seconds < renewSeconds || seconds < cached.iat) {
      const iat = seconds - backdateSeconds;
      const exp = iat + tokenSeconds;
      const payload = encode({
        iss: env.QWEATHER_DEVELOPER_ID,
        sub: env.QWEATHER_PROJECT_ID,
        iat,
        exp,
      });
      const signature = sign(null, Buffer.from(`${header}.${payload}`), key).toString('base64url');
      cached = { token: `${header}.${payload}.${signature}`, iat, exp };
    }
    return { Authorization: `Bearer ${cached.token}` };
  };
}

function encode(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function loadKey(path: string): KeyObject {
  let pem: Buffer;
  try {
    pem = readFileSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new ServiceConfigError(
      `QWEATHER_PRIVATE_KEY_FILE 指向的私钥文件读不了${code ? `（${code}）` : ''}`,
    );
  }
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    throw new ServiceConfigError('QWEATHER_PRIVATE_KEY_FILE 指向的文件不是 PEM 格式的私钥');
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new ServiceConfigError(
      `QWEATHER_PRIVATE_KEY_FILE 指向的私钥不是 Ed25519 的（是 ${key.asymmetricKeyType ?? '未知类型'}）`,
    );
  }
  return key;
}
