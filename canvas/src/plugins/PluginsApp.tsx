// The plugin registry pages, served by the canvas bundle at /plugins (the store) and
// /plugins/<id> (one page per plugin): what it does, why it matters, screenshots and a
// clip, its settings, what it reaches (permissions), version and source, and Install /
// Uninstall into "My registry" (server/plugins.ts). Plain, readable pages in the board's
// light look; one column on phones.

import { useEffect, useState } from "react";
import { BUILTINS, type BuiltinInfo, builtinInfo, isDevPlugin, type PluginInfo, pluginInfo, pluginPoster, visiblePlugins } from "../../../shared/plugins";
import { PortalIcon } from "../portals/icons";
import type { PluginMedia } from "../../../shared/widgets";
import { BUNNY_CSS, BunnyMark } from "../BunnyMark";
import { WidgetIcon } from "../components/widget/icons";
import { boardHref, installPlugin, pluginsHref, uninstallPlugin, useDevPlugins, useInstalled } from "./registry";

const CSS = `${BUNNY_CSS}
html,body{overflow:auto!important;height:auto!important;position:static!important;overscroll-behavior:auto!important;touch-action:auto!important}
body{margin:0}
.pl-root{min-height:100vh;background:light-dark(#f7f8fa, var(--bunny-surface));color:light-dark(#1f2430, var(--bunny-ink));font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
.pl-wrap{max-width:1040px;margin:0 auto;padding:20px 16px 64px}
.pl-top{display:flex;align-items:center;gap:10px;margin-bottom:18px}
.pl-top a{color:light-dark(#3a4252, var(--bunny-muted));text-decoration:none;display:inline-flex;align-items:center;gap:6px;font-size:14px}
.pl-top a:hover{color:light-dark(#1f2430, var(--bunny-ink))}
.pl-h1{font-size:28px;line-height:1.2;margin:0 0 6px;font-weight:700;letter-spacing:-.01em}
.pl-lead{color:light-dark(#5a6273, var(--bunny-muted));margin:0 0 20px;max-width:640px}
.pl-filter{display:flex;gap:6px;margin:0 0 22px}
.pl-chip{border:1px solid light-dark(#d9dde4, var(--bunny-line));background:light-dark(#fff, var(--bunny-surface));border-radius:999px;padding:4px 12px;font:inherit;font-size:13px;cursor:pointer;color:light-dark(#3a4252, var(--bunny-muted))}
.pl-chip[aria-pressed=true]{background:#1f2430;border-color:light-dark(#1f2430, var(--bunny-line));color:#fff}
.pl-section{margin:0 0 32px}
.pl-h2{font-size:18px;margin:0 0 4px;font-weight:650}
.pl-sub{color:light-dark(#6a7282, var(--bunny-muted));margin:0 0 14px;font-size:14px}
.pl-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:16px}
.pl-tile{display:flex;flex-direction:column;background:light-dark(#fff, var(--bunny-surface));border:1px solid light-dark(#e3e6eb, var(--bunny-line));border-radius:12px;overflow:hidden;text-decoration:none;color:inherit;transition:box-shadow .15s,border-color .15s}
.pl-tile:hover{border-color:light-dark(#c9ced6, var(--bunny-line));box-shadow:0 4px 16px rgba(20,30,60,.08)}
.pl-poster{position:relative;aspect-ratio:16/10;background:light-dark(#eef0f3, var(--bunny-raised));overflow:hidden}
.pl-poster img{width:100%;height:100%;object-fit:cover;object-position:top left;display:block}
.pl-tile-body{padding:12px 14px 14px;display:flex;flex-direction:column;gap:4px}
.pl-name{display:flex;align-items:center;gap:8px;font-weight:650;font-size:16px}
.pl-tagline{color:light-dark(#5a6273, var(--bunny-muted));font-size:14px}
.pl-meta{color:light-dark(#7a8292, var(--bunny-muted));font-size:12.5px;margin-top:2px}
.pl-badge{font-size:11.5px;font-weight:600;border-radius:5px;padding:1px 6px;white-space:nowrap}
.pl-badge.ok{color:light-dark(#1e7a3a, hsl(138 61% 74%));background:light-dark(#e6f4ea, var(--bunny-raised));border:1px solid light-dark(#b7dfc3, hsl(138 35% 39%))}
.pl-badge.warn{color:light-dark(#7a5a00, hsl(44 88% 74%));background:light-dark(#fff6db, hsl(45 45% 21%));border:1px solid light-dark(#f0dc9a, hsl(46 35% 39%))}
.pl-badge.muted{color:light-dark(#5a6273, var(--bunny-muted));background:light-dark(#f1f3f6, var(--bunny-raised));border:1px solid light-dark(#e1e4ea, var(--bunny-line))}
.pl-ph{position:absolute;left:8px;top:8px;background:rgba(31,36,48,.82);color:#fff;font-size:11px;font-weight:650;letter-spacing:.04em;text-transform:uppercase;border-radius:4px;padding:2px 6px}
.pl-head{display:flex;align-items:flex-start;gap:14px;flex-wrap:wrap;margin-bottom:18px}
.pl-head-icon{width:48px;height:48px;border-radius:12px;background:light-dark(#fff, var(--bunny-surface));border:1px solid light-dark(#e3e6eb, var(--bunny-line));display:flex;align-items:center;justify-content:center;color:light-dark(#2d3442, var(--bunny-ink));flex-shrink:0}
.pl-head-text{flex:1;min-width:220px}
.pl-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.pl-btn{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:14px;font-weight:600;border-radius:8px;padding:8px 16px;cursor:pointer;border:1px solid light-dark(#2f80ed, hsl(214 35% 39%));background:#2f80ed;color:#fff}
.pl-btn:disabled{opacity:.6;cursor:default}
.pl-btn.secondary{background:light-dark(#fff, var(--bunny-surface));color:light-dark(#3a4252, var(--bunny-muted));border-color:light-dark(#d0d5dd, var(--bunny-line))}
.pl-layout{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:28px;align-items:start}
@media (max-width:820px){.pl-layout{grid-template-columns:1fr}.pl-h1{font-size:24px}}
.pl-viewer{position:relative;background:light-dark(#fff, var(--bunny-surface));border:1px solid light-dark(#e3e6eb, var(--bunny-line));border-radius:12px;overflow:hidden}
.pl-viewer img,.pl-viewer video{display:block;width:100%;height:auto;max-height:520px;object-fit:contain;background:light-dark(#f1f3f6, var(--bunny-raised))}
.pl-caption{color:light-dark(#5a6273, var(--bunny-muted));font-size:13.5px;padding:8px 12px;border-top:1px solid light-dark(#eef0f3, var(--bunny-line))}
.pl-thumbs{display:flex;gap:8px;margin-top:10px;overflow-x:auto;padding-bottom:4px}
.pl-thumb{position:relative;flex:0 0 112px;height:70px;border-radius:8px;overflow:hidden;border:2px solid transparent;background:light-dark(#eef0f3, var(--bunny-raised));padding:0;cursor:pointer}
.pl-thumb[aria-current=true]{border-color:light-dark(#2f80ed, hsl(214 35% 39%))}
.pl-thumb img{width:100%;height:100%;object-fit:cover;object-position:top left;display:block}
.pl-thumb .pl-play{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#fff;background:light-dark(rgba(31,36,48,.35), color-mix(in srgb, #2b303b 35%, transparent))}
.pl-block{margin:26px 0 0}
.pl-block h2{font-size:17px;margin:0 0 6px;font-weight:650}
.pl-block p{margin:0;color:light-dark(#343b49, var(--bunny-ink));max-width:680px}
.pl-side{background:light-dark(#fff, var(--bunny-surface));border:1px solid light-dark(#e3e6eb, var(--bunny-line));border-radius:12px;padding:14px 16px}
.pl-side h3{font-size:13px;text-transform:uppercase;letter-spacing:.05em;color:light-dark(#7a8292, var(--bunny-muted));margin:14px 0 6px;font-weight:650}
.pl-side h3:first-child{margin-top:0}
.pl-side dl{margin:0;display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:14px}
.pl-side dt{color:light-dark(#7a8292, var(--bunny-muted))}
.pl-side dd{margin:0;word-break:break-word}
.pl-side a,.pl-block a{color:light-dark(#2563c9, hsl(217 69% 74%))}
.pl-list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:8px}
.pl-list li{display:flex;gap:10px;font-size:14px;color:light-dark(#343b49, var(--bunny-ink))}
.pl-kind{flex-shrink:0;font-size:11px;font-weight:650;text-transform:uppercase;letter-spacing:.04em;color:light-dark(#5a6273, var(--bunny-muted));background:light-dark(#f1f3f6, var(--bunny-raised));border-radius:4px;padding:2px 6px;height:fit-content;margin-top:2px;min-width:58px;text-align:center}
.pl-note{margin-top:14px;font-size:13.5px;border-radius:8px;padding:10px 12px}
.pl-note.warn{background:light-dark(#fff6db, hsl(45 45% 21%));color:light-dark(#6b5000, hsl(45 88% 74%));border:1px solid light-dark(#f0dc9a, hsl(46 35% 39%))}
.pl-note.info{background:light-dark(#eef4fe, var(--bunny-raised));color:light-dark(#284a86, hsl(218 54% 74%));border:1px solid light-dark(#c9dafa, hsl(219 35% 39%))}
.pl-fields{display:flex;flex-direction:column;gap:8px}
.pl-field{border:1px solid light-dark(#eef0f3, var(--bunny-line));border-radius:8px;padding:8px 12px;background:light-dark(#fff, var(--bunny-surface))}
.pl-field b{font-size:14px}
.pl-field span{color:light-dark(#6a7282, var(--bunny-muted));font-size:13.5px}
.pl-field code{font-size:12.5px;background:light-dark(#f1f3f6, var(--bunny-raised));border-radius:4px;padding:1px 5px;word-break:break-all}
`;

