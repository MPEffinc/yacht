import {
  AUDIO_ASSETS,
  AUDIO_CATEGORIES,
  AUDIO_POOLS,
  DEFAULT_AUDIO_VOLUMES,
  type AudioAssetDefinition,
  type AudioCategory,
  type AudioId,
  type AudioPoolId,
  type AudioPriority,
  type BgmId,
} from "./audio-assets";

export const AUDIO_STORAGE_KEY = "yacht.audio.preferences.v1";
const MAX_CONCURRENT_SFX = 5;
const MAX_DEDUPE_KEYS = 512;

export interface AudioPreferences {
  readonly bgmMuted: boolean;
  readonly sfxMuted: boolean;
  readonly sfxVolume: number;
  readonly volumes: Readonly<Record<AudioCategory, number>>;
}

export interface AudioManagerSnapshot extends AudioPreferences {
  readonly unlocked: boolean;
  readonly currentBgm: BgmId | null;
}

export interface PlayOptions {
  readonly category?: AudioCategory;
  readonly dedupeKey?: string;
  readonly priority?: AudioPriority;
  readonly gain?: number;
  readonly maxDurationMs?: number;
  readonly fadeOutMs?: number;
}

export interface BgmOptions {
  readonly fadeMs?: number;
}

export interface DuckOptions {
  readonly level?: number;
  readonly fadeMs?: number;
}

interface ActiveSfx {
  readonly source: AudioBufferSourceNode;
  readonly priority: AudioPriority;
}

interface ActiveBgm {
  readonly id: BgmId;
  readonly source: AudioBufferSourceNode;
  readonly gain: GainNode;
}

type WebkitWindow = Window & typeof globalThis & {
  webkitAudioContext?: typeof AudioContext;
};

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : minimum));
}

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readPreferences(): AudioPreferences {
  const fallback: AudioPreferences = {
    bgmMuted: false,
    sfxMuted: false,
    sfxVolume: 1,
    volumes: { ...DEFAULT_AUDIO_VOLUMES },
  };
  try {
    const raw = storage()?.getItem(AUDIO_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<AudioPreferences>;
    const suppliedVolumes = parsed.volumes ?? {};
    const volumes = Object.fromEntries(
      AUDIO_CATEGORIES.map((category) => [
        category,
        clamp(Number((suppliedVolumes as Partial<Record<AudioCategory, number>>)[category]
          ?? DEFAULT_AUDIO_VOLUMES[category])),
      ]),
    ) as Record<AudioCategory, number>;
    return {
      bgmMuted: parsed.bgmMuted === true,
      sfxMuted: parsed.sfxMuted === true,
      sfxVolume: clamp(Number(parsed.sfxVolume ?? 1)),
      volumes,
    };
  } catch {
    return fallback;
  }
}

function presentationalRandom(): number {
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const value = new Uint32Array(1);
    crypto.getRandomValues(value);
    return value[0] / 0x1_0000_0000;
  }
  return Math.random();
}

/** Presentation-only selection. It never reads or advances the server dice RNG. */
export function chooseAudioPoolSample(
  samples: readonly AudioId[],
  previous: AudioId | undefined,
  random = presentationalRandom,
): AudioId | null {
  if (samples.length === 0) return null;
  const candidates = samples.length > 1 && previous
    ? samples.filter((sample) => sample !== previous)
    : samples;
  const index = Math.min(
    candidates.length - 1,
    Math.floor(clamp(random(), 0, .999999999) * candidates.length),
  );
  return candidates[index] ?? null;
}

export class AudioManager {
  private context: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private readonly categoryGains = new Map<AudioCategory, GainNode>();
  private readonly encodedBuffers = new Map<AudioId, ArrayBuffer>();
  private readonly decodedBuffers = new Map<AudioId, AudioBuffer>();
  private readonly pendingFetches = new Map<AudioId, Promise<ArrayBuffer | null>>();
  private readonly pendingDecodes = new Map<AudioId, Promise<AudioBuffer | null>>();
  private readonly activeSfx = new Set<ActiveSfx>();
  private readonly lastPoolSample = new Map<string, AudioId>();
  private readonly dedupeKeys = new Set<string>();
  private readonly dedupeOrder: string[] = [];
  private readonly duckRequests = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private preferences = readPreferences();
  private snapshot: AudioManagerSnapshot = {
    ...this.preferences,
    volumes: { ...this.preferences.volumes },
    unlocked: false,
    currentBgm: null,
  };
  private unlocked = false;
  private desiredBgm: BgmId | null = null;
  private activeBgm: ActiveBgm | null = null;
  private bgmGeneration = 0;

