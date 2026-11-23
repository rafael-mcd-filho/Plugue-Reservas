import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';

interface ListPaginationProps {
  /** Página atual, começando em 1. */
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  /** Rótulo no singular e no plural, ex.: ['empresa', 'empresas']. */
  itemLabel: [string, string];
  pageSizeOptions?: number[];
  onPageSizeChange?: (pageSize: number) => void;
  disabled?: boolean;
  className?: string;
}

const numberFormatter = new Intl.NumberFormat('pt-BR');

/** Rodapé padrão das listas: intervalo exibido, total e navegação. */
export default function ListPagination({
  page,
  pageSize,
  total,
  onPageChange,
  itemLabel,
  pageSizeOptions,
  onPageSizeChange,
  disabled,
  className,
}: ListPaginationProps) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(page, 1), pageCount);
  const first = total === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const last = Math.min(safePage * pageSize, total);
  const label = total === 1 ? itemLabel[0] : itemLabel[1];

  return (
    <div className={cn('flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-xs text-muted-foreground', className)}>
      <span aria-live="polite">
        {total === 0
          ? 'Nenhum resultado'
          : `${numberFormatter.format(first)}–${numberFormatter.format(last)} de ${numberFormatter.format(total)} ${label}`}
      </span>
      <div className="flex flex-wrap items-center gap-2">
        {pageSizeOptions && onPageSizeChange && (
          <label className="flex items-center gap-2">
            Por página
            <Select value={String(pageSize)} onValueChange={(value) => onPageSizeChange(Number(value))}>
              <SelectTrigger className="h-8 w-[72px]" aria-label="Itens por página">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {pageSizeOptions.map((option) => (
                  <SelectItem key={option} value={String(option)}>{option}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        )}
        {pageCount > 1 && <span>Página {safePage} de {pageCount}</span>}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || safePage <= 1}
          onClick={() => onPageChange(safePage - 1)}
        >
          Anterior
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || safePage >= pageCount}
          onClick={() => onPageChange(safePage + 1)}
        >
          Próxima
        </Button>
      </div>
    </div>
  );
}
