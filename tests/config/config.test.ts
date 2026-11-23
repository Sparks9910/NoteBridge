import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/infrastructure/config.ts';

describe('L0 配置校验与生产门禁 (config.ts)', () => {
  it('未传任何环境变量时应使用契约默认值', () => {
    const config = loadConfig({});
    expect(config).toEqual({
      appEnv: 'development',
      enableDemoMode: false,
      defaultBpm: 90,
      audioLookaheadMs: 100,
      storageNamespace: 'notebridge_v1',
    });
  });

  it('开发环境与测试环境允许显式开启演示模式', () => {
    const devConfig = loadConfig({
      VITE_APP_ENV: 'development',
      VITE_ENABLE_DEMO_MODE: 'true',
    });
    expect(devConfig.enableDemoMode).toBe(true);

    const testConfig = loadConfig({
      VITE_APP_ENV: 'test',
      VITE_ENABLE_DEMO_MODE: 'true',
    });
    expect(testConfig.enableDemoMode).toBe(true);
  });

  it('生产环境默认关闭演示模式时应正常通过', () => {
    const prodConfig = loadConfig({
      VITE_APP_ENV: 'production',
      VITE_ENABLE_DEMO_MODE: 'false',
    });
    expect(prodConfig.appEnv).toBe('production');
    expect(prodConfig.enableDemoMode).toBe(false);
  });

  it('生产环境开启演示开关时必须立即抛出 CONFIG_INVALID', () => {
    expect(() =>
      loadConfig({
        VITE_APP_ENV: 'production',
        VITE_ENABLE_DEMO_MODE: 'true',
      })
    ).toThrowError(ConfigError);

    try {
      loadConfig({
        VITE_APP_ENV: 'production',
        VITE_ENABLE_DEMO_MODE: 'true',
      });
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const configErr = err as ConfigError;
      expect(configErr.appError.code).toBe('CONFIG_INVALID');
      expect(configErr.appError.field).toBe('VITE_ENABLE_DEMO_MODE');
      expect(configErr.appError.detail).toContain('生产环境');
    }
  });

  it('VITE_APP_ENV 非法值应抛出 CONFIG_INVALID', () => {
    expect(() => loadConfig({ VITE_APP_ENV: 'staging' })).toThrowError(
      ConfigError
    );
  });

  it('VITE_ENABLE_DEMO_MODE 非布尔字符串应抛出 CONFIG_INVALID', () => {
    expect(() => loadConfig({ VITE_ENABLE_DEMO_MODE: 'yes' })).toThrowError(
      ConfigError
    );
    expect(() => loadConfig({ VITE_ENABLE_DEMO_MODE: '' })).toThrowError(
      ConfigError
    );
  });

  it('VITE_DEFAULT_BPM 边界与非法值校验（40..200 整数）', () => {
    expect(loadConfig({ VITE_DEFAULT_BPM: '40' }).defaultBpm).toBe(40);
    expect(loadConfig({ VITE_DEFAULT_BPM: '200' }).defaultBpm).toBe(200);

    expect(() => loadConfig({ VITE_DEFAULT_BPM: '39' })).toThrowError(
      ConfigError
    );
    expect(() => loadConfig({ VITE_DEFAULT_BPM: '201' })).toThrowError(
      ConfigError
    );
    expect(() => loadConfig({ VITE_DEFAULT_BPM: '90.5' })).toThrowError(
      ConfigError
    );
    expect(() => loadConfig({ VITE_DEFAULT_BPM: 'abc' })).toThrowError(
      ConfigError
    );
  });

  it('VITE_AUDIO_LOOKAHEAD_MS 边界与非法值校验（25..200 整数）', () => {
    expect(
      loadConfig({ VITE_AUDIO_LOOKAHEAD_MS: '25' }).audioLookaheadMs
    ).toBe(25);
    expect(
      loadConfig({ VITE_AUDIO_LOOKAHEAD_MS: '200' }).audioLookaheadMs
    ).toBe(200);

    expect(() =>
      loadConfig({ VITE_AUDIO_LOOKAHEAD_MS: '24' })
    ).toThrowError(ConfigError);
    expect(() =>
      loadConfig({ VITE_AUDIO_LOOKAHEAD_MS: '201' })
    ).toThrowError(ConfigError);
    expect(() =>
      loadConfig({ VITE_AUDIO_LOOKAHEAD_MS: '100.5' })
    ).toThrowError(ConfigError);
  });

  it('VITE_STORAGE_NAMESPACE 空字符串或纯空白应抛出 CONFIG_INVALID', () => {
    expect(() => loadConfig({ VITE_STORAGE_NAMESPACE: '' })).toThrowError(
      ConfigError
    );
    expect(() => loadConfig({ VITE_STORAGE_NAMESPACE: '   ' })).toThrowError(
      ConfigError
    );
  });
});
