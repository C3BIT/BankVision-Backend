/**
 * Interactive admin password reset utility.
 *
 * Resets the password of an existing admin/super_admin/supervisor account
 * directly in the database, enforcing the same banking-grade rules the running
 * API enforces on a self-service change:
 *   - password complexity policy (utils/passwordPolicy)
 *   - "not the same as current" + password-history reuse checks
 *     (utils/accountSecurity)
 *   - bcrypt hashing with the same cost factor (10) used everywhere else
 *   - rolls the previous hash into passwordHistory (keeps last N)
 *   - clears any brute-force lockout so the account can log in immediately
 *   - optionally resets TOTP/2FA (for when the authenticator was also lost)
 *
 * DB credentials come from the backend's own .env — this script loads it
 * explicitly (by absolute path) so it works no matter which directory you run
 * it from. Nothing is ever printed to stdout except non-secret metadata; the
 * new password is read with masked input and never echoed or logged.
 *
 * Usage:
 *   node src/scripts/resetAdminPassword.js
 *   npm run reset-admin-password
 */

// Load the backend's .env explicitly, before anything pulls in the DB config
// (configs/variables reads process.env at require time). Resolving the path
// relative to this file — not process.cwd() — lets the script run from
// anywhere (repo root, src/, a cron working dir, etc.).
const path = require('path');
require('dotenv').config({
  path: path.resolve(__dirname, '../../.env'),
  override: true,
});

const readline = require('readline');
const bcrypt = require('bcryptjs');

const sequelize = require('../configs/sequelize');
const { Admin } = require('../models/Admin');
const { validatePassword, getPasswordRequirements } = require('../utils/passwordPolicy');
const { validatePasswordChange, addToPasswordHistory } = require('../utils/accountSecurity');

const BCRYPT_ROUNDS = 10; // matches every other bcrypt.hash() call in the codebase

// ---------------------------------------------------------------------------
// Prompt helpers
// ---------------------------------------------------------------------------

// Visible line prompt. A fresh interface per question keeps things simple and
// avoids any state overlap with the masked (raw-mode) prompt below, since every
// call is awaited sequentially.
const ask = (query) =>
  new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });

// Masked prompt for secrets. Echoes '*' per character so the operator gets
// length feedback without the password ever appearing on screen or in logs.
// Falls back to a plain (still non-echoing) read when stdin isn't a TTY.
const askHidden = (query) =>
  new Promise((resolve) => {
    const input = process.stdin;
    const output = process.stdout;
    output.write(query);

    if (!input.isTTY) {
      // Non-interactive stdin (piped): read one line, no masking possible.
      const rl = readline.createInterface({ input, output: undefined, terminal: false });
      rl.question('', (answer) => {
        rl.close();
        output.write('\n');
        resolve(answer);
      });
      return;
    }

    let value = '';
    const wasRaw = input.isRaw;
    input.setRawMode(true);
    input.resume();

    const onData = (buf) => {
      const char = buf.toString('utf8');
      switch (char) {
        case '\n':
        case '\r':
        case '\u0004': // Ctrl-D / EOT
          input.setRawMode(wasRaw);
          input.pause();
          input.removeListener('data', onData);
          output.write('\n');
          resolve(value);
          break;
        case '\u0003': // Ctrl-C
          input.setRawMode(wasRaw);
          output.write('\n');
          process.exit(130);
          break;
        case '\u007f': // Backspace / Delete
        case '\b':
          if (value.length > 0) {
            value = value.slice(0, -1);
            output.write('\b \b');
          }
          break;
        default:
          // Ignore other control characters; accept printable input only.
          if (char >= ' ') {
            value += char;
            output.write('*');
          }
      }
    };

    input.on('data', onData);
  });

const confirm = async (query, defaultYes = true) => {
  const suffix = defaultYes ? ' [Y/n] ' : ' [y/N] ';
  const answer = (await ask(query + suffix)).toLowerCase();
  if (!answer) return defaultYes;
  return answer === 'y' || answer === 'yes';
};

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------

