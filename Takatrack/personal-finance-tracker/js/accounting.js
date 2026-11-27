/**
 * accounting.js — Pure Accounting, Validation, Aggregation, & Export Engine
 * -------------------------------------------------------------------------
 * Strict accounting rules enforced everywhere:
 *  - Monetary amounts are strictly positive integer BDT (no floats).
 *  - Borrowing money is NOT income.
 *  - Lending money is NOT an expense.
 *  - Repaying a debt is NOT an expense.
 *  - Collecting a loan is NOT income.
 *  - Net cash flow = actual income - actual expenses.
 *  - Outstanding debt is always derived from underlying loan_transactions.
 */

export const EXPENSE_TYPES = new Set(['expense']);
export const INCOME_TYPES = new Set(['income']);
export const LOAN_EVENT_TYPES = new Set(['borrow', 'lend', 'repay_debt', 'collect_loan']);

/**
 * Parses and validates a positive integer BDT amount.
 * Rejects decimals, zero, negatives, and non-numeric strings.
 * @param {string|number} raw
 * @returns {{ ok: boolean, value?: number, error?: string }}
 */
export function parseIntegerBDT(raw) {
  if (raw === null || raw === undefined) {
    return { ok: false, error: 'Amount is required.' };
  }
  const str = String(raw).trim().replace(/,/g, '');
  if (!str) {
    return { ok: false, error: 'Amount is required.' };
  }
  if (!/^\d+$/.test(str)) {
    return { ok: false, error: 'Enter a whole number in Taka (no decimals or negative values).' };
  }
  const value = Number.parseInt(str, 10);
  if (!Number.isSafeInteger(value) || value <= 0) {
    return { ok: false, error: 'Amount must be greater than ৳0.' };
  }
  return { ok: true, value };
}

/**
 * Normalizes a person's name for persistent profile deduplication.
 * @param {string} name
 * @returns {string}
 */
export function normalizePersonName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Validates that loan direction matches the event type.
 * @param {'payable'|'receivable'} direction
 * @param {'borrow'|'lend'|'repay_debt'|'collect_loan'} eventType
 */
export function validateLoanDirectionEvent(direction, eventType) {
  if (direction === 'payable' && (eventType === 'borrow' || eventType === 'repay_debt')) {
    return { ok: true };
  }
  if (direction === 'receivable' && (eventType === 'lend' || eventType === 'collect_loan')) {
    return { ok: true };
  }
  return {
    ok: false,
    error: `Invalid direction (${direction}) for loan event (${eventType}).`,
  };
}

/**
 * Validates a repayment/collection against the current outstanding balance.
 * Prevents repayments exceeding outstanding balance unless explicitly confirmed.
 * @param {number} outstandingBalance
 * @param {number} amount
 * @param {boolean} allowOverpayment
 */
export function validateRepaymentAmount(outstandingBalance, amount, allowOverpayment = false) {
  const parsed = parseIntegerBDT(amount);
  if (!parsed.ok) return parsed;
  if (parsed.value > outstandingBalance && !allowOverpayment) {
    return {
      ok: false,
      requiresConfirmation: true,
      outstandingBalance,
      error: `Amount (৳${parsed.value}) exceeds the outstanding balance (৳${outstandingBalance}). Confirm if this is an intentional correction.`,
    };
  }
  return { ok: true, value: parsed.value, isOverpaymentOverride: parsed.value > outstandingBalance };
}

/**
 * Derives person balances strictly from underlying loan_transactions.
 * @param {Array} people
 * @param {Array} loanTransactions
 * @returns {Array}
 */
export function computePersonBalances(people, loanTransactions) {
  const peopleById = new Map(people.map((p) => [p.id, p]));
  const buckets = new Map();

  for (const tx of loanTransactions) {
    const key = `${tx.person_id}::${tx.direction}`;
    if (!buckets.has(key)) {
      const person = peopleById.get(tx.person_id) || { id: tx.person_id, name: tx.person_name || 'Unknown' };
      buckets.set(key, {
        person_id: tx.person_id,
        person_name: person.name,
        person_phone: person.phone || null,
        person_notes: person.notes || null,
        direction: tx.direction,
        total_principal: 0,
        total_settled: 0,
        outstanding_balance: 0,
        transaction_count: 0,
        last_activity_at: tx.occurred_at || tx.transaction_date,
      });
    }
    const b = buckets.get(key);
    const amt = Number(tx.amount) || 0;
    if (tx.event_type === 'borrow' || tx.event_type === 'lend') {
      b.total_principal += amt;
    } else if (tx.event_type === 'repay_debt' || tx.event_type === 'collect_loan') {
      b.total_settled += amt;
    }
    b.outstanding_balance = b.total_principal - b.total_settled;
    b.transaction_count += 1;
    const ts = tx.occurred_at || tx.transaction_date;
    if (ts && (!b.last_activity_at || ts > b.last_activity_at)) {
      b.last_activity_at = ts;
    }
  }

  return Array.from(buckets.values()).sort((a, b) => {
    if (b.outstanding_balance !== a.outstanding_balance) {
      return b.outstanding_balance - a.outstanding_balance;
    }
    return a.person_name.localeCompare(b.person_name);
  });
}

/**
 * Computes monthly dashboard summary strictly adhering to accounting rules.
 * @param {Array} transactions - rows from `transactions` (expense/income)
 * @param {Array} loanTransactions - rows from `loan_transactions`
 * @param {number} year - e.g. 2026
 * @param {number} month - 1..12
 */
