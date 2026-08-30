# Yacht Dice Online

Yacht Dice Online의 Phase 0 + Phase 1 구현입니다. `/yacht/` 하위 경로에서 동작하는 React 클라이언트, Node.js HTTP/WebSocket 서버, 서버 권위형 멀티플레이 로비를 제공합니다. Yacht 주사위 게임 자체는 아직 포함하지 않습니다.

## Architecture

```text
Browser /yacht/
  ├─ HTTP: React production bundle
  └─ WS: /yacht/ws
          ↓
Node.js HTTP + ws server :3000
          ↓
in-memory RoomService (authoritative state)

Production: Nginx → 127.0.0.1:18081 → Docker :3000
```

Room과 세션은 메모리에만 유지되므로 서버 프로세스가 재시작되면 사라집니다. 클라이언트는 방별 session token을 `localStorage`에 저장하며, 공개 `ROOM_VIEW`에는 토큰이 포함되지 않습니다.

## Directory structure

```text
src/                 HTTP, WebSocket, protocol, RoomService
client/src/          React lobby UI와 브라우저 protocol type
tests/               RoomService 및 실제 WebSocket 통합 테스트
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
WS  /yacht/ws                  lobby protocol
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
```

주요 server event는 `SESSION_ESTABLISHED`, `ROOM_VIEW`, `COMMAND_OK`, `LEFT`, `ERROR`, `DIAGNOSTIC_PONG`입니다. 모든 client message는 Zod strict schema로 검증됩니다.

## Lobby rules

- 2~8명, 기본 최대 인원 8명
- trim/NFC 정규화된 1~20자 Unicode 닉네임과 방 내 대소문자 무시 중복 방지
- Node `crypto` 기반 Room ID, Player ID, session token
- 연결 종료 후 기본 60초 동안 `DISCONNECTED_GRACE` 유지
- 명시적 퇴장 또는 grace 만료 시 가장 먼저 참가한 connected player에게 Host 이전
- Host를 포함한 모든 플레이어가 Ready이고 2명 이상일 때만 Host가 시작 가능
- `STARTED` 방에는 신규 참가자나 spectator를 허용하지 않음
- 상태 변경마다 revision 증가 및 전체 참가자에게 authoritative snapshot broadcast

## Docker

```bash
cd /var/www/yacht
docker compose build
docker compose up -d
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

Phase 2에서 주사위 Roll/Hold, 점수 계산과 score board, turn 진행, 게임 종료 및 Yacht rule engine을 구현합니다.
