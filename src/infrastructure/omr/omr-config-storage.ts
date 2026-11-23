import {
  DEFAULT_LOCAL_OMR_ENDPOINT,
  type OmrProviderConfig,
} from './omr-provider.ts';

const OMR_CONFIG_STORAGE_KEY = 'notebridge:v2:omr-config';

export function loadOmrConfigFromStorage(): OmrProviderConfig {
  const fallback: OmrProviderConfig = {
    providerType: 'local-bridge',
    endpointUrl: DEFAULT_LOCAL_OMR_ENDPOINT,
    apiKey: '',
  };

  try {
    if (typeof globalThis.localStorage === 'undefined') {
      return fallback;
    }
    const raw = globalThis.localStorage.getItem(OMR_CONFIG_STORAGE_KEY);
    if (!raw) {
      return fallback;
    }
    const parsed = JSON.parse(raw) as Partial<OmrProviderConfig>;
    return {
      providerType:
        parsed.providerType === 'custom-endpoint'
          ? 'custom-endpoint'
          : 'local-bridge',
      endpointUrl:
        typeof parsed.endpointUrl === 'string'
          ? parsed.endpointUrl
          : DEFAULT_LOCAL_OMR_ENDPOINT,
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
    };
  } catch {
    return fallback;
  }
}

export function saveOmrConfigToStorage(config: OmrProviderConfig): void {
  try {
    if (typeof globalThis.localStorage === 'undefined') {
      return;
    }
    globalThis.localStorage.setItem(
      OMR_CONFIG_STORAGE_KEY,
      JSON.stringify({
        providerType: config.providerType,
        endpointUrl: config.endpointUrl,
        apiKey: config.apiKey ?? '',
      })
    );
  } catch {
    // 忽略存储配额或禁用 localStorage 导致的非致命异常
  }
}
