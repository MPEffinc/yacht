# Yacht Dice Online

Yacht Dice Online의 서버 권위형 구현입니다. `/yacht/` 하위 경로에서 2~6석 테이블을 만들고 Human과 server-owned BOT을 자유롭게 조합할 수 있습니다. 주사위, 점수, 턴, 승자는 모두 서버가 결정합니다.

## Architecture

```text
Browser /yacht/
  ├─ HTTP: React production bundle
  └─ WS: /yacht/ws
          ↓
Node.js HTTP + ws server :3000
          ↓
in-memory RoomService + Yacht game state machine
  ├─ crypto dice RNG
  ├─ pure scoring rules
  └─ authoritative turn/score/winner state

Production: Nginx → 127.0.0.1:18081 → Docker :3000
```

Room과 세션은 메모리에만 유지되므로 서버 프로세스가 재시작되면 사라집니다. 클라이언트는 방별 session token을 `localStorage`에 저장하며, 공개 `ROOM_VIEW`에는 토큰이 포함되지 않습니다.

## Directory structure

```text
src/                 HTTP, WebSocket, protocol, RoomService
src/game/            Yacht types, pure scoring, game state machine
src/bot/             Monte Carlo 정책, simulation RNG, BOT turn controller
client/src/          React lobby, GameBoard, score board, browser protocol 및 audio director
client/src/audio/    Vite가 fingerprint하는 Yacht BGM/Dice/System audio assets
tests/               scoring/game/RoomService 및 실제 WebSocket 통합 테스트
deploy/nginx/        Nginx location 설정 예시
Dockerfile           multi-stage production image
compose.yaml         127.0.0.1:18081 전용 서비스
```

## Local development and verification

Node.js 22 이상이 필요합니다.

```bash
cd /var/www/yacht
npm install
npm test
npm run typecheck
npm run build
npm start
```

`npm start`는 production build를 `0.0.0.0:3000`에서 제공합니다. 프런트엔드 UI만 빠르게 작업할 때는 `npm run dev`를 사용할 수 있지만, WebSocket과 API까지 확인하려면 production build 후 `npm start` 또는 Docker를 사용합니다.

## Endpoints

```text
GET /yacht/                    React SPA
GET /yacht/r/{ROOM_ID}         invite URL SPA fallback
GET /yacht/api/health          {"ok":true}
WS  /yacht/ws                  lobby + game protocol
```

WebSocket client command:

```text
DIAGNOSTIC_PING
CREATE_ROOM
JOIN_ROOM
RECONNECT_ROOM
LEAVE_ROOM
SET_READY
START_GAME
ADD_BOT
REMOVE_BOT
SET_BOT_DIFFICULTY
ROLL_DICE
SET_HELD_DICE
SCORE_CATEGORY
RETURN_TO_LOBBY
```

주요 server event는 `SESSION_ESTABLISHED`, `ROOM_VIEW`, `COMMAND_OK`, `GAME_ABORTED`, `LEFT`, `ERROR`, `DIAGNOSTIC_PONG`입니다. 모든 client message는 Zod strict schema로 검증됩니다. 게임 명령은 최신 `ROOM_VIEW.revision`을 `expectedRevision`으로 보내며 stale 명령은 거절 후 최신 snapshot으로 resync됩니다.

## Lobby rules

- 2~6명, 기본 최대 인원 2명
- trim/NFC 정규화된 1~20자 Unicode 닉네임과 방 내 대소문자 무시 중복 방지
- Node `crypto` 기반 Room ID, Player ID, session token
- 연결 종료 후 기본 60초 동안 `DISCONNECTED_GRACE` 유지
- 명시적 퇴장 또는 grace 만료 시 가장 먼저 참가한 connected player에게 Host 이전
- Host가 빈 seat를 눌러 최대 인원까지 BOT을 추가하고 BOT별 `NORMAL`/`HARD`를 설정하거나 제거 가능
- 모든 Human이 연결되어 있고 Host 이외 Human guest가 Ready이며 전체 참가자가 2명 이상일 때 Host가 시작 가능; BOT은 Ready 불필요
- BOT은 session/reconnect가 없고 Host가 될 수 없으며 Host 이전 후보에서도 제외
- `STARTED` 방에는 신규 참가자나 spectator를 허용하지 않음
- 상태 변경마다 revision 증가 및 전체 참가자에게 authoritative snapshot broadcast

## Yacht RULESET_V1

- 6면체 주사위 5개, 턴당 최대 3회 Roll
- 첫 Roll은 5개 전체, 이후에는 Hold하지 않은 주사위만 다시 Roll
- 한 번 이상 Roll한 뒤 아직 사용하지 않은 category 하나를 확정하여 턴 종료
- 조건을 만족하지 않는 category도 0점으로 기록 가능하며, `null`(미사용)과 `0`(사용 완료)을 구분
- 고정된 join order로 턴을 순환하며 각 플레이어가 12개 category를 모두 채우면 종료
- 동점이면 모든 최고점 플레이어를 공동 승자로 반환

Selectable category 12개:

