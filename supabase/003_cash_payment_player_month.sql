-- Migration 003: vincular entradas do caixa a um jogador e mês de referência.
-- Execute uma única vez no SQL Editor do projeto Supabase existente.
-- Registros anteriores são preservados; entradas antigas sem vínculo aparecem no site como registros legados.

ALTER TABLE public.cash_transactions
  ADD COLUMN IF NOT EXISTS member_id uuid,
  ADD COLUMN IF NOT EXISTS reference_month date;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'cash_transactions_member_id_fkey'
      AND conrelid = 'public.cash_transactions'::regclass
  ) THEN
    ALTER TABLE public.cash_transactions
      ADD CONSTRAINT cash_transactions_member_id_fkey
      FOREIGN KEY (member_id)
      REFERENCES public.group_members(id)
      ON DELETE RESTRICT;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'cash_transactions_reference_month_first_day_check'
      AND conrelid = 'public.cash_transactions'::regclass
  ) THEN
    ALTER TABLE public.cash_transactions
      ADD CONSTRAINT cash_transactions_reference_month_first_day_check
      CHECK (reference_month IS NULL OR EXTRACT(DAY FROM reference_month) = 1);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_cash_group_reference_month
  ON public.cash_transactions(group_id, reference_month)
  WHERE type = 'income';

-- Validate every new income/payment. Historical rows can remain unlinked until reconciled.
-- Expenses do not carry player or month fields.
CREATE OR REPLACE FUNCTION public.validate_cash_payment_fields()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_member_group uuid;
BEGIN
  IF NEW.type = 'income' THEN
    IF NEW.member_id IS NULL THEN
      RAISE EXCEPTION 'Entrada exige o jogador que fez o pagamento.';
    END IF;
    IF NEW.reference_month IS NULL THEN
      RAISE EXCEPTION 'Entrada exige o mês de referência.';
    END IF;
    IF EXTRACT(DAY FROM NEW.reference_month) <> 1 THEN
      RAISE EXCEPTION 'O mês de referência deve ser informado como o primeiro dia do mês.';
    END IF;

    SELECT gm.group_id
      INTO v_member_group
      FROM public.group_members gm
     WHERE gm.id = NEW.member_id;

    IF v_member_group IS NULL OR v_member_group <> NEW.group_id THEN
      RAISE EXCEPTION 'O jogador selecionado não pertence a esta turma.';
    END IF;
  ELSE
    NEW.member_id := NULL;
    NEW.reference_month := NULL;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_cash_payment_fields ON public.cash_transactions;
CREATE TRIGGER trg_validate_cash_payment_fields
BEFORE INSERT OR UPDATE OF type, member_id, reference_month, group_id
ON public.cash_transactions
FOR EACH ROW
EXECUTE FUNCTION public.validate_cash_payment_fields();
