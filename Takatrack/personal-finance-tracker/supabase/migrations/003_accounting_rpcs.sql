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
