// SSRF guard for the app widget's health probe. The probe runs on the board server with
// its network position (tailnet, LAN, localhost, cloud metadata on a VM), so every hop is
// checked here before a socket is opened, and the connection is pinned to the address
// that was checked (no DNS rebinding between check and connect).
//
// Order, first match wins:
//   1. hard deny (never overridable): cloud metadata and link-local (169.254.0.0/16 incl.
//      169.254.169.254, fe80::/10, fd00:ec2::254, 100.100.100.200), unspecified (0.0.0.0/8,
//      ::), multicast and broadcast, and metadata host names (metadata.google.internal …);
//   2. the operator's deny list (BUNNY_APP_WIDGET_DENY);
//   3. the operator's allow list (BUNNY_APP_WIDGET_ALLOW), which can open loopback;
//   4. default: loopback (127.0.0.0/8, ::1, so the board's own host and the Paseo daemon)
//      denied; everything else allowed, including LAN ranges and the tailnet (100.64.0.0/10,
//      fd7a:115c:a1e0::/48), where self-hosted apps live.
// Lists are comma separated CIDRs, IPs or host names ("*.example.com" matches subdomains).

import dns from "node:dns";
import net from "node:net";

export interface AppPolicy {
  allow: string[];
  deny: string[];
}

export class BlockedError extends Error {
  readonly code = "BLOCKED";
}

const HARD_V4 = ["169.254.0.0/16", "0.0.0.0/8", "100.100.100.200/32", "224.0.0.0/4", "240.0.0.0/4", "192.0.0.0/24"];
const HARD_V6 = ["fe80::/10", "fd00:ec2::254/128", "ff00::/8", "::/128"];
const HARD_NAMES = ["metadata", "metadata.google.internal", "metadata.goog", "metadata.azure.internal", "instance-data", "instance-data.ec2.internal", "metadata.tencentyun.com", "metadata.platformequinix.com"];
const LOOPBACK_V4 = ["127.0.0.0/8"];
const LOOPBACK_V6 = ["::1/128"];

function blockList(cidrs: string[]): net.BlockList {
  const b = new net.BlockList();
  for (const c of cidrs) {
    const [addr, bits] = c.split("/");
    const type = net.isIPv6(addr) ? "ipv6" : "ipv4";
    if (bits === undefined) b.addAddress(addr, type);
    else b.addSubnet(addr, Number(bits), type);
  }
  return b;
}

const hardList = blockList([...HARD_V4, ...HARD_V6]);
const loopList = blockList([...LOOPBACK_V4, ...LOOPBACK_V6]);

// ::ffff:a.b.c.d (IPv4-mapped) and 64:ff9b::/96 (NAT64) embed an IPv4 address: judge that.
export function unwrapIp(ip: string): string {
  const s = ip.toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const mapped = s.match(/^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return mapped[1];
  const hex = s.match(/^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const a = parseInt(hex[1], 16);
    const b = parseInt(hex[2], 16);
    return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  }
  return s;
}

interface Rules {
  list: net.BlockList;
  names: string[];
}

function rules(items: string[]): Rules {
  const cidrs: string[] = [];
  const names: string[] = [];
  for (const raw of items) {
    const it = raw.trim().toLowerCase();
    if (!it) continue;
    const [addr] = it.split("/");
    if (net.isIP(addr)) cidrs.push(it);
    else names.push(it.replace(/\.$/, ""));
  }
  return { list: blockList(cidrs), names };
}

const nameMatch = (names: string[], host: string) => names.some((n) => (n.startsWith("*.") ? host.endsWith(n.slice(1)) : host === n));
const ipMatch = (r: Rules, ip: string) => r.list.check(ip, net.isIPv6(ip) ? "ipv6" : "ipv4");

export interface Guard {
  // Throws BlockedError for a host name that may never be probed (before DNS).
  checkHost(hostname: string): void;
  // Throws BlockedError when this resolved address may not be probed for that host.
  checkAddress(hostname: string, address: string): void;
  // A dns.lookup replacement for http.request: resolves, checks every address, and
  // connects only to an allowed one.
  lookup: net.LookupFunction;
}

export function policyFromEnv(env: NodeJS.ProcessEnv = process.env): AppPolicy {
  const split = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return { allow: split(env.BUNNY_APP_WIDGET_ALLOW), deny: split(env.BUNNY_APP_WIDGET_DENY) };
}

export function createGuard(policy: AppPolicy = { allow: [], deny: [] }, resolve: typeof dns.lookup = dns.lookup): Guard {
  const deny = rules(policy.deny);
  const allow = rules(policy.allow);
  const norm = (h: string) => h.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const checkHost = (hostname: string) => {
    const h = norm(hostname);
    if (HARD_NAMES.includes(h)) throw new BlockedError(`blocked: ${h} is a cloud metadata host`);
    if (nameMatch(deny.names, h)) throw new BlockedError(`blocked: ${h} is on the deny list`);
    if (net.isIP(h)) checkAddress(h, h);
  };
  const checkAddress = (hostname: string, address: string) => {
    const h = norm(hostname);
    const ip = unwrapIp(address);
    if (!net.isIP(ip)) throw new BlockedError(`blocked: ${address} is not an IP address`);
    const type = net.isIPv6(ip) ? "ipv6" : "ipv4";
    if (hardList.check(ip, type)) throw new BlockedError(`blocked: ${ip} is a metadata, link-local or reserved address`);
    if (ipMatch(deny, ip)) throw new BlockedError(`blocked: ${ip} is on the deny list`);
    if (ipMatch(allow, ip) || nameMatch(allow.names, h)) return;
    if (loopList.check(ip, type)) throw new BlockedError(`blocked: ${ip} is loopback (allow it with BUNNY_APP_WIDGET_ALLOW)`);
  };
  const lookup: net.LookupFunction = (hostname, options, callback) => {
    try {
      checkHost(hostname);
    } catch (e) {
      callback(e as NodeJS.ErrnoException, "", 4);
      return;
    }
    resolve(hostname, { ...(options as dns.LookupOptions), all: true }, (err, addresses) => {
      if (err) return callback(err, "", 4);
      const list = addresses as unknown as dns.LookupAddress[];
      let firstErr: Error | null = null;
      const ok: dns.LookupAddress[] = [];
      for (const a of list) {
        try {
          checkAddress(hostname, a.address);
          ok.push(a);
        } catch (e) {
          firstErr ??= e as Error;
        }
      }
      // One blocked address blocks the name: a host that resolves to both a public and a
      // metadata address is an attack, not a load balancer.
      if (firstErr || !ok.length) return callback((firstErr ?? new BlockedError(`blocked: ${hostname} resolved to nothing`)) as NodeJS.ErrnoException, "", 4);
      if ((options as dns.LookupOptions).all) return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, ok);
      callback(null, ok[0].address, ok[0].family);
    });
  };
  return { checkHost, checkAddress, lookup };
}
