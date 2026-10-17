-- Migration 007: allow team draws even when there are not enough goalkeepers.
-- Run after migration 006_team_goalkeeper_assignment.sql.
-- A team may have goalkeeper_member_id = null. If a keeper is assigned,
-- they must be in that team's roster and have goalkeeper or line-goalkeeper flag.

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
BEGIN
  SELECT group_id INTO v_group
    FROM public.matches
   WHERE id = p_match_id;

  IF v_group IS NULL OR NOT public.is_group_admin(v_group) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  IF p_teams IS NULL OR pg_catalog.jsonb_typeof(p_teams) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Invalid teams payload';
  END IF;
  IF pg_catalog.jsonb_array_length(p_teams) < 2
     OR pg_catalog.jsonb_array_length(p_teams) > 4 THEN
    RAISE EXCEPTION 'The number of teams must be between 2 and 4';
  END IF;

  -- Validate payload before deleting the previously saved draw.
  FOR v_team IN SELECT value FROM pg_catalog.jsonb_array_elements(p_teams)
  LOOP
    IF pg_catalog.jsonb_typeof(v_team->'players') IS DISTINCT FROM 'array'
       OR pg_catalog.jsonb_array_length(v_team->'players') = 0 THEN
      RAISE EXCEPTION 'Every team must contain players';
    END IF;

    -- Optional designated goalkeeper. NULL is a supported state.
    v_keeper_id := NULLIF(v_team->>'goalkeeper_member_id', '')::uuid;

    IF v_keeper_id IS NOT NULL THEN
      IF NOT EXISTS (
        SELECT 1
          FROM pg_catalog.jsonb_array_elements(v_team->'players') AS p(player_json)
         WHERE (p.player_json->>'member_id')::uuid = v_keeper_id
      ) THEN
        RAISE EXCEPTION 'The designated goalkeeper must be included in the team roster';
      END IF;

      IF NOT EXISTS (
        SELECT 1
          FROM public.group_members gm
         WHERE gm.id = v_keeper_id
           AND gm.group_id = v_group
           AND gm.active
           AND (gm.is_goalkeeper OR gm.is_line_goalkeeper)
      ) THEN
        RAISE EXCEPTION 'The designated player must be marked as goalkeeper or line goalkeeper';
      END IF;
    END IF;

    FOR v_player IN SELECT value FROM pg_catalog.jsonb_array_elements(v_team->'players')
    LOOP
      v_member_id := (v_player->>'member_id')::uuid;
      IF NOT EXISTS (
        SELECT 1
          FROM public.group_members gm
         WHERE gm.id = v_member_id
           AND gm.group_id = v_group
           AND gm.active
      ) THEN
        RAISE EXCEPTION 'Invalid or inactive player in team';
      END IF;
    END LOOP;
  END LOOP;

  -- A player must not be included in more than one team.
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

    INSERT INTO public.teams(match_id, name)
    VALUES (p_match_id, v_team->>'name')
    RETURNING id INTO v_team_id;

    FOR v_player IN SELECT value FROM pg_catalog.jsonb_array_elements(v_team->'players')
    LOOP
      v_member_id := (v_player->>'member_id')::uuid;
      SELECT gm.skill_level INTO v_level
        FROM public.group_members gm
       WHERE gm.id = v_member_id
         AND gm.group_id = v_group;

      INSERT INTO public.team_players(
        team_id, member_id, skill_level_at_draw, is_assigned_goalkeeper
      ) VALUES (
        v_team_id, v_member_id, v_level, coalesce(v_member_id = v_keeper_id, false)
      );
    END LOOP;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.save_balanced_teams(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_balanced_teams(uuid, jsonb) TO authenticated;
