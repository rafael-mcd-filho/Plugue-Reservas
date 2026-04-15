import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { format } from 'date-fns';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CalendarRange,
  CheckCircle2,
  CopyPlus,
  Layers3,
  Pencil,
  Plus,
  Star,
  Trash2,
  Users,
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useCompanySlug } from '@/contexts/CompanySlugContext';
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

type TableStatus = 'available' | 'occupied' | 'reserved' | 'maintenance';
type ActivationMode = 'draft' | 'now' | 'from_date' | 'period';
type MapState = 'default' | 'draft' | 'scheduled' | 'active' | 'ended';

interface TableMapRow {
  id: string;
  company_id: string;
  name: string;
  description: string | null;
  is_default: boolean;
  is_enabled: boolean;
  active_from: string | null;
  active_to: string | null;
  priority: number;
  created_at: string;
  updated_at: string;
}

interface TableSectionRow {
  id: string;
  company_id: string;
  code: string;
  name: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

interface DisplaySection {
  id: string;
  code: string;
  name: string;
  sort_order: number;
  managed: boolean;
}

interface RestaurantTable {
  id: string;
  company_id: string;
  table_map_id: string;
  number: number;
  capacity: number;
  section: string;
  status: TableStatus;
}

const STATUS_LABELS: Record<TableStatus, string> = {
  available: 'Disponivel',
  occupied: 'Ocupada',
  reserved: 'Reservada',
  maintenance: 'Manutenção',
};

const ACTIVATION_OPTIONS: Array<{
  value: ActivationMode;
  title: string;
  description: string;
}> = [
  {
    value: 'draft',
    title: 'Deixar parado',
    description: 'O mapa fica salvo como rascunho e não entra em operação.',
  },
  {
    value: 'now',
    title: 'Ativar agora',
    description: 'O mapa passa a sobrepor o padrão imediatamente e fica ativo até você pausar ou trocar.',
  },
  {
    value: 'from_date',
    title: 'Ativar a partir de uma data',
    description: 'O mapa começa a valer em uma data futura e segue ativo sem data final.',
  },
  {
    value: 'period',
    title: 'Ativar só por um período',
    description: 'O mapa assume apenas dentro do intervalo escolhido e depois o sistema volta sozinho ao padrão.',
  },
];

function toDateTimeLocalValue(value: string | null) {
  if (!value) return '';
  const date = new Date(value);
  const adjusted = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return adjusted.toISOString().slice(0, 16);
}

function fromDateTimeLocalValue(value: string) {
  return value ? new Date(value).toISOString() : null;
}

function slugifySectionName(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function formatSectionLabel(code: string) {
  return code
    .split('-')
    .filter(Boolean)
    .map((chunk) => chunk.charAt(0).toUpperCase() + chunk.slice(1))
    .join(' ');
}

function getUniqueSectionCode(name: string, sections: TableSectionRow[]) {
  const baseCode = slugifySectionName(name) || 'secao';
  let nextCode = baseCode;
  let counter = 2;

  while (sections.some((section) => section.code === nextCode)) {
    nextCode = `${baseCode}-${counter}`;
    counter += 1;
  }

  return nextCode;
}

function normalizeSection(section: string, tableSections: TableSectionRow[]) {
  if (!section) return tableSections[0]?.code ?? 'salao';
  if (tableSections.some((item) => item.code === section)) return section;

  const normalized = slugifySectionName(section) || 'salao';
  if (tableSections.some((item) => item.code === normalized)) return normalized;

  return tableSections[0]?.code ?? normalized;
}

function formatMapPeriod(tableMap: TableMapRow | null) {
  if (!tableMap) return '';
  if (tableMap.is_default) return 'Sempre ativo como fallback da unidade';
  if (!tableMap.is_enabled && !tableMap.active_from && !tableMap.active_to) return 'Rascunho sem data';
  if (tableMap.active_from && tableMap.active_to) {
    return `${format(new Date(tableMap.active_from), 'dd/MM/yyyy HH:mm')} até ${format(new Date(tableMap.active_to), 'dd/MM/yyyy HH:mm')}`;
  }
  if (tableMap.active_from) {
    return `A partir de ${format(new Date(tableMap.active_from), 'dd/MM/yyyy HH:mm')}`;
  }
  return 'Sem período definido';
}

function deriveActivationMode(tableMap: TableMapRow | null): ActivationMode {
  if (!tableMap || tableMap.is_default) return 'draft';
  if (!tableMap.is_enabled || !tableMap.active_from) return 'draft';
  if (tableMap.active_to) return 'period';
  return new Date(tableMap.active_from).getTime() <= Date.now() ? 'now' : 'from_date';
}

function getMapState(tableMap: TableMapRow, reference = new Date()) {
  if (tableMap.is_default) {
    return {
      key: 'default' as MapState,
      label: 'Mapa padrão',
      description: 'Entra automaticamente quando nenhum evento está ativo.',
      badgeClassName: 'bg-primary text-primary-foreground hover:bg-primary',
    };
  }

  if (!tableMap.is_enabled || !tableMap.active_from) {
    return {
      key: 'draft' as MapState,
      label: 'Parado',
      description: 'Salvo como rascunho, sem substituir o padrão.',
      badgeClassName: 'bg-muted text-muted-foreground hover:bg-muted',
    };
  }

  const start = new Date(tableMap.active_from).getTime();
  const end = tableMap.active_to ? new Date(tableMap.active_to).getTime() : Number.POSITIVE_INFINITY;
  const now = reference.getTime();

  if (now < start) {
    return {
      key: 'scheduled' as MapState,
      label: 'Programado',
      description: 'Vai assumir automaticamente na data definida.',
      badgeClassName: 'bg-info text-white hover:bg-info',
    };
  }

  if (now >= end) {
    return {
      key: 'ended' as MapState,
      label: 'Encerrado',
      description: 'Já passou. O sistema voltou para o mapa padrão.',
      badgeClassName: 'bg-muted text-muted-foreground hover:bg-muted',
    };
  }

  return {
    key: 'active' as MapState,
    label: 'Ativo agora',
    description: 'Sobrepõe o mapa padrão neste momento.',
    badgeClassName: 'bg-success text-white hover:bg-success',
  };
}

function resolveActiveTableMap(tableMaps: TableMapRow[], reservationAt: Date) {
  const specialMap = [...tableMaps]
    .filter((tableMap) =>
      !tableMap.is_default &&
      tableMap.is_enabled &&
      tableMap.active_from &&
      new Date(tableMap.active_from).getTime() <= reservationAt.getTime() &&
      (!tableMap.active_to || new Date(tableMap.active_to).getTime() > reservationAt.getTime()))
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return (b.active_from ? new Date(b.active_from).getTime() : 0) - (a.active_from ? new Date(a.active_from).getTime() : 0);
    })[0];

