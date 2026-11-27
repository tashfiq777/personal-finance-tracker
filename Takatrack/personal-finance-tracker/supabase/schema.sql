-- ============================================================================
-- Migration 001: Initial Normalized Schema for Personal Finance Tracker (BDT)
-- ============================================================================
-- Rules enforced at the database level:
--   1. All monetary values stored as BIGINT integer Bangladeshi Taka (BDT).
--   2. All amounts strictly positive (amount > 0); direction/type carries sign.
--   3. One persistent person profile per (user_id, normalized_name).
--   4. Expenses & income live in `transactions`; debts & loans live in
--      `loan_transactions` so loans can NEVER contaminate income/expense totals.
--   5. Client mutation IDs support idempotent offline queue synchronization.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1. User Profiles
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name TEXT,
  currency TEXT NOT NULL DEFAULT 'BDT' CHECK (currency = 'BDT'),
  timezone TEXT NOT NULL DEFAULT 'Asia/Dhaka',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Custom & Default Categories (Expense / Income)
CREATE TABLE IF NOT EXISTS public.categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 50),
  normalized_name TEXT GENERATED ALWAYS AS (lower(btrim(name))) STORED,
  type TEXT NOT NULL CHECK (type IN ('expense', 'income')),
  color TEXT DEFAULT '#0F766E',
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_categories_user_type_name UNIQUE (user_id, type, normalized_name)
);

CREATE INDEX IF NOT EXISTS idx_categories_user_type
  ON public.categories (user_id, type);

-- 3. Persistent People Profiles (Debt & Lending Counterparties)
CREATE TABLE IF NOT EXISTS public.people (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  normalized_name TEXT GENERATED ALWAYS AS (lower(btrim(name))) STORED,
  phone TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_people_user_normalized_name UNIQUE (user_id, normalized_name)
);

CREATE INDEX IF NOT EXISTS idx_people_user_name
  ON public.people (user_id, normalized_name);

-- 4. Core Transactions (STRICTLY Expenses and Income ONLY)
CREATE TABLE IF NOT EXISTS public.transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  client_mutation_id UUID,
  type TEXT NOT NULL CHECK (type IN ('expense', 'income')),
  amount BIGINT NOT NULL CHECK (amount > 0),
  category_id UUID REFERENCES public.categories(id) ON DELETE SET NULL,
  category_name TEXT NOT NULL DEFAULT 'Uncategorized' CHECK (length(btrim(category_name)) BETWEEN 1 AND 50),
  description TEXT CHECK (description IS NULL OR length(description) <= 300),
  transaction_date DATE NOT NULL DEFAULT ((now() AT TIME ZONE 'Asia/Dhaka')::date),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_transactions_client_mutation UNIQUE (user_id, client_mutation_id)
);

CREATE INDEX IF NOT EXISTS idx_transactions_user_date
  ON public.transactions (user_id, transaction_date DESC, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_transactions_user_type_date
  ON public.transactions (user_id, type, transaction_date DESC);

CREATE INDEX IF NOT EXISTS idx_transactions_user_category
  ON public.transactions (user_id, category_name);

-- 5. Loan Transactions (Borrowing, Lending, Repayments, Collections)
CREATE TABLE IF NOT EXISTS public.loan_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  client_mutation_id UUID,
  person_id UUID NOT NULL REFERENCES public.people(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('payable', 'receivable')),
  event_type TEXT NOT NULL CHECK (event_type IN ('borrow', 'lend', 'repay_debt', 'collect_loan')),
  amount BIGINT NOT NULL CHECK (amount > 0),
  description TEXT CHECK (description IS NULL OR length(description) <= 300),
  is_overpayment_override BOOLEAN NOT NULL DEFAULT false,
  transaction_date DATE NOT NULL DEFAULT ((now() AT TIME ZONE 'Asia/Dhaka')::date),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_loan_direction_event_match CHECK (
    (direction = 'payable' AND event_type IN ('borrow', 'repay_debt'))
    OR
    (direction = 'receivable' AND event_type IN ('lend', 'collect_loan'))
  ),
  CONSTRAINT uq_loan_transactions_client_mutation UNIQUE (user_id, client_mutation_id)
);

