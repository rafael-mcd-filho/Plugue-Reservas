UPDATE public.automation_settings
SET
  message_template = CASE
    WHEN type = 'confirmation_message'
      AND message_template = 'Olá {nome}! Sua reserva para {pessoas} pessoa(s) no dia {data} às {hora} foi confirmada. Até lá!'
      THEN 'Olá, {nome}! ✨ Sua reserva para {pessoas} pessoa(s) no dia {data} às {hora} está confirmada.

Acompanhe sua reserva por aqui 👇
{link_acompanhamento}'
    WHEN type = 'reminder_24h'
      AND message_template = 'Olá {nome}! Lembrete: sua reserva é amanhã, dia {data} às {hora}, para {pessoas} pessoa(s). Esperamos você!'
      THEN 'Olá, {nome}! ⏰ Passando para lembrar da sua reserva amanhã, dia {data} às {hora}, para {pessoas} pessoa(s). Vai ser um prazer te receber! 🍽️'
    WHEN type = 'reminder_1h'
      AND message_template = 'Olá {nome}! Lembrete: sua reserva é hoje às {hora} para {pessoas} pessoa(s). Estamos esperando você!'
      THEN 'Olá, {nome}! ⏳ Falta pouco: sua reserva é hoje às {hora} para {pessoas} pessoa(s). Estamos te esperando! 🍽️'
    WHEN type = 'cancellation_message'
      AND message_template = 'Olá {nome}, sua reserva do dia {data} às {hora} foi cancelada. Caso queira reagendar, acesse nosso link de reservas.'
      THEN 'Olá, {nome}. Sua reserva do dia {data} às {hora} foi cancelada.

Se quiser acompanhar ou fazer uma nova reserva, acesse por aqui 👇
{link_acompanhamento}'
    WHEN type = 'post_visit'
      AND message_template = 'Olá {nome}! Obrigado pela visita! Esperamos que tenha gostado. Nos vemos em breve!'
      THEN 'Olá, {nome}! ✨ Obrigado pela visita. Esperamos que você tenha aproveitado a experiência. Volte sempre! 💛'
    WHEN type = 'birthday_message'
      AND message_template = 'Parabéns, {nome}! Desejamos um feliz aniversário! Que tal comemorar conosco? Faça sua reserva!'
      THEN 'Parabéns, {nome}! 🎉 Desejamos um aniversário incrível, cheio de alegria e bons momentos. Quando quiser comemorar com a gente, vai ser um prazer te receber! 🥂'
    WHEN type = 'waitlist_entry'
      AND message_template = 'Olá {nome}! Você está na posição {posicao} da lista de espera ({pessoas} pessoa(s)).

Acompanhe em tempo real:
{link_acompanhamento}'
      THEN 'Olá, {nome}! ⏳ Você entrou na nossa lista de espera para {pessoas} pessoa(s).
No momento, sua posição é {posicao}.

Acompanhe em tempo real por aqui 👇
{link_acompanhamento}'
    WHEN type = 'waitlist_called'
      AND message_template IN (
        '{nome}, sua mesa está pronta! Dirija-se à recepção. Você tem 5 minutos para se apresentar.',
        '{nome}, sua mesa está pronta! Dirija-se à recepção. Você tem 10 minutos para se apresentar.'
      )
      THEN '{nome}, sua mesa está pronta! 🔔 Dirija-se à recepção. Você tem 5 minutos para se apresentar.'
    ELSE message_template
  END,
  updated_at = now()
WHERE
  (type = 'confirmation_message'
    AND message_template = 'Olá {nome}! Sua reserva para {pessoas} pessoa(s) no dia {data} às {hora} foi confirmada. Até lá!')
  OR (type = 'reminder_24h'
    AND message_template = 'Olá {nome}! Lembrete: sua reserva é amanhã, dia {data} às {hora}, para {pessoas} pessoa(s). Esperamos você!')
  OR (type = 'reminder_1h'
    AND message_template = 'Olá {nome}! Lembrete: sua reserva é hoje às {hora} para {pessoas} pessoa(s). Estamos esperando você!')
  OR (type = 'cancellation_message'
    AND message_template = 'Olá {nome}, sua reserva do dia {data} às {hora} foi cancelada. Caso queira reagendar, acesse nosso link de reservas.')
  OR (type = 'post_visit'
    AND message_template = 'Olá {nome}! Obrigado pela visita! Esperamos que tenha gostado. Nos vemos em breve!')
  OR (type = 'birthday_message'
    AND message_template = 'Parabéns, {nome}! Desejamos um feliz aniversário! Que tal comemorar conosco? Faça sua reserva!')
  OR (type = 'waitlist_entry'
    AND message_template = 'Olá {nome}! Você está na posição {posicao} da lista de espera ({pessoas} pessoa(s)).

Acompanhe em tempo real:
{link_acompanhamento}')
  OR (type = 'waitlist_called'
    AND message_template IN (
      '{nome}, sua mesa está pronta! Dirija-se à recepção. Você tem 5 minutos para se apresentar.',
      '{nome}, sua mesa está pronta! Dirija-se à recepção. Você tem 10 minutos para se apresentar.'
    ));
