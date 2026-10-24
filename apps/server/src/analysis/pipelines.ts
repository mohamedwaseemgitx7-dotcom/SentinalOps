import { now, type DB } from '../db.ts';
import { redact } from '../lib/errors.ts';
import type { EventBus } from '../lib/events.ts';
import { readCapped, type GitHubClient } from '../github/client.ts';
import type { IncidentService } from '../incidents.ts';
import { diagnoseLog, type Diagnosis } from './diagnose.ts';

interface GhRun {
  id: number;
  name: string | null;
  workflow_id: number;
  head_branch: string | null;
  head_sha: string;
  event: string;
  status: string;
  conclusion: string | null;
  run_number: number;
  run_attempt: number;
  html_url: string;
  created_at: string;
  run_started_at?: string;
  updated_at: string;
  actor?: { login: string };
  pull_requests?: { number: number }[];
  head_commit?: { message: string } | null;
}

interface GhJob {
  id: number;
  name: string;
  conclusion: string | null;
  steps?: { name: string; conclusion: string | null; number: number }[];
}

const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);

export class PipelineService {
  private db: DB;
  private gh: GitHubClient;
  private bus: EventBus;
  private incidents: IncidentService;

  constructor(db: DB, gh: GitHubClient, bus: EventBus, incidents: IncidentService) {
    this.db = db;
    this.gh = gh;
    this.bus = bus;
    this.incidents = incidents;
  }

