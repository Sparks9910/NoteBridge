import { createAppError } from '../../domain/state-machines.ts';
import type { Result } from '../../domain/types.ts';
import { validateScoreDocumentV2 } from '../../domain/v2-serializer.ts';
import type { ScoreDocumentV2 } from '../../domain/v2-types.ts';
import {
  importMusicXmlToScoreV2,
  importMxlToScoreV2,
} from '../codecs/musicxml-codec.ts';

export type OmrProviderType = 'local-bridge' | 'custom-endpoint';

export const DEFAULT_LOCAL_OMR_ENDPOINT = 'http://127.0.0.1:8765';
const MAX_OMR_FILE_BYTES = 20 * 1024 * 1024;
const ALLOWED_OMR_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'application/pdf',
]);

export interface OmrProviderConfig {
  providerType: OmrProviderType;
  endpointUrl: string;
  apiKey?: string;
  timeoutMs?: number;
}

export interface OmrRecognizeOptions {
  title?: string;
  nowMs?: number;
}

export interface OmrFileInput {
  name: string;
  mimeType: string;
  data: Uint8Array;
}

export interface OmrHealthStatus {
  available: boolean;
  providerId: string;
  endpointUrl: string;
  engineVersion?: string;
  message: string;
}

export interface OmrProvider {
  readonly id: string;
  readonly label: string;
  checkHealth(): Promise<OmrHealthStatus>;
  recognizeScore(
    file: OmrFileInput,
    options?: OmrRecognizeOptions
  ): Promise<Result<ScoreDocumentV2>>;
}

export type FetchLike = typeof fetch;

function normalizeEndpointUrl(raw: string): Result<string> {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) {
    return {
      ok: false,
      error: createAppError(
        'CONFIG_INVALID',
        '请先配置本地 OMR 服务地址（例如 http://127.0.0.1:8765）或使用“仅载入为原谱对照”',
        'endpointUrl'
      ),
    };
  }
  if (!/^https?:\/\/.+/i.test(trimmed)) {
    return {
      ok: false,
      error: createAppError(
        'CONFIG_INVALID',
        'OMR 服务地址必须以 http:// 或 https:// 开头',
        'endpointUrl'
      ),
    };
  }
  return { ok: true, value: trimmed };
}

function validateOmrFile(file: OmrFileInput): Result<void> {
  if (!(file.data instanceof Uint8Array) || file.data.byteLength === 0) {
    return {
      ok: false,
      error: createAppError(
        'STORAGE_SCHEMA_CORRUPTED',
        '请选择有效的图片或 PDF 乐谱文件后再执行转谱'
      ),
    };
  }
  if (file.data.byteLength > MAX_OMR_FILE_BYTES) {
    return {
      ok: false,
      error: createAppError(
        'STORAGE_QUOTA_EXCEEDED',
        '原谱文件大小超出 20MB 限制，请压缩或分页裁剪后再试'
      ),
    };
  }
  const mime = file.mimeType.toLowerCase();
  const lowerName = file.name.toLowerCase();
  const extOk = /\.(png|jpe?g|webp|pdf)$/.test(lowerName);
  if (!ALLOWED_OMR_MIMES.has(mime) && !extOk) {
    return {
      ok: false,
      error: createAppError(
        'STORAGE_SCHEMA_CORRUPTED',
        'OMR 智能转谱仅支持 PNG、JPG、WebP 图片或 PDF 乐谱文件'
      ),
    };
  }
  return { ok: true, value: undefined };
}

function stripExt(name: string): string {
  return name.replace(/\.[^.]+$/, '').trim() || '智能转谱乐谱';
}

export class HttpOmrBridgeProvider implements OmrProvider {
  public readonly id: string;
  public readonly label: string;
  private readonly config: OmrProviderConfig;
  private readonly fetchFn: FetchLike;

