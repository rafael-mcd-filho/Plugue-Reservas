-- Padroniza o rotulo de sabado em opening_hours de companies para 'Sáb'.
-- O lookup local agora e tolerante a Sab/Sábado, mas mantemos os dados
-- consistentes para o painel admin nao mostrar valor antigo sem acento.

UPDATE public.companies
SET opening_hours = (
  SELECT jsonb_agg(
    CASE
      WHEN element->>'day' = 'Sab' THEN element || '{"day": "Sáb"}'::jsonb
      ELSE element
    END
  )
  FROM jsonb_array_elements(opening_hours) AS element
)
WHERE opening_hours IS NOT NULL
  AND jsonb_typeof(opening_hours) = 'array'
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(opening_hours) AS element
    WHERE element->>'day' = 'Sab'
  );
