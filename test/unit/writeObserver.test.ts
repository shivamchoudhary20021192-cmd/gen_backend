import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { installGuard } from '../../src/db/pods';
import { assignedColumns, bookkeepingOnly, writeObserver, writtenTables } from '../../src/db/writeObserver';
import { tenancy } from '../../src/platform/tenancy/context';
import { fakeShop } from '../helpers/shop';

// Deliberately does not load storefrontVersions: nothing here may reach a database.

describe('writtenTables', () => {
  it('finds the table an INSERT, REPLACE, UPDATE or DELETE writes', () => {
    assert.deepEqual(writtenTables('INSERT INTO products (shop_id, name) VALUES (?, ?)'), ['products']);
    assert.deepEqual(writtenTables('insert ignore into `collection_products` SELECT * FROM x'), ['collection_products']);
    assert.deepEqual(writtenTables('REPLACE INTO settings (k, v) VALUES (?, ?)'), ['settings']);
    assert.deepEqual(writtenTables('UPDATE carts SET updated_at = NOW() WHERE shop_id = ?'), ['carts']);
    assert.deepEqual(writtenTables('DELETE FROM cart_items WHERE cart_id = ? AND shop_id = ?'), ['cart_items']);
    assert.deepEqual(writtenTables('UPDATE veylog.products SET name = ? WHERE id = ?'), ['products']);
  });

  it('reports every table a multi-table UPDATE or DELETE may change', () => {
    assert.deepEqual(writtenTables('UPDATE orders o JOIN inventory_items i ON i.variant_id = o.variant_id SET i.on_hand = i.on_hand - 1 WHERE o.id = ?'), ['orders', 'inventory_items']);
    assert.deepEqual(writtenTables('DELETE p FROM products p JOIN collections c ON c.id = p.collection_id WHERE c.id = ?'), ['products', 'collections']);
  });

  it('ignores reads, session statements and table names in comments or strings', () => {
    assert.equal(writtenTables('SELECT * FROM products WHERE name = ?'), null);
    assert.equal(writtenTables("SET time_zone = '+00:00'"), null);
    assert.equal(writtenTables('SELECT id FROM jobs WHERE status = ? FOR UPDATE SKIP LOCKED'), null);
    assert.deepEqual(writtenTables("/* INSERT INTO products */ UPDATE carts SET note = 'UPDATE products SET x' WHERE id = ?"), ['carts']);
  });
});

/** A connection that answers every statement, so the wrapper's bookkeeping can be watched. */
function fakeConnection() {
  const connection = {
    query: async (_sql: unknown, _values?: unknown) => [[], []],
    execute: async (_sql: unknown, _values?: unknown) => [[], []],
    beginTransaction: async () => undefined,
    commit: async () => undefined,
    rollback: async () => undefined,
  };
  return installGuard(connection as never) as unknown as typeof connection;
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('write observation at the driver', () => {
  const seen: Array<[number, readonly string[]]> = [];
  writeObserver.subscribe((shopId, tables) => seen.push([shopId, tables]));

  it('reports an autocommit write for the shop in context, once it succeeds', async () => {
    seen.length = 0;
    const connection = fakeConnection();
    await tenancy.run(fakeShop({ id: 7 }), () => connection.query('UPDATE products SET name = ? WHERE id = ? AND shop_id = ?', ['x', 1, 7]));
    await settle();
    assert.deepEqual(seen, [[7, ['products']]]);
  });

  it('does not report reads, or writes outside any shop', async () => {
    seen.length = 0;
    const connection = fakeConnection();
    await tenancy.run(fakeShop({ id: 7 }), () => connection.query('SELECT * FROM products WHERE shop_id = ?', [7]));
    await connection.query('UPDATE plans SET name = ? WHERE id = ?', ['Pro', 1]);
    await settle();
    assert.deepEqual(seen, []);
  });

  it('holds a transaction’s writes until COMMIT, and drops them on ROLLBACK', async () => {
    seen.length = 0;
    const connection = fakeConnection();
    await tenancy.run(fakeShop({ id: 9 }), async () => {
      await connection.beginTransaction();
      await connection.query('INSERT INTO products (shop_id, name) VALUES (?, ?)', [9, 'a']);
      await connection.execute('UPDATE collections SET title = ? WHERE shop_id = ?', ['b', 9]);
      await settle();
      assert.deepEqual(seen, [], 'nothing before the commit');
      await connection.commit();
    });
    assert.deepEqual(seen, [
      [9, ['products']],
      [9, ['collections']],
    ]);

    seen.length = 0;
    await tenancy.run(fakeShop({ id: 9 }), async () => {
      await connection.beginTransaction();
      await connection.query('DELETE FROM products WHERE id = ? AND shop_id = ?', [1, 9]);
      await settle();
      await connection.rollback();
    });
    await connection.query('SELECT 1');
    await settle();
    assert.deepEqual(seen, [], 'a rolled-back write changed nothing');
  });

  it('does not report a statement that failed', async () => {
    seen.length = 0;
    const connection = installGuard({
      query: async () => {
        throw new Error('Duplicate entry');
      },
      execute: async () => [[], []],
    } as never) as unknown as { query: (sql: string) => Promise<unknown> };
    await tenancy.run(fakeShop({ id: 7 }), () => assert.rejects(connection.query('INSERT INTO products (shop_id) VALUES (7)')));
    await settle();
    assert.deepEqual(seen, []);
  });
});

describe('bookkeeping writes', () => {
  it('reads the columns an UPDATE assigns, commas in functions and all', () => {
    assert.deepEqual(assignedColumns('UPDATE cms_articles SET view_count = view_count + 1 WHERE shop_id = ? AND id = ?'), ['view_count']);
    assert.deepEqual(assignedColumns("UPDATE t SET a = IF(x > 1, 'a,b', 2), `b` = NOW(), t.c = ? WHERE id = ?"), ['a', 'b', 'c']);
    assert.equal(assignedColumns('INSERT INTO t (a) VALUES (1)'), null);
  });

  it('knows a view counter or a last-used stamp from a real change', () => {
    assert.equal(bookkeepingOnly('UPDATE cms_articles SET view_count = view_count + 1 WHERE shop_id = ? AND id = ?'), true);
    assert.equal(bookkeepingOnly('UPDATE notification_templates SET usage_count = usage_count + 1, last_used_at = NOW() WHERE shop_id = ? AND id = ?'), true);
    assert.equal(bookkeepingOnly('UPDATE cms_articles SET title = ?, updated_at = NOW() WHERE shop_id = ? AND id = ?'), false);
    assert.equal(bookkeepingOnly('DELETE FROM cms_articles WHERE shop_id = ? AND id = ?'), false);
  });

  it('are not reported', async () => {
    const seen: number[] = [];
    writeObserver.subscribe((shopId) => seen.push(shopId));
    const connection = fakeConnection();
    await tenancy.run(fakeShop({ id: 11 }), () => connection.query('UPDATE cms_articles SET view_count = view_count + 1 WHERE shop_id = ? AND id = ?', [11, 3]));
    await settle();
    assert.deepEqual(seen, []);
  });
});
