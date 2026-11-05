// Which machine the board's own (local) agents run on, for the phone tiles' "Claude · <machine>".
// The board server is not always that machine: in the split deployment (docs/split-runtime.md)
// the board runs on a VPS and the agents on an M1 through its Paseo daemon. So, in order:
// - the hostname the Paseo daemon reports about itself (its server_info);
// - BUNNY_RUNTIME_HOSTNAME, which the split deployment sets to the M1's hostname;
// - otherwise null: unknown, and the phone leaves the machine out rather than naming the
//   board server. Agents on other machines carry their own host in the binding (meta.paseo.host).
export function agentMachine(reported: string | null | undefined, runtimeHostname: string | null | undefined): string | null {
  for (const name of [reported, runtimeHostname]) {
    const clean = typeof name === "string" ? name.trim().replace(/\.local$/i, "") : "";
    if (clean) return clean;
  }
  return null;
}
