import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
} from "react";
import { audioManager } from "./audio-manager";
import {
  audioScene,
  finishedAudioAsset,
  isFinishTransition,
  isGameStartTransition,
  isRollTransition,
  isSelfTurnTransition,
  joinedPlayerIds,
  readyAudioChanges,
} from "./audio-event-policy";
import type { PublicRoomSnapshot } from "./protocol";

const HOVER_THROTTLE_MS = 80;
const DICE_THROW_DELAY_MS = 360;
const DICE_SHAKE_DURATION_MS = 560;
const GAME_MAIN_BGM_DELAY_MS = 420;
const INITIAL_TURN_CUE_DELAY_MS = 700;

interface AudioDirectorProps {
  room: PublicRoomSnapshot | null;
  selfPlayerId: string | null;
  serverRejectId?: string | null;
}

function interactiveElement(target: EventTarget | null): Element | null {
  if (!(target instanceof Element)) return null;
  return target.closest("button, a.button, input[type='range'], select");
}

/** Observes authoritative snapshots and never sends a game command. */
export function AudioDirector({
  room,
  selfPlayerId,
  serverRejectId = null,
}: AudioDirectorProps): null {
  const previousRoom = useRef<PublicRoomSnapshot | null>(null);
  const initialized = useRef(false);
  const scheduledTimers = useRef(new Set<number>());
  const timerGeneration = useRef(0);

  const schedule = (callback: () => void, delayMs: number): void => {
    const generation = timerGeneration.current;
    const timer = window.setTimeout(() => {
      scheduledTimers.current.delete(timer);
      if (generation === timerGeneration.current) callback();
    }, delayMs);
    scheduledTimers.current.add(timer);
  };

  const cancelScheduled = (): void => {
    timerGeneration.current += 1;
    for (const timer of scheduledTimers.current) window.clearTimeout(timer);
    scheduledTimers.current.clear();
  };

  useEffect(() => {
    void audioManager.preload();
    const unlock = (): void => {
      void audioManager.unlock().then((unlocked) => {
        if (!unlocked) return;
        window.removeEventListener("pointerdown", unlock, true);
        window.removeEventListener("keydown", unlock, true);
      });
    };
    window.addEventListener("pointerdown", unlock, true);
    window.addEventListener("keydown", unlock, true);
    return () => {
      window.removeEventListener("pointerdown", unlock, true);
      window.removeEventListener("keydown", unlock, true);
      cancelScheduled();
    };
  }, []);

  useEffect(() => {
    let lastHoverElement: Element | null = null;
    let lastHoverAt = Number.NEGATIVE_INFINITY;

    const hover = (event: PointerEvent): void => {
      if (event.pointerType === "touch") return;
      const control = interactiveElement(event.target);
      if (!control || control.matches(":disabled") || control.hasAttribute("data-audio-no-hover")) return;
      const previous = interactiveElement(event.relatedTarget);
      if (previous === control || (event.relatedTarget instanceof Node && control.contains(event.relatedTarget))) return;
      const now = performance.now();
      if (control === lastHoverElement || now - lastHoverAt < HOVER_THROTTLE_MS) return;
      lastHoverElement = control;
      lastHoverAt = now;
      void audioManager.playSfx("ui_hover", { priority: "low" });
    };

    const leave = (event: PointerEvent): void => {
      const control = interactiveElement(event.target);
      if (!control || control !== lastHoverElement) return;
      if (interactiveElement(event.relatedTarget) !== control) lastHoverElement = null;
    };

    const disabledAttempt = (event: PointerEvent): void => {
      const control = interactiveElement(event.target);
      if (!control?.matches(":disabled")) return;
      void audioManager.unlock().then((unlocked) => {
        if (unlocked) void audioManager.playSfx("error", { priority: "high" });
      });
    };

    const click = (event: MouseEvent): void => {
      const control = interactiveElement(event.target);
      if (!control || control.matches(":disabled") || control.hasAttribute("data-audio-no-click")) return;
      void audioManager.unlock().then((unlocked) => {
        if (unlocked) void audioManager.playSfx("subtle_click", { priority: "low" });
      });
    };

    document.addEventListener("pointerover", hover, true);
    document.addEventListener("pointerout", leave, true);
    document.addEventListener("pointerdown", disabledAttempt, true);
    document.addEventListener("click", click, true);
    return () => {
      document.removeEventListener("pointerover", hover, true);
      document.removeEventListener("pointerout", leave, true);
      document.removeEventListener("pointerdown", disabledAttempt, true);
      document.removeEventListener("click", click, true);
    };
  }, []);

  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      previousRoom.current = room;
      audioManager.restoreAllBgmDucks(0);
      const scene = audioScene(room);
      if (scene === "LOBBY") void audioManager.playBgm("bgm_lobby", { fadeMs: 550 });
      else {
        void audioManager.playBgm("bgm_main", { fadeMs: 550 });
        if (scene === "FINISHED") audioManager.duckBgm("finished", { level: .18, fadeMs: 0 });
      }
      return;
    }

    const previous = previousRoom.current;
    previousRoom.current = room;
    if (!room) {
      if (previous) {
        cancelScheduled();
        audioManager.restoreAllBgmDucks(250);
        void audioManager.crossfadeBgm("bgm_lobby", 550);
      }
      return;
    }
    if (!previous || previous.id !== room.id) {
      cancelScheduled();
      audioManager.restoreAllBgmDucks(200);
      const scene = audioScene(room);
      void audioManager.playBgm(scene === "LOBBY" ? "bgm_lobby" : "bgm_main", { fadeMs: 500 });
      if (scene === "FINISHED") audioManager.duckBgm("finished", { level: .18, fadeMs: 0 });
      return;
    }

    for (const playerId of joinedPlayerIds(previous, room)) {
      void audioManager.playSfx("player_in", {
        dedupeKey: `player-in:${room.id}:${playerId}`,
      });
    }
    for (const change of readyAudioChanges(previous, room)) {
      void audioManager.playSfx(change.ready ? "ready_on" : "ready_off", {
        dedupeKey: `ready:${room.id}:${room.revision}:${change.playerId}:${change.ready}`,
      });
    }

    const gameStarted = isGameStartTransition(previous, room);
    if (gameStarted) {
      cancelScheduled();
      audioManager.restoreAllBgmDucks(120);
      audioManager.stopBgm({ fadeMs: 400 });
      void audioManager.playSfx("game_start", {
        dedupeKey: `game-start:${room.id}:${room.revision}`,
        priority: "high",
      });
      schedule(() => void audioManager.playBgm("bgm_main", { fadeMs: 600 }), GAME_MAIN_BGM_DELAY_MS);
      if (isSelfTurnTransition(previous, room, selfPlayerId)) {
        schedule(() => {
          void audioManager.playSfx("your_turn", {
            dedupeKey: `turn:${room.id}:${room.revision}:${selfPlayerId}`,
            priority: "high",
          });
        }, INITIAL_TURN_CUE_DELAY_MS);
      }
    } else if (audioScene(previous) !== audioScene(room)) {
      const scene = audioScene(room);
      if (scene === "LOBBY") {
        cancelScheduled();
        audioManager.restoreAllBgmDucks(250);
        void audioManager.crossfadeBgm("bgm_lobby", 550);
      } else if (scene === "PLAYING") {
        audioManager.restoreAllBgmDucks(250);
        void audioManager.crossfadeBgm("bgm_main", 550);
      }
    }

    if (isRollTransition(previous, room)) {
      const rollKey = `roll:${room.id}:${room.revision}:${room.game!.currentPlayerId}:${room.game!.rollsUsed}`;
      void audioManager.playRandom("diceShake", {
        dedupeKey: `${rollKey}:shake`,
        maxDurationMs: DICE_SHAKE_DURATION_MS,
        fadeOutMs: 120,
      });
      schedule(() => {
        void audioManager.playRandom("diceThrow", {
          dedupeKey: `${rollKey}:throw`,
          priority: "normal",
        });
      }, DICE_THROW_DELAY_MS);
    }

    if (!gameStarted && isSelfTurnTransition(previous, room, selfPlayerId)) {
      void audioManager.playSfx("your_turn", {
        dedupeKey: `turn:${room.id}:${room.revision}:${selfPlayerId}`,
        priority: "high",
      });
    }

    if (isFinishTransition(previous, room)) {
      cancelScheduled();
      audioManager.duckBgm("finished", { level: .18, fadeMs: 180 });
      const result = finishedAudioAsset(room, selfPlayerId);
      if (result) {
        void audioManager.playSfx(result, {
          dedupeKey: `finish:${room.id}:${room.revision}:${selfPlayerId}`,
          priority: "high",
        });
      }
    }
  }, [room, selfPlayerId]);

  useEffect(() => {
    if (!serverRejectId) return;
    void audioManager.playSfx("error", {
      dedupeKey: `server-reject:${serverRejectId}`,
      priority: "high",
    });
  }, [serverRejectId]);

  return null;
}

