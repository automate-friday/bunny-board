import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPaseoApi } from "@getpaseo/client";
import { withDaemonRead } from "./daemon-health";
// Access to Paseo from the long-lived board server.
//
// The plugin server context only hands out its PaseoApi inside hook and RPC
// invocations. The board server needs it from startup (to fulfil frame requests
// written into the document), so on boot it opens an auxiliary daemon connection
// and calls its own plugin RPC "board.bootstrap", whose handler captures the
// plugin-session PaseoApi. That API is the one allowed to timeline.append.
// The auxiliary connection stays open for operations the PaseoApi lacks
// (updateAgent for names and labels).

import { hostOperation, daemonFailureReason } from "./daemon-health";
import type { PaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";

export function localDaemonUrl(fallback:string,home=process.env.PASEO_HOME??path.join(os.homedir(),'.paseo')):string {
  try{
    const {listen}=JSON.parse(readFileSync(path.join(home,'paseo.pid'),'utf8'));
    if(typeof listen!=='string'||!/^(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]|\[::\]):[1-9]\d{0,4}$/.test(listen))return fallback;
    const url=new URL(`ws://${listen}/ws`);if(Number(url.port)>65535)return fallback;
    if(url.hostname==='0.0.0.0'||url.hostname==='[::]')url.hostname='127.0.0.1';
    return url.toString();
  }catch{return fallback;}
}

export type AgentStatus = "idle" | "running" | "needs-permission" | "archived" | "error" | "missing";

export class PaseoBridge {
  private paseo: PaseoApi | null = null;
  private resolveReady!: (p: PaseoApi) => void;
  readonly ready: Promise<PaseoApi>;
  aux: DaemonClient | null = null;
  private stopped = false;
  private auxApi:PaseoApi|null=null;
  private endpointTimer:ReturnType<typeof setInterval>|null=null;
  private checkingEndpoint=false;
  get readApi(){return this.auxApi;}
  private started:Promise<void>|null=null;
  private connectedBefore=false;
  private transportUp=false;
  private downAt=Date.now();
  private offStatus:(()=>void)|null=null;
  onHealth:(()=>void)|null=null;
  // Connected means the board's own daemon socket is up: sends, reads and timeline checks
  // all go over it. The plugin API (captured by the board.bootstrap plugin RPC, which a
  // busy daemon times out) is not needed to deliver a message, so it does not gate health.
  health(){
    const connected=!this.stopped && !!this.aux?.isConnected;
    const state=connected?'connected':this.stopped||this.aux?.authFailureReason||Date.now()-this.downAt>30000?'failed':this.connectedBefore?'reconnecting':'connecting';
    return {host:new URL(this.daemonUrl).host,state,message:connected?'Paseo host connected':'Paseo host unavailable. Messages remain queued until recovery.',queueing:!connected,retryAfterMs:2000,...(this.aux?.lastError?{reason:daemonFailureReason(Error(this.aux.lastError))}:{})};
  }
  ensureConnected(verify=false){if(!this.stopped)this.aux?.ensureConnected({verify});}


  constructor(
    private readonly pluginId: string,
    private daemonUrl: string,
    private readonly log: (msg: string) => void,
    private readonly resolveUrl?:()=>string,
  ) {
    this.ready = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
  }

  capture(paseo: PaseoApi): void {
    if (this.paseo) return;
    this.paseo = paseo;
    this.log("paseo API captured");
    this.resolveReady(paseo);
    this.onHealth?.();
  }

  get api(): PaseoApi | null {
    return this.paseo;
  }

