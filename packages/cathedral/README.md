# @computesdk/cathedral

[Cathedral](https://cathedral.computer) provider for ComputeSDK. Cathedral runs sandboxes for evals, graders and agents: create one from a catalog template, an imported image or a snapshot, run commands, move files, snapshot it and fork from the snapshot.

## Installation & Setup

```bash
npm install @computesdk/cathedral
```

Add your Cathedral API key to a `.env` file:

```bash
CATHEDRAL_API_KEY=cat_sk_your_key
# Optional: the catalog template to create from (default: first template in your catalog)
CATHEDRAL_TEMPLATE=your_template_name
```

Get a key at [cathedral.computer/account](https://cathedral.computer/account/). An agent can also request one for its person to approve: see [cathedral.computer/agents.md](https://cathedral.computer/agents.md).

## Usage

```typescript
import { cathedral } from '@computesdk/cathedral';

const compute = cathedral({
  apiKey: process.env.CATHEDRAL_API_KEY,
  template: process.env.CATHEDRAL_TEMPLATE,
});

// Create a sandbox (waits until it is running)
const sandbox = await compute.sandbox.create({ timeout: 15 * 60 * 1000 });

// Run a command
const result = await sandbox.runCommand('echo "Hello from Cathedral!"');
console.log(result.stdout);

// Files
await sandbox.filesystem.writeFile('/tmp/input.txt', 'data');
console.log(await sandbox.filesystem.readFile('/tmp/input.txt'));

// Snapshot, then fork a new sandbox from it
const snapshot = await compute.snapshot!.create(sandbox.sandboxId);
const fork = await compute.sandbox.create({ snapshotId: snapshot.id });

// Clean up
await fork.destroy();
await sandbox.destroy();
await compute.snapshot!.delete(snapshot.id);
```

### Configuration Options

```typescript
interface CathedralConfig {
  /** Cathedral API key (cat_sk_...). Falls back to CATHEDRAL_API_KEY */
  apiKey?: string;
  /** API origin. Falls back to CATHEDRAL_BASE_URL, then https://cathedral.computer */
  baseUrl?: string;
  /** Catalog template used when create() gets no templateId. Falls back to CATHEDRAL_TEMPLATE */
  template?: string;
  /** deny_all (default), internet or allowlist, where the template offers it */
  network?: 'deny_all' | 'internet' | 'allowlist';
  /** Destinations that narrow an allowlist template's egress */
  egressAllowlist?: string[];
  /** Spend ceiling per sandbox in USD; must cover rate x lifetime. Default "1.00" */
  maxSpendUsd?: string | number;
  /** Default sandbox lifetime in ms. Default 1 hour */
  timeout?: number;
  /** Labels added to every sandbox */
  labels?: Record<string, string>;
  /** Act for a team. Falls back to CATHEDRAL_TEAM_ID */
  teamId?: string;
  /** How long create() waits for the sandbox to run. Default 10 minutes */
  createTimeoutMs?: number;
}
```

## Create options

| Option | Maps to |
|---|---|
| `templateId` | `template` (catalog template name) |
| `snapshotId` | `snapshot_id` (a fork) |
| `image` | `image` (a catalog image) |
| `imageId` | `image_id` (an image imported or built with `/v1/images`) |
| `timeout` | `lifetime_seconds` (60 s to 23 h); the sandbox is deleted at the deadline |
| `metadata`, `name` | `labels` (keys and values the API accepts; others are dropped) |
| `envs` | applied to every command, since Cathedral sets env per command |

## Behaviour worth knowing

- **Standard VMs.** Sandboxes run on the account's own Standard VM (up to 13 sandboxes per VM). A create with no VM that has room starts one, which takes about 5 to 6 minutes; `create()` waits for it (up to `createTimeoutMs`). Later creates join the running VM. A VM releases itself 15 minutes after its last sandbox ends.
- **Commands.** `runCommand` runs a shell string through `POST /v1/sandboxes/{id}/exec`. Commands with a `timeout` over 45 seconds start in the background and are long-polled to completion; `background: true` starts and returns at once.
- **At most once.** Every create, delete, exec, snapshot and file write carries an `Idempotency-Key`, so a request whose response was lost is resent without running twice. An exec whose outcome is unknown is never resent.
- **No inbound ports.** `getUrl` is not supported; move data with the filesystem methods.
- **Errors say whose failure it was.** Errors are `CathedralError` with `status`, `code` and `failedBy` (`you` or `cathedral`).

## Testing

```bash
pnpm --filter @computesdk/cathedral run test        # unit tests, mocked HTTP
CATHEDRAL_API_KEY=cat_sk_... pnpm --filter @computesdk/cathedral run test   # plus live integration
```
