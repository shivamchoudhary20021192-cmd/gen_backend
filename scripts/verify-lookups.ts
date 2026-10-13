/**
 * Verify Lookups System Installation
 * 
 * Run this script to verify the lookup tables are properly installed
 * and seeded with data.
 * 
 * Usage: npx tsx scripts/verify-lookups.ts
 */

import { pool, type RowDataPacket } from '../src/db/pool';

interface CountResult extends RowDataPacket {
  count: number;
}

async function verifyLookups() {
  console.log('🔍 Verifying Lookup System Installation...\n');

  try {
    // Check if tables exist
    console.log('1️⃣  Checking if tables exist...');
    const [tables] = await pool.query<any[]>(
      `SHOW TABLES LIKE 'lookup_%'`
    );

    if (tables.length < 2) {
      console.error('❌ Lookup tables not found!');
      console.log('   Run: mysql -u root -p veylog_db < database/26_lookup_tables.sql');
      process.exit(1);
    }

    console.log(`✅ Found ${tables.length} lookup tables`);
    tables.forEach((row: any) => {
      const tableName = Object.values(row)[0];
      console.log(`   - ${tableName}`);
    });

    // Count categories
    console.log('\n2️⃣  Checking categories...');
    const [catCount] = await pool.query<CountResult[]>(
      'SELECT COUNT(*) as count FROM lookup_categories'
    );
    const categoryCount = catCount[0].count;

    if (categoryCount === 0) {
      console.error('❌ No categories found! Migration may have failed.');
      process.exit(1);
    }

    console.log(`✅ Found ${categoryCount} categories`);

    // List categories
    const [categories] = await pool.query<any[]>(
      'SELECT code, name, (SELECT COUNT(*) FROM lookup_values WHERE category_id = lookup_categories.id) as value_count FROM lookup_categories ORDER BY sort_order'
    );

    console.log('\n   Categories:');
    categories.forEach((cat: any) => {
      console.log(`   - ${cat.code.padEnd(20)} (${cat.value_count} values)`);
    });

    // Count values
    console.log('\n3️⃣  Checking values...');
    const [valCount] = await pool.query<CountResult[]>(
      'SELECT COUNT(*) as count FROM lookup_values'
    );
    const valueCount = valCount[0].count;

    if (valueCount === 0) {
      console.error('❌ No values found! Migration may have failed.');
      process.exit(1);
    }

    console.log(`✅ Found ${valueCount} values`);

    // Sample values from each category
    console.log('\n4️⃣  Sample values:');
    const [samples] = await pool.query<any[]>(
      `SELECT 
         lc.code as category,
         GROUP_CONCAT(lv.label ORDER BY lv.sort_order LIMIT 3 SEPARATOR ', ') as sample_values
       FROM lookup_categories lc
       INNER JOIN lookup_values lv ON lv.category_id = lc.id
       WHERE lv.is_active = TRUE
       GROUP BY lc.id
       ORDER BY lc.sort_order
       LIMIT 5`
    );

    samples.forEach((row: any) => {
      console.log(`   ${row.category}: ${row.sample_values}, ...`);
    });

    // Test API readiness
    console.log('\n5️⃣  Checking if backend can query lookups...');
    const { LookupsRepository } = await import('../src/modules/lookups/lookups.repository');
    
    const testCategories = await LookupsRepository.getCategories();
    if (testCategories.length === 0) {
      console.error('❌ Repository cannot fetch categories');
      process.exit(1);
    }

    const testValues = await LookupsRepository.getValuesByCategory('benefits');
    if (testValues.length === 0) {
      console.error('❌ Repository cannot fetch values');
      process.exit(1);
    }

    console.log(`✅ Repository working (${testCategories.length} categories, ${testValues.length} benefit values)`);

    // Success
    console.log('\n✅ ✅ ✅  Lookup System Installation Verified! ✅ ✅ ✅\n');
    console.log('📝 Next Steps:');
    console.log('   1. Start backend: npm run dev');
    console.log('   2. Test API: curl http://localhost:3000/admin/api/v1/lookups');
    console.log('   3. Update frontend to use dynamic dropdowns');
    console.log('   4. See LOOKUP_SYSTEM_GUIDE.md for details\n');

    process.exit(0);
  } catch (error) {
    console.error('\n❌ Verification Failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

verifyLookups();
