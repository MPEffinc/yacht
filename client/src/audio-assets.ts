export const AUDIO_CATEGORIES = ["BGM", "DICE", "UI", "SYSTEM"] as const;

export type AudioCategory = (typeof AUDIO_CATEGORIES)[number];
export type AudioPriority = "low" | "normal" | "high";

export interface AudioAssetDefinition {
  readonly url: string;
  readonly category: AudioCategory;
  readonly loop?: boolean;
  readonly gain?: number;
  readonly priority?: AudioPriority;
}

// Static URL construction lets Vite fingerprint every file and prepend /yacht/.
export const AUDIO_ASSETS = {
  bgm_lobby: { url: new URL("./audio/bgm_lobby.mp3", import.meta.url).href, category: "BGM", loop: true },
  bgm_main: { url: new URL("./audio/bgm_main.mp3", import.meta.url).href, category: "BGM", loop: true },

  dice_shake_01: { url: new URL("./audio/dice/dice-shake-1.ogg", import.meta.url).href, category: "DICE", gain: .72 },
  dice_shake_02: { url: new URL("./audio/dice/dice-shake-2.ogg", import.meta.url).href, category: "DICE", gain: .72 },
  dice_shake_03: { url: new URL("./audio/dice/dice-shake-3.ogg", import.meta.url).href, category: "DICE", gain: .72 },
  dice_throw_01: { url: new URL("./audio/dice/dice-throw-1.ogg", import.meta.url).href, category: "DICE", gain: .88 },
  dice_throw_02: { url: new URL("./audio/dice/dice-throw-2.ogg", import.meta.url).href, category: "DICE", gain: .88 },
  dice_throw_03: { url: new URL("./audio/dice/dice-throw-3.ogg", import.meta.url).href, category: "DICE", gain: .88 },

  alert_normal_combination: { url: new URL("./audio/system/alert_normal_combination.mp3", import.meta.url).href, category: "SYSTEM", gain: .62 },
  alert_special_combination: { url: new URL("./audio/system/alert_special_combination.mp3", import.meta.url).href, category: "SYSTEM", gain: .72 },
  alert_yacht: { url: new URL("./audio/system/alert_yacht.mp3", import.meta.url).href, category: "SYSTEM", gain: .8, priority: "high" },
  write_score_alert: { url: new URL("./audio/system/write_score_alert.mp3", import.meta.url).href, category: "SYSTEM", gain: .62 },
  write_score_pencil: { url: new URL("./audio/system/write_score_pencil.mp3", import.meta.url).href, category: "SYSTEM", gain: .56 },
  player_in: { url: new URL("./audio/system/player_in.ogg", import.meta.url).href, category: "SYSTEM" },
  game_start: { url: new URL("./audio/system/game_start.ogg", import.meta.url).href, category: "SYSTEM", priority: "high" },
  victory: { url: new URL("./audio/system/victory.mp3", import.meta.url).href, category: "SYSTEM", gain: .76, priority: "high" },
  ui_hover: { url: new URL("./audio/system/ui_hovering.ogg", import.meta.url).href, category: "UI", gain: .42, priority: "low" },
  ready_off: { url: new URL("./audio/system/ready_off.ogg", import.meta.url).href, category: "SYSTEM" },
  ready_on: { url: new URL("./audio/system/ready_on.ogg", import.meta.url).href, category: "SYSTEM" },
  your_turn: { url: new URL("./audio/system/your_turn_alert.mp3", import.meta.url).href, category: "SYSTEM", gain: .82, priority: "high" },
  lose_restart: { url: new URL("./audio/system/Lose_restart.mp3", import.meta.url).href, category: "SYSTEM", gain: .72, priority: "high" },
  subtle_click: { url: new URL("./audio/system/click_002.ogg", import.meta.url).href, category: "UI", gain: .66, priority: "low" },
  error: { url: new URL("./audio/system/error_001.ogg", import.meta.url).href, category: "SYSTEM", priority: "high" },
} as const satisfies Record<string, AudioAssetDefinition>;

export type AudioId = keyof typeof AUDIO_ASSETS;
export type BgmId = {
  [Id in AudioId]: (typeof AUDIO_ASSETS)[Id]["category"] extends "BGM" ? Id : never;
}[AudioId];

export const AUDIO_POOLS = {
  diceShake: ["dice_shake_01", "dice_shake_02", "dice_shake_03"],
  diceThrow: ["dice_throw_01", "dice_throw_02", "dice_throw_03"],
} as const satisfies Record<string, readonly AudioId[]>;

export type AudioPoolId = keyof typeof AUDIO_POOLS;

export const DEFAULT_AUDIO_VOLUMES: Readonly<Record<AudioCategory, number>> = {
  BGM: .22,
  DICE: .55,
  UI: .3,
  SYSTEM: .6,
};