  /** Must run from a real gesture. Safe to call repeatedly, including Safari/iOS. */
  async unlock(): Promise<boolean> {
    const context = this.ensureContext();
    if (!context) return false;
    try {
      if (context.state === "suspended") await context.resume();
      if (context.state !== "running") return false;

      const source = context.createBufferSource();
      const gain = context.createGain();
      gain.gain.value = 0;
      source.buffer = context.createBuffer(1, 1, context.sampleRate);
      source.connect(gain);
      gain.connect(this.masterGain!);
      source.start();

      if (!this.unlocked) {
        this.unlocked = true;
        this.refreshSnapshot();
      }
      if (this.desiredBgm && this.activeBgm?.id !== this.desiredBgm) {
        void this.startBgm(this.desiredBgm, 450);
      }
      return true;
    } catch {
      return false;
    }
  }

  async preload(ids: readonly AudioId[] = Object.keys(AUDIO_ASSETS) as AudioId[]): Promise<void> {
    await Promise.allSettled(ids.map(async (id) => {
      await this.fetchEncoded(id);
      if (this.context) await this.loadBuffer(id);
    }));
  }

  async playSfx(id: AudioId, options: PlayOptions = {}): Promise<boolean> {
    if (!this.claimDedupe(options.dedupeKey)) return false;
    const asset = AUDIO_ASSETS[id] as AudioAssetDefinition;
    const category = options.category ?? asset.category;
    if (category === "BGM" || !this.unlocked || !this.context || !this.masterGain) return false;
    if (this.preferences.sfxMuted) return false;

    const priority = options.priority ?? asset.priority ?? "normal";
    const highIsPlaying = [...this.activeSfx].some((entry) => entry.priority === "high");
    if (priority === "low" && highIsPlaying) return false;
    if (priority !== "high" && this.activeSfx.size >= MAX_CONCURRENT_SFX) return false;

    const buffer = await this.loadBuffer(id);
    if (!buffer || !this.unlocked || !this.context || this.preferences.sfxMuted) return false;
    if (priority === "high") {
      this.stopLowPrioritySfx();
      if (this.activeSfx.size >= MAX_CONCURRENT_SFX) this.stopOldestSfx();
    } else {
      const highStartedWhileLoading = [...this.activeSfx].some((entry) => entry.priority === "high");
      if ((priority === "low" && highStartedWhileLoading) || this.activeSfx.size >= MAX_CONCURRENT_SFX) return false;
    }

    try {
      const context = this.context;
      const source = context.createBufferSource();
      const gain = context.createGain();
      const categoryGain = this.categoryGains.get(category);
      if (!categoryGain) return false;
      const initialGain = clamp((asset.gain ?? 1) * (options.gain ?? 1), 0, 2);
      const now = context.currentTime;
      const requestedDuration = options.maxDurationMs === undefined
        ? buffer.duration
        : Math.max(0, options.maxDurationMs / 1_000);
      const duration = Math.min(buffer.duration, requestedDuration);
      if (duration <= 0) return false;
      const fadeSeconds = Math.min(duration, Math.max(0, options.fadeOutMs ?? 0) / 1_000);

      gain.gain.setValueAtTime(initialGain, now);
      if (fadeSeconds > 0) {
        gain.gain.setValueAtTime(initialGain, now + duration - fadeSeconds);
        gain.gain.linearRampToValueAtTime(0, now + duration);
      }
      source.buffer = buffer;
      source.connect(gain);
      gain.connect(categoryGain);
      const active: ActiveSfx = { source, priority };
      this.activeSfx.add(active);
      source.onended = () => this.activeSfx.delete(active);
      if (options.maxDurationMs === undefined) source.start(now);
      else source.start(now, 0, duration);
      return true;
    } catch {
      return false;
    }
  }

  async playRandom(
    pool: AudioPoolId | readonly AudioId[],
    options: PlayOptions = {},
  ): Promise<AudioId | null> {
    const samples = typeof pool === "string" ? AUDIO_POOLS[pool] : pool;
    const poolKey = typeof pool === "string" ? pool : samples.join("|");
    const selected = chooseAudioPoolSample(samples, this.lastPoolSample.get(poolKey));
    if (!selected) return null;
    this.lastPoolSample.set(poolKey, selected);
    return (await this.playSfx(selected, options)) ? selected : null;
  }

  async playBgm(id: BgmId, options: BgmOptions = {}): Promise<boolean> {
    this.desiredBgm = id;
    if (!this.unlocked || !this.context) return false;
    if (this.activeBgm?.id === id) return true;
    return this.startBgm(id, options.fadeMs ?? 650);
  }

