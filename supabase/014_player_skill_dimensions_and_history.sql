-- Migration 014: three fractional player ratings and automatic historical adjustment.
-- Run after the existing migrations 011, 012 and 013.

-- Separate values replace the single user-facing skill rating. Keep skill_level
-- for compatibility with older functions and existing guest-registration RPCs.
ALTER TABLE public.group_members
  ADD COLUMN IF NOT EXISTS attack_level numeric(3,1),
  ADD COLUMN IF NOT EXISTS defense_level numeric(3,1),
  ADD COLUMN IF NOT EXISTS historical_level numeric(3,1),
  ADD COLUMN IF NOT EXISTS historical_level_base numeric(5,2);

-- Existing players inherit their former rating into all three dimensions.
UPDATE public.group_members
   SET attack_level = COALESCE(attack_level, skill_level::numeric, 3.0),
       defense_level = COALESCE(defense_level, skill_level::numeric, 3.0),
       historical_level = COALESCE(historical_level, skill_level::numeric, 3.0),
       historical_level_base = COALESCE(historical_level_base, historical_level, skill_level::numeric, 3.0);

ALTER TABLE public.group_members
  ALTER COLUMN attack_level SET DEFAULT 3.0,
  ALTER COLUMN attack_level SET NOT NULL,
  ALTER COLUMN defense_level SET DEFAULT 3.0,
  ALTER COLUMN defense_level SET NOT NULL,
  ALTER COLUMN historical_level SET DEFAULT 3.0,
  ALTER COLUMN historical_level SET NOT NULL,
  ALTER COLUMN historical_level_base SET DEFAULT 3.0,
  ALTER COLUMN historical_level_base SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname='group_members_attack_level_range' AND conrelid='public.group_members'::regclass) THEN
    ALTER TABLE public.group_members ADD CONSTRAINT group_members_attack_level_range CHECK (attack_level BETWEEN 1.0 AND 5.0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname='group_members_defense_level_range' AND conrelid='public.group_members'::regclass) THEN
    ALTER TABLE public.group_members ADD CONSTRAINT group_members_defense_level_range CHECK (defense_level BETWEEN 1.0 AND 5.0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname='group_members_historical_level_range' AND conrelid='public.group_members'::regclass) THEN
    ALTER TABLE public.group_members ADD CONSTRAINT group_members_historical_level_range CHECK (historical_level BETWEEN 1.0 AND 5.0);
  END IF;
END;
$$;

-- Save the three ratings at the time the lineup is saved, so old game histories
-- do not change when a player's current ratings later change.
ALTER TABLE public.team_players
  ADD COLUMN IF NOT EXISTS attack_level_at_draw numeric(3,1),
  ADD COLUMN IF NOT EXISTS defense_level_at_draw numeric(3,1),
  ADD COLUMN IF NOT EXISTS historical_level_at_draw numeric(3,1);

UPDATE public.team_players
   SET attack_level_at_draw = COALESCE(attack_level_at_draw, skill_level_at_draw::numeric, 3.0),
       defense_level_at_draw = COALESCE(defense_level_at_draw, skill_level_at_draw::numeric, 3.0),
       historical_level_at_draw = COALESCE(historical_level_at_draw, skill_level_at_draw::numeric, 3.0);

ALTER TABLE public.team_players
  ALTER COLUMN attack_level_at_draw SET DEFAULT 3.0,
  ALTER COLUMN attack_level_at_draw SET NOT NULL,
  ALTER COLUMN defense_level_at_draw SET DEFAULT 3.0,
  ALTER COLUMN defense_level_at_draw SET NOT NULL,
  ALTER COLUMN historical_level_at_draw SET DEFAULT 3.0,
  ALTER COLUMN historical_level_at_draw SET NOT NULL;

