import { type ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { format, parseISO } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Download,
  Eye,
  Filter,
  Loader2,
  Search,
  Upload,
  X,
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useCompanySlug } from '@/contexts/CompanySlugContext';
import { useAuth } from '@/contexts/AuthContext';
import InfoTooltip from '@/components/dashboard/InfoTooltip';
import LeadProfileDialog from '@/components/leads/LeadProfileDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DateRangePicker } from '@/components/ui/date-range-picker';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
} from '@/components/ui/pagination';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  downloadCsv,
  downloadSpreadsheet,
  type SpreadsheetColumn,
} from '@/lib/export-utils';
import { parseLeadImportCsv, type ParsedLeadImportRow } from '@/lib/lead-import';
import { normalizeLeadPhoneKey } from '@/lib/lead-consistency';
import {
  formatLeadPhoneText,
  formatLeadSource,
  formatLeadVisitContext,
  formatReservationStatus,
  isCompanionVisitSource,
  mapCrmLeadRowToProfile,
  type CrmLeadProfile,
} from '@/lib/crm-lead-profile';
import { cn } from '@/lib/utils';
import {
  CRM_VISITS_FILTER_MAX,
  collectCrmImportedLeadMatchPages,
  getCrmVisitsFilterRangeError,
  normalizeCrmVisitsFilterInput,
  resolveCrmLeadsDisplayedPage,
  useCrmLeadsCanonicalExport,
  useCrmLeadsPage,
  type CrmLeadSource,
} from '@/hooks/useCrmLeads';
import { toast } from 'sonner';
import type { DateRange } from 'react-day-picker';

interface ImportedLeadRecord {
  id: string;
  full_name: string;
  phone: string | null;
  phone_normalized: string | null;
  email: string | null;
  email_normalized: string | null;
  birthdate: string | null;
  notes: string | null;
  source: string | null;
  import_filename: string | null;
  imported_at: string;
  imported_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

type LeadSource = CrmLeadSource;
type LeadImportMode = 'fill_missing' | 'overwrite';
type Lead = CrmLeadProfile;

interface CanonicalExportRequest {
  createdFrom: string | null;
  createdTo: string | null;
  stateCode: string | null;
  birthdayMonth: number | null;
  visitFrom: string | null;
  visitTo: string | null;
}

const LEADS_PAGE_SIZE_OPTIONS = ['25', '50', '100'] as const;

function mergeImportedNotes(currentNotes: string | null, nextNotes: string | null) {
  if (!currentNotes) return nextNotes;
  if (!nextNotes || nextNotes === currentNotes) return currentNotes;
  return `${currentNotes}\n${nextNotes}`;
}

function mergeImportedTextField(
  currentValue: string | null | undefined,
  nextValue: string | null | undefined,
  mode: LeadImportMode,
) {
  const current = currentValue?.trim() || '';
  const next = nextValue?.trim() || '';

  if (mode === 'overwrite') {
    return next || current || null;
  }

  return current || next || null;
}

function mergeImportedNameField(
  currentValue: string | null | undefined,
  nextValue: string | null | undefined,
  mode: LeadImportMode,
) {
  const current = currentValue?.trim() || '';
  const next = nextValue?.trim() || '';

  if (mode === 'overwrite') {
    return next || current || 'Lead sem nome';
  }

  if (!current || current === 'Lead sem nome') {
    return next || current || 'Lead sem nome';
  }

  return current;
}

function mergeImportedNotesField(
  currentValue: string | null | undefined,
  nextValue: string | null | undefined,
  mode: LeadImportMode,
) {
  const current = currentValue?.trim() || null;
  const next = nextValue?.trim() || null;

  if (mode === 'overwrite') {
    return next || current;
  }

  return mergeImportedNotes(current, next);
}

function mergePreviewRows(current: ParsedLeadImportRow, next: ParsedLeadImportRow): ParsedLeadImportRow {
  return {
    ...current,
    name: current.name !== 'Lead sem nome' ? current.name : next.name,
    phone: current.phone || next.phone,
    phoneNormalized: current.phoneNormalized || next.phoneNormalized,
    email: current.email || next.email,
    emailNormalized: current.emailNormalized || next.emailNormalized,
    birthdate: current.birthdate || next.birthdate,
    notes: mergeImportedNotes(current.notes, next.notes),
  };
}

function consolidateImportPreviewRows(rows: ParsedLeadImportRow[]) {
  const mergedRows: ParsedLeadImportRow[] = [];
  const byPhone = new Map<string, ParsedLeadImportRow>();
  const byEmail = new Map<string, ParsedLeadImportRow>();
  let duplicateCount = 0;

  for (const row of rows) {
    const current =
      (row.phoneNormalized ? byPhone.get(row.phoneNormalized) : undefined)
      || (row.emailNormalized ? byEmail.get(row.emailNormalized) : undefined);

    if (current) {
      duplicateCount += 1;
      const merged = mergePreviewRows(current, row);

      Object.assign(current, merged);

      if (current.phoneNormalized) {
        byPhone.set(current.phoneNormalized, current);
      }

      if (current.emailNormalized) {
        byEmail.set(current.emailNormalized, current);
      }

      continue;
    }

    const nextRow = { ...row };
    mergedRows.push(nextRow);

    if (nextRow.phoneNormalized) {
      byPhone.set(nextRow.phoneNormalized, nextRow);
    }

    if (nextRow.emailNormalized) {
      byEmail.set(nextRow.emailNormalized, nextRow);
    }
  }

  return { rows: mergedRows, duplicateCount };
}

async function findImportedLeadMatches(companyId: string, rows: ParsedLeadImportRow[]) {
  const phoneValues = new Set<string>();
  const emailValues = new Set<string>();

  for (const row of rows) {
    if (row.phoneNormalized) {
      phoneValues.add(row.phoneNormalized);
      phoneValues.add(normalizeLeadPhoneKey(row.phoneNormalized));
    }

    if (row.emailNormalized) {
      emailValues.add(row.emailNormalized);
    }
  }

  const selectFields = 'id, full_name, phone, phone_normalized, email, email_normalized, birthdate, notes, source, import_filename, imported_at, imported_by_user_id, created_at, updated_at';
  const matches = new Map<string, ImportedLeadRecord>();
  const chunkSize = 100;
  const queryPageSize = 500;

  const loadMatches = async (column: 'phone_normalized' | 'email_normalized', values: string[]) => {
    for (let index = 0; index < values.length; index += chunkSize) {
      const chunk = values.slice(index, index + chunkSize);
      const matchedRows = await collectCrmImportedLeadMatchPages(
        async (rangeStart, rangeEnd) => {
          const { data, error, count } = await supabase
            .from('crm_leads' as never)
            .select(selectFields, { count: 'exact' })
            .eq('company_id', companyId)
            .in(column, chunk)
            .order('id', { ascending: true })
            .range(rangeStart, rangeEnd);

          if (error) throw error;
          if (count === null) {
            throw new Error('Não foi possível confirmar o total de leads existentes.');
          }

          return {
            rows: (data ?? []) as ImportedLeadRecord[],
            total: count,
          };
        },
        (lead) => lead.id,
        queryPageSize,
      );

      for (const lead of matchedRows) {
        matches.set(lead.id, lead);
      }
    }
  };

  await Promise.all([
    loadMatches('phone_normalized', Array.from(phoneValues)),
    loadMatches('email_normalized', Array.from(emailValues)),
  ]);

  return Array.from(matches.values());
}

function getVisiblePages(currentPage: number, totalPages: number) {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }

