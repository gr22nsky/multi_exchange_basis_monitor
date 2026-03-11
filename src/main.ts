import './style.css';

type Exchange = 'binance' | 'okx' | 'bybit';
type MarketKind = 'spot' | 'perp';

interface Quote {
  bid: number;
  ask: number;
  mid: number;
  ts: number;
}

interface CoinSnapshot {
  base: string;
  rankingVolume: number;
  exchanges: Record<Exchange, { spot: Quote | null; perp: Quote | null }>;
  bestSpot: { exchange: Exchange; mid: number; ts: number } | null;
  bestPerp: { exchange: Exchange; mid: number; ts: number } | null;
  premiumPct: number | null;
  ready: boolean;
}

interface DashboardSnapshot {
  coins: CoinSnapshot[];
  leader: CoinSnapshot | null;
  updatedAt: number;
  staleAfterMs: number;
  streamHealth: Record<Exchange, Record<MarketKind, 'connected' | 'disconnected'>>;
  exchangeLatencyMs: Record<Exchange, number | null>;
}

const app = document.querySelector<HTMLDivElement>('#app');

if (!app) {
  throw new Error('App container not found');
}

app.innerHTML = `
  <main class="shell">
    <section class="hero">
      <div class="hero-copy">
        <p class="eyebrow">Realtime Monitor</p>
        <h1>Multi-Exchange Basis Monitor</h1>
      </div>
    </section>

    <section class="summary-grid">
      <article class="card accent accent-top" id="leader-card"></article>
      <article class="card">
        <h2>스트림 상태</h2>
        <div class="updated-at-wrap">
          <span class="status-label">마지막 갱신</span>
          <strong id="updated-at">연결 대기 중</strong>
        </div>
        <div id="stream-health" class="stream-health"></div>
      </article>
      <article class="card">
        <h2>계산 기준</h2>
        <ul class="rules">
          <li>대상 코인은 Binance, OKX, Bybit 세 거래소에 모두 존재하는 USDT 현물과 USDT 무기한 퍼페추얼만 사용합니다.</li>
          <li>스테이블코인은 제외하고, 세 거래소 spot 24시간 USDT 거래대금을 합산해 상위 10개 코인을 선정합니다.</li>
          <li>가격은 각 시장의 최우선 매수호가와 매도호가의 중간값인 미드 가격으로 계산합니다.</li>
          <li>코인별로 세 거래소 중 가장 낮은 spot 미드와 가장 높은 perp 미드를 찾아 실시간 basis를 계산합니다.</li>
          <li>프리미엄 공식은 (최고 perp - 최저 spot) / 최저 spot × 100 이며, 가장 높은 값을 상단에 강조합니다.</li>
        </ul>
      </article>
    </section>

    <section class="card table-card">
      <div class="table-header">
        <div>
          <p class="eyebrow small">Realtime Table</p>
          <h2>거래소별 Spot / Perp 미드</h2>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>코인</th>
              <th>Binance Spot</th>
              <th>Binance Perp</th>
              <th>OKX Spot</th>
              <th>OKX Perp</th>
              <th>Bybit Spot</th>
              <th>Bybit Perp</th>
              <th>최저 Spot</th>
              <th>최고 Perp</th>
              <th>프리미엄</th>
            </tr>
          </thead>
          <tbody id="coin-table-body"></tbody>
        </table>
      </div>
    </section>
  </main>
`;

const updatedAtEl = document.querySelector<HTMLElement>('#updated-at')!;
const leaderCardEl = document.querySelector<HTMLElement>('#leader-card')!;
const streamHealthEl = document.querySelector<HTMLElement>('#stream-health')!;
const coinTableBodyEl = document.querySelector<HTMLElement>('#coin-table-body')!;

function formatMoney(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return '-';
  }

  if (value >= 1000) {
    return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  if (value >= 1) {
    return value.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
  }

  return value.toLocaleString('en-US', { minimumFractionDigits: 6, maximumFractionDigits: 6 });
}

function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return '-';
  }

  return `${value.toFixed(3)}%`;
}

function formatRelativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 2) {
    return '방금 전';
  }

  return `${seconds}초 전`;
}

function renderLeader(leader: CoinSnapshot | null): void {
  if (!leader || leader.premiumPct === null || !leader.bestSpot || !leader.bestPerp) {
    leaderCardEl.innerHTML = `
      <p class="eyebrow small">Largest Gap</p>
      <div class="leader-body">
        <h2>계산 가능한 데이터 대기 중</h2>
        <p class="muted">세 거래소의 spot/perp 호가가 들어오면 최대 프리미엄 조합을 표시합니다.</p>
      </div>
    `;
    return;
  }

  leaderCardEl.innerHTML = `
    <p class="eyebrow small">Largest Gap</p>
    <div class="leader-body">
      <h2>${leader.base}</h2>
      <div class="leader-metric">${formatPercent(leader.premiumPct)}</div>
      <p class="leader-route">
        ${leader.bestSpot.exchange.toUpperCase()} Spot ${formatMoney(leader.bestSpot.mid)}
        <span>→</span>
        ${leader.bestPerp.exchange.toUpperCase()} Perp ${formatMoney(leader.bestPerp.mid)}
      </p>
    </div>
  `;
}

