export async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  mapItem: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;

  const worker = async () => {
    while (next < items.length) {
      const index = next;

      next += 1;
      results[index] = await mapItem(items[index]);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );

  return results;
}

export const API_CONCURRENCY = 8;
