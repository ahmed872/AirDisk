import { parentPort, workerData } from 'node:worker_threads';
import type { BackendJob } from '../backup/backup-service';
import { executeJob } from './job-runner';

/**
 * Entry point of the backup/integrity worker thread. Bundled as its own file
 * (apps/desktop: out/main/backup-worker.js). It receives one job, runs it with
 * its own SQLite connection and posts one reply; the key (if any) arrives in
 * the job and is never logged.
 */
parentPort?.postMessage(executeJob(workerData as BackendJob));
