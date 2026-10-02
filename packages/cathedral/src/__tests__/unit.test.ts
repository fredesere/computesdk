import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cathedral, CathedralError, PACKAGE_USER_AGENT } from '../index';

interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

type Responder = (call: Call) => { status: number; body?: unknown; text?: string } | Promise<{ status: number; body?: unknown; text?: string }>;

const SANDBOX_ID = '11111111-2222-4333-8444-555555555555';
const API_KEY = 'cat_sk_test_0123456789';

function sandboxDoc(state: string, extra: Record<string, unknown> = {}) {
  return {
    id: SANDBOX_ID,
    state,
    template: 'node-22',
    network: 'deny_all',
    labels: {},
    created_at: '2026-10-01T00:00:00Z',
    cleanup_state: 'none',
    error: null,
    lifetime_deadline_at: null,
    operation: null,
    resources: { cpu: 1, memory_gib: 4 },
    ...extra,
  };
}

let calls: Call[];
let routes: Array<{ match: (c: Call) => boolean; respond: Responder }>;

function route(method: string, path: string | RegExp, respond: Responder) {
  routes.push({
    match: (c) => c.method === method && (typeof path === 'string' ? c.url.pathname === path : path.test(c.url.pathname)),
    respond,
  });
}

beforeEach(() => {
  calls = [];
  routes = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>));
      let body: unknown = init.body;
      if (typeof body === 'string' && headers['Content-Type'] === 'application/json') body = JSON.parse(body);
      const call: Call = { method: init.method ?? 'GET', url: new URL(input), headers, body };
      calls.push(call);
      const handler = routes.find((r) => r.match(call));
      if (!handler) return new Response(JSON.stringify({ error: 'no route' }), { status: 599 });
      const res = await handler.respond(call);
      const payload = res.text ?? (res.body === undefined ? null : JSON.stringify(res.body));
      return new Response(res.status === 204 ? null : payload, { status: res.status });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function provider(extra: Record<string, unknown> = {}) {
  return cathedral({ apiKey: API_KEY, template: 'node-22', pollIntervalMs: 1, ...extra });
}

describe('config', () => {
  it('fails early without an API key', async () => {
    const prev = process.env.CATHEDRAL_API_KEY;
    delete process.env.CATHEDRAL_API_KEY;
    try {
      await expect(cathedral({}).sandbox.create()).rejects.toThrow(/Missing Cathedral API key/);
    } finally {
      if (prev !== undefined) process.env.CATHEDRAL_API_KEY = prev;
    }
  });

  it('refuses a plain-http base URL so the key never leaves over cleartext', async () => {
    await expect(cathedral({ apiKey: API_KEY, baseUrl: 'http://example.com' }).sandbox.create()).rejects.toThrow(/must be https/);
  });
});

