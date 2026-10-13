/**
 *   npm run db:migrate                 apply everything pending
 *   npm run db:migrate -- status       what is applied, pending, or drifted
 *   npm run db:migrate -- baseline     mark the legacy files applied (existing databases only)
 *   npm run db:migrate -- up --dry-run print what would run
 *   npm run db:migrate -- up --database veylog_test
 *
 * Reads the connection from .env like the API does, so there is exactly one
 * place a developer sets the database password.
 */
import { env, projectRoot } from '../src/config/env';
import { MigrationRunner } from '../src/db/migrations/runner';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args.find((arg) => !arg.startsWith('--')) ?? 'up';
  const flag = (name: string) => {
    const index = args.indexOf(`--${name}`);
    return index === -1 ? undefined : args[index + 1];
  };

  const runner = new MigrationRunner({
    projectRoot,
    database: flag('database') ?? env.db.database,
    connection: { host: env.db.host, port: env.db.port, user: env.db.user, password: env.db.password },
    dryRun: args.includes('--dry-run'),
  });

  switch (command) {
    case 'up':
      await runner.up({ to: flag('to') });
      break;
    case 'baseline':
      await runner.baseline();
      break;
    case 'status': {
      const rows = await runner.status();
      for (const { migration, applied, drifted } of rows) {
        const state = applied ? (drifted ? 'DRIFTED' : 'applied') : 'PENDING';
        process.stdout.write(`${state.padEnd(8)} ${migration.version}\n`);
      }
      const pending = rows.filter((row) => !row.applied).length;
      process.stdout.write(`\n${rows.length - pending} applied, ${pending} pending\n`);
      break;
    }
    default:
      throw new Error(`Unknown command "${command}". Use up, status or baseline.`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