  constructor(config: OmrProviderConfig, fetchFn?: FetchLike) {
    this.config = config;
    this.id = config.providerType;
    this.label =
      config.providerType === 'local-bridge'
        ? '本地开源 OMR 桥接（Audiveris / Homr）'
        : '自定义远程 OMR 端点';
    this.fetchFn = fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  public async checkHealth(): Promise<OmrHealthStatus> {
    const urlRes = normalizeEndpointUrl(this.config.endpointUrl);
    if (!urlRes.ok) {
      return {
        available: false,
        providerId: this.id,
        endpointUrl: this.config.endpointUrl,
        message: urlRes.error.detail,
      };
    }

    const timeoutMs = this.config.timeoutMs ?? 4000;
    const controller = new AbortController();
    const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);

    try {
      const headers: Record<string, string> = {};
      if (this.config.apiKey?.trim()) {
        headers.Authorization = `Bearer ${this.config.apiKey.trim()}`;
      }
      const res = await this.fetchFn(`${urlRes.value}/health`, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });

      if (!res.ok) {
        return {
          available: false,
          providerId: this.id,
          endpointUrl: urlRes.value,
          message: `OMR 服务响应异常（状态码 ${res.status}），可先点击“仅载入为原谱对照”手动录入`,
        };
      }

      let engineVersion: string | undefined;
      try {
        const json = (await res.json()) as {
          available?: boolean;
          engineVersion?: string;
          engine?: string;
        };
        engineVersion = json.engineVersion ?? json.engine;
        if (json.available === false) {
          return {
            available: false,
            providerId: this.id,
            endpointUrl: urlRes.value,
            engineVersion,
            message: 'OMR 服务当前尚未就绪，请检查本地识谱引擎进程状态',
          };
        }
      } catch {
        // 允许纯 200 OK 文本响应
      }

      return {
        available: true,
        providerId: this.id,
        endpointUrl: urlRes.value,
        engineVersion,
        message: engineVersion
          ? `已连接 OMR 识谱引擎（${engineVersion}）`
          : '已连接本地 OMR 识谱服务',
      };
    } catch {
      return {
        available: false,
        providerId: this.id,
        endpointUrl: urlRes.value,
        message:
          '未检测到本地 OMR 识谱服务（请启动 Audiveris/Homr HTTP 桥接，或点击“仅载入为原谱对照”进行人工对照制谱）',
      };
    } finally {
      globalThis.clearTimeout(timer);
    }
  }

  public async recognizeScore(
    file: OmrFileInput,
    options?: OmrRecognizeOptions
  ): Promise<Result<ScoreDocumentV2>> {
    const urlRes = normalizeEndpointUrl(this.config.endpointUrl);
    if (!urlRes.ok) {
      return urlRes;
    }

    const fileCheck = validateOmrFile(file);
    if (!fileCheck.ok) {
      return fileCheck;
    }

    const timeoutMs = this.config.timeoutMs ?? 20000;
    const controller = new AbortController();
    const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);

    try {
      const form = new FormData();
      const blob = new Blob([new Uint8Array(file.data)], {
        type: file.mimeType || 'application/octet-stream',
      });
      form.append('file', blob, file.name);
      form.append('filename', file.name);
      form.append('provider', this.id);

      const headers: Record<string, string> = {};
      if (this.config.apiKey?.trim()) {
        headers.Authorization = `Bearer ${this.config.apiKey.trim()}`;
      }

      const res = await this.fetchFn(`${urlRes.value}/recognize`, {
        method: 'POST',
        headers,
        body: form,
        signal: controller.signal,
      });

      if (res.status === 401) {
        return {
          ok: false,
          error: createAppError(
            'AUTH_UNAUTHORIZED',
            'OMR 服务鉴权失败，请检查配置的访问密钥是否正确'
          ),
        };
      }
      if (res.status === 403) {
        return {
          ok: false,
          error: createAppError(
            'AUTH_FORBIDDEN',
            '当前密钥无权调用该 OMR 识谱服务，请检查服务端授权设置'
          ),
        };
      }
      if (!res.ok) {
        return {
          ok: false,
          error: createAppError(
            'RESOURCE_NOT_FOUND',
            `OMR 识谱服务返回错误（状态码 ${res.status}），可点击“仅载入为原谱对照”手动照谱录入`
          ),
        };
      }

      const title = options?.title?.trim() || stripExt(file.name);
      const nowMs = options?.nowMs ?? Date.now();
      const contentType = (res.headers.get('content-type') ?? '').toLowerCase();

      if (
        (!contentType.includes('+xml') &&
          contentType.includes('application/vnd.recordare.musicxml')) ||
        contentType.includes('application/zip')
      ) {
        const bytes = new Uint8Array(await res.arrayBuffer());
        return importMxlToScoreV2(bytes, { title, nowMs });
      }

      if (contentType.includes('application/json')) {
        const payload = (await res.json()) as {
          musicxml?: unknown;
          score?: unknown;
          schemaVersion?: unknown;
          detail?: unknown;
        };
        if (typeof payload.musicxml === 'string') {
          return importMusicXmlToScoreV2(payload.musicxml, { title, nowMs });
        }
        const candidate = payload.score ?? (payload.schemaVersion === 2 ? payload : null);
        if (candidate) {
          return validateScoreDocumentV2(candidate);
        }
        return {
          ok: false,
          error: createAppError(
            'STORAGE_SCHEMA_CORRUPTED',
            typeof payload.detail === 'string' && /[\u4e00-\u9fa5]/.test(payload.detail)
              ? payload.detail
              : 'OMR 服务返回的 JSON 数据缺少有效的乐谱内容'
          ),
        };
      }

      const rawText = await res.text();
      if (rawText.trimStart().startsWith('{')) {
        try {
          const parsed = JSON.parse(rawText) as {
            musicxml?: unknown;
            score?: unknown;
            schemaVersion?: unknown;
          };
          if (typeof parsed.musicxml === 'string') {
            return importMusicXmlToScoreV2(parsed.musicxml, { title, nowMs });
          }
          if (parsed.score || parsed.schemaVersion === 2) {
            return validateScoreDocumentV2(parsed.score ?? parsed);
          }
        } catch {
          // 继续尝试 XML 解析
        }
      }

      return importMusicXmlToScoreV2(rawText, { title, nowMs });
    } catch {
      return {
        ok: false,
        error: createAppError(
          'RESOURCE_NOT_FOUND',
          '无法连接 OMR 识谱服务，请确认本地 Audiveris/Homr 桥接服务已启动，或点击“仅载入为原谱对照”手动照谱录入'
        ),
      };
    } finally {
      globalThis.clearTimeout(timer);
    }
  }
}

export class OmrProviderRegistry {
  private readonly factories = new Map<
    OmrProviderType,
    (config: OmrProviderConfig, fetchFn?: FetchLike) => OmrProvider
  >();

  public register(
    type: OmrProviderType,
    factory: (config: OmrProviderConfig, fetchFn?: FetchLike) => OmrProvider
  ): void {
    this.factories.set(type, factory);
  }

  public create(config: OmrProviderConfig, fetchFn?: FetchLike): OmrProvider {
    const factory = this.factories.get(config.providerType);
    if (factory) {
      return factory(config, fetchFn);
    }
    return new HttpOmrBridgeProvider(config, fetchFn);
  }
}

export const omrProviderRegistry = new OmrProviderRegistry();
omrProviderRegistry.register(
  'local-bridge',
  (cfg, fetchFn) => new HttpOmrBridgeProvider(cfg, fetchFn)
);
omrProviderRegistry.register(
  'custom-endpoint',
  (cfg, fetchFn) => new HttpOmrBridgeProvider(cfg, fetchFn)
);

export function createOmrProvider(
  config: OmrProviderConfig,
  fetchFn?: FetchLike
): OmrProvider {
  return omrProviderRegistry.create(config, fetchFn);
}