// --- tiny router: /plugins and /plugins/<id>, keeping ?from=<board> ---------------------
function usePath(): string {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const on = () => setPath(window.location.pathname);
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);
  return path;
}

function go(e: React.MouseEvent, href: string): void {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  window.history.pushState(null, "", href);
  window.dispatchEvent(new PopStateEvent("popstate"));
  window.scrollTo(0, 0);
}

function Link({ to, children, className, testid }: { to: string; children: React.ReactNode; className?: string; testid?: string }) {
  return (
    <a href={to} className={className} data-testid={testid} onClick={(e) => go(e, to)}>
      {children}
    </a>
  );
}

function Top({ back }: { back?: { to: string; label: string } }) {
  return (
    <div className="pl-top">
      <BunnyMark size={26} />
      {back ? (
        <Link to={back.to} testid="pl-back">
          <WidgetIcon name="arrow-left" size={16} /> {back.label}
        </Link>
      ) : null}
      <span style={{ flex: 1 }} />
      <a href={boardHref()} data-testid="pl-board">
        Back to the board
      </a>
    </div>
  );
}

function displayMode(p: PluginInfo): string | null {
  if (!p.app) return null;
  return p.app.frameable ? "Shows inside the board" : "Opens as a card";
}

function Poster({ m }: { m: PluginMedia | undefined }) {
  if (!m) return <div className="pl-poster" />;
  const src = m.kind === "video" ? (m.poster ?? "") : m.src;
  return (
    <div className="pl-poster">
      {src ? <img src={src} alt="" loading="lazy" /> : null}
      {m.placeholder ? <span className="pl-ph">Placeholder</span> : null}
    </div>
  );
}

