import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * AutomationBridge — launches TabletAutoTest workflow runs against a bay's
 * tablet console and tracks their outcome.
 *
 * Runs are spawned DETACHED (own process group, stdio to a log file, unref) so
 * a TwinView restart never kills an in-flight run: the tablet keeps driving
 * the physical machine no matter what this server does. The flip side is that
 * a restarted server must re-adopt runs it didn't spawn — so every active run
 * is persisted to active-runs.json in the logs dir at spawn time, reloaded on
 * construction (pid liveness via `process.kill(pid, 0)`), and liveness-polled
 * every few seconds after that. A re-adopted child was reparented to init when
 * its original parent died, so its exit code is unobservable — the outcome of
 * an adopted run comes exclusively from the `RESULT_JSON: ` trailer the runner
 * prints as its final log line.
 */

export type RunStatus = 'running' | 'passed' | 'failed' | 'error';

/** What survives a server restart — everything needed to re-adopt a live run. */
interface ActiveRunRecord {
  unitId: string;
  workflowId: string;
  serial: string;
  pid: number;
  logPath: string;
  /** Unix ms */
  startedAt: number;
}

export interface AutomationRun extends ActiveRunRecord {
  status: RunStatus;
  /**
   * null while running — and forever for re-adopted runs: a child spawned by a
   * previous server instance is no longer our child, so its exit code is
   * unobservable. Adopted outcomes are derived from the RESULT_JSON trailer alone.
   */
  exitCode: number | null;
  /** true when this run was reloaded from active-runs.json after a restart */
  adopted: boolean;
  endedAt: number | null;
  /** Parsed RESULT_JSON payload from the log trailer (null: none found) */
  result: Record<string, unknown> | null;
}

export type RunPhase = 'started' | 'adopted' | 'finished';

export interface AutomationBridgeOptions {
  /** Where per-run logs and active-runs.json live */
  logsDir: string;
  /**
   * argv template for one workflow run; `{workflowId}` and `{serial}` are
   * substituted. Override via config.json `automation.command` if the
   * TabletAutoTest runner entrypoint differs from the default below.
   */
  command?: string[];
  /** Working directory for the runner (the TabletAutoTest checkout) */
  cwd?: string;
  onEvent?: (run: AutomationRun, phase: RunPhase) => void;
}

const ACTIVE_RUNS_FILE = 'active-runs.json';
const LIVENESS_POLL_MS = 3000;
const DEFAULT_COMMAND = ['python', 'run_workflow.py', '--workflow', '{workflowId}', '--serial', '{serial}'];

function pidAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = alive but owned elsewhere (shouldn't happen for runs we spawned)
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The runner prints `RESULT_JSON: {...}` as its final log line — scan backwards for the last one. */
function readResultJson(logPath: string): Record<string, unknown> | null {
  let text: string;
  try {
    text = readFileSync(logPath, 'utf-8');
  } catch {
    return null;
  }
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('RESULT_JSON:')) continue;
    try {
      const parsed: unknown = JSON.parse(line.slice('RESULT_JSON:'.length).trim());
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null; // trailer exists but is mangled — treated as 'error' below
    }
  }
  return null;
}

function deriveStatus(result: Record<string, unknown> | null, exitCode: number | null): RunStatus {
  if (result) {
    if (result.passed === true) return 'passed';
    if (result.passed === false) return 'failed';
    const verdict = String(result.result ?? result.status ?? '').toLowerCase();
    if (verdict === 'pass' || verdict === 'passed') return 'passed';
    if (verdict === 'fail' || verdict === 'failed') return 'failed';
  }
  // No usable trailer: the run died without reporting. A clean exit 0 from a
  // child we spawned ourselves still counts as passed; anything else —
  // including every re-adopted run, whose exit code is unobservable — is an error.
  return exitCode === 0 ? 'passed' : 'error';
}

