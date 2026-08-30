import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
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
  const [rollingIndices, setRollingIndices] = useState<number[]>([]);
  const [presentationLocked, setPresentationLocked] = useState(false);
  const [turnTransition, setTurnTransition] = useState<string | null>(null);
  const [reducedMotion, setReducedMotion] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const previousGameRef = useRef(game);
  const previousRevisionRef = useRef(room.revision);
  const rollTimerRef = useRef<number | null>(null);
  const turnTimerRef = useRef<number | null>(null);
  const playersById = new Map(room.players.map((player) => [player.id, player]));
  const currentPlayer = game.currentPlayerId
    ? playersById.get(game.currentPlayerId) ?? null
    : null;
  const isMyTurn = game.phase === "PLAYING" && game.currentPlayerId === selfPlayerId;
  const currentDisconnected = currentPlayer?.connectionState === "DISCONNECTED_GRACE";
  const allKept = game.rollsUsed > 0 && game.dice.every((die) => die.held);
  const inputLocked = busy || presentationLocked || !connected || currentDisconnected;
  const canRoll = isMyTurn && game.rollsRemaining > 0 && !allKept && !inputLocked;
  const canKeep = isMyTurn && game.rollsUsed > 0 && game.rollsRemaining > 0 && !inputLocked;

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
    if (isRollTransition && !reducedMotion) {
      const rolled = previous.rollsUsed === 0
        ? [0, 1, 2, 3, 4]
        : previous.dice
            .map((die, index) => ({ held: die.held, index }))
            .filter((die) => !die.held)
            .map((die) => die.index);
      if (rolled.length > 0) {
        if (rollTimerRef.current !== null) window.clearTimeout(rollTimerRef.current);
        setRollingIndices(rolled);
        setPresentationLocked(true);
        rollTimerRef.current = window.setTimeout(() => {
          setRollingIndices([]);
          setPresentationLocked(false);
          rollTimerRef.current = null;
        }, 560);
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

  useEffect(() => () => {
    if (rollTimerRef.current !== null) window.clearTimeout(rollTimerRef.current);
    if (turnTimerRef.current !== null) window.clearTimeout(turnTimerRef.current);
  }, []);

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
    const heldIndices = game.dice
      .map((die, dieIndex) => ({ kept: dieIndex === index ? !die.held : die.held, dieIndex }))
      .filter((entry) => entry.kept)
      .map((entry) => entry.dieIndex);
    onSetHeld(heldIndices);
  }

  function openScoreDialog(category: ScoreCategory, score: number): void {
    if (inputLocked) return;
    setPendingScore({ category, score, revision: room.revision });
  }

  function submitScore(): void {
    if (!pendingScore) return;
    const category = pendingScore.category;
    setPendingScore(null);
    onScore(category);
  }

  const standings = game.playerOrder
    .map((playerId) => ({
      playerId,
      nickname: playersById.get(playerId)?.nickname ?? "Unknown",
      total: game.scoreCards[playerId]?.total ?? 0,
    }))
    .sort((left, right) => right.total - left.total);

  return (
    <section className="game-layout">
      <header className="game-heading">
        <div>
          <p className="eyebrow">TABLE {room.id}</p>
          <h1>Yacht Dice</h1>
        </div>
        <div className="game-heading-status" aria-live="polite">
          <span>{game.phase === "FINISHED" ? "GAME OVER" : "CURRENT PLAYER"}</span>
          <strong>
            {game.phase === "FINISHED"
              ? "게임 종료"
              : currentDisconnected
                ? `${currentPlayer?.nickname ?? "플레이어"}님의 재접속을 기다리는 중`
                : isMyTurn
                  ? "내 차례입니다"
                  : `${currentPlayer?.nickname ?? "플레이어"}님의 차례입니다`}
          </strong>
        </div>
      </header>

      <div className="tabletop-board">
        {turnTransition && (
          <div className="turn-transition" role="status">
            {turnTransition}
          </div>
        )}
        <ScoreSheet
          busy={inputLocked}
          isMyTurn={isMyTurn}
          onConfirmScore={openScoreDialog}
          playersById={playersById}
          room={room}
          selfPlayerId={selfPlayerId}
        />

        <section className="dice-station" aria-label="Dice tray">
          {game.phase === "FINISHED" ? (
            <ResultPanel
              busy={busy}
              isHost={room.hostPlayerId === selfPlayerId}
              onReturnToLobby={onReturnToLobby}
              standings={standings}
              winnerPlayerIds={game.winnerPlayerIds}
            />
          ) : (
            <div className="turn-card">
              <span>TURN</span>
              <strong>{game.round}<small>/12</small></strong>
              <p>{isMyTurn ? "주사위를 선택하세요" : "상대의 플레이를 기다립니다"}</p>
            </div>
          )}

          <div className="dice-tray">
            <div className="keep-zone">
              <div className="tray-label">
                <strong>KEEP</strong>
                <span>보관한 주사위</span>
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
                      />
                    ) : (
                      <span aria-hidden="true" className="slot-number">{index + 1}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div className="roll-zone">
              <span className="felt-label">ROLL AREA</span>
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
                      rolling={rollingIndices.includes(index)}
                    />
                  ),
                )}
                {allKept && (
                  <p className="all-kept-message">모든 주사위를 KEEP했습니다.</p>
                )}
              </div>
            </div>
          </div>

          <button
            className="roll-again-button"
            disabled={!canRoll}
            onClick={onRoll}
            type="button"
          >
            {busy ? "처리 중..." : game.rollsUsed === 0 ? "Roll Dice" : "Roll Again"}
          </button>
          <p className="rolls-left">{game.rollsRemaining} rolls left</p>
          {allKept && isMyTurn ? (
            <p className="keep-help all-kept-help">
              점수를 선택하거나 KEEP을 해제해 주세요.
            </p>
          ) : game.rollsUsed > 0 && game.rollsRemaining > 0 && isMyTurn && (
            <p className="keep-help">주사위를 누르면 KEEP 영역으로 이동합니다.</p>
          )}
        </section>
      </div>

      <div className="game-footer-actions">
        <button
          className="button danger"
          disabled={busy}
          onClick={() => setLeaveDialogOpen(true)}
          type="button"
        >
          방 나가기
        </button>
      </div>

      {pendingScore && (
        <ConfirmationDialog
          confirmLabel={`${pendingScore.score}점 기록`}
          danger={pendingScore.score === 0}
          onCancel={() => setPendingScore(null)}
          onConfirm={submitScore}
          title={categoryLabels[pendingScore.category]}
        >
          {pendingScore.score === 0 ? (
            <>
              <strong>0점으로 기록됩니다.</strong>
              <p>이 점수 칸은 이후 다시 사용할 수 없습니다.</p>
            </>
          ) : (
            <p><strong>{pendingScore.score}점</strong>을 기록하시겠습니까?</p>
          )}
        </ConfirmationDialog>
      )}

      {leaveDialogOpen && (
        <ConfirmationDialog
          confirmLabel="게임에서 나가기"
          danger
          onCancel={() => setLeaveDialogOpen(false)}
          onConfirm={() => {
            setLeaveDialogOpen(false);
            onLeave();
          }}
          title="게임에서 나가시겠습니까?"
        >
          {game.phase === "PLAYING" ? (
            <p>진행 중 나가면 현재 게임은 종료되고 남은 플레이어는 로비로 돌아갑니다.</p>
          ) : (
            <p>방을 나가면 남은 플레이어는 로비로 돌아갑니다.</p>
          )}
        </ConfirmationDialog>
      )}
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
}: {
  die: { value: DieValue | null; held: boolean };
  index: number;
  kept: boolean;
  canInteract: boolean;
  onClick: () => void;
  rolling: boolean;
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
      type="button"
    >
      <PipFace value={die.value} />
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

function ScoreSheet({
  room,
  selfPlayerId,
  isMyTurn,
  busy,
  playersById,
  onConfirmScore,
}: {
  room: PublicRoomSnapshot;
  selfPlayerId: string | null;
  isMyTurn: boolean;
  busy: boolean;
  playersById: Map<string, PublicRoomSnapshot["players"][number]>;
  onConfirmScore: (category: ScoreCategory, score: number) => void;
}): ReactElement {
  const game = room.game!;
  const columnClass = (playerId: string): string =>
    [
      playerId === selfPlayerId ? "self-column" : "",
      playerId === game.currentPlayerId ? "current-column" : "",
    ]
      .filter(Boolean)
      .join(" ");

  function categoryRow(category: ScoreCategory): ReactElement {
    return (
      <tr key={category}>
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
            <td className={columnClass(playerId)} key={playerId}>
              {score !== null ? (
                <strong>{score}</strong>
              ) : preview !== undefined && playerId === game.currentPlayerId ? (
                <button
                  aria-label={`${categoryLabels[category]}에 ${preview}점 기록`}
                  className="score-preview"
                  disabled={!selectable}
                  onClick={() => onConfirmScore(category, preview)}
                  type="button"
                >
                  ({preview})
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
    <section className="score-sheet" aria-label="Yacht Dice score sheet">
      <div className="score-sheet-heading">
        <div>
          <span>SCORE SHEET</span>
          <strong>Turn {game.round}/12</strong>
        </div>
        <small>예상 점수를 눌러 기록</small>
      </div>
      <div className="score-table-scroll">
        <table className="score-table">
          <thead>
            <tr>
              <th scope="col">Categories</th>
              {game.playerOrder.map((playerId) => (
                <th className={columnClass(playerId)} key={playerId} scope="col">
                  {playersById.get(playerId)?.nickname ?? "Unknown"}
                  {playerId === selfPlayerId && <small>YOU</small>}
                </th>
              ))}
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
    <div className="result-panel">
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
              같은 방에서 다시 하기
            </button>
            <p>같은 방을 유지하고 로비로 돌아갑니다. 모두 Ready하면 다시 시작할 수 있습니다.</p>
          </>
        ) : (
          <p className="rematch-waiting">
            방장이 재경기를 준비하면 같은 방에서 다시 플레이할 수 있습니다.
          </p>
        )}
      </div>
    </div>
  );
}

function ConfirmationDialog({
  title,
  children,
  confirmLabel,
  danger = false,
  onCancel,
  onConfirm,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}): ReactElement {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
        "button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])",
      ) ?? [])];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        aria-labelledby={titleId}
        aria-modal="true"
        className="confirmation-dialog"
        ref={dialogRef}
        role="dialog"
      >
        <p className="dialog-kicker">CONFIRM</p>
        <h2 id={titleId}>{title}</h2>
        <div className="dialog-copy">{children}</div>
        <div className="dialog-actions">
          <button autoFocus className="button ghost" onClick={onCancel} type="button">
            취소
          </button>
          <button
            className={danger ? "button dialog-danger" : "button accent"}
            onClick={onConfirm}
            type="button"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
