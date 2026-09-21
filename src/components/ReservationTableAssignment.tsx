import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Info, Lightbulb, Loader2, Table2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Progress } from '@/components/ui/progress';
import { supabase } from '@/integrations/supabase/client';
import {
  findBestTableCombination,
  orderSelectedTableIds,
  type TableCombinationOption,
} from '@/lib/reservation-table-selection';
import { cn } from '@/lib/utils';

interface ReservationTableOption extends TableCombinationOption {
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
  selected?: boolean;
  assignmentOnly?: boolean;
}

interface ReservationTableAssignmentRow {
  table_id: string;
  table_number: number;
  section_code: string | null;
  section_name: string | null;
  capacity: number;
  table_map_id: string | null;
  table_map_name: string | null;
  sort_order: number;
  is_primary: boolean;
}

interface ReservationTableAssignmentProps {
  companyId: string;
  reservationId: string;
  date: string;
  time: string;
  partySize: number;
  onAssigned?: (reservationId: string, tableIds: string[]) => void;
}

interface AssignmentMutationVariables {
  tableIds: string[];
  allowUnassigned: boolean;
}

function formatTableLabel(option: Pick<ReservationTableOption, 'table_number' | 'section_code'>) {
  return option.section_code ? `Mesa ${option.table_number} · ${option.section_code}` : `Mesa ${option.table_number}`;
}

function formatTableNumbers(assignments: ReservationTableAssignmentRow[]) {
  const numbers = assignments
    .slice()
    .sort((left, right) => left.sort_order - right.sort_order || left.table_number - right.table_number)
    .map((assignment) => assignment.table_number);

  if (numbers.length === 0) return '';
  if (numbers.length === 1) return `Mesa ${numbers[0]}`;
  if (numbers.length === 2) return `Mesas ${numbers[0]} e ${numbers[1]}`;
  return `Mesas ${numbers.slice(0, -1).join(', ')} e ${numbers.at(-1)}`;
}

function areSameTableIds(left: Set<string>, right: Set<string>) {
  return left.size === right.size && Array.from(left).every((tableId) => right.has(tableId));
}

