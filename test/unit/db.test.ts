import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Executor } from '../../src/db/pool';
import { retryOnLockConflict } from '../../src/db/retry';

function deadlock(): Error {
  return Object.assign(new Error('Deadlock found when trying to get lock; try restarting transaction'), { code: 'ER_LOCK_DEADLOCK' });
}

const fakePool = { getConnection: () => undefined } as unknown as Executor;
const fakeTransaction = { release: () => undefined } as unknown as Executor;

describe('retryOnLockConflict', () => {
  it('runs an autocommit statement again after a deadlock', async () => {
    let calls = 0;
    const result = await retryOnLockConflict(fakePool, async () => {
      calls += 1;
      if (calls === 1) throw deadlock();
      return 'logged';
    });
    assert.equal(result, 'logged');
    assert.equal(calls, 2);
  });

  it('never retries inside a transaction, where the deadlock already rolled back the rest', async () => {
    let calls = 0;
    await assert.rejects(
      retryOnLockConflict(fakeTransaction, async () => {
        calls += 1;
        throw deadlock();
      }),
      /Deadlock/,
    );
    assert.equal(calls, 1);
  });

  it('gives up after the attempts, and passes other errors straight through', async () => {
    let calls = 0;
    await assert.rejects(
      retryOnLockConflict(fakePool, async () => {
        calls += 1;
        throw deadlock();
      }),
    );
    assert.equal(calls, 3);

    calls = 0;
    await assert.rejects(
      retryOnLockConflict(fakePool, async () => {
        calls += 1;
        throw new Error('syntax');
      }),
      /syntax/,
    );
    assert.equal(calls, 1);
  });
});