function Tile({ p, installed }: { p: PluginInfo; installed: boolean }) {
  const mode = displayMode(p);
  return (
    <Link to={pluginsHref(p.id)} className="pl-tile" testid={`pl-tile-${p.id}`}>
      <Poster m={pluginPoster(p)} />
      <div className="pl-tile-body">
        <div className="pl-name">
          <span style={{ flex: 1, minWidth: 0 }}>{p.name}</span>
          {installed ? <span className="pl-badge ok" data-testid="pl-installed-badge">Installed</span> : null}
          {p.retiring ? <span className="pl-badge warn">Retiring</span> : null}
        </div>
        <div className="pl-tagline">{p.tagline}</div>
        <div className="pl-meta">
          {p.category}
          {mode ? ` · ${mode}` : ""}
        </div>
      </div>
    </Link>
  );
}

// The icon of a built-in feature (the page head; widgets use WidgetIcon).
function BuiltinIcon({ id, size }: { id: string; size: number }) {
  return id === "portals" ? <span style={{ color: "light-dark(#7c4dcc, hsl(262 55% 74%))", display: "inline-flex" }}><PortalIcon size={size} /></span> : null;
}

function BuiltinTile({ b }: { b: BuiltinInfo }) {
  return (
    <Link to={pluginsHref(b.id)} className="pl-tile" testid={`pl-tile-${b.id}`}>
      <Poster m={b.media.find((m) => m.kind === "image")} />
      <div className="pl-tile-body">
        <div className="pl-name">
          <BuiltinIcon id={b.id} size={18} />
          <span style={{ flex: 1, minWidth: 0 }}>{b.name}</span>
          <span className="pl-badge muted" data-testid="pl-builtin-badge">Built in</span>
        </div>
        <div className="pl-tagline">{b.tagline}</div>
        <div className="pl-meta">{b.category} · on the toolbar</div>
      </div>
    </Link>
  );
}