  crossfadeBgm(id: BgmId, durationMs = 650): Promise<boolean> {
    return this.playBgm(id, { fadeMs: durationMs });
  }

  stopBgm(options: BgmOptions | number = {}): void {
    this.desiredBgm = null;
    this.bgmGeneration += 1;
    const fadeMs = typeof options === "number" ? options : (options.fadeMs ?? 350);
    const active = this.activeBgm;
    this.activeBgm = null;
    if (active && this.context) this.fadeAndStop(active, fadeMs);
    this.refreshSnapshot();
  }

  duckBgm(key = "default", options: DuckOptions = {}): void {
    this.duckRequests.set(key, clamp(options.level ?? .38));
    this.applyBgmBusGain(options.fadeMs ?? 160);
  }

  restoreBgm(key = "default", fadeMs = 420): void {
    this.duckRequests.delete(key);
    this.applyBgmBusGain(fadeMs);
  }

  restoreAllBgmDucks(fadeMs = 420): void {
    this.duckRequests.clear();
    this.applyBgmBusGain(fadeMs);
  }

  getPreferences(): AudioPreferences {
    return { ...this.preferences, volumes: { ...this.preferences.volumes } };
  }

  getSnapshot = (): AudioManagerSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setBgmMuted(muted = !this.preferences.bgmMuted): void {
    if (muted === this.preferences.bgmMuted) return;
    this.preferences = { ...this.preferences, bgmMuted: muted };
    this.persistPreferences();
    this.applyBgmBusGain(100);
    this.refreshSnapshot();
  }

  setSfxMuted(muted = !this.preferences.sfxMuted): void {
    if (muted === this.preferences.sfxMuted) return;
    this.preferences = { ...this.preferences, sfxMuted: muted };
    this.persistPreferences();
    this.applyCategoryGains();
    this.refreshSnapshot();
  }

  setSfxVolume(volume: number): void {
    const sfxVolume = clamp(volume);
    if (sfxVolume === this.preferences.sfxVolume) return;
    this.preferences = { ...this.preferences, sfxVolume };
    this.persistPreferences();
    this.applyCategoryGains();
    this.refreshSnapshot();
  }

  setVolume(category: AudioCategory, volume: number): void {
    const volumes = { ...this.preferences.volumes, [category]: clamp(volume) };
    this.preferences = { ...this.preferences, volumes };
    this.persistPreferences();
    this.applyCategoryGains();
    this.refreshSnapshot();
  }

  clearDedupeHistory(): void {
    this.dedupeKeys.clear();
    this.dedupeOrder.length = 0;
  }

  private ensureContext(): AudioContext | null {
    if (this.context) return this.context;
    if (typeof window === "undefined") return null;
    const audioWindow = window as WebkitWindow;
    const AudioContextConstructor = window.AudioContext ?? audioWindow.webkitAudioContext;
    if (!AudioContextConstructor) return null;
    try {
      const context = new AudioContextConstructor();
      const master = context.createGain();
      master.gain.value = 1;
      master.connect(context.destination);
      this.context = context;
      this.masterGain = master;
      for (const category of AUDIO_CATEGORIES) {
        const gain = context.createGain();
        gain.connect(master);
        this.categoryGains.set(category, gain);
      }
      this.applyCategoryGains();
      return context;
    } catch {
      return null;
    }
  }

  private async fetchEncoded(id: AudioId): Promise<ArrayBuffer | null> {
    const existing = this.encodedBuffers.get(id);
    if (existing) return existing;
    const pending = this.pendingFetches.get(id);
    if (pending) return pending;
    const request = (async () => {
      try {
        const response = await fetch((AUDIO_ASSETS[id] as AudioAssetDefinition).url);
        if (!response.ok) return null;
        const encoded = await response.arrayBuffer();
        this.encodedBuffers.set(id, encoded);
        return encoded;
      } catch {
        return null;
      } finally {
        this.pendingFetches.delete(id);
      }
    })();
    this.pendingFetches.set(id, request);
    return request;
  }

  private async loadBuffer(id: AudioId): Promise<AudioBuffer | null> {
    const existing = this.decodedBuffers.get(id);
    if (existing) return existing;
    const pending = this.pendingDecodes.get(id);
    if (pending) return pending;
    if (!this.context) return null;
    const request = (async () => {
      try {
        const encoded = await this.fetchEncoded(id);
        if (!encoded || !this.context) return null;
        const decoded = await this.context.decodeAudioData(encoded.slice(0));
        this.decodedBuffers.set(id, decoded);
        return decoded;
      } catch {
        return null;
      } finally {
        this.pendingDecodes.delete(id);
      }
    })();
    this.pendingDecodes.set(id, request);
    return request;
  }

