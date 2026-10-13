import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise';
import { LEGACY_MIGRATIONS, retargetLegacySql } from './legacy';
import { splitSqlStatements } from './sqlSplitter';

/**
 * The schema migration runner.
 *
 * Three kinds of migration, one ledger:
 *
 *   legacy  database/NN_*.sql — the hand-applied files, replayed in the order
 *           listed in legacy.ts on a fresh database, or marked applied with
 *           `baseline` on one that already has them.
 *   sql     database/migrations/NNN_*.sql — plain DDL/DML.
 *   ts      src/db/migrations/versions/NNN_*.ts — for changes that have to
 *           look at the database before deciding what to do (the tenancy
 *           conversion introspects every table rather than hardcoding 166
 *           ALTERs that drift the moment someone adds a column).
 *
 * MySQL commits DDL implicitly, so a migration cannot be rolled back as a unit.
 * Migrations are therefore written to be re-runnable: a failure half way
 * through is fixed and the same command run again.
 */

export interface MigrationContext {
  conn: Connection;
  database: string;
  dryRun: boolean;
  log: (message: string) => void;
  /** Runs one statement, or prints it under --dry-run. */
  exec: (sql: string, params?: unknown[]) => Promise<void>;
}

export interface TsMigration {
  description: string;
  up(ctx: MigrationContext): Promise<void>;
}

export interface MigrationFile {
  version: string;
  kind: 'legacy' | 'sql' | 'ts';
  file: string;
  checksum: string;
}

interface AppliedRow extends RowDataPacket {
  version: string;
  checksum: string;
  kind: string;
  applied_at: Date;
}

export interface RunnerOptions {
  projectRoot: string;
  database: string;
  connection: { host: string; port: number; user: string; password: string };
  dryRun?: boolean;
  log?: (message: string) => void;
}

const LEDGER = 'schema_migrations';

function checksumOf(content: string): string {
  return crypto.createHash('sha256').update(content.replace(/\r\n/g, '\n')).digest('hex');
}

/** NNN_name.ext → NNN_name. The number orders; the name documents. */
function versionOf(file: string): string {
  return path.basename(file).replace(/\.(sql|ts|js)$/, '');
}

export function discoverMigrations(projectRoot: string): MigrationFile[] {
  const legacyDir = path.join(projectRoot, 'database');
  const sqlDir = path.join(projectRoot, 'database', 'migrations');
  // Under tsx the .ts sources are loadable; a compiled build can only require
  // the .js output, so whichever this process can actually load is looked at
  // first and the other is ignored by the version dedupe below.
  const sourceDir = path.join(projectRoot, 'src', 'db', 'migrations', 'versions');
  const compiledDir = path.join(projectRoot, 'dist', 'src', 'db', 'migrations', 'versions');
  const runningCompiled = __filename.endsWith('.js');
  const tsDirs = runningCompiled ? [compiledDir, sourceDir] : [sourceDir, compiledDir];

  const legacy: MigrationFile[] = LEGACY_MIGRATIONS.map((name) => {
    const file = path.join(legacyDir, name);
    return { version: `legacy/${versionOf(name)}`, kind: 'legacy', file, checksum: checksumOf(fs.readFileSync(file, 'utf8')) };
  });

  const numbered: MigrationFile[] = [];
  if (fs.existsSync(sqlDir)) {
    for (const name of fs.readdirSync(sqlDir)) {
      if (!/^\d{3,}_.+\.sql$/.test(name)) continue;
      const file = path.join(sqlDir, name);
      numbered.push({ version: versionOf(name), kind: 'sql', file, checksum: checksumOf(fs.readFileSync(file, 'utf8')) });
    }
  }

  const seenTs = new Set<string>();
  for (const dir of tsDirs) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!/^\d{3,}_.+\.(ts|js)$/.test(name) || name.endsWith('.d.ts')) continue;
      if (runningCompiled && !name.endsWith('.js')) continue;
      const version = versionOf(name);
      if (seenTs.has(version)) continue;
      seenTs.add(version);
      const file = path.join(dir, name);
      numbered.push({ version, kind: 'ts', file, checksum: checksumOf(fs.readFileSync(file, 'utf8')) });
    }
  }

  const byVersion = new Map<string, MigrationFile>();
  for (const migration of numbered) {
    const existing = byVersion.get(migration.version.split('_')[0]);
    if (existing) {
      throw new Error(`Two migrations share the number ${migration.version.split('_')[0]}: ${existing.file} and ${migration.file}`);
    }
    byVersion.set(migration.version.split('_')[0], migration);
  }

  numbered.sort((a, b) => Number(a.version.split('_')[0]) - Number(b.version.split('_')[0]));
  return [...legacy, ...numbered];
}

export class MigrationRunner {
  private readonly log: (message: string) => void;

  constructor(private readonly options: RunnerOptions) {
    this.log = options.log ?? ((message) => process.stdout.write(`${message}\n`));
  }

  private async connect(withDatabase: boolean): Promise<Connection> {
    return mysql.createConnection({
      ...this.options.connection,
      database: withDatabase ? this.options.database : undefined,
      charset: 'utf8mb4_0900_ai_ci',
      timezone: 'Z',
      multipleStatements: false,
    });
  }

  private async databaseExists(): Promise<boolean> {
    const conn = await this.connect(false);
    try {
      const [rows] = await conn.query<RowDataPacket[]>(
        'SELECT schema_name FROM information_schema.schemata WHERE schema_name = ?',
        [this.options.database],
      );
      return rows.length > 0;
    } finally {
      await conn.end();
    }
  }

