// "Use cloud agent": which cloud builder writes the code (skills/cloud-dev, bin/cloud-task).
// This is not the frame conversation's own provider/model (the conductor); it is the
// cloud service the conductor dispatches code changes to.

export const CLOUD_PROVIDERS = ["claude", "codex"] as const;
export type CloudProvider = (typeof CLOUD_PROVIDERS)[number];

export const CLOUD_PROVIDER_LABEL: Record<CloudProvider, string> = { claude: "Claude", codex: "Codex" };

export const isCloudProvider = (v: unknown): v is CloudProvider => typeof v === "string" && (CLOUD_PROVIDERS as readonly string[]).includes(v);

// The builder a create request asks for: null for a local (unchecked) start, the named
// builder when cloud, Claude when an older client sent cloud:true without one. Anything
// else is an error, never quietly another provider.
export function requestedCloudProvider(req: { cloud?: unknown; cloudProvider?: unknown }): CloudProvider | null {
  if (req.cloud !== undefined && typeof req.cloud !== "boolean") throw new Error(`invalid cloud flag ${JSON.stringify(req.cloud)}; expected true or false`);
  if (req.cloud !== true) {
    if (req.cloudProvider !== undefined) throw new Error(`cloudProvider ${JSON.stringify(req.cloudProvider)} needs "Use cloud agent" (cloud: true)`);
    return null;
  }
  if (req.cloudProvider === undefined) return "claude";
  if (!isCloudProvider(req.cloudProvider)) throw new Error(`invalid cloud builder ${JSON.stringify(req.cloudProvider)}; expected ${CLOUD_PROVIDERS.join(" or ")}`);
  return req.cloudProvider;
}

// A bound frame's builder: frames bound before the choice existed (cloud:true only) used
// Claude. null for a local frame, and for a stored value that is not a known builder.
export function frameCloudProvider(paseo: { cloud?: unknown; cloudProvider?: unknown } | undefined): CloudProvider | null {
  if (paseo?.cloud !== true) return null;
  if (paseo.cloudProvider === undefined) return "claude";
  return isCloudProvider(paseo.cloudProvider) ? paseo.cloudProvider : null;
}
