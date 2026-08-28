-- Novas empresas passam a nascer no horario de Brasilia.
--
-- A coluna companies.time_zone foi criada em 20260820130000 com DEFAULT
-- 'America/Fortaleza', o que fez todas as empresas existentes herdarem esse
-- fuso independentemente da praca. Aqui apenas o default muda: nenhuma linha
-- existente e reescrita, para nao reagrupar silenciosamente relatorios ja
-- consultados. O ajuste das empresas atuais e feito pela tela de configuracoes.
ALTER TABLE public.companies
  ALTER COLUMN time_zone SET DEFAULT 'America/Sao_Paulo';

COMMENT ON COLUMN public.companies.time_zone IS
  'Fuso IANA da unidade, usado para agrupar reservas por dia nos relatorios. '
  'Editavel na aba Empresa das configuracoes e validado por '
  'companies_time_zone_valid.';
