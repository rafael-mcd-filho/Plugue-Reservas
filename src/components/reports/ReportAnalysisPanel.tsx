import type { ReactNode } from 'react';
import { ArrowDownRight, ArrowUpRight, CircleHelp } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export interface ReportInsight {
  title: string;
  detail: string;
  tone?: 'neutral' | 'positive' | 'attention';
}

export default function ReportAnalysisPanel({ insights, children }: { insights: ReportInsight[]; children: ReactNode }) {
  const [params, setParams] = useSearchParams();
  const view = params.get('report_view') === 'explore' ? 'explore' : 'summary';
  return (
    <Tabs value={view} onValueChange={nextView => setParams(current => {
      const next = new URLSearchParams(current);
      if (nextView === 'explore') next.set('report_view', 'explore');
      else next.delete('report_view');
      return next;
    }, { replace: true })} className="space-y-4">
      <TabsList aria-label="Nível de análise" className="h-auto gap-1 rounded-lg p-1">
        <TabsTrigger value="summary" className="min-h-10 px-5">Resumo</TabsTrigger>
        <TabsTrigger value="explore" className="min-h-10 px-5">Explorar dados</TabsTrigger>
      </TabsList>
      <TabsContent value="summary" className="space-y-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <div>
          <h2 className="text-base font-semibold">Leituras do período</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">Confira o volume e a base de cada leitura. Explore os dados para investigar os resultados.</p>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          {insights.slice(0, 3).map(insight => {
            const Icon = insight.tone === 'positive' ? ArrowUpRight : insight.tone === 'attention' ? ArrowDownRight : CircleHelp;
            return (
              <article key={insight.title} className="rounded-xl border border-border bg-card p-4">
                <Icon aria-hidden="true" className="mb-3 h-4 w-4 text-muted-foreground" />
                <h3 className="text-sm font-semibold leading-snug">{insight.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{insight.detail}</p>
              </article>
            );
          })}
        </div>
        {insights.length === 0 && <p className="rounded-xl border border-dashed border-border p-5 text-sm text-muted-foreground">Ainda não há volume suficiente para apresentar leituras deste período.</p>}
      </TabsContent>
      <TabsContent value="explore" className="space-y-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{children}</TabsContent>
    </Tabs>
  );
}