-- Ledger of the historical-rating effect for each player in each closed match.
-- It allows score correction/re-closure without counting the same result twice.
CREATE TABLE IF NOT EXISTS public.match_player_rating_changes (
  match_id uuid NOT NULL REFERENCES public.matches(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES public.group_members(id) ON DELETE CASCADE,
  delta numeric(3,1) NOT NULL CHECK (delta IN (-0.1, 0.0, 0.1)),
  PRIMARY KEY (match_id, member_id)
);
REVOKE ALL ON TABLE public.match_player_rating_changes FROM PUBLIC, anon, authenticated;

-- Save a new three-rating snapshot when a division is drawn or manually edited.
CREATE OR REPLACE FUNCTION public.save_balanced_teams(
  p_match_id uuid,
  p_teams jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_group uuid;
  v_team jsonb;
  v_player jsonb;
  v_team_id uuid;
  v_keeper_id uuid;
  v_member_id uuid;
  v_level smallint;
  v_attack numeric(3,1);
  v_defense numeric(3,1);
  v_history numeric(3,1);
BEGIN
  SELECT group_id INTO v_group FROM public.matches WHERE id = p_match_id;
  IF v_group IS NULL OR NOT public.is_group_admin(v_group) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF p_teams IS NULL OR pg_catalog.jsonb_typeof(p_teams) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Invalid teams payload';
  END IF;
  IF pg_catalog.jsonb_array_length(p_teams) < 2 OR pg_catalog.jsonb_array_length(p_teams) > 4 THEN
    RAISE EXCEPTION 'The number of teams must be between 2 and 4';
  END IF;

  -- Validate before deleting the previously saved division.
  FOR v_team IN SELECT value FROM pg_catalog.jsonb_array_elements(p_teams)
  LOOP
    IF pg_catalog.jsonb_typeof(v_team->'players') IS DISTINCT FROM 'array'
       OR pg_catalog.jsonb_array_length(v_team->'players') = 0 THEN
      RAISE EXCEPTION 'Every team must contain players';
    END IF;
    v_keeper_id := NULLIF(v_team->>'goalkeeper_member_id', '')::uuid;
    IF v_keeper_id IS NOT NULL THEN
      IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_array_elements(v_team->'players') AS p(player_json)
        WHERE (p.player_json->>'member_id')::uuid = v_keeper_id
      ) THEN
        RAISE EXCEPTION 'The designated goalkeeper must be included in the team roster';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM public.group_members gm
        WHERE gm.id = v_keeper_id AND gm.group_id = v_group
          AND ((gm.active AND (gm.is_goalkeeper OR gm.is_line_goalkeeper))
            OR EXISTS (
              SELECT 1 FROM public.team_players tp JOIN public.teams t ON t.id = tp.team_id
              WHERE t.match_id = p_match_id AND tp.member_id = v_keeper_id AND tp.is_assigned_goalkeeper
            ))
      ) THEN
        RAISE EXCEPTION 'The designated player must be marked as goalkeeper or line goalkeeper';
      END IF;
    END IF;
    FOR v_player IN SELECT value FROM pg_catalog.jsonb_array_elements(v_team->'players')
    LOOP
      v_member_id := (v_player->>'member_id')::uuid;
      IF NOT EXISTS (
        SELECT 1 FROM public.group_members gm
        WHERE gm.id = v_member_id AND gm.group_id = v_group
          AND (gm.active OR EXISTS (
            SELECT 1 FROM public.team_players tp JOIN public.teams t ON t.id = tp.team_id
            WHERE t.match_id = p_match_id AND tp.member_id = v_member_id
          ))
      ) THEN
        RAISE EXCEPTION 'Invalid or inactive player in team';
      END IF;
    END LOOP;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_teams) AS t(team_json)
    CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(t.team_json->'players') AS p(player_json)
    GROUP BY (p.player_json->>'member_id')::uuid
    HAVING pg_catalog.count(*) > 1
  ) THEN
    RAISE EXCEPTION 'A player cannot be assigned to more than one team';
  END IF;

  DELETE FROM public.teams WHERE match_id = p_match_id;
  FOR v_team IN SELECT value FROM pg_catalog.jsonb_array_elements(p_teams)
  LOOP
    v_keeper_id := NULLIF(v_team->>'goalkeeper_member_id', '')::uuid;
    INSERT INTO public.teams(match_id, name) VALUES (p_match_id, v_team->>'name') RETURNING id INTO v_team_id;
    FOR v_player IN SELECT value FROM pg_catalog.jsonb_array_elements(v_team->'players')
    LOOP
      v_member_id := (v_player->>'member_id')::uuid;
      SELECT gm.skill_level, gm.attack_level, gm.defense_level, gm.historical_level
        INTO v_level, v_attack, v_defense, v_history
        FROM public.group_members gm WHERE gm.id = v_member_id AND gm.group_id = v_group;
      INSERT INTO public.team_players(
        team_id, member_id, skill_level_at_draw, is_assigned_goalkeeper,
        attack_level_at_draw, defense_level_at_draw, historical_level_at_draw
      ) VALUES (
        v_team_id, v_member_id, v_level, COALESCE(v_member_id = v_keeper_id, false),
        v_attack, v_defense, v_history
      );
    END LOOP;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.save_balanced_teams(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_balanced_teams(uuid, jsonb) TO authenticated;

-- Update all three values through an admin-only RPC. Editing the historical
-- value adjusts its baseline so the current rating remains the value entered,
-- while future match results continue to add/subtract tenths.
CREATE OR REPLACE FUNCTION public.update_member_skill_levels(
  p_member_id uuid,
  p_attack_level numeric,
  p_defense_level numeric,
  p_historical_level numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_group uuid;
  v_total_delta numeric(8,1);
  v_base numeric(5,2);
  v_result jsonb;
BEGIN
  SELECT gm.group_id INTO v_group FROM public.group_members gm WHERE gm.id = p_member_id FOR UPDATE;
  IF v_group IS NULL OR NOT public.is_group_admin(v_group) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF p_attack_level IS NULL OR p_attack_level < 1.0 OR p_attack_level > 5.0 OR p_attack_level <> pg_catalog.round(p_attack_level, 1)
     OR p_defense_level IS NULL OR p_defense_level < 1.0 OR p_defense_level > 5.0 OR p_defense_level <> pg_catalog.round(p_defense_level, 1)
     OR p_historical_level IS NULL OR p_historical_level < 1.0 OR p_historical_level > 5.0 OR p_historical_level <> pg_catalog.round(p_historical_level, 1) THEN
    RAISE EXCEPTION 'Informe níveis entre 1,0 e 5,0 com uma casa decimal.';
  END IF;
  SELECT COALESCE(pg_catalog.sum(r.delta), 0.0) INTO v_total_delta
    FROM public.match_player_rating_changes r WHERE r.member_id = p_member_id;
  v_base := pg_catalog.round(p_historical_level, 1) - v_total_delta;
  UPDATE public.group_members gm
     SET attack_level = pg_catalog.round(p_attack_level, 1),
         defense_level = pg_catalog.round(p_defense_level, 1),
         historical_level_base = v_base,
         historical_level = pg_catalog.round(p_historical_level, 1),
         skill_level = pg_catalog.round((p_attack_level + p_defense_level + p_historical_level) / 3.0)::smallint
   WHERE gm.id = p_member_id AND gm.group_id = v_group
   RETURNING pg_catalog.jsonb_build_object(
     'attack_level', gm.attack_level,
     'defense_level', gm.defense_level,
     'historical_level', gm.historical_level
   ) INTO v_result;
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.update_member_skill_levels(uuid, numeric, numeric, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_member_skill_levels(uuid, numeric, numeric, numeric) TO authenticated;

-- Close (or correct) a match and recalculate historical ratings from the ledger.
-- Unique top score: +0.1 to its roster; below top: -0.1; tied leaders: no change.
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
  SELECT m.group_id, m.status INTO v_group, v_status
    FROM public.matches m WHERE m.id = p_match_id FOR UPDATE;
  IF v_group IS NULL OR NOT public.is_group_admin(v_group) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF v_status NOT IN ('scheduled', 'completed') THEN
    RAISE EXCEPTION 'Esta pelada não pode ser encerrada neste estado.';
  END IF;
  SELECT pg_catalog.count(*) INTO v_team_count FROM public.teams t WHERE t.match_id = p_match_id;
  IF v_team_count < 2 THEN
    RAISE EXCEPTION 'A pelada precisa ter uma divisão salva com pelo menos dois times.';
  END IF;
  IF p_scores IS NULL OR pg_catalog.jsonb_typeof(p_scores) IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_array_length(p_scores) <> v_team_count THEN
    RAISE EXCEPTION 'Informe o placar para todos os times da divisão salva.';
  END IF;
  IF (
    SELECT pg_catalog.count(DISTINCT (item->>'team_id')::uuid)
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
    UPDATE public.teams SET score = v_score WHERE id = v_team_id AND match_id = p_match_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Um dos times informados não pertence a esta pelada.'; END IF;
  END LOOP;

  -- Replacing these ledger rows makes score corrections idempotent: the same
  -- game contributes only its current result, not one extra adjustment per edit.
  DELETE FROM public.match_player_rating_changes WHERE match_id = p_match_id;
  INSERT INTO public.match_player_rating_changes(match_id, member_id, delta)
  WITH team_results AS (
    SELECT t.id AS team_id, t.score, pg_catalog.max(t.score) OVER () AS max_score
      FROM public.teams t WHERE t.match_id = p_match_id
  ), ranked AS (
    SELECT tr.*, pg_catalog.count(*) FILTER (WHERE tr.score = tr.max_score) OVER () AS top_count
      FROM team_results tr
  )
  SELECT p_match_id, tp.member_id,
         CASE WHEN ranked.score < ranked.max_score THEN -0.1::numeric
              WHEN ranked.top_count = 1 THEN 0.1::numeric
              ELSE 0.0::numeric END
    FROM ranked
    JOIN public.team_players tp ON tp.team_id = ranked.team_id;

  -- Recompute the visible rating from its base plus every match effect in the
  -- ledger. This remains correct if a result is edited after later matches.
  WITH rated AS (
    SELECT gm.id,
           pg_catalog.round(LEAST(5.0::numeric, GREATEST(1.0::numeric,
             gm.historical_level_base + COALESCE((
               SELECT pg_catalog.sum(r.delta) FROM public.match_player_rating_changes r WHERE r.member_id = gm.id
             ), 0.0::numeric)
           )), 1) AS new_history
      FROM public.group_members gm WHERE gm.group_id = v_group
  )
  UPDATE public.group_members gm
     SET historical_level = rated.new_history,
         skill_level = pg_catalog.round((gm.attack_level + gm.defense_level + rated.new_history) / 3.0)::smallint
    FROM rated WHERE rated.id = gm.id;

  UPDATE public.matches SET status = 'completed', closed_at = COALESCE(closed_at, now()) WHERE id = p_match_id;
END;
$$;
REVOKE ALL ON FUNCTION public.close_match_with_scores(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.close_match_with_scores(uuid, jsonb) TO authenticated;

-- If an administrator deletes a completed game, remove its historical effect
-- from affected players before the match's ledger rows cascade-delete.
CREATE OR REPLACE FUNCTION public.recompute_history_before_match_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.match_player_rating_changes r WHERE r.match_id = OLD.id) THEN
    WITH rated AS (
      SELECT gm.id,
             pg_catalog.round(LEAST(5.0::numeric, GREATEST(1.0::numeric,
               gm.historical_level_base + COALESCE((
                 SELECT pg_catalog.sum(r.delta) FROM public.match_player_rating_changes r
                  WHERE r.member_id = gm.id AND r.match_id <> OLD.id
               ), 0.0::numeric)
             )), 1) AS new_history
        FROM public.group_members gm
       WHERE gm.group_id = OLD.group_id
         AND EXISTS (SELECT 1 FROM public.match_player_rating_changes r WHERE r.match_id = OLD.id AND r.member_id = gm.id)
    )
    UPDATE public.group_members gm
       SET historical_level = rated.new_history,
           skill_level = pg_catalog.round((gm.attack_level + gm.defense_level + rated.new_history) / 3.0)::smallint
      FROM rated WHERE rated.id = gm.id;
  END IF;
  RETURN OLD;
END;
$$;
DROP TRIGGER IF EXISTS recompute_history_before_match_delete ON public.matches;
CREATE TRIGGER recompute_history_before_match_delete
BEFORE DELETE ON public.matches
FOR EACH ROW EXECUTE FUNCTION public.recompute_history_before_match_delete();
