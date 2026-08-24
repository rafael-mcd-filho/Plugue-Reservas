import type { ReactNode } from 'react';
import { RefreshCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { DateRangePicker } from '@/components/ui/date-range-picker';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import type { ReportFilterState } from '@/hooks/useReportFilters';
import {
  REPORT_GRANULARITY_LABELS,
  REPORT_PERIOD_LABELS,
  REPORT_PERIOD_PRESETS,
  type ReportGranularity,
  type ReportPeriodPreset,
} from '@/lib/report-filters';
import { cn } from '@/lib/utils';

interface ReportFilterBarProps {
  filters: ReportFilterState;
  children?: ReactNode;
  isRefreshing?: boolean;
  onRefresh?: () => void;
}

export default function ReportFilterBar({
  filters,
  children,
  isRefreshing = false,
  onRefresh,
}: ReportFilterBarProps) {
  return (
    <Card className="overflow-hidden border-border/80 bg-card shadow-sm">
      <CardContent className="p-3">
        <div className="flex min-w-0 flex-col gap-2 md:flex-row md:flex-wrap md:items-end">
          <div className="min-w-0 space-y-1 md:w-44 md:flex-none">
            <Label htmlFor="report-period" className="text-xs">Período</Label>
            <Select
              value={filters.periodPreset}
              onValueChange={(value) => filters.setPeriodPreset(value as ReportPeriodPreset)}
            >
              <SelectTrigger id="report-period" className="h-9" aria-label="Selecionar período do relatório">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REPORT_PERIOD_PRESETS.map((preset) => (
                  <SelectItem key={preset} value={preset}>{REPORT_PERIOD_LABELS[preset]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="min-w-0 space-y-1 md:w-60 md:flex-none">
            <Label htmlFor="report-date-range" className="text-xs">Intervalo analisado</Label>
            <DateRangePicker
              id="report-date-range"
              ariaLabel="Selecionar intervalo analisado"
              value={filters.dateRange}
              onChange={filters.setDateRange}
              className="h-9 w-full"
              align="start"
            />
            {filters.rangeError && (
              <p className="text-xs leading-relaxed text-destructive" role="alert">{filters.rangeError}</p>
            )}
          </div>

          <div className="min-w-0 space-y-1 md:w-36 md:flex-none">
            <Label htmlFor="report-granularity" className="text-xs">Granularidade</Label>
            <Select
              value={filters.granularity}
              onValueChange={(value) => filters.setGranularity(value as ReportGranularity)}
            >
              <SelectTrigger id="report-granularity" className="h-9" aria-label="Selecionar granularidade do relatório">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(REPORT_GRANULARITY_LABELS) as ReportGranularity[]).map((granularity) => (
                  <SelectItem key={granularity} value={granularity}>
                    {REPORT_GRANULARITY_LABELS[granularity]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="min-w-0 space-y-1 md:w-44 md:flex-none">
            <span className="block text-xs font-medium text-foreground">Comparação</span>
            <div className="flex h-9 items-center justify-between gap-3 rounded-md border border-border bg-muted/20 px-3">
              <Label htmlFor="report-comparison" className="cursor-pointer whitespace-nowrap text-xs">
                Período anterior
              </Label>
              <Switch
                id="report-comparison"
                checked={filters.comparisonEnabled}
                onCheckedChange={filters.setComparisonEnabled}
              />
            </div>
          </div>

          <div className="flex min-w-0 items-end gap-2 md:flex-1 md:justify-end">
            {children}
            {onRefresh && (
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-9 w-9 shrink-0"
                onClick={onRefresh}
                disabled={isRefreshing || !!filters.rangeError}
                aria-label="Atualizar relatório"
                title="Atualizar relatório"
              >
                <RefreshCcw
                  className={cn('h-4 w-4', isRefreshing && 'animate-spin motion-reduce:animate-none')}
                  aria-hidden="true"
                />
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
