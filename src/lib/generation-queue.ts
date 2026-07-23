/**
 * Serialises async jobs and lets a panic wipe invalidate anything already
 * in flight (#70). Callers check `stillValid` after every await before writing
 * durable secrets; `invalidate()` + `drain()` before erase so a late write
 * cannot land after the wipe commits.
 */
export class GenerationQueue {
  private generation = 0;
  private tail: Promise<void> = Promise.resolve();

  /** Bump so in-flight and queued jobs see `stillValid() === false`. */
  invalidate(): void {
    this.generation += 1;
  }

  /**
   * Run `task` after prior jobs. `stillValid` is true only while this job's
   * generation is still current — check it before every durable write.
   */
  async run(task: (stillValid: () => boolean) => Promise<void>): Promise<void> {
    const gen = this.generation;
    const stillValid = () => this.generation === gen;
    const next = this.tail.then(
      () => (stillValid() ? task(stillValid) : undefined),
      () => (stillValid() ? task(stillValid) : undefined),
    );
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    await next;
  }

  /** Wait until every job started before this call has settled. */
  async drain(): Promise<void> {
    await this.tail;
  }
}