```text
ONES  TWOS  THREES  FOURS  FIVES  SIXES
CHOICE  FOUR_OF_A_KIND  FULL_HOUSE
SMALL_STRAIGHT  LARGE_STRAIGHT  YACHT
```

Upper 6개 합이 63점 이상이면 derived bonus +35점입니다. Choice는 전체 합, Four of a Kind는 같은 눈 4개 이상일 때 전체 합, Full House는 3+2 조합 또는 같은 눈 5개(Yacht)일 때 전체 합입니다. Small Straight는 연속 4개 포함 시 15점, Large Straight는 정확한 연속 5개일 때 30점, Yacht는 같은 눈 5개일 때 50점입니다. 추가 Yacht bonus나 Joker rule은 없으며 이 규칙에서 가능한 이론상 최고점은 325점입니다.

점수 규칙과 게임 화면 용어는 Nintendo Switch의 *51 Worldwide Games / Clubhouse Games: 51 Worldwide Classics*에 수록된 Yacht Dice와 호환되도록 구성했습니다. 이 프로젝트는 독립적인 비공식 구현이며 Nintendo와 제휴하거나 Nintendo의 승인을 받은 제품이 아닙니다.

## Game state and turn flow

`ROOM_VIEW.game`은 시작 전 `null`이고 시작 후 다음 authoritative 정보를 포함합니다.

```text
phase, playerOrder, currentPlayerId
dice, rollsUsed, rollsRemaining
scoreCards, availableScores
round, completedTurns, winnerPlayerIds
```

각 score card에는 확정 점수와 `upperSubtotal`, `upperBonus`, `lowerSubtotal`, `total`, `completedCategories`가 포함됩니다. 한 번 이상 Roll하면 서버가 현재 플레이어의 모든 미사용 category preview를 계산합니다. 클라이언트는 서버가 준 preview를 표시하고 category 의도만 전송합니다.

```text
START_GAME → 초기 dice(null) → ROLL_DICE
→ SET_HELD_DICE / ROLL_DICE (최대 3회)
→ SCORE_CATEGORY → 다음 플레이어
→ 모든 score card 완료 → FINISHED / 공동 승자 계산
```

Production dice는 Node `crypto.randomInt(1, 7)`을 사용하며 테스트에서는 deterministic roller를 주입합니다.

## Multiplayer BOT

BOT은 전용 single-player mode가 아니라 일반 Room의 participant입니다. HOME에서 테이블을 만든 뒤 Host가 최대 인원만큼 표시되는 빈 seat의 `ADD BOT`을 누릅니다. 각 BOT은 고유한 `YACHT BOT N` 이름, null session token, 독립적인 `NORMAL`/`HARD` 난이도를 가지며 여러 BOT과 Human을 원하는 순서로 함께 둘 수 있습니다. 모든 connected Human이 사라지면 BOT-only room은 삭제됩니다.

두 난이도는 실제 결과와 분리된 simulation PRNG로 31개의 합법적인 KEEP mask를 각각 192회 Monte Carlo 평가합니다. 점수 utility는 raw score, upper bonus와 달성 가능성, 남은 category 수에 따른 sacrifice cost, 낮은 Choice reserve, Large Straight 전략 보정을 포함합니다. `HARD`는 이 strong Monte Carlo/heuristic policy의 최고 utility 행동을 선택합니다. `NORMAL`도 같은 평가를 사용하지만 최고점과 utility 차이가 4 이하인 상위 3개 행동 중 72%/20%/8%로 선택해 가끔 합리적인 차선책을 둡니다. 빠진 차선 후보의 확률은 최고 행동으로 돌아갑니다.

실제 Roll/KEEP/Score는 Human과 똑같이 `RoomService.rollDice`, `setHeldDice`, `scoreCategory`를 거치므로 production dice는 계속 crypto RNG가 결정합니다. BOT presentation random도 simulation/선택/실제 dice RNG와 분리됩니다. Turn 시작 1.2–2.0초, Roll 결과 확인은 Normal 2.0–3.1초·Hard 2.5–3.8초, KEEP 뒤 1.0–1.6초, Score 전 1.5–2.5초 범위의 jitter를 사용하며 Special/Yacht 조합은 alert를 볼 수 있도록 더 기다립니다.

## Disconnect policy

일시 disconnect에서는 기존 60초 grace 동안 dice, KEEP, Roll 횟수, score card와 현재 턴을 그대로 보존하며 자동으로 턴을 넘기지 않습니다. 게임 중 명시적 퇴장 또는 grace 만료가 발생하면 게임을 abort하고 남은 방을 Ready가 초기화된 `LOBBY`로 되돌립니다. 정상적으로 `FINISHED`된 게임에서 나가는 경우도 roster/scorecard 불일치를 피하기 위해 Lobby로 돌아가지만 `GAME_ABORTED` notice는 보내지 않습니다. Host 이전은 기존 join order 규칙을 유지합니다.

## Gameplay polish and rematch

