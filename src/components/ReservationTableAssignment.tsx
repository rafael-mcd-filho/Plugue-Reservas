import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Loader2, Table2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';

interface ReservationTableOption {
  table_id: string;
  table_number: number;
  section_code: string | null;
  section_name: string | null;
  capacity: number;
  table_map_id: string | null;
  table_map_name: string | null;
  available: boolean;
  conflict_reservation_id: string | null;
  conflict_guest_name: string | null;
  recommended: boolean;
}

interface ReservationTableAssignmentProps {
  companyId: string;
  reservationId: string;
  date: string;
  time: string;
  partySize: number;
  initialTableId: string | null;
  onAssigned?: (reservationId: string, tableId: string | null) => void;
}

function formatTableLabel(option: Pick<ReservationTableOption, 'table_number' | 'section_code'>) {
  return option.section_code ? `Mesa ${option.table_number} · ${option.section_code}` : `Mesa ${option.table_number}`;
}

export default function ReservationTableAssignment({
  companyId,
  reservationId,
  date,
  time,
  partySize,
  initialTableId,
  onAssigned,
}: ReservationTableAssignmentProps) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [currentTableId, setCurrentTableId] = useState<string | null>(initialTableId);

  const normalizedTime = time.length === 5 ? `${time}:00` : time;

  const { data: options = [], isLoading, isError } = useQuery({
    queryKey: ['reservation-table-options', reservationId, date, normalizedTime, partySize],
    queryFn: async () => {
      const { data, error } = await (supabase.rpc as any)('get_reservation_table_options', {
        _company_id: companyId,
        _date: date,
        _time: normalizedTime,
        _party_size: partySize,
        _duration_minutes: null,
        _reservation_id: reservationId,
      });

      if (error) throw error;
      return ((data as any[]) ?? []) as ReservationTableOption[];
    },
    enabled: open && !!companyId && !!date && !!normalizedTime,
    staleTime: 15 * 1000,
  });

  const currentOption = useMemo(
    () => options.find((option) => option.table_id === currentTableId) ?? null,
    [options, currentTableId],
  );

  // Busca leve dos dados da mesa atribuida para exibir numero/secao mesmo com o
  // seletor fechado (a lista completa de opcoes so carrega ao abrir).
  const { data: currentTableInfo } = useQuery({
    queryKey: ['reservation-current-table', currentTableId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('restaurant_tables' as any)
        .select('number, section')
        .eq('id', currentTableId!)
        .maybeSingle();

      if (error) throw error;
      return (data as { number: number; section: string | null } | null) ?? null;
    },
    enabled: !!currentTableId,
    staleTime: 5 * 60 * 1000,
  });

  const currentTableLabel = useMemo(() => {
    if (!currentTableId) return null;
    if (currentOption) return formatTableLabel(currentOption);
    if (currentTableInfo) {
      return currentTableInfo.section
        ? `Mesa ${currentTableInfo.number} · ${currentTableInfo.section}`
        : `Mesa ${currentTableInfo.number}`;
    }
    return 'Mesa atribuída';
  }, [currentTableId, currentOption, currentTableInfo]);

  const assignMutation = useMutation({
    mutationFn: async ({ tableId, allowUnassigned }: { tableId: string | null; allowUnassigned: boolean }) => {
      const { data, error } = await (supabase.rpc as any)('assign_reservation_table', {
        _reservation_id: reservationId,
        _table_id: tableId,
        _allow_unassigned: allowUnassigned,
        _assignment_note: null,
      });

      if (error) throw error;
      return (Array.isArray(data) ? data[0] : data) as { table_id: string | null };
    },
    onSuccess: (updated, variables) => {
      const nextTableId = updated?.table_id ?? (variables.allowUnassigned ? null : variables.tableId);
      setCurrentTableId(nextTableId ?? null);
      onAssigned?.(reservationId, nextTableId ?? null);
      qc.invalidateQueries({ queryKey: ['reservation-table-options', reservationId] });
      qc.invalidateQueries({ queryKey: ['calendar-day-capacity', companyId] });
      qc.invalidateQueries({ queryKey: ['calendar-reservations', companyId] });
      qc.invalidateQueries({ queryKey: ['reservations', companyId] });
      qc.invalidateQueries({ queryKey: ['today-reservations', companyId] });
      qc.invalidateQueries({ queryKey: ['reservation-event-history', reservationId] });
      toast.success(nextTableId ? 'Mesa atribuída.' : 'Reserva marcada para alocar depois.');
      setOpen(false);
    },
    onError: (error: any) => {
      toast.error(error?.message ?? 'Não foi possível atualizar a mesa.');
    },
  });

  return (
    <div className="rounded-lg border border-border bg-muted/20 p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Table2 className="h-4 w-4 text-primary" />
          <div>
            <p className="text-sm font-medium text-foreground">Mesa</p>
            <p className="text-xs text-muted-foreground">
              {currentTableLabel ?? 'Sem mesa · alocar depois'}
            </p>
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full sm:w-auto"
          onClick={() => setOpen((value) => !value)}
        >
          {open ? 'Fechar' : currentTableId ? 'Trocar mesa' : 'Atribuir mesa'}
        </Button>
      </div>

      {open && (
        <div className="mt-3 space-y-2">
          {isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Carregando mesas disponíveis...
            </div>
          ) : isError ? (
            <p className="text-sm text-destructive">Não foi possível carregar as mesas deste horário.</p>
          ) : options.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nenhuma mesa no mapa ativo deste horário. Você ainda pode deixar para alocar depois.
            </p>
          ) : (
            <div className="grid gap-2">
              {options.map((option) => {
                const isCurrent = option.table_id === currentTableId;
                const selectable = option.available || isCurrent;

                return (
                  <button
                    key={option.table_id}
                    type="button"
                    disabled={!selectable || assignMutation.isPending}
                    onClick={() => assignMutation.mutate({ tableId: option.table_id, allowUnassigned: false })}
                    className={cn(
                      'flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left text-sm transition',
                      isCurrent
                        ? 'border-primary/40 bg-primary-soft/40'
                        : selectable
                          ? 'border-border bg-background hover:border-primary/30 hover:bg-muted/30'
                          : 'cursor-not-allowed border-border bg-muted/20 opacity-60',
                    )}
                  >
                    <span className="min-w-0">
                      <span className="font-medium text-foreground">{formatTableLabel(option)}</span>
                      <span className="ml-2 text-xs text-muted-foreground">{option.capacity} lugares</span>
                      {!option.available && option.conflict_guest_name && (
                        <span className="mt-0.5 block text-xs text-rose-600">
                          Ocupada por {option.conflict_guest_name}
                        </span>
                      )}
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      {option.recommended && !isCurrent && (
                        <span className="rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">
                          Sugerida
                        </span>
                      )}
                      {isCurrent && <Check className="h-4 w-4 text-primary" />}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {currentTableId && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-full text-muted-foreground hover:text-foreground"
              disabled={assignMutation.isPending}
              onClick={() => assignMutation.mutate({ tableId: null, allowUnassigned: true })}
            >
              Remover mesa (alocar depois)
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
