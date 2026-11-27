/**
 * tests/accounting.test.mjs — Automated Verification Suite
 * Run with: node --test tests/accounting.test.mjs
 *
 * Verifies all critical accounting rules, persistent person profile
 * deduplication, partial repayments, over-repayment guards, edit/delete
 * recalculation, historical month/year reporting, offline queue sync &
 * deduplication, multi-user isolation, and Excel-compatible CSV export.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseIntegerBDT,
  normalizePersonName,
  validateLoanDirectionEvent,
  validateRepaymentAmount,
  computePersonBalances,
  computeMonthlySummary,
  computeYearlySummary,
  filterUnifiedTransactions,
  buildCsvExport,
} from '../js/accounting.js';
import { OfflineSyncManager } from '../js/sync.js';

// Simple in-memory storage mock for Node testing
class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}

// In-memory relational ledger simulator mirroring our Supabase schema & RLS
class InMemoryLedger {
  constructor() {
    this.people = [];
    this.transactions = [];
    this.loanTransactions = [];
    this.seq = 1;
  }

  _nextId(prefix) { return `${prefix}_${this.seq++}`; }

  addTransaction(userId, { type, amount, category_name = 'Uncategorized', description = null, transaction_date, client_mutation_id = null }) {
    const parsed = parseIntegerBDT(amount);
    if (!parsed.ok) throw new Error(parsed.error);
    if (client_mutation_id) {
      const dup = this.transactions.find((t) => t.user_id === userId && t.client_mutation_id === client_mutation_id);
      if (dup) return dup;
    }
    const row = {
      id: this._nextId('tx'),
      user_id: userId,
      type,
      amount: parsed.value,
      category_name,
      description,
      transaction_date,
      occurred_at: `${transaction_date}T12:00:00Z`,
      client_mutation_id,
    };
    this.transactions.push(row);
    return row;
  }

  upsertPerson(userId, name) {
    const norm = normalizePersonName(name);
    let existing = this.people.find((p) => p.user_id === userId && p.normalized_name === norm);
    if (!existing) {
      existing = { id: this._nextId('person'), user_id: userId, name: name.trim(), normalized_name: norm };
      this.people.push(existing);
    }
    return existing;
  }

  recordLoan(userId, { personName, direction, event_type, amount, description = null, transaction_date, allowOverpayment = false }) {
    const dirCheck = validateLoanDirectionEvent(direction, event_type);
    if (!dirCheck.ok) throw new Error(dirCheck.error);
    const person = this.upsertPerson(userId, personName);

    const userLoans = this.loanTransactions.filter(
      (l) => l.user_id === userId && l.person_id === person.id && l.direction === direction
    );
    const balances = computePersonBalances([person], userLoans);
    const currentOutstanding = balances[0]?.outstanding_balance || 0;

    if (event_type === 'repay_debt' || event_type === 'collect_loan') {
      const check = validateRepaymentAmount(currentOutstanding, amount, allowOverpayment);
      if (!check.ok) throw new Error(check.error);
    } else {
      const parsed = parseIntegerBDT(amount);
      if (!parsed.ok) throw new Error(parsed.error);
    }

    const row = {
      id: this._nextId('loan'),
      user_id: userId,
      person_id: person.id,
      person_name: person.name,
      direction,
      event_type,
      amount: Number(amount),
      description,
      transaction_date,
      occurred_at: `${transaction_date}T12:00:00Z`,
    };
    this.loanTransactions.push(row);
    return { person, row };
  }

  getUserTransactions(userId) {
    return this.transactions.filter((t) => t.user_id === userId);
  }

  getUserLoans(userId) {
    return this.loanTransactions.filter((l) => l.user_id === userId);
  }

  getUserPeople(userId) {
    return this.people.filter((p) => p.user_id === userId);
  }
}

test('1 & 2. Integer BDT validation, expenses, income, and net cash flow', () => {
  assert.equal(parseIntegerBDT('500').ok, true);
  assert.equal(parseIntegerBDT('500').value, 500);
  assert.equal(parseIntegerBDT('12.50').ok, false, 'Must reject floating-point Taka');
  assert.equal(parseIntegerBDT('0').ok, false, 'Must reject zero');
  assert.equal(parseIntegerBDT('-100').ok, false, 'Must reject negative numbers');

  const db = new InMemoryLedger();
  db.addTransaction('u1', { type: 'expense', amount: 350, category_name: 'Food', transaction_date: '2026-11-05' });
  db.addTransaction('u1', { type: 'expense', amount: 150, transaction_date: '2026-11-06' }); // no desc/category allowed
  db.addTransaction('u1', { type: 'income', amount: 12000, category_name: 'Allowance', transaction_date: '2026-11-01' });

  const summary = computeMonthlySummary(db.getUserTransactions('u1'), db.getUserLoans('u1'), 2026, 11);
  assert.equal(summary.total_expenses, 500);
  assert.equal(summary.total_income, 12000);
  assert.equal(summary.net_cash_flow, 11500);
});

test('3, 4, 5. Persistent person profiles (no duplicates), partial repayments, and over-repayment guard', () => {
  const db = new InMemoryLedger();

  // Borrow twice from the same person with varied casing/spacing
  db.recordLoan('u1', { personName: 'Rahim Ahmed', direction: 'payable', event_type: 'borrow', amount: 2000, transaction_date: '2026-11-02' });
  db.recordLoan('u1', { personName: '  rahim   ahmed ', direction: 'payable', event_type: 'borrow', amount: 1500, transaction_date: '2026-11-04' });

  // Verify strictly ONE persistent person profile exists
  assert.equal(db.getUserPeople('u1').length, 1);

  // Partial repayment reduces balance without overwriting original borrowing records
  db.recordLoan('u1', { personName: 'Rahim Ahmed', direction: 'payable', event_type: 'repay_debt', amount: 1000, transaction_date: '2026-11-08' });

  let balances = computePersonBalances(db.getUserPeople('u1'), db.getUserLoans('u1'));
  assert.equal(balances[0].total_principal, 3500);
  assert.equal(balances[0].total_settled, 1000);
  assert.equal(balances[0].outstanding_balance, 2500);
  assert.equal(balances[0].transaction_count, 3, 'Original 2 borrow rows + 1 repayment row must all remain intact');

  // Repayment exceeding outstanding balance must fail without explicit confirmation
  assert.throws(() => {
    db.recordLoan('u1', { personName: 'Rahim Ahmed', direction: 'payable', event_type: 'repay_debt', amount: 3000, transaction_date: '2026-11-10', allowOverpayment: false });
  }, /exceeds the outstanding balance/);

  // Lend twice to another person & collect partially
  db.recordLoan('u1', { personName: 'Karim', direction: 'receivable', event_type: 'lend', amount: 1000, transaction_date: '2026-11-03' });
  db.recordLoan('u1', { personName: 'karim', direction: 'receivable', event_type: 'lend', amount: 800, transaction_date: '2026-11-05' });
  db.recordLoan('u1', { personName: 'Karim', direction: 'receivable', event_type: 'collect_loan', amount: 600, transaction_date: '2026-11-09' });

  assert.equal(db.getUserPeople('u1').length, 2);
  balances = computePersonBalances(db.getUserPeople('u1'), db.getUserLoans('u1'));
  const karim = balances.find((b) => b.person_name === 'Karim');
  assert.equal(karim.total_principal, 1800);
  assert.equal(karim.total_settled, 600);
  assert.equal(karim.outstanding_balance, 1200);
});

test('6 & 7. Strict accounting isolation: borrowing/lending/repayments NEVER affect income or expenses', () => {
  const db = new InMemoryLedger();
  db.addTransaction('u1', { type: 'income', amount: 10000, transaction_date: '2026-11-01' });
  db.addTransaction('u1', { type: 'expense', amount: 2500, transaction_date: '2026-11-03' });
  db.recordLoan('u1', { personName: 'Sajib', direction: 'payable', event_type: 'borrow', amount: 5000, transaction_date: '2026-11-04' });
  db.recordLoan('u1', { personName: 'Sajib', direction: 'payable', event_type: 'repay_debt', amount: 2000, transaction_date: '2026-11-06' });
  db.recordLoan('u1', { personName: 'Nadia', direction: 'receivable', event_type: 'lend', amount: 3000, transaction_date: '2026-11-05' });
  db.recordLoan('u1', { personName: 'Nadia', direction: 'receivable', event_type: 'collect_loan', amount: 1000, transaction_date: '2026-11-07' });

  const summary = computeMonthlySummary(db.getUserTransactions('u1'), db.getUserLoans('u1'), 2026, 11);
  assert.equal(summary.total_income, 10000, 'Borrowing and loan collections must NOT be counted as income');
  assert.equal(summary.total_expenses, 2500, 'Lending and debt repayments must NOT be counted as expenses');
  assert.equal(summary.net_cash_flow, 7500);
  assert.equal(summary.total_i_owe, 3000);
  assert.equal(summary.total_owed_to_me, 2000);
});

test('8 & 9. Edit/delete recalculation and multi-month/yearly historical reporting', () => {
  const db = new InMemoryLedger();
  const txOct = db.addTransaction('u1', { type: 'expense', amount: 4000, category_name: 'Education', transaction_date: '2026-10-15' });
  db.addTransaction('u1', { type: 'expense', amount: 1500, category_name: 'Food', transaction_date: '2026-11-10' });
  db.addTransaction('u1', { type: 'income', amount: 15000, category_name: 'Salary', transaction_date: '2026-10-01' });

  let yearly = computeYearlySummary(db.getUserTransactions('u1'), db.getUserLoans('u1'), 2026);
  assert.equal(yearly.highest_spending_month, 10);
  assert.equal(yearly.highest_spending_amount, 4000);
  assert.equal(yearly.average_monthly_spending, 2750);

  // Edit October expense down to 1000 and verify recalculation
  txOct.amount = 1000;
  yearly = computeYearlySummary(db.getUserTransactions('u1'), db.getUserLoans('u1'), 2026);
  assert.equal(yearly.highest_spending_month, 11);
  assert.equal(yearly.highest_spending_amount, 1500);
  assert.equal(yearly.total_expenses, 2500);

  // Delete October expense and verify recalculation
  db.transactions = db.transactions.filter((t) => t.id !== txOct.id);
  const octSummary = computeMonthlySummary(db.getUserTransactions('u1'), db.getUserLoans('u1'), 2026, 10);
  assert.equal(octSummary.total_expenses, 0);
  assert.equal(octSummary.total_income, 15000);
});

test('11. Multi-user data isolation', () => {
  const db = new InMemoryLedger();
  db.addTransaction('user_A', { type: 'expense', amount: 900, transaction_date: '2026-11-10' });
  db.addTransaction('user_B', { type: 'expense', amount: 4500, transaction_date: '2026-11-10' });

  const sumA = computeMonthlySummary(db.getUserTransactions('user_A'), db.getUserLoans('user_A'), 2026, 11);
  const sumB = computeMonthlySummary(db.getUserTransactions('user_B'), db.getUserLoans('user_B'), 2026, 11);
  assert.equal(sumA.total_expenses, 900);
  assert.equal(sumB.total_expenses, 4500);
});

test('12. Offline queue persistence, retry safety, and deduplicated sync', async () => {
  const storage = new MemoryStorage();
  const mgr = new OfflineSyncManager(storage);
  const db = new InMemoryLedger();

  const queued = mgr.enqueue('create_transaction', {
    type: 'expense',
    amount: 220,
    categoryName: 'Transport',
    description: 'CNG ride',
    transactionDate: '2026-11-27',
  });

  assert.equal(mgr.getPendingCount(), 1);

  // Simulate a failed first sync attempt: item must NOT be lost
  const failRes = await mgr.flush(async () => { throw new Error('Network unreachable'); });
  assert.equal(failRes.synced, 0);
  assert.equal(failRes.remaining, 1);

  // Simulate successful sync
  const okRes = await mgr.flush(async (item) => {
    db.addTransaction('u1', {
      type: item.payload.type,
      amount: item.payload.amount,
      category_name: item.payload.categoryName,
      description: item.payload.description,
      transaction_date: item.payload.transactionDate,
      client_mutation_id: item.client_mutation_id,
    });
  });
  assert.equal(okRes.synced, 1);
  assert.equal(okRes.remaining, 0);

  // Re-submitting the same client_mutation_id must NOT create a duplicate
  db.addTransaction('u1', {
    type: 'expense',
    amount: 220,
    transaction_date: '2026-11-27',
    client_mutation_id: queued.client_mutation_id,
  });
  assert.equal(db.getUserTransactions('u1').length, 1);
});

test('Unified filter & Excel-compatible UTF-8 BOM CSV export', () => {
  const rows = [
    { id: '1', transaction_date: '2026-11-20', transaction_type: 'expense', category_name: 'Food', person_name: null, amount: 450, description: 'Biryani, tea', occurred_at: '2026-11-20T13:00:00Z' },
    { id: '2', transaction_date: '2026-11-21', transaction_type: 'borrow', category_name: 'Borrowed', person_name: 'Tanvir', amount: 2000, description: 'Books', occurred_at: '2026-11-21T14:00:00Z' },
  ];

  const filtered = filterUnifiedTransactions(rows, { query: 'tanvir', type: 'borrow' });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].id, '2');

  const csv = buildCsvExport(rows);
  assert.ok(csv.startsWith('\uFEFF'), 'CSV must start with UTF-8 BOM for Excel compatibility');
  assert.ok(csv.includes('"Biryani, tea"'), 'CSV must properly quote commas');
});
