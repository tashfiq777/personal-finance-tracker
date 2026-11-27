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
