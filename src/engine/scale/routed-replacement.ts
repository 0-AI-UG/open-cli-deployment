/** A redundant service must keep a serving sibling while its replacement is
 * absent or unready. Ingress failures must stop teardown, never be ignored. */
export async function replaceRoutedReplica<T>(options: {
  redundant: boolean;
  removeFromIngress: () => Promise<void>;
  drain: () => Promise<unknown>;
  replace: () => Promise<T>;
  verifyReady: () => Promise<void>;
  admitToIngress: () => Promise<void>;
}): Promise<T> {
  if (!options.redundant) return options.replace();
  await options.removeFromIngress();
  await options.drain();
  const result = await options.replace();
  await options.verifyReady();
  await options.admitToIngress();
  return result;
}
