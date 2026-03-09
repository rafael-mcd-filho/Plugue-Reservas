
-- Insert 60 days of fictitious reservations for Sushi Zen House
INSERT INTO public.reservations (company_id, table_id, guest_name, guest_phone, guest_email, date, time, party_size, duration_minutes, status, occasion, created_at, updated_at)
SELECT 
  '1e0da55b-f8e9-4199-80b6-79c64e93cb7a'::uuid,
  CASE WHEN random() > 0.5 THEN '9a83e0fe-79e0-40e1-bdd5-1cfbab07752f'::uuid ELSE '57be60f4-936e-42f9-ac7f-7f2049f5709f'::uuid END,
  (ARRAY['Ana Silva', 'Carlos Souza', 'Maria Oliveira', 'João Santos', 'Fernanda Lima', 'Pedro Costa', 'Juliana Rocha', 'Lucas Almeida', 'Camila Mendes', 'Rafael Barbosa', 'Beatriz Ferreira', 'Thiago Ribeiro', 'Larissa Gomes', 'Marcos Pereira', 'Amanda Nascimento', 'Bruno Carvalho', 'Patricia Araujo', 'Diego Martins', 'Isabela Dias', 'Felipe Moreira'])[floor(random()*20+1)],
  '(11) 9' || lpad(floor(random()*90000000+10000000)::text, 8, '0'),
  lower(md5(random()::text)) || '@email.com',
  d::date,
  (ARRAY['17:30', '18:00', '18:30', '19:00', '19:30', '20:00', '20:30', '21:00', '21:30'])[floor(random()*9+1)]::time,
  floor(random()*4+1)::int,
  30,
  (ARRAY['confirmed', 'confirmed', 'confirmed', 'completed', 'completed', 'completed', 'pending', 'cancelled', 'no-show'])[floor(random()*9+1)],
  (ARRAY['Aniversário', 'Jantar Romântico', 'Reunião de Negócios', 'Confraternização', NULL, NULL, NULL])[floor(random()*7+1)],
  d + interval '10 hours',
  d + interval '10 hours'
FROM generate_series(CURRENT_DATE - interval '60 days', CURRENT_DATE, '1 day') AS d
CROSS JOIN generate_series(1, 4) AS n
WHERE extract(dow from d) NOT IN (1);

-- Insert funnel logs for the last 60 days
INSERT INTO public.reservation_funnel_logs (company_id, visitor_id, step, date, created_at)
SELECT 
  '1e0da55b-f8e9-4199-80b6-79c64e93cb7a'::uuid,
  'visitor-' || n::text,
  s.step,
  d::date,
  d + interval '12 hours'
FROM generate_series(CURRENT_DATE - interval '60 days', CURRENT_DATE, '1 day') AS d
CROSS JOIN generate_series(1, 8) AS n
CROSS JOIN (VALUES ('page_view'), ('date_select'), ('time_select'), ('form_fill'), ('completed')) AS s(step)
WHERE 
  (s.step = 'page_view') OR
  (s.step = 'date_select' AND n <= 6) OR
  (s.step = 'time_select' AND n <= 5) OR
  (s.step = 'form_fill' AND n <= 4) OR
  (s.step = 'completed' AND n <= 3)
ON CONFLICT DO NOTHING;
