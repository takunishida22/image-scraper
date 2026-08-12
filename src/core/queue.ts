import pLimit from "p-limit";

export interface QueueOptions {
  concurrency: number;
}

export async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const limit = pLimit(Math.max(1, concurrency));
  return Promise.all(items.map((item, index) => limit(() => worker(item, index))));
}

export function createLimiter(concurrency: number) {
  return pLimit(Math.max(1, concurrency));
}
