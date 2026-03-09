import { addDays, subDays, format, eachDayOfInterval, startOfDay } from 'date-fns';
import { ptBR } from 'date-fns/locale';

export interface DailyStats {
  date: string;
  label: string;
  reservations: number;
  visits: number;
  waitlist: number;
  cancellations: number;
  noShows: number;
  avgPartySize: number;
}

const COMPANIES = [
  { id: '26f387c9-54e6-447b-9f26-38b3503c4dd5', name: 'Bistrô do Chef' },
  { id: '1e0da55b-f8e9-4199-80b6-79c64e93cb7a', name: 'Sushi Zen House' },
  { id: 'f0d6e8d8-2c7d-45db-97c7-595a8fad4a88', name: 'Restaurante Sabor & Arte' },
  { id: '853a7b45-7ef4-4b7b-8781-958cd527669d', name: 'Cantina Bella Napoli' },
];

function seededRandom(seed: number) {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

function generateDailyStats(companyId: string, date: Date, seed: number): DailyStats {
  const dayOfWeek = date.getDay();
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 5 || dayOfWeek === 6;
  const baseMultiplier = isWeekend ? 1.6 : 1;

  // Different patterns per company
  const companyIndex = COMPANIES.findIndex(c => c.id === companyId);
  const companyBase = [18, 25, 15, 20][companyIndex] || 15;

  const r1 = seededRandom(seed);
  const r2 = seededRandom(seed + 1);
  const r3 = seededRandom(seed + 2);
  const r4 = seededRandom(seed + 3);

  const reservations = Math.round(companyBase * baseMultiplier * (0.6 + r1 * 0.8));
  const visits = Math.round(reservations * (0.7 + r2 * 0.25));
  const waitlist = Math.round(reservations * (0.1 + r3 * 0.3));
  const cancellations = Math.round(reservations * r4 * 0.15);
  const noShows = Math.max(0, reservations - visits - cancellations);

  return {
    date: format(date, 'yyyy-MM-dd'),
    label: format(date, 'dd/MM', { locale: ptBR }),
    reservations,
    visits,
    waitlist,
    cancellations,
    noShows,
    avgPartySize: Math.round((2.5 + r1 * 2) * 10) / 10,
  };
}

export function getMockDashboardData(
  companyId: string | 'all',
  startDate: Date,
  endDate: Date,
): DailyStats[] {
  const days = eachDayOfInterval({ start: startDate, end: endDate });

  if (companyId === 'all') {
    return days.map((day, i) => {
      const combined = COMPANIES.reduce(
        (acc, company, ci) => {
          const stats = generateDailyStats(company.id, day, i * 100 + ci * 31 + day.getTime() % 1000);
          acc.reservations += stats.reservations;
          acc.visits += stats.visits;
          acc.waitlist += stats.waitlist;
          acc.cancellations += stats.cancellations;
          acc.noShows += stats.noShows;
          acc.avgPartySize += stats.avgPartySize;
          return acc;
        },
        { reservations: 0, visits: 0, waitlist: 0, cancellations: 0, noShows: 0, avgPartySize: 0 },
      );
      combined.avgPartySize = Math.round((combined.avgPartySize / COMPANIES.length) * 10) / 10;
      return {
        ...combined,
        date: format(day, 'yyyy-MM-dd'),
        label: format(day, 'dd/MM', { locale: ptBR }),
      };
    });
  }

  return days.map((day, i) =>
    generateDailyStats(companyId, day, i * 100 + day.getTime() % 1000),
  );
}

export function getMockCompanies() {
  return COMPANIES;
}
