import { describe, expect, it } from 'vitest';
import { errorLine, errorLineChars } from './error-line.js';

describe('回复出错时的一句话', () => {
  it('明写了 HTTP 状态码：「请求失败（N）」，状态码单独给出', () => {
    expect(errorLine('HTTP 401')).toEqual({ text: '请求失败（401）', statusCode: 401 });
    expect(errorLine('HTTP/1.1 502 Bad Gateway')).toEqual({
      text: '请求失败（502）',
      statusCode: 502,
    });
    expect(errorLine('Request failed with status code 503')).toEqual({
      text: '请求失败（503）',
      statusCode: 503,
    });
    expect(errorLine('upstream error, statusCode: 500')).toEqual({
      text: '请求失败（500）',
      statusCode: 500,
    });
    expect(errorLine('429 Too Many Requests')).toEqual({
      text: '请求失败（429）',
      statusCode: 429,
    });
  });

  it('APICallError 的说明只是响应的原因短语（错误体不是 JSON 时）：按标准短语认出状态码', () => {
    expect(errorLine('Too Many Requests')).toEqual({ text: '请求失败（429）', statusCode: 429 });
    expect(errorLine('Service Unavailable')).toEqual({ text: '请求失败（503）', statusCode: 503 });
    expect(errorLine('unauthorized')).toEqual({ text: '请求失败（401）', statusCode: 401 });
    expect(errorLine('Payload Too Large')).toEqual({ text: '请求失败（413）', statusCode: 413 });
  });

  it('重试用尽、遇到不可重试的错误：看里面那个错误', () => {
    expect(errorLine('Failed after 3 attempts. Last error: Too Many Requests')).toEqual({
      text: '请求失败（429）',
      statusCode: 429,
    });
    expect(errorLine('Failed after 3 attempts. Last error: HTTP 503')).toEqual({
      text: '请求失败（503）',
      statusCode: 503,
    });
    // SDK 实际给出的：里面的错误带着类型名
    expect(
      errorLine('Failed after 3 attempts. Last error: AI_APICallError: Too Many Requests'),
    ).toEqual({
      text: '请求失败（429）',
      statusCode: 429,
    });
    expect(
      errorLine("Failed after 2 attempts with non-retryable error: 'AI_APICallError: Forbidden'"),
    ).toEqual({ text: '请求失败（403）', statusCode: 403 });
    expect(errorLine("Failed after 2 attempts with non-retryable error: 'Unauthorized'")).toEqual({
      text: '请求失败（401）',
      statusCode: 401,
    });
    // 里面是服务端自己写的说明：认不出，原样
    expect(
      errorLine('Failed after 3 attempts. Last error: Rate limit reached for requests'),
    ).toEqual({ text: 'Failed after 3 attempts. Last error: Rate limit reached for requests' });
  });

  it('超时（核心自己的说明）：原样', () => {
    expect(errorLine('等待模型输出超时：60 秒内没有收到第一段输出')).toEqual({
      text: '等待模型输出超时：60 秒内没有收到第一段输出',
    });
    expect(errorLine('等待模型输出超时：两段输出之间超过 30 秒')).toEqual({
      text: '等待模型输出超时：两段输出之间超过 30 秒',
    });
  });

  it('网络错误：原样；地址、端口里的数字不当成状态码', () => {
    expect(errorLine('Cannot connect to API: connect ECONNREFUSED 127.0.0.1:443')).toEqual({
      text: 'Cannot connect to API: connect ECONNREFUSED 127.0.0.1:443',
    });
    expect(
      errorLine('Failed after 3 attempts. Last error: Cannot connect to API: fetch failed'),
    ).toEqual({ text: 'Failed after 3 attempts. Last error: Cannot connect to API: fetch failed' });
  });

  it('开头是三位数：只有这个数、或后面紧跟它的原因短语才算；别的以数字开头的说明不算', () => {
    expect(errorLine('502')).toEqual({ text: '请求失败（502）', statusCode: 502 });
    expect(errorLine('503 Service Unavailable - upstream overloaded')).toEqual({
      text: '请求失败（503）',
      statusCode: 503,
    });
    expect(errorLine('400 tokens is the max for this model')).toEqual({
      text: '400 tokens is the max for this model',
    });
    // 数和短语对不上
    expect(errorLine('429 Service Unavailable')).toEqual({ text: '429 Service Unavailable' });
  });

  it('服务端自己写的说明、不是错误的码：原样', () => {
    expect(errorLine('Insufficient Balance')).toEqual({ text: 'Insufficient Balance' });
    expect(errorLine('HTTP 200')).toEqual({ text: 'HTTP 200' });
    expect(errorLine('OK')).toEqual({ text: 'OK' });
  });

  it('只取第一行；太长的截断；空的说「请求失败」', () => {
    expect(errorLine('提示词文件有误：persona.md\n第二行是细节')).toEqual({
      text: '提示词文件有误：persona.md',
    });
    // 第二行里的码不算
    expect(errorLine('出错了\nHTTP 500')).toEqual({ text: '出错了' });
    const long = errorLine('很'.repeat(500)).text;
    expect([...long]).toHaveLength(errorLineChars);
    expect(long.endsWith('…')).toBe(true);
    expect(errorLine('')).toEqual({ text: '请求失败' });
    expect(errorLine('  \n ')).toEqual({ text: '请求失败' });
  });
});
