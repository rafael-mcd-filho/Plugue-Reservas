import { Users, CalendarCheck, Clock, XCircle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useReservations } from '@/contexts/ReservationContext';
import { ReservationStatusBadge } from '@/components/StatusBadge';

export default function Dashboard() {
  const { reservations, getTableById } = useReservations();
  const today = new Date().toISOString().split('T')[0];
  const todayReservations = reservations.filter(r => r.date === today);

  const stats = [
    { label: 'Reservas Hoje', value: todayReservations.length, icon: CalendarCheck, color: 'text-primary' },
    { label: 'Convidados Esperados', value: todayReservations.reduce((sum, r) => sum + r.partySize, 0), icon: Users, color: 'text-accent' },
    { label: 'Pendentes', value: todayReservations.filter(r => r.status === 'pending').length, icon: Clock, color: 'text-yellow-600' },
    { label: 'Canceladas', value: todayReservations.filter(r => r.status === 'cancelled').length, icon: XCircle, color: 'text-destructive' },
  ];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-muted-foreground mt-1">Visão geral do seu restaurante</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map(stat => (
          <Card key={stat.label} className="border-none shadow-sm">
            <CardContent className="flex items-center gap-4 pt-6">
              <div className={`p-3 rounded-xl bg-muted ${stat.color}`}>
                <stat.icon className="h-6 w-6" />
              </div>
              <div>
                <p className="text-2xl font-bold">{stat.value}</p>
                <p className="text-sm text-muted-foreground">{stat.label}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="border-none shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg">Reservas de Hoje</CardTitle>
        </CardHeader>
        <CardContent>
          {todayReservations.length === 0 ? (
            <p className="text-muted-foreground text-sm py-8 text-center">Nenhuma reserva para hoje</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="pb-3 font-medium text-muted-foreground">Horário</th>
                    <th className="pb-3 font-medium text-muted-foreground">Cliente</th>
                    <th className="pb-3 font-medium text-muted-foreground">Pessoas</th>
                    <th className="pb-3 font-medium text-muted-foreground">Mesa</th>
                    <th className="pb-3 font-medium text-muted-foreground">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {todayReservations.sort((a, b) => a.time.localeCompare(b.time)).map(r => {
                    const table = getTableById(r.tableId);
                    return (
                      <tr key={r.id} className="border-b last:border-0 hover:bg-muted/50 transition-colors">
                        <td className="py-3 font-medium">{r.time}</td>
                        <td className="py-3">
                          <div>{r.guestName}</div>
                          <div className="text-xs text-muted-foreground">{r.guestPhone}</div>
                        </td>
                        <td className="py-3">{r.partySize}</td>
                        <td className="py-3">Mesa {table?.number ?? '?'}</td>
                        <td className="py-3"><ReservationStatusBadge status={r.status} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
