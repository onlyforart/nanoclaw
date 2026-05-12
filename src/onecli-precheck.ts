/**
 * OneCLI startup gate (K.1.h A.5).
 *
 * Refuses to start the host process if the OneCLI credential gateway is
 * not reachable. Operator stance (`feedback_credential_plane_onecli`):
 * the agent must never see raw credentials; the host MUST route through
 * OneCLI. Silent degradation is unacceptable — better to fail boot than
 * spawn a container that 401s its way through the agent's first message
 * with no clear cause.
 *
 * Probe shape: the `@onecli-sh/sdk` (v0.3.1) does NOT expose a `health()`
 * method. The cheapest authenticated round-trip is `ensureAgent` — which
 * is also idempotent + already used by `host-llm.ts` later in boot. We
 * register a probe agent (`nanoclaw-host-precheck`) here so the call has
 * a stable identifier even on a fresh OneCLI install.
 *
 * Called from `src/index.ts` as the very first async step in `main()`,
 * before DB init / channels / plugins.
 */
import { OneCLI } from '@onecli-sh/sdk';

import { log } from './log.js';

const PROBE_AGENT_ID = 'nanoclaw-host-precheck';

export async function preflightOneCLI(): Promise<void> {
  const url = process.env.ONECLI_URL;
  const apiKey = process.env.ONECLI_API_KEY;

  if (!url || !apiKey) {
    log.fatal(
      'OneCLI gateway not configured: ONECLI_URL and/or ONECLI_API_KEY are missing. ' +
        'NanoClaw v2 requires the OneCLI credential gateway — agents must not see ' +
        'raw API keys. Run /init-onecli to install + populate the vault, then set ' +
        'ONECLI_URL + ONECLI_API_KEY in .env. Refusing to start.',
      { hasUrl: Boolean(url), hasApiKey: Boolean(apiKey) },
    );
    process.exit(1);
    return;
  }

  const onecli = new OneCLI({ url, apiKey });
  try {
    await onecli.ensureAgent({ name: PROBE_AGENT_ID, identifier: PROBE_AGENT_ID });
    log.info('OneCLI gateway reachable', { url, probeAgent: PROBE_AGENT_ID });
  } catch (err) {
    log.fatal(
      'OneCLI gateway unreachable. NanoClaw v2 refuses to start without the ' +
        'credential proxy — agents must not see raw credentials. Check that ' +
        'the OneCLI daemon is running at ONECLI_URL and that ONECLI_API_KEY is valid.',
      { url, err },
    );
    process.exit(1);
  }
}
