/**
 * `@computesdk/cathedral` - the Cathedral provider for ComputeSDK.
 *
 * Cathedral (https://cathedral.computer) runs sealed sandboxes for evals, graders and agents: a
 * gVisor sandbox inside an AMD SEV-SNP confidential VM. This package maps ComputeSDK's sandbox
 * interface onto Cathedral's public REST API:
 *
 *   create      POST   /v1/sandboxes                 (sealed size from the catalog; polls if not yet `running`)
 *   getById     GET    /v1/sandboxes/{id}
 *   list        GET    /v1/sandboxes?state=running
 *   destroy     DELETE /v1/sandboxes/{id}
 *   runCommand  POST   /v1/sandboxes/{id}/exec       (<= 45 s; longer runs use /execs + poll)
 *   filesystem  GET/PUT /v1/sandboxes/{id}/files and GET /stat under /work; a command elsewhere and
 *               for mkdir/readdir/remove
 *   snapshot    POST   /v1/sandboxes/{id}/snapshots, GET/DELETE /v1/snapshots
 *
 * Forks are ordinary creates with `snapshotId`. Every mutating call carries an Idempotency-Key
 * so a lost response is resent without running twice.
 *
 * @see https://cathedral.computer/agents.md
 */

import { defineProvider, escapeShellArg } from '@computesdk/provider';
import type {
  CommandResult,
  CreateSandboxOptions,
  FileEntry,
  RunCommandOptions,
  SandboxInfo,
} from '@computesdk/provider';

import { CathedralClient, CathedralError, idempotencyKey, sleep, type CathedralClientOptions } from './client.js';

export { CathedralClient, CathedralError, DEFAULT_BASE_URL, PACKAGE_USER_AGENT } from './client.js';
export type { CathedralClientOptions, CathedralErrorBody } from './client.js';

/** The sandbox as Cathedral returns it (subset of SandboxResponse). */
export interface CathedralSandboxResponse {
  id: string;
  state: string;
  template?: string | null;
  image?: string | null;
  image_id?: string | null;
  snapshot_id?: string | null;
  network?: string | null;
  labels?: Record<string, string>;
  created_at?: string | null;
  lifetime_deadline_at?: string | null;
  cleanup_state?: string;
  error?: string | null;
  error_code?: string | null;
  failed_by?: string | null;
  waiting_for?: string | null;
  retry_after_s?: number | null;
  resources?: { cpu: number; memory_gib: number; disk_gib?: number | null } | null;
  [key: string]: unknown;
}

export interface CathedralSnapshotResponse {
  id: string;
  state: string;
  source_sandbox_id?: string | null;
  template?: string;
  labels?: Record<string, string>;
  created_at: string;
  ready_at?: string | null;
  expires_at?: string;
  error?: unknown;
  [key: string]: unknown;
}

/** What ComputeSDK holds for a Cathedral sandbox. `getInstance()` returns this. */
export interface CathedralSandbox {
  id: string;
  /** Last sandbox document read from the API. */
  info: CathedralSandboxResponse;
  /** Env vars passed at create; applied to every command, since Cathedral sets env per exec. */
  envs: Record<string, string>;
  /** Lifetime the sandbox was created with, in ms. */
  timeoutMs: number;
  client: CathedralClient;
  /** Commands go to a front door, which takes argv lists only (see `CathedralConfig.frontDoor`). */
  frontDoor: boolean;
}

export interface CathedralSnapshot {
  id: string;
  provider: 'cathedral';
  createdAt: Date;
  metadata: {
    state: string;
    sourceSandboxId: string | null;
    template?: string;
    labels?: Record<string, string>;
    expiresAt?: string;
  };
}

