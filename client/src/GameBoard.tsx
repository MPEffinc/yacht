import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from "react";
import {
  LOWER_CATEGORIES,
  UPPER_CATEGORIES,
  type DieValue,
  type PublicRoomSnapshot,
  type ScoreCategory,
} from "./protocol";

const categoryLabels: Record<ScoreCategory, string> = {
  ONES: "Aces",
  TWOS: "Deuces",
  THREES: "Threes",
  FOURS: "Fours",
  FIVES: "Fives",
  SIXES: "Sixes",
  CHOICE: "Choice",
  FOUR_OF_A_KIND: "4 of a Kind",
  FULL_HOUSE: "Full House",
  SMALL_STRAIGHT: "S. Straight",
  LARGE_STRAIGHT: "L. Straight",
  YACHT: "Yacht",
};

const upperFaces: Partial<Record<ScoreCategory, DieValue>> = {
  ONES: 1,
  TWOS: 2,
  THREES: 3,
  FOURS: 4,
  FIVES: 5,
  SIXES: 6,
};

const pipPositions: Record<DieValue, number[]> = {
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
};

const combinationPriority: ScoreCategory[] = [
  "YACHT",
  "LARGE_STRAIGHT",
  "FULL_HOUSE",
  "FOUR_OF_A_KIND",
  "SMALL_STRAIGHT",
];

const combinationLabels: Partial<Record<ScoreCategory, string>> = {
  YACHT: "YACHT!",
  LARGE_STRAIGHT: "LARGE STRAIGHT",
  FULL_HOUSE: "FULL HOUSE",
  FOUR_OF_A_KIND: "4 OF A KIND",
  SMALL_STRAIGHT: "SMALL STRAIGHT",
};

const ROLL_PRESENTATION_MS = 780;

interface CombinationAlert {
  primary: ScoreCategory;
  secondary: ScoreCategory[];
  revision: number;
}

interface PendingDieFlip {
  rect: DOMRect;
  expectedRevision: number;
}

function presentationFace(revision: number, dieIndex: number, phase: number): DieValue {
  return ((revision + dieIndex * 3 + phase * 2) % 6 + 1) as DieValue;
}

interface GameBoardProps {
  room: PublicRoomSnapshot;
  selfPlayerId: string | null;
  busy: boolean;
  connected: boolean;
  onRoll: () => void;
  onSetHeld: (indices: number[]) => void;
  onScore: (category: ScoreCategory) => void;
  onLeave: () => void;
  onReturnToLobby: () => void;
}

interface PendingScore {
  category: ScoreCategory;
  score: number;
  revision: number;
}

