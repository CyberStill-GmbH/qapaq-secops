export interface OwnedResource {
  readonly id: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly remove: () => Promise<void>;
}

export async function safeCleanup(
  resources: readonly OwnedResource[],
  runId: string,
): Promise<string[]> {
  const remaining: string[] = [];
  for (const resource of resources) {
    if (
      resource.labels['qapaq.test'] !== 'true' ||
      resource.labels['qapaq.test.run-id'] !== runId
    ) {
      remaining.push(resource.id);
      continue;
    }
    try {
      await resource.remove();
    } catch {
      remaining.push(resource.id);
    }
  }
  return remaining;
}