CREATE INDEX IF NOT EXISTS idx_loan_tx_user_person_dir
  ON public.loan_transactions (user_id, person_id, direction, transaction_date DESC);

CREATE INDEX IF NOT EXISTS idx_loan_tx_user_date
  ON public.loan_transactions (user_id, transaction_date DESC, occurred_at DESC);

-- 6. Automatic updated_at Trigger Function
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_profiles_updated_at ON public.profiles;
CREATE TRIGGER trg_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_people_updated_at ON public.people;
CREATE TRIGGER trg_people_updated_at
  BEFORE UPDATE ON public.people
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_transactions_updated_at ON public.transactions;
CREATE TRIGGER trg_transactions_updated_at
  BEFORE UPDATE ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_loan_transactions_updated_at ON public.loan_transactions;
CREATE TRIGGER trg_loan_transactions_updated_at
  BEFORE UPDATE ON public.loan_transactions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 7. Derived Person Balances View (Always Calculated from Underlying Records)
CREATE OR REPLACE VIEW public.person_balances
WITH (security_invoker = true) AS
SELECT
  lt.user_id,
  lt.person_id,
  p.name AS person_name,
  p.phone AS person_phone,
  p.notes AS person_notes,
  lt.direction,
  COALESCE(SUM(CASE WHEN lt.event_type IN ('borrow', 'lend') THEN lt.amount ELSE 0 END), 0)::BIGINT AS total_principal,
  COALESCE(SUM(CASE WHEN lt.event_type IN ('repay_debt', 'collect_loan') THEN lt.amount ELSE 0 END), 0)::BIGINT AS total_settled,
  (
    COALESCE(SUM(CASE WHEN lt.event_type IN ('borrow', 'lend') THEN lt.amount ELSE 0 END), 0)
    - COALESCE(SUM(CASE WHEN lt.event_type IN ('repay_debt', 'collect_loan') THEN lt.amount ELSE 0 END), 0)
  )::BIGINT AS outstanding_balance,
  COUNT(*)::INT AS transaction_count,
  MAX(lt.occurred_at) AS last_activity_at
FROM public.loan_transactions lt
JOIN public.people p ON p.id = lt.person_id
GROUP BY lt.user_id, lt.person_id, p.name, p.phone, p.notes, lt.direction;

-- 8. Unified Transaction History View (All 6 Transaction Types)
CREATE OR REPLACE VIEW public.unified_transactions
WITH (security_invoker = true) AS
SELECT
  t.id,
  t.user_id,
  'transactions'::TEXT AS source_table,
  t.type AS transaction_type,
  t.amount,
  t.category_id,
  t.category_name,
  NULL::UUID AS person_id,
  NULL::TEXT AS person_name,
  NULL::TEXT AS direction,
  t.description,
  t.transaction_date,
  t.occurred_at,
  t.created_at
FROM public.transactions t
UNION ALL
SELECT
  lt.id,
  lt.user_id,
  'loan_transactions'::TEXT AS source_table,
  lt.event_type AS transaction_type,
  lt.amount,
  NULL::UUID AS category_id,
  CASE lt.event_type
    WHEN 'borrow' THEN 'Borrowed'
    WHEN 'lend' THEN 'Lent'
    WHEN 'repay_debt' THEN 'Debt Repayment'
    WHEN 'collect_loan' THEN 'Loan Collection'
  END AS category_name,
  lt.person_id,
  p.name AS person_name,
  lt.direction,
  lt.description,
  lt.transaction_date,
  lt.occurred_at,
  lt.created_at
FROM public.loan_transactions lt
JOIN public.people p ON p.id = lt.person_id;

-- 9. Auto-create Profile & Default Categories on New User Signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data ->> 'full_name', ''))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.categories (user_id, name, type, color, is_default)
  VALUES
    (NEW.id, 'Food', 'expense', '#EF4444', true),
    (NEW.id, 'Transport', 'expense', '#F97316', true),
    (NEW.id, 'Education', 'expense', '#3B82F6', true),
    (NEW.id, 'Shopping', 'expense', '#A855F7', true),
    (NEW.id, 'Entertainment', 'expense', '#EC4899', true),
    (NEW.id, 'Bills', 'expense', '#EAB308', true),
    (NEW.id, 'Personal', 'expense', '#06B6D4', true),
    (NEW.id, 'Other', 'expense', '#64748B', true),
    (NEW.id, 'Allowance', 'income', '#10B981', true),
    (NEW.id, 'Salary', 'income', '#059669', true),
    (NEW.id, 'Freelance', 'income', '#0EA5E9', true),
    (NEW.id, 'Gift', 'income', '#8B5CF6', true),
    (NEW.id, 'Other', 'income', '#64748B', true)
  ON CONFLICT (user_id, type, normalized_name) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
