/**
 * database.js — Supabase Client & Typed Financial Data Access Layer
 * -----------------------------------------------------------------
 * Uses lazy dynamic import for the Supabase SDK so offline loads never
 * crash the ES module graph before the UI can render.
 */

import { loadConfig, isConfigValid } from './config.js';
import { parseIntegerBDT, validateLoanDirectionEvent } from './accounting.js';
import { getTodayBD } from './utils.js';

let supabase = null;

export async function initDatabase() {
  if (supabase) return supabase;
  const cfg = await loadConfig();
  if (!isConfigValid(cfg)) {
    throw new Error('SUPABASE_NOT_CONFIGURED');
  }

  let createClient;
  try {
    const mod = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
    createClient = mod.createClient;
  } catch {
    throw new Error('SUPABASE_SDK_OFFLINE');
  }

  supabase = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
  return supabase;
}

export function getSupabase() {
  if (!supabase) throw new Error('Database client not initialized.');
  return supabase;
}

export async function getCurrentUser() {
  const client = getSupabase();
  const { data, error } = await client.auth.getUser();
  if (error) throw error;
  return data.user;
}

/* ===========================
   CATEGORIES
   =========================== */

export async function ensureDefaultCategories() {
  const client = getSupabase();
  const { error } = await client.rpc('ensure_default_categories');
  if (error) console.warn('Could not seed default categories:', error.message);
}

