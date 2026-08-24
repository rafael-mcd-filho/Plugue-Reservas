# Plano de implantação dos relatórios avançados

## Status

Implementação local em validação. Nada deste plano foi publicado, aplicado ao banco remoto, commitado ou enviado ao repositório.

A Dashboard atual permanece integralmente congelada nesta etapa. Nenhum card, consulta, filtro ou comportamento da Dashboard será alterado enquanto as três páginas novas estiverem sendo construídas e validadas. Sua redução e reorganização serão tratadas somente em uma fase futura, separada e aprovada explicitamente.

## Decisões de interface e escopo

- As três páginas novas e a página de Recorrência não terão ação nem fluxo de exportação de dados.
- Topo, cabeçalho e filtros serão compactos e seguirão o mesmo padrão visual e de interação nas quatro páginas de relatório.
- O cabeçalho deve priorizar título, contexto curto, período, comparação e atualização, sem ocupar espaço excessivo antes dos dados.
- Os filtros compartilhados devem manter a mesma ordem, altura, nomenclatura e comportamento responsivo; filtros específicos aparecem apenas quando necessários para a leitura daquela página.
- Esta fase não modifica a Dashboard nem reaproveita a implantação das páginas como autorização para alterar seus componentes ou consultas.

## Páginas entregues

### Demanda & Conversão

- Jornada pública em cinco etapas, por sessões ou visitantes únicos.
- Conversão, abandono e tempo entre etapas.
- Reservas criadas, pessoas, antecedência e forma operacional de entrada.
- Tamanho dos grupos: 1–2, 3–4, 5–6 e 7+ pessoas.
- Comparação com período anterior, busca local e drill-down.
- O filtro de forma de entrada afeta as métricas de reservas; o funil web continua total e é identificado como tal.

### Comparecimento & Perdas

- Comparecimentos, no-shows, cancelamentos e reservas em aberto.
- Segmentação por dia da semana, horário, tamanho do grupo, antecedência e forma de entrada.
- Curva de antecedência dos cancelamentos.
- Comparações observacionais com mensagens de WhatsApp e pré-pagamento, sem atribuir causalidade.
- Drill-down paginado.

### Ocupação & Capacidade

- Regras por capacidade são um modelo de primeira classe, assim como regras por mesas; nenhuma depende da outra.
- Capacidade publicada, pressão da demanda e check-ins sobre capacidade.
- Heatmap por dia e horário, fila de espera e no-show por horário.
- Mesa e seção apenas quando a reserva possui vínculo registrado.
- Histórico por snapshots versionados; períodos anteriores sem snapshot são marcados como estimativa ou indisponíveis.
- Não mede, estima nem promete permanência real, giro ou horário de liberação de mesa.

## Fundação compartilhada

- Período, intervalo personalizado, granularidade e comparação persistidos na URL.
- Topo, cabeçalho e barra de filtros compactos, responsivos e padronizados entre os relatórios.
- Limite de 366 dias.
- Fuso IANA por empresa, configurável em Configurações.
- Autorização server-side: administrador ou superadmin, permissão de Dashboard e `advanced_reports` ativo.
- Estados separados de carregamento, atualização, erro e vazio.

## Banco e execução

Ordem planejada:

1. `20260820130000_add_advanced_report_foundation.sql`
2. `20260820131000_add_demand_conversion_report.sql`
3. `20260820131100_index_demand_conversion_reservations.sql`
4. `20260820132000_add_attendance_losses_report.sql`
5. `20260820132100_index_attendance_losses_evolution.sql`
6. `20260820132200_index_attendance_losses_pluguechat.sql`
7. `20260820132300_index_attendance_losses_prepayment.sql`
8. `20260820133000_add_occupancy_capacity_foundation.sql`
9. `20260820134000_index_occupancy_capacity_report.sql`
10. `20260820134100_index_occupancy_capacity_reservations.sql`
11. `20260820134200_index_occupancy_capacity_waitlist.sql`
12. `20260820135000_schedule_occupancy_capacity_snapshots.sql`

Os arquivos com `CREATE INDEX CONCURRENTLY` precisam ser executados individualmente e fora de uma transação. O processo de release deve fixar uma versão do Supabase CLI comprovadamente compatível, validar `indisvalid` e `indisready` após cada índice e possuir instrução de reparo para uma execução interrompida.

A migration pendente da exclusão de empresas (`20260819120000_optimize_company_deletion.sql`) não pertence a este release. O dry-run precisa listar somente as migrations dos relatórios antes de qualquer escrita remota.

## Ordem futura de publicação

1. Criar backup e confirmar PITR.
2. Aplicar a fundação e RPCs em banco, sem habilitar rotas ainda.
3. Aplicar cada índice concorrente e validar seu estado.
4. Iniciar o pipeline de snapshots e observar erro, duração e sobreposição dos ciclos.
5. Executar regressões de autorização, isolamento entre empresas, fuso e períodos-limite.
6. Fazer smoke dos três RPCs em uma empresa sintética e depois em uma unidade pequena.
7. Publicar o frontend com as novas rotas.
8. Monitorar latência, timeout, locks e crescimento dos snapshots.
9. Só depois iniciar um projeto separado para simplificar a Dashboard.

Nenhuma Edge Function nova é necessária para estes relatórios. A captura de eventos, a fila Meta, o worker CAPI, os nomes de eventos e o mapeamento enviado à Meta permanecem fora do escopo e não devem ser alterados.

## Critérios de aceite antes de produção

- Todos os testes unitários e regressões SQL passam em conjunto.
- TypeScript, ESLint, build e `git diff --check` passam.
- Nenhuma alteração em `Dashboard.tsx`, `useDashboardData.ts` ou no pipeline Meta/CAPI.
- Admin de uma empresa não acessa dados de outra; operador e anônimo são negados.
- Troca de empresa não reapresenta PII em cache.
- Topo, cabeçalho e filtros permanecem compactos, padronizados e utilizáveis sem rolagem horizontal em telas móveis.
- Capacidade zero ou inexistente não produz taxa enganosa.
- No-show usa apenas a base madura de comparecimento + no-show.
- Regras por capacidade funcionam sem mesa; detalhamento de mesa não inventa vínculos.
- O pipeline de snapshots não sobrepõe ciclos nem altera slots já iniciados.

## Rollback futuro

- Ocultar as rotas e itens de menu no frontend.
- Revogar `EXECUTE` dos RPCs públicos se houver risco de dados.
- Desagendar somente os jobs `occupancy-capacity-snapshot-hourly` e `occupancy-capacity-snapshot-daily` se o pipeline apresentar problema.
- Manter índices válidos e snapshots já gravados; não apagar dados automaticamente durante rollback.
- Não tocar no pipeline Meta/CAPI.
