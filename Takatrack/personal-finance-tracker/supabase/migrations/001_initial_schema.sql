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
