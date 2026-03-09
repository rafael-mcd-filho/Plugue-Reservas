ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS opening_hours jsonb DEFAULT '[
    {"day":"Seg","open":"17:30","close":"22:30"},
    {"day":"Ter","open":"17:30","close":"22:30"},
    {"day":"Qua","open":"17:30","close":"22:30"},
    {"day":"Qui","open":"17:30","close":"22:30"},
    {"day":"Sex","open":"17:30","close":"22:30"},
    {"day":"Sáb","open":"17:30","close":"22:30"},
    {"day":"Dom","open":"17:30","close":"22:30"}
  ]'::jsonb,
  ADD COLUMN IF NOT EXISTS payment_methods jsonb DEFAULT '{"dinheiro":true,"credito":true,"debito":true,"pix":true,"vale_refeicao":false}'::jsonb;