-- ============================================================================
-- Migration 002: Strict Row Level Security (RLS) Policies
-- ============================================================================
-- Every user-owned table enforces private-by-default isolation so no user can
-- ever read, insert, update, or delete another user's financial records.
-- ============================================================================

-- Enable RLS on all user-owned tables
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.people ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loan_transactions ENABLE ROW LEVEL SECURITY;

-- Enforce RLS even for table owners where appropriate (optional best practice)
ALTER TABLE public.profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE public.categories FORCE ROW LEVEL SECURITY;
ALTER TABLE public.people FORCE ROW LEVEL SECURITY;
ALTER TABLE public.transactions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.loan_transactions FORCE ROW LEVEL SECURITY;

-- 1. PROFILES
DROP POLICY IF EXISTS "profiles_select_own" ON public.profiles;
CREATE POLICY "profiles_select_own"
  ON public.profiles FOR SELECT
  TO authenticated
  USING (auth.uid() = id);

DROP POLICY IF EXISTS "profiles_insert_own" ON public.profiles;
CREATE POLICY "profiles_insert_own"
  ON public.profiles FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = id);

DROP POLICY IF EXISTS "profiles_update_own" ON public.profiles;
CREATE POLICY "profiles_update_own"
  ON public.profiles FOR UPDATE
  TO authenticated
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- 2. CATEGORIES
DROP POLICY IF EXISTS "categories_select_own" ON public.categories;
CREATE POLICY "categories_select_own"
  ON public.categories FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "categories_insert_own" ON public.categories;
CREATE POLICY "categories_insert_own"
  ON public.categories FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "categories_update_own" ON public.categories;
CREATE POLICY "categories_update_own"
  ON public.categories FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "categories_delete_own" ON public.categories;
CREATE POLICY "categories_delete_own"
  ON public.categories FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- 3. PEOPLE
DROP POLICY IF EXISTS "people_select_own" ON public.people;
CREATE POLICY "people_select_own"
  ON public.people FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "people_insert_own" ON public.people;
CREATE POLICY "people_insert_own"
  ON public.people FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "people_update_own" ON public.people;
CREATE POLICY "people_update_own"
  ON public.people FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "people_delete_own" ON public.people;
CREATE POLICY "people_delete_own"
  ON public.people FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- 4. TRANSACTIONS (Expenses & Income)
DROP POLICY IF EXISTS "transactions_select_own" ON public.transactions;
CREATE POLICY "transactions_select_own"
  ON public.transactions FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "transactions_insert_own" ON public.transactions;
CREATE POLICY "transactions_insert_own"
  ON public.transactions FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "transactions_update_own" ON public.transactions;
CREATE POLICY "transactions_update_own"
  ON public.transactions FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "transactions_delete_own" ON public.transactions;
CREATE POLICY "transactions_delete_own"
  ON public.transactions FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- 5. LOAN TRANSACTIONS (Borrow, Lend, Repay, Collect)
DROP POLICY IF EXISTS "loan_transactions_select_own" ON public.loan_transactions;
CREATE POLICY "loan_transactions_select_own"
  ON public.loan_transactions FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "loan_transactions_insert_own" ON public.loan_transactions;
CREATE POLICY "loan_transactions_insert_own"
  ON public.loan_transactions FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM public.people p
      WHERE p.id = person_id AND p.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "loan_transactions_update_own" ON public.loan_transactions;
CREATE POLICY "loan_transactions_update_own"
  ON public.loan_transactions FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM public.people p
      WHERE p.id = person_id AND p.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "loan_transactions_delete_own" ON public.loan_transactions;
CREATE POLICY "loan_transactions_delete_own"
  ON public.loan_transactions FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);
