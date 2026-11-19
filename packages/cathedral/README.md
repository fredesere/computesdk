# @computesdk/cathedral

[Cathedral](https://cathedral.computer) provider for ComputeSDK. Cathedral runs sandboxes for evals, graders and agents: create one from a catalog template, an imported image or a snapshot, run commands, move files, snapshot it and fork from the snapshot.

## Installation & Setup

```bash
npm install @computesdk/cathedral
```

Add your Cathedral API key to a `.env` file:

```bash
CATHEDRAL_API_KEY=cat_sk_your_key
# Optional: the size to create (sealed-1x2, sealed-2x4, sealed-4x8, sealed-8x16).
# Default: the catalog's default sealed size.
CATHEDRAL_TEMPLATE=sealed-2x4
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
  /** Size or catalog template used when create() gets no templateId. Falls back to CATHEDRAL_TEMPLATE, then the default sealed size */
  template?: string;
  /** deny_all (default), internet or allowlist, where the template offers it */
  network?: 'deny_all' | 'internet' | 'allowlist';
  /** Destinations that narrow an allowlist template's egress */
  egressAllowlist?: string[];
  /** Spend ceiling per sandbox in USD. Falls back to CATHEDRAL_MAX_SPEND_USD, then the size's rate x lifetime plus a quarter */
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
| `image` | `image` (a public image by digest, such as `node@sha256:...`; runs inside the chosen size) |
| `imageId` | `image_id` (an image imported or built with `/v1/images`) |
| `timeout` | `lifetime_seconds` (60 s to 23 h); the sandbox is deleted at the deadline |
| `metadata`, `name` | `labels` (keys and values the API accepts; others are dropped) |
| `envs` | applied to every command, since Cathedral sets env per command |

## Behaviour worth knowing

- **Sealed sizes.** With no `templateId`, `create()` takes the catalog's default sealed size and asks for `amd_sev_snp` hardware: a gVisor sandbox inside an AMD SEV-SNP confidential VM. Sizes and hourly rates are in `GET /v1/sandboxes/catalog`. A create answers once the sandbox runs, in about 2 to 3 seconds when the host already has the image; the first create of a new image on a host waits for the pull.
- **Default image.** The default sealed image has Python 3.12 and no Node.js. Pass a Node image by digest for Node work.
- **Files.** The filesystem methods use the files API under `/work`, the working directory. Paths elsewhere (`/tmp`, `/root`) go through a command, so every path works.
- **Commands.** `runCommand` runs a shell string through `POST /v1/sandboxes/{id}/exec`. Commands with a `timeout` over 45 seconds start in the background and are long-polled to completion; `background: true` starts and returns at once.
- **At most once.** Every create, delete, exec, snapshot and file write carries an `Idempotency-Key`, so a request whose response was lost is resent without running twice. An exec whose outcome is unknown is never resent.
- **No port URLs yet.** `getUrl` is not supported on sealed sandboxes yet; move data with the filesystem methods.
- **Errors say whose failure it was.** Errors are `CathedralError` with `status`, `code` and `failedBy` (`you` or `cathedral`).

## Testing

```bash
pnpm --filter @computesdk/cathedral run test        # unit tests, mocked HTTP
CATHEDRAL_API_KEY=cat_sk_... pnpm --filter @computesdk/cathedral run test   # plus live integration
```
