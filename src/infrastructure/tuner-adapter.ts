import { createAppError } from '../domain/state-machines.ts';
import type { Result } from '../domain/types.ts';

export interface TunerAdapter {
  start(
    onSamples: (samples: Float32Array, sampleRate: number) => void
  ): Promise<Result<void>>;
  stop(): void;
  isRunning(): boolean;
}

export function generateSineWaveBuffer(
  frequencyHz: number,
  sampleRate = 44100,
  length = 4096,
  amplitude = 0.6
): Float32Array {
  const out = new Float32Array(length);
  if (!Number.isFinite(frequencyHz) || frequencyHz <= 0 || sampleRate <= 0) {
    return out;
  }
  const omega = (2 * Math.PI * frequencyHz) / sampleRate;
  for (let i = 0; i < length; i += 1) {
    out[i] = amplitude * Math.sin(omega * i);
  }
  return out;
}

function mapMicrophoneErrorToAppError(err: unknown) {
  const name =
    typeof err === 'object' && err !== null && 'name' in err
      ? String((err as { name?: unknown }).name ?? '')
      : '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return createAppError(
      'AUTH_FORBIDDEN',
      '麦克风访问权限被拒绝，请在浏览器地址栏允许麦克风权限后重试'
    );
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return createAppError(
      'RESOURCE_NOT_FOUND',
      '未检测到可用麦克风设备，请接入麦克风或使用标准音按钮手动校音'
    );
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return createAppError(
      'AUDIO_CONTEXT_BLOCKED',
      '麦克风正被其他程序占用，请关闭占用后重试调音器'
    );
  }
  return createAppError(
    'AUDIO_CONTEXT_BLOCKED',
    '无法启动浏览器麦克风采集，请确认运行在安全上下文（localhost / HTTPS）后重试'
  );
}

/**
 * 浏览器真实麦克风采集适配器（getUserMedia + AudioContext + AnalyserNode）。
 */
export class WebMicrophoneTunerAdapter implements TunerAdapter {
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private stream: MediaStream | null = null;
  private rafId: number | null = null;
  private buffer: Float32Array<ArrayBuffer> | null = null;
  private running = false;

  public isRunning(): boolean {
    return this.running;
  }

  public async start(
    onSamples: (samples: Float32Array, sampleRate: number) => void
  ): Promise<Result<void>> {
    this.stop();

    const nav = typeof globalThis !== 'undefined' ? globalThis.navigator : undefined;
    if (!nav?.mediaDevices || typeof nav.mediaDevices.getUserMedia !== 'function') {
      return {
        ok: false,
        error: createAppError(
          'AUDIO_CONTEXT_BLOCKED',
          '当前浏览器环境不支持麦克风采集接口，请使用标准音参考或更换现代浏览器'
        ),
      };
    }

    const AudioCtxCtor =
      globalThis.AudioContext ??
      (globalThis as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (typeof AudioCtxCtor !== 'function') {
      return {
        ok: false,
        error: createAppError(
          'AUDIO_CONTEXT_BLOCKED',
          '当前运行环境缺少 Web Audio 上下文支持，无法启动调音器'
        ),
      };
    }

    try {
      const stream = await nav.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      const ctx = new AudioCtxCtor();
      if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
        await ctx.resume();
      }
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 4096;
      source.connect(analyser);

      this.stream = stream;
      this.audioContext = ctx;
      this.sourceNode = source;
      this.analyser = analyser;
      this.buffer = new Float32Array(new ArrayBuffer(analyser.fftSize * 4));
      this.running = true;

      const tick = () => {
        if (!this.running || !this.analyser || !this.audioContext || !this.buffer) {
          return;
        }
        this.analyser.getFloatTimeDomainData(this.buffer);
        onSamples(this.buffer, this.audioContext.sampleRate);
        if (typeof globalThis.requestAnimationFrame === 'function') {
          this.rafId = globalThis.requestAnimationFrame(tick);
        }
      };
      if (typeof globalThis.requestAnimationFrame === 'function') {
        this.rafId = globalThis.requestAnimationFrame(tick);
      }

      return { ok: true, value: undefined };
    } catch (err) {
      this.stop();
      return {
        ok: false,
        error: mapMicrophoneErrorToAppError(err),
      };
    }
  }

  public stop(): void {
    this.running = false;
    if (
      this.rafId !== null &&
      typeof globalThis.cancelAnimationFrame === 'function'
    ) {
      globalThis.cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    try {
      this.sourceNode?.disconnect();
    } catch {
      // 忽略断开阶段异常
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        try {
          track.stop();
        } catch {
          // 忽略轨道停止异常
        }
      }
    }
    if (this.audioContext) {
      void this.audioContext.close().catch(() => {});
    }
    this.sourceNode = null;
    this.analyser = null;
    this.stream = null;
    this.audioContext = null;
    this.buffer = null;
  }
}

export type MockTunerFailMode = 'denied' | 'no-device' | 'blocked' | null;

/**
 * 可控模拟调音器采集适配器，供 L2 服务测试注入固定频率波形或模拟权限错误。
 */
export class MockTunerAdapter implements TunerAdapter {
  public failMode: MockTunerFailMode;
  private running = false;
  private listener: ((samples: Float32Array, sampleRate: number) => void) | null =
    null;

  constructor(options?: { failMode?: MockTunerFailMode }) {
    this.failMode = options?.failMode ?? null;
  }

  public isRunning(): boolean {
    return this.running;
  }

  public async start(
    onSamples: (samples: Float32Array, sampleRate: number) => void
  ): Promise<Result<void>> {
    if (this.failMode === 'denied') {
      return {
        ok: false,
        error: createAppError(
          'AUTH_FORBIDDEN',
          '麦克风访问权限被拒绝，请在浏览器设置中允许麦克风访问'
        ),
      };
    }
    if (this.failMode === 'no-device') {
      return {
        ok: false,
        error: createAppError(
          'RESOURCE_NOT_FOUND',
          '未检测到可用麦克风输入设备，请连接后重试'
        ),
      };
    }
    if (this.failMode === 'blocked') {
      return {
        ok: false,
        error: createAppError(
          'AUDIO_CONTEXT_BLOCKED',
          '音频上下文启动失败，请点击页面按钮后重试'
        ),
      };
    }
    this.running = true;
    this.listener = onSamples;
    return { ok: true, value: undefined };
  }

  public emitSamples(samples: Float32Array, sampleRate = 44100): void {
    if (!this.running || !this.listener) {
      return;
    }
    this.listener(samples, sampleRate);
  }

  public emitFrequency(
    frequencyHz: number,
    sampleRate = 44100,
    length = 4096
  ): void {
    this.emitSamples(
      generateSineWaveBuffer(frequencyHz, sampleRate, length),
      sampleRate
    );
  }

  public stop(): void {
    this.running = false;
    this.listener = null;
  }
}