-- ============================================================================
-- Migration 003: Atomic Financial RPCs & Server-Side Reporting Functions
-- ============================================================================
-- Uses SECURITY INVOKER so all queries execute under the caller's JWT and RLS.
-- Ensures atomic debt/repayment writes, overpayment validation, and accurate
-- server-side monthly/yearly summaries.
-- ============================================================================

-- 1. Atomic Loan Event Recorder (Borrow / Lend / Repay / Collect)
--    - Guarantees one persistent person profile per normalized name.
--    - Locks existing loan records for the person/direction to prevent races.
--    - Blocks repayments exceeding outstanding balance unless p_allow_overpayment = true.
--    - Idempotent via optional p_client_mutation_id.
CREATE OR REPLACE FUNCTION public.record_loan_event(
  p_direction TEXT,
  p_event_type TEXT,
  p_amount BIGINT,
  p_person_id UUID DEFAULT NULL,
  p_person_name TEXT DEFAULT NULL,
  p_description TEXT DEFAULT NULL,
  p_transaction_date DATE DEFAULT ((now() AT TIME ZONE 'Asia/Dhaka')::date),
  p_allow_overpayment BOOLEAN DEFAULT false,
  p_client_mutation_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_person_id UUID;
  v_person_name TEXT;
  v_existing_tx public.loan_transactions%ROWTYPE;
  v_new_tx public.loan_transactions%ROWTYPE;
  v_principal BIGINT := 0;
  v_settled BIGINT := 0;
  v_outstanding BIGINT := 0;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHORIZED: Authentication required.';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: Amount must be a positive integer in BDT.';
  END IF;

  IF NOT (
    (p_direction = 'payable' AND p_event_type IN ('borrow', 'repay_debt'))
    OR (p_direction = 'receivable' AND p_event_type IN ('lend', 'collect_loan'))
  ) THEN
    RAISE EXCEPTION 'INVALID_DIRECTION: Direction % does not match event_type %.', p_direction, p_event_type;
  END IF;

  -- Idempotency check for offline sync retries
  IF p_client_mutation_id IS NOT NULL THEN
    SELECT * INTO v_existing_tx
    FROM public.loan_transactions
    WHERE user_id = v_user_id AND client_mutation_id = p_client_mutation_id;

    IF FOUND THEN
      SELECT name INTO v_person_name FROM public.people WHERE id = v_existing_tx.person_id;
      RETURN jsonb_build_object(
        'id', v_existing_tx.id,
        'person_id', v_existing_tx.person_id,
        'person_name', v_person_name,
        'direction', v_existing_tx.direction,
        'event_type', v_existing_tx.event_type,
        'amount', v_existing_tx.amount,
        'deduplicated', true
      );
    END IF;
  END IF;

  -- Resolve or upsert the single persistent person profile
  IF p_person_id IS NOT NULL THEN
    SELECT id, name INTO v_person_id, v_person_name
    FROM public.people
    WHERE id = p_person_id AND user_id = v_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'PERSON_NOT_FOUND: Person profile does not exist.';
    END IF;
  ELSE
    IF p_person_name IS NULL OR length(btrim(p_person_name)) = 0 THEN
      RAISE EXCEPTION 'INVALID_PERSON: Person name is required.';
    END IF;

    INSERT INTO public.people (user_id, name)
    VALUES (v_user_id, btrim(p_person_name))
    ON CONFLICT (user_id, normalized_name)
    DO UPDATE SET updated_at = now()
    RETURNING id, name INTO v_person_id, v_person_name;
  END IF;

  -- Compute current outstanding balance atomically under person row lock
  SELECT
    COALESCE(SUM(CASE WHEN event_type IN ('borrow', 'lend') THEN amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN event_type IN ('repay_debt', 'collect_loan') THEN amount ELSE 0 END), 0)
  INTO v_principal, v_settled
  FROM public.loan_transactions
  WHERE user_id = v_user_id
    AND person_id = v_person_id
    AND direction = p_direction;

  v_outstanding := v_principal - v_settled;

  -- Guard against overpayment unless user explicitly confirms exceptional correction
  IF p_event_type IN ('repay_debt', 'collect_loan') THEN
    IF p_amount > v_outstanding AND NOT COALESCE(p_allow_overpayment, false) THEN
      RAISE EXCEPTION 'OVERPAYMENT_EXCEEDS_BALANCE:%', v_outstanding;
    END IF;
  END IF;

  -- Append new loan transaction (never overwrites original borrow/lend rows)
  INSERT INTO public.loan_transactions (
    user_id,
    client_mutation_id,
    person_id,
    direction,
    event_type,
    amount,
    description,
    is_overpayment_override,
    transaction_date
  )
  VALUES (
    v_user_id,
    p_client_mutation_id,
    v_person_id,
    p_direction,
    p_event_type,
    p_amount,
    NULLIF(btrim(COALESCE(p_description, '')), ''),
    (p_event_type IN ('repay_debt', 'collect_loan') AND p_amount > v_outstanding),
    COALESCE(p_transaction_date, (now() AT TIME ZONE 'Asia/Dhaka')::date)
  )
  RETURNING * INTO v_new_tx;

  -- Recompute updated totals
  IF p_event_type IN ('borrow', 'lend') THEN
    v_principal := v_principal + p_amount;
  ELSE
    v_settled := v_settled + p_amount;
  END IF;
  v_outstanding := v_principal - v_settled;

  RETURN jsonb_build_object(
    'id', v_new_tx.id,
    'person_id', v_person_id,
    'person_name', v_person_name,
    'direction', v_new_tx.direction,
    'event_type', v_new_tx.event_type,
    'amount', v_new_tx.amount,
    'description', v_new_tx.description,
    'transaction_date', v_new_tx.transaction_date,
    'occurred_at', v_new_tx.occurred_at,
    'total_principal', v_principal,
    'total_settled', v_settled,
    'outstanding_balance', v_outstanding,
    'deduplicated', false
  );
END;
$$;

-- 2. Dashboard Monthly Summary RPC
--    Strictly excludes borrowing, lending, repayments, and collections from
--    income & expense totals.
CREATE OR REPLACE FUNCTION public.get_dashboard_summary(
  p_year INT,
  p_month INT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_start_date DATE := make_date(p_year, p_month, 1);
  v_end_date DATE := (make_date(p_year, p_month, 1) + INTERVAL '1 month - 1 day')::date;
  v_total_expenses BIGINT := 0;
  v_total_income BIGINT := 0;
  v_total_i_owe BIGINT := 0;
  v_total_owed_to_me BIGINT := 0;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHORIZED: Authentication required.';
  END IF;

  SELECT
    COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0)
  INTO v_total_expenses, v_total_income
  FROM public.transactions
  WHERE user_id = v_user_id
    AND transaction_date BETWEEN v_start_date AND v_end_date;

  SELECT
    COALESCE(SUM(CASE WHEN direction = 'payable' AND outstanding_balance > 0 THEN outstanding_balance ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN direction = 'receivable' AND outstanding_balance > 0 THEN outstanding_balance ELSE 0 END), 0)
  INTO v_total_i_owe, v_total_owed_to_me
  FROM public.person_balances
  WHERE user_id = v_user_id;

  RETURN jsonb_build_object(
    'year', p_year,
    'month', p_month,
    'total_expenses', v_total_expenses,
    'total_income', v_total_income,
    'net_cash_flow', (v_total_income - v_total_expenses),
    'total_i_owe', v_total_i_owe,
    'total_owed_to_me', v_total_owed_to_me
  );
END;
$$;

-- 3. Yearly Summary RPC (12-month breakdown + average + highest spending month)
CREATE OR REPLACE FUNCTION public.get_yearly_report(
  p_year INT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_months JSONB;
  v_total_income BIGINT := 0;
  v_total_expenses BIGINT := 0;
  v_active_months INT := 0;
  v_avg_monthly_spending BIGINT := 0;
  v_highest_month INT := NULL;
  v_highest_amount BIGINT := 0;
  v_total_i_owe BIGINT := 0;
  v_total_owed_to_me BIGINT := 0;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHORIZED: Authentication required.';
  END IF;

  WITH month_series AS (
    SELECT generate_series(1, 12) AS month_num
  ),
  monthly_agg AS (
    SELECT
      EXTRACT(MONTH FROM transaction_date)::INT AS month_num,
      COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0)::BIGINT AS income,
      COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0)::BIGINT AS expenses
    FROM public.transactions
    WHERE user_id = v_user_id
      AND EXTRACT(YEAR FROM transaction_date)::INT = p_year
    GROUP BY 1
  ),
  combined AS (
    SELECT
      ms.month_num,
      COALESCE(ma.income, 0)::BIGINT AS income,
      COALESCE(ma.expenses, 0)::BIGINT AS expenses,
      (COALESCE(ma.income, 0) - COALESCE(ma.expenses, 0))::BIGINT AS net_cash_flow
    FROM month_series ms
    LEFT JOIN monthly_agg ma ON ma.month_num = ms.month_num
    ORDER BY ms.month_num
  )
  SELECT
    jsonb_agg(jsonb_build_object(
      'month', month_num,
      'income', income,
      'expenses', expenses,
      'net_cash_flow', net_cash_flow
    ) ORDER BY month_num),
    COALESCE(SUM(income), 0),
    COALESCE(SUM(expenses), 0),
    COUNT(*) FILTER (WHERE expenses > 0 OR income > 0)
  INTO v_months, v_total_income, v_total_expenses, v_active_months
  FROM combined;

  IF v_active_months > 0 THEN
    v_avg_monthly_spending := ROUND(v_total_expenses::NUMERIC / v_active_months)::BIGINT;
  END IF;

  SELECT
    EXTRACT(MONTH FROM transaction_date)::INT,
    SUM(amount)::BIGINT
  INTO v_highest_month, v_highest_amount
  FROM public.transactions
  WHERE user_id = v_user_id
    AND type = 'expense'
    AND EXTRACT(YEAR FROM transaction_date)::INT = p_year
  GROUP BY 1
  ORDER BY 2 DESC, 1 ASC
  LIMIT 1;

  SELECT
    COALESCE(SUM(CASE WHEN direction = 'payable' AND outstanding_balance > 0 THEN outstanding_balance ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN direction = 'receivable' AND outstanding_balance > 0 THEN outstanding_balance ELSE 0 END), 0)
  INTO v_total_i_owe, v_total_owed_to_me
  FROM public.person_balances
  WHERE user_id = v_user_id;

  RETURN jsonb_build_object(
    'year', p_year,
    'months', COALESCE(v_months, '[]'::jsonb),
    'total_income', v_total_income,
    'total_expenses', v_total_expenses,
    'net_cash_flow', (v_total_income - v_total_expenses),
    'active_months', v_active_months,
    'average_monthly_spending', v_avg_monthly_spending,
    'highest_spending_month', v_highest_month,
    'highest_spending_amount', COALESCE(v_highest_amount, 0),
    'total_i_owe', v_total_i_owe,
    'total_owed_to_me', v_total_owed_to_me
  );
