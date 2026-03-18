# Multi-Exchange Basis Monitor

Binance, OKX, Bybit 3개 거래소의 `현물(spot)`과 `무기한 퍼페추얼(perp)` 오더북 최우선 호가를 웹소켓으로 수집하고, 코인별 `basis(선물 프리미엄)`를 실시간으로 모니터링하는 웹 프로젝트입니다.

현재 페이지는 아래 내용을 보여줍니다.

- 세 거래소 공통 코인의 거래소별 `spot / perp` 미드 가격
- 코인별 `최저 spot`, `최고 perp`, `premium %`
- 전체 코인 중 `가장 큰 gap` 조합
- 거래소별 스트림 연결 상태와 최신 데이터 지연값(ms)
- `0.5% 이상 gap` 발생 기록과 유지시간(record tab)

## 계산 기준

- 대상 거래소: `Binance`, `OKX`, `Bybit`
- 대상 시장: `USDT 현물`, `USDT 무기한 퍼페추얼`
- 대상 코인:
  - 세 거래소 모두에 `spot + perp`가 존재하는 코인만 사용
  - `USDT`, `USDC`, `BUSD`, `FDUSD`, `TUSD`, `USDE`, `DAI`, `USDD`, `PYUSD`, `EURC` 같은 스테이블 코인은 제외
  - 세 거래소의 `spot 24시간 USDT 거래대금` 합산 기준 상위 10개를 선택
- 가격 계산:
  - `mid = (best bid + best ask) / 2`
- 프리미엄 계산:
  - 각 코인별로 세 거래소 중 `가장 낮은 spot mid`
  - 세 거래소 중 `가장 높은 perp mid`
  - `premium(%) = (최고 perp - 최저 spot) / 최저 spot * 100`
- 기록 저장:
  - `premium >= 0.5%`가 되면 gap event를 SQLite DB에 저장
  - 저장 항목: `코인`, `spot 거래소`, `spot 가격`, `perp 거래소`, `perp 가격`, `gap`, `발생시간`, `유지시간`
  - gap이 유지되는 동안 duration을 계속 갱신하고, 조건이 깨지면 record를 종료

## 화면 구성

- `Largest Gap`
  - 현재 가장 premium이 큰 코인
  - `어느 거래소의 spot`이 가장 낮은지
  - `어느 거래소의 perp`가 가장 높은지
- `스트림 상태`
  - 거래소별 `spot / perp` 연결 상태
  - 거래소별 최신 데이터 기준 지연값(ms)
  - 마지막 스냅샷 갱신 시각
- `계산 기준`
  - 집계 대상과 계산 공식 요약
- `Realtime Table`
  - 코인별 거래소별 `spot / perp` 미드
  - 코인별 `최저 spot`, `최고 perp`, `premium`
- `Record`
  - 0.5% 이상 gap 이벤트 저장 목록
  - 활성 상태 여부, 유지시간, 발생시간 확인

## 기술 스택

- Frontend: `Vite`, `TypeScript`
- Backend: `Node.js`, `Express`, `ws`, `TypeScript`
- Storage: `SQLite (node:sqlite)`
- Streaming:
  - 거래소 웹소켓 수집
  - 브라우저에는 `SSE(Server-Sent Events)`로 스냅샷 전달

## 프로젝트 구조

```text
.
├─ server/
│  ├─ src/
│  │  ├─ exchanges.ts   # 거래소 메타데이터/심볼 선택/상위 코인 선정
│  │  ├─ records.ts     # gap record SQLite 저장/조회
│  │  ├─ service.ts     # 웹소켓 연결, 미드 계산, 스냅샷 집계
│  │  ├─ index.ts       # Express API + SSE + 정적 파일 서빙
│  │  └─ types.ts       # 공통 타입
│  └─ dist/             # 서버 빌드 결과물
├─ src/
│  ├─ main.ts           # 대시보드 렌더링
│  └─ style.css         # UI 스타일
├─ dist/client/         # 프론트 빌드 결과물
├─ package.json
└─ README.md
```

## 실행 방법

### 1. 의존성 설치

```bash
npm install
```

### 2. 개발 서버 실행

```bash
npm run dev
```

실행 후:

- 브라우저: `http://localhost:5173`

### 3. 타입 체크

```bash
npm run check
```

### 4. 프로덕션 빌드

```bash
npm run build
```

### 5. 빌드 후 서버 실행

```bash
npm start
```

## API

### `GET /api/health`

서버 생존 확인용 엔드포인트입니다.

### `GET /api/snapshot`

현재 집계된 스냅샷 JSON을 반환합니다.

포함 내용:

- 코인별 거래소 가격
- `bestSpot`
- `bestPerp`
- `premiumPct`
- `leader`
- 거래소별 스트림 상태
- 거래소별 데이터 지연값(ms)

### `GET /api/stream`

브라우저 대시보드가 구독하는 `SSE` 스트림입니다.
현재는 1초마다 전체 스냅샷을 전송합니다.

### `GET /api/records`

저장된 gap record 목록을 반환합니다.
대시보드는 현재 `/api/snapshot`의 `records` 필드도 함께 사용합니다.

## 데이터 흐름

1. 서버가 각 거래소 REST API로 상장 심볼과 24시간 거래량을 조회합니다.
2. 세 거래소에 모두 존재하는 `USDT spot + USDT perp` 코인을 찾습니다.
3. 스테이블코인을 제외하고, `spot 24h 거래대금` 기준 상위 10개를 선택합니다.
4. 선택된 코인만 각 거래소 웹소켓에 구독합니다.
5. 서버가 최우선 호가를 받아 `mid` 가격을 계산합니다.
6. 코인별 `최저 spot / 최고 perp / premium`을 계산합니다.
7. `premium >= 0.5%`이면 SQLite DB에 gap event를 기록하고 duration을 갱신합니다.
8. 브라우저는 `/api/stream`을 통해 1초마다 최신 스냅샷을 반영합니다.

## 현재 구현 메모

- 대상 코인 수는 현재 `10개 고정`입니다.
- 단, 어떤 코인이 상위 10개에 들어오는지는 거래량에 따라 바뀔 수 있습니다.
- 대상 코인 목록은 서버에서 `30분마다` 다시 계산합니다.
- 가격 freshness 판정 기준은 현재 `15초`입니다.
- gap record DB 파일은 `data/gap-records.sqlite`에 생성됩니다.
- 거래소 응답 구조 차이 때문에 각 거래소별 심볼/오더북 파싱 로직이 분리되어 있습니다.

## 공식 문서

- Binance: https://developers.binance.com/docs
- OKX: https://www.okx.com/docs-v5/en/
- Bybit: https://bybit-exchange.github.io/docs/v5/intro