  /** Pulls recent workflow runs (bounded) and diagnoses new failures. */
  async sync(repo: { id: number; full_name: string }, opts: { maxRuns?: number; diagnoseLimit?: number } = {}): Promise<{ runs: number; newFailures: number; diagnosed: number }> {
    const maxRuns = Math.min(opts.maxRuns ?? 100, 300);
    const runs: GhRun[] = [];
    for (let page = 1; runs.length < maxRuns && page <= 3; page++) {
      const body = await this.gh.json<{ workflow_runs: GhRun[] }>(`/repos/${repo.full_name}/actions/runs?per_page=100&page=${page}`);
      runs.push(...body.workflow_runs);
      if (body.workflow_runs.length < 100) break;
  }
    const known = new Map(
      (this.db.prepare('SELECT id, conclusion FROM workflow_runs WHERE repo_id = ?').all(repo.id) as { id: number; conclusion: string | null }[]).map((r) => [r.id, r.conclusion]),
    );
    const upsert = this.db.prepare(`
      INSERT INTO workflow_runs (id, repo_id, workflow_name, workflow_id, branch, head_sha, commit_message, event, status, conclusion, run_number, run_attempt, html_url, actor, pr_numbers, created_at, started_at, updated_at, duration_s)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, conclusion = excluded.conclusion, run_attempt = excluded.run_attempt,
        updated_at = excluded.updated_at, duration_s = excluded.duration_s`);
    let newFailures = 0;
    const toDiagnose: GhRun[] = [];
    for (const r of runs.slice(0, maxRuns)) {
      const started = r.run_started_at ?? r.created_at;
      const duration = r.status === 'completed' ? Math.max(0, Math.round((Date.parse(r.updated_at) - Date.parse(started)) / 1000)) : null;
      upsert.run(
        r.id, repo.id, r.name ?? `workflow ${r.workflow_id}`, r.workflow_id, r.head_branch, r.head_sha, r.head_commit?.message.split('\n')[0]?.slice(0, 200) ?? null,
        r.event, r.status, r.conclusion, r.run_number, r.run_attempt, r.html_url, r.actor?.login ?? null,
        JSON.stringify((r.pull_requests ?? []).map((p) => p.number)), r.created_at, started, r.updated_at, duration,
      );
      const isFailed = r.conclusion !== null && FAILED.has(r.conclusion);
      if (isFailed && known.get(r.id) !== r.conclusion) newFailures++;
      if (isFailed && !this.db.prepare('SELECT 1 FROM run_diagnoses WHERE run_id = ?').get(r.id)) toDiagnose.push(r);
    }

    let diagnosed = 0;
    // Newest failures first; bounded so a large backlog does not exhaust the API quota.
    for (const r of toDiagnose.sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, opts.diagnoseLimit ?? 10)) {
      try {
        await this.diagnoseRun(repo, r.id);
        diagnosed++;
      } catch (err) {
        this.bus.publish('pipeline.diagnosis_failed', 'warning', `Could not diagnose run ${r.id}: ${(err as Error).message.slice(0, 160)}`);
      }
    }
    this.verifyFixes(repo.id);
    this.syncPipelineIncidents(repo);
    if (newFailures) this.bus.publish('pipeline.failures', 'warning', `${newFailures} new failed workflow run(s) in ${repo.full_name}`, `/pipelines?repo=${repo.id}`);
    this.bus.publish('pipeline.synced', 'info', `Synced ${runs.length} workflow runs from ${repo.full_name}`, `/pipelines?repo=${repo.id}`);
    this.bus.invalidate('pipelines');
    return { runs: runs.length, newFailures, diagnosed };
  }

  async diagnoseRun(repo: { id: number; full_name: string }, runId: number): Promise<Diagnosis & { jobName: string | null; failedStep: string | null }> {
    const jobs = await this.gh.json<{ jobs: GhJob[] }>(`/repos/${repo.full_name}/actions/runs/${runId}/jobs?filter=latest&per_page=100`);
    const failedJob = jobs.jobs.find((j) => j.conclusion && FAILED.has(j.conclusion)) ?? jobs.jobs.find((j) => j.conclusion === 'cancelled') ?? null;
    const failedStep = failedJob?.steps?.find((s) => s.conclusion === 'failure')?.name ?? null;

    let diagnosis: Diagnosis;
    let logAvailable = false;
    if (failedJob) {
      const res = await this.gh.request(`/repos/${repo.full_name}/actions/jobs/${failedJob.id}/logs`);
      if (res.ok) {
        logAvailable = true;
        const log = await readCapped(res, 3 * 1024 * 1024);
        diagnosis = diagnoseLog(redact(log), failedStep);
      } else {
        await res.body?.cancel();
        diagnosis = {
          category: 'unknown', confidence: 'low',
          summary: `Job "${failedJob.name}" failed at step "${failedStep ?? 'unknown'}". Logs are unavailable (HTTP ${res.status}) — they may have expired or the token lacks actions:read.`,
          recommendation: 'Open the run on GitHub to read the log, or re-run with a token that has actions:read permission.',
          evidence: [], primaryLine: null, file: null,
        };
      }
    } else {
      diagnosis = {
        category: 'unknown', confidence: 'low',
        summary: 'The run failed before any job reported a failed conclusion (startup failure or invalid workflow).',
        recommendation: 'Check the workflow file for YAML or expression errors (the Security tab runs workflow checks) and the run annotations on GitHub.',
        evidence: [], primaryLine: null, file: null,
      };
    }
    this.db.prepare(`
      INSERT INTO run_diagnoses (run_id, job_id, job_name, failed_step, category, confidence, summary, evidence, recommendation, log_available, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET job_id = excluded.job_id, job_name = excluded.job_name, failed_step = excluded.failed_step, category = excluded.category,
        confidence = excluded.confidence, summary = excluded.summary, evidence = excluded.evidence, recommendation = excluded.recommendation,
        log_available = excluded.log_available, created_at = excluded.created_at`).run(
      runId, failedJob?.id ?? null, failedJob?.name ?? null, failedStep, diagnosis.category, diagnosis.confidence, diagnosis.summary,
      JSON.stringify({ lines: diagnosis.evidence, primaryLine: diagnosis.primaryLine, file: diagnosis.file }), diagnosis.recommendation, logAvailable ? 1 : 0, now(),
    );
    return { ...diagnosis, jobName: failedJob?.name ?? null, failedStep };
  }

  /**
   * A diagnosis counts as verified only when a later run of the same workflow on the same
   * branch completed successfully — code changes alone are never treated as a fix.
   */
  verifyFixes(repoId: number): number {
    const pending = this.db.prepare(`
      SELECT d.run_id, r.workflow_id, r.branch, r.created_at FROM run_diagnoses d JOIN workflow_runs r ON r.id = d.run_id
      WHERE r.repo_id = ? AND d.verified_by_run_id IS NULL`).all(repoId) as { run_id: number; workflow_id: number; branch: string; created_at: string }[];
    let verified = 0;
    for (const p of pending) {
      const ok = this.db.prepare(`
        SELECT id, updated_at FROM workflow_runs WHERE repo_id = ? AND workflow_id = ? AND branch IS ? AND created_at > ? AND conclusion = 'success'
        ORDER BY created_at ASC LIMIT 1`).get(repoId, p.workflow_id, p.branch, p.created_at) as { id: number; updated_at: string } | undefined;
      if (ok) {
        this.db.prepare('UPDATE run_diagnoses SET verified_by_run_id = ?, verified_at = ? WHERE run_id = ?').run(ok.id, ok.updated_at, p.run_id);
        verified++;
      }
    }
    return verified;
  }

  /** One incident per (workflow, branch) whose latest completed run on the default branch failed. */
  private syncPipelineIncidents(repo: { id: number; full_name: string }): void {
    const branch = (this.db.prepare('SELECT default_branch FROM repositories WHERE id = ?').get(repo.id) as { default_branch: string | null } | undefined)?.default_branch;
    if (!branch) return;
    const latest = this.db.prepare(`
      SELECT r.workflow_id, r.workflow_name, r.conclusion, r.id, r.created_at FROM workflow_runs r
      JOIN (SELECT workflow_id, MAX(created_at) AS m FROM workflow_runs WHERE repo_id = ? AND branch = ? AND status = 'completed' GROUP BY workflow_id) l
        ON l.workflow_id = r.workflow_id AND l.m = r.created_at
      WHERE r.repo_id = ? AND r.branch = ?`).all(repo.id, branch, repo.id, branch) as { workflow_id: number; workflow_name: string; conclusion: string; id: number; created_at: string }[];
    for (const w of latest) {
      const ref = `repo:${repo.id}:workflow:${w.workflow_id}:${branch}`;
      if (FAILED.has(w.conclusion)) {
        // Incident start = first failure in the current failing streak.
        const lastSuccess = this.db.prepare("SELECT MAX(created_at) AS t FROM workflow_runs WHERE repo_id = ? AND workflow_id = ? AND branch = ? AND conclusion = 'success'").get(repo.id, w.workflow_id, branch) as { t: string | null };
        const firstFail = this.db.prepare("SELECT MIN(created_at) AS t FROM workflow_runs WHERE repo_id = ? AND workflow_id = ? AND branch = ? AND conclusion IN ('failure','timed_out','startup_failure') AND created_at > ?").get(repo.id, w.workflow_id, branch, lastSuccess.t ?? '') as { t: string | null };
        this.incidents.open({ source: 'pipeline', ref, title: `${w.workflow_name} is failing on ${branch} (${repo.full_name})`, severity: 'high', repoId: repo.id, startedAt: firstFail.t ?? w.created_at });
      } else if (w.conclusion === 'success') {
        this.incidents.resolveByRef('pipeline', ref, `Run ${w.id} on ${branch} succeeded`);
      }
    }
  }
}