function BuiltinDetail({ b }: { b: BuiltinInfo }) {
  useEffect(() => {
    document.title = `${b.name} · Plugins`;
  }, [b.name]);
  return (
    <>
      <Top back={{ to: pluginsHref(), label: "All plugins" }} />
      <div className="pl-head">
        <div className="pl-head-icon">
          <BuiltinIcon id={b.id} size={30} />
        </div>
        <div className="pl-head-text">
          <h1 className="pl-h1" data-testid="pl-title">
            {b.name}
          </h1>
          <div className="pl-tagline" style={{ fontSize: 16 }}>
            {b.tagline}
          </div>
        </div>
        <div className="pl-actions">
          <span className="pl-badge muted" style={{ fontSize: 13, padding: "4px 8px" }} data-testid="pl-builtin">
            Built in: on every board
          </span>
        </div>
      </div>
      <div className="pl-layout">
        <main>
          <Gallery media={b.media} name={b.name} />
          <div className="pl-block">
            <h2>What it does</h2>
            <p data-testid="pl-about">{b.about}</p>
          </div>
          <div className="pl-block">
            <h2>Why it matters</h2>
            <p data-testid="pl-why">{b.whyItMatters}</p>
          </div>
          <div className="pl-block">
            <h2>How to use it</h2>
            <ol data-testid="pl-howto" style={{ margin: 0, paddingLeft: 20, color: "light-dark(#343b49, var(--bunny-ink))", maxWidth: 680 }}>
              {b.howTo.map((h) => (
                <li key={h} style={{ marginBottom: 4 }}>
                  {h}
                </li>
              ))}
            </ol>
          </div>
        </main>
        <aside className="pl-side" data-testid="pl-side">
          <h3>What it reaches</h3>
          <ul className="pl-list" data-testid="pl-permissions">
            {b.permissions.map((x) => (
              <li key={x.text}>
                <span className="pl-kind">{x.kind === "none" ? "nothing" : x.kind}</span>
                <span>{x.text}</span>
              </li>
            ))}
          </ul>
          <h3>Details</h3>
          <dl>
            <dt>Version</dt>
            <dd>{b.version}</dd>
            <dt>Category</dt>
            <dd>{b.category}</dd>
            <dt>Source</dt>
            <dd>
              <a href={b.source.url} target="_blank" rel="noopener noreferrer">
                {b.source.label}
              </a>
            </dd>
          </dl>
          <div className="pl-note info">Built into every board: find it on the bottom toolbar. Nothing to install.</div>
        </aside>
      </div>
    </>
  );
}

function Store({ installed, devPlugins }: { installed: string[] | null; devPlugins: boolean }) {
  const [only, setOnly] = useState(false);
  const has = (id: string) => !!installed?.includes(id);
  // Only released plugins unless the server offers developer plugins (shared/plugins.ts).
  const shown = (kind: PluginInfo["kind"]) => visiblePlugins(devPlugins).filter((p) => p.kind === kind && (!only || has(p.id)));
  // Frameable apps first, as in the tray.
  const apps = shown("app").sort((a, b) => Number(!!b.app?.frameable) - Number(!!a.app?.frameable));
  return (
    <>
      <Top />
      <h1 className="pl-h1">Plugins</h1>
      <p className="pl-lead">Live widgets you can put on the board, and that agents deploy and configure for the job they are doing, plus the features built into every board. Open one to see what it does and why you would want it; install the ones you want and they appear in the widget tray on the board's toolbar. Only plugins that have proven themselves on real work are listed.</p>
      <div className="pl-filter" role="group" aria-label="Show">
        <button type="button" className="pl-chip" aria-pressed={!only} onClick={() => setOnly(false)} data-testid="pl-filter-all">
          All
        </button>
        <button type="button" className="pl-chip" aria-pressed={only} onClick={() => setOnly(true)} data-testid="pl-filter-installed">
          My registry{installed ? ` (${installed.length})` : ""}
        </button>
      </div>
      <section className="pl-section">
        <h2 className="pl-h2">Widgets</h2>
        <p className="pl-sub">Small live windows that keep themselves up to date.</p>
        <div className="pl-grid">
          {shown("widget").map((p) => (
            <Tile key={p.id} p={p} installed={has(p.id)} />
          ))}
        </div>
      </section>
      {only ? null : (
        <section className="pl-section" data-testid="pl-builtins">
          <h2 className="pl-h2">Built in</h2>
          <p className="pl-sub">Part of every board, on the toolbar: nothing to install.</p>
          <div className="pl-grid">
            {BUILTINS.map((b) => (
              <BuiltinTile key={b.id} b={b} />
            ))}
          </div>
        </section>
      )}
      {apps.length || (only && devPlugins) ? (
      <section className="pl-section" data-testid="pl-apps">
        <h2 className="pl-h2">Apps</h2>
        <p className="pl-sub">Open-source apps you can host yourself, ready-made as an App window. Some show inside the board; others refuse to be shown inside other sites and open as a card with a link.</p>
        <div className="pl-grid">
          {apps.map((p) => (
            <Tile key={p.id} p={p} installed={has(p.id)} />
          ))}
        </div>
        {only && !apps.length ? <p className="pl-sub">No apps installed yet.</p> : null}
      </section>
      ) : null}
    </>
  );
}

