# Yacht Dice Online

Yacht Dice Online의 Phase 0~2 구현입니다. `/yacht/` 하위 경로에서 2~8명이 로비를 만들고 실제 Yacht Dice `RULESET_V1` 게임을 끝까지 플레이할 수 있습니다. 주사위, 점수, 턴, 승자는 모두 서버가 결정합니다.

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
client/src/          React lobby, GameBoard, score board, browser protocol type
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
ROLL_DICE
SET_HELD_DICE
SCORE_CATEGORY
```

주요 server event는 `SESSION_ESTABLISHED`, `ROOM_VIEW`, `COMMAND_OK`, `GAME_ABORTED`, `LEFT`, `ERROR`, `DIAGNOSTIC_PONG`입니다. 모든 client message는 Zod strict schema로 검증됩니다. 게임 명령은 최신 `ROOM_VIEW.revision`을 `expectedRevision`으로 보내며 stale 명령은 거절 후 최신 snapshot으로 resync됩니다.

## Lobby rules

- 2~8명, 기본 최대 인원 8명
- trim/NFC 정규화된 1~20자 Unicode 닉네임과 방 내 대소문자 무시 중복 방지
- Node `crypto` 기반 Room ID, Player ID, session token
- 연결 종료 후 기본 60초 동안 `DISCONNECTED_GRACE` 유지
- 명시적 퇴장 또는 grace 만료 시 가장 먼저 참가한 connected player에게 Host 이전
- Host를 포함한 모든 플레이어가 Ready이고 2명 이상일 때만 Host가 시작 가능
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

## Disconnect policy

일시 disconnect에서는 기존 60초 grace 동안 dice, Hold, Roll 횟수, score card와 현재 턴을 그대로 보존하며 자동으로 턴을 넘기지 않습니다. 게임 중 명시적 퇴장 또는 grace 만료가 발생하면 게임을 abort하고 남은 방을 Ready가 초기화된 `LOBBY`로 되돌립니다. Host 이전은 기존 join order 규칙을 유지합니다.

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

현재 범위에는 AI, spectator, chat, account, database, match history, leaderboard, rematch, custom rules, sound 및 3D dice가 포함되지 않습니다.
