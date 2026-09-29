import { Worker } from 'node:worker_threads';
import { DomainError, ErrorCode, isDomainError } from '@airdesk/domain';
import { runBackendJob, type BackendJob } from '../backup/backup-service';
import type { Logger } from '../util/logger';

/** What travels back from the worker thread (plain data only). */
export type JobReply = { ok: true; result: unknown } | { ok: false; error: { code?: string; message: string; details?: Record<string, unknown> } };

/** Executes a job and turns any failure into a serialisable reply (used inside the worker). */
export function executeJob(job: BackendJob): JobReply {
  try {
    return { ok: true, result: runBackendJob(job) };
  } catch (e) {
    if (isDomainError(e)) return { ok: false, error: { code: e.code, message: e.message, ...(e.details ? { details: { ...e.details } } : {}) } };
    return { ok: false, error: { message: (e as Error)?.message ?? String(e) } };
  }
}

function fromReply(reply: JobReply): unknown {
  if (reply.ok) return reply.result;
  const { code, message, details } = reply.error;
  if (code) throw new DomainError(code as ErrorCode, message, details);
  throw new Error(message);
}

/**
 * Runs heavy backup/restore/integrity work (SQLite checks, compression,
 * hashing, key derivation) on a worker thread with its own SQLite connection,
 * so the Electron main process — and with it every open window — stays
 * responsive. Without a worker script (unit tests) the job runs in-process.
 * If the worker fails without answering (cannot start, crashed), the job is
 * run again in-process — slower but still safe, every job cleans up after
 * itself — and the fallback is logged (the packaged smoke test asserts that
 * jobs really ran on the worker).
 */
export class JobRunner {
  private jobsInProcess = 0;
  private jobsInWorker = 0;

  constructor(
    private readonly workerPath: string | null,
    private readonly logger?: Logger,
  ) {}

  get stats(): { inWorker: number; inProcess: number; workerConfigured: boolean } {
    return { inWorker: this.jobsInWorker, inProcess: this.jobsInProcess, workerConfigured: !!this.workerPath };
  }

  async run<T>(job: BackendJob): Promise<T> {
    if (!this.workerPath) return this.inProcess<T>(job);
    let reply: JobReply;
    try {
      reply = await new Promise<JobReply>((resolve, reject) => {
        const worker = new Worker(this.workerPath!, { workerData: job });
        let settled = false;
        worker.once('message', (m: JobReply) => { settled = true; resolve(m); });
        worker.once('error', (e) => { if (!settled) { settled = true; reject(e); } });
        worker.once('exit', (code) => { if (!settled) { settled = true; reject(new Error(`worker exited with code ${code}`)); } });
      });
    } catch (e) {
      this.logger?.error('Background worker failed; running the job in-process', { job: job.type, error: (e as Error).message });
      return this.inProcess<T>(job);
    }
    this.jobsInWorker++;
    return fromReply(reply) as T;
  }

  private async inProcess<T>(job: BackendJob): Promise<T> {
    this.jobsInProcess++;
    return fromReply(executeJob(job)) as T;
  }
}
