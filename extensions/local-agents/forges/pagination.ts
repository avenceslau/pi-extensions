const PAGE_ITEMS = 100;
const MAX_PAGES = 50;

// Reads every page, so a review missing from the result is really not open. `path` already has a query string.
export async function listAllPages<T>(
  path: string,
  fetchPage: (pagePath: string) => Promise<T[]>,
): Promise<T[]> {
  const items: T[] = [];

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const batch = await fetchPage(
      `${path}&per_page=${PAGE_ITEMS}&page=${page}`,
    );

    items.push(...batch);

    if (batch.length < PAGE_ITEMS) {
      return items;
    }
  }

  throw new Error(`${path} has more than ${MAX_PAGES} pages`);
}
