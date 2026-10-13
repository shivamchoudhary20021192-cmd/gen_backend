/**
 * Runs one pass of the domain sweep in this process — what a worker's
 * `domains.sweep` job does every minute. For operators and development:
 *
 *   npm run domains:sweep            (DB_NAME, DNS_* and EDGE_* as the API has them)
 */
import { closePool, verifyConnection } from '../src/db/pool';
import { advanceTransfers, check } from '../src/platform/domains/domains.service';
import { domainsRepository } from '../src/platform/domains/domains.repository';

async function main(): Promise<void> {
  await verifyConnection();
  const due = await domainsRepository.claimDue(Number(process.env.DOMAIN_SWEEP_BATCH ?? 200));
  console.log(`Claimed ${due.length} due domain(s).`);
  for (const domain of due) {
    const before = domain.status;
    try {
      const after = await check(domain);
      console.log(`${after.hostname.padEnd(40)} ${before} → ${after.status}${after.next_check_at ? `, next ${after.next_check_at.toISOString()}` : ''}`);
    } catch (error) {
      console.log(`${domain.hostname.padEnd(40)} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const transfers = await advanceTransfers();
  if (transfers.completed || transfers.failed || transfers.pending) console.log(`Transfers in: ${JSON.stringify(transfers)}`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closePool().catch(() => undefined));
