# Emojis no WhatsApp — investigação de 19/10/2026

## Evidências

- Space Pizza está configurada no canal Evolution. O modelo de lembrete salvo no PostgreSQL está em UTF-8 válido, com quatro emojis e nenhum caractere de substituição U+FFFD (`�`).
- As duas mensagens identificadas às 10:36:28 e 10:39:00 já contêm quatro U+FFFD no conteúdo armazenado pela Evolution. O problema não se limita à fonte usada pelo WhatsApp para exibir a mensagem.
- Seis confirmações do sistema foram comparadas com o conteúdo recebido pela Evolution: texto idêntico e onze emojis preservados em cada envio.
- A origem `android` informada pela Evolution é uma previsão pelo formato do ID da mensagem, não uma prova de qual aplicativo ou aparelho disparou a mensagem.
- O usuário informou que os lembretes chegaram automaticamente. Esses dois lembretes não aparecem nos registros atuais de fila, logs ou guards da empresa. O agendamento remoto aponta para o projeto correto; o código anterior à publicação também usa fila e guard. Portanto, a origem da corrupção desse envio automático ainda precisa ser reproduzida, sem concluir que foi uma ação manual.

## Defeito reproduzido nos links com mensagem

Uma requisição de leitura ao serviço `wa.me`, com texto sintético contendo 🚀, ⏰ e 🍕, recebeu redirecionamento HTTP 302 para `api.whatsapp.com` já com os três emojis substituídos por U+FFFD. O resultado foi observado com cabeçalhos de navegador desktop e Android.

Ao acessar diretamente `api.whatsapp.com/send?phone=...&text=...`, a URI `whatsapp://send` e o link para WhatsApp Web gerados pelo serviço preservam o texto completo. A prévia HTML do serviço ainda pode exibir caracteres substitutos; a conferência foi feita no texto da URI encaminhada ao aplicativo.

A correção centraliza os links com mensagem em `src/lib/whatsapp-links.ts`, usando o endereço direto. Todos os oito pontos com texto foram convertidos; links de contato sem texto continuam com `wa.me`. Telefones completos com DDI permanecem inalterados.

Validação: 1.032 testes da aplicação e build aprovados. Os testes novos cobrem emojis BMP e não BMP, tons de pele, ZWJ, seletores de apresentação, acentos, quebras de linha e caracteres reservados, além do seletor real de modelos.

Correção dos links publicada em 19/10/2026 pelo deployment `dpl_BxKA9N66rQqVvj3e8Jyngy8FmBic`. Os dois domínios públicos responderam 200 com a nova versão, e o helper com o endereço direto foi conferido no bundle publicado. Não houve alteração em funções Edge, configurações ou agendamentos de envio.

## Validação do envio automático

Após o usuário fornecer e autorizar seu número, foi enviado **um único teste**, usando o mesmo helper e remetente da API utilizada nas automações, com a mensagem `🚀 Teste de emojis do Plugue Reservas ⏰ 👽 🍕`.

A resposta e uma consulta posterior ao histórico da Evolution preservaram o texto exato: quatro emojis, zero U+FFFD. O provedor registrou `DELIVERY_ACK`, indicando entrega ao aparelho. O usuário confirmou visualmente: **todos os quatro emojis chegaram corretos**. Esse teste valida o transporte pelo helper/provedor e a exibição no aparelho; não reproduz o agendamento completo do lembrete histórico.

O teste não deve acionar o cron ou o worker global de produção. Um recibo exclusivo impede reenvio acidental. A resposta e o histórico do provedor devem ser comparados ao texto original antes de atribuir a causa ao envio automático.

Os dados brutos de diagnóstico e as configurações usadas para leitura ficam em diretório privado fora do repositório; não incluir telefones, tokens ou conteúdo de clientes neste documento.

## Padronização dos modelos da Space Pizza

O usuário autorizou revisar os emojis de todos os modelos da empresa, substituí-los pelos quatro símbolos aprovados no teste (`🚀 ⏰ 👽 🍕`) e testar cada mensagem no número informado anteriormente.

Foram revisados os dez modelos efetivos do painel: dois personalizados e oito padrões. Sete modelos precisaram de substituições. O lembrete de logo mais já usava os quatro símbolos aprovados; o lembrete do dia anterior e a reativação não tinham emojis. A confirmação personalizada foi atualizada e seis modelos padrão com emojis foram salvos somente para essa empresa, com ativação desabilitada. Os estados anteriores dos demais modelos foram preservados.

A alteração foi aplicada em transação com verificação de concorrência e backup dos valores anteriores. A comparação por grafemas confirmou que somente emojis foram substituídos: texto, regras comerciais e variáveis permaneceram idênticos. A leitura posterior dos dez modelos confirmou o conjunto permitido de emojis e os estados de ativação. Não havia mensagens pendentes da empresa no momento da revisão.

O lote de testes contém dez mensagens numeradas e identificadas como teste, com dados fictícios e links para a página pública da empresa. O envio usa o mesmo helper e remetente da API, exclusivamente para o número autorizado, com recibo individual para impedir duplicações. Não aciona workers globais nem cria reservas, visitas ou avaliações.

Lote concluído em 19/10/2026: **dez mensagens enviadas e dez entregas confirmadas** (`DELIVERY_ACK`). A resposta e o histórico da Evolution mantiveram todos os textos exatamente como preparados, com 25 ocorrências de emojis no conjunto e zero U+FFFD. A confirmação e o lembrete personalizado também foram testados com seus textos completos. Cada modelo teve somente um pedido de envio.

A leitura final da configuração de produção confirmou os dez modelos efetivos com somente os quatro emojis aprovados, os demais caracteres preservados e os estados de ativação originais. A conferência visual desse lote pelo usuário complementa os recibos de entrega; esses testes não simulam os gatilhos de negócio nem o cron completo.