export interface CathedralConfig extends CathedralClientOptions {
  /**
   * Size or catalog template to create from when `templateId` is not passed (`sealed-2x4` and so
   * on). Falls back to CATHEDRAL_TEMPLATE, then to the catalog's default sealed size.
   */
  template?: string;
  /** Network mode: `deny_all` (default), `internet` or `allowlist`, where the template offers it. */
  network?: 'deny_all' | 'internet' | 'allowlist';
  /** Destinations that narrow an `allowlist` template's egress. */
  egressAllowlist?: string[];
  /**
   * Spend ceiling per sandbox in USD (required by the API; must cover rate x lifetime).
   * Falls back to CATHEDRAL_MAX_SPEND_USD, then to the size's rate x lifetime plus a quarter.
   */
  maxSpendUsd?: string | number;
  /** Default sandbox lifetime in ms when `create` gets no `timeout`. Default 1 hour. */
  timeout?: number;
  /** Labels added to every sandbox this provider creates (in addition to `metadata`). */
  labels?: Record<string, string>;
  /**
   * How long `create` waits for the sandbox to reach `running`, including a 503 with
   * `retry_after_s` resent with the same Idempotency-Key. Default 10 minutes.
   */
  createTimeoutMs?: number;
  /** Poll interval while a sandbox is `creating`. Default 200 ms. */
  pollIntervalMs?: number;
  /**
   * Talk to a Cathedral front door (the regional broker) instead of the central API: `baseUrl`
   * (or CATHEDRAL_BASE_URL) is the front door. Creates name a template or image, skip the
   * catalog read, carry no spend ceiling (the front door enforces the key's allowance) and ask
   * for sealed placement; commands are sent as `["bash", "-c", command]`, since a front door
   * refuses a shell string. Falls back to CATHEDRAL_FRONT_DOOR=1. Default off.
   */
  frontDoor?: boolean;
}

/** What `create` needs from `GET /v1/sandboxes/catalog`: the default size and each sealed size's rate. */
interface CatalogDefaults {
  /** Template used when none is passed: the sealed pool's default size, else the first catalog template. */
  defaultTemplate?: string;
  /** Hardware the sealed sizes run on (`amd_sev_snp`). */
  sealedHardware: string;
  /** Hourly rate in USD per sealed size, keyed by template name. */
  sealedRates: Record<string, number>;
}

interface CatalogResponse {
  sealed?: {
    available?: boolean;
    hardware?: string;
    template?: string;
    sizes?: Array<{ template: string; hourly_rate_usd?: string | number | null }>;
  } | null;
  templates?: Array<{ name: string }>;
}

type ConfigWithClient = CathedralConfig & { __client?: CathedralClient; __catalog?: Promise<CatalogDefaults> };

const DEFAULT_LIFETIME_MS = 60 * 60 * 1000;
const MIN_LIFETIME_S = 60;
const MAX_LIFETIME_S = 82_800;
const SYNC_EXEC_MAX_S = 45;
const BACKGROUND_EXEC_MAX_S = 14_400;
const LABEL_KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,62}$/;
const LABEL_VALUE = /^[\x20-\x7e]{0,128}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

function getClient(config: ConfigWithClient): CathedralClient {
  if (!config.__client) config.__client = new CathedralClient(config);
  return config.__client;
}

function frontDoorOn(config: CathedralConfig): boolean {
  if (config.frontDoor !== undefined) return config.frontDoor;
  return typeof process !== 'undefined' && process.env?.CATHEDRAL_FRONT_DOOR === '1';
}

function sandboxPath(id: string, suffix = ''): string {
  return `/v1/sandboxes/${encodeURIComponent(id)}${suffix}`;
}