export function computeMonthlySummary(transactions, loanTransactions, year, month) {
  const ymPrefix = `${year}-${String(month).padStart(2, '0')}`;
  let totalExpenses = 0;
  let totalIncome = 0;

  for (const tx of transactions) {
    if (!tx.transaction_date || !String(tx.transaction_date).startsWith(ymPrefix)) continue;
    const amt = Number(tx.amount) || 0;
    if (tx.type === 'expense') {
      totalExpenses += amt;
    } else if (tx.type === 'income') {
      totalIncome += amt;
    }
  }

  const balances = computePersonBalances([], loanTransactions);
  let totalIOwe = 0;
  let totalOwedToMe = 0;
  for (const b of balances) {
    if (b.direction === 'payable' && b.outstanding_balance > 0) {
      totalIOwe += b.outstanding_balance;
    } else if (b.direction === 'receivable' && b.outstanding_balance > 0) {
      totalOwedToMe += b.outstanding_balance;
    }
  }

  return {
    year,
    month,
    total_expenses: totalExpenses,
    total_income: totalIncome,
    net_cash_flow: totalIncome - totalExpenses,
    total_i_owe: totalIOwe,
    total_owed_to_me: totalOwedToMe,
  };
}

/**
 * Computes yearly 12-month analytics strictly from actual transactions & loans.
 * @param {Array} transactions
 * @param {Array} loanTransactions
 * @param {number} year
 */
export function computeYearlySummary(transactions, loanTransactions, year) {
  const yearPrefix = `${year}-`;
  const months = Array.from({ length: 12 }, (_, idx) => ({
    month: idx + 1,
    income: 0,
    expenses: 0,
    net_cash_flow: 0,
  }));

  for (const tx of transactions) {
    if (!tx.transaction_date || !String(tx.transaction_date).startsWith(yearPrefix)) continue;
    const m = Number.parseInt(String(tx.transaction_date).slice(5, 7), 10);
    if (m < 1 || m > 12) continue;
    const amt = Number(tx.amount) || 0;
    if (tx.type === 'income') months[m - 1].income += amt;
    else if (tx.type === 'expense') months[m - 1].expenses += amt;
  }

  let totalIncome = 0;
  let totalExpenses = 0;
  let activeMonths = 0;
  let highestMonth = null;
  let highestAmount = 0;

  for (const m of months) {
    m.net_cash_flow = m.income - m.expenses;
    totalIncome += m.income;
    totalExpenses += m.expenses;
    if (m.income > 0 || m.expenses > 0) activeMonths += 1;
    if (m.expenses > highestAmount) {
      highestAmount = m.expenses;
      highestMonth = m.month;
    }
  }

  const balances = computePersonBalances([], loanTransactions);
  let totalIOwe = 0;
  let totalOwedToMe = 0;
  for (const b of balances) {
    if (b.direction === 'payable' && b.outstanding_balance > 0) totalIOwe += b.outstanding_balance;
    if (b.direction === 'receivable' && b.outstanding_balance > 0) totalOwedToMe += b.outstanding_balance;
  }

  return {
    year,
    months,
    total_income: totalIncome,
    total_expenses: totalExpenses,
    net_cash_flow: totalIncome - totalExpenses,
    active_months: activeMonths,
    average_monthly_spending: activeMonths > 0 ? Math.round(totalExpenses / activeMonths) : 0,
    highest_spending_month: highestMonth,
    highest_spending_amount: highestAmount,
    total_i_owe: totalIOwe,
    total_owed_to_me: totalOwedToMe,
  };
}

/**
 * Filters and searches unified transaction history records.
 * @param {Array} records
 * @param {Object} filters
 */
export function filterUnifiedTransactions(records, filters = {}) {
  const q = String(filters.query || '').trim().toLowerCase();
  const minAmt = filters.minAmount ? Number(filters.minAmount) : null;
  const maxAmt = filters.maxAmount ? Number(filters.maxAmount) : null;

  return records.filter((r) => {
    if (filters.year && !String(r.transaction_date || '').startsWith(`${filters.year}-`)) {
      return false;
    }
    if (filters.month && filters.year) {
      const ym = `${filters.year}-${String(filters.month).padStart(2, '0')}`;
      if (!String(r.transaction_date || '').startsWith(ym)) return false;
    }
    if (filters.dateFrom && String(r.transaction_date) < filters.dateFrom) return false;
    if (filters.dateTo && String(r.transaction_date) > filters.dateTo) return false;
    if (filters.type && filters.type !== 'all' && r.transaction_type !== filters.type) return false;
    if (filters.category && filters.category !== 'all' && r.category_name !== filters.category) return false;
    if (filters.personId && filters.personId !== 'all' && r.person_id !== filters.personId) return false;
    if (minAmt !== null && !Number.isNaN(minAmt) && Number(r.amount) < minAmt) return false;
    if (maxAmt !== null && !Number.isNaN(maxAmt) && Number(r.amount) > maxAmt) return false;
    if (q) {
      const hay = `${r.description || ''} ${r.person_name || ''} ${r.category_name || ''} ${r.transaction_type || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/**
 * Builds an Excel-compatible UTF-8 CSV (with BOM) from unified ledger rows.
 * @param {Array} rows
 * @returns {string}
 */
export function buildCsvExport(rows) {
  const headers = [
    'Date',
    'Type',
    'Category',
    'Person',
    'Amount (BDT)',
    'Description',
    'Recorded At',
    'ID',
  ];

  const escapeCsv = (val) => {
    const str = val === null || val === undefined ? '' : String(val);
    if (/[",\n\r]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push([
      escapeCsv(r.transaction_date),
      escapeCsv(r.transaction_type),
      escapeCsv(r.category_name || ''),
      escapeCsv(r.person_name || ''),
      escapeCsv(r.amount),
      escapeCsv(r.description || ''),
      escapeCsv(r.occurred_at || r.created_at || ''),
      escapeCsv(r.id),
    ].join(','));
  }
  return `\uFEFF${lines.join('\r\n')}`;
}