  start():Promise<void> {
    if(!this.endpointTimer&&this.resolveUrl){this.endpointTimer=setInterval(()=>void this.refreshEndpoint(),5000);this.endpointTimer.unref();}
    if(!this.started)this.started=this.startOnce().finally(()=>{this.started=null;});
    return this.started;
  }
  private async refreshEndpoint(){
    if(this.stopped||this.checkingEndpoint||this.aux?.isConnected||!this.resolveUrl)return;
    const next=this.resolveUrl();if(next===this.daemonUrl)return;
    this.checkingEndpoint=true;
    try{
      this.offStatus?.();this.offStatus=null;
      const old=this.aux;this.aux=null;this.auxApi=null;this.daemonUrl=next;
      await old?.close();this.onHealth?.();void this.start();
    }finally{this.checkingEndpoint=false;}
  }
  private async startOnce(): Promise<void> {
    if(this.resolveUrl&&!this.aux)this.daemonUrl=this.resolveUrl();
    for (let attempt = 1; !this.stopped; attempt++) {
      const finish = hostOperation(this.log, new URL(this.daemonUrl).host, attempt === 1 ? "connect" : "reconnect");
      try {
        if (!this.aux) {
          this.aux = new DaemonClient({
            url: this.daemonUrl,
            clientId: `board-aux-${process.pid}`,
            clientType: "cli",
            appVersion: "0.11.4",
            connectTimeoutMs: 8000,
            reconnect: { enabled: true },
          });
          this.auxApi=createPaseoApi(this.aux);
          this.offStatus=this.aux.subscribeConnectionStatus((state)=>{
            if(state.status==='connected'){this.connectedBefore=true;this.transportUp=true;}
            else if(this.transportUp){this.downAt=Date.now();this.transportUp=false;}
            this.log(`host-connection ${JSON.stringify({ host: new URL(this.daemonUrl).host, state:state.status, ...(state.status==='connecting'?{attempt:state.attempt}:{}), reason: this.aux?.lastError ? daemonFailureReason(Error(this.aux.lastError)) : null })}`);
            this.onHealth?.();
          });
        }
        await withDaemonRead(()=>this.aux!.connect());
        if (!this.paseo) await this.aux.invokePluginRpc(this.pluginId, "board.bootstrap", {});
        finish();
        return;
      } catch (e) {
        finish(e);
        this.log(`bootstrap attempt ${attempt} failed: ${daemonFailureReason(e)}`);
        await new Promise((r) => setTimeout(r, Math.min(5000, 500 * attempt)));
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if(this.endpointTimer)clearInterval(this.endpointTimer);this.endpointTimer=null;
    this.offStatus?.();this.offStatus=null;
    await this.auxApi?.dispose().catch(()=>undefined);
    await this.aux?.close().catch(() => undefined);
    this.aux = null;this.auxApi=null;
  }

  // Abort the agent's current turn (the PaseoApi handle has no cancel).
  async cancelAgent(agentId: string): Promise<void> {
    if (!this.aux) throw new Error("daemon connection not ready");
    await this.aux.cancelAgent(agentId);
  }

  async updateAgent(agentId: string, updates: { name?: string; labels?: Record<string, string> }): Promise<void> {
    if (!this.aux) return;
    await this.aux.updateAgent(agentId, updates);
  }
}

// biome-ignore lint/suspicious/noExplicitAny: agent snapshot payload from the SDK.
export function statusOf(agent: any | null | undefined): AgentStatus {
  if (!agent) return "missing";
  if (agent.archivedAt) return "archived";
  if (Array.isArray(agent.pendingPermissions) && agent.pendingPermissions.length > 0) return "needs-permission";
  // A terminal failure can retain the previous turn while the provider unwinds.
  // It must not keep the UI or message queue waiting on that dead turn.
  if (agent.status === "error") return "error";
  if (agentBusy(agent)) return "running";
  return "idle";
}

// Share the turn predicate with delivery and lifecycle projection. Historical
// lastError alone is not terminal: a later turn may already be running.
export function agentBusy(agent: {status?: string; activeTurn?: unknown; archivedAt?: unknown} | null | undefined): boolean {
  return !!agent && !agent.archivedAt && agent.status !== "error" &&
    (agent.status === "running" || agent.status === "initializing" || !!agent.activeTurn);
}
