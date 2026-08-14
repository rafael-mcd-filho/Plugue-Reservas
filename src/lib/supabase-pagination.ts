const SUPABASE_PAGE_SIZE = 1000;

interface SupabasePageResult<T> {
  data: T[] | null;
  error: unknown;
}

export async function fetchAllSupabasePages<T>(
  getPage: (from: number, to: number) => PromiseLike<SupabasePageResult<T>>,
) {
  const rows: T[] = [];

  for (let from = 0; ;) {
    const to = from + SUPABASE_PAGE_SIZE - 1;
    const { data, error } = await getPage(from, to);

    if (error) {
      throw error;
    }

    const page = data ?? [];
    if (page.length === 0) {
      break;
    }

    rows.push(...page);
    // Avanca pelo total efetivamente entregue. Assim a paginacao continua
    // correta mesmo quando o PostgREST usa um limite menor que o solicitado.
    from += page.length;
  }

  return rows;
}