/** Read the catalog once per provider instance, so a burst of creates shares one catalog read. */
function catalogDefaults(config: ConfigWithClient, client: CathedralClient): Promise<CatalogDefaults> {
  if (!config.__catalog) {
    config.__catalog = client
      .request<CatalogResponse>('catalog', '/v1/sandboxes/catalog')
      .then(({ body }) => {
        const sealed = body?.sealed;
        const sealedRates: Record<string, number> = {};
        for (const size of sealed?.sizes ?? []) {
          const rate = Number(size.hourly_rate_usd);
          if (size.template && Number.isFinite(rate)) sealedRates[size.template] = rate;
        }
        return {
          defaultTemplate: (sealed?.available ? sealed.template : undefined) ?? body?.templates?.[0]?.name,
          sealedHardware: sealed?.hardware || 'amd_sev_snp',
          sealedRates,
        };
      })
      .catch((error) => {
        config.__catalog = undefined;
        throw error;
      });
  }
  return config.__catalog;
}

/**
 * Spend ceiling for one sandbox. An explicit value wins. Otherwise cover the size's rate for the
 * whole lifetime plus a quarter, rounded up to the cent: a flat default (say 1 USD) would hold
 * far more of a budget-capped key than the sandbox can spend, and refuse creates in a burst.
 */
function maxSpendUsd(config: CathedralConfig, hourlyRate: number | undefined, lifetimeS: number): string {
  const explicit = config.maxSpendUsd ?? (typeof process !== 'undefined' ? process.env?.CATHEDRAL_MAX_SPEND_USD : undefined);
  if (explicit !== undefined && explicit !== '') return String(explicit);
  if (hourlyRate === undefined) return '1.00';
  const cents = Math.max(1, Math.ceil(hourlyRate * (lifetimeS / 3600) * 1.25 * 100));
  return (cents / 100).toFixed(2);
}

function toLabels(...sources: Array<Record<string, unknown> | undefined>): Record<string, string> | undefined {
  const labels: Record<string, string> = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(source ?? {})) {
      // Labels are routing metadata, not a data store: drop anything the API would reject
      // rather than failing the create over it.
      if (typeof value !== 'string' || !LABEL_KEY.test(key) || !LABEL_VALUE.test(value)) continue;
      labels[key] = value;
    }
  }
  const entries = Object.entries(labels).slice(0, 16);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function lifetimeSeconds(timeoutMs: number): number {
  return Math.min(MAX_LIFETIME_S, Math.max(MIN_LIFETIME_S, Math.ceil(timeoutMs / 1000)));
}

