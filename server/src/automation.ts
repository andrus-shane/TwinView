/**
 * Bridge to the TabletAutoTest automation repo.
 *
 * TwinView shows the twin; TabletAutoTest owns the real test workflows
 * (rail-tap setpoints, sensor-verified tracking, reports). This bridge lets
 * the per-bay Test Control panel list those workflows and launch one against
 * the bay's assigned tablet console via `tools/headless_runner.py` — the same
 * shim the Go MCP server uses, chosen because it needs no backend services
 * and ends every command with a machine-parseable `RESULT_JSON:` line.
 *
 * Runs are spawned DETACHED with their output redirected to a log file, so a
 * TwinView server restart never kills an in-flight run (killing the runner
 * mid-workflow would skip the wrap-up phase that stops the belt). The cost:
 * after a restart the bridge no longer knows about the old run — status
 * resets to idle while the run itself finishes unharmed on its own.
 */

import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface AutomationConfig {
  repo?: string;
  python?: string;
}

export interface AutomationWorkflow {
  id: string;
  name: string;
  summary?: string;
  category?: string;
}

export interface AutomationRun {
  workflowId: string;
  serial: string;
  unitId: string;
  startedAt: number;
  endedAt?: number;
  status: 'running' | 'passed' | 'failed' | 'error';
  exitCode?: number;
  logPath: string;
  /** The runner's RESULT_JSON payload, when one was emitted */
  result?: unknown;
}

const LIST_TIMEOUT_MS = 90_000; // first import of tablet_automation takes seconds
const RESULT_MARKER = 'RESULT_JSON: ';

/** Last RESULT_JSON payload in a runner log, or undefined. */
function parseResultMarker(text: string): unknown {
  const idx = text.lastIndexOf(RESULT_MARKER);
  if (idx < 0) return undefined;
  const line = text.slice(idx + RESULT_MARKER.length, text.indexOf('\n', idx) + 1 || undefined);
  try {
    return JSON.parse(line.trim());
  } catch {
    return undefined;
  }
}

export class AutomationBridge {
  private repo: string | null;
  private python: string;
  private workflows: AutomationWorkflow[] | null = null;
  private listing: Promise<AutomationWorkflow[]> | null = null;
  /** Current-or-last run per unit id */
  private runs = new Map<string, AutomationRun>();

  constructor(
    cfg: AutomationConfig | undefined,
    twinRoot: string,
    private logDir: string,
    /** This TwinView server's own base URL — handed to runs (TWINVIEW_URL)
     * so the matrix step can mirror its live targets into the twin's
     * expected traces. Empty string disables the hand-off. */
    private baseUrl: string = '',
  ) {
    const candidate = resolve(twinRoot, cfg?.repo ?? join('..', 'TabletAutoTest'));
    this.repo = existsSync(join(candidate, 'tools', 'headless_runner.py')) ? candidate : null;
    const venvPython = this.repo ? join(this.repo, '.venv', 'Scripts', 'python.exe') : '';
    this.python = cfg?.python ?? (venvPython && existsSync(venvPython) ? venvPython : 'python');
  }

  available(): boolean {
    return this.repo !== null;
  }

  repoPath(): string | null {
    return this.repo;
  }

  /** Workflow catalog via `headless_runner.py list-workflows`, cached for the process. */
  async listWorkflows(): Promise<AutomationWorkflow[]> {
    if (this.workflows) return this.workflows;
    if (!this.repo) throw new Error('TabletAutoTest repo not found');
    this.listing ??= this.spawnList().then(
      (wfs) => {
        this.workflows = wfs;
        this.listing = null;
        return wfs;
      },
      (err) => {
        this.listing = null;
        throw err;
      },
    );
    return this.listing;
  }

  private spawnList(): Promise<AutomationWorkflow[]> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(this.python, [join('tools', 'headless_runner.py'), 'list-workflows'], {
        cwd: this.repo!,
        env: { ...process.env, TABLET_REPO: this.repo! },
        windowsHide: true,
      });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', () => {}); // runner logs to stderr; irrelevant here
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`list-workflows timed out after ${LIST_TIMEOUT_MS / 1000}s`));
      }, LIST_TIMEOUT_MS);
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        const payload = parseResultMarker(out) as { workflows?: unknown[] } | undefined;
        if (code !== 0 || !payload?.workflows) {
          reject(new Error(`list-workflows failed (exit ${code})`));
          return;
        }
        // The runner emits an array of workflow-id strings today; tolerate a
        // future richer object shape too.
        const all = payload.workflows
          .map((w): AutomationWorkflow => {
            if (typeof w === 'string') return { id: w, name: w };
            const wf = w as Record<string, unknown>;
            return {
              id: String(wf.id ?? ''),
              name: String(wf.name ?? wf.id ?? ''),
              summary: typeof wf.summary === 'string' ? wf.summary : undefined,
              category: typeof wf.category === 'string' ? wf.category : undefined,
            };
          })
          .filter((w) => w.id);
        // The Test Control panel wants runnable test workflows, not every
        // building block — but fall back to the full list rather than none.
        const tests = all.filter((w) => w.category === 'test' || w.id.startsWith('test.'));
        resolvePromise((tests.length ? tests : all).sort((a, b) => a.id.localeCompare(b.id)));
      });
    });
  }

  status(unitId: string): AutomationRun | null {
    return this.runs.get(unitId) ?? null;
  }

  /** Launch a workflow for a unit; one at a time per unit. */
  run(unitId: string, workflowId: string, serial: string): AutomationRun | { error: string } {
    if (!this.repo) return { error: 'TabletAutoTest repo not found' };
    if (!workflowId) return { error: 'workflowId is required' };
    const existing = this.runs.get(unitId);
    if (existing?.status === 'running') {
      return { error: `a run is already active on this unit (${existing.workflowId})` };
    }

    mkdirSync(this.logDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logPath = join(this.logDir, `${unitId}_${workflowId.replace(/[^\w.-]/g, '_')}_${stamp}.log`);
    const logFd = openSync(logPath, 'a');

    const run: AutomationRun = {
      workflowId,
      serial,
      unitId,
      startedAt: Date.now(),
      status: 'running',
      logPath,
    };
    try {
      const child = spawn(
        this.python,
        [join('tools', 'headless_runner.py'), 'workflow', workflowId, serial],
        {
          cwd: this.repo,
          env: {
            ...process.env,
            TABLET_REPO: this.repo,
            // the matrix step pushes its live expected speed/incline back
            // to this unit's twin (best-effort; see treadmill.py)
            ...(this.baseUrl ? { TWINVIEW_URL: this.baseUrl, TWINVIEW_UNIT: unitId } : {}),
          },
          windowsHide: true,
          detached: true, // survives a TwinView restart — never orphan a moving belt
          stdio: ['ignore', logFd, logFd],
        },
      );
      child.on('exit', (code) => {
        run.endedAt = Date.now();
        run.exitCode = code ?? -1;
        run.status = code === 0 ? 'passed' : code === 1 ? 'failed' : 'error';
        try {
          run.result = parseResultMarker(readFileSync(logPath, 'utf-8'));
        } catch {
          /* log unreadable — keep exit-code status */
        }
      });
      child.on('error', (err) => {
        run.endedAt = Date.now();
        run.status = 'error';
        run.result = { error: String(err) };
      });
      child.unref();
    } finally {
      closeSync(logFd); // the child holds its own handle once spawned
    }
    this.runs.set(unitId, run);
    return run;
  }
}
