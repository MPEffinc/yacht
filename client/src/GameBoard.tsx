import type { ReactElement } from "react";
import {
  LOWER_CATEGORIES,
  UPPER_CATEGORIES,
  type PublicRoomSnapshot,
  type ScoreCategory,
} from "./protocol";

const categoryLabels: Record<ScoreCategory, string> = {
  ONES: "Ones",
  TWOS: "Twos",
  THREES: "Threes",
  FOURS: "Fours",
  FIVES: "Fives",
  SIXES: "Sixes",
  CHOICE: "Choice",
  FOUR_OF_A_KIND: "Four of a Kind",
  FULL_HOUSE: "Full House",
  SMALL_STRAIGHT: "Small Straight",
  LARGE_STRAIGHT: "Large Straight",
  YACHT: "Yacht",
};

const dieFaces = ["", "⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];

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
  const canHold = isMyTurn && game.rollsUsed > 0 && game.rollsRemaining > 0 && !busy;

  function toggleHeld(index: number): void {
    if (!canHold) return;
    const heldIndices = game.dice
      .map((die, dieIndex) => ({ held: dieIndex === index ? !die.held : die.held, dieIndex }))
      .filter((entry) => entry.held)
      .map((entry) => entry.dieIndex);
    onSetHeld(heldIndices);
  }

  function confirmScore(category: ScoreCategory, score: number): void {
    const label = categoryLabels[category];
    const warning =
      score === 0
        ? `\n0점으로 기록되며 이 칸은 다시 사용할 수 없습니다.`
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
      <div className="game-topbar">
        <div>
          <p className="eyebrow">ROOM {room.id}</p>
          <h1>Round {game.round} <span>/ 12</span></h1>
        </div>
        <div className="turn-pill">
          <span>{game.phase === "FINISHED" ? "GAME OVER" : "CURRENT TURN"}</span>
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
      </div>

      {game.phase === "FINISHED" && (
        <div className="result-panel">
          <p className="eyebrow">FINAL RESULT</p>
          <h2>게임 종료</h2>
          <ol>
            {standings.map((entry) => {
              const rank = standings.findIndex((candidate) => candidate.total === entry.total) + 1;
              const winner = game.winnerPlayerIds.includes(entry.playerId);
              return (
                <li key={entry.playerId} className={winner ? "winner" : ""}>
                  <span>{rank}위</span>
                  <strong>{winner && "★ "}{entry.nickname}</strong>
                  <b>{entry.total}</b>
                </li>
              );
            })}
          </ol>
        </div>
      )}

      <div className="game-main-grid">
        <div className="dice-panel card">
          <div className="section-title game-section-title">
            <div>
              <h2>주사위</h2>
              <p>{game.rollsUsed === 0 ? "첫 Roll은 모든 주사위를 굴립니다." : "주사위를 눌러 Hold하세요."}</p>
            </div>
            <span className="roll-count">남은 굴림 {game.rollsRemaining}회</span>
          </div>
          <div className="dice-grid" aria-label="주사위 5개">
            {game.dice.map((die, index) => (
              <button
                aria-label={`${index + 1}번 주사위${die.held ? ", Hold됨" : ""}`}
                className={`game-die${die.held ? " held" : ""}`}
                disabled={!canHold || die.value === null}
                key={index}
                onClick={() => toggleHeld(index)}
                type="button"
              >
                <span>{die.value === null ? "–" : dieFaces[die.value]}</span>
                <small>{die.held ? "HOLD" : ""}</small>
              </button>
            ))}
          </div>
          <button
            className="button accent roll-button"
            disabled={!canRoll}
            onClick={onRoll}
            type="button"
          >
            {busy ? "처리 중..." : game.rollsUsed === 0 ? "주사위 굴리기" : "다시 굴리기"}
          </button>
          {!isMyTurn && game.phase === "PLAYING" && (
            <p className="control-hint">현재 플레이어의 선택을 기다리고 있습니다.</p>
          )}
        </div>

        <div className="score-summary card">
          <p className="eyebrow">MY SCORE</p>
          <strong>{selfPlayerId ? game.scoreCards[selfPlayerId]?.total ?? 0 : 0}</strong>
          <span>점</span>
          <small>
            {selfPlayerId ? game.scoreCards[selfPlayerId]?.completedCategories ?? 0 : 0} / 12 categories
          </small>
        </div>
      </div>

      <ScoreBoard
        busy={busy}
        isMyTurn={isMyTurn}
        onConfirmScore={confirmScore}
        playersById={playersById}
        room={room}
        selfPlayerId={selfPlayerId}
      />

      <div className="game-footer-actions">
        <button className="button danger" disabled={busy} onClick={onLeave} type="button">
          방 나가기
        </button>
      </div>
    </section>
  );
}

function ScoreBoard({
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

  function categoryRow(category: ScoreCategory): ReactElement {
    return (
      <tr key={category}>
        <th scope="row">{categoryLabels[category]}</th>
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
            <td className={playerId === selfPlayerId ? "self-column" : ""} key={playerId}>
              {score !== null ? (
                <strong>{score}</strong>
              ) : preview !== undefined && playerId === game.currentPlayerId ? (
                <button
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
    key: "upperSubtotal" | "upperBonus" | "lowerSubtotal" | "total",
    className = "derived-row",
  ): ReactElement {
    return (
      <tr className={className}>
        <th scope="row">{label}</th>
        {game.playerOrder.map((playerId) => (
          <td className={playerId === selfPlayerId ? "self-column" : ""} key={playerId}>
            <strong>{game.scoreCards[playerId]![key]}</strong>
          </td>
        ))}
      </tr>
    );
  }

  return (
    <div className="scoreboard-card card">
      <div className="scoreboard-heading">
        <div>
          <p className="eyebrow">SCORE CARD</p>
          <h2>점수판</h2>
        </div>
        <p>괄호 점수는 현재 Roll의 예상 점수입니다.</p>
      </div>
      <div className="score-table-scroll">
        <table className="score-table">
          <thead>
            <tr>
              <th scope="col">Category</th>
              {game.playerOrder.map((playerId) => (
                <th className={playerId === selfPlayerId ? "self-column" : ""} key={playerId} scope="col">
                  {playersById.get(playerId)?.isHost && <span className="host-star">★ </span>}
                  {playersById.get(playerId)?.nickname ?? "Unknown"}
                  {playerId === selfPlayerId && <small>나</small>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {UPPER_CATEGORIES.map(categoryRow)}
            {derivedRow("Upper subtotal", "upperSubtotal")}
            {derivedRow("Bonus (63+)", "upperBonus", "derived-row bonus-row")}
            <tr className="section-break"><th colSpan={game.playerOrder.length + 1}>Lower section</th></tr>
            {LOWER_CATEGORIES.map(categoryRow)}
            {derivedRow("Lower subtotal", "lowerSubtotal")}
            {derivedRow("TOTAL", "total", "total-row")}
          </tbody>
        </table>
      </div>
    </div>
  );
}
