import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import { ShopScopedCache } from '../../src/platform/cache/shopCache';
import { shopId, shopIdSql, tenancy, TenantContextError } from '../../src/platform/tenancy/context';
import { TenantIsolationError, tenantGuard } from '../../src/platform/tenancy/guard';
import { scanSql } from '../../src/platform/tenancy/sqlScan';
import { fakeShop } from '../helpers/shop';

describe('scanSql', () => {
  it('finds tables across FROM, JOIN, UPDATE, INSERT and DELETE', () => {
    assert.deepEqual(
      scanSql('SELECT * FROM products p JOIN product_variants v ON v.product_id = p.id WHERE p.shop_id = ?').tables.sort(),
      ['product_variants', 'products'],
    );
    assert.deepEqual(scanSql('UPDATE orders SET x = 1 WHERE shop_id = ?').tables, ['orders']);
    assert.deepEqual(scanSql('INSERT INTO carts (shop_id, token) VALUES (?, ?)').tables, ['carts']);
    assert.deepEqual(scanSql('DELETE FROM cart_items WHERE shop_id = ? AND id = ?').tables, ['cart_items']);
  });

  it('does not mistake ON DUPLICATE KEY UPDATE for a table reference', () => {
    const scan = scanSql('INSERT INTO settings (shop_id, setting_key, value) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)');
    assert.deepEqual(scan.tables, ['settings']);
  });

  it('ignores table names inside string literals and comments', () => {
    const scan = scanSql("SELECT 'FROM orders' AS label -- FROM customers\n FROM products WHERE shop_id = ?");
    assert.deepEqual(scan.tables, ['products']);
  });

  it('locates the parameters bound to shop_id, including in INSERT column lists', () => {
    assert.deepEqual(scanSql('SELECT * FROM products WHERE status = ? AND shop_id = ? AND id = ?').shopParamIndexes, [1]);
    assert.deepEqual(scanSql('INSERT INTO carts (token, shop_id) VALUES (?, ?)').shopParamIndexes, [1]);
    assert.equal(scanSql('SELECT * FROM products WHERE id = ?').mentionsShopId, false);
  });
});

describe('tenant guard', () => {
  beforeEach(() => {
    tenantGuard.configure('enforce');
    tenantGuard.load(['products', 'orders']);
  });

  it('refuses a tenant query outside any shop context', () => {
    assert.throws(() => tenantGuard.check('SELECT * FROM products WHERE shop_id = ?', [1]), TenantIsolationError);
  });

  it('refuses a tenant query that is not scoped by shop_id', () => {
    tenancy.run(fakeShop(), () => {
      assert.throws(() => tenantGuard.check('SELECT * FROM products WHERE id = ?', [5]), TenantIsolationError);
    });
  });

  it('refuses shop_id bound to another shop — the swapped-parameter bug', () => {
    tenancy.run(fakeShop({ id: 7 }), () => {
      assert.throws(
        () => tenantGuard.check('SELECT * FROM orders WHERE id = ? AND shop_id = ?', [7, 12]),
        /bound to 12/,
      );
    });
  });

  it('accepts a correctly scoped query, and control-plane tables anywhere', () => {
    tenancy.run(fakeShop({ id: 7 }), () => {
      tenantGuard.check('SELECT * FROM orders WHERE shop_id = ? AND id = ?', [7, 99]);
    });
    tenantGuard.check('SELECT * FROM shops WHERE id = ?', [1]);
  });

  it('lets an explicitly unscoped block through, and says why', () => {
    tenancy.unscoped('test: platform sweep', () => {
      tenantGuard.check('SELECT COUNT(*) FROM orders', []);
      assert.equal(tenancy.unscopedReason(), 'test: platform sweep');
    });
  });
});

describe('tenancy context', () => {
  it('throws without a shop, and keeps the shop across awaits', async () => {
    assert.throws(() => shopId(), TenantContextError);
    await tenancy.run(fakeShop({ id: 42 }), async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(shopId(), 42);
      assert.equal(shopIdSql(), '42');
    });
  });
});

describe('ShopScopedCache', () => {
  it('never serves one shop another shop\'s entry', async () => {
    const cache = new ShopScopedCache<string>(60_000);
    const a = await tenancy.run(fakeShop({ id: 1 }), () => cache.get('home', async () => 'shop one'));
    const b = await tenancy.run(fakeShop({ id: 2 }), () => cache.get('home', async () => 'shop two'));
    assert.equal(a, 'shop one');
    assert.equal(b, 'shop two');
    const again = await tenancy.run(fakeShop({ id: 1 }), () => cache.get('home', async () => 'recomputed'));
    assert.equal(again, 'shop one');
  });

  it('shares one in-flight load between concurrent misses', async () => {
    const cache = new ShopScopedCache<number>(60_000);
    let loads = 0;
    const produce = async () => {
      loads += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return 1;
    };
    await tenancy.run(fakeShop(), () => Promise.all([cache.get('k', produce), cache.get('k', produce), cache.get('k', produce)]));
    assert.equal(loads, 1);
  });

  it('clears only the shop that changed', async () => {
    const cache = new ShopScopedCache<string>(60_000);
    await tenancy.run(fakeShop({ id: 1 }), () => cache.get('k', async () => 'one'));
    await tenancy.run(fakeShop({ id: 2 }), () => cache.get('k', async () => 'two'));
    tenancy.run(fakeShop({ id: 1 }), () => cache.clear());
    assert.equal(await tenancy.run(fakeShop({ id: 2 }), () => cache.get('k', async () => 'reloaded')), 'two');
    assert.equal(await tenancy.run(fakeShop({ id: 1 }), () => cache.get('k', async () => 'reloaded')), 'reloaded');
  });
});
