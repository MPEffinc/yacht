import type { ReactElement } from "react";
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
  onRoll: () => void;
  onSetHeld: (indices: number[]) => void;
  onScore: (category: ScoreCategory) => void;
  onLeave: () => void;
}

export function GameBoard({
  room,
  selfPlayerId,
  busy,
  onRoll,
  onSetHeld,
  onScore,
  onLeave,
}: GameBoardProps): ReactElement {
  const game = room.game!;
  const playersById = new Map(room.players.map((player) => [player.id, player]));
  const currentPlayer = game.currentPlayerId
    ? playersById.get(game.currentPlayerId) ?? null
    : null;
  const isMyTurn = game.phase === "PLAYING" && game.currentPlayerId === selfPlayerId;
  const currentDisconnected = currentPlayer?.connectionState === "DISCONNECTED_GRACE";
  const canRoll = isMyTurn && game.rollsRemaining > 0 && !busy;
  const canKeep = isMyTurn && game.rollsUsed > 0 && game.rollsRemaining > 0 && !busy;

  function toggleKept(index: number): void {
    if (!canKeep) return;
    const heldIndices = game.dice
      .map((die, dieIndex) => ({ kept: dieIndex === index ? !die.held : die.held, dieIndex }))
      .filter((entry) => entry.kept)
      .map((entry) => entry.dieIndex);
    onSetHeld(heldIndices);
  }

  function confirmScore(category: ScoreCategory, score: number): void {
    const label = categoryLabels[category];
    const warning =
      score === 0
        ? "\n0점으로 기록되며 이 칸은 다시 사용할 수 없습니다."
        : "";
    if (window.confirm(`${label}에 ${score}점을 기록하시겠습니까?${warning}`)) {
      onScore(category);
    }
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
        <ScoreSheet
          busy={busy}
          isMyTurn={isMyTurn}
          onConfirmScore={confirmScore}
          playersById={playersById}
          room={room}
          selfPlayerId={selfPlayerId}
        />

        <section className="dice-station" aria-label="Dice tray">
          {game.phase === "FINISHED" ? (
            <ResultPanel standings={standings} winnerPlayerIds={game.winnerPlayerIds} />
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
                    />
                  ),
                )}
                {game.dice.every((die) => die.held) && (
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
          {game.rollsUsed > 0 && game.rollsRemaining > 0 && isMyTurn && (
            <p className="keep-help">주사위를 누르면 KEEP 영역으로 이동합니다.</p>
          )}
        </section>
      </div>

      <div className="game-footer-actions">
        <button className="button danger" disabled={busy} onClick={onLeave} type="button">
          방 나가기
        </button>
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
}: {
  die: { value: DieValue | null; held: boolean };
  index: number;
  kept: boolean;
  canInteract: boolean;
  onClick: () => void;
}): ReactElement {
  const action = kept ? "KEEP 해제" : "KEEP 설정";
  return (
    <button
      aria-label={`${index + 1}번 주사위, ${die.value ?? "아직 굴리지 않음"}, ${action}`}
      className={kept ? "physical-die kept" : "physical-die"}
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
}: {
  standings: Array<{ playerId: string; nickname: string; total: number }>;
  winnerPlayerIds: string[];
}): ReactElement {
  return (
    <div className="result-panel">
      <p className="eyebrow">FINAL RESULT</p>
      <h2>게임 종료</h2>
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
    </div>
  );
}
