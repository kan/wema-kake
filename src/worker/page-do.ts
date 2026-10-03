import { DurableObject } from 'cloudflare:workers';

const META_TABLE = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`;

/** 添字 + 1 がスキーマのバージョン。変更は末尾に足し、既存の要素は書き換えない */
const MIGRATIONS = [
  `
CREATE TABLE notes (
  id         TEXT PRIMARY KEY,
  x REAL NOT NULL, y REAL NOT NULL,
  width REAL NOT NULL, height REAL NOT NULL,
  text       TEXT NOT NULL,
  color      TEXT NOT NULL,
  z_index    INTEGER NOT NULL,
  auto_size  INTEGER NOT NULL DEFAULT 0,
  extra      TEXT,
  created_by TEXT,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);

CREATE TABLE edges (
  id         TEXT PRIMARY KEY,
  from_id    TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  to_id      TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  props      TEXT NOT NULL,
  created_by TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE ops (
  seq         INTEGER PRIMARY KEY,
  actor       TEXT NOT NULL,
  client_id   TEXT NOT NULL,
  op_id       TEXT NOT NULL,
  body        TEXT NOT NULL,
  summary     TEXT,
  reverted_by INTEGER,
  created_at  INTEGER NOT NULL
);

CREATE UNIQUE INDEX ops_client_op ON ops (client_id, op_id);

INSERT INTO meta (key, value) VALUES ('seq', '0');
`,
];

/** ページ 1 つ分の付箋・接続線・操作履歴を持つ */
export class PageDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.migrate();
  }

  private migrate(): void {
    const sql = this.ctx.storage.sql;
    sql.exec(META_TABLE);
    const row = sql.exec(`SELECT value FROM meta WHERE key = 'version'`).toArray()[0];
    const version = row ? Number(row.value) : 0;
    if (version >= MIGRATIONS.length) return;
    this.ctx.storage.transactionSync(() => {
      for (const migration of MIGRATIONS.slice(version)) {
        sql.exec(migration);
      }
      sql.exec(
        `INSERT OR REPLACE INTO meta (key, value) VALUES ('version', ?)`,
        String(MIGRATIONS.length),
      );
    });
  }

  /** 現在の通番 */
  getSeq(): number {
    const row = this.ctx.storage.sql.exec(`SELECT value FROM meta WHERE key = 'seq'`).one();
    return Number(row.value);
  }
}
