import { closeSync, existsSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
export function readArtifactFile(p: string | undefined, stateDir: string, max = 20 * 1024 * 1024): Buffer {
    if (!p || !path.isAbsolute(p) || !existsSync(p)) throw new Error("board_add_artifact needs an absolute path to an existing file, or a url");
    const st = lstatSync(p);
    if (st.isSymbolicLink()) throw new Error("artifact path is a symlink; pass the real file");
    if (!st.isFile()) throw new Error("artifact path is not a regular file");
    if (st.size === 0 || st.size > max) throw new Error(`artifact must be between 1 byte and ${Math.round(max / 1024 / 1024)} MB`);
    // Resolve symlinked folders too (lstat only covers the last path segment); macOS
    // paths are case-insensitive, so compare lowercased.
    let real: string;
    try {
      real = realpathSync(p);
    } catch {
      throw new Error(`cannot resolve ${p}`);
    }
    const home = (() => {
      try {
        return realpathSync(os.homedir());
      } catch {
        return os.homedir();
      }
    })();
    const lower = (s: string) => s.toLowerCase();
    const denied = [
      stateDir,
      ...[".ssh", ".aws", ".gnupg", ".paseo", ".docker", ".kube", ".netrc", ".npmrc", ".pypirc", ".git-credentials", path.join(".config", "gh"), path.join(".config", "gcloud"), path.join(".claude", ".credentials.json"), path.join(".codex", "auth.json"), "Library/Keychains"].map((d) => path.join(home, d)),
    ].map((d) => {
      try {
        return lower(realpathSync(d));
      } catch {
        return lower(d);
      }
    });
    const lr = lower(real);
    const base = path.basename(real);
    if (denied.some((d) => lr === d || lr.startsWith(`${d}${path.sep}`)) || /^\.env(\.|$)|^id_[a-z0-9]+$|\.(pem|key|p12|pfx|keychain)$|^secrets?(\.|$)|credentials/i.test(base))
      throw new Error(`refusing to put ${p} on the board: it looks like a secret (files on the board are served to anyone on the tailnet)`);
    const buf = Buffer.alloc(st.size);
    const fd = openSync(real, "r");
    try {
      readSync(fd, buf, 0, st.size, 0);
    } finally {
      closeSync(fd);
    }
    return buf;
  }
