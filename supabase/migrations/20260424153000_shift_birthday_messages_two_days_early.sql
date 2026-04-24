UPDATE public.automation_settings
SET
  message_template = 'Oi, {nome}! 🎉 Seu aniversário está chegando e faltam só 2 dias para essa data especial. Quando quiser comemorar com a gente, vai ser um prazer te receber! 🥂',
  updated_at = now()
WHERE type = 'birthday_message'
  AND message_template IN (
    'Parabéns, {nome}! 🎉 Desejamos um aniversário incrível, cheio de alegria e bons momentos. Quando quiser comemorar com a gente, vai ser um prazer te receber! 🥂',
    'Parabéns, {nome}! Desejamos um feliz aniversário! Que tal comemorar conosco? Faça sua reserva!'
  );
