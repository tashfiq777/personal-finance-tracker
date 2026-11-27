/**
 * reports.js — Monthly & Yearly Analytics Controller (Chart.js)
 * -------------------------------------------------------------
 * All metrics are calculated live from actual Supabase database records.
 * Borrowing, lending, repayments, and collections are strictly excluded
 * from income & expense charts and reported separately as balances.
 */

import { bootstrapPage } from './app.js';
import { getMonthlyTransactions, getYearlyReport } from './database.js';
import {
  formatBDT,
  getCurrentYearMonthBD,
  getMonthLabel,
  getShortMonthName,
  escapeHtml,
  showToast,
} from './utils.js';

let selectedYear;
let selectedMonth;
let dailyChart = null;
let categoryChart = null;
let yearlyChart = null;

const PALETTE = [
  '#0F766E', '#EF4444', '#F97316', '#3B82F6', '#A855F7',
  '#EC4899', '#EAB308', '#06B6D4', '#10B981', '#64748B',
];

function readInitialPeriod() {
  const params = new URLSearchParams(window.location.search);
  const y = Number.parseInt(params.get('year'), 10);
  const m = Number.parseInt(params.get('month'), 10);
  const now = getCurrentYearMonthBD();
  return {
    year: y >= 2000 && y <= 2100 ? y : now.year,
    month: m >= 1 && m <= 12 ? m : now.month,
  };
}

function syncPeriodToUrl() {
  const url = new URL(window.location.href);
  url.searchParams.set('year', String(selectedYear));
  url.searchParams.set('month', String(selectedMonth));
  window.history.replaceState({}, '', url);
}

function getChartTextColor() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark'
    || (!document.documentElement.getAttribute('data-theme')
      && window.matchMedia('(prefers-color-scheme: dark)').matches);
  return isDark ? '#CBD5E1' : '#475569';
}

function renderDailySpendingChart(monthlyTxs) {
  const daysInMonth = new Date(Date.UTC(selectedYear, selectedMonth, 0)).getUTCDate();
  const totals = new Array(daysInMonth).fill(0);
  for (const tx of monthlyTxs) {
    if (tx.type !== 'expense' || !tx.transaction_date) continue;
    const day = Number.parseInt(tx.transaction_date.slice(8, 10), 10);
    if (day >= 1 && day <= daysInMonth) totals[day - 1] += Number(tx.amount);
  }

  const ctx = document.getElementById('daily-spending-chart').getContext('2d');
  if (dailyChart) dailyChart.destroy();

  if (typeof window.Chart === 'undefined') return;
  dailyChart = new window.Chart(ctx, {
    type: 'bar',
    data: {
      labels: Array.from({ length: daysInMonth }, (_, i) => String(i + 1)),
      datasets: [{
        label: 'Daily Expense (৳)',
        data: totals,
        backgroundColor: '#EF4444',
        borderRadius: 6,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: { label: (ctxItem) => formatBDT(ctxItem.raw) },
        },
      },
      scales: {
        x: { ticks: { color: getChartTextColor(), maxRotation: 0 } },
        y: {
          beginAtZero: true,
          ticks: {
            color: getChartTextColor(),
            callback: (v) => `৳${v}`,
          },
        },
      },
    },
  });
}

function renderCategoryChart(monthlyTxs) {
  const map = new Map();
  let totalExp = 0;
  for (const tx of monthlyTxs) {
    if (tx.type !== 'expense') continue;
    const cat = tx.category_name || 'Uncategorized';
    const amt = Number(tx.amount);
    map.set(cat, (map.get(cat) || 0) + amt);
    totalExp += amt;
  }

  const entries = Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
  const listRoot = document.getElementById('category-breakdown-list');

  if (entries.length === 0) {
    if (categoryChart) {
      categoryChart.destroy();
      categoryChart = null;
    }
    listRoot.innerHTML = `<p class="text-muted" style="margin:0;text-align:center;font-size:0.88rem;">No expenses recorded in ${escapeHtml(getMonthLabel(selectedYear, selectedMonth))}.</p>`;
    return;
  }

  const labels = entries.map(([name]) => name);
  const values = entries.map(([, amt]) => amt);
  const colors = entries.map((_, i) => PALETTE[i % PALETTE.length]);

  const ctx = document.getElementById('category-chart').getContext('2d');
  if (categoryChart) categoryChart.destroy();

  if (typeof window.Chart !== 'undefined') {
    categoryChart = new window.Chart(ctx, {
      type: 'doughnut',
      data: {
        labels,
        datasets: [{ data: values, backgroundColor: colors, borderWidth: 0 }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '62%',
        plugins: {
          legend: { position: 'bottom', labels: { color: getChartTextColor(), boxWidth: 12 } },
          tooltip: {
            callbacks: {
              label: (item) => {
                const pct = totalExp > 0 ? Math.round((item.raw / totalExp) * 100) : 0;
                return `${item.label}: ${formatBDT(item.raw)} (${pct}%)`;
              },
            },
          },
        },
      },
    });
  }

  listRoot.innerHTML = entries.map(([name, amt], idx) => {
    const pct = totalExp > 0 ? Math.round((amt / totalExp) * 100) : 0;
    return `
      <div class="row-between" style="font-size:0.88rem;">
        <div class="row" style="gap:8px;">
          <span style="width:10px;height:10px;border-radius:50%;background:${colors[idx]};display:inline-block;"></span>
          <span>${escapeHtml(name)}</span>
        </div>
        <div class="tabular-nums"><strong>${formatBDT(amt)}</strong> <span class="text-muted">(${pct}%)</span></div>
      </div>
    `;
  }).join('');
}

function renderYearlyChart(yearlyData) {
  const months = yearlyData.months || [];
  const labels = months.map((m) => getShortMonthName(m.month));
  const incomes = months.map((m) => Number(m.income) || 0);
  const expenses = months.map((m) => Number(m.expenses) || 0);

  const ctx = document.getElementById('yearly-comparison-chart').getContext('2d');
  if (yearlyChart) yearlyChart.destroy();

  if (typeof window.Chart === 'undefined') return;
  yearlyChart = new window.Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Income (৳)', data: incomes, backgroundColor: '#10B981', borderRadius: 5 },
        { label: 'Expenses (৳)', data: expenses, backgroundColor: '#EF4444', borderRadius: 5 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: getChartTextColor() } },
        tooltip: {
          callbacks: { label: (item) => `${item.dataset.label}: ${formatBDT(item.raw)}` },
        },
      },
      scales: {
        x: { ticks: { color: getChartTextColor() } },
        y: {
          beginAtZero: true,
          ticks: {
            color: getChartTextColor(),
            callback: (v) => `৳${v}`,
          },
        },
      },
    },
  });
}

