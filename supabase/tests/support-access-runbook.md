# Suporte com acesso delegado

Tudo foi implementado e verificado localmente. Nenhuma migração, função, credencial ou configuração de produção foi aplicada por este trabalho.

## Verificação local

```powershell
npm run test:support
npm run build
```

`test:support` também executa os testes da interface e os handlers Edge com mocks. Não precisa de credenciais Supabase nem executa chamadas externas. Os runners SQL podem ser executados individualmente com `node supabase/tests/run_support_access_regression.mjs` e `node supabase/tests/run_support_migration_replay.mjs`.

O primeiro runner verifica os limites de autorização com PGlite: empresas autorizadas, permissões individuais do operador, identidade real na auditoria, escopo único mesmo quando o alvo tem outras empresas, arquivos no Storage, sessão vinculada ao login, expiração e revogação permanente.

O segundo recompõe o schema a partir das migrações reais do repositório e verifica políticas/RPCs atuais, histórico de reserva e bootstrap público anônimo. Auth e Storage têm fixtures locais. `cron`/`net` usam stubs inertes; nenhuma requisição externa é executada. Os índices concorrentes são criados normalmente no engine local. O teste não valida a concorrência de índices nem a infraestrutura do Supabase hospedado.

Para testar com login em uma stack Supabase local real, preparar primeiro um ambiente isolado. Há migrações históricas com jobs `pg_cron` que chamam URLs do projeto hospedado: esses jobs precisam permanecer desativados e a saída de rede para os serviços reais precisa estar bloqueada durante o teste. O replay PGlite acima já substitui `cron` e `net` por stubs inertes e é a forma de validação usada neste trabalho.

O frontend também precisa de `.env.development.local` apontando explicitamente para essa stack local. Sem essas variáveis, o cliente existente usa o projeto hospedado como fallback. Usar a URL e a chave pública da stack local, por exemplo:

```dotenv
VITE_SUPABASE_URL=http://127.0.0.1:54321
VITE_SUPABASE_PUBLISHABLE_KEY=<chave pública da stack local>
```

Não foi criada uma stack com login real nem alterada a configuração local do usuário. A verificação visual usou uma fixture separada com dados simulados e bloqueio de requisições externas. Não usar `--linked`, URL remota ou credenciais reais para este teste.

## Migrações e contratos

Aplicar `20261006120000_add_support_role.sql` antes de `20261006121000_add_support_access_and_impersonation.sql`, em transações separadas. PostgreSQL precisa do commit da adição de `support` ao enum antes de usar o novo valor.

O papel `support` é global (`user_roles.company_id = null`) e não pode ser combinado com outros papéis. Somente um superadmin pode criar/gerenciar esse usuário e seus acessos na tela **Usuários**. Nenhuma empresa é autorizada automaticamente.

O RPC `set_support_company_access(_user_id uuid, _company_ids uuid[])` define a lista permitida. Uma lista vazia remove todos os acessos. A lista própria e a lista para um superadmin podem ser consultadas em `support_company_access`; a tabela de sessões não oferece leitura direta ao cliente.

RPCs disponíveis ao suporte:

- `support_list_companies()` retorna `id`, `name`, `slug`, `status`.
- `support_list_impersonation_candidates(_company_id)` retorna usuários ativos e não banidos daquela empresa, com `user_id`, `full_name`, `email`, `effective_role`.
- `support_dashboard(_company_id default null, _start_date default CURRENT_DATE, _end_date default CURRENT_DATE)` retorna contagens de empresas, reservas, confirmados, check-ins, cancelados, no-show e pessoas. Não retorna valores financeiros. Datas são inclusivas; o intervalo máximo é 367 dias.
- `start_support_impersonation(_company_id, _target_user_id)` retorna JSON com `id`, `actorUserId`, `companyId`, `companySlug`, `companyName`, `userId`, `userName`, `userEmail`, `effectiveRole`, `expiresAt`.
- `get_support_impersonation_context()` retorna esse contexto validado ou `null`.
- `stop_support_impersonation(_session_id)` encerra a sessão do próprio ator/login e retorna boolean.

Cada sessão dura uma hora. A autenticação continua sendo a do suporte; `auth.uid()` não foi modificado. O header `x-support-impersonation` transporta o UUID da sessão em REST/RPC, Edge Functions e operações de Storage. Ele não é suficiente sozinho: o servidor também confere ator, `session_id` do JWT, concessão da empresa, identidade/papel ativo do alvo e bans no Auth.

O contexto inválido fecha o acesso. Remover empresa/papel, desativar perfil ou banir ator/alvo encerra as sessões relacionadas. Reativar a conta ou devolver a concessão não reativa sessões antigas. Iniciar outra impersonação no mesmo login encerra a anterior.

Referências de escrita também ficam na empresa escolhida: uma linha de pagamento da empresa A não pode apontar para uma reserva da B. O cliente de suporte não pode substituir os identificadores do provedor de pagamento; os endpoints de pagamento continuam responsáveis por esses campos, inclusive quando empresas compartilham uma conta Asaas.

## Cuidados de integração

A consulta do perfil/roles reais do suporte e endpoints de Auth usam a identidade original. Dentro da empresa, políticas, RPCs e Edge Functions aplicam a identidade e permissões do alvo, sempre limitadas à empresa escolhida. A auditoria grava ator real, alvo, empresa e sessão. Alterações de dados não copiam valores sensíveis para os logs.

A impersonação não troca o login nem permite alterar as credenciais do usuário alvo pelo fluxo de conta pessoal. O link “Meu perfil” fica oculto para Suporte. As ações operacionais e os módulos da empresa seguem o papel e as permissões do alvo.

O suporte impersonando um administrador pode acessar configurações e dados da empresa que esse administrador normalmente vê, incluindo campos sensíveis de integrações se as APIs existentes já os retornarem ao administrador. O papel não permite o financeiro, integrações, logs ou saúde **globais** da plataforma. Alterar esse comportamento para ocultar dados também na empresa seria outra regra de acesso.

Realtime não transporta esse header por padrão; não pode conceder acesso delegado adicional. A interface deve usar REST/RPC para obter dados quando precisar da delegação. O polling do contexto na interface ajuda a encerrar a navegação; a autorização efetiva é conferida no servidor em cada request.

Migrações futuras que substituam RPCs/políticas ou criem tabelas precisam preservar `effective_auth_uid` e as políticas restritivas de escopo. A adaptação introspectiva desta migração preserva os nomes/assinaturas/ACLs do schema presente; não se reaplica automaticamente a alterações posteriores. Executar os dois runners ao modificar essa área.

A checagem TypeScript geral do projeto ainda apresenta erros de tipos em outros módulos. O build e os testes passam, sem diagnósticos nos novos arquivos de Suporte. Deno CLI não estava disponível; os handlers foram executados com mocks e checados usando o compilador TypeScript local.

## Publicação futura

Antes de uma publicação autorizada, revisar o diff, aplicar as duas migrações na ordem em um ambiente de homologação, publicar as Edge Functions alteradas e o frontend e testar com três contas: superadmin, suporte com uma empresa e suporte sem concessões. Confirmar que links diretos/API não abrem módulos globais ou outra empresa e que saída/ban/desativação removem a sessão. A publicação em produção não foi executada.