  if (specialMap) return specialMap;
  return tableMaps.find((tableMap) => tableMap.is_default) ?? null;
}

function rangesOverlap(
  firstStart: string | null,
  firstEnd: string | null,
  secondStart: string | null,
  secondEnd: string | null,
) {
  if (!firstStart || !secondStart) return false;

  const startA = new Date(firstStart).getTime();
  const endA = firstEnd ? new Date(firstEnd).getTime() : Number.POSITIVE_INFINITY;
  const startB = new Date(secondStart).getTime();
  const endB = secondEnd ? new Date(secondEnd).getTime() : Number.POSITIVE_INFINITY;

  return startA < endB && startB < endA;
}

export default function TableMap() {
  const { companyId } = useCompanySlug();
  const qc = useQueryClient();
  const [selectedMapId, setSelectedMapId] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editingTable, setEditingTable] = useState<RestaurantTable | null>(null);
  const [mapDialogOpen, setMapDialogOpen] = useState(false);
  const [editingMap, setEditingMap] = useState<TableMapRow | null>(null);
  const [sectionDialogOpen, setSectionDialogOpen] = useState(false);
  const [editingSection, setEditingSection] = useState<TableSectionRow | null>(null);
  const [sectionToDelete, setSectionToDelete] = useState<TableSectionRow | null>(null);
  const [deleteMapConfirmOpen, setDeleteMapConfirmOpen] = useState(false);
  const [form, setForm] = useState({ number: '', capacity: '2', section: 'salao' });
  const [mapForm, setMapForm] = useState({
    name: '',
    activationMode: 'draft' as ActivationMode,
    activeFrom: '',
    activeTo: '',
    duplicateCurrentTables: true,
  });
  const [sectionForm, setSectionForm] = useState({ name: '' });

  const { data: tableMaps = [], isLoading: mapsLoading } = useQuery({
    queryKey: ['table-maps', companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('table_maps' as any)
        .select('*')
        .eq('company_id', companyId)
        .order('is_default', { ascending: false })
        .order('priority', { ascending: true })
        .order('created_at', { ascending: true });
      if (error) throw error;
      return (data as TableMapRow[]) ?? [];
    },
    enabled: !!companyId,
  });

  const orderedTableMaps = useMemo(
    () =>
      [...tableMaps].sort((first, second) => {
        if (first.is_default !== second.is_default) return first.is_default ? -1 : 1;

        const stateOrder: Record<MapState, number> = {
          active: 0,
          scheduled: 1,
          draft: 2,
          ended: 3,
          default: 4,
        };

        const firstState = getMapState(first).key;
        const secondState = getMapState(second).key;

        if (stateOrder[firstState] !== stateOrder[secondState]) {
          return stateOrder[firstState] - stateOrder[secondState];
        }

        return first.name.localeCompare(second.name);
      }),
    [tableMaps],
  );

  const { data: tableSections = [], isLoading: sectionsLoading } = useQuery({
    queryKey: ['table-sections', companyId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('table_sections' as any)
        .select('*')
        .eq('company_id', companyId)
        .order('sort_order', { ascending: true })
        .order('created_at', { ascending: true });
      if (error) throw error;
      return (data as TableSectionRow[]) ?? [];
    },
    enabled: !!companyId,
  });

  useEffect(() => {
    if (orderedTableMaps.length === 0) {
      setSelectedMapId('');
      return;
    }

    if (!selectedMapId || !orderedTableMaps.some((tableMap) => tableMap.id === selectedMapId)) {
      const defaultMap = orderedTableMaps.find((tableMap) => tableMap.is_default);
      setSelectedMapId(defaultMap?.id ?? orderedTableMaps[0].id);
    }
  }, [orderedTableMaps, selectedMapId]);

  const defaultSectionCode = tableSections[0]?.code ?? 'salao';
  const selectedMap = orderedTableMaps.find((tableMap) => tableMap.id === selectedMapId) ?? null;
  const activeMapNow = useMemo(() => resolveActiveTableMap(orderedTableMaps, new Date()), [orderedTableMaps]);
  const selectedMapState = selectedMap ? getMapState(selectedMap) : null;

  const { data: rawTables = [], isLoading: tablesLoading } = useQuery({
    queryKey: ['restaurant-tables', companyId, selectedMapId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('restaurant_tables' as any)
        .select('*')
        .eq('company_id', companyId)
        .eq('table_map_id', selectedMapId)
        .order('number', { ascending: true });
      if (error) throw error;
      return (data as RestaurantTable[]) ?? [];
    },
    enabled: !!companyId && !!selectedMapId,
  });

  const tables = useMemo(
    () =>
      rawTables.map((table) => ({
        ...table,
        section: normalizeSection(table.section, tableSections),
      })),
    [rawTables, tableSections],
  );

  const { data: selectedMapReservationCount = 0 } = useQuery({
    queryKey: ['table-map-reservations-count', companyId, selectedMapId],
    queryFn: async () => {
      const { count, error } = await supabase
        .from('reservations' as any)
        .select('id', { head: true, count: 'exact' })
        .eq('company_id', companyId)
        .eq('table_map_id', selectedMapId);
      if (error) throw error;
      return count ?? 0;
    },
    enabled: !!companyId && !!selectedMapId && !!selectedMap && !selectedMap.is_default,
  });

  const displaySections = useMemo<DisplaySection[]>(() => {
    const managed = tableSections.map((section) => ({
      id: section.id,
      code: section.code,
      name: section.name,
      sort_order: section.sort_order,
      managed: true,
    }));

    const missingCodes = [...new Set(tables.map((table) => table.section))].filter(
      (code) => !managed.some((section) => section.code === code),
    );

    return [
      ...managed,
      ...missingCodes.map((code, index) => ({
        id: `fallback-${code}`,
        code,
        name: formatSectionLabel(code),
        sort_order: 1000 + index,
        managed: false,
      })),
    ].sort((first, second) => first.sort_order - second.sort_order || first.name.localeCompare(second.name));
  }, [tableSections, tables]);

  const isLoading = mapsLoading || sectionsLoading || (selectedMapId ? tablesLoading : false);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!selectedMapId) throw new Error('Selecione um mapa antes de cadastrar mesas.');

      const payload = {
        company_id: companyId,
        table_map_id: selectedMapId,
        number: Number(form.number),
        capacity: Number(form.capacity),
        section: normalizeSection(form.section, tableSections),
        status: editingTable?.status ?? 'available',
        updated_at: new Date().toISOString(),
      };

      if (editingTable) {
        const { error } = await supabase
          .from('restaurant_tables' as any)
          .update(payload as any)
          .eq('id', editingTable.id);
        if (error) throw error;
        return;
      }

      const { error } = await supabase
        .from('restaurant_tables' as any)
        .insert(payload as any);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['restaurant-tables', companyId] });
      toast.success(editingTable ? 'Mesa atualizada!' : 'Mesa criada!');
      closeModal();
    },
    onError: (err: any) => toast.error(`Erro: ${err.message}`),
  });

  const saveSectionMutation = useMutation({
    mutationFn: async () => {
      const name = sectionForm.name.trim();
      if (!name) throw new Error('Informe o nome da seção.');

      if (editingSection) {
        const { error } = await supabase
          .from('table_sections' as any)
          .update({
            name,
            updated_at: new Date().toISOString(),
          } as any)
          .eq('id', editingSection.id);

        if (error) throw error;
        return;
      }

      const nextSortOrder = tableSections.length > 0
        ? Math.max(...tableSections.map((section) => section.sort_order)) + 10
        : 10;

      const { error } = await supabase
        .from('table_sections' as any)
        .insert({
          company_id: companyId,
          code: getUniqueSectionCode(name, tableSections),
          name,
          sort_order: nextSortOrder,
        } as any);

      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['table-sections', companyId] });
      toast.success(editingSection ? 'Seção atualizada!' : 'Seção criada!');
      setSectionDialogOpen(false);
      setEditingSection(null);
    },
    onError: (err: any) => toast.error(`Erro: ${err.message}`),
  });

  const deleteSectionMutation = useMutation({
    mutationFn: async () => {
      if (!sectionToDelete) throw new Error('Selecione uma seção para excluir.');
      if (tableSections.length <= 1) {
        throw new Error('Mantenha pelo menos uma seção cadastrada na unidade.');
      }

      const { count, error: countError } = await supabase
        .from('restaurant_tables' as any)
        .select('id', { head: true, count: 'exact' })
        .eq('company_id', companyId)
        .eq('section', sectionToDelete.code);

      if (countError) throw countError;
      if ((count ?? 0) > 0) {
        throw new Error('Esta seção ainda possui mesas vinculadas. Realoque as mesas antes de excluir.');
      }

      const { error } = await supabase
        .from('table_sections' as any)
        .delete()
        .eq('id', sectionToDelete.id);

      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['table-sections', companyId] });
      qc.invalidateQueries({ queryKey: ['restaurant-tables', companyId] });
      toast.success('Seção excluída!');
      setSectionToDelete(null);
    },
    onError: (err: any) => toast.error(`Erro: ${err.message}`),
  });

  const saveMapMutation = useMutation({
    mutationFn: async () => {
      const name = mapForm.name.trim();
      if (!name) throw new Error('Informe o nome do mapa.');

      let isEnabled = true;
      let activeFrom: string | null = null;
      let activeTo: string | null = null;

      if (!editingMap?.is_default) {
        switch (mapForm.activationMode) {
          case 'draft':
            isEnabled = false;
            activeFrom = null;
            activeTo = null;
            break;
          case 'now':
            isEnabled = true;
            activeFrom = editingMap?.active_from && new Date(editingMap.active_from).getTime() <= Date.now()
              ? editingMap.active_from
              : new Date().toISOString();
            activeTo = null;
            break;
          case 'from_date':
            activeFrom = fromDateTimeLocalValue(mapForm.activeFrom);
            if (!activeFrom) throw new Error('Escolha a data de início do evento.');
            isEnabled = true;
            activeTo = null;
            break;
          case 'period':
            activeFrom = fromDateTimeLocalValue(mapForm.activeFrom);
            activeTo = fromDateTimeLocalValue(mapForm.activeTo);
            if (!activeFrom || !activeTo) throw new Error('Escolha o início e o fim do período.');
            if (new Date(activeFrom).getTime() >= new Date(activeTo).getTime()) {
              throw new Error('O período final precisa ser maior que o inicial.');
            }
            isEnabled = true;
            break;
        }
      }

      const overlappingMap = !editingMap?.is_default && isEnabled && activeFrom
        ? orderedTableMaps.find((tableMap) =>
            tableMap.id !== editingMap?.id &&
            !tableMap.is_default &&
            tableMap.is_enabled &&
            tableMap.active_from &&
            rangesOverlap(activeFrom, activeTo, tableMap.active_from, tableMap.active_to))
        : null;

      if (overlappingMap) {
        throw new Error(`O mapa "${overlappingMap.name}" já ocupa esse período.`);
      }

      if (editingMap) {
        const { data, error } = await supabase
          .from('table_maps' as any)
          .update({
            name,
            is_enabled: editingMap.is_default ? true : isEnabled,
            active_from: editingMap.is_default ? null : activeFrom,
            active_to: editingMap.is_default ? null : activeTo,
            updated_at: new Date().toISOString(),
          } as any)
          .eq('id', editingMap.id)
          .select('*')
          .single();
        if (error) throw error;
        return data as TableMapRow;
      }

      const { data: createdMap, error: createError } = await supabase
        .from('table_maps' as any)
        .insert({
          company_id: companyId,
          name,
          is_default: false,
          is_enabled: isEnabled,
          active_from: activeFrom,
          active_to: activeTo,
          priority: 100,
        } as any)
        .select('*')
        .single();

      if (createError) throw createError;

      if (mapForm.duplicateCurrentTables && selectedMapId && tables.length > 0) {
        const clonedTables = tables.map((table) => ({
          company_id: companyId,
          table_map_id: (createdMap as any).id,
          number: table.number,
          capacity: table.capacity,
          section: table.section,
          status: table.status,
        }));

        const { error: cloneError } = await supabase
          .from('restaurant_tables' as any)
          .insert(clonedTables as any);

        if (cloneError) throw cloneError;
      }

      return createdMap as TableMapRow;
    },
    onSuccess: (savedMap) => {
      qc.invalidateQueries({ queryKey: ['table-maps', companyId] });
      qc.invalidateQueries({ queryKey: ['restaurant-tables', companyId] });
      setSelectedMapId(savedMap.id);
      setMapDialogOpen(false);
      setEditingMap(null);
      toast.success(editingMap ? 'Mapa atualizado!' : 'Mapa criado!');
    },
    onError: (err: any) => toast.error(`Erro: ${err.message}`),
  });

  const setDefaultMapMutation = useMutation({
    mutationFn: async (tableMap: TableMapRow) => {
      if (tableMap.is_default) return;

      const now = new Date().toISOString();

      const { error: resetError } = await supabase
        .from('table_maps' as any)
        .update({
          is_default: false,
          is_enabled: false,
          active_from: null,
          active_to: null,
          priority: 100,
          updated_at: now,
        } as any)
        .eq('company_id', companyId)
        .eq('is_default', true);

      if (resetError) throw resetError;

      const { error: setError } = await supabase
        .from('table_maps' as any)
        .update({
          is_default: true,
          is_enabled: true,
          active_from: null,
          active_to: null,
          priority: 1000,
          updated_at: now,
        } as any)
        .eq('id', tableMap.id);

      if (setError) throw setError;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['table-maps', companyId] });
      toast.success('Mapa definido como padrão!');
    },
    onError: (err: any) => toast.error(`Erro: ${err.message}`),
  });

  const duplicateMapMutation = useMutation({
    mutationFn: async () => {
      if (!selectedMap) throw new Error('Selecione um mapa para duplicar.');

      const { data: createdMap, error: createError } = await supabase
        .from('table_maps' as any)
        .insert({
          company_id: companyId,
          name: `${selectedMap.name} (copia)`,
          is_default: false,
          is_enabled: false,
          active_from: null,
          active_to: null,
          priority: 100,
        } as any)
        .select('*')
        .single();

      if (createError) throw createError;

      if (tables.length > 0) {
        const clonedTables = tables.map((table) => ({
          company_id: companyId,
          table_map_id: (createdMap as any).id,
          number: table.number,
          capacity: table.capacity,
          section: table.section,
          status: table.status,
        }));

        const { error: cloneError } = await supabase
          .from('restaurant_tables' as any)
          .insert(clonedTables as any);

        if (cloneError) throw cloneError;
      }

      return createdMap as TableMapRow;
    },
    onSuccess: (createdMap) => {
      qc.invalidateQueries({ queryKey: ['table-maps', companyId] });
      qc.invalidateQueries({ queryKey: ['restaurant-tables', companyId] });
      setSelectedMapId(createdMap.id);
      toast.success('Mapa duplicado!');
    },
    onError: (err: any) => toast.error(`Erro: ${err.message}`),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from('restaurant_tables' as any)
        .delete()
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['restaurant-tables', companyId] });
      toast.success('Mesa removida!');
    },
    onError: (err: any) => toast.error(`Erro: ${err.message}`),
  });

  const deleteMapMutation = useMutation({
    mutationFn: async () => {
      if (!selectedMap) throw new Error('Selecione um mapa para excluir.');
      if (selectedMap.is_default) throw new Error('O mapa padrão não pode ser excluído.');
      if (activeMapNow?.id === selectedMap.id && selectedMap.is_enabled) {
        throw new Error('Não exclua um mapa que está ativo agora. Pause-o ou ajuste o período primeiro.');
      }
      if (selectedMapReservationCount > 0) {
        throw new Error('Este mapa já possui reservas vinculadas. Mantenha-o salvo e pare a ativação.');
      }

      const { error } = await supabase
        .from('table_maps' as any)
        .delete()
        .eq('id', selectedMap.id);

      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['table-maps', companyId] });
      qc.invalidateQueries({ queryKey: ['restaurant-tables', companyId] });
      setDeleteMapConfirmOpen(false);
      toast.success('Mapa excluido!');
    },
    onError: (err: any) => toast.error(`Erro: ${err.message}`),
  });

  const openCreate = () => {
    if (!selectedMapId) {
      toast.error('Selecione ou crie um mapa antes de cadastrar mesas.');
      return;
    }

    const nextNumber = tables.length > 0 ? Math.max(...tables.map((table) => table.number)) + 1 : 1;
    setEditingTable(null);
    setForm({ number: String(nextNumber), capacity: '2', section: defaultSectionCode });
    setModalOpen(true);
  };

  const openEdit = (tableId: string) => {
    const table = tables.find((item) => item.id === tableId);
    if (!table) return;

    setEditingTable(table);
    setForm({
      number: String(table.number),
      capacity: String(table.capacity),
      section: table.section,
    });
    setModalOpen(true);
  };

  const closeModal = () => {
    setModalOpen(false);
    setEditingTable(null);
  };

  const openCreateMap = () => {
    setEditingMap(null);
    setMapForm({
      name: '',
      activationMode: 'draft',
      activeFrom: '',
      activeTo: '',
      duplicateCurrentTables: true,
    });
    setMapDialogOpen(true);
  };

  const openEditMap = () => {
    if (!selectedMap) return;

    setEditingMap(selectedMap);
    setMapForm({
      name: selectedMap.name,
      activationMode: deriveActivationMode(selectedMap),
      activeFrom: toDateTimeLocalValue(selectedMap.active_from),
      activeTo: toDateTimeLocalValue(selectedMap.active_to),
      duplicateCurrentTables: false,
    });
    setMapDialogOpen(true);
  };

  const openCreateSection = () => {
    setEditingSection(null);
    setSectionForm({ name: '' });
    setSectionDialogOpen(true);
  };

  const openEditSection = (section: TableSectionRow) => {
    setEditingSection(section);
    setSectionForm({ name: section.name });
    setSectionDialogOpen(true);
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!form.number || !form.capacity) {
      toast.error('Preencha todos os campos da mesa.');
      return;
    }
    saveMutation.mutate();
  };

  const handleMapSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    saveMapMutation.mutate();
  };

  const handleSectionSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    saveSectionMutation.mutate();
  };

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-[300px] w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Mapas de Mesas</h1>
          <p className="mt-1 text-muted-foreground">
            Mantenha um mapa padrão, crie eventos com ativação programada e organize as seções da unidade.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button variant="outline" className="gap-2" onClick={openCreateMap}>
            <Plus className="h-4 w-4" />
            Novo mapa
          </Button>
          <Button variant="outline" className="gap-2" onClick={() => duplicateMapMutation.mutate()} disabled={!selectedMap}>
            <CopyPlus className="h-4 w-4" />
            Duplicar mapa
          </Button>
          <Button variant="outline" className="gap-2" onClick={openCreateSection}>
            <Layers3 className="h-4 w-4" />
            Nova seção
          </Button>
          <Button onClick={openCreate} className="gap-2" disabled={!selectedMapId}>
            <Plus className="h-4 w-4" />
            Nova mesa
          </Button>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[340px_minmax(0,1fr)]">
        <Card className="rounded-[24px] border border-[rgba(0,0,0,0.08)] shadow-sm">
          <CardHeader>
            <CardTitle className="text-lg">Mapas cadastrados</CardTitle>
            <CardDescription>
              Veja rapidamente qual é o mapa padrão, quais eventos estão ativos e quais ainda estão parados.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {orderedTableMaps.map((tableMap) => {
              const state = getMapState(tableMap);

              return (
                <button
                  key={tableMap.id}
                  type="button"
                  onClick={() => setSelectedMapId(tableMap.id)}
                  className={cn(
                    'w-full rounded-2xl border p-4 text-left transition-all',
                    selectedMapId === tableMap.id
                      ? 'border-primary bg-primary-soft shadow-sm'
                      : 'border-[rgba(0,0,0,0.08)] bg-white hover:border-primary/35',
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-foreground">{tableMap.name}</p>
                      <p className="mt-1 text-xs text-muted-foreground">{formatMapPeriod(tableMap)}</p>
                    </div>

                    {tableMap.is_default ? (
                      <Badge className="bg-primary text-primary-foreground hover:bg-primary">Padrao</Badge>
                    ) : (
                      <Badge variant="secondary">Evento</Badge>
                    )}
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    <Badge className={state.badgeClassName}>{state.label}</Badge>
                    {activeMapNow?.id === tableMap.id && !tableMap.is_default && (
                      <Badge className="bg-success-soft text-success hover:bg-success-soft">Sobrepondo</Badge>
                    )}
                  </div>
                </button>
              );
            })}
          </CardContent>
        </Card>

        <div className="space-y-6">
          {selectedMap && (
            <Card className="rounded-[24px] border border-[rgba(0,0,0,0.08)] shadow-sm">
              <CardHeader className="space-y-4">
                <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                  <div className="space-y-3">
                    <div>
                      <CardTitle className="text-lg">{selectedMap.name}</CardTitle>
                      <CardDescription>{selectedMapState?.description}</CardDescription>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      {selectedMap.is_default ? (
                        <Badge className="gap-1 bg-primary text-primary-foreground hover:bg-primary">
                          <Star className="h-3.5 w-3.5" />
                          Mapa padrão
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="gap-1">
                          <CalendarRange className="h-3.5 w-3.5" />
                          Evento
                        </Badge>
                      )}

                      {selectedMapState && (
                        <Badge className={cn('gap-1', selectedMapState.badgeClassName)}>
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          {selectedMapState.label}
                        </Badge>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" className="gap-2" onClick={openEditMap}>
                      <Pencil className="h-4 w-4" />
                      Editar mapa
                    </Button>
                    {!selectedMap.is_default && (
                      <Button
                        variant="outline"
                        className="gap-2"
                        onClick={() => setDefaultMapMutation.mutate(selectedMap)}
                        disabled={setDefaultMapMutation.isPending}
                      >
                        <Star className="h-4 w-4" />
                        Tornar padrão
                      </Button>
                    )}
                    {!selectedMap.is_default && (
                      <Button
                        variant="outline"
                        className="gap-2 text-destructive hover:text-destructive"
                        onClick={() => setDeleteMapConfirmOpen(true)}
                      >
                        <Trash2 className="h-4 w-4" />
                        Excluir mapa
                      </Button>
                    )}
                  </div>
                </div>
              </CardHeader>

              <CardContent className="space-y-5">
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                  <div className="rounded-2xl border border-[rgba(0,0,0,0.08)] bg-muted/15 p-4">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">Período</p>
                    <p className="mt-2 text-sm font-medium text-foreground">{formatMapPeriod(selectedMap)}</p>
                  </div>

                  <div className="rounded-2xl border border-[rgba(0,0,0,0.08)] bg-muted/15 p-4">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">Mesas neste mapa</p>
                    <p className="mt-2 text-sm font-medium text-foreground">{tables.length}</p>
                  </div>

                  <div className="rounded-2xl border border-[rgba(0,0,0,0.08)] bg-muted/15 p-4">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">Mapa ativo agora</p>
                    <p className="mt-2 text-sm font-medium text-foreground">{activeMapNow?.name ?? 'Nenhum'}</p>
                  </div>

                  <div className="rounded-2xl border border-[rgba(0,0,0,0.08)] bg-muted/15 p-4">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">Reservas vinculadas</p>
                    <p className="mt-2 text-sm font-medium text-foreground">
                      {selectedMap.is_default ? 'N/A' : selectedMapReservationCount}
                    </p>
                  </div>
                </div>

                {!selectedMap.is_default && (
                  <div className="rounded-2xl border border-[rgba(0,0,0,0.08)] bg-muted/15 p-4 text-sm text-muted-foreground">
                    Quando este evento estiver habilitado dentro do período escolhido, ele sobrepõe o mapa padrão.
                    Ao fim do período, o sistema volta automaticamente para o padrão.
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          <Card className="rounded-[24px] border border-[rgba(0,0,0,0.08)] shadow-sm">
            <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <CardTitle className="text-lg">Secoes da unidade</CardTitle>
                <CardDescription>
                  Crie e renomeie areas como Salao, Varanda, Deck ou Rooftop. As mesas de qualquer mapa usam essa lista.
                </CardDescription>
              </div>

              <Button variant="outline" className="gap-2" onClick={openCreateSection}>
                <Plus className="h-4 w-4" />
                Nova seção
              </Button>
            </CardHeader>
            <CardContent className="space-y-3">
              {displaySections.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-[rgba(0,0,0,0.14)] px-4 py-8 text-center text-sm text-muted-foreground">
                  Nenhuma seção cadastrada.
                </div>
              ) : (
                displaySections.map((section) => {
                  const tableCount = tables.filter((table) => table.section === section.code).length;
                  const managedSection = tableSections.find((item) => item.code === section.code) ?? null;

                  return (
                    <div
                      key={section.id}
                      className="flex flex-col gap-3 rounded-2xl border border-[rgba(0,0,0,0.08)] bg-white px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-medium text-foreground">{section.name}</p>
                          {!section.managed && <Badge variant="outline">Legado</Badge>}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Código interno: {section.code} - {tableCount} mesa(s) neste mapa
                        </p>
                      </div>

                      {managedSection && (
                        <div className="flex items-center gap-1">
                          <Button variant="ghost" size="sm" className="gap-2" onClick={() => openEditSection(managedSection)}>
                            <Pencil className="h-4 w-4" />
                            Editar
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="gap-2 text-destructive hover:text-destructive"
                            onClick={() => setSectionToDelete(managedSection)}
                          >
                            <Trash2 className="h-4 w-4" />
                            Excluir
                          </Button>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </CardContent>
          </Card>

          <div className="flex justify-end">
            <span className="text-sm font-medium text-foreground">Total: {tables.length} mesas</span>
          </div>

          {tables.length === 0 ? (
            <Card className="rounded-[24px] border-dashed">
              <CardContent className="flex flex-col items-center justify-center py-16 text-center">
                <p className="mb-4 text-muted-foreground">Nenhuma mesa cadastrada neste mapa.</p>
                <Button onClick={openCreate} variant="outline" className="gap-2" disabled={!selectedMapId}>
                  <Plus className="h-4 w-4" />
                  Cadastrar primeira mesa
                </Button>
              </CardContent>
            </Card>
          ) : (
            displaySections.map((section) => {
              const sectionTables = tables.filter((table) => table.section === section.code);
              if (sectionTables.length === 0) return null;

              return (
                <Card key={section.code} className="rounded-[24px] border border-[rgba(0,0,0,0.08)] shadow-sm">
                  <CardHeader className="flex flex-row items-center justify-between gap-3">
                    <div>
                      <CardTitle className="text-lg">{section.name}</CardTitle>
                      <CardDescription>{sectionTables.length} mesa(s) nesta seção</CardDescription>
                    </div>
                    <Badge variant="outline">{section.code}</Badge>
                  </CardHeader>
                  <CardContent>
                    <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-4">
                      {sectionTables.map((table) => (
                        <div
                          key={table.id}
                          className="rounded-2xl border border-[rgba(0,0,0,0.08)] bg-card p-4 shadow-sm"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <span className="text-lg font-bold text-foreground">Mesa {table.number}</span>
                              <p className="mt-1 text-sm text-muted-foreground">
                                Capacidade para {table.capacity} {table.capacity === 1 ? 'pessoa' : 'pessoas'}
                              </p>
                            </div>

                            <div className="flex shrink-0 items-center gap-1 text-muted-foreground">
                              <Users className="h-3.5 w-3.5" />
                              <span className="text-sm font-medium">{table.capacity}</span>
                            </div>
                          </div>

                          <div className="mt-4 flex justify-end gap-1 border-t border-border/70 pt-3">
                            <Button variant="ghost" size="icon" onClick={() => openEdit(table.id)} aria-label={`Editar mesa ${table.number}`}>
                              <Pencil className="h-4 w-4 text-muted-foreground" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => deleteMutation.mutate(table.id)}
                              aria-label={`Excluir mesa ${table.number}`}
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              );
            })
          )}
        </div>
      </div>

      <Dialog
        open={modalOpen}
        onOpenChange={(open) => {
          if (!open) closeModal();
          else setModalOpen(true);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{editingTable ? 'Editar mesa' : 'Nova mesa'}</DialogTitle>
          </DialogHeader>

          <form onSubmit={handleSubmit} className="space-y-4 pt-2">
            <div>
              <Label>Número da mesa</Label>
              <Input
                type="number"
                min={1}
                value={form.number}
                onChange={(event) => setForm((current) => ({ ...current, number: event.target.value }))}
                required
              />
            </div>

            <div>
              <Label>Capacidade (pessoas)</Label>
              <Input
                type="number"
                min={1}
                max={50}
                value={form.capacity}
                onChange={(event) => setForm((current) => ({ ...current, capacity: event.target.value }))}
                required
              />
            </div>

            <div>
              <Label>Seção</Label>
              <Select value={form.section} onValueChange={(value) => setForm((current) => ({ ...current, section: value }))}>
                <SelectTrigger>
                  <SelectValue placeholder="Selecione a seção" />
                </SelectTrigger>
                <SelectContent>
                  {displaySections.map((section) => (
                    <SelectItem key={section.code} value={section.code}>
                      {section.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <Button type="submit" className="w-full" disabled={saveMutation.isPending}>
              {editingTable ? 'Salvar alterações' : 'Criar mesa'}
            </Button>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={sectionDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            setSectionDialogOpen(false);
            setEditingSection(null);
          } else {
            setSectionDialogOpen(true);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editingSection ? 'Editar seção' : 'Nova seção'}</DialogTitle>
          </DialogHeader>

          <form onSubmit={handleSectionSubmit} className="space-y-4 pt-2">
            <div>
              <Label>Nome da seção</Label>
              <Input
                value={sectionForm.name}
                onChange={(event) => setSectionForm({ name: event.target.value })}
                placeholder="Ex: Deck externo"
                required
              />
            </div>

            <div className="rounded-xl border border-[rgba(0,0,0,0.08)] bg-muted/15 px-4 py-3 text-sm text-muted-foreground">
              {editingSection
                ? `O código interno desta seção continua "${editingSection.code}". Renomear aqui não quebra as mesas já cadastradas.`
                : 'Ao criar, a seção fica disponível para todos os mapas da unidade.'}
            </div>

            <Button type="submit" className="w-full" disabled={saveSectionMutation.isPending}>
              {editingSection ? 'Salvar seção' : 'Criar seção'}
            </Button>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={mapDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            setMapDialogOpen(false);
            setEditingMap(null);
          } else {
            setMapDialogOpen(true);
          }
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editingMap ? 'Editar mapa' : 'Novo mapa'}</DialogTitle>
          </DialogHeader>

          <form onSubmit={handleMapSubmit} className="space-y-5 pt-2">
            <div>
              <Label>Nome do mapa</Label>
              <Input
                value={mapForm.name}
                onChange={(event) => setMapForm((current) => ({ ...current, name: event.target.value }))}
                placeholder="Ex: Dia dos Namorados"
                required
              />
            </div>

            {editingMap?.is_default ? (
              <div className="rounded-xl border border-primary/20 bg-primary-soft px-4 py-3 text-sm text-primary">
                O mapa padrão fica sempre sem período. Ele entra automaticamente quando nenhum evento estiver ativo.
              </div>
            ) : (
              <>
                <div className="space-y-3">
                  <Label>Quando este mapa deve valer?</Label>
                  <RadioGroup
                    value={mapForm.activationMode}
                    onValueChange={(value) => setMapForm((current) => ({ ...current, activationMode: value as ActivationMode }))}
                    className="grid gap-3"
                  >
                    {ACTIVATION_OPTIONS.map((option) => (
                      <Label
                        key={option.value}
                        htmlFor={`activation-${option.value}`}
                        className={cn(
                          'flex cursor-pointer items-start gap-3 rounded-2xl border px-4 py-3',
                          mapForm.activationMode === option.value
                            ? 'border-primary bg-primary-soft'
                            : 'border-[rgba(0,0,0,0.08)] bg-white',
                        )}
                      >
                        <RadioGroupItem id={`activation-${option.value}`} value={option.value} className="mt-1" />
                        <div>
                          <p className="text-sm font-medium text-foreground">{option.title}</p>
                          <p className="text-xs text-muted-foreground">{option.description}</p>
                        </div>
                      </Label>
                    ))}
                  </RadioGroup>
                </div>

                {(mapForm.activationMode === 'from_date' || mapForm.activationMode === 'period') && (
                  <div className={cn('grid gap-4', mapForm.activationMode === 'period' ? 'md:grid-cols-2' : 'md:grid-cols-1')}>
                    <div>
                      <Label>Inicio</Label>
                      <Input
                        type="datetime-local"
                        value={mapForm.activeFrom}
                        onChange={(event) => setMapForm((current) => ({ ...current, activeFrom: event.target.value }))}
                      />
                    </div>

                    {mapForm.activationMode === 'period' && (
                      <div>
                        <Label>Fim</Label>
                        <Input
                          type="datetime-local"
                          value={mapForm.activeTo}
                          onChange={(event) => setMapForm((current) => ({ ...current, activeTo: event.target.value }))}
                        />
                      </div>
                    )}
                  </div>
                )}

                <div className="rounded-xl border border-[rgba(0,0,0,0.08)] bg-muted/15 px-4 py-3 text-sm text-muted-foreground">
                  O sistema não permite dois eventos ativos ou programados para o mesmo período. Se houver conflito,
                  você precisará ajustar a agenda antes de salvar.
                </div>
              </>
            )}

            {!editingMap && (
              <div className="flex items-center justify-between rounded-xl border border-[rgba(0,0,0,0.08)] bg-muted/15 px-4 py-3">
                <div>
                  <p className="text-sm font-medium text-foreground">Duplicar mesas do mapa selecionado</p>
                  <p className="text-xs text-muted-foreground">
                    Cria o novo mapa com a mesma estrutura do mapa atualmente aberto.
                  </p>
                </div>

                <input
                  type="checkbox"
                  checked={mapForm.duplicateCurrentTables}
                  onChange={(event) =>
                    setMapForm((current) => ({ ...current, duplicateCurrentTables: event.target.checked }))
                  }
                  className="h-4 w-4 accent-primary"
                />
              </div>
            )}

            <Button type="submit" className="w-full" disabled={saveMapMutation.isPending}>
              {editingMap ? 'Salvar mapa' : 'Criar mapa'}
            </Button>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!sectionToDelete} onOpenChange={(open) => { if (!open) setSectionToDelete(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir seção?</AlertDialogTitle>
            <AlertDialogDescription>
              {sectionToDelete
                ? `A seção "${sectionToDelete.name}" só pode ser removida se não houver nenhuma mesa vinculada a ela em qualquer mapa da unidade.`
                : 'A seção só pode ser removida se não houver mesas vinculadas.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(event) => {
                event.preventDefault();
                deleteSectionMutation.mutate();
              }}
              disabled={deleteSectionMutation.isPending}
            >
              Excluir seção
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deleteMapConfirmOpen} onOpenChange={setDeleteMapConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir mapa?</AlertDialogTitle>
            <AlertDialogDescription>
              {selectedMapReservationCount > 0
                ? 'Este mapa possui reservas vinculadas e não pode ser excluído. Pare a ativação ou escolha outro mapa como padrão.'
                : 'Esta ação remove o mapa e todas as mesas dele. Use isso apenas para mapas sem reservas.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(event) => {
                event.preventDefault();
                if (selectedMapReservationCount > 0) {
                  setDeleteMapConfirmOpen(false);
                  return;
                }
                deleteMapMutation.mutate();
              }}
              disabled={deleteMapMutation.isPending || selectedMapReservationCount > 0}
            >
              Excluir mapa
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
