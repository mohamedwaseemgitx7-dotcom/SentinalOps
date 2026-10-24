import path from 'node:path';
import type { RepoSource } from './source.ts';

const EXT_LANG: Record<string, string> = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.mts': 'TypeScript', '.cts': 'TypeScript',
  '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.py': 'Python', '.go': 'Go', '.rs': 'Rust', '.java': 'Java', '.kt': 'Kotlin', '.cs': 'C#',
  '.rb': 'Ruby', '.php': 'PHP', '.swift': 'Swift', '.c': 'C', '.h': 'C', '.cpp': 'C++', '.cc': 'C++', '.hpp': 'C++',
  '.scala': 'Scala', '.dart': 'Dart', '.vue': 'Vue', '.svelte': 'Svelte', '.html': 'HTML', '.css': 'CSS',
  '.scss': 'SCSS', '.sh': 'Shell', '.ps1': 'PowerShell', '.tf': 'HCL', '.sql': 'SQL', '.lua': 'Lua', '.ex': 'Elixir',
  '.exs': 'Elixir', 'dockerfile': 'Dockerfile',
};

export function languagesFromSizes(sizes: Map<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [ext, bytes] of sizes) {
    const lang = EXT_LANG[ext];
    if (lang) out[lang] = (out[lang] ?? 0) + bytes;
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
}

/** dependency name → framework label */
const NPM_FRAMEWORKS: Record<string, string> = {
  next: 'Next.js', react: 'React', vue: 'Vue', nuxt: 'Nuxt', svelte: 'Svelte', '@sveltejs/kit': 'SvelteKit',
  '@angular/core': 'Angular', astro: 'Astro', express: 'Express', fastify: 'Fastify', hono: 'Hono', koa: 'Koa',
  '@nestjs/core': 'NestJS', electron: 'Electron', '@tauri-apps/api': 'Tauri', vite: 'Vite', 'react-native': 'React Native',
  expo: 'Expo', prisma: 'Prisma', mongoose: 'Mongoose', typeorm: 'TypeORM', 'drizzle-orm': 'Drizzle', jest: 'Jest',
  vitest: 'Vitest', mocha: 'Mocha', '@playwright/test': 'Playwright', cypress: 'Cypress', tailwindcss: 'Tailwind CSS',
  'socket.io': 'Socket.IO', graphql: 'GraphQL', '@remix-run/react': 'Remix', gatsby: 'Gatsby', wrangler: 'Cloudflare Workers',
};
const PY_FRAMEWORKS: Record<string, string> = {
  django: 'Django', flask: 'Flask', fastapi: 'FastAPI', pytest: 'pytest', sqlalchemy: 'SQLAlchemy', celery: 'Celery',
  streamlit: 'Streamlit', pandas: 'pandas', numpy: 'NumPy', torch: 'PyTorch', tensorflow: 'TensorFlow', boto3: 'AWS SDK (boto3)',
};

export interface Architecture {
  manifests: string[];
  workflows: string[];
  dockerfiles: string[];
  composeFiles: string[];
  terraform: string[];
  kubernetes: string[];
  testFiles: number;
  testDirs: string[];
  docs: Record<string, boolean>;
  packages: { file: string; name: string | null; scripts: string[]; dependencies: number; devDependencies: number }[];
  components: { name: string; kind: string; path: string }[];
  envFiles: string[];
  lockfiles: string[];
  ciProviders: string[];
  deploymentTargets: string[];
}

const DOC_FILES: Record<string, RegExp> = {
  README: /^readme(\.[a-z]+)?$/i,
  LICENSE: /^(licen[cs]e|copying)(\.[a-z]+)?$/i,
  SECURITY: /^(\.github\/)?security\.md$/i,
  CONTRIBUTING: /^(\.github\/)?contributing\.md$/i,
  CHANGELOG: /^(changelog|history)(\.md)?$/i,
  CODEOWNERS: /^(\.github\/|docs\/)?codeowners$/i,
  'Issue templates': /^\.github\/issue_template/i,
  'PR template': /^\.github\/pull_request_template/i,
  'Dependabot config': /^\.github\/dependabot\.ya?ml$/i,
  'Architecture docs': /^(docs\/)?(architecture|adr|design)/i,
  Runbook: /(runbook|playbook|troubleshooting|operations)/i,
};