Roll 결과는 항상 server-authoritative snapshot으로 먼저 확정되며, 브라우저는 실제로 다시 굴린 주사위에만 짧은 presentation animation을 적용합니다. 모든 주사위를 KEEP한 재굴림은 서버와 클라이언트가 함께 차단합니다. 점수와 진행 중 퇴장은 자체 confirmation dialog로 확인하며, reconnect 후에는 보존된 authoritative state를 그대로 복구합니다.

경기 종료 후 Host가 `RETURN_TO_LOBBY`를 보내면 같은 room/player/session과 BOT 난이도를 유지한 채 Human Ready만 초기화합니다. Lobby에서 BOT을 추가·제거하거나 난이도를 바꿀 수 있고, Human guest가 다시 Ready한 뒤 Host가 `START_GAME`을 실행해야 새 점수표와 주사위 상태로 재경기가 시작됩니다.

## Audio

브라우저 오디오는 Web Audio API 기반이며 첫 `pointerdown` 또는 `keydown`에서 Safari/iOS 호환 silent-buffer 방식으로 unlock합니다. Home/Join/Lobby는 lobby BGM, Playing은 main BGM을 loop하며 게임 시작 때 crossfade하고 결과 화면에서는 BGM을 낮춘 뒤 플레이어별 victory/loss cue를 재생합니다.

Roll sound는 로컬 버튼 클릭이 아니라 authoritative `ROOM_VIEW`의 `rollsUsed` 증가를 관찰하므로 모든 플레이어가 함께 듣습니다. 3개의 shake와 3개의 throw sample에서 각각 서로 다른 2개를 골라 같은 시각에 겹쳐 재생하고, 직전 조합과 같은 pair는 피하는 presentation-only random을 사용합니다. Roll 연출이 끝나면 서버가 확정한 `matchedCombinations`에 따라 normal/special/Yacht alert를 재생하며 Yacht alert는 special alert에 우선합니다. 예상 점수는 Roll 애니메이션과 결과 alert가 시작되기 전에는 가려서 최종 눈금을 미리 노출하지 않습니다.

점수 기록음은 authoritative score card에서 한 category가 `null`에서 숫자로 바뀌고 `completedTurns`가 정확히 1 증가했을 때만 alert와 pencil을 같은 시각에 겹쳐 재생합니다. reconnect의 첫 snapshot은 baseline으로만 사용하므로 기존 Roll과 점수 기록음을 다시 재생하지 않습니다. Turn 전환은 화면 표시만 사용하며 별도 `your_turn` SFX는 재생하지 않습니다. 우측 상단 Audio 설정에서 BGM/SFX 볼륨과 mute를 조절할 수 있고 `yacht.audio.preferences.v1`에 저장됩니다.

## Docker

```bash
cd /var/www/yacht
docker compose build
docker compose up -d --no-deps yacht-app
docker compose ps
curl -i http://127.0.0.1:18081/yacht/api/health
curl -i http://127.0.0.1:18081/yacht/
```

Compose는 `127.0.0.1:18081`만 사용합니다. 기존 Muffin의 container와 `127.0.0.1:18080`은 사용하거나 변경하지 않습니다.

## Nginx deployment

[`deploy/nginx/yacht.conf`](deploy/nginx/yacht.conf)는 `jmouse.duckdns.org`의 기존 HTTPS `server` block 안에 include할 location snippet입니다. Codex는 `/etc/nginx`를 수정하거나 Nginx를 reload하지 않습니다. 서버 관리자가 실제 site 파일 경로를 확인한 뒤 다음과 같이 설치합니다.

```bash
sudo cp /var/www/yacht/deploy/nginx/yacht.conf /etc/nginx/snippets/yacht.conf
sudoedit /etc/nginx/sites-available/<jmouse-site-file>
```

HTTPS `server { ... }` 안에 아래 한 줄을 추가합니다.

```nginx
include /etc/nginx/snippets/yacht.conf;
```

그 후 관리자가 검증하고 반영합니다.

```bash
sudo nginx -t
sudo systemctl reload nginx
```

## Scope

Phase 0은 React/TypeScript/Vite production build, Node HTTP server, health endpoint, Zod WebSocket transport, Docker와 `/yacht/` base path를 포함합니다.

Phase 1은 방 생성/참가/나가기, 세션 재접속, Host 이전, Ready/시작 조건, invite URL, 서버 권위형 room snapshot을 포함합니다.

Phase 2는 crypto Roll, Hold, 12개 category scoring, +35 upper bonus, score preview/board, turn/round 진행, 완료/공동 승자, revision 보호와 게임 중 이탈 abort를 포함합니다.

Phase 3는 authoritative Roll animation presentation, 점수/퇴장 확인 dialog, 턴 전환 안내, all-KEEP 보호, reconnect/stale revision UX, 정상 종료 lifecycle 보정과 같은 방 Lobby를 재사용하는 동의 기반 rematch를 포함합니다.

현재 범위에는 Normal BOT 한 명을 제외한 난이도 선택/다중 BOT, spectator, chat, account, database, match history, leaderboard, custom rules 및 3D dice가 포함되지 않습니다.