function renderStreamHealth(snapshot: DashboardSnapshot): void {
  const items = (Object.entries(snapshot.streamHealth) as Array<
    [Exchange, Record<MarketKind, 'connected' | 'disconnected'>]
  >)
    .map(([exchange, health]) => {
      const spotClass = health.spot === 'connected' ? 'is-up' : 'is-down';
      const perpClass = health.perp === 'connected' ? 'is-up' : 'is-down';
      const latency = snapshot.exchangeLatencyMs[exchange];

      return `
        <div class="exchange-health">
          <div>
            <strong>${exchange.toUpperCase()}</strong>
            <div class="latency">${latency === null ? '-' : `${latency} ms`}</div>
          </div>
          <div class="chips">
            <span class="chip ${spotClass}">Spot</span>
            <span class="chip ${perpClass}">Perp</span>
          </div>
        </div>
      `;
    })
    .join('');

  streamHealthEl.innerHTML = items;
}

function createPriceCell(quote: Quote | null, staleAfterMs: number): string {
  if (!quote) {
    return '<span class="value missing">-</span>';
  }

  const stale = Date.now() - quote.ts > staleAfterMs;
  return `
    <span class="value ${stale ? 'stale' : ''}">${formatMoney(quote.mid)}</span>
    <span class="meta">${formatRelativeTime(quote.ts)}</span>
  `;
}

function renderTable(snapshot: DashboardSnapshot): void {
  coinTableBodyEl.innerHTML = snapshot.coins
    .map((coin) => {
      const bestSpotLabel = coin.bestSpot
        ? `${coin.bestSpot.exchange.toUpperCase()} ${formatMoney(coin.bestSpot.mid)}`
        : '-';
      const bestPerpLabel = coin.bestPerp
        ? `${coin.bestPerp.exchange.toUpperCase()} ${formatMoney(coin.bestPerp.mid)}`
        : '-';

      return `
        <tr>
          <td>
            <div class="coin-cell">
              <strong>${coin.base}</strong>
              <span>${coin.ready ? 'LIVE' : 'WAIT'}</span>
            </div>
          </td>
          <td>${createPriceCell(coin.exchanges.binance.spot, snapshot.staleAfterMs)}</td>
          <td>${createPriceCell(coin.exchanges.binance.perp, snapshot.staleAfterMs)}</td>
          <td>${createPriceCell(coin.exchanges.okx.spot, snapshot.staleAfterMs)}</td>
          <td>${createPriceCell(coin.exchanges.okx.perp, snapshot.staleAfterMs)}</td>
          <td>${createPriceCell(coin.exchanges.bybit.spot, snapshot.staleAfterMs)}</td>
          <td>${createPriceCell(coin.exchanges.bybit.perp, snapshot.staleAfterMs)}</td>
          <td><span class="value">${bestSpotLabel}</span></td>
          <td><span class="value">${bestPerpLabel}</span></td>
          <td><span class="premium ${coin.premiumPct !== null && coin.premiumPct > 0 ? 'positive' : ''}">${formatPercent(coin.premiumPct)}</span></td>
        </tr>
      `;
    })
    .join('');
}

function render(snapshot: DashboardSnapshot): void {
  updatedAtEl.textContent = new Date(snapshot.updatedAt).toLocaleString('ko-KR');
  renderLeader(snapshot.leader);
  renderStreamHealth(snapshot);
  renderTable(snapshot);
}

async function loadInitialSnapshot(): Promise<void> {
  const response = await fetch('/api/snapshot');
  if (!response.ok) {
    throw new Error(`snapshot request failed: ${response.status}`);
  }

  render((await response.json()) as DashboardSnapshot);
}

function subscribe(): void {
  const source = new EventSource('/api/stream');
  source.addEventListener('snapshot', (event) => {
    render(JSON.parse((event as MessageEvent<string>).data) as DashboardSnapshot);
  });
  source.onerror = () => {
    source.close();
    setTimeout(subscribe, 2000);
  };
}

loadInitialSnapshot()
  .catch((error) => {
    console.error(error);
    leaderCardEl.innerHTML = `
      <p class="eyebrow small">Largest Gap</p>
      <div class="leader-body">
        <h2>데이터 로드 실패</h2>
        <p class="muted">백엔드 연결 상태를 확인하세요.</p>
      </div>
    `;
  })
  .finally(() => {
    subscribe();
  });