export async function detectArchitecture(src: RepoSource): Promise<{ arch: Architecture; frameworks: string[] }> {
  const f = src.files;
  const base = (p: string) => path.posix.basename(p).toLowerCase();
  const arch: Architecture = {
    manifests: f.filter((p) => ['package.json', 'requirements.txt', 'pyproject.toml', 'go.mod', 'cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'gemfile', 'composer.json', 'pipfile'].includes(base(p)) || p.endsWith('.csproj')),
    workflows: f.filter((p) => /^\.github\/workflows\/[^/]+\.ya?ml$/i.test(p)),
    dockerfiles: f.filter((p) => /(^|\/)(dockerfile|containerfile)(\.[\w-]+)?$/i.test(p) || /\.dockerfile$/i.test(p)),
    composeFiles: f.filter((p) => /(^|\/)(docker-)?compose(\.[\w-]+)?\.ya?ml$/i.test(p)),
    terraform: f.filter((p) => p.endsWith('.tf')),
    kubernetes: [],
    testFiles: f.filter((p) => /(\.|_)(test|spec)\.[a-z]+$/i.test(p) || /(^|\/)test_[^/]+\.py$/i.test(p) || /(^|\/)(tests?|__tests__|e2e)\//i.test(p)).length,
    testDirs: [...new Set(f.map((p) => p.match(/^(.*?(?:^|\/)(?:tests?|__tests__|e2e|spec))\//i)?.[1]).filter((x): x is string => !!x))].slice(0, 10),
    docs: Object.fromEntries(Object.entries(DOC_FILES).map(([k, re]) => [k, f.some((p) => re.test(p))])),
    packages: [],
    components: [],
    envFiles: f.filter((p) => /(^|\/)\.env(\.[\w-]+)?$/i.test(p) && !/\.(example|sample|template|dist)$/i.test(p)),
    lockfiles: f.filter((p) => ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock', 'poetry.lock', 'pipfile.lock', 'cargo.lock', 'go.sum', 'composer.lock', 'gemfile.lock', 'uv.lock'].includes(base(p))),
    ciProviders: [],
    deploymentTargets: [],
  };

  // Kubernetes manifests: YAML that declares apiVersion + kind, in likely folders (bounded reads).
  const k8sCandidates = f.filter((p) => /\.ya?ml$/i.test(p) && /(k8s|kube|kubernetes|manifests|helm|charts|deploy)/i.test(p)).slice(0, 40);
  for (const p of k8sCandidates) {
    const text = await src.read(p);
    if (text && /^apiVersion:/m.test(text) && /^kind:/m.test(text)) arch.kubernetes.push(p);
  }

  if (arch.workflows.length) arch.ciProviders.push('GitHub Actions');
  if (f.includes('.gitlab-ci.yml')) arch.ciProviders.push('GitLab CI');
  if (f.some((p) => p.startsWith('.circleci/'))) arch.ciProviders.push('CircleCI');
  if (f.includes('Jenkinsfile')) arch.ciProviders.push('Jenkins');
  if (f.includes('azure-pipelines.yml')) arch.ciProviders.push('Azure Pipelines');

  const targets: [RegExp, string][] = [
    [/^vercel\.(json|ts)$/, 'Vercel'], [/^netlify\.toml$/, 'Netlify'], [/^wrangler\.(toml|json|jsonc)$/, 'Cloudflare Workers'],
    [/^render\.ya?ml$/, 'Render'], [/^fly\.toml$/, 'Fly.io'], [/^app\.ya?ml$/, 'Google App Engine'], [/^Procfile$/, 'Heroku-style Procfile'],
    [/(^|\/)serverless\.ya?ml$/, 'Serverless Framework'], [/(^|\/)template\.ya?ml$/, 'AWS SAM (possible)'], [/(^|\/)cdk\.json$/, 'AWS CDK'],
    [/^firebase\.json$/, 'Firebase'], [/^\.platform\.app\.yaml$/, 'Platform.sh'],
  ];
  for (const [re, label] of targets) if (f.some((p) => re.test(p))) arch.deploymentTargets.push(label);
  if (arch.terraform.length) arch.deploymentTargets.push('Terraform-managed infrastructure');
  if (arch.kubernetes.length) arch.deploymentTargets.push('Kubernetes');

  const frameworks = new Set<string>();
  for (const manifest of arch.manifests.slice(0, 25)) {
    const text = await src.read(manifest);
    if (!text) continue;
    const name = base(manifest);
    if (name === 'package.json') {
      try {
        const pkg = JSON.parse(text) as { name?: string; scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        for (const d of Object.keys(deps)) if (NPM_FRAMEWORKS[d]) frameworks.add(NPM_FRAMEWORKS[d]!);
        arch.packages.push({
          file: manifest,
          name: pkg.name ?? null,
          scripts: Object.keys(pkg.scripts ?? {}),
          dependencies: Object.keys(pkg.dependencies ?? {}).length,
          devDependencies: Object.keys(pkg.devDependencies ?? {}).length,
        });
        frameworks.add('Node.js');
      } catch {
        /* invalid JSON is reported by the rules engine */
      }
    } else if (name === 'requirements.txt' || name === 'pyproject.toml' || name === 'pipfile') {
      const lower = text.toLowerCase();
      for (const [dep, label] of Object.entries(PY_FRAMEWORKS)) if (new RegExp(`(^|[\\s"'\\[])${dep}([\\s=<>~!\\[;"',]|$)`, 'm').test(lower)) frameworks.add(label);
      frameworks.add('Python');
    } else if (name === 'go.mod') {
      frameworks.add('Go modules');
      if (text.includes('github.com/gin-gonic/gin')) frameworks.add('Gin');
      if (text.includes('github.com/gofiber/fiber')) frameworks.add('Fiber');
    } else if (name === 'cargo.toml') {
      frameworks.add('Cargo');
      if (/^\s*(actix-web|axum|rocket|tokio)\s*=/m.test(text)) frameworks.add(text.match(/^\s*(actix-web|axum|rocket|tokio)\s*=/m)![1]!);
    } else if (name === 'pom.xml' || name.startsWith('build.gradle')) {
      frameworks.add(name === 'pom.xml' ? 'Maven' : 'Gradle');
      if (text.includes('spring-boot')) frameworks.add('Spring Boot');
    } else if (manifest.endsWith('.csproj')) {
      frameworks.add('.NET');
    }
  }
  if (arch.dockerfiles.length) frameworks.add('Docker');
  if (arch.terraform.length) frameworks.add('Terraform');
  if (arch.kubernetes.length) frameworks.add('Kubernetes');
  if (arch.workflows.length) frameworks.add('GitHub Actions');

  // Components: each manifest directory is a deployable/buildable unit.
  for (const manifest of arch.manifests) {
    const dir = path.posix.dirname(manifest);
    arch.components.push({ name: dir === '.' ? '(root)' : dir, kind: base(manifest), path: manifest });
  }
  for (const d of arch.dockerfiles) arch.components.push({ name: path.posix.dirname(d) === '.' ? '(root)' : path.posix.dirname(d), kind: 'container image', path: d });
  for (const c of arch.composeFiles) arch.components.push({ name: c, kind: 'compose stack', path: c });

  return { arch, frameworks: [...frameworks] };
}
