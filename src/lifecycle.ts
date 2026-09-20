export type Shutdown = () => Promise<void>;

export interface StdioEventSource {
  once(event: "end" | "close", listener: () => void): unknown;
}

export function createShutdown(closers: Array<() => Promise<void>>): Shutdown {
  let pending: Promise<void> | undefined;
  return () => {
    pending ??= (async () => {
      const results = await Promise.allSettled(closers.map((close) => close()));
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map(({ reason }) => reason);
      if (failures.length > 0) throw new AggregateError(failures, "Shutdown failed");
    })();
    return pending;
  };
}

export function installStdioLifecycle(
  shutdown: Shutdown,
  input: StdioEventSource = process.stdin,
): void {
  const close = () => void shutdown().catch(() => undefined);
  input.once("end", close);
  input.once("close", close);
}