function Gallery({ media, name }: { media: PluginMedia[]; name: string }) {
  const [i, setI] = useState(0);
  const m = media[Math.min(i, media.length - 1)];
  if (!m) return null;
  return (
    <div data-testid="pl-gallery">
      <div className="pl-viewer">
        {m.kind === "video" ? (
          <video key={m.src} src={m.src} poster={m.poster} controls muted playsInline preload="metadata" data-testid="pl-video" />
        ) : (
          <img key={m.src} src={m.src} alt={m.caption} data-testid="pl-image" />
        )}
        {m.placeholder ? <span className="pl-ph">Placeholder: real screenshot coming</span> : null}
        <div className="pl-caption">{m.caption}</div>
      </div>
      {media.length > 1 ? (
        <div className="pl-thumbs" role="tablist" aria-label={`${name} media`}>
          {media.map((x, k) => (
            <button key={x.src} type="button" className="pl-thumb" aria-current={k === i} aria-label={x.caption} onClick={() => setI(k)} data-testid={`pl-thumb-${k}`}>
              {x.kind === "video" ? x.poster ? <img src={x.poster} alt="" /> : null : <img src={x.src} alt="" />}
              {x.kind === "video" ? (
                <span className="pl-play">
                  <WidgetIcon name="play" size={22} />
                </span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Detail({ p, installed }: { p: PluginInfo; installed: string[] | null }) {
  const isIn = !!installed?.includes(p.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    document.title = `${p.name} · Plugins`;
  }, [p.name]);
  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      await (isIn ? uninstallPlugin(p.id) : installPlugin(p.id));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const mode = displayMode(p);
  return (
    <>
      <Top back={{ to: pluginsHref(), label: "All plugins" }} />
      <div className="pl-head">
        <div className="pl-head-icon">
          <WidgetIcon name={p.icon} size={26} />
        </div>
        <div className="pl-head-text">
          <h1 className="pl-h1" data-testid="pl-title">
            {p.name}
          </h1>
          <div className="pl-tagline" style={{ fontSize: 16 }}>
            {p.tagline}
          </div>
        </div>
        <div className="pl-actions">
          {installed === null ? null : isIn ? (
            <>
              <span className="pl-badge ok" style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 13, padding: "4px 8px" }} data-testid="pl-installed">
                <WidgetIcon name="check" size={14} /> Installed
              </span>
              <button type="button" className="pl-btn secondary" disabled={busy} onClick={toggle} data-testid="pl-uninstall">
                Uninstall
              </button>
            </>
          ) : (
            <button type="button" className="pl-btn" disabled={busy} onClick={toggle} data-testid="pl-install">
              Install
            </button>
          )}
        </div>
      </div>
      {error ? <div className="pl-note warn">{error}</div> : null}
      <div className="pl-layout">
        <main>
          <Gallery media={p.media} name={p.name} />
          <div className="pl-block">
            <h2>What it does</h2>
            <p data-testid="pl-about">{p.about}</p>
          </div>
          <div className="pl-block">
            <h2>Why it matters</h2>
            <p data-testid="pl-why">{p.whyItMatters}</p>
          </div>
          {p.app ? (
            <div className="pl-block" data-testid="pl-display">
              <h2>How it shows on the board</h2>
              <p>
                <b>{mode}.</b>{" "}
                {p.app.frameable
                  ? `${p.name} allows being shown inside other sites, so the App window shows it directly and you can use it on the board.`
                  : `${p.name} does not allow being shown inside other sites, so the App window shows a card with its health, response time and an Open button that takes you there.`}{" "}
                Checked {p.app.checkedAt}: {p.app.observed}. The board checks again every time it loads the app, so this follows the app if it changes.
              </p>
            </div>
          ) : null}
          <div className="pl-block">
            <h2>Settings</h2>
            <p style={{ marginBottom: 8 }}>{p.kind === "app" ? "Installed ready to go: the address is filled in. You can change any of these on the board with the widget's gear." : "Filled in on the board after you drop it in (or by an agent)."}</p>
            <div className="pl-fields" data-testid="pl-fields">
              {p.fields.map((f) => (
                <div className="pl-field" key={f.key}>
                  <b>{f.label}</b> <span>{f.required ? "required" : "optional"}</span>
                  {f.help ? <div><span>{f.help}</span></div> : null}
                  {p.preset?.[f.key] !== undefined ? (
                    <div>
                      <span>Pre-filled: </span>
                      <code>{String(p.preset[f.key])}</code>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        </main>
        <aside className="pl-side" data-testid="pl-side">
          <h3>What it reaches</h3>
          <ul className="pl-list" data-testid="pl-permissions">
            {p.permissions.map((x) => (
              <li key={x.text}>
                <span className="pl-kind">{x.kind === "none" ? "nothing" : x.kind}</span>
                <span>{x.text}</span>
              </li>
            ))}
          </ul>
          <h3>Details</h3>
          <dl>
            <dt>Version</dt>
            <dd data-testid="pl-version">{p.version}</dd>
            <dt>Category</dt>
            <dd>{p.category}</dd>
            {mode ? (
              <>
                <dt>On the board</dt>
                <dd>{mode}</dd>
              </>
            ) : null}
            <dt>Source</dt>
            <dd>
              <a href={p.source.url} target="_blank" rel="noopener noreferrer">
                {p.source.label}
              </a>
            </dd>
            <dt>License</dt>
            <dd>{p.source.license}</dd>
            {p.app ? (
              <>
                <dt>Demo</dt>
                <dd>
                  <a href={p.app.demo} target="_blank" rel="noopener noreferrer">
                    {new URL(p.app.demo).host}
                  </a>
                </dd>
              </>
            ) : null}
          </dl>
          <div className="pl-note info">{isIn ? `In your registry: find it in the widget tray on the board's toolbar.` : p.kind === "app" ? `Install adds a ready-made ${p.name} window to the widget tray.` : `Install adds ${p.name} to the widget tray.`}</div>
          {p.retiring ? <div className="pl-note warn">{p.retiring}</div> : null}
        </aside>
      </div>
    </>
  );
}

export function PluginsApp() {
  const path = usePath();
  const installed = useInstalled();
  const devPlugins = useDevPlugins();
  const id = decodeURIComponent(path.replace(/^\/plugins\/?/, "").replace(/\/$/, ""));
  const p = id ? pluginInfo(id) : undefined;
  const b = id && !p ? builtinInfo(id) : undefined;
  useEffect(() => {
    if (!id) document.title = "Plugins";
  }, [id]);
  return (
    <div className="pl-root" data-testid="plugins-page">
      <style>{CSS}</style>
      <div className="pl-wrap">
        {!id ? (
          <Store installed={installed} devPlugins={devPlugins} />
        ) : p && isDevPlugin(p.id) && !devPlugins ? (
          <>
            <Top back={{ to: pluginsHref(), label: "All plugins" }} />
            <h1 className="pl-h1" data-testid="pl-not-available">
              {p.name} is not available yet
            </h1>
            <p className="pl-lead">It is a developer plugin: not released, so it is not offered on this board. Widgets of this kind already on a board keep working.</p>
          </>
        ) : p ? (
          <Detail p={p} installed={installed} />
        ) : b ? (
          <BuiltinDetail b={b} />
        ) : (
          <>
            <Top back={{ to: pluginsHref(), label: "All plugins" }} />
            <h1 className="pl-h1">No plugin called “{id}”</h1>
          </>
        )}
      </div>
    </div>
  );
}

export const isPluginsPath = (pathname: string) => pathname === "/plugins" || pathname.startsWith("/plugins/");