export function GameBoard({
  room,
  selfPlayerId,
  busy,
  connected,
  onRoll,
  onSetHeld,
  onScore,
  onLeave,
  onReturnToLobby,
}: GameBoardProps): ReactElement {
  const game = room.game!;
  const [pendingScore, setPendingScore] = useState<PendingScore | null>(null);
  const [leaveDialogOpen, setLeaveDialogOpen] = useState(false);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState<"COPIED" | "ERROR" | null>(null);
  const [rollingIndices, setRollingIndices] = useState<number[]>([]);
  const [visualFaces, setVisualFaces] = useState<Partial<Record<number, DieValue>>>({});
  const [combinationAlert, setCombinationAlert] = useState<CombinationAlert | null>(null);
  const [presentationLocked, setPresentationLocked] = useState(false);
  const [turnTransition, setTurnTransition] = useState<string | null>(null);
  const [reducedMotion, setReducedMotion] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const previousGameRef = useRef(game);
  const previousRevisionRef = useRef(room.revision);
  const gameBoardRef = useRef<HTMLElement>(null);
  const pendingDieFlipsRef = useRef(new Map<number, PendingDieFlip>());
  const rollTimerRef = useRef<number | null>(null);
  const rollFaceTimersRef = useRef<number[]>([]);
  const combinationTimerRef = useRef<number | null>(null);
  const turnTimerRef = useRef<number | null>(null);
  const playersById = new Map(room.players.map((player) => [player.id, player]));
  const currentPlayer = game.currentPlayerId
    ? playersById.get(game.currentPlayerId) ?? null
    : null;
  const isMyTurn = game.phase === "PLAYING" && game.currentPlayerId === selfPlayerId;
  const currentDisconnected = currentPlayer?.connectionState === "DISCONNECTED_GRACE";
  const allKept = game.rollsUsed > 0 && game.dice.every((die) => die.held);
  const inputLocked = busy || presentationLocked || !connected || currentDisconnected;
  const scoreSelectionOpen = pendingScore !== null;
  const canRoll = isMyTurn && game.rollsRemaining > 0 && !allKept && !inputLocked && !scoreSelectionOpen;
  const canKeep = isMyTurn && game.rollsUsed > 0 && game.rollsRemaining > 0 && !inputLocked && !scoreSelectionOpen;

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = (): void => setReducedMotion(mediaQuery.matches);
    mediaQuery.addEventListener("change", onChange);
    return () => mediaQuery.removeEventListener("change", onChange);
  }, []);

  useLayoutEffect(() => {
    const previous = previousGameRef.current;
    const previousRevision = previousRevisionRef.current;
    previousGameRef.current = game;
    previousRevisionRef.current = room.revision;
    const isSequentialSnapshot = room.revision === previousRevision + 1;

    const isRollTransition =
      isSequentialSnapshot &&
      previous.phase === "PLAYING" &&
      game.phase === "PLAYING" &&
      previous.currentPlayerId === game.currentPlayerId &&
      game.rollsUsed === previous.rollsUsed + 1;
    if (isRollTransition) {
      const rolled = previous.rollsUsed === 0
        ? [0, 1, 2, 3, 4]
        : previous.dice
            .map((die, index) => ({ held: die.held, index }))
            .filter((die) => !die.held)
            .map((die) => die.index);
      if (rolled.length > 0) {
        if (rollTimerRef.current !== null) window.clearTimeout(rollTimerRef.current);
        rollFaceTimersRef.current.forEach((timer) => window.clearTimeout(timer));
        rollFaceTimersRef.current = [];
        if (combinationTimerRef.current !== null) window.clearTimeout(combinationTimerRef.current);
        setCombinationAlert(null);

        const matched = combinationPriority.filter((category) =>
          game.matchedCombinations.includes(category),
        );
        const revealCombination = (): void => {
          const primary = matched[0];
          if (!primary) return;
          setCombinationAlert({ primary, secondary: matched.slice(1), revision: room.revision });
          combinationTimerRef.current = window.setTimeout(() => {
            setCombinationAlert(null);
            combinationTimerRef.current = null;
          }, 1_250);
        };

        if (reducedMotion) {
          setRollingIndices([]);
          setVisualFaces({});
          setPresentationLocked(false);
          revealCombination();
        } else {
          setRollingIndices(rolled);
          setPresentationLocked(true);
          setVisualFaces(Object.fromEntries(
            rolled.map((index) => [index, presentationFace(room.revision, index, 0)]),
          ));
          for (const [phase, delay] of [110, 220, 350, 490].entries()) {
            rollFaceTimersRef.current.push(window.setTimeout(() => {
              setVisualFaces(Object.fromEntries(
                rolled.map((index) => [index, presentationFace(room.revision, index, phase + 1)]),
              ));
            }, delay));
          }
          rollFaceTimersRef.current.push(window.setTimeout(() => setVisualFaces({}), 590));
          rollTimerRef.current = window.setTimeout(() => {
            setRollingIndices([]);
            setVisualFaces({});
            setPresentationLocked(false);
            revealCombination();
            rollTimerRef.current = null;
          }, ROLL_PRESENTATION_MS);
        }
      }
    }

    const isTurnTransition =
      isSequentialSnapshot &&
      previous.phase === "PLAYING" &&
      game.phase === "PLAYING" &&
      previous.completedTurns + 1 === game.completedTurns &&
      previous.currentPlayerId !== game.currentPlayerId &&
      game.currentPlayerId !== null;
    if (isTurnTransition) {
      const message = game.currentPlayerId === selfPlayerId
        ? "내 차례입니다"
        : `${room.players.find((player) => player.id === game.currentPlayerId)?.nickname ?? "플레이어"}님의 차례`;
      if (turnTimerRef.current !== null) window.clearTimeout(turnTimerRef.current);
      setTurnTransition(message);
      turnTimerRef.current = window.setTimeout(() => {
        setTurnTransition(null);
        turnTimerRef.current = null;
      }, reducedMotion ? 1 : 820);
    }
  }, [game, reducedMotion, room.players, room.revision, selfPlayerId]);

  useLayoutEffect(() => {
    if (pendingDieFlipsRef.current.size === 0) return;
    for (const [index, pending] of pendingDieFlipsRef.current) {
      if (pending.expectedRevision !== room.revision) {
        if (pending.expectedRevision < room.revision) pendingDieFlipsRef.current.delete(index);
        continue;
      }
      const element = gameBoardRef.current?.querySelector<HTMLElement>(`[data-die-index="${index}"]`);
      if (!element) continue;
      const last = element.getBoundingClientRect();
      const deltaX = pending.rect.left - last.left;
      const deltaY = pending.rect.top - last.top;
      const startScale = pending.rect.width / last.width;
      element.style.zIndex = "12";
      const animation = element.animate(
        reducedMotion
          ? [{ opacity: .72 }, { opacity: 1 }]
          : [
              { transform: `translate(${deltaX}px, ${deltaY}px) scale(${startScale})` },
              { transform: `translate(${deltaX * .08}px, ${deltaY * .08}px) scale(1.035)`, offset: .78 },
              { transform: "translate(0, -2px) scale(.985)", offset: .9 },
              { transform: "translate(0, 0) scale(1)" },
            ],
        {
          duration: reducedMotion ? 100 : 340,
          easing: "cubic-bezier(.2,.78,.24,1)",
        },
      );
      void animation.finished.then(
        () => { element.style.zIndex = ""; },
        () => { element.style.zIndex = ""; },
      );
      pendingDieFlipsRef.current.delete(index);
    }
  }, [game.dice, reducedMotion, room.revision]);

  useEffect(() => () => {
    if (rollTimerRef.current !== null) window.clearTimeout(rollTimerRef.current);
    rollFaceTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    if (combinationTimerRef.current !== null) window.clearTimeout(combinationTimerRef.current);
    if (turnTimerRef.current !== null) window.clearTimeout(turnTimerRef.current);
  }, []);

  useEffect(() => {
    if (!pendingScore && !leaveDialogOpen) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      if (pendingScore) setPendingScore(null);
      else setLeaveDialogOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [leaveDialogOpen, pendingScore]);

  useEffect(() => {
    if (!pendingScore) return;
    const selfCard = selfPlayerId ? game.scoreCards[selfPlayerId] : null;
    const stillValid =
      connected &&
      game.phase === "PLAYING" &&
      isMyTurn &&
      room.revision === pendingScore.revision &&
      selfCard?.scores[pendingScore.category] === null &&
      game.availableScores?.[pendingScore.category] === pendingScore.score;
    if (!stillValid) setPendingScore(null);
  }, [connected, game, isMyTurn, pendingScore, room.revision, selfPlayerId]);

  function toggleKept(index: number): void {
    if (!canKeep) return;
    const element = gameBoardRef.current?.querySelector<HTMLElement>(`[data-die-index="${index}"]`);
    if (element) {
      pendingDieFlipsRef.current.set(index, {
        rect: element.getBoundingClientRect(),
        expectedRevision: room.revision + 1,
      });
    }
    const heldIndices = game.dice
      .map((die, dieIndex) => ({ kept: dieIndex === index ? !die.held : die.held, dieIndex }))
      .filter((entry) => entry.kept)
      .map((entry) => entry.dieIndex);
    onSetHeld(heldIndices);
  }

  function selectScore(category: ScoreCategory, score: number): void {
    if (inputLocked) return;
    setPendingScore({ category, score, revision: room.revision });
  }

  function submitScore(): void {
    if (!pendingScore) return;
    const category = pendingScore.category;
    setPendingScore(null);
    onScore(category);
  }

  async function copyInvite(): Promise<void> {
    const inviteUrl = `${window.location.origin}/yacht/r/${room.id}`;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopyFeedback("COPIED");
    } catch {
      setCopyFeedback("ERROR");
    }
    window.setTimeout(() => setCopyFeedback(null), 2_000);
  }

  const standings = game.playerOrder
    .map((playerId) => ({
      playerId,
      nickname: playersById.get(playerId)?.nickname ?? "Unknown",
      total: game.scoreCards[playerId]?.total ?? 0,
    }))
    .sort((left, right) => right.total - left.total);

  return (
    <section className="game-layout" ref={gameBoardRef}>
      <div className="tabletop-board">
        <TableControls
          busy={busy}
          connected={connected}
          controlsOpen={controlsOpen}
          copyFeedback={copyFeedback}
          gamePhase={game.phase}
          leaveConfirmOpen={leaveDialogOpen}
          onCancelLeave={() => setLeaveDialogOpen(false)}
          onConfirmLeave={() => {
            setLeaveDialogOpen(false);
            onLeave();
          }}
          onCopyInvite={() => void copyInvite()}
          onOpenLeave={() => setLeaveDialogOpen(true)}
          onToggle={() => {
            setControlsOpen((open) => !open);
            setLeaveDialogOpen(false);
          }}
          roomId={room.id}
        />

        <div className="tabletop-pieces">
          <ScoreSheet
            busy={inputLocked}
            currentDisconnected={Boolean(currentDisconnected)}
            currentPlayerName={currentPlayer?.nickname ?? "플레이어"}
            isMyTurn={isMyTurn}
            onCancelScore={() => setPendingScore(null)}
            onConfirmScore={selectScore}
            onSubmitScore={submitScore}
            pendingScore={pendingScore}
            playersById={playersById}
            room={room}
            selfPlayerId={selfPlayerId}
            turnTransition={turnTransition}
          />

          <section className={game.phase === "FINISHED" ? "dice-station finished" : "dice-station"} aria-label="Dice tray">
            {game.phase === "FINISHED" && (
              <ResultPanel
                busy={busy}
                isHost={room.hostPlayerId === selfPlayerId}
                onReturnToLobby={onReturnToLobby}
                standings={standings}
                winnerPlayerIds={game.winnerPlayerIds}
              />
            )}

            <div className="dice-tray">
              <div className="keep-zone">
                <div className="tray-label">
                  <strong>KEEP</strong>
                  <span>굴리지 않을 주사위</span>
                </div>
                <div className="keep-slots">
                  {game.dice.map((die, index) => (
                    <div className={die.held ? "keep-slot occupied" : "keep-slot"} key={index}>
                      {die.held ? (
                        <DieButton
                          canInteract={canKeep}
                          die={die}
                          index={index}
                          kept
                          onClick={() => toggleKept(index)}
                          rolling={false}
                          visualValue={die.value}
                        />
                      ) : (
                        <span aria-hidden="true" className="slot-number">{index + 1}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              <div className="roll-zone">
                <span className="felt-label">ROLLING FELT</span>
                {combinationAlert && (
                  <div
                    className={combinationAlert.primary === "YACHT" ? "combination-alert yacht" : "combination-alert"}
                    key={`${combinationAlert.revision}-${combinationAlert.primary}`}
                    role="status"
                  >
                    <strong>{combinationLabels[combinationAlert.primary]}</strong>
                    {combinationAlert.secondary.length > 0 && (
                      <small>
                        ALSO SCORES · {combinationAlert.secondary.map((category) => combinationLabels[category]).join(" · ")}
                      </small>
                    )}
                  </div>
                )}
                <div className="rolling-dice">
                  {game.dice.map((die, index) =>
                    die.held ? null : (
                      <DieButton
                        canInteract={canKeep && die.value !== null}
                        die={die}
                        index={index}
                        kept={false}
                        key={index}
                        onClick={() => toggleKept(index)}
                        rollOrder={rollingIndices.indexOf(index)}
                        rolling={rollingIndices.includes(index)}
                        visualValue={visualFaces[index] ?? die.value}
                      />
                    ),
                  )}
                  {allKept && (
                    <p className="all-kept-message">모든 주사위를 KEEP했습니다.</p>
                  )}
                </div>
              </div>

              <div className="tray-control-rim">
                <button
                  className="roll-again-button"
                  disabled={!canRoll}
                  onClick={onRoll}
                  type="button"
                >
                  {game.phase === "FINISHED"
                    ? "GAME COMPLETE"
                    : busy
                      ? "처리 중..."
                      : game.rollsUsed === 0
                        ? "ROLL DICE"
                        : "ROLL AGAIN"}
                </button>
                <div className="roll-readout" aria-live="polite">
                  <span>ROLLS LEFT</span>
                  <strong>{game.phase === "FINISHED" ? "—" : game.rollsRemaining}</strong>
                </div>
                <p className={allKept ? "keep-help all-kept-help" : "keep-help"}>
                  {game.phase === "FINISHED"
                    ? "최종 점수표를 확인하세요"
                    : allKept && isMyTurn
                      ? "점수를 기록하거나 KEEP을 해제하세요"
                      : game.rollsUsed > 0 && isMyTurn
                        ? "주사위를 눌러 KEEP"
                        : isMyTurn
                          ? "주사위를 굴려 시작하세요"
                          : "상대의 플레이를 기다리는 중"}
                </p>
              </div>
            </div>
          </section>
        </div>
      </div>
    </section>
  );
}

function DieButton({
  die,
  index,
  kept,
  canInteract,
  onClick,
  rolling,
  rollOrder = -1,
  visualValue,
}: {
  die: { value: DieValue | null; held: boolean };
  index: number;
  kept: boolean;
  canInteract: boolean;
  onClick: () => void;
  rolling: boolean;
  rollOrder?: number;
  visualValue: DieValue | null;
}): ReactElement {
  const action = kept ? "KEEP 해제" : "KEEP 설정";
  return (
    <button
      aria-label={`${index + 1}번 주사위, ${die.value ?? "아직 굴리지 않음"}, ${action}`}
      className={`physical-die${kept ? " kept" : ""}${rolling ? " rolling" : ""}`}
      data-die-index={index}
      data-die-value={die.value ?? "empty"}
      disabled={!canInteract}
      onClick={onClick}
      style={rolling ? { "--roll-delay": `${Math.max(0, rollOrder) * 35}ms` } as CSSProperties : undefined}
      type="button"
    >
      <PipFace value={visualValue} />
      {kept && <small>KEEP</small>}
    </button>
  );
}

function PipFace({ value, compact = false }: { value: DieValue | null; compact?: boolean }): ReactElement {
  return (
    <span aria-hidden="true" className={compact ? "pip-face compact" : "pip-face"}>
      {value === null ? (
        <i className="empty-die-mark">–</i>
      ) : (
        pipPositions[value].map((position) => (
          <i
            className={`pip pip-${position}`}
            key={position}
          />
        ))
      )}
    </span>
  );
}

function CategoryLabel({ category }: { category: ScoreCategory }): ReactElement {
  const face = upperFaces[category];
  return (
    <span className="category-label">
      <span aria-hidden="true" className={face ? "category-symbol upper" : "category-symbol lower"}>
        {face ? <PipFace compact value={face} /> : categoryLabels[category].slice(0, 1)}
      </span>
      {categoryLabels[category]}
    </span>
  );
}

function TableControls({
  roomId,
  connected,
  busy,
  controlsOpen,
  copyFeedback,
  gamePhase,
  leaveConfirmOpen,
  onToggle,
  onCopyInvite,
  onOpenLeave,
  onCancelLeave,
  onConfirmLeave,
}: {
  roomId: string;
  connected: boolean;
  busy: boolean;
  controlsOpen: boolean;
  copyFeedback: "COPIED" | "ERROR" | null;
  gamePhase: "PLAYING" | "FINISHED";
  leaveConfirmOpen: boolean;
  onToggle: () => void;
  onCopyInvite: () => void;
  onOpenLeave: () => void;
  onCancelLeave: () => void;
  onConfirmLeave: () => void;
}): ReactElement {
  return (
    <aside className="table-controls">
      <button
        aria-controls="table-controls-shelf"
        aria-expanded={controlsOpen}
        className="table-plaque"
        onClick={onToggle}
        type="button"
      >
        <span>{roomId}</span>
        <strong className={connected ? "network-online" : "network-offline"}>
          {connected ? "ONLINE" : "RECONNECTING"} <i aria-hidden="true" />
        </strong>
        <b aria-hidden="true">{controlsOpen ? "CLOSE" : "MENU"}</b>
      </button>

      {controlsOpen && (
        <div className="table-controls-shelf" id="table-controls-shelf">
          <div className="shelf-heading">
            <span>TABLE MENU</span>
            <strong>{roomId}</strong>
          </div>
          <div className="shelf-status">
            <span>NETWORK</span>
            <strong className={connected ? "network-online" : "network-offline"}>
              {connected ? "ONLINE" : "연결 복구 중"} <i aria-hidden="true" />
            </strong>
          </div>
          <button className="shelf-action" onClick={onCopyInvite} type="button">
            {copyFeedback === "COPIED" ? "초대 링크 복사 완료" : "초대 링크 복사"}
          </button>
          {copyFeedback === "ERROR" && (
            <p className="shelf-feedback" role="status">/yacht/r/{roomId} 링크를 직접 복사해 주세요.</p>
          )}

          {leaveConfirmOpen ? (
            <div className="shelf-leave-confirm" role="group" aria-label="게임 나가기 확인">
              <strong>테이블을 나갈까요?</strong>
              <p>
                {gamePhase === "PLAYING"
                  ? "진행 중 나가면 게임이 종료되고 모두 로비로 돌아갑니다."
                  : "방을 나가면 남은 플레이어는 로비로 돌아갑니다."}
              </p>
              <div>
                <button autoFocus onClick={onCancelLeave} type="button">취소</button>
                <button className="confirm-leave" disabled={busy} onClick={onConfirmLeave} type="button">
                  나가기
                </button>
              </div>
            </div>
          ) : (
            <button className="shelf-action shelf-leave" disabled={busy} onClick={onOpenLeave} type="button">
              게임에서 나가기
            </button>
          )}
        </div>
      )}
    </aside>
  );
}

function ScoreSheet({
  room,
  selfPlayerId,
  isMyTurn,
  busy,
  currentPlayerName,
  currentDisconnected,
  pendingScore,
  turnTransition,
  playersById,
  onConfirmScore,
  onCancelScore,
  onSubmitScore,
}: {
  room: PublicRoomSnapshot;
  selfPlayerId: string | null;
  isMyTurn: boolean;
  busy: boolean;
  currentPlayerName: string;
  currentDisconnected: boolean;
  pendingScore: PendingScore | null;
  turnTransition: string | null;
  playersById: Map<string, PublicRoomSnapshot["players"][number]>;
  onConfirmScore: (category: ScoreCategory, score: number) => void;
  onCancelScore: () => void;
  onSubmitScore: () => void;
}): ReactElement {
  const game = room.game!;
  const scoreScrollRef = useRef<HTMLDivElement>(null);
  const currentHeaderRef = useRef<HTMLTableCellElement>(null);
  const columnClass = (playerId: string): string =>
    [
      playerId === selfPlayerId ? "self-column" : "",
      playerId === game.currentPlayerId ? "current-column" : "",
      game.winnerPlayerIds.includes(playerId) ? "winner-column" : "",
    ]
      .filter(Boolean)
      .join(" ");

  useLayoutEffect(() => {
    const scroller = scoreScrollRef.current;
    const header = currentHeaderRef.current;
    if (!scroller || !header || scroller.scrollWidth <= scroller.clientWidth) return;
    const stickyCategoryWidth = 165;
    const visibleLeft = scroller.scrollLeft + stickyCategoryWidth;
    const visibleRight = scroller.scrollLeft + scroller.clientWidth;
    const headerLeft = header.offsetLeft;
    const headerRight = headerLeft + header.offsetWidth;
    if (headerLeft < visibleLeft) {
      scroller.scrollLeft = Math.max(0, headerLeft - stickyCategoryWidth);
    } else if (headerRight > visibleRight) {
      scroller.scrollLeft = headerRight - scroller.clientWidth;
    }
  }, [game.currentPlayerId, game.playerOrder.length]);

  function categoryRow(category: ScoreCategory): ReactElement {
    const selected = pendingScore?.category === category;
    return (
      <tr className={selected ? "selected-score-row" : ""} key={category}>
        <th scope="row"><CategoryLabel category={category} /></th>
        {game.playerOrder.map((playerId) => {
          const score = game.scoreCards[playerId]!.scores[category];
          const preview = game.availableScores?.[category];
          const selectable =
            isMyTurn &&
            playerId === selfPlayerId &&
            score === null &&
            preview !== undefined &&
            !busy;
          return (
            <td
              className={`${columnClass(playerId)}${selected && playerId === selfPlayerId ? " selected-score-cell" : ""}`}
              key={playerId}
            >
              {score !== null ? (
                <strong>{score}</strong>
              ) : preview !== undefined && playerId === game.currentPlayerId ? (
                <button
                  aria-label={`${categoryLabels[category]}에 ${preview}점 기록`}
                  aria-pressed={selected}
                  className={selected ? "score-preview selected" : "score-preview"}
                  disabled={!selectable}
                  onClick={() => onConfirmScore(category, preview)}
                  type="button"
                >
                  {preview}
                </button>
              ) : (
                <span className="empty-score">—</span>
              )}
            </td>
          );
        })}
      </tr>
    );
  }

  function derivedRow(
    label: string,
    key: "upperSubtotal" | "upperBonus" | "total",
    className = "derived-row",
  ): ReactElement {
    return (
      <tr className={className}>
        <th scope="row">{label}</th>
        {game.playerOrder.map((playerId) => (
          <td className={columnClass(playerId)} key={playerId}>
            <strong>{game.scoreCards[playerId]![key]}</strong>
          </td>
        ))}
      </tr>
    );
  }

  return (
    <section className={game.phase === "FINISHED" ? "score-sheet final-score-sheet" : "score-sheet"} aria-label="Yacht Dice score sheet">
      <div className="score-sheet-heading">
        <div className="score-sheet-title">
          <span>YACHT</span>
          <strong>SCORE PAD</strong>
        </div>
        <div className="score-sheet-state" aria-live="polite">
          {turnTransition && <span className="score-turn-note">{turnTransition}</span>}
          <strong>
            {game.phase === "FINISHED"
              ? "FINAL SCORES"
              : currentDisconnected
                ? `${currentPlayerName} · 재접속 대기`
                : isMyTurn
                  ? game.rollsUsed === 0
                    ? "당신 차례 · 주사위를 굴리세요"
                    : "당신 차례 · 점수를 선택하세요"
                  : `${currentPlayerName} 차례`}
          </strong>
          <small>{game.phase === "FINISHED" ? "점수표가 최종 결과입니다" : "예상 점수를 눌러 기록"}</small>
        </div>
        <div className="score-turn">
          <span>TURN</span>
          <strong>{game.round}<small>/12</small></strong>
        </div>
      </div>
      <div className="score-table-scroll" ref={scoreScrollRef}>
        <table className="score-table">
          <thead>
            <tr>
              <th scope="col">Categories</th>
              {game.playerOrder.map((playerId) => {
                const current = playerId === game.currentPlayerId;
                const self = playerId === selfPlayerId;
                const winner = game.winnerPlayerIds.includes(playerId);
                return (
                  <th
                    aria-current={current ? "true" : undefined}
                    className={columnClass(playerId)}
                    key={playerId}
                    ref={current ? currentHeaderRef : undefined}
                    scope="col"
                  >
                    <span className="player-name-line">
                      {current && <i aria-hidden="true" className="current-player-marker" />}
                      {playersById.get(playerId)?.nickname ?? "Unknown"}
                    </span>
                    {(self || current || winner) && (
                      <small>
                        {winner ? "★ WINNER" : [self ? "YOU" : "", current ? "TURN" : ""].filter(Boolean).join(" · ")}
                      </small>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {UPPER_CATEGORIES.map(categoryRow)}
            {derivedRow("Subtotal", "upperSubtotal")}
            {derivedRow("+35 Bonus", "upperBonus", "derived-row bonus-row")}
            {LOWER_CATEGORIES.map(categoryRow)}
            {derivedRow("Total", "total", "total-row")}
          </tbody>
        </table>
      </div>
      {pendingScore && (
        <div
          aria-label={`${categoryLabels[pendingScore.category]} 점수 기록 확인`}
          className={pendingScore.score === 0 ? "score-confirmation-strip zero-score" : "score-confirmation-strip"}
          role="group"
        >
          <div className="score-confirmation-copy">
            <span>PENCIL IN</span>
            <strong>{categoryLabels[pendingScore.category]} · {pendingScore.score}점</strong>
            <small>
              {pendingScore.score === 0
                ? "0점으로 기록하면 이 칸은 다시 사용할 수 없습니다."
                : "선택한 칸에 이 점수를 기록합니다."}
            </small>
          </div>
          <div className="score-confirmation-actions">
            <button autoFocus onClick={onCancelScore} type="button">취소</button>
            <button className={pendingScore.score === 0 ? "record-score zero" : "record-score"} onClick={onSubmitScore} type="button">
              {pendingScore.score}점 기록
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function ResultPanel({
  standings,
  winnerPlayerIds,
  isHost,
  busy,
  onReturnToLobby,
}: {
  standings: Array<{ playerId: string; nickname: string; total: number }>;
  winnerPlayerIds: string[];
  isHost: boolean;
  busy: boolean;
  onReturnToLobby: () => void;
}): ReactElement {
  const winners = standings.filter((entry) => winnerPlayerIds.includes(entry.playerId));
  const winnerText = winners.map((entry) => entry.nickname).join(" · ");
  return (
    <aside className="result-panel" aria-label="Final ranking and rematch">
      <p className="result-kicker">{winners.length > 1 ? "TIE WINNERS" : "WINNER"}</p>
      <h2>{winnerText}{winners.length > 1 ? " 공동 우승" : " 우승"}</h2>
      <p className="result-final-score">Final score {winners[0]?.total ?? 0}</p>
      <ol>
        {standings.map((entry) => {
          const rank = standings.findIndex((candidate) => candidate.total === entry.total) + 1;
          const winner = winnerPlayerIds.includes(entry.playerId);
          return (
            <li className={winner ? "winner" : ""} key={entry.playerId}>
              <span>{rank}위</span>
              <strong>{winner && "★ "}{entry.nickname}</strong>
              <b>{entry.total}</b>
            </li>
          );
        })}
      </ol>
      <div className="rematch-actions">
        {isHost ? (
          <>
            <button
              className="rematch-button"
              data-action="return-to-lobby"
              disabled={busy}
              onClick={onReturnToLobby}
              type="button"
            >
              SAME TABLE · 다시 하기
            </button>
            <p>같은 테이블의 로비로 돌아갑니다. 모두 Ready하면 다시 시작할 수 있습니다.</p>
          </>
        ) : (
          <p className="rematch-waiting">
            방장이 재경기를 준비하는 중… 같은 테이블에서 기다려 주세요.
          </p>
        )}
      </div>
    </aside>
  );
}
