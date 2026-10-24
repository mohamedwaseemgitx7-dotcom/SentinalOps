import path from 'node:path';
import type { Finding, Severity } from './rules.ts';
import type { RepoSource } from './source.ts';

export interface Dependency {
  ecosystem: 'npm' | 'PyPI' | 'Go';
  name: string;
  version: string;
  manifest: string;
  direct: boolean;
}

const MAX_DEPS = 3000;

export async function extractDependencies(src: RepoSource): Promise<{ deps: Dependency[]; unresolved: string[] }> {
  const deps: Dependency[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();
  const add = (d: Dependency) => {
    const k = `${d.ecosystem}|${d.name}|${d.version}`;
    if (seen.has(k) || deps.length >= MAX_DEPS) return;
    seen.add(k);
    deps.push(d);
  };

  for (const file of src.files) {
    const base = path.posix.basename(file).toLowerCase();
    if (base === 'package-lock.json') {
      const text = await src.read(file);
      if (!text) {
        unresolved.push(`${file} (too large or unreadable)`);
        continue;
      }
      try {
        const lock = JSON.parse(text) as {
          packages?: Record<string, { version?: string; dev?: boolean; link?: boolean }>;
          dependencies?: Record<string, { version?: string }>;
        };
        const rootPkg = lock.packages?.[''] as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | undefined;
        const directNames = new Set([...Object.keys(rootPkg?.dependencies ?? {}), ...Object.keys(rootPkg?.devDependencies ?? {})]);
        if (lock.packages) {
          for (const [key, meta] of Object.entries(lock.packages)) {
            if (!key || meta.link || !meta.version) continue;
            const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
            add({ ecosystem: 'npm', name, version: meta.version, manifest: file, direct: directNames.has(name) && key === `node_modules/${name}` });
          }
        } else if (lock.dependencies) {
          for (const [name, meta] of Object.entries(lock.dependencies)) if (meta.version) add({ ecosystem: 'npm', name, version: meta.version, manifest: file, direct: true });
        }
      } catch {
        unresolved.push(`${file} (invalid JSON)`);
      }
    } else if (base === 'package.json' && !src.files.some((f) => path.posix.dirname(f) === path.posix.dirname(file) && /(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(f))) {
      // Without a lockfile only exact pins can be checked.
      const text = await src.read(file);
      try {
        const pkg = JSON.parse(text ?? '{}') as { dependencies?: Record<string, string> };
        for (const [name, spec] of Object.entries(pkg.dependencies ?? {})) {
          if (/^\d+\.\d+\.\d+$/.test(spec)) add({ ecosystem: 'npm', name, version: spec, manifest: file, direct: true });
          else unresolved.push(`${name}@${spec} in ${file} (range, no lockfile)`);
        }
      } catch {
        /* reported elsewhere */
      }
    } else if (base === 'requirements.txt' || /requirements[-\w]*\.txt$/.test(base)) {
      const text = (await src.read(file)) ?? '';
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.split('#')[0]!.trim();
        if (!line || line.startsWith('-')) continue;
        const m = line.match(/^([A-Za-z0-9._-]+)(?:\[[^\]]*\])?\s*==\s*([A-Za-z0-9.+!-]+)/);
        if (m) add({ ecosystem: 'PyPI', name: m[1]!.toLowerCase(), version: m[2]!, manifest: file, direct: true });
        else unresolved.push(`${line} in ${file} (not pinned with ==)`);
      }
    } else if (base === 'go.mod') {
      const text = (await src.read(file)) ?? '';
      for (const m of text.matchAll(/^\s*(?:require\s+)?([a-z0-9.-]+\.[a-z]{2,}\/[^\s]+)\s+(v[0-9][^\s]*)/gm)) {
        add({ ecosystem: 'Go', name: m[1]!, version: m[2]!, manifest: file, direct: !m[0].includes('// indirect') });
      }
    }
  }
  return { deps, unresolved: unresolved.slice(0, 50) };
}

interface OsvVuln {
  id: string;
  summary?: string;
  details?: string;
  aliases?: string[];
  database_specific?: { severity?: string };
  severity?: { type: string; score: string }[];
  affected?: { package?: { name: string; ecosystem: string }; ranges?: { events?: { fixed?: string }[] }[] }[];
  references?: { type: string; url: string }[];
}

