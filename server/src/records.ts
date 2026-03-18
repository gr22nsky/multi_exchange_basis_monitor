import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Exchange, GapRecord } from './types.js';

export const GAP_RECORD_THRESHOLD_PCT = 0.5;
const DEFAULT_DB_PATH = path.resolve(process.cwd(), 'data', 'gap-records.sqlite');

interface CreateGapRecordInput {
  base: string;
  spotExchange: Exchange;
  spotPrice: number;
  perpExchange: Exchange;
  perpPrice: number;
  premiumPct: number;
  startedAt: number;
}

interface UpdateGapRecordInput {
  spotPrice: number;
  perpPrice: number;
  premiumPct: number;
  lastSeenAt: number;
  durationMs: number;
}

export class GapRecordStore {
  private readonly db: DatabaseSync;

  constructor(dbPath = DEFAULT_DB_PATH) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS gap_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        base TEXT NOT NULL,
        spot_exchange TEXT NOT NULL,
        spot_price REAL NOT NULL,
        perp_exchange TEXT NOT NULL,
        perp_price REAL NOT NULL,
        premium_pct REAL NOT NULL,
        started_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_gap_records_started_at ON gap_records(started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_gap_records_is_active ON gap_records(is_active, started_at DESC);
    `);

    this.db.prepare('UPDATE gap_records SET is_active = 0 WHERE is_active = 1').run();
  }

  close(): void {
    this.db.close();
  }

  createRecord(input: CreateGapRecordInput): number {
    const result = this.db
      .prepare(`
        INSERT INTO gap_records (
          base,
          spot_exchange,
          spot_price,
          perp_exchange,
          perp_price,
          premium_pct,
          started_at,
          last_seen_at,
          duration_ms,
          is_active
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      `)
      .run(
        input.base,
        input.spotExchange,
        input.spotPrice,
        input.perpExchange,
        input.perpPrice,
        input.premiumPct,
        input.startedAt,
        input.startedAt,
        0,
      ) as { lastInsertRowid: number | bigint };

    return Number(result.lastInsertRowid);
  }

  updateRecord(id: number, input: UpdateGapRecordInput): void {
    this.db
      .prepare(`
        UPDATE gap_records
        SET
          spot_price = ?,
          perp_price = ?,
          premium_pct = ?,
          last_seen_at = ?,
          duration_ms = ?,
          is_active = 1
        WHERE id = ?
      `)
      .run(
        input.spotPrice,
        input.perpPrice,
        input.premiumPct,
        input.lastSeenAt,
        input.durationMs,
        id,
      );
  }

  closeRecord(id: number, lastSeenAt: number, durationMs: number): void {
    this.db
      .prepare(`
        UPDATE gap_records
        SET
          last_seen_at = ?,
          duration_ms = ?,
          is_active = 0
        WHERE id = ?
      `)
      .run(lastSeenAt, durationMs, id);
  }

  listRecords(limit = 100): GapRecord[] {
    const rows = this.db
      .prepare(`
        SELECT
          id,
          base,
          spot_exchange,
          spot_price,
          perp_exchange,
          perp_price,
          premium_pct,
          started_at,
          last_seen_at,
          duration_ms,
          is_active
        FROM gap_records
        ORDER BY is_active DESC, started_at DESC
        LIMIT ?
      `)
      .all(limit) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: Number(row.id),
      base: String(row.base),
      spotExchange: String(row.spot_exchange) as Exchange,
      spotPrice: Number(row.spot_price),
      perpExchange: String(row.perp_exchange) as Exchange,
      perpPrice: Number(row.perp_price),
      premiumPct: Number(row.premium_pct),
      startedAt: Number(row.started_at),
      lastSeenAt: Number(row.last_seen_at),
      durationMs: Number(row.duration_ms),
      isActive: Boolean(row.is_active),
    }));
  }
}
