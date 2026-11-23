export interface PopularTimeSlot {
  time: string;
  count: number;
}

/** Soma as reservas não canceladas de cada horário marcado no período e devolve os mais pedidos. */
export function buildPopularTimeSlots(counts: Record<string, number>, limit = 5): PopularTimeSlot[] {
  const byTime = new Map<string, number>();
  for (const [key, count] of Object.entries(counts)) {
    // Chave do mapa de calor: "<dia da semana>_<HH:mm>".
    const time = key.slice(key.indexOf('_') + 1);
    if (!time) continue;
    byTime.set(time, (byTime.get(time) ?? 0) + count);
  }

  return [...byTime.entries()]
    .map(([time, count]) => ({ time, count }))
    .filter((slot) => slot.count > 0)
    .sort((left, right) => right.count - left.count || left.time.localeCompare(right.time))
    .slice(0, limit);
}