function mapSeverity(v: OsvVuln): { severity: Severity; known: boolean } {
  const s = v.database_specific?.severity?.toUpperCase();
  if (s === 'CRITICAL') return { severity: 'critical', known: true };
  if (s === 'HIGH') return { severity: 'high', known: true };
  if (s === 'MODERATE' || s === 'MEDIUM') return { severity: 'medium', known: true };
  if (s === 'LOW') return { severity: 'low', known: true };
  return { severity: 'medium', known: false };
}

/**
 * Queries the public OSV.dev database (Google-operated, free, no key). Only
 * ecosystem/package/version triples are sent — never source code.
 */
export async function osvFindings(deps: Dependency[]): Promise<{ findings: Finding[]; queried: number; vulnerable: number; error: string | null }> {
  if (deps.length === 0) return { findings: [], queried: 0, vulnerable: 0, error: null };
  const hits: { dep: Dependency; ids: string[] }[] = [];
  try {
    for (let i = 0; i < deps.length; i += 500) {
      const chunk = deps.slice(i, i + 500);
      const res = await fetch('https://api.osv.dev/v1/querybatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'SentinelOps/0.1' },
        body: JSON.stringify({ queries: chunk.map((d) => ({ package: { name: d.name, ecosystem: d.ecosystem }, version: d.version })) }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`OSV querybatch returned ${res.status}`);
      const body = (await res.json()) as { results: { vulns?: { id: string }[] }[] };
      body.results.forEach((r, idx) => {
        if (r.vulns?.length) hits.push({ dep: chunk[idx]!, ids: r.vulns.map((v) => v.id) });
      });
    }
  } catch (err) {
    return { findings: [], queried: deps.length, vulnerable: 0, error: (err as Error).message };
  }

  const uniqueIds = [...new Set(hits.flatMap((h) => h.ids))].slice(0, 80);
  const details = new Map<string, OsvVuln>();
  await Promise.all(
    uniqueIds.map(async (id) => {
      try {
        const res = await fetch(`https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(20_000) });
        if (res.ok) details.set(id, (await res.json()) as OsvVuln);
      } catch {
        /* keep the ID-only finding */
      }
    }),
  );

  const findings: Finding[] = [];
  for (const { dep, ids } of hits) {
    // OSV often returns both a GHSA and a PYSEC/GO entry for one issue — prefer GHSA, dedupe aliases.
    const seen = new Set<string>();
    for (const id of ids.sort((a, b) => Number(b.startsWith('GHSA')) - Number(a.startsWith('GHSA')))) {
      const v = details.get(id);
      if (seen.has(id) || v?.aliases?.some((a) => seen.has(a))) continue;
      seen.add(id);
      v?.aliases?.forEach((a) => seen.add(a));
      const { severity, known } = v ? mapSeverity(v) : { severity: 'medium' as Severity, known: false };
      const fixed = v?.affected
        ?.filter((a) => a.package?.name.toLowerCase() === dep.name.toLowerCase())
        .flatMap((a) => a.ranges ?? [])
        .flatMap((r) => r.events ?? [])
        .map((e) => e.fixed)
        .filter((x): x is string => !!x);
      const cve = v?.aliases?.find((a) => a.startsWith('CVE-'));
      findings.push({
        ruleId: id,
        source: 'osv.dev',
        severity,
        title: `${dep.name}@${dep.version}: ${v?.summary ?? id}`,
        file: dep.manifest,
        package: `${dep.ecosystem}:${dep.name}@${dep.version}`,
        evidence: `${dep.direct ? 'Direct' : 'Transitive'} dependency ${dep.name}@${dep.version}${cve ? ` (${cve})` : ''}${known ? '' : ' — severity not provided by advisory; shown as medium'}`,
        explanation: (v?.details ?? v?.summary ?? 'Known vulnerability recorded in OSV.').slice(0, 1200),
        remediation: fixed?.length
          ? `Upgrade ${dep.name} to ${[...new Set(fixed)].join(' or ')} or later${dep.direct ? '' : ' (update the parent package or add an override)'}, then re-run tests.`
          : `No fixed version is listed. Assess exploitability in your usage, consider an alternative package, or apply a documented mitigation.`,
        reference: `https://osv.dev/vulnerability/${id}`,
        key: `${id}|${dep.ecosystem}|${dep.name}|${dep.version}`,
      });
    }
  }
  return { findings, queried: deps.length, vulnerable: hits.length, error: null };
}