describe('create', () => {
  it('sends auth, a real User-Agent, an Idempotency-Key and the documented body', async () => {
    route('POST', '/v1/sandboxes', () => ({ status: 202, body: sandboxDoc('running') }));
    const sandbox = await provider({ labels: { job: 'bench' } }).sandbox.create({ timeout: 120_000, metadata: { trial: 't1' } });

    expect(sandbox.sandboxId).toBe(SANDBOX_ID);
    const create = calls[0];
    expect(create.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(create.headers['User-Agent']).toBe(PACKAGE_USER_AGENT);
    expect(create.headers['Idempotency-Key']).toMatch(/^computesdk-c-[0-9a-f-]{36}$/);
    expect(create.body).toEqual({
      template: 'node-22',
      lifetime_seconds: 120,
      max_spend_usd: '1.00',
      network: 'deny_all',
      labels: { job: 'bench', trial: 't1' },
    });
  });

  it('polls while creating and returns once running', async () => {
    let gets = 0;
    route('POST', '/v1/sandboxes', () => ({ status: 202, body: sandboxDoc('creating') }));
    route('GET', `/v1/sandboxes/${SANDBOX_ID}`, () => {
      gets += 1;
      return { status: 200, body: sandboxDoc(gets < 3 ? 'creating' : 'running') };
    });
    const sandbox = await provider().sandbox.create();
    expect(sandbox.sandboxId).toBe(SANDBOX_ID);
    expect(gets).toBe(3);
  });

  it('reports a failed start with failed_by and error_code', async () => {
    route('POST', '/v1/sandboxes', () => ({ status: 202, body: sandboxDoc('creating') }));
    route('GET', `/v1/sandboxes/${SANDBOX_ID}`, () => ({
      status: 200,
      body: sandboxDoc('failed', { error_code: 'box_start_failed', failed_by: 'cathedral' }),
    }));
    await expect(provider().sandbox.create()).rejects.toThrow(/box_start_failed.*failed_by=cathedral/);
  });

  it('times out a sandbox that never runs', async () => {
    route('POST', '/v1/sandboxes', () => ({ status: 202, body: sandboxDoc('pending', { waiting_for: 'box_starting', retry_after_s: 0 }) }));
    route('GET', `/v1/sandboxes/${SANDBOX_ID}`, () => ({ status: 200, body: sandboxDoc('pending', { waiting_for: 'box_starting', retry_after_s: 0 }) }));
    await expect(provider({ createTimeoutMs: 30 }).sandbox.create()).rejects.toThrow(/not running.*waiting_for=box_starting/);
  });

  it('resends a create with the SAME Idempotency-Key after a 503 with retry_after_s', async () => {
    let posts = 0;
    route('POST', '/v1/sandboxes', () => {
      posts += 1;
      return posts === 1
        ? { status: 503, body: { error: 'Capacity is being added.', failed_by: 'cathedral', billed: false, retry_after_s: 0, detail: { error: 'seed_supply_pending' } } }
        : { status: 202, body: sandboxDoc('running') };
    });
    await provider().sandbox.create();
    const keys = calls.filter((c) => c.method === 'POST').map((c) => c.headers['Idempotency-Key']);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('maps snapshotId to a fork and image to a catalog image', async () => {
    route('POST', '/v1/sandboxes', () => ({ status: 202, body: sandboxDoc('running') }));
    const p = provider();
    await p.sandbox.create({ snapshotId: 'snap_abc' });
    await p.sandbox.create({ image: 'docker.io/library/node:22' } as never);
    expect(calls[0].body).toMatchObject({ snapshot_id: 'snap_abc' });
    expect(calls[0].body).not.toHaveProperty('template');
    expect(calls[1].body).toMatchObject({ image: 'docker.io/library/node:22' });
    expect(calls[1].body).not.toHaveProperty('template');
  });

  it('reads the default template from the catalog once for a burst', async () => {
    route('GET', '/v1/sandboxes/catalog', () => ({ status: 200, body: { templates: [{ name: 'standard-node' }] } }));
    route('POST', '/v1/sandboxes', () => ({ status: 202, body: sandboxDoc('running') }));
    const prev = process.env.CATHEDRAL_TEMPLATE;
    delete process.env.CATHEDRAL_TEMPLATE;
    try {
      const p = cathedral({ apiKey: API_KEY, pollIntervalMs: 1 });
      await Promise.all([p.sandbox.create(), p.sandbox.create(), p.sandbox.create()]);
    } finally {
      if (prev !== undefined) process.env.CATHEDRAL_TEMPLATE = prev;
    }
    expect(calls.filter((c) => c.url.pathname === '/v1/sandboxes/catalog')).toHaveLength(1);
    expect(calls.filter((c) => c.method === 'POST').every((c) => (c.body as { template: string }).template === 'standard-node')).toBe(true);
  });

  it('surfaces a 4xx as a CathedralError with the code and whose failure it was', async () => {
    route('POST', '/v1/sandboxes', () => ({
      status: 422,
      body: { error: 'Spend limit too low.', failed_by: 'you', billed: false, detail: { error: 'sandbox_spend_limit_too_low' } },
    }));
    const error = await provider().sandbox.create().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).toMatch(/422 sandbox_spend_limit_too_low, failed_by=you/);
  });
});

describe('sandbox operations', () => {
  async function running(extra: Record<string, unknown> = {}) {
    route('POST', '/v1/sandboxes', () => ({ status: 202, body: sandboxDoc('running') }));
    return provider(extra).sandbox.create({ envs: { FROM_CREATE: '1' } });
  }

  it('runs a shell command through /exec and maps the result', async () => {
    route('POST', `/v1/sandboxes/${SANDBOX_ID}/exec`, () => ({
      status: 200,
      body: { exit_code: 0, stdout: 'v22.11.0\n', stderr: '', duration_ms: 12, stdout_truncated: false, stderr_truncated: false, timed_out: false },
    }));
    const sandbox = await running();
    const result = await sandbox.runCommand('node -v', { cwd: '/work', env: { A: 'b' } });
    expect(result).toEqual({ stdout: 'v22.11.0\n', stderr: '', exitCode: 0, durationMs: 12 });
    const exec = calls.find((c) => c.url.pathname.endsWith('/exec'))!;
    expect(exec.body).toEqual({ command: 'node -v', cwd: '/work', env: { FROM_CREATE: '1', A: 'b' }, timeout_seconds: 45 });
    expect(exec.headers['Idempotency-Key']).toMatch(/^computesdk-x-/);
  });

  it('passes non-zero exit codes through', async () => {
    route('POST', `/v1/sandboxes/${SANDBOX_ID}/exec`, () => ({
      status: 200,
      body: { exit_code: 127, stdout: '', stderr: 'sh: nope: not found\n', duration_ms: 3, stdout_truncated: false, stderr_truncated: false, timed_out: false },
    }));
    const sandbox = await running();
    const result = await sandbox.runCommand('nope');
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toContain('not found');
  });

  it('runs commands longer than 45 s in the background and long-polls for the result', async () => {
    route('POST', `/v1/sandboxes/${SANDBOX_ID}/execs`, () => ({ status: 202, body: { exec_id: 'e1', state: 'running', exit_code: null, stdout: '', stderr: '', duration_ms: null } }));
    let polls = 0;
    route('GET', `/v1/sandboxes/${SANDBOX_ID}/execs/e1`, (call) => {
      polls += 1;
      expect(call.url.searchParams.get('wait')).toBe('25');
      return polls < 2
        ? { status: 200, body: { exec_id: 'e1', state: 'running', exit_code: null, stdout: '', stderr: '', duration_ms: null } }
        : { status: 200, body: { exec_id: 'e1', state: 'exited', exit_code: 0, stdout: 'done\n', stderr: '', duration_ms: 61000 } };
    });
    const sandbox = await running();
    const result = await sandbox.runCommand('sleep 61; echo done', { timeout: 120_000 });
    expect(result).toMatchObject({ stdout: 'done\n', exitCode: 0, durationMs: 61000 });
    const start = calls.find((c) => c.url.pathname.endsWith('/execs'))!;
    expect(start.body).toMatchObject({ timeout_seconds: 120 });
    expect(start.headers['Idempotency-Key']).toBeDefined();
  });

  it('throws when a background exec is lost rather than inventing an exit code', async () => {
    route('POST', `/v1/sandboxes/${SANDBOX_ID}/execs`, () => ({ status: 202, body: { exec_id: 'e2', state: 'running', exit_code: null, stdout: '', stderr: '', duration_ms: null } }));
    route('GET', `/v1/sandboxes/${SANDBOX_ID}/execs/e2`, () => ({ status: 200, body: { exec_id: 'e2', state: 'lost', exit_code: null, failed_by: 'cathedral', stdout: '', stderr: '', duration_ms: null } }));
    const sandbox = await running();
    await expect(sandbox.runCommand('long', { timeout: 100_000 })).rejects.toThrow(/state lost.*failed_by=cathedral/);
  });

  it('does not resend an exec whose outcome is unknown', async () => {
    let posts = 0;
    route('POST', `/v1/sandboxes/${SANDBOX_ID}/exec`, () => {
      posts += 1;
      return { status: 502, body: { error: 'Outcome unknown.', failed_by: 'cathedral', detail: { error: 'exec_outcome_unknown', replay_safe: false } } };
    });
    const sandbox = await running();
    await expect(sandbox.runCommand('echo once')).rejects.toBeInstanceOf(CathedralError);
    expect(posts).toBe(1);
  });

  it('reads and writes files natively and checks existence with stat', async () => {
    route('PUT', `/v1/sandboxes/${SANDBOX_ID}/files`, () => ({ status: 204 }));
    route('GET', `/v1/sandboxes/${SANDBOX_ID}/files`, (call) =>
      call.url.searchParams.get('path') === '/tmp/a.txt' ? { status: 200, text: 'hello' } : { status: 404, body: { detail: { error: 'file_not_found' } } },
    );
    route('GET', `/v1/sandboxes/${SANDBOX_ID}/stat`, (call) =>
      call.url.searchParams.get('path') === '/tmp/a.txt'
        ? { status: 200, body: { is_file: true, is_dir: false, size: 5, mode: 420 } }
        : { status: 404, body: { detail: { error: 'file_not_found' } } },
    );
    const sandbox = await running();
    await sandbox.filesystem.writeFile('/tmp/a.txt', 'hello');
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.url.searchParams.get('path')).toBe('/tmp/a.txt');
    expect(put.headers['Content-Type']).toBe('application/octet-stream');
    expect(put.body).toBe('hello');
    expect(await sandbox.filesystem.readFile('/tmp/a.txt')).toBe('hello');
    await expect(sandbox.filesystem.readFile('/tmp/missing')).rejects.toThrow(/ENOENT/);
    expect(await sandbox.filesystem.exists('/tmp/a.txt')).toBe(true);
    expect(await sandbox.filesystem.exists('/tmp/missing')).toBe(false);
  });

  it('parses readdir output and quotes paths for the shell', async () => {
    route('POST', `/v1/sandboxes/${SANDBOX_ID}/exec`, () => ({
      status: 200,
      body: { exit_code: 0, stdout: 'd\t4096\t1700000000\tsub dir\nf\t5\t1700000001\ta.txt\n', stderr: '', duration_ms: 4 },
    }));
    const sandbox = await running();
    const entries = await sandbox.filesystem.readdir('/tmp/my dir');
    expect(entries).toEqual([
      { name: 'sub dir', type: 'directory', size: 4096, modified: new Date(1700000000 * 1000) },
      { name: 'a.txt', type: 'file', size: 5, modified: new Date(1700000001 * 1000) },
    ]);
    const exec = calls.find((c) => c.url.pathname.endsWith('/exec'))!;
    expect((exec.body as { command: string }).command).toContain('cd "/tmp/my dir"');
  });

  it('getInfo maps states', async () => {
    const sandbox = await running();
    route('GET', `/v1/sandboxes/${SANDBOX_ID}`, () => ({ status: 200, body: sandboxDoc('failed') }));
    expect((await sandbox.getInfo()).status).toBe('error');
  });

  it('getUrl explains that inbound ports are not offered', async () => {
    const sandbox = await running();
    await expect(sandbox.getUrl({ port: 3000 })).rejects.toThrow(/do not expose inbound ports/);
  });

  it('destroy sends DELETE with an Idempotency-Key and treats 404 as done', async () => {
    route('DELETE', `/v1/sandboxes/${SANDBOX_ID}`, () => ({ status: 404, body: { detail: { error: 'sandbox_not_found' } } }));
    const sandbox = await running();
    await sandbox.destroy();
    const del = calls.find((c) => c.method === 'DELETE')!;
    expect(del.headers['Idempotency-Key']).toMatch(/^computesdk-d-/);
  });
});

describe('collection operations', () => {
  it('getById returns null for an unknown sandbox', async () => {
    route('GET', /^\/v1\/sandboxes\/[^/]+$/, () => ({ status: 404, body: { detail: { error: 'sandbox_not_found' } } }));
    expect(await provider().sandbox.getById(SANDBOX_ID)).toBeNull();
  });

  it('list pages through running sandboxes', async () => {
    route('GET', '/v1/sandboxes', (call) =>
      call.url.searchParams.get('offset') === '0'
        ? { status: 200, body: { sandboxes: [sandboxDoc('running')], has_more: true } }
        : { status: 200, body: { sandboxes: [sandboxDoc('running', { id: 'aaaaaaaa-2222-4333-8444-555555555555' })], has_more: false } },
    );
    const all = await provider().sandbox.list();
    expect(all.map((s) => s.sandboxId)).toEqual([SANDBOX_ID, 'aaaaaaaa-2222-4333-8444-555555555555']);
    expect(calls.every((c) => c.url.searchParams.get('state') === 'running')).toBe(true);
  });
});

describe('snapshots', () => {
  it('creates a snapshot, waits for ready, lists and deletes it', async () => {
    let gets = 0;
    const snap = (state: string) => ({ id: 'snap_1', state, source_sandbox_id: SANDBOX_ID, template: 'node-22', labels: {}, created_at: '2026-10-01T00:00:00Z', expires_at: '2026-10-02T00:00:00Z', ready_at: null, error: null, disk_gib: 1, resources: {} });
    route('POST', `/v1/sandboxes/${SANDBOX_ID}/snapshots`, () => ({ status: 202, body: snap('creating') }));
    route('GET', '/v1/snapshots/snap_1', () => {
      gets += 1;
      return { status: 200, body: snap('ready') };
    });
    route('GET', '/v1/snapshots', () => ({ status: 200, body: { snapshots: [snap('ready')], next_cursor: null } }));
    route('DELETE', '/v1/snapshots/snap_1', () => ({ status: 202, body: snap('deleting') }));

    const p = provider();
    const created = await p.snapshot!.create(SANDBOX_ID, { name: 'base' });
    expect(created).toMatchObject({ id: 'snap_1', provider: 'cathedral', metadata: { state: 'ready', sourceSandboxId: SANDBOX_ID } });
    expect(gets).toBe(1);
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.headers['Idempotency-Key']).toMatch(/^computesdk-s-/);
    expect(post.body).toEqual({ labels: { name: 'base' } });

    expect((await p.snapshot!.list()).map((s) => s.id)).toEqual(['snap_1']);
    await p.snapshot!.delete('snap_1');
    expect(calls.some((c) => c.method === 'DELETE' && c.url.pathname === '/v1/snapshots/snap_1')).toBe(true);
  });
});
