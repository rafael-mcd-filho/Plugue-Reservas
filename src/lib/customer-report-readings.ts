import type { CustomerRecurrenceReport } from '@/hooks/useCustomerRecurrenceReport';
import type { ReportInsight } from '@/components/reports/ReportAnalysisPanel';

export function getCustomerReportReadings(report: CustomerRecurrenceReport): ReportInsight[] {
  const { summary, meta } = report;
  const integer = (value: number) => value.toLocaleString('pt-BR');
  const percent = (value: number) => `${value.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;
  if (summary.identified_customers === 0) return [];
  return [
    {
      title: `${integer(summary.returning_customers)} clientes já visitavam antes do período`,
      detail: `${percent(summary.recurrence_rate)} entre ${integer(summary.identified_customers)} clientes identificados por telefone e com presença registrada. ${summary.identified_customers < 10 ? 'Base pequena: leia essa proporção com cautela.' : 'O cálculo considera o histórico disponível anterior ao intervalo.'}`,
    },
    {
      title: `${integer(summary.repeated_in_period)} clientes repetiram dentro do intervalo`,
      detail: `${integer(summary.additional_visits)} visitas além da primeira. Repetição dentro do período e retorno de um cliente antigo são leituras diferentes; um cliente novo também pode repetir.`,
    },
    {
      title: 'Cobertura: visitas identificadas',
      detail: `${integer(summary.period_visits)} visitas registradas na base de clientes identificados. ${meta.include_companions ? 'Inclui acompanhantes identificados.' : 'Considera os titulares; acompanhantes estão fora do recorte.'} Esta análise não representa todos os frequentadores nem mede consumo.`,
    },
  ];
}
