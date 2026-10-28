-- Migration 011: close a match and save the final score for every saved team.
-- Run after migrations 001-010.
-- Existing divisions in teams/team_players are preserved as the historical lineup.

ALTER TABLE public.matches
  ADD COLUMN IF NOT EXISTS closed_at timestamptz;

ALTER TABLE public.teams
  ADD COLUMN IF NOT EXISTS score integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'teams_score_nonnegative'
      AND conrelid = 'public.teams'::regclass
  ) THEN
    ALTER TABLE public.teams
      ADD CONSTRAINT teams_score_nonnegative
      CHECK (score IS NULL OR score >= 0);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.close_match_with_scores(
  p_match_id uuid,
  p_scores jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_group uuid;
  v_status text;
  v_team_count integer;
  v_item jsonb;
  v_team_id uuid;
  v_score_text text;
  v_score integer;
BEGIN
  SELECT m.group_id, m.status
    INTO v_group, v_status
    FROM public.matches m
   WHERE m.id = p_match_id
   FOR UPDATE;

  IF v_group IS NULL OR NOT public.is_group_admin(v_group) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  IF v_status NOT IN ('scheduled', 'completed') THEN
    RAISE EXCEPTION 'Esta pelada não pode ser encerrada neste estado.';
  END IF;

  SELECT count(*) INTO v_team_count
    FROM public.teams t
   WHERE t.match_id = p_match_id;

  IF v_team_count < 2 THEN
    RAISE EXCEPTION 'A pelada precisa ter uma divisão salva com pelo menos dois times.';
  END IF;

  IF p_scores IS NULL
     OR pg_catalog.jsonb_typeof(p_scores) IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_array_length(p_scores) <> v_team_count THEN
    RAISE EXCEPTION 'Informe o placar para todos os times da divisão salva.';
  END IF;

  IF (
    SELECT count(DISTINCT (item->>'team_id')::uuid)
      FROM pg_catalog.jsonb_array_elements(p_scores) AS scores(item)
  ) <> v_team_count THEN
    RAISE EXCEPTION 'O placar deve conter cada time exatamente uma vez.';
  END IF;

  FOR v_item IN SELECT value FROM pg_catalog.jsonb_array_elements(p_scores)
  LOOP
    IF pg_catalog.jsonb_typeof(v_item) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'Formato de placar inválido.';
    END IF;

    v_team_id := NULLIF(v_item->>'team_id', '')::uuid;
    v_score_text := v_item->>'score';

    IF v_score_text IS NULL OR v_score_text !~ '^[0-9]+$' THEN
      RAISE EXCEPTION 'Cada placar deve ser um inteiro igual ou maior que zero.';
    END IF;
    v_score := v_score_text::integer;

    UPDATE public.teams
       SET score = v_score
     WHERE id = v_team_id
       AND match_id = p_match_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Um dos times informados não pertence a esta pelada.';
    END IF;
  END LOOP;

  -- Keep status completed on score corrections and set the close timestamp once.
  UPDATE public.matches
     SET status = 'completed',
         closed_at = COALESCE(closed_at, now())
   WHERE id = p_match_id;
END;
$$;

REVOKE ALL ON FUNCTION public.close_match_with_scores(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.close_match_with_scores(uuid, jsonb) TO authenticated;
