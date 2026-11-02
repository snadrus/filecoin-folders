/** One active download. Cancel applies to queued jobs only. */

export interface DownloadJob {
  id: string;
  name: string;
  cid?: string;
  deletionScheduled?: boolean;
  run: (stage: (label: string) => void) => Promise<void>;
}

export interface ActiveDownload {
  id: string;
  name: string;
  stage: string;
}

export class DownloadQueue {
  active: ActiveDownload | null = null;
  pending: { id: string; name: string }[] = [];
  finished: string[] = [];
  error: string | null = null;
  scope: string | undefined;
  onChange: () => void = () => undefined;

  #jobs: DownloadJob[] = [];
  #running = false;
  #generation = 0;
  #done: Promise<void> = Promise.resolve();

  get idle(): Promise<void> {
    return this.#done;
  }

  setScope(scope: string | undefined): void {
    this.scope = scope;
    this.pending = [];
    this.finished = [];
    this.#jobs = [];
    this.error = null;
    this.#generation += 1;
    this.onChange();
  }

  enqueue(job: DownloadJob): void {
    if (!this.scope || !job.cid || job.deletionScheduled) return;
    if (this.active?.id === job.id || this.pending.some((item) => item.id === job.id)) return;
    this.#jobs.push(job);
    this.pending.push({ id: job.id, name: job.name });
    this.error = null;
    this.onChange();
    if (!this.#running) this.#done = this.#pump();
  }

  cancel(id: string): void {
    if (this.active?.id === id) return;
    this.#jobs = this.#jobs.filter((job) => job.id !== id);
    this.pending = this.pending.filter((item) => item.id !== id);
    this.onChange();
  }

  async #pump(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    const generation = this.#generation;
    try {
      while (this.#jobs.length && generation === this.#generation) {
        const job = this.#jobs.shift();
        if (!job) break;
        this.pending = this.pending.filter((item) => item.id !== job.id);
        this.active = { id: job.id, name: job.name, stage: "Downloading from storage provider" };
        this.onChange();
        let ok = true;
        try {
          await job.run((stage) => {
            if (this.active?.id === job.id) {
              this.active = { ...this.active, stage };
              this.onChange();
            }
          });
        } catch (cause) {
          ok = false;
          if (generation === this.#generation) {
            console.error("FiFolders download", cause);
            this.error = `${job.name}: ${cause instanceof Error ? cause.message : "Unable to download the file"}`;
          }
        } finally {
          if (ok && generation === this.#generation) this.finished = [...this.finished, job.name].slice(-3);
          if (this.active?.id === job.id) this.active = null;
          this.onChange();
        }
      }
    } finally {
      this.#running = false;
    }
  }
}