END;
$$;

-- 4. Seed Default Categories Idempotently (fallback if user existed before trigger)
CREATE OR REPLACE FUNCTION public.ensure_default_categories()
RETURNS VOID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHORIZED: Authentication required.';
  END IF;

  INSERT INTO public.categories (user_id, name, type, color, is_default)
  VALUES
    (v_user_id, 'Food', 'expense', '#EF4444', true),
    (v_user_id, 'Transport', 'expense', '#F97316', true),
    (v_user_id, 'Education', 'expense', '#3B82F6', true),
    (v_user_id, 'Shopping', 'expense', '#A855F7', true),
    (v_user_id, 'Entertainment', 'expense', '#EC4899', true),
    (v_user_id, 'Bills', 'expense', '#EAB308', true),
    (v_user_id, 'Personal', 'expense', '#06B6D4', true),
    (v_user_id, 'Other', 'expense', '#64748B', true),
    (v_user_id, 'Allowance', 'income', '#10B981', true),
    (v_user_id, 'Salary', 'income', '#059669', true),
    (v_user_id, 'Freelance', 'income', '#0EA5E9', true),
    (v_user_id, 'Gift', 'income', '#8B5CF6', true),
    (v_user_id, 'Other', 'income', '#64748B', true)
  ON CONFLICT (user_id, type, normalized_name) DO NOTHING;
END;
$$;
