// 📁 backend/src/services/gracePeriodScheduler.js
//
// Runs daily:
//   1. Agents whose grace period expired → permanently block
//   2. Flagged agents unpaid for 30+ days → blacklist
//   3. Reminder notifications at 30/60/80/88 days into grace

const { pool } = require('../config/database');
const walletService = require('./walletService');

const RUN_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
const BLACKLIST_AFTER_DAYS = Number(process.env.BLACKLIST_AFTER_DAYS) || 30;

let started = false;
let handle = null;

async function expireGracePeriods() {
  const r = await pool.query(
    `SELECT id, wallet_balance FROM agents
     WHERE status = 'GRACE_PERIOD'
       AND grace_period_ends_at IS NOT NULL
       AND grace_period_ends_at < NOW()
       AND wallet_balance <= $1
       AND flagged = FALSE`,
    [walletService.BLOCK_THRESHOLD]
  );
  for (const a of r.rows) {
    await walletService.permanentlyBlock(
      a.id,
      'Grace period expired with unpaid commission'
    );
    console.log(`[grace] permanently blocked ${a.id} (balance ${a.wallet_balance})`);
  }
  return r.rowCount;
}

async function clearRecoveredGrace() {
  const r = await pool.query(
    `UPDATE agents
     SET breached_at = NULL,
         grace_period_ends_at = NULL,
         status = 'ACTIVE',
         updated_at = NOW()
     WHERE status = 'GRACE_PERIOD'
       AND wallet_balance > $1`,
    [walletService.BLOCK_THRESHOLD]
  );
  return r.rowCount;
}

async function blacklistAbandoned() {
  const r = await pool.query(
    `SELECT id, mpesa_number, id_number, business_name, wallet_balance
     FROM agents
     WHERE flagged = TRUE
       AND flagged_at < NOW() - ($1::int || ' days')::interval
       AND wallet_balance < 0
       AND status <> 'BLACKLISTED'`,
    [BLACKLIST_AFTER_DAYS]
  );

  for (const a of r.rows) {
    await pool.query(
      `INSERT INTO blacklist_entries
       (phone, id_number, business_name, debt_amount, reason)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        a.mpesa_number,
        a.id_number,
        a.business_name,
        a.wallet_balance,
        `Unpaid commission after ${BLACKLIST_AFTER_DAYS} days post-flag`,
      ]
    );
    await pool.query(
      `UPDATE agents SET status = 'BLACKLISTED', updated_at = NOW() WHERE id = $1`,
      [a.id]
    );
    console.log(`[grace] blacklisted ${a.id} (debt ${a.wallet_balance})`);
  }
  return r.rowCount;
}

async function sendGraceReminders() {
  // reminderDay = days remaining before grace ends
  const REMIND_AT = [30, 60, 80, 88];
  for (const daysLeft of REMIND_AT) {
    const target = new Date();
    target.setDate(target.getDate() + daysLeft);
    // match agents whose grace ends on that calendar day
    const r = await pool.query(
      `SELECT id, wallet_balance, grace_period_ends_at
       FROM agents
       WHERE status = 'GRACE_PERIOD'
         AND DATE(grace_period_ends_at) = DATE($1)`,
      [target]
    );
    for (const a of r.rows) {
      // Fire your existing notification service here if you like
      console.log(
        `[grace] reminder: agent ${a.id} has ${daysLeft} days left (balance ${a.wallet_balance})`
      );
    }
  }
}

async function run() {
  try {
    const blocked = await expireGracePeriods();
    const cleared = await clearRecoveredGrace();
    const blacklisted = await blacklistAbandoned();
    await sendGraceReminders();
    if (blocked || cleared || blacklisted) {
      console.log(
        `[grace] run complete — blocked ${blocked}, cleared ${cleared}, blacklisted ${blacklisted}`
      );
    }
  } catch (err) {
    console.error('[grace] run failed:', err.message);
  }
}

function startGracePeriodScheduler() {
  if (started) return;
  started = true;
  console.log('[grace] scheduler started — runs daily');

  // first run 30s after boot
  setTimeout(run, 30 * 1000);
  handle = setInterval(run, RUN_INTERVAL_MS);
}

function stopGracePeriodScheduler() {
  if (handle) clearInterval(handle);
  handle = null;
  started = false;
}

module.exports = { startGracePeriodScheduler, stopGracePeriodScheduler, run };