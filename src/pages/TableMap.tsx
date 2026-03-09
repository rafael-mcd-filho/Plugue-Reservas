import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useReservations } from '@/contexts/ReservationContext';
import { TableStatusBadge } from '@/components/StatusBadge';
import { cn } from '@/lib/utils';
import { TableStatus } from '@/types/restaurant';
import { Users } from 'lucide-react';

const statusColors: Record<TableStatus, string> = {
  available: 'border-accent bg-accent/10 hover:bg-accent/20',
  occupied: 'border-primary bg-primary/10 hover:bg-primary/20',
  reserved: 'border-yellow-500 bg-yellow-500/10 hover:bg-yellow-500/20',
  maintenance: 'border-muted-foreground/30 bg-muted opacity-60',
};

export default function TableMap() {
  const { tables, reservations } = useReservations();
  const today = new Date().toISOString().split('T')[0];

  const sections = ['salão', 'varanda', 'privativo'] as const;
  const sectionLabels = { salão: 'Salão Principal', varanda: 'Varanda', privativo: 'Área Privativa' };

  const summary = {
    available: tables.filter(t => t.status === 'available').length,
    occupied: tables.filter(t => t.status === 'occupied').length,
    reserved: tables.filter(t => t.status === 'reserved').length,
    maintenance: tables.filter(t => t.status === 'maintenance').length,
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Mapa de Mesas</h1>
        <p className="text-muted-foreground mt-1">Visualização do salão e status das mesas</p>
      </div>

      <div className="flex flex-wrap gap-4">
        {Object.entries(summary).map(([status, count]) => (
          <div key={status} className="flex items-center gap-2 text-sm">
            <div className={cn('w-3 h-3 rounded-full', {
              'bg-accent': status === 'available',
              'bg-primary': status === 'occupied',
              'bg-yellow-500': status === 'reserved',
              'bg-muted-foreground/40': status === 'maintenance',
            })} />
            <TableStatusBadge status={status as TableStatus} />
            <span className="text-muted-foreground">({count})</span>
          </div>
        ))}
      </div>

      {sections.map(section => {
        const sectionTables = tables.filter(t => t.section === section);
        if (sectionTables.length === 0) return null;
        return (
          <Card key={section} className="border-none shadow-sm">
            <CardHeader>
              <CardTitle className="text-lg">{sectionLabels[section]}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                {sectionTables.map(table => {
                  const tableReservation = reservations.find(r => r.tableId === table.id && r.date === today && (r.status === 'confirmed' || r.status === 'pending'));
                  return (
                    <div
                      key={table.id}
                      className={cn(
                        'relative p-4 rounded-xl border-2 transition-all cursor-default',
                        statusColors[table.status]
                      )}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-lg font-bold">Mesa {table.number}</span>
                        <div className="flex items-center gap-1 text-muted-foreground">
                          <Users className="h-3.5 w-3.5" />
                          <span className="text-xs">{table.capacity}</span>
                        </div>
                      </div>
                      <TableStatusBadge status={table.status} />
                      {tableReservation && (
                        <div className="mt-2 pt-2 border-t border-border/50 text-xs text-muted-foreground">
                          <div className="font-medium text-foreground">{tableReservation.guestName}</div>
                          <div>{tableReservation.time} · {tableReservation.partySize} pessoas</div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