async function refreshReports() {
  syncPeriodToUrl();
  document.getElementById('rep-month-label').textContent = getMonthLabel(selectedYear, selectedMonth);
  document.getElementById('rep-year-inline').textContent = String(selectedYear);
  document.getElementById('rep-year-heading').textContent = String(selectedYear);

  try {
    const [monthlyTxs, yearly] = await Promise.all([
      getMonthlyTransactions(selectedYear, selectedMonth),
      getYearlyReport(selectedYear),
    ]);

    let mIncome = 0;
    let mExpenses = 0;
    for (const tx of monthlyTxs) {
      if (tx.type === 'income') mIncome += Number(tx.amount);
      else if (tx.type === 'expense') mExpenses += Number(tx.amount);
    }

    document.getElementById('rep-m-income').textContent = formatBDT(mIncome);
    document.getElementById('rep-m-expenses').textContent = formatBDT(mExpenses);
    const netEl = document.getElementById('rep-m-net');
    const net = mIncome - mExpenses;
    netEl.textContent = formatBDT(net, { signed: true });
    netEl.className = `kpi-value tabular-nums ${net >= 0 ? 'text-income' : 'text-expense'}`;

    document.getElementById('rep-y-avg').textContent = formatBDT(yearly.average_monthly_spending);
    document.getElementById('rep-y-income').textContent = formatBDT(yearly.total_income);
    document.getElementById('rep-y-expenses').textContent = formatBDT(yearly.total_expenses);
    document.getElementById('rep-total-owed').textContent = formatBDT(yearly.total_i_owe);
    document.getElementById('rep-total-lent').textContent = formatBDT(yearly.total_owed_to_me);

    if (yearly.highest_spending_month) {
      document.getElementById('rep-y-highest').textContent = getShortMonthName(yearly.highest_spending_month);
      document.getElementById('rep-y-highest-amt').textContent = formatBDT(yearly.highest_spending_amount);
    } else {
      document.getElementById('rep-y-highest').textContent = '—';
      document.getElementById('rep-y-highest-amt').textContent = 'No expenses yet';
    }

    renderDailySpendingChart(monthlyTxs);
    renderCategoryChart(monthlyTxs);
    renderYearlyChart(yearly);
  } catch (err) {
    showToast(err.message || 'Could not load reports.', 'error');
  }
}

bootstrapPage({
  activeNav: 'reports',
  onReady: async () => {
    const initial = readInitialPeriod();
    selectedYear = initial.year;
    selectedMonth = initial.month;

    document.getElementById('rep-prev-month').addEventListener('click', () => {
      selectedMonth -= 1;
      if (selectedMonth < 1) {
        selectedMonth = 12;
        selectedYear -= 1;
      }
      refreshReports();
    });

    document.getElementById('rep-next-month').addEventListener('click', () => {
      selectedMonth += 1;
      if (selectedMonth > 12) {
        selectedMonth = 1;
        selectedYear += 1;
      }
      refreshReports();
    });

    document.getElementById('rep-prev-year').addEventListener('click', () => {
      selectedYear -= 1;
      refreshReports();
    });

    document.getElementById('rep-next-year').addEventListener('click', () => {
      selectedYear += 1;
      refreshReports();
    });

    await refreshReports();
  },
});
