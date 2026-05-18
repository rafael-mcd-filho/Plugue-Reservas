const SUPABASE_PAGE_SIZE = 1000;

interface SupabasePageResult<T> {
  data: T[] | null;
  error: unknown;
}

export async function fetchAllSupabasePages<T>(
  getPage: (from: number, to: number) => PromiseLike<SupabasePageResult<T>>,
) {
  const rows: T[] = [];

  for (let from = 0; ; from += SUPABASE_PAGE_SIZE) {
    const to = from + SUPABASE_PAGE_SIZE - 1;
    const { data, error } = await getPage(from, to);

    if (error) {
      throw error;
    }

    const page = data ?? [];
    rows.push(...page);

    if (page.length < SUPABASE_PAGE_SIZE) {
      break;
    }
  }

  return rows;
}
