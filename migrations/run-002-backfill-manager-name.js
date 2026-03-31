/**
 * Migration: Backfill managerName in call_logs from managers table
 * Run: node migrations/run-002-backfill-manager-name.js
 */
require('dotenv').config({ path: __dirname + '/../.env' });

const sequelize = require('../src/configs/sequelize');

async function run() {
  try {
    await sequelize.authenticate();
    console.log('✅ DB connected');

    const [, meta] = await sequelize.query(`
      UPDATE call_logs cl
      JOIN managers m ON m.email = cl.managerEmail
      SET cl.managerName = m.name
      WHERE cl.managerName IS NULL
        AND cl.managerEmail IS NOT NULL
    `);

    console.log(`✅ Done. Rows updated: ${meta.affectedRows ?? meta.rowsAffected ?? 'unknown'}`);
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    await sequelize.close();
  }
}

run();