  private async ensureLedger(conn: Connection): Promise<void> {
    await conn.query(
      `CREATE TABLE IF NOT EXISTS \`${LEDGER}\` (
         id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
         version     VARCHAR(190) NOT NULL,
         kind        ENUM('legacy','sql','ts') NOT NULL,
         checksum    CHAR(64)     NOT NULL,
         baselined   TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
         duration_ms INT UNSIGNED NOT NULL DEFAULT 0,
         applied_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
         PRIMARY KEY (id),
         UNIQUE KEY uq_schema_migrations_version (version)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
    );
  }

  private async applied(conn: Connection): Promise<Map<string, AppliedRow>> {
    const [rows] = await conn.query<AppliedRow[]>(`SELECT version, checksum, kind, applied_at FROM \`${LEDGER}\``);
    return new Map(rows.map((row) => [row.version, row]));
  }

  async status(): Promise<{ migration: MigrationFile; applied: AppliedRow | null; drifted: boolean }[]> {
    const all = discoverMigrations(this.options.projectRoot);
    if (!(await this.databaseExists())) return all.map((migration) => ({ migration, applied: null, drifted: false }));
    const conn = await this.connect(true);
    try {
      await this.ensureLedger(conn);
      const applied = await this.applied(conn);
      return all.map((migration) => {
        const row = applied.get(migration.version) ?? null;
        return { migration, applied: row, drifted: Boolean(row && row.checksum !== migration.checksum) };
      });
    } finally {
      await conn.end();
    }
  }

  /**
   * Marks every legacy file as applied without running it.
   *
   * For a database that was built by hand before the runner existed. Refuses
   * to run against a database that does not look like one, because baselining
   * an empty database produces a ledger that lies about what is in it.
   */
  async baseline(): Promise<number> {
    const conn = await this.connect(true);
    try {
      const [probe] = await conn.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ? AND table_name IN ('products','orders','menu_items','messaging_senders')`,
        [this.options.database],
      );
      if (Number(probe[0].n) < 4) {
        throw new Error(`${this.options.database} does not contain the legacy schema; run "up" instead of "baseline".`);
      }
      await this.ensureLedger(conn);
      const applied = await this.applied(conn);
      let count = 0;
      for (const migration of discoverMigrations(this.options.projectRoot)) {
        if (migration.kind !== 'legacy' || applied.has(migration.version)) continue;
        await conn.query(`INSERT INTO \`${LEDGER}\` (version, kind, checksum, baselined) VALUES (?, 'legacy', ?, 1)`, [
          migration.version,
          migration.checksum,
        ]);
        count += 1;
      }
      this.log(`baselined ${count} legacy migration(s)`);
      return count;
    } finally {
      await conn.end();
    }
  }

  async up(options: { to?: string } = {}): Promise<number> {
    const dryRun = Boolean(this.options.dryRun);
    const fresh = !(await this.databaseExists());

    if (fresh) {
      if (dryRun) {
        this.log(`[dry-run] would create database ${this.options.database}`);
        return 0;
      }
      const bootstrap = await this.connect(false);
      try {
        await bootstrap.query(
          `CREATE DATABASE IF NOT EXISTS \`${this.options.database}\` DEFAULT CHARACTER SET utf8mb4 DEFAULT COLLATE utf8mb4_0900_ai_ci`,
        );
      } finally {
        await bootstrap.end();
      }
    }

    const conn = await this.connect(true);
    let count = 0;
    try {
      await conn.query("SET SESSION time_zone = '+00:00'");
      await this.ensureLedger(conn);
      const applied = await this.applied(conn);

      for (const migration of discoverMigrations(this.options.projectRoot)) {
        const done = applied.get(migration.version);
        if (done) {
          if (done.checksum !== migration.checksum && migration.kind !== 'legacy') {
            this.log(`! ${migration.version} changed after it was applied (checksum drift) — leaving it alone`);
          }
          continue;
        }

        const started = Date.now();
        this.log(`${dryRun ? '[dry-run] ' : ''}→ ${migration.version}`);
        await this.apply(conn, migration, dryRun);

        if (!dryRun) {
          await conn.query(`INSERT INTO \`${LEDGER}\` (version, kind, checksum, duration_ms) VALUES (?, ?, ?, ?)`, [
            migration.version,
            migration.kind,
            migration.checksum,
            Date.now() - started,
          ]);
        }
        count += 1;
        if (options.to && migration.version.startsWith(options.to)) break;
      }
    } finally {
      await conn.end();
    }

    this.log(count === 0 ? 'database is up to date' : `${dryRun ? 'would apply' : 'applied'} ${count} migration(s)`);
    return count;
  }

  private async apply(conn: Connection, migration: MigrationFile, dryRun: boolean): Promise<void> {
    const exec = async (sql: string, params: unknown[] = []) => {
      if (dryRun) {
        this.log(`   ${sql.replace(/\s+/g, ' ').slice(0, 400)}${params.length ? `  -- ${JSON.stringify(params)}` : ''}`);
        return;
      }
      await conn.query(sql, params);
    };

    if (migration.kind === 'ts') {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const loaded = require(migration.file) as { default?: TsMigration } & Partial<TsMigration>;
      const module = (loaded.default ?? loaded) as TsMigration;
      if (typeof module.up !== 'function') throw new Error(`${migration.file} does not export up()`);
      await module.up({ conn, database: this.options.database, dryRun, log: (m) => this.log(`   ${m}`), exec });
      return;
    }

    let sql = fs.readFileSync(migration.file, 'utf8');
    if (migration.kind === 'legacy') sql = retargetLegacySql(sql, this.options.database, path.basename(migration.file));

    for (const statement of splitSqlStatements(sql)) {
      try {
        await exec(statement);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`${migration.version} failed: ${reason}\n--- statement ---\n${statement.slice(0, 1200)}`);
      }
    }
  }
}