/** Local-only controls. They never touch room or game state. */
export function AudioControls({ variant = "header" }: { variant?: "header" | "plaque" }): ReactElement {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const snapshot = useSyncExternalStore(
    audioManager.subscribe,
    audioManager.getSnapshot,
    audioManager.getSnapshot,
  );

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    dialog.focus();
    return () => {
      if (dialog.open && typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
      triggerRef.current?.focus();
    };
  }, [open]);

  const closeFromBackdrop = (event: ReactMouseEvent<HTMLDialogElement>): void => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (
      event.clientX < bounds.left || event.clientX > bounds.right
      || event.clientY < bounds.top || event.clientY > bounds.bottom
    ) setOpen(false);
  };

  return (
    <div className={`audio-settings ${variant}`}>
      <button
        aria-controls="audio-settings-dialog"
        aria-expanded={open}
        aria-haspopup="dialog"
        className="audio-settings-trigger"
        onClick={() => setOpen(true)}
        ref={triggerRef}
        type="button"
      >
        <span aria-hidden="true">◉</span> AUDIO
      </button>
      {open && (
        <dialog
          aria-labelledby="audio-settings-title"
          className="audio-settings-dialog"
          id="audio-settings-dialog"
          onCancel={(event) => {
            event.preventDefault();
            setOpen(false);
          }}
          onClick={closeFromBackdrop}
          ref={dialogRef}
        >
          <div className="audio-settings-header">
            <div>
              <p>TABLE SOUND</p>
              <h2 id="audio-settings-title">AUDIO SETTINGS</h2>
            </div>
            <button aria-label="Close audio settings" className="audio-settings-close" onClick={() => setOpen(false)} type="button">×</button>
          </div>

          <AudioSettingsRow
            id="audio-bgm-volume"
            label="BACKGROUND MUSIC"
            muted={snapshot.bgmMuted}
            onMute={() => audioManager.setBgmMuted()}
            onVolume={(volume) => audioManager.setVolume("BGM", volume)}
            value={snapshot.volumes.BGM}
          />
          <AudioSettingsRow
            id="audio-sfx-volume"
            label="SOUND EFFECTS"
            muted={snapshot.sfxMuted}
            onMute={() => audioManager.setSfxMuted()}
            onVolume={(volume) => audioManager.setSfxVolume(volume)}
            value={snapshot.sfxVolume}
          />
          <p className="audio-settings-note">
            DICE, TABLE AND SYSTEM SOUNDS FOLLOW THE SOUND EFFECTS LEVEL.
          </p>
        </dialog>
      )}
    </div>
  );
}

function AudioSettingsRow({
  id,
  label,
  muted,
  onMute,
  onVolume,
  value,
}: {
  id: string;
  label: string;
  muted: boolean;
  onMute: () => void;
  onVolume: (value: number) => void;
  value: number;
}): ReactElement {
  return (
    <div className="audio-settings-row">
      <div className="audio-settings-label">
        <label htmlFor={id}>{label}</label>
        <output htmlFor={id}>{Math.round(value * 100)}%</output>
      </div>
      <input
        aria-label={`${label} volume`}
        id={id}
        max="100"
        min="0"
        onChange={(event) => onVolume(Number(event.currentTarget.value) / 100)}
        step="1"
        type="range"
        value={Math.round(value * 100)}
      />
      <button aria-pressed={muted} className="audio-settings-mute" onClick={onMute} type="button">
        {muted ? "UNMUTE" : "MUTE"}
      </button>
    </div>
  );
}