  if (currentPage <= 4) {
    return [1, 2, 3, 4, 5, 'ellipsis', totalPages] as const;
  }

  if (currentPage >= totalPages - 3) {
    return [1, 'ellipsis', totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages] as const;
  }

  return [1, 'ellipsis', currentPage - 1, currentPage, currentPage + 1, 'ellipsis', totalPages] as const;
}

function formatLeadVisitsText(count: number) {
  return `${count} ${count === 1 ? 'visita' : 'visitas'}`;
}

function getLeadSourceBadgeClassName(source: LeadSource) {
  if (source === 'imported') {
    return 'border-border bg-muted/50 text-muted-foreground';
  }

  if (source === 'mixed') {
    return 'border-info/20 bg-info-soft text-info';
  }

  return isCompanionVisitSource(source)
    ? 'border-primary/20 bg-primary-soft text-primary'
    : 'border-success/20 bg-success-soft text-success';
}

export default function Leads() {
  const { companyId, slug } = useCompanySlug();
  const { user } = useAuth();
  const qc = useQueryClient();
  const importFileInputRef = useRef<HTMLInputElement | null>(null);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [createdRange, setCreatedRange] = useState<DateRange | undefined>();
  const [createdFrom, setCreatedFrom] = useState<Date | undefined>();
  const [createdTo, setCreatedTo] = useState<Date | undefined>();
  const [stateFilter, setStateFilter] = useState('all');
  const [minReservations, setMinReservations] = useState('');
  const [maxReservations, setMaxReservations] = useState('');
  const [birthdaysThisMonthOnly, setBirthdaysThisMonthOnly] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState<(typeof LEADS_PAGE_SIZE_OPTIONS)[number]>('25');
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importFileName, setImportFileName] = useState('');
  const [importRows, setImportRows] = useState<ParsedLeadImportRow[]>([]);
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [importDuplicateCount, setImportDuplicateCount] = useState(0);
  const [importMode, setImportMode] = useState<LeadImportMode>('fill_missing');
  const [importReading, setImportReading] = useState(false);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [exportLeadCreatedRange, setExportLeadCreatedRange] = useState<DateRange | undefined>();
  const [exportVisitRange, setExportVisitRange] = useState<DateRange | undefined>();
  const [exportStateFilter, setExportStateFilter] = useState('all');
  const [exportBirthdaysThisMonthOnly, setExportBirthdaysThisMonthOnly] = useState(false);
  const [exportRequest, setExportRequest] = useState<CanonicalExportRequest | null>(null);
  const [exportSpreadsheetPending, setExportSpreadsheetPending] = useState(false);
  const currentMonth = new Date().getMonth() + 1;
  const currentMonthLabel = format(new Date(), 'MMMM', { locale: ptBR });

  useEffect(() => {
    setCreatedFrom(createdRange?.from);
    setCreatedTo(createdRange?.to);
  }, [createdRange]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setCurrentPage(1);
      setDebouncedSearch(search.trim());
    }, 350);

    return () => window.clearTimeout(timeoutId);
  }, [search]);

  const parsedMinReservations = minReservations ? Number(minReservations) : null;
  const parsedMaxReservations = maxReservations ? Number(maxReservations) : null;
  const visitFilterRangeError = getCrmVisitsFilterRangeError(
    parsedMinReservations,
    parsedMaxReservations,
  );
  const leadsQuery = useCrmLeadsPage({
    companyId,
    page: currentPage,
    pageSize: Number(pageSize),
    search: debouncedSearch,
    createdFrom: createdFrom ? format(createdFrom, 'yyyy-MM-dd') : null,
    createdTo: createdTo ? format(createdTo, 'yyyy-MM-dd') : null,
    stateCode: stateFilter === 'all' ? null : stateFilter,
    birthdayMonth: birthdaysThisMonthOnly ? currentMonth : null,
    minVisits: parsedMinReservations !== null && Number.isFinite(parsedMinReservations)
      ? parsedMinReservations
      : null,
    maxVisits: parsedMaxReservations !== null && Number.isFinite(parsedMaxReservations)
      ? parsedMaxReservations
      : null,
    enabled: !visitFilterRangeError,
  });
  const exportQuery = useCrmLeadsCanonicalExport({
    companyId,
    createdFrom: exportRequest?.createdFrom,
    createdTo: exportRequest?.createdTo,
    stateCode: exportRequest?.stateCode,
    birthdayMonth: exportRequest?.birthdayMonth,
    visitFrom: exportRequest?.visitFrom,
    visitTo: exportRequest?.visitTo,
    enabled: exportDialogOpen && !!exportRequest,
  });

  const resetImportState = () => {
    setImportFileName('');
    setImportRows([]);
    setImportErrors([]);
    setImportDuplicateCount(0);
    setImportMode('fill_missing');
    setImportReading(false);

    if (importFileInputRef.current) {
      importFileInputRef.current.value = '';
    }
  };

  const importMutation = useMutation({
    mutationFn: async () => {
      if (!companyId || !user) {
        throw new Error('Sessão expirada. Entre novamente para importar leads.');
      }

      if (importRows.length === 0) {
        throw new Error('Carregue um CSV com pelo menos um lead válido antes de importar.');
      }

      const existingByPhone = new Map<string, ImportedLeadRecord>();
      const existingByEmail = new Map<string, ImportedLeadRecord>();
      const existingLeads = await findImportedLeadMatches(companyId, importRows);

      for (const lead of existingLeads) {
        const phoneKey = normalizeLeadPhoneKey(lead.phone_normalized ?? lead.phone);
        if (phoneKey && !existingByPhone.has(phoneKey)) {
          existingByPhone.set(phoneKey, lead);
        }

        if (lead.email_normalized && !existingByEmail.has(lead.email_normalized)) {
          existingByEmail.set(lead.email_normalized, lead);
        }
      }

      const importedAt = new Date().toISOString();
      const payloads: Array<Record<string, unknown>> = [];
      let inserted = 0;
      let updated = 0;
      let skipped = 0;

      for (const row of importRows) {
        const phoneKey = normalizeLeadPhoneKey(row.phoneNormalized || row.phone);
        const matchedByPhone = phoneKey ? existingByPhone.get(phoneKey) : undefined;
        const matchedByEmail = row.emailNormalized ? existingByEmail.get(row.emailNormalized) : undefined;

        if (matchedByPhone && matchedByEmail && matchedByPhone.id !== matchedByEmail.id) {
          skipped += 1;
          continue;
        }

        const current = matchedByPhone ?? matchedByEmail ?? null;

        const payload: Record<string, unknown> = {
          company_id: companyId,
          full_name: mergeImportedNameField(current?.full_name, row.name, importMode),
          phone: mergeImportedTextField(current?.phone, row.phone || null, importMode),
          phone_normalized: mergeImportedTextField(current?.phone_normalized, row.phoneNormalized || null, importMode),
          email: mergeImportedTextField(current?.email, row.email || null, importMode),
          email_normalized: mergeImportedTextField(current?.email_normalized, row.emailNormalized || null, importMode),
          birthdate: mergeImportedTextField(current?.birthdate, row.birthdate, importMode),
          notes: mergeImportedNotesField(current?.notes, row.notes, importMode),
          source: 'import_csv',
          import_filename: importFileName || null,
          imported_at: importedAt,
          imported_by_user_id: user.id,
        };

        if (current?.id) {
          payload.id = current.id;
          updated += 1;
        } else {
          inserted += 1;
        }

        payloads.push(payload);
      }

      if (payloads.length === 0) {
        return { inserted, updated, skipped };
      }

      const chunkSize = 200;

      for (let index = 0; index < payloads.length; index += chunkSize) {
        const chunk = payloads.slice(index, index + chunkSize);
        const { error } = await supabase
          .from('crm_leads' as never)
          .upsert(chunk as never[]);

        if (error) {
          throw error;
        }
      }

      return { inserted, updated, skipped };
    },
    onSuccess: async ({ inserted, updated, skipped }) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['crm-leads-page', companyId] }),
        qc.invalidateQueries({ queryKey: ['crm-leads-export', companyId] }),
      ]);

      const pieces = [
        inserted > 0 ? `${inserted} novos` : null,
        updated > 0 ? `${updated} atualizados` : null,
        skipped > 0 ? `${skipped} ignorados por conflito` : null,
      ].filter(Boolean);

      toast.success(
        pieces.length > 0
          ? `Importação concluída: ${pieces.join(' • ')}.`
          : 'Nenhum lead precisou ser importado.',
      );

      setImportDialogOpen(false);
      resetImportState();
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : 'Não foi possível importar os leads.';
      toast.error(message);
    },
  });

  const handleImportFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    setImportReading(true);

    try {
      const text = await file.text();
      const result = parseLeadImportCsv(text);
      const consolidated = consolidateImportPreviewRows(result.rows);

      setImportFileName(file.name);
      setImportRows(consolidated.rows);
      setImportErrors(result.errors);
      setImportDuplicateCount(result.duplicateCount + consolidated.duplicateCount);

      if (consolidated.rows.length === 0) {
        toast.error('Nenhum lead válido foi encontrado no arquivo.');
      } else if (result.errors.length > 0) {
        toast.success(`Arquivo carregado com ${consolidated.rows.length} leads válidos e ${result.errors.length} linhas ignoradas.`);
      } else {
        toast.success(`${consolidated.rows.length} leads prontos para importar.`);
      }
    } catch {
      toast.error('Não foi possível ler o arquivo CSV.');
    } finally {
      setImportReading(false);
      event.target.value = '';
    }
  };

  const downloadImportTemplate = () => {
    downloadCsv(
      'modelo-importacao-leads.csv',
      ['nome', 'telefone', 'email', 'nascimento', 'observações'],
      [
        ['Maria Eduarda Nunes', '83981297758', 'maria@example.com', '1994-05-18', 'Veio de uma base antiga'],
        ['Joao Pedro', '85999887766', '', '', 'Interessado em jantar romantico'],
      ],
    );
  };

  const isLoading = leadsQuery.isLoading;
  const hasLoadError = leadsQuery.isError;

  const refetchLeadData = () => {
    void leadsQuery.refetch();
  };

  const refreshSelectedLead = async (lead: CrmLeadProfile) => {
    const refreshedList = await leadsQuery.refetch();
    const refreshedRow = refreshedList.data?.leads.find((row) => row.customer_key === lead.key);

    if (refreshedRow && refreshedRow.canonical_visit_count !== lead.total_reservations) {
      setSelectedLead(mapCrmLeadRowToProfile(refreshedRow));
      return true;
    }

    return false;
  };

  const leads = useMemo(
    () => (leadsQuery.data?.leads ?? []).map(mapCrmLeadRowToProfile),
    [leadsQuery.data?.leads],
  );
  const stateOptions = leadsQuery.data?.states ?? [];
  const filteredLeads = leads;
  const paginatedLeads = leads;
  const listMeta = leadsQuery.data?.meta;
  const filteredLeadsCount = listMeta?.filtered_leads ?? 0;
  const totalLeadsCount = listMeta?.total_leads ?? 0;
  const filteredCanonicalVisits = listMeta?.filtered_canonical_visits ?? 0;
  const totalCanonicalVisits = listMeta?.total_canonical_visits ?? 0;
  const totalPages = Math.max(1, Math.ceil(filteredLeadsCount / (listMeta?.page_size ?? Number(pageSize))));
  const displayedPage = resolveCrmLeadsDisplayedPage(currentPage, listMeta?.page);
  const isChangingPage = !!listMeta
    && leadsQuery.isPlaceholderData
    && leadsQuery.isFetching
    && currentPage !== listMeta.page;

  const pageSummary = useMemo(() => {
    if (filteredLeadsCount === 0) {
      return 'Exibindo 0 de 0 leads';
    }

    const size = listMeta?.page_size ?? Number(pageSize);
    const start = (displayedPage - 1) * size + 1;
    const end = Math.min(displayedPage * size, filteredLeadsCount);

    return `Exibindo ${start}-${end} de ${filteredLeadsCount} leads`;
  }, [displayedPage, filteredLeadsCount, listMeta?.page_size, pageSize]);

  const visiblePages = useMemo(() => getVisiblePages(displayedPage, totalPages), [displayedPage, totalPages]);

  const hasActiveFilters =
    search.trim().length > 0 ||
    !!createdFrom ||
    !!createdTo ||
    stateFilter !== 'all' ||
    minReservations.trim().length > 0 ||
    maxReservations.trim().length > 0 ||
    birthdaysThisMonthOnly;

  useEffect(() => {
    setCurrentPage(1);
  }, [createdFrom, createdTo, stateFilter, minReservations, maxReservations, birthdaysThisMonthOnly, pageSize]);

  useEffect(() => {
    if (listMeta && currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, listMeta, totalPages]);

  const exportedLeads = useMemo(() => {
    return (exportQuery.data?.items ?? []).map(({ lead: row, visits, matchedSource }) => ({
      lead: mapCrmLeadRowToProfile(row),
      matchedVisits: visits,
      matchedSource,
    }));
  }, [exportQuery.data?.items]);

  const exportedLeadsSummary = useMemo(() => {
    return {
      totalLeads: exportedLeads.length,
    };
  }, [exportedLeads]);

  const clearFilters = () => {
    setSearch('');
    setDebouncedSearch('');
    setCreatedRange(undefined);
    setCreatedFrom(undefined);
    setCreatedTo(undefined);
    setStateFilter('all');
    setMinReservations('');
    setMaxReservations('');
    setBirthdaysThisMonthOnly(false);
    setCurrentPage(1);
  };

  const clearExportFilters = () => {
    setExportLeadCreatedRange(undefined);
    setExportVisitRange(undefined);
    setExportStateFilter('all');
    setExportBirthdaysThisMonthOnly(false);
    setExportRequest(null);
  };

  const applyExportFilters = () => {
    const nextRequest: CanonicalExportRequest = {
      createdFrom: exportLeadCreatedRange?.from ? format(exportLeadCreatedRange.from, 'yyyy-MM-dd') : null,
      createdTo: exportLeadCreatedRange?.to ? format(exportLeadCreatedRange.to, 'yyyy-MM-dd') : null,
      stateCode: exportStateFilter === 'all' ? null : exportStateFilter,
      birthdayMonth: exportBirthdaysThisMonthOnly ? currentMonth : null,
      visitFrom: exportVisitRange?.from ? format(exportVisitRange.from, 'yyyy-MM-dd') : null,
      visitTo: exportVisitRange?.to ? format(exportVisitRange.to, 'yyyy-MM-dd') : null,
    };

    if (exportRequest && JSON.stringify(exportRequest) === JSON.stringify(nextRequest)) {
      void exportQuery.refetch();
      return;
    }

    setExportRequest(nextRequest);
  };

  const exportLeadsSpreadsheet = async () => {
    const rows = exportedLeads.map(({ lead, matchedVisits, matchedSource }) => [
      lead.guest_name,
      formatLeadPhoneText(lead.guest_phone),
      lead.guest_email || '',
      lead.stateCode ? `${lead.stateName} (${lead.stateCode})` : '',
      lead.guest_birthdate ? new Date(`${lead.guest_birthdate}T12:00:00`) : null,
      parseISO(lead.lead_created_at),
      formatLeadSource(matchedSource),
      matchedVisits.length,
      lead.total_reservations,
      matchedVisits[0]
        ? new Date(`${matchedVisits[0].date}T${matchedVisits[0].time}`)
        : null,
      matchedVisits.length > 0
        ? matchedVisits
          .map((visit) => {
            const visitStatus = formatReservationStatus(visit.status);
            const visitMoment = `${format(new Date(`${visit.date}T12:00:00`), 'dd/MM/yyyy')} ${visit.time.slice(0, 5)}`;
            return `${visitMoment} - ${visitStatus}${formatLeadVisitContext(visit)}${visit.occasion ? ` - ${visit.occasion}` : ''}`;
          })
          .join(' | ')
        : 'Contato sem presenças registradas (check-in, atendimento concluído ou fila sentada)',
    ]);
    const columns: SpreadsheetColumn[] = [
      { header: 'Nome', width: 30 },
      { header: 'WhatsApp', width: 20 },
      { header: 'Email', width: 34 },
      { header: 'Estado', width: 27 },
      { header: 'Nascimento', width: 15, align: 'center', format: 'dd/mm/yyyy' },
      { header: 'Lead criado em', width: 20, align: 'center', format: 'dd/mm/yyyy hh:mm' },
      { header: 'Papel filtrado', width: 20 },
      { header: 'Presenças filtradas', width: 18, align: 'center', format: '0' },
      { header: 'Visitas totais', width: 14, align: 'center', format: '0' },
      { header: 'Última presença filtrada', width: 25, align: 'center', format: 'dd/mm/yyyy hh:mm' },
      { header: 'Histórico de presenças', width: 64, wrap: true },
    ];

    setExportSpreadsheetPending(true);

    try {
      await downloadSpreadsheet({
        filename: `leads_${format(new Date(), 'yyyy-MM-dd')}.xlsx`,
        sheetName: 'Leads',
        columns,
        rows,
        getRowHeight: (row) => {
          const historyLength = String(row[10] ?? '').length;
          const estimatedLines = Math.min(4, Math.max(1, Math.ceil(historyLength / 85)));
          return Math.max(22, estimatedLines * 15);
        },
      });

      toast.success(`${exportedLeads.length} leads exportados em Excel.`);
    } catch (error) {
      console.error('Lead spreadsheet export error:', error);
      toast.error('Não foi possível gerar a planilha de leads.');
    } finally {
      setExportSpreadsheetPending(false);
    }
  };

  const summaryText = hasActiveFilters
    ? `${filteredLeadsCount} de ${totalLeadsCount} clientes · ${filteredCanonicalVisits} de ${totalCanonicalVisits} visitas`
    : `${totalLeadsCount} clientes · ${totalCanonicalVisits} visitas`;

  return (
    <div className="space-y-6" aria-busy={leadsQuery.isFetching}>
      <div className="space-y-4">
        <div className="flex flex-col gap-3 border-b border-border/70 pb-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold tracking-tight text-foreground">Leads</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Base consolidada de clientes, reservas, fila de espera e importações.
            </p>
          </div>

          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
            <Select value={pageSize} onValueChange={(value) => setPageSize(value as (typeof LEADS_PAGE_SIZE_OPTIONS)[number])}>
              <SelectTrigger className="h-9 w-full rounded-md bg-card shadow-sm sm:w-[150px]" aria-label="Resultados por página">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LEADS_PAGE_SIZE_OPTIONS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {option} por página
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button onClick={() => setImportDialogOpen(true)} variant="outline" size="sm" className="w-full gap-2 bg-card sm:w-auto">
              <Upload className="h-4 w-4" />
              Importar CSV
            </Button>
            <Button
              onClick={() => setExportDialogOpen(true)}
              variant="outline"
              size="sm"
              className="w-full gap-2 bg-card sm:w-auto"
              disabled={totalLeadsCount === 0}
            >
              <Download className="h-4 w-4" />
              Exportar
            </Button>
          </div>
        </div>

      </div>

      <Card className="border-0 bg-card/95 shadow-sm ring-1 ring-black/[0.05]">
        <CardContent className="space-y-3 p-3">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <Filter className="h-4 w-4 text-primary" />
                Filtros
              </div>
              <label
                htmlFor="birthdays-this-month"
                className={cn(
                  'flex h-7 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-[11px] font-medium transition-colors',
                  birthdaysThisMonthOnly
                    ? 'border-primary/25 bg-primary-soft text-primary'
                    : 'border-border bg-background text-muted-foreground hover:text-foreground',
                )}
              >
                <Checkbox
                  id="birthdays-this-month"
                  checked={birthdaysThisMonthOnly}
                  onCheckedChange={(checked) => setBirthdaysThisMonthOnly(checked === true)}
                  className="h-3.5 w-3.5"
                />
                <CalendarDays className="h-3.5 w-3.5" />
                Aniversariantes de {currentMonthLabel}
              </label>
            </div>
            <p className="text-xs text-muted-foreground">{summaryText}</p>
          </div>

          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-[minmax(0,1.5fr)_220px_220px_130px_130px_auto]">
            <div className="relative md:col-span-2 xl:col-span-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Buscar por nome, telefone ou email…"
                value={search}
                maxLength={200}
                onChange={(event) => setSearch(event.target.value)}
                className="h-10 rounded-md bg-background pl-10"
                aria-label="Buscar leads por nome, telefone ou email"
              />
            </div>

            <Select value={stateFilter} onValueChange={setStateFilter}>
              <SelectTrigger className="h-10 rounded-md bg-background" aria-label="Filtrar leads por estado">
                <SelectValue placeholder="Estado" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos os estados</SelectItem>
                <SelectItem value="unknown">DDD não identificado</SelectItem>
                {stateOptions.map((state) => (
                  <SelectItem key={state.code} value={state.code}>
                    {state.name} ({state.code})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <DateRangePicker
              value={createdRange}
              onChange={setCreatedRange}
              placeholder="Selecionar período"
              className="h-10 w-full rounded-md bg-background"
            />

            <Input
              type="number"
              min="0"
              max={CRM_VISITS_FILTER_MAX}
              step="1"
              inputMode="numeric"
              placeholder="Visitas min."
              value={minReservations}
              onChange={(event) => setMinReservations(normalizeCrmVisitsFilterInput(event.target.value))}
              className="h-10 rounded-md bg-background"
              aria-label="Mínimo de visitas"
              aria-invalid={!!visitFilterRangeError}
              aria-describedby={visitFilterRangeError ? 'lead-visits-filter-error' : undefined}
            />

            <Input
              type="number"
              min="0"
              max={CRM_VISITS_FILTER_MAX}
              step="1"
              inputMode="numeric"
              placeholder="Visitas max."
              value={maxReservations}
              onChange={(event) => setMaxReservations(normalizeCrmVisitsFilterInput(event.target.value))}
              className="h-10 rounded-md bg-background"
              aria-label="Máximo de visitas"
              aria-invalid={!!visitFilterRangeError}
              aria-describedby={visitFilterRangeError ? 'lead-visits-filter-error' : undefined}
            />

            <Button variant="ghost" className="h-10 gap-2 px-3" disabled={!hasActiveFilters} onClick={clearFilters}>
              <X className="h-4 w-4" />
              Limpar
            </Button>
          </div>
          {visitFilterRangeError && (
            <p id="lead-visits-filter-error" className="text-xs font-medium text-destructive" role="alert">
              {visitFilterRangeError}
            </p>
          )}
        </CardContent>
      </Card>

      {visitFilterRangeError ? (
        <Card className="border-destructive/25 bg-destructive/5 shadow-none">
          <CardContent className="py-8 text-center text-sm text-foreground">
            Corrija o intervalo de visitas para atualizar a lista.
          </CardContent>
        </Card>
      ) : hasLoadError ? (
        <Card className="border-destructive/25 bg-destructive/5 shadow-none">
          <CardContent className="flex flex-col items-center gap-3 py-10 text-center" role="alert">
            <div>
              <p className="font-medium text-foreground">Não foi possível carregar a base de leads</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Nenhuma contagem parcial será exibida. Tente carregar os dados novamente.
              </p>
            </div>
            <Button type="button" variant="outline" onClick={refetchLeadData}>
              Tentar novamente
            </Button>
          </CardContent>
        </Card>
      ) : isLoading ? (
        <p className="py-12 text-center text-muted-foreground">Carregando…</p>
      ) : filteredLeadsCount === 0 ? (
        <p className="py-12 text-center text-muted-foreground">
          {hasActiveFilters ? 'Nenhum lead encontrado com os filtros atuais' : 'Nenhum lead encontrado'}
        </p>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="flex items-center gap-1.5 text-base font-semibold text-foreground">
                Clientes encontrados
                <InfoTooltip
                  content="Quando há telefone, ele identifica o cliente: nomes diferentes no mesmo número são unidos e exibimos o nome mais recente. Sem telefone, usamos o email; sem ambos, cada registro permanece separado. Contatos de reservas sem presença também aparecem, com 0 visitas."
                  ariaLabel="Entender como os clientes são identificados"
                  interaction="popover"
                />
              </h2>
              <p className="text-sm text-muted-foreground">{pageSummary}</p>
            </div>
            <span className="text-xs font-medium text-muted-foreground">Página {displayedPage} de {totalPages}</span>
          </div>

          <Card className="relative overflow-hidden border-0 bg-card/95 shadow-sm ring-1 ring-black/[0.05]">
            {isChangingPage && (
              <div
                className="absolute inset-0 z-20 flex min-h-48 items-center justify-center bg-card/80 backdrop-blur-[1px]"
                role="status"
                aria-live="polite"
              >
                <div className="flex items-center gap-2 rounded-full border border-border bg-background px-4 py-2 text-xs font-medium text-muted-foreground shadow-sm">
                  <Loader2 className="h-4 w-4 animate-spin text-primary motion-reduce:animate-none" aria-hidden="true" />
                  Carregando página {currentPage}…
                </div>
              </div>
            )}
            <Table className="min-w-[760px] text-xs">
              <TableHeader className="bg-muted/25">
                <TableRow className="hover:bg-transparent">
                  <TableHead className="h-8 w-[34%] px-2 text-[11px]">Nome</TableHead>
                  <TableHead className="h-8 px-2 text-[11px]">Telefone</TableHead>
                  <TableHead className="h-8 px-2 text-[11px]">Email</TableHead>
                  <TableHead className="h-8 w-[110px] px-2 text-right text-[11px]">
                    <span className="flex items-center justify-end gap-1">
                      Visitas
                      <InfoTooltip
                        content="Conta presenças registradas de titulares e acompanhantes identificados: check-in, atendimento concluído ou fila sentada. Quando uma fila vira reserva, ela conta apenas uma vez. O número considera todo o histórico disponível."
                        ariaLabel="Entender a contagem de visitas"
                        interaction="popover"
                      />
                    </span>
                  </TableHead>
                  <TableHead className="h-8 w-9 px-2" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {paginatedLeads.map((lead) => (
                  <TableRow
                    key={lead.key}
                    className="group cursor-pointer hover:bg-primary-soft/25"
                    onClick={() => setSelectedLead(lead)}
                  >
                    <TableCell className="px-2 py-1.5">
                      <div className="flex min-w-0 items-center gap-2">
                        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-primary-soft text-[11px] font-bold text-primary ring-1 ring-primary/15">
                          {(lead.guest_name.charAt(0) || '?').toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <div className="flex min-w-0 items-center gap-1.5">
                            <p className="truncate font-medium text-foreground">{lead.guest_name}</p>
                            <Badge
                              variant="outline"
                              className={cn('h-4 shrink-0 rounded px-1.5 text-[9px] leading-none', getLeadSourceBadgeClassName(lead.source))}
                            >
                              {formatLeadSource(lead.source)}
                            </Badge>
                            {lead.importedLeadId && (
                              <Badge variant="outline" className="h-4 shrink-0 rounded border-amber-200 bg-amber-50 px-1.5 text-[9px] leading-none text-amber-700">
                                Importado
                              </Badge>
                            )}
                          </div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="px-2 py-1.5">
                      <span className="whitespace-nowrap text-xs text-foreground">{formatLeadPhoneText(lead.guest_phone)}</span>
                    </TableCell>
                    <TableCell className="max-w-[260px] px-2 py-1.5">
                      <span className="block truncate text-xs text-muted-foreground">{lead.guest_email || 'Não informado'}</span>
                    </TableCell>
                    <TableCell className="px-2 py-1.5 text-right">
                      <span className="font-semibold text-foreground">{formatLeadVisitsText(lead.total_reservations)}</span>
                    </TableCell>
                    <TableCell className="px-2 py-1.5">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="ml-auto h-8 w-8 text-muted-foreground group-hover:bg-primary-soft group-hover:text-primary"
                        onClick={(event) => {
                          event.stopPropagation();
                          setSelectedLead(lead);
                        }}
                        aria-label={`Abrir perfil de ${lead.guest_name}`}
                      >
                        <Eye className="h-3.5 w-3.5" aria-hidden="true" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>

          {totalPages > 1 && (
            <Pagination aria-label="Paginação dos leads">
              <PaginationContent>
                <PaginationItem>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="gap-1"
                    aria-label="Ir para a página anterior"
                    disabled={displayedPage === 1 || leadsQuery.isFetching}
                    onClick={() => setCurrentPage(displayedPage - 1)}
                  >
                    <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                    Anterior
                  </Button>
                </PaginationItem>

                {visiblePages.map((page, index) => (
                  <PaginationItem key={`${page}-${index}`}>
                    {page === 'ellipsis' ? (
                      <PaginationEllipsis />
                    ) : (
                      <Button
                        type="button"
                        variant={page === displayedPage ? 'outline' : 'ghost'}
                        size="icon"
                        aria-label={`Ir para a página ${page}`}
                        aria-current={page === displayedPage ? 'page' : undefined}
                        disabled={leadsQuery.isFetching}
                        onClick={() => setCurrentPage(page)}
                      >
                        {page}
                      </Button>
                    )}
                  </PaginationItem>
                ))}

                <PaginationItem>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="gap-1"
                    aria-label="Ir para a próxima página"
                    disabled={displayedPage === totalPages || leadsQuery.isFetching}
                    onClick={() => setCurrentPage(displayedPage + 1)}
                  >
                    Próxima
                    <ChevronRight className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </PaginationItem>
              </PaginationContent>
            </Pagination>
          )}
        </div>
      )}

      <Dialog
        open={importDialogOpen}
        onOpenChange={(open) => {
          setImportDialogOpen(open);
          if (!open && !importMutation.isPending) {
            resetImportState();
          }
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Importar leads</DialogTitle>
          </DialogHeader>

          <div className="space-y-6 pt-2">
            <div className="rounded-3xl border border-border bg-muted/20 p-5">
              <p className="text-sm text-muted-foreground">
                Importe leads sem criar reservas. O arquivo pode ter as colunas
                <span className="font-medium text-foreground"> nome</span>,
                <span className="font-medium text-foreground"> telefone</span>,
                <span className="font-medium text-foreground"> email</span>,
                <span className="font-medium text-foreground"> nascimento</span> e
                <span className="font-medium text-foreground"> observações</span>.
              </p>

              <input
                ref={importFileInputRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={handleImportFileChange}
              />

              <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
                <Button
                  type="button"
                  variant="outline"
                  className="gap-2"
                  onClick={() => importFileInputRef.current?.click()}
                  disabled={importReading || importMutation.isPending}
                >
                  {importReading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                  {importReading ? 'Lendo arquivo…' : 'Selecionar CSV'}
                </Button>
                <Button type="button" variant="ghost" onClick={downloadImportTemplate} disabled={importMutation.isPending}>
                  Baixar modelo
                </Button>
                {importRows.length > 0 && (
                  <Button type="button" variant="ghost" onClick={resetImportState} disabled={importMutation.isPending}>
                    Limpar arquivo
                  </Button>
                )}
              </div>

              {importFileName && (
                <p className="mt-3 text-xs text-muted-foreground">
                  Arquivo atual: <span className="font-medium text-foreground">{importFileName}</span>
                </p>
              )}
            </div>

            {(importRows.length > 0 || importErrors.length > 0) ? (
              <>
                <div className="grid gap-3 md:grid-cols-4">
                  <div className="rounded-2xl border border-border bg-card p-4">
                    <p className="text-xs uppercase tracking-[0.08em] text-muted-foreground">Prontos</p>
                    <p className="mt-2 text-2xl font-semibold text-foreground">{importRows.length}</p>
                  </div>
                  <div className="rounded-2xl border border-border bg-card p-4">
                    <p className="text-xs uppercase tracking-[0.08em] text-muted-foreground">Ignorados</p>
                    <p className="mt-2 text-2xl font-semibold text-foreground">{importErrors.length}</p>
                  </div>
                  <div className="rounded-2xl border border-border bg-card p-4">
                    <p className="text-xs uppercase tracking-[0.08em] text-muted-foreground">Duplicados</p>
                    <p className="mt-2 text-2xl font-semibold text-foreground">{importDuplicateCount}</p>
                  </div>
                  <div className="rounded-2xl border border-border bg-card p-4">
                    <p className="text-xs uppercase tracking-[0.08em] text-muted-foreground">Modo</p>
                    <p className="mt-2 text-sm font-medium text-foreground">
                      {importMode === 'fill_missing' ? 'Preencher vazios' : 'Sobrescrever com CSV'}
                    </p>
                  </div>
                </div>

                <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
                  <div className="space-y-2">
                    <Label>Como atualizar leads já importados</Label>
                    <Select value={importMode} onValueChange={(value) => setImportMode(value as LeadImportMode)}>
                      <SelectTrigger className="h-11 rounded-xl bg-card">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="fill_missing">Preencher apenas campos vazios</SelectItem>
                        <SelectItem value="overwrite">Sobrescrever com valores do CSV</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      O sistema usa telefone e email normalizados para tentar localizar leads já importados.
                    </p>
                  </div>

                  <div className="rounded-2xl border border-border bg-card p-4">
                    <p className="text-sm font-medium text-foreground">Preview</p>
                    <div className="mt-3 max-h-64 space-y-2 overflow-y-auto">
                      {importRows.slice(0, 8).map((row) => (
                        <div key={row.key} className="rounded-xl border border-border bg-muted/10 p-3 text-sm">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <p className="font-medium text-foreground">{row.name}</p>
                            <p className="text-xs text-muted-foreground">Linha {row.rowNumber}</p>
                          </div>
                          <div className="mt-1 space-y-1 text-xs text-muted-foreground">
                            <p>Telefone: {formatLeadPhoneText(row.phone)}</p>
                            <p>Email: {row.email || 'Não informado'}</p>
                            {row.birthdate && <p>Nascimento: {row.birthdate}</p>}
                            {row.notes && <p className="whitespace-pre-wrap">Observações: {row.notes}</p>}
                          </div>
                        </div>
                      ))}
                    </div>
                    {importRows.length > 8 && (
                      <p className="mt-3 text-xs text-muted-foreground">
                        Mostrando 8 de {importRows.length} leads prontos para importar.
                      </p>
                    )}
                  </div>
                </div>

                {importErrors.length > 0 && (
                  <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-4">
                    <p className="text-sm font-medium text-foreground">Linhas ignoradas</p>
                    <div className="mt-3 max-h-40 space-y-2 overflow-y-auto text-xs text-muted-foreground">
                      {importErrors.slice(0, 12).map((errorMessage) => (
                        <p key={errorMessage}>{errorMessage}</p>
                      ))}
                    </div>
                    {importErrors.length > 12 && (
                      <p className="mt-3 text-xs text-muted-foreground">
                        Mostrando 12 de {importErrors.length} erros encontrados.
                      </p>
                    )}
                  </div>
                )}

                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-sm text-muted-foreground">
                    Leads importados aparecem mesmo sem reservas e se juntam ao histórico pelo telefone; quando não houver telefone, pelo email.
                  </p>
                  <Button
                    type="button"
                    className="gap-2"
                    onClick={() => importMutation.mutate()}
                    disabled={importRows.length === 0 || importReading || importMutation.isPending}
                  >
                    {importMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                    {importMutation.isPending ? 'Importando…' : `Importar ${importRows.length} leads`}
                  </Button>
                </div>
              </>
            ) : (
              <div className="rounded-3xl border border-dashed border-border bg-muted/10 p-6 text-sm text-muted-foreground">
                Carregue um arquivo CSV para validar os contatos antes de importar.
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={exportDialogOpen}
        onOpenChange={(open) => {
          setExportDialogOpen(open);
          if (!open) {
            setExportRequest(null);
          }
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Exportar leads</DialogTitle>
          </DialogHeader>

          <div className="space-y-6 pt-2">
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-2">
                <Label>Criação do lead</Label>
                <DateRangePicker
                  value={exportLeadCreatedRange}
                  onChange={setExportLeadCreatedRange}
                  className="h-11 w-full rounded-xl bg-card"
                />
              </div>

              <div className="space-y-2">
                <Label>Período das presenças</Label>
                <DateRangePicker
                  value={exportVisitRange}
                  onChange={setExportVisitRange}
                  className="h-11 w-full rounded-xl bg-card"
                />
              </div>

              <div className="space-y-2">
                <Label>Estado</Label>
                <Select value={exportStateFilter} onValueChange={setExportStateFilter}>
                  <SelectTrigger className="h-11 rounded-xl bg-card">
                    <SelectValue placeholder="Todos os estados" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todos os estados</SelectItem>
                    <SelectItem value="unknown">DDD não identificado</SelectItem>
                    {stateOptions.map((state) => (
                      <SelectItem key={state.code} value={state.code}>
                        {state.name} ({state.code})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="export-birthdays-this-month">Aniversariantes</Label>
                <label
                  htmlFor="export-birthdays-this-month"
                  className={cn(
                    'flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border px-4 py-2.5 transition-colors',
                    exportBirthdaysThisMonthOnly
                      ? 'border-primary/30 bg-primary-soft/60'
                      : 'border-border bg-card hover:bg-muted/20',
                  )}
                >
                  <Checkbox
                    id="export-birthdays-this-month"
                    checked={exportBirthdaysThisMonthOnly}
                    onCheckedChange={(checked) => setExportBirthdaysThisMonthOnly(checked === true)}
                  />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">Somente aniversariantes de {currentMonthLabel}</p>
                    <p className="text-xs text-muted-foreground">Leads sem data de nascimento não serão incluídos.</p>
                  </div>
                </label>
              </div>

            </div>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-xs text-muted-foreground">
                Os filtros são combinados. A exportação inclui somente presenças registradas (check-in, atendimento concluído ou fila sentada); reservas apenas confirmadas, canceladas e no-show não são visitas.
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Button variant="ghost" onClick={clearExportFilters}>
                  Limpar filtros
                </Button>
                <Button onClick={applyExportFilters} disabled={exportQuery.isFetching} className="gap-2">
                  {exportQuery.isFetching && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                  {exportQuery.isFetching ? 'Buscando…' : 'Buscar'}
                </Button>
              </div>
            </div>

            {exportRequest && (exportQuery.isLoading || (exportQuery.isFetching && !exportQuery.data)) ? (
              <div className="flex items-center gap-3 rounded-3xl border border-border bg-muted/20 p-5 text-sm text-muted-foreground" role="status" aria-live="polite">
                <Loader2 className="h-5 w-5 shrink-0 animate-spin" aria-hidden="true" />
                Carregando todas as páginas e presenças do recorte. Em bases maiores, isso pode levar alguns instantes.
              </div>
            ) : exportRequest && exportQuery.isError ? (
              <div className="rounded-3xl border border-destructive/25 bg-destructive/5 p-5" role="alert">
                <p className="text-sm font-medium text-foreground">Não foi possível preparar a exportação completa.</p>
                <p className="mt-1 text-xs text-muted-foreground">Nenhuma planilha parcial será gerada.</p>
                <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => void exportQuery.refetch()}>
                  Tentar novamente
                </Button>
              </div>
            ) : exportRequest && exportQuery.data ? (
              <div className="space-y-4 rounded-3xl border border-border bg-muted/20 p-5">
                <div className="rounded-2xl border border-border bg-card p-4">
                  <p className="text-xs uppercase tracking-[0.08em] text-muted-foreground">Leads encontrados</p>
                  <p className="mt-2 text-2xl font-semibold text-foreground">{exportedLeadsSummary.totalLeads}</p>
                </div>

                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-sm text-muted-foreground">
                    {exportedLeads.length === 0
                      ? 'Nenhum lead encontrado com os filtros informados.'
                      : 'A planilha terá os dados do lead e somente as presenças registradas (check-in, atendimento concluído ou fila sentada) no recorte escolhido.'}
                  </p>
                  <Button
                    className="gap-2"
                    onClick={exportLeadsSpreadsheet}
                    disabled={exportedLeads.length === 0 || exportSpreadsheetPending || exportQuery.isFetching}
                  >
                    {exportSpreadsheetPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                    {exportSpreadsheetPending ? 'Gerando planilha…' : 'Exportar planilha'}
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>

      <LeadProfileDialog
        open={!!selectedLead}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedLead(null);
          }
        }}
        lead={selectedLead}
        slug={slug}
        companyId={companyId}
        onRefreshLead={refreshSelectedLead}
      />
    </div>
  );
}