export default function ReservationTableAssignment({
  companyId,
  reservationId,
  date,
  time,
  partySize,
  onAssigned,
}: ReservationTableAssignmentProps) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [draftTableIds, setDraftTableIds] = useState<Set<string>>(new Set());
  const [draftTouched, setDraftTouched] = useState(false);
  const [confirmUnassignedOpen, setConfirmUnassignedOpen] = useState(false);

  const normalizedTime = time.length === 5 ? `${time}:00` : time;
  const requiredCapacity = Math.max(1, partySize);

  const assignmentsQuery = useQuery({
    queryKey: ['reservation-table-assignments', reservationId],
    queryFn: async () => {
      const { data, error } = await (supabase.rpc as any)('get_reservation_table_assignments', {
        _reservation_id: reservationId,
      });

      if (error) throw error;
      return ((data as any[]) ?? []) as ReservationTableAssignmentRow[];
    },
    enabled: !!reservationId,
    staleTime: 15 * 1000,
  });

  const assignments = useMemo(
    () => assignmentsQuery.data ?? [],
    [assignmentsQuery.data],
  );
  const assignedTableIds = useMemo(
    () => new Set(assignments.map((assignment) => assignment.table_id)),
    [assignments],
  );
  const assignedTableIdsKey = useMemo(
    () => Array.from(assignedTableIds).sort().join(','),
    [assignedTableIds],
  );

  const optionsQuery = useQuery({
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
    enabled: open && !!companyId && !!date && !!normalizedTime && assignmentsQuery.isSuccess,
    staleTime: 15 * 1000,
  });

  const options = useMemo(
    () => optionsQuery.data ?? [],
    [optionsQuery.data],
  );
  const displayedOptions = useMemo(() => {
    const optionIds = new Set(options.map((option) => option.table_id));
    const assignmentOnlyOptions: ReservationTableOption[] = assignments
      .filter((assignment) => !optionIds.has(assignment.table_id))
      .map((assignment) => ({
        table_id: assignment.table_id,
        table_number: assignment.table_number,
        section_code: assignment.section_code,
        section_name: assignment.section_name,
        capacity: assignment.capacity,
        table_map_id: assignment.table_map_id,
        table_map_name: assignment.table_map_name,
        available: false,
        conflict_reservation_id: null,
        conflict_guest_name: null,
        recommended: false,
        selected: true,
        assignmentOnly: true,
      }));

    return [...options, ...assignmentOnlyOptions];
  }, [assignments, options]);

  const optionById = useMemo(
    () => new Map(displayedOptions.map((option) => [option.table_id, option])),
    [displayedOptions],
  );
  const suggestedOptions = useMemo(
    () => findBestTableCombination(options, requiredCapacity),
    [options, requiredCapacity],
  );
  const suggestedTableIds = useMemo(
    () => new Set(suggestedOptions.map((option) => option.table_id)),
    [suggestedOptions],
  );
  const suggestedCapacity = useMemo(
    () => suggestedOptions.reduce((sum, option) => sum + option.capacity, 0),
    [suggestedOptions],
  );

  useEffect(() => {
    if (draftTouched) return;
    setDraftTableIds(new Set(assignedTableIds));
  }, [assignedTableIdsKey, assignedTableIds, draftTouched]);

  useEffect(() => {
    if (!open || !optionsQuery.isSuccess) return;

    const reconciledIds = new Set(
      Array.from(draftTableIds).filter((tableId) => optionById.has(tableId)),
    );
    if (areSameTableIds(reconciledIds, draftTableIds)) return;

    setDraftTableIds(reconciledIds);
    setDraftTouched(true);
  }, [draftTableIds, open, optionById, optionsQuery.isSuccess]);

  const assignedCapacity = useMemo(
    () => assignments.reduce((sum, assignment) => sum + assignment.capacity, 0),
    [assignments],
  );
  const draftCapacity = useMemo(
    () => Array.from(draftTableIds).reduce(
      (sum, tableId) => sum + (optionById.get(tableId)?.capacity ?? 0),
      0,
    ),
    [draftTableIds, optionById],
  );
  const remainingCapacity = Math.max(0, requiredCapacity - draftCapacity);
  const excessCapacity = Math.max(0, draftCapacity - requiredCapacity);
  const hasEnoughCapacity = draftCapacity >= requiredCapacity;
  const hasDraftChanges = !areSameTableIds(draftTableIds, assignedTableIds);
  const hasUnavailableDraftSelection = Array.from(draftTableIds).some(
    (tableId) => !optionById.get(tableId)?.available,
  );
  const totalAvailableCapacity = useMemo(
    () => options.filter((option) => option.available).reduce((sum, option) => sum + option.capacity, 0),
    [options],
  );
  const suggestionAlreadySelected = areSameTableIds(draftTableIds, suggestedTableIds);

  const assignmentSummary = useMemo(() => {
    if (assignmentsQuery.isLoading) return 'Carregando mesas…';
    if (assignmentsQuery.isError) return 'Não foi possível consultar as mesas';
    if (assignments.length === 0) return 'Sem mesa · alocar depois';

    const capacitySummary = `${assignedCapacity}/${requiredCapacity} lugares`;
    const missing = Math.max(0, requiredCapacity - assignedCapacity);
    return `${formatTableNumbers(assignments)} · ${capacitySummary}${missing > 0 ? ` · faltam ${missing}` : ''}`;
  }, [assignedCapacity, assignments, assignmentsQuery.isError, assignmentsQuery.isLoading, requiredCapacity]);

  const invalidateReservationData = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['reservation-table-assignments', reservationId] }),
      qc.invalidateQueries({ queryKey: ['reservation-table-options', reservationId] }),
      qc.invalidateQueries({ queryKey: ['calendar-day-capacity', companyId] }),
      qc.invalidateQueries({ queryKey: ['reservations', companyId] }),
      qc.invalidateQueries({ queryKey: ['today-reservations', companyId] }),
      qc.invalidateQueries({ queryKey: ['reservation-event-history', reservationId] }),
    ]);
  };

  const assignMutation = useMutation({
    mutationFn: async ({ tableIds, allowUnassigned }: AssignmentMutationVariables) => {
      const { data, error } = await (supabase.rpc as any)('assign_reservation_tables', {
        _reservation_id: reservationId,
        _table_ids: tableIds,
        _allow_unassigned: allowUnassigned,
        _assignment_note: allowUnassigned ? 'Alocar mesas depois' : null,
      });

      if (error) throw error;
      return Array.isArray(data) ? data[0] : data;
    },
    onSuccess: async (_updated, variables) => {
      await invalidateReservationData();
      onAssigned?.(reservationId, variables.tableIds);
      toast.success(
        variables.allowUnassigned
          ? 'Reserva marcada para alocar depois.'
          : `${variables.tableIds.length === 1 ? 'Mesa atribuída' : `${variables.tableIds.length} mesas atribuídas`} com sucesso.`,
      );
      setDraftTouched(false);
      setOpen(false);
    },
    onError: async (error: any) => {
      await Promise.all([
        assignmentsQuery.refetch(),
        optionsQuery.refetch(),
      ]);
      toast.error(error?.message ?? 'Não foi possível atualizar as mesas.');
    },
  });

  const cancelSelection = () => {
    assignMutation.reset();
    setDraftTableIds(new Set(assignedTableIds));
    setDraftTouched(false);
    setOpen(false);
  };

  const toggleEditor = () => {
    if (open) {
      cancelSelection();
      return;
    }

    assignMutation.reset();
    setDraftTableIds(new Set(assignedTableIds));
    setDraftTouched(false);
    setOpen(true);
  };

  const toggleTable = (tableId: string, checked: boolean) => {
    assignMutation.reset();
    setDraftTouched(true);
    setDraftTableIds((current) => {
      const next = new Set(current);
      if (checked) next.add(tableId);
      else next.delete(tableId);
      return next;
    });
  };

  const applySuggestion = () => {
    assignMutation.reset();
    setDraftTableIds(new Set(suggestedTableIds));
    setDraftTouched(true);
  };

  const saveSelection = () => {
    if (!hasEnoughCapacity || hasUnavailableDraftSelection || !hasDraftChanges || assignMutation.isPending) return;

    const tableIds = orderSelectedTableIds(
      assignments,
      draftTableIds,
      displayedOptions.map((option) => option.table_id),
    );
    assignMutation.mutate({ tableIds, allowUnassigned: false });
  };

  const allocateLater = () => {
    if (assignedTableIds.size > 0) {
      setConfirmUnassignedOpen(true);
      return;
    }

    assignMutation.mutate({ tableIds: [], allowUnassigned: true });
  };

  return (
    <div className="rounded-lg border border-border bg-muted/20 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-2">
          <Table2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">Mesas</p>
            <p className={cn(
              'break-words text-xs',
              assignments.length > 0 && assignedCapacity < requiredCapacity
                ? 'font-medium text-warning-foreground'
                : 'text-muted-foreground',
            )}>
              {assignmentSummary}
            </p>
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full sm:w-auto"
          disabled={assignmentsQuery.isLoading || assignMutation.isPending}
          onClick={toggleEditor}
          aria-expanded={open}
          aria-controls={`reservation-table-selector-${reservationId}`}
        >
          {open ? 'Cancelar' : assignments.length > 0 ? 'Alterar mesas' : 'Atribuir mesas'}
        </Button>
      </div>

      {assignmentsQuery.isError && !open && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-destructive" role="alert">
          <span>Não foi possível carregar a atribuição atual.</span>
          <Button type="button" variant="outline" size="sm" onClick={() => assignmentsQuery.refetch()}>
            Tentar novamente
          </Button>
        </div>
      )}

      {open && (
        <div id={`reservation-table-selector-${reservationId}`} className="mt-3 space-y-3 border-t border-border pt-3">
          <div
            className={cn(
              'rounded-md border px-2.5 py-2',
              hasEnoughCapacity
                ? 'border-success/20 bg-success-soft/70'
                : 'border-warning/30 bg-warning-soft/70',
            )}
            aria-live="polite"
            aria-atomic="true"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-xs font-semibold tabular-nums text-foreground">
                {draftCapacity}/{requiredCapacity} lugares
              </p>
              <p className={cn(
                'text-xs font-medium',
                hasEnoughCapacity ? 'text-success' : 'text-warning-foreground',
              )}>
                {hasEnoughCapacity
                  ? excessCapacity > 0
                    ? `${excessCapacity} ${excessCapacity === 1 ? 'lugar de folga' : 'lugares de folga'}`
                    : 'Capacidade exata'
                  : `Faltam ${remainingCapacity}`}
              </p>
            </div>
            <Progress
              className="mt-1.5 h-1.5 bg-background/80"
              value={Math.min(100, (draftCapacity / requiredCapacity) * 100)}
              aria-label={`${draftCapacity} de ${requiredCapacity} lugares selecionados`}
            />
          </div>

          <p className="flex items-center gap-1.5 text-[11px] leading-4 text-muted-foreground">
            <Info className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
            Cada mesa selecionada fica ocupada por inteiro.
          </p>

          {optionsQuery.isLoading || assignmentsQuery.isLoading ? (
            <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground" role="status">
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
              Carregando mesas disponíveis…
            </div>
          ) : optionsQuery.isError || assignmentsQuery.isError ? (
            <div className="space-y-2 rounded-lg border border-destructive/20 bg-destructive-soft/60 p-3" role="alert">
              <p className="text-sm text-destructive">Não foi possível carregar as mesas deste horário.</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  assignmentsQuery.refetch();
                  optionsQuery.refetch();
                }}
              >
                Tentar novamente
              </Button>
            </div>
          ) : displayedOptions.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
              Nenhuma mesa no mapa ativo deste horário. Você pode deixar a reserva para alocar depois.
            </p>
          ) : (
            <>
              {suggestedOptions.length > 0 && !suggestionAlreadySelected && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 w-full justify-start border-success/25 bg-success-soft/50 px-2.5 text-xs text-success hover:bg-success-soft"
                  disabled={assignMutation.isPending}
                  onClick={applySuggestion}
                >
                  <Lightbulb className="h-3.5 w-3.5" aria-hidden="true" />
                  Usar sugestão · {suggestedOptions.length} {suggestedOptions.length === 1 ? 'mesa' : 'mesas'} · {suggestedCapacity} lugares
                </Button>
              )}

              <fieldset>
                <legend className="sr-only">Selecione as mesas desta reserva</legend>
                <div className="grid max-h-[18rem] gap-1.5 overflow-y-auto pr-1 overscroll-contain">
                  {displayedOptions.map((option) => {
                    const isAssigned = assignedTableIds.has(option.table_id);
                    const isSelected = draftTableIds.has(option.table_id);
                    // A mesa pode ter ficado indisponível após a abertura do editor.
                    // Ainda assim, uma seleção local precisa poder ser removida.
                    const selectable = option.available || isSelected;
                    const isSuggested = suggestedTableIds.has(option.table_id);
                    const inputId = `reservation-${reservationId}-table-${option.table_id}`;
                    const descriptionId = `${inputId}-description`;

                    return (
                      <label
                        key={option.table_id}
                        htmlFor={inputId}
                        className={cn(
                          'flex min-h-10 items-center gap-2 rounded-md border px-3 py-2 text-left transition-[border-color,background-color] focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-1',
                          isSelected
                            ? 'border-primary/45 bg-primary-soft/45'
                            : selectable
                              ? 'cursor-pointer border-border bg-background hover:border-primary/30 hover:bg-muted/30'
                              : 'cursor-not-allowed border-border bg-muted/20 opacity-60',
                        )}
                      >
                        <Checkbox
                          id={inputId}
                          checked={isSelected}
                          disabled={!selectable || assignMutation.isPending}
                          onCheckedChange={(checked) => toggleTable(option.table_id, checked === true)}
                          aria-describedby={descriptionId}
                        />
                        <span className="flex min-w-0 flex-1 items-baseline gap-2">
                          <span className="truncate text-sm font-medium text-foreground">{formatTableLabel(option)}</span>
                          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                            {option.capacity} {option.capacity === 1 ? 'lugar' : 'lugares'}
                          </span>
                        </span>
                        <span id={descriptionId} className="flex min-w-0 max-w-[48%] shrink-0 items-center justify-end gap-1.5 text-xs">
                          {option.assignmentOnly ? (
                            <span className="truncate text-warning-foreground" title="Fora do mapa ativo; desmarque para remover">
                              Fora do mapa
                            </span>
                          ) : !option.available ? (
                            <span
                              className="truncate text-destructive"
                              title={option.conflict_guest_name ? `Ocupada por ${option.conflict_guest_name}` : 'Ocupada neste horário'}
                            >
                              {option.conflict_guest_name ? `Ocupada · ${option.conflict_guest_name}` : 'Ocupada'}
                            </span>
                          ) : isAssigned ? (
                            <span className="rounded border border-primary/20 bg-primary-soft px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                              Atual
                            </span>
                          ) : (
                            <span className="sr-only">Disponível</span>
                          )}
                          {isSuggested && !isAssigned && option.available && (
                            <span className="rounded border border-success/25 bg-success-soft px-1.5 py-0.5 text-[10px] font-semibold text-success">
                              Sugestão
                            </span>
                          )}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>

              {totalAvailableCapacity < requiredCapacity && (
                <div className="flex items-start gap-2 rounded-lg border border-warning/25 bg-warning-soft/60 p-3 text-sm" role="status">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning-foreground" aria-hidden="true" />
                  <p>
                    As mesas livres somam {totalAvailableCapacity} lugares. Ainda faltam {requiredCapacity - totalAvailableCapacity}; deixe para alocar depois ou libere outra mesa.
                  </p>
                </div>
              )}

              {hasUnavailableDraftSelection && (
                <div className="flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive-soft/60 p-3 text-sm" role="alert">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
                  <p>Uma mesa selecionada ficou indisponível. Desmarque-a e escolha outra antes de salvar.</p>
                </div>
              )}
            </>
          )}

          {assignMutation.isError && (
            <p className="text-sm text-destructive" role="alert">
              {(assignMutation.error as any)?.message ?? 'Não foi possível salvar. Revise as mesas e tente novamente.'}
            </p>
          )}

          <div className="flex flex-col-reverse gap-2 border-t border-border pt-3 sm:flex-row sm:flex-wrap sm:justify-between">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground"
              disabled={assignmentsQuery.isLoading || assignmentsQuery.isError || assignMutation.isPending}
              onClick={allocateLater}
            >
              Alocar depois
            </Button>
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button type="button" variant="outline" size="sm" disabled={assignMutation.isPending} onClick={cancelSelection}>
                Cancelar
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={
                  !hasEnoughCapacity
                  || hasUnavailableDraftSelection
                  || !hasDraftChanges
                  || assignmentsQuery.isLoading
                  || assignmentsQuery.isError
                  || optionsQuery.isLoading
                  || optionsQuery.isError
                  || assignMutation.isPending
                }
                onClick={saveSelection}
              >
                {assignMutation.isPending && <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden="true" />}
                {assignMutation.isPending
                  ? 'Salvando…'
                  : `Salvar ${draftTableIds.size} ${draftTableIds.size === 1 ? 'mesa' : 'mesas'}`}
              </Button>
            </div>
          </div>
        </div>
      )}

      <AlertDialog open={confirmUnassignedOpen} onOpenChange={setConfirmUnassignedOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remover as mesas atribuídas?</AlertDialogTitle>
            <AlertDialogDescription>
              A reserva ficará marcada para alocar depois e as {assignedTableIds.size} mesas atuais serão liberadas para outras reservas.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={assignMutation.isPending}>Manter mesas</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={assignMutation.isPending}
              onClick={() => assignMutation.mutate({ tableIds: [], allowUnassigned: true })}
            >
              Remover e alocar depois
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