export class AutomationBridge {
  /** Latest run per unit — the in-flight run, or the finished result until the next start */
  private byUnit = new Map<string, AutomationRun>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private opts: AutomationBridgeOptions) {
    mkdirSync(opts.logsDir, { recursive: true });
    this.adoptPersistedRuns();
    this.timer = setInterval(() => this.pollTick(), LIVENESS_POLL_MS);
    this.timer.unref();
  }

  /** Is an automation run currently driving this unit? Feeds the unattended-motion watchdog. */
  isRunning(unitId: string): boolean {
    return this.byUnit.get(unitId)?.status === 'running';
  }

  runFor(unitId: string): AutomationRun | undefined {
    const r = this.byUnit.get(unitId);
    return r ? { ...r } : undefined;
  }

  runs(): AutomationRun[] {
    return [...this.byUnit.values()].map((r) => ({ ...r }));
  }

  start(unitId: string, workflowId: string, serial: string): AutomationRun {
    const prev = this.byUnit.get(unitId);
    if (prev?.status === 'running') {
      throw new Error(`unit ${unitId} already has a run in flight (${prev.workflowId}, pid ${prev.pid})`);
    }
    const startedAt = Date.now();
    const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const logPath = join(this.opts.logsDir, `${stamp}-${unitId}-${workflowId}.log`);
    const argv = (this.opts.command ?? DEFAULT_COMMAND).map((a) =>
      a.replaceAll('{workflowId}', workflowId).replaceAll('{serial}', serial),
    );

    // Detached + own log fd + unref: the run must survive a TwinView restart.
    const fd = openSync(logPath, 'a');
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd: this.opts.cwd,
        detached: true,
        stdio: ['ignore', fd, fd],
      });
    } finally {
      closeSync(fd); // the child holds its own copy
    }
    child.unref();

    const run: AutomationRun = {
      unitId,
      workflowId,
      serial,
      pid: child.pid ?? -1,
      logPath,
      startedAt,
      status: 'running',
      exitCode: null,
      adopted: false,
      endedAt: null,
      result: null,
    };
    this.byUnit.set(unitId, run);
    this.persistActive();
    // Exit events only exist for children of THIS process; re-adopted runs
    // settle via the liveness poll instead. A failed spawn (e.g. runner not on
    // PATH) leaves an empty log → no RESULT_JSON → finalize lands on 'error'.
    child.on('error', () => this.finalize(run, null));
    child.on('exit', (code) => this.finalize(run, code));
    this.opts.onEvent?.(run, 'started');
    return run;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // Deliberately no child kill: runs are detached and must outlive the server.
  }

  /** Restart recovery: reload persisted runs, keep the live ones as status=running, settle the dead. */
  private adoptPersistedRuns(): void {
    for (const rec of this.loadActiveFile()) {
      const run: AutomationRun = {
        ...rec,
        status: 'running',
        exitCode: null,
        adopted: true,
        endedAt: null,
        result: null,
      };
      this.byUnit.set(rec.unitId, run);
      if (pidAlive(rec.pid)) this.opts.onEvent?.(run, 'adopted');
      else this.finalize(run, null); // died while TwinView was down — settle from the log now
    }
    this.persistActive(); // rewrites the file without the entries we just settled
  }

  /**
   * Liveness poll — the only completion signal for re-adopted runs (no child
   * handle, no exit event). Doubles as a backstop for runs we spawned ourselves.
   */
  private pollTick(): void {
    for (const run of this.byUnit.values()) {
      if (run.status === 'running' && !pidAlive(run.pid)) this.finalize(run, null);
    }
  }

  /**
   * Settle a finished run. `exitCode` is null when unobservable (adopted runs,
   * liveness-poll detection) — the outcome then rests entirely on the
   * RESULT_JSON trailer; a missing or unparseable trailer is an 'error', never a guess.
   */
  private finalize(run: AutomationRun, exitCode: number | null): void {
    if (run.status !== 'running') return; // exit event and liveness poll can race
    run.exitCode = exitCode;
    run.endedAt = Date.now();
    run.result = readResultJson(run.logPath);
    run.status = deriveStatus(run.result, exitCode);
    this.persistActive(); // drop it from the survives-restart set
    this.opts.onEvent?.(run, 'finished');
  }

  private loadActiveFile(): ActiveRunRecord[] {
    const path = join(this.opts.logsDir, ACTIVE_RUNS_FILE);
    if (!existsSync(path)) return [];
    try {
      const data: unknown = JSON.parse(readFileSync(path, 'utf-8'));
      if (!Array.isArray(data)) return [];
      return data.filter(
        (r): r is ActiveRunRecord =>
          typeof r?.unitId === 'string' &&
          typeof r?.workflowId === 'string' &&
          typeof r?.serial === 'string' &&
          typeof r?.pid === 'number' &&
          typeof r?.logPath === 'string' &&
          typeof r?.startedAt === 'number',
      );
    } catch {
      return []; // corrupt file: nothing to adopt; it gets rewritten on the next change
    }
  }

  /** Rewrite active-runs.json to exactly the currently running set. */
  private persistActive(): void {
    const active = [...this.byUnit.values()]
      .filter((r) => r.status === 'running')
      .map(({ unitId, workflowId, serial, pid, logPath, startedAt }) => ({
        unitId,
        workflowId,
        serial,
        pid,
        logPath,
        startedAt,
      }));
    writeFileSync(join(this.opts.logsDir, ACTIVE_RUNS_FILE), JSON.stringify(active, null, 2));
  }
}
