-- Migration 005: marcações adicionais dos jogadores.
-- Execute uma única vez no SQL Editor do Supabase existente, depois das migrations 001-004.
-- Todos os jogadores existentes e convidados começam com as marcações desligadas.

ALTER TABLE public.group_members
  ADD COLUMN IF NOT EXISTS is_goalkeeper boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_line_goalkeeper boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_fixed boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.group_members.is_goalkeeper IS
  'Indica se o jogador atua como goleiro.';
COMMENT ON COLUMN public.group_members.is_line_goalkeeper IS
  'Indica se o jogador atua como goleiro linha.';
COMMENT ON COLUMN public.group_members.is_fixed IS
  'Indica jogador fixo/mensalista, cobrado mensalmente e que costuma comparecer aos jogos.';

-- As políticas RLS existentes da tabela group_members permanecem em vigor.
-- Esta migration não concede permissões novas a usuários anônimos.