async function waitUntilRunning(
  client: CathedralClient,
  initial: CathedralSandboxResponse,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<CathedralSandboxResponse> {
  const deadline = Date.now() + timeoutMs;
  let current = initial;
  while (current.state !== 'running') {
    if (current.state === 'failed' || current.state === 'deleted' || current.state === 'deleting') {
      throw new Error(
        `Cathedral sandbox ${current.id} did not start: state=${current.state}` +
          (current.error_code ? ` error_code=${current.error_code}` : '') +
          (current.failed_by ? ` failed_by=${current.failed_by}` : '') +
          (current.error ? ` (${current.error})` : ''),
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Cathedral sandbox ${current.id} not running after ${Math.round(timeoutMs / 1000)}s (state=${current.state}` +
          (current.waiting_for ? `, waiting_for=${current.waiting_for}` : '') +
          ')',
      );
    }
    // `pending` waits on capacity: honour retry_after_s, capped so the transition is still
    // noticed promptly. `creating` is short: poll fast.
    const wait =
      current.state === 'pending' && typeof current.retry_after_s === 'number'
        ? Math.min(current.retry_after_s * 1000, 5000)
        : pollIntervalMs;
    await sleep(Math.max(0, Math.min(wait, deadline - Date.now())));
    const { body } = await client.request<CathedralSandboxResponse>('get sandbox', sandboxPath(current.id));
    current = body;
  }
  return current;
}

interface ExecResponse {
  exit_code: number | null;
  stdout: string;
  stderr: string;
  duration_ms: number | null;
  timed_out?: boolean;
}

interface ExecStatusResponse extends ExecResponse {
  exec_id: string;
  state: string;
  poll_after_s?: number | null;
  message?: string | null;
  failed_by?: string | null;
}

function execEnv(sandbox: CathedralSandbox, options?: RunCommandOptions): Record<string, string> | undefined {
  const env = { ...sandbox.envs, ...(options?.env ?? {}) };
  for (const key of Object.keys(env)) {
    if (!ENV_KEY.test(key)) throw new Error(`Invalid environment variable name: ${key}`);
  }
  return Object.keys(env).length ? env : undefined;
}

async function runCommand(
  sandbox: CathedralSandbox,
  command: string,
  options?: RunCommandOptions,
): Promise<CommandResult> {
  const started = Date.now();
  const client = sandbox.client;
  // A front door takes argv lists only; wrap the string the way the central API does.
  const body: Record<string, unknown> = { command: sandbox.frontDoor ? ['bash', '-c', command] : command };
  if (options?.cwd) body.cwd = options.cwd;
  const env = execEnv(sandbox, options);
  if (env) body.env = env;

  const requestedS = options?.timeout ? Math.ceil(options.timeout / 1000) : undefined;

  if (options?.background) {
    // Detached: start it and return. It runs until it exits or its timeout (max 4 h).
    body.timeout_seconds = Math.min(BACKGROUND_EXEC_MAX_S, Math.max(1, requestedS ?? BACKGROUND_EXEC_MAX_S));
    await client.request<ExecStatusResponse>('start exec', sandboxPath(sandbox.id, '/execs'), {
      method: 'POST',
      json: body,
      idempotencyKey: idempotencyKey('x'),
    });
    return { stdout: '', stderr: '', exitCode: 0, durationMs: Date.now() - started };
  }

  if (requestedS === undefined || requestedS <= SYNC_EXEC_MAX_S) {
    body.timeout_seconds = Math.max(1, requestedS ?? SYNC_EXEC_MAX_S);
    const { body: result } = await client.request<ExecResponse>('exec', sandboxPath(sandbox.id, '/exec'), {
      method: 'POST',
      json: body,
      idempotencyKey: idempotencyKey('x'),
    });
    return toCommandResult(result, started);
  }

  // Longer than one request may stay open: start in the background and long-poll for the result.
  body.timeout_seconds = Math.min(BACKGROUND_EXEC_MAX_S, requestedS);
  const { body: startedExec } = await client.request<ExecStatusResponse>('start exec', sandboxPath(sandbox.id, '/execs'), {
    method: 'POST',
    json: body,
    idempotencyKey: idempotencyKey('x'),
  });
  let status = startedExec;
  while (status.state === 'running' || status.state === 'starting' || status.state === 'queued') {
    const { body: next } = await client.request<ExecStatusResponse>(
      'get exec',
      sandboxPath(sandbox.id, `/execs/${encodeURIComponent(status.exec_id)}`),
      { query: { wait: 25 } },
    );
    status = next;
  }
  if (status.exit_code === null || status.exit_code === undefined) {
    throw new Error(
      `Cathedral exec ${status.exec_id} ended in state ${status.state}` +
        (status.failed_by ? ` (failed_by=${status.failed_by})` : '') +
        (status.message ? `: ${status.message}` : ''),
    );
  }
  return toCommandResult(status, started);
}

function toCommandResult(result: ExecResponse, started: number): CommandResult {
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: typeof result.exit_code === 'number' ? result.exit_code : 1,
    durationMs: typeof result.duration_ms === 'number' ? result.duration_ms : Date.now() - started,
  };
}

function toInfo(sandbox: CathedralSandbox, info: CathedralSandboxResponse): SandboxInfo {
  const status: SandboxInfo['status'] =
    info.state === 'running' || info.state === 'creating' || info.state === 'pending'
      ? 'running'
      : info.state === 'failed'
        ? 'error'
        : 'stopped';
  return {
    id: info.id,
    provider: 'cathedral',
    status,
    createdAt: info.created_at ? new Date(info.created_at) : new Date(),
    timeout: sandbox.timeoutMs,
    metadata: {
      state: info.state,
      template: info.template ?? null,
      image: info.image ?? null,
      imageId: info.image_id ?? null,
      snapshotId: info.snapshot_id ?? null,
      network: info.network ?? null,
      labels: info.labels ?? {},
      resources: info.resources ?? null,
      lifetimeDeadlineAt: info.lifetime_deadline_at ?? null,
      cleanupState: info.cleanup_state ?? null,
    },
  };
}

function toSnapshot(raw: CathedralSnapshotResponse): CathedralSnapshot {
  return {
    id: raw.id,
    provider: 'cathedral',
    createdAt: new Date(raw.created_at),
    metadata: {
      state: raw.state,
      sourceSandboxId: raw.source_sandbox_id ?? null,
      template: raw.template,
      labels: raw.labels,
      expiresAt: raw.expires_at,
    },
  };
}

function handle(
  config: CathedralConfig,
  client: CathedralClient,
  info: CathedralSandboxResponse,
  envs: Record<string, string>,
  timeoutMs: number,
): CathedralSandbox {
  return { id: info.id, info, envs, timeoutMs, client, frontDoor: frontDoorOn(config) };
}

const quoted = (path: string) => `"${escapeShellArg(path)}"`;

/**
 * The Files API serves the work directory (`/work`) only and refuses other paths with 422.
 * Paths elsewhere (`/tmp`, `/root`) go through a command instead, so every path works.
 */
const WORK_DIR = '/work';
const isWorkPath = (path: string) => path.startsWith(`${WORK_DIR}/`);

async function shell(sandbox: CathedralSandbox, command: string, what: string): Promise<CommandResult> {
  const result = await runCommand(sandbox, command);
  if (result.exitCode !== 0) throw new Error(`Failed to ${what}: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
  return result;
}

async function readFile(sandbox: CathedralSandbox, path: string): Promise<string> {
  if (!isWorkPath(path)) {
    const result = await runCommand(sandbox, `cat -- ${quoted(path)}`);
    if (result.exitCode !== 0) {
      if (/No such file/i.test(result.stderr)) throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      throw new Error(`Failed to read ${path}: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
    }
    return result.stdout;
  }
  const { status, body } = await sandbox.client.request<string>('read file', sandboxPath(sandbox.id, '/files'), {
    query: { path },
    text: true,
    allow: [404],
  });
  if (status === 404) throw new Error(`ENOENT: no such file or directory, open '${path}'`);
  return body;
}

async function writeFile(sandbox: CathedralSandbox, path: string, content: string): Promise<void> {
  if (!isWorkPath(path)) {
    // Upload into the work directory natively (no command-length limit on the content), then move.
    const staged = `${WORK_DIR}/.computesdk-upload-${idempotencyKey('u')}`;
    await writeFile(sandbox, staged, content);
    const slash = path.lastIndexOf('/');
    const parent = slash > 0 ? `mkdir -p -- ${quoted(path.slice(0, slash))} && ` : '';
    await shell(sandbox, `${parent}mv -f -- ${quoted(staged)} ${quoted(path)}`, `write ${path}`);
    return;
  }
  const put = () =>
    sandbox.client.request('write file', sandboxPath(sandbox.id, '/files'), {
      method: 'PUT',
      query: { path },
      raw: content,
      idempotencyKey: idempotencyKey('w'),
    });
  try {
    await put();
  } catch (error) {
    // A missing parent directory is the common client-side cause; create it once and retry.
    if (!(error instanceof CathedralError) || ![404, 409, 422].includes(error.status)) throw error;
    const slash = path.lastIndexOf('/');
    if (slash <= 0) throw error;
    const mk = await runCommand(sandbox, `mkdir -p ${quoted(path.slice(0, slash))}`);
    if (mk.exitCode !== 0) throw error;
    await put();
  }
}

async function exists(sandbox: CathedralSandbox, path: string): Promise<boolean> {
  if (!isWorkPath(path)) {
    return (await runCommand(sandbox, `test -e ${quoted(path)} || test -L ${quoted(path)}`)).exitCode === 0;
  }
  const { status } = await sandbox.client.request('stat', sandboxPath(sandbox.id, '/stat'), {
    query: { path },
    allow: [404],
  });
  return status !== 404;
}

/**
 * List a directory with a POSIX shell loop rather than GNU `find -printf`, so it works on
 * busybox images too. One line per entry: type, size, mtime (epoch s), name.
 */
async function readdir(sandbox: CathedralSandbox, path: string): Promise<FileEntry[]> {
  const script =
    `cd ${quoted(path)} || exit 2; for f in * .[!.]* ..?*; do [ -e "$f" ] || [ -L "$f" ] || continue; ` +
    `if [ -d "$f" ]; then t=d; else t=f; fi; ` +
    `set -- $(stat -c '%s %Y' -- "$f" 2>/dev/null || echo '0 0'); ` +
    `printf '%s\\t%s\\t%s\\t%s\\n' "$t" "$1" "$2" "$f"; done`;
  const result = await runCommand(sandbox, script);
  if (result.exitCode !== 0) {
    throw new Error(`Failed to list ${path}: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
  }
  return result.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [type, size, mtime, ...rest] = line.split('\t');
      return {
        name: rest.join('\t'),
        type: type === 'd' ? ('directory' as const) : ('file' as const),
        size: Number(size) || 0,
        modified: new Date((Number(mtime) || 0) * 1000),
      };
    });
}

type FsRun = (sandbox: CathedralSandbox, command: string, options?: RunCommandOptions) => Promise<CommandResult>;

async function shellOrThrow(run: FsRun, sandbox: CathedralSandbox, command: string, what: string): Promise<void> {
  const result = await run(sandbox, command);
  if (result.exitCode !== 0) throw new Error(`Failed to ${what}: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
}

export const cathedral = defineProvider<CathedralSandbox, ConfigWithClient, never, CathedralSnapshot>({
  name: 'cathedral',
  methods: {
    instances: {
      create: async (config: ConfigWithClient, options?: CreateSandboxOptions) => {
        const client = getClient(config);
        const timeoutMs = options?.timeout ?? config.timeout ?? DEFAULT_LIFETIME_MS;
        // `image`, `imageId` and `network` are Cathedral-specific create options passed through
        // ComputeSDK's open options object (e.g. a benchmark participant's sandboxOptions).
        const { envs, name, metadata, templateId, snapshotId, ...rest } = (options ?? {}) as CreateSandboxOptions & {
          image?: string;
          imageId?: string;
          network?: string;
        };

        const lifetimeS = lifetimeSeconds(timeoutMs);
        const body: Record<string, unknown> = {
          lifetime_seconds: lifetimeS,
          network: rest.network ?? config.network ?? 'deny_all',
        };
        let hourlyRate: number | undefined;
        const frontDoor = frontDoorOn(config);
        if (frontDoor) {
          // The front door creates from a named template or an image and answers 201 running:
          // no catalog read, no spend ceiling, and sealed placement for every create.
          if (snapshotId) throw new Error('Cathedral front-door mode does not create from snapshotId; pass templateId or image.');
          const template =
            templateId || config.template || (typeof process !== 'undefined' ? process.env?.CATHEDRAL_TEMPLATE : undefined);
          if (rest.imageId) body.image_id = rest.imageId;
          else if (rest.image) body.image = rest.image;
          else if (template) body.template = template;
          else throw new Error('Cathedral front-door mode needs a template: pass templateId (for example node-22), or set CATHEDRAL_TEMPLATE.');
          body.sealed = true;
        } else if (snapshotId) {
          // A fork keeps its source's size, rate and network modes.
          body.snapshot_id = snapshotId;
        } else {
          const catalog = await catalogDefaults(config, client);
          const template =
            templateId ||
            config.template ||
            (typeof process !== 'undefined' ? process.env?.CATHEDRAL_TEMPLATE : undefined) ||
            catalog.defaultTemplate;
          if (!template) {
            throw new Error('Cathedral catalog lists no templates for this key. Pass templateId, or set CATHEDRAL_TEMPLATE.');
          }
          body.template = template;
          // A sealed size (sealed-2x4 and so on) runs in an AMD SEV-SNP guest and must say so.
          if (template in catalog.sealedRates) {
            body.required_hardware = catalog.sealedHardware;
            hourlyRate = catalog.sealedRates[template];
          }
          // An image runs inside the chosen size. Public images are referenced by digest
          // (`node@sha256:...`); `imageId` is one imported into your account.
          if (rest.imageId) body.image_id = rest.imageId;
          else if (rest.image) body.image = rest.image;
        }
        if (!frontDoor) {
          body.max_spend_usd = maxSpendUsd(config, hourlyRate, lifetimeS);
          if (config.egressAllowlist?.length) body.egress_allowlist = config.egressAllowlist;
        }
        const labels = toLabels(config.labels, metadata as Record<string, unknown> | undefined, name ? { name } : undefined);
        if (labels) body.labels = labels;

        const key = idempotencyKey('c');
        const createDeadline = Date.now() + (config.createTimeoutMs ?? 10 * 60 * 1000);
        let created: CathedralSandboxResponse | undefined;
        while (!created) {
          try {
            ({ body: created } = await client.request<CathedralSandboxResponse>('create sandbox', '/v1/sandboxes', {
              method: 'POST',
              json: body,
              idempotencyKey: key,
            }));
          } catch (error) {
            // Capacity being added (503 seed_supply_pending / box_unavailable): nothing was
            // created or charged; resend the identical request with the same key.
            if (
              error instanceof CathedralError &&
              error.status === 503 &&
              error.retryAfterS !== undefined &&
              Date.now() + error.retryAfterS * 1000 < createDeadline
            ) {
              await sleep(error.retryAfterS * 1000);
              continue;
            }
            throw error;
          }
        }

        const running = await waitUntilRunning(
          client,
          created,
          Math.max(0, createDeadline - Date.now()),
          config.pollIntervalMs ?? 200,
        );
        const sandbox = handle(config, client, running, { ...(envs ?? {}) }, timeoutMs);
        return { sandbox, sandboxId: sandbox.id };
      },

      getById: async (config: ConfigWithClient, sandboxId: string) => {
        const client = getClient(config);
        const { status, body } = await client.request<CathedralSandboxResponse>('get sandbox', sandboxPath(sandboxId), {
          allow: [404, 422],
        });
        if (status === 404 || status === 422) return null;
        const sandbox = handle(config, client, body, {}, config.timeout ?? DEFAULT_LIFETIME_MS);
        return { sandbox, sandboxId: sandbox.id };
      },

      list: async (config: ConfigWithClient) => {
        const client = getClient(config);
        const out: Array<{ sandbox: CathedralSandbox; sandboxId: string }> = [];
        for (let offset = 0; ; offset += 100) {
          const { body } = await client.request<{ sandboxes: CathedralSandboxResponse[]; has_more: boolean }>(
            'list sandboxes',
            '/v1/sandboxes',
            { query: { state: 'running', limit: 100, offset } },
          );
          for (const info of body.sandboxes ?? []) {
            out.push({ sandbox: handle(config, client, info, {}, config.timeout ?? DEFAULT_LIFETIME_MS), sandboxId: info.id });
          }
          if (!body.has_more) break;
        }
        return out;
      },

      destroy: async (config: ConfigWithClient, sandboxId: string) => {
        const client = getClient(config);
        // 202 `deleting`; billing for the sandbox stops at this call. Already gone is fine.
        await client.request('delete sandbox', sandboxPath(sandboxId), {
          method: 'DELETE',
          idempotencyKey: idempotencyKey('d'),
          allow: [404],
        });
      },

      runCommand,

      getInfo: async (sandbox: CathedralSandbox) => {
        const { body } = await sandbox.client.request<CathedralSandboxResponse>('get sandbox', sandboxPath(sandbox.id));
        sandbox.info = body;
        return toInfo(sandbox, body);
      },

      getUrl: async () => {
        throw new Error(
          'Cathedral does not offer port URLs on sealed sandboxes yet, so getUrl is not supported. ' +
            'Move data in and out with the filesystem methods instead.',
        );
      },

      getInstance: (sandbox: CathedralSandbox) => sandbox,

      filesystem: {
        readFile: (sandbox: CathedralSandbox, path: string) => readFile(sandbox, path),
        writeFile: (sandbox: CathedralSandbox, path: string, content: string) => writeFile(sandbox, path, content),
        mkdir: (sandbox: CathedralSandbox, path: string, run: FsRun) =>
          shellOrThrow(run, sandbox, `mkdir -p ${quoted(path)}`, `create directory ${path}`),
        readdir: (sandbox: CathedralSandbox, path: string) => readdir(sandbox, path),
        exists: (sandbox: CathedralSandbox, path: string) => exists(sandbox, path),
        remove: (sandbox: CathedralSandbox, path: string, run: FsRun) =>
          shellOrThrow(run, sandbox, `rm -rf ${quoted(path)}`, `remove ${path}`),
      },
    },

    snapshot: {
      create: async (config: ConfigWithClient, sandboxId: string, options?: { name?: string; metadata?: Record<string, string> }) => {
        const client = getClient(config);
        const labels = toLabels(options?.metadata, options?.name ? { name: options.name } : undefined);
        const { body } = await client.request<CathedralSnapshotResponse>('create snapshot', sandboxPath(sandboxId, '/snapshots'), {
          method: 'POST',
          json: labels ? { labels } : {},
          idempotencyKey: idempotencyKey('s'),
        });
        // A snapshot is usable as `snapshotId` once `ready`; wait so callers can fork from it.
        let snapshot = body;
        const deadline = Date.now() + 10 * 60 * 1000;
        while (snapshot.state === 'creating' && Date.now() < deadline) {
          await sleep(1000);
          ({ body: snapshot } = await client.request<CathedralSnapshotResponse>(
            'get snapshot',
            `/v1/snapshots/${encodeURIComponent(snapshot.id)}`,
          ));
        }
        if (snapshot.state !== 'ready') {
          throw new Error(`Cathedral snapshot ${snapshot.id} is ${snapshot.state}, not ready`);
        }
        return toSnapshot(snapshot);
      },

      list: async (config: ConfigWithClient, options?: { sandboxId?: string; limit?: number }) => {
        const client = getClient(config);
        const out: CathedralSnapshot[] = [];
        let cursor: string | undefined;
        do {
          const { body } = await client.request<{ snapshots: CathedralSnapshotResponse[]; next_cursor?: string | null }>(
            'list snapshots',
            '/v1/snapshots',
            { query: { limit: 100, cursor } },
          );
          for (const raw of body.snapshots ?? []) {
            if (options?.sandboxId && raw.source_sandbox_id !== options.sandboxId) continue;
            out.push(toSnapshot(raw));
          }
          cursor = body.next_cursor ?? undefined;
        } while (cursor && (!options?.limit || out.length < options.limit));
        return options?.limit ? out.slice(0, options.limit) : out;
      },

      delete: async (config: ConfigWithClient, snapshotId: string) => {
        await getClient(config).request('delete snapshot', `/v1/snapshots/${encodeURIComponent(snapshotId)}`, {
          method: 'DELETE',
          idempotencyKey: idempotencyKey('s'),
          allow: [404],
        });
      },
    },
  },
});

export default cathedral;
