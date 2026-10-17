-- Migration 009: link court expense transactions to the relevant match.
-- Run after 003_cash_payment_player_month.sql and after the matches table exists.
ALTER TABLE public.cash_transactions
  ADD COLUMN IF NOT EXISTS match_id uuid
  REFERENCES public.matches(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_cash_transactions_match_id
  ON public.cash_transactions(match_id);

-- Keep any linked match within the same group. This also prevents inserting
-- an expense linked to a match belonging to another group.
CREATE OR REPLACE FUNCTION public.validate_cash_transaction_match()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.match_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM public.matches m
     WHERE m.id = NEW.match_id
       AND m.group_id = NEW.group_id
  ) THEN
    RAISE EXCEPTION 'O jogo selecionado não pertence a esta turma.';
  END IF;

  IF NEW.type = 'expense' AND NEW.match_id IS NULL THEN
    -- Preserve historical cash rows when a linked match is deleted and the
    -- foreign key performs ON DELETE SET NULL. Manual attempts to unset the
    -- match while it still exists are rejected.
    IF TG_OP = 'UPDATE'
       AND OLD.match_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.matches m WHERE m.id = OLD.match_id
       ) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Selecione o jogo relacionado ao pagamento da quadra.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_cash_transaction_match
  ON public.cash_transactions;

CREATE TRIGGER trg_validate_cash_transaction_match
BEFORE INSERT OR UPDATE OF group_id, type, match_id
ON public.cash_transactions
FOR EACH ROW
EXECUTE FUNCTION public.validate_cash_transaction_match();