const main = async () => {
  console.log('\n=== BankVision — Admin Password Reset ===\n');

  await sequelize.authenticate();
  console.log(`Connected to database "${process.env.DB_NAME}" at ${process.env.DB_HOST}:${process.env.DB_PORT || 3306}\n`);

  const admins = await Admin.findAll({
    order: [['createdAt', 'ASC']],
    attributes: ['id', 'name', 'email', 'role', 'isActive', 'lockedUntil', 'totpEnabled'],
  });

  if (admins.length === 0) {
    console.log('No admin accounts exist. Run "node src/scripts/seedAdmin.js" to create one.');
    return;
  }

  console.log('Admin accounts:\n');
  admins.forEach((a, i) => {
    const locked = a.lockedUntil && new Date(a.lockedUntil) > new Date() ? ' [LOCKED]' : '';
    const inactive = a.isActive ? '' : ' [INACTIVE]';
    const twofa = a.totpEnabled ? ' [2FA]' : '';
    console.log(`  ${i + 1}) ${a.email}  —  ${a.name} (${a.role})${locked}${inactive}${twofa}`);
  });
  console.log('');

  // --- Select the target account (by number or email) ---
  let target = null;
  while (!target) {
    const choice = await ask('Select an admin by number or email (or "q" to quit): ');
    if (choice.toLowerCase() === 'q') {
      console.log('Aborted. No changes made.');
      return;
    }
    const asIndex = Number.parseInt(choice, 10);
    if (!Number.isNaN(asIndex) && asIndex >= 1 && asIndex <= admins.length) {
      target = admins[asIndex - 1];
    } else {
      target = admins.find((a) => a.email.toLowerCase() === choice.toLowerCase()) || null;
    }
    if (!target) console.log('  ✗ No matching admin. Try again.\n');
  }

  // Re-fetch the full record (needs password + passwordHistory for the reuse checks)
  const admin = await Admin.findByPk(target.id);

  console.log(`\nSelected: ${admin.email} (${admin.role})`);
  if (!(await confirm('Reset the password for this account?'))) {
    console.log('Aborted. No changes made.');
    return;
  }

  // --- Read and validate the new password ---
  console.log(`\nPassword requirements: ${getPasswordRequirements()}\n`);

  let newPassword = null;
  while (!newPassword) {
    const candidate = await askHidden('New password: ');

    const policy = validatePassword(candidate);
    if (!policy.isValid) {
      console.log('  ✗ Password does not meet policy:');
      policy.errors.forEach((e) => console.log(`      - ${e}`));
      console.log('');
      continue;
    }

    // Reject reuse of the current or a recent password, same as the API's
    // self-service change endpoint.
    const historyCheck = await validatePasswordChange(candidate, admin.password, admin.passwordHistory || []);
    if (!historyCheck.valid) {
      console.log(`  ✗ ${historyCheck.message}\n`);
      continue;
    }

    const confirmPassword = await askHidden('Confirm new password: ');
    if (candidate !== confirmPassword) {
      console.log('  ✗ Passwords do not match. Try again.\n');
      continue;
    }

    newPassword = candidate;
  }

  // --- Optional account-recovery toggles ---
  const isLocked = admin.lockedUntil && new Date(admin.lockedUntil) > new Date();
  const unlock = isLocked || admin.failedLoginAttempts > 0
    ? await confirm('\nAccount has failed-login state. Clear lockout / failed attempts?', true)
    : true; // nothing to clear, but harmless to reset counters to 0

  let resetTotp = false;
  if (admin.totpEnabled) {
    resetTotp = await confirm('This account has 2FA (TOTP) enabled. Disable/reset it too?', false);
  }

  // --- Final confirmation before writing ---
  console.log('\nAbout to apply:');
  console.log(`  • Reset password for ${admin.email}`);
  if (unlock) console.log('  • Clear lockout and failed-login counters');
  if (resetTotp) console.log('  • Disable TOTP 2FA and wipe its secret/backup codes');
  if (!(await confirm('\nProceed?', false))) {
    console.log('Aborted. No changes made.');
    return;
  }

  // --- Apply within a transaction ---
  const hashedPassword = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

  await sequelize.transaction(async (t) => {
    // Roll the OLD hash into history (keeps last N) before overwriting it.
    admin.passwordHistory = addToPasswordHistory(admin.password, admin.passwordHistory || []);
    admin.password = hashedPassword; // beforeUpdate hook stamps passwordChangedAt

    if (unlock) {
      admin.failedLoginAttempts = 0;
      admin.lockedUntil = null;
      admin.lastFailedLogin = null;
    }

    if (resetTotp) {
      admin.totpEnabled = false;
      admin.totpSecret = null;
      admin.totpBackupCodes = [];
    }

    await admin.save({ transaction: t });
  });

  console.log(`\n✓ Password reset successfully for ${admin.email}.`);
  if (unlock) console.log('✓ Lockout cleared.');
  if (resetTotp) console.log('✓ TOTP 2FA reset — the admin will re-enrol on next login.');
  console.log('');
};

main()
  .catch((error) => {
    console.error('\n✗ Password reset failed:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await sequelize.close();
    } catch {
      /* ignore close errors on shutdown */
    }
    process.exit(process.exitCode || 0);
  });
