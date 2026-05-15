UPDATE public.automation_settings
SET message_template = 'Oi, {nome}! 🎉 Seu aniversário está chegando e faltam só 4 dias para essa data especial. Quando quiser comemorar com a gente, vai ser um prazer te receber! 🥂',
    updated_at = now()
WHERE type = 'birthday_message'
  AND message_template = 'Oi, {nome}! 🎉 Seu aniversário está chegando e faltam só 2 dias para essa data especial. Quando quiser comemorar com a gente, vai ser um prazer te receber! 🥂';
