import {
  definePlugin,
  defineService,
  ServiceConfigError,
  type ServiceEnv,
} from '../../src/plugin-api.js';
import { qweatherAuth } from './jwt.js';

// 和风天气（ADR-0014）：第一个服务。查天气和天气预警，都按经纬度查；地名先用城市查询换成经纬度。
// 认证是 JWT（Ed25519 密钥对，私钥文件留在本机）；文档在 docs/，是发给模型的原文

/** 主机名：带了 https:// 也认，结尾的 / 去掉 */
function baseUrl(env: ServiceEnv): string {
  const host = env
    .QWEATHER_API_HOST!.trim()
    .replace(/^https:\/\//i, '')
    .replace(/\/+$/, '');
  if (!/^[A-Za-z0-9.-]+(:\d+)?$/.test(host)) {
    throw new ServiceConfigError(
      'QWEATHER_API_HOST 要写账号专属的主机名，如 abc123.def.qweatherapi.com',
    );
  }
  return `https://${host}`;
}

export const qweatherService = defineService({
  name: 'qweather',
  title: '和风天气',
  summary:
    '查天气和天气预警，全球都能查。接口有城市查询（地名查成经纬度）、实时天气、逐小时预报、逐天预报、天气预警',
  env: [
    'QWEATHER_API_HOST',
    'QWEATHER_DEVELOPER_ID',
    'QWEATHER_PROJECT_ID',
    'QWEATHER_KEY_ID',
    'QWEATHER_PRIVATE_KEY_FILE',
  ],
  baseUrl,
  auth: { type: 'custom', setup: qweatherAuth },
  endpoints: [
    {
      id: 'city_lookup',
      title: '城市查询',
      path: '/geo/v2/city/lookup',
      query: ['location', 'adm', 'range', 'number', 'lang'],
    },
    {
      id: 'weather_now',
      title: '实时天气',
      path: '/weather/v1/current/{latitude}/{longitude}',
      query: ['localTime', 'lang'],
    },
    {
      id: 'weather_hourly',
      title: '逐小时预报',
      path: '/weather/v1/hourly/{latitude}/{longitude}',
      query: ['hours', 'localTime', 'lang'],
    },
    {
      id: 'weather_daily',
      title: '逐天预报',
      path: '/weather/v1/daily/{latitude}/{longitude}',
      query: ['days', 'localTime', 'lang'],
    },
    {
      id: 'weather_alert',
      title: '天气预警',
      path: '/weatheralert/v1/current/{latitude}/{longitude}',
      query: ['localTime', 'lang'],
    },
  ],
  limits: {
    minIntervalSeconds: 300,
    maxRequestsPerDay: 1500,
    maxRequestsPerDayEnv: 'QWEATHER_MAX_REQUESTS_PER_DAY',
  },
  docs: new URL('./docs/', import.meta.url),
});

/** 和风天气插件：只有这一个服务，没有自己的工具 */
export const qweatherPlugin = definePlugin({ name: 'qweather', services: [qweatherService] });