export async function getCategories(type = null) {
  const client = getSupabase();
  let query = client
    .from('categories')
    .select('*')
    .order('is_default', { ascending: false })
    .order('name', { ascending: true });

  if (type) query = query.eq('type', type);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

export async function createCategory({ name, type, color = '#0F766E' }) {
  const cleanName = String(name || '').trim();
  if (!cleanName) throw new Error('Category name is required.');
  if (!['expense', 'income'].includes(type)) throw new Error('Invalid category type.');

  const user = await getCurrentUser();
  const { data, error } = await getSupabase()
    .from('categories')
    .insert({
      user_id: user.id,
      name: cleanName,
      type,
      color,
      is_default: false,
    })
    .select()
    .single();

  if (error) {
    if (error.code === '23505') throw new Error('A category with this name already exists.');
    throw error;
  }
  return data;
}

export async function deleteCategory(id) {
  const { error } = await getSupabase().from('categories').delete().eq('id', id);
  if (error) throw error;
}

/* ===========================
   EXPENSES & INCOME
   =========================== */

export async function createTransaction({
  type,
  amount,
  categoryId = null,
  categoryName = 'Uncategorized',
  description = '',
  transactionDate = null,
  clientMutationId = null,
}) {
  if (!['expense', 'income'].includes(type)) {
    throw new Error('Transaction type must be expense or income.');
  }
  const parsed = parseIntegerBDT(amount);
  if (!parsed.ok) throw new Error(parsed.error);

  const user = await getCurrentUser();
  const payload = {
    user_id: user.id,
    type,
    amount: parsed.value,
    category_id: categoryId || null,
    category_name: String(categoryName || '').trim() || 'Uncategorized',
    description: String(description || '').trim() || null,
    transaction_date: transactionDate || getTodayBD(),
    client_mutation_id: clientMutationId || null,
  };

  const { data, error } = await getSupabase()
    .from('transactions')
    .upsert(payload, {
      onConflict: 'user_id,client_mutation_id',
      ignoreDuplicates: false,
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function updateTransaction(id, { amount, categoryId, categoryName, description, transactionDate }) {
  const parsed = parseIntegerBDT(amount);
  if (!parsed.ok) throw new Error(parsed.error);

  const { data, error } = await getSupabase()
    .from('transactions')
    .update({
      amount: parsed.value,
      category_id: categoryId || null,
      category_name: String(categoryName || '').trim() || 'Uncategorized',
      description: String(description || '').trim() || null,
      transaction_date: transactionDate,
    })
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function deleteTransaction(id) {
  const { error } = await getSupabase().from('transactions').delete().eq('id', id);
  if (error) throw error;
}

export async function getMonthlyTransactions(year, month) {
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const end = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

  const { data, error } = await getSupabase()
    .from('transactions')
    .select('*')
    .gte('transaction_date', start)
    .lte('transaction_date', end)
    .order('transaction_date', { ascending: false })
    .order('occurred_at', { ascending: false });

  if (error) throw error;
  return data || [];
}

/* ===========================
   DASHBOARD & REPORTS RPCs
   =========================== */

export async function getDashboardSummary(year, month) {
  const { data, error } = await getSupabase().rpc('get_dashboard_summary', {
    p_year: year,
    p_month: month,
  });
  if (error) throw error;
  return data;
}

export async function getYearlyReport(year) {
  const { data, error } = await getSupabase().rpc('get_yearly_report', {
    p_year: year,
  });
  if (error) throw error;
  return data;
}

/* ===========================
   PEOPLE & LOANS (ATOMIC)
   =========================== */

export async function getPeopleList() {
  const { data, error } = await getSupabase()
    .from('people')
    .select('*')
    .order('name', { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function getPersonBalances(direction = null) {
  let query = getSupabase()
    .from('person_balances')
    .select('*')
    .order('outstanding_balance', { ascending: false })
    .order('person_name', { ascending: true });

  if (direction) query = query.eq('direction', direction);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

export async function getPersonDetails(personId, direction) {
  const client = getSupabase();
  const [personRes, txRes] = await Promise.all([
    client.from('people').select('*').eq('id', personId).single(),
    client
      .from('loan_transactions')
      .select('*')
      .eq('person_id', personId)
      .eq('direction', direction)
      .order('transaction_date', { ascending: false })
      .order('occurred_at', { ascending: false }),
  ]);

  if (personRes.error) throw personRes.error;
  if (txRes.error) throw txRes.error;

  const transactions = txRes.data || [];
  let totalPrincipal = 0;
  let totalSettled = 0;
  for (const tx of transactions) {
    if (tx.event_type === 'borrow' || tx.event_type === 'lend') totalPrincipal += Number(tx.amount);
    else totalSettled += Number(tx.amount);
  }

  return {
    person: personRes.data,
    direction,
    total_principal: totalPrincipal,
    total_settled: totalSettled,
    outstanding_balance: totalPrincipal - totalSettled,
    transactions,
  };
}

export async function recordLoanEvent({
  personId = null,
  personName = null,
  direction,
  eventType,
  amount,
  description = '',
  transactionDate = null,
  allowOverpayment = false,
  clientMutationId = null,
}) {
  const dirCheck = validateLoanDirectionEvent(direction, eventType);
  if (!dirCheck.ok) throw new Error(dirCheck.error);

  const parsed = parseIntegerBDT(amount);
  if (!parsed.ok) throw new Error(parsed.error);

  const { data, error } = await getSupabase().rpc('record_loan_event', {
    p_direction: direction,
    p_event_type: eventType,
    p_amount: parsed.value,
    p_person_id: personId || null,
    p_person_name: personName ? String(personName).trim() : null,
    p_description: String(description || '').trim() || null,
    p_transaction_date: transactionDate || getTodayBD(),
    p_allow_overpayment: Boolean(allowOverpayment),
    p_client_mutation_id: clientMutationId || null,
  });

  if (error) {
    if (error.message && error.message.includes('OVERPAYMENT_EXCEEDS_BALANCE:')) {
      const bal = Number(error.message.split('OVERPAYMENT_EXCEEDS_BALANCE:')[1]);
      const err = new Error(`Amount exceeds the current outstanding balance of ৳${bal}.`);
      err.code = 'OVERPAYMENT_EXCEEDS_BALANCE';
      err.outstandingBalance = bal;
      throw err;
    }
    throw error;
  }
  return data;
}

export async function updateLoanTransaction(id, { amount, description, transactionDate }) {
  const parsed = parseIntegerBDT(amount);
  if (!parsed.ok) throw new Error(parsed.error);

  const { data, error } = await getSupabase()
    .from('loan_transactions')
    .update({
      amount: parsed.value,
      description: String(description || '').trim() || null,
      transaction_date: transactionDate,
    })
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function deleteLoanTransaction(id) {
  const { error } = await getSupabase().from('loan_transactions').delete().eq('id', id);
  if (error) throw error;
}

/* ===========================
   UNIFIED LEDGER & BACKUP
   =========================== */

export async function getUnifiedTransactions({ limit = 500 } = {}) {
  const { data, error } = await getSupabase()
    .from('unified_transactions')
    .select('*')
    .order('transaction_date', { ascending: false })
    .order('occurred_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data || [];
}

export async function exportAllUserData() {
  const client = getSupabase();
  const [cats, people, txs, loans] = await Promise.all([
    client.from('categories').select('*').order('created_at', { ascending: true }),
    client.from('people').select('*').order('created_at', { ascending: true }),
    client.from('transactions').select('*').order('transaction_date', { ascending: true }),
    client.from('loan_transactions').select('*').order('transaction_date', { ascending: true }),
  ]);

  if (cats.error) throw cats.error;
  if (people.error) throw people.error;
  if (txs.error) throw txs.error;
  if (loans.error) throw loans.error;

  return {
    schema_version: 1,
    exported_at: new Date().toISOString(),
    currency: 'BDT',
    categories: cats.data || [],
    people: people.data || [],
    transactions: txs.data || [],
    loan_transactions: loans.data || [],
  };
}

export async function importUserBackup(backupJson) {
  if (!backupJson || backupJson.schema_version !== 1) {
    throw new Error('Unsupported or invalid backup file format.');
  }
  const user = await getCurrentUser();
  const client = getSupabase();

  if (Array.isArray(backupJson.categories)) {
    for (const c of backupJson.categories) {
      if (!c.name || !['expense', 'income'].includes(c.type)) continue;
      await client
        .from('categories')
        .upsert(
          {
            user_id: user.id,
            name: c.name,
            type: c.type,
            color: c.color || '#0F766E',
            is_default: Boolean(c.is_default),
          },
          { onConflict: 'user_id,type,normalized_name', ignoreDuplicates: true }
        );
    }
  }

  const personIdMap = new Map();
  if (Array.isArray(backupJson.people)) {
    for (const p of backupJson.people) {
      if (!p.name) continue;
      const { data, error } = await client
        .from('people')
        .upsert(
          {
            user_id: user.id,
            name: p.name,
            phone: p.phone || null,
            notes: p.notes || null,
          },
          { onConflict: 'user_id,normalized_name' }
        )
        .select()
        .single();
      if (!error && data) {
        personIdMap.set(p.id, data.id);
      }
    }
  }

  let importedTx = 0;
  if (Array.isArray(backupJson.transactions)) {
    for (const t of backupJson.transactions) {
      const parsed = parseIntegerBDT(t.amount);
      if (!parsed.ok || !['expense', 'income'].includes(t.type)) continue;
      const { error } = await client.from('transactions').upsert(
        {
          user_id: user.id,
          client_mutation_id: t.client_mutation_id || t.id,
          type: t.type,
          amount: parsed.value,
          category_name: t.category_name || 'Uncategorized',
          description: t.description || null,
          transaction_date: t.transaction_date || getTodayBD(),
          occurred_at: t.occurred_at || new Date().toISOString(),
        },
        { onConflict: 'user_id,client_mutation_id', ignoreDuplicates: true }
      );
      if (!error) importedTx += 1;
    }
  }

  let importedLoans = 0;
  if (Array.isArray(backupJson.loan_transactions)) {
    for (const lt of backupJson.loan_transactions) {
      const mappedPersonId = personIdMap.get(lt.person_id);
      const parsed = parseIntegerBDT(lt.amount);
      if (!mappedPersonId || !parsed.ok) continue;
      const { error } = await client.from('loan_transactions').upsert(
        {
          user_id: user.id,
          client_mutation_id: lt.client_mutation_id || lt.id,
          person_id: mappedPersonId,
          direction: lt.direction,
          event_type: lt.event_type,
          amount: parsed.value,
          description: lt.description || null,
          is_overpayment_override: Boolean(lt.is_overpayment_override),
          transaction_date: lt.transaction_date || getTodayBD(),
          occurred_at: lt.occurred_at || new Date().toISOString(),
        },
        { onConflict: 'user_id,client_mutation_id', ignoreDuplicates: true }
      );
      if (!error) importedLoans += 1;
    }
  }

  return { importedTx, importedLoans };
}