  private async startBgm(id: BgmId, fadeMs: number): Promise<boolean> {
    const generation = ++this.bgmGeneration;
    const buffer = await this.loadBuffer(id);
    if (!buffer || !this.context || !this.unlocked || this.desiredBgm !== id || generation !== this.bgmGeneration) return false;
    try {
      const source = this.context.createBufferSource();
      const gain = this.context.createGain();
      const categoryGain = this.categoryGains.get("BGM");
      if (!categoryGain) return false;
      const now = this.context.currentTime;
      const seconds = Math.max(0, fadeMs) / 1_000;
      const asset = AUDIO_ASSETS[id] as AudioAssetDefinition;
      source.buffer = buffer;
      source.loop = asset.loop !== false;
      source.connect(gain);
      gain.connect(categoryGain);
      gain.gain.setValueAtTime(seconds > 0 ? 0 : (asset.gain ?? 1), now);
      if (seconds > 0) gain.gain.linearRampToValueAtTime(asset.gain ?? 1, now + seconds);
      source.start();

      const previous = this.activeBgm;
      this.activeBgm = { id, source, gain };
      if (previous) this.fadeAndStop(previous, fadeMs);
      this.refreshSnapshot();
      return true;
    } catch {
      return false;
    }
  }

  private fadeAndStop(active: ActiveBgm, fadeMs: number): void {
    if (!this.context) return;
    const now = this.context.currentTime;
    const seconds = Math.max(0, fadeMs) / 1_000;
    try {
      active.gain.gain.cancelScheduledValues(now);
      active.gain.gain.setValueAtTime(active.gain.gain.value, now);
      active.gain.gain.linearRampToValueAtTime(0, now + seconds);
      active.source.stop(now + seconds + .03);
    } catch {
      // Stopping an already-ended source is intentionally best-effort.
    }
  }

  private stopLowPrioritySfx(): void {
    for (const active of [...this.activeSfx]) {
      if (active.priority !== "low") continue;
      try { active.source.stop(); } catch { /* Already stopped. */ }
      this.activeSfx.delete(active);
    }
  }

  private stopOldestSfx(): void {
    const oldest = this.activeSfx.values().next().value as ActiveSfx | undefined;
    if (!oldest) return;
    try { oldest.source.stop(); } catch { /* Already stopped. */ }
    this.activeSfx.delete(oldest);
  }

  private applyCategoryGains(): void {
    for (const category of AUDIO_CATEGORIES) {
      const node = this.categoryGains.get(category);
      if (!node || category === "BGM") continue;
      node.gain.value = this.preferences.sfxMuted
        ? 0
        : this.preferences.volumes[category] * this.preferences.sfxVolume;
    }
    this.applyBgmBusGain(0);
  }

  private applyBgmBusGain(fadeMs: number): void {
    const node = this.categoryGains.get("BGM");
    if (!node || !this.context) return;
    const duck = this.duckRequests.size > 0 ? Math.min(...this.duckRequests.values()) : 1;
    const target = this.preferences.bgmMuted ? 0 : this.preferences.volumes.BGM * duck;
    const now = this.context.currentTime;
    node.gain.cancelScheduledValues(now);
    node.gain.setValueAtTime(node.gain.value, now);
    node.gain.linearRampToValueAtTime(target, now + Math.max(0, fadeMs) / 1_000);
  }

  private claimDedupe(key: string | undefined): boolean {
    if (!key) return true;
    if (this.dedupeKeys.has(key)) return false;
    this.dedupeKeys.add(key);
    this.dedupeOrder.push(key);
    if (this.dedupeOrder.length > MAX_DEDUPE_KEYS) {
      const expired = this.dedupeOrder.shift();
      if (expired) this.dedupeKeys.delete(expired);
    }
    return true;
  }

  private persistPreferences(): void {
    try { storage()?.setItem(AUDIO_STORAGE_KEY, JSON.stringify(this.preferences)); } catch {
      // Audio preferences are optional local UI state.
    }
  }

  private refreshSnapshot(): void {
    this.snapshot = {
      ...this.preferences,
      volumes: { ...this.preferences.volumes },
      unlocked: this.unlocked,
      currentBgm: this.activeBgm?.id ?? null,
    };
    for (const listener of this.listeners) listener();
  }
}

export const audioManager = new AudioManager();
