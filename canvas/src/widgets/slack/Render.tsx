// Slack widget body: the channel list (account only), a channel's messages with a
// composer, or one thread. Clicking a channel or "N replies" re-points the widget's
// config; on mock accounts a footer injects faults (429, disconnect, stall).

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SlackConfig, SlackData, SlackMsg } from "../../../../shared/widgets/slack";
import { api } from "../../api";
import { WidgetIcon } from "../../components/widget/icons";
import type { WidgetBodyProps } from "../registry";

const HINTS: Record<string, string> = {
  token_revoked: "This account's token was revoked. Pick another account in Configure.",
  invalid_auth: "The board server's token for this account is not valid.",
  missing_scope: "The Slack app is missing a scope this view needs.",
  channel_not_found: "The channel does not exist, or it is private and the bot is not in it.",
  not_in_channel: "Invite the bot to this channel, or pick another one in Configure.",
  thread_not_found: "That thread does not exist in this channel.",
};

function time(ts: string): string {
  const d = new Date(Number(ts) * 1000);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function Avatar({ name }: { name: string }) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return <span style={{ width: 26, height: 26, borderRadius: 6, background: `hsl(${h} 55% 55%)`, color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", fontWeight: 700, flexShrink: 0 }}>{name.slice(0, 1).toUpperCase()}</span>;
}

function Message({ m, onThread }: { m: SlackMsg; onThread?: () => void }) {
  return (
    <div data-testid="slack-message" data-ts={m.ts} style={{ display: "flex", gap: 8, padding: "5px 10px" }}>
      <Avatar name={m.userName} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
          <b style={{ fontSize: 12.5 }}>{m.userName}</b>
          {m.bot ? <span style={{ fontSize: 9, background: "light-dark(#e8eaed, var(--bunny-raised))", borderRadius: 3, padding: "0 3px" }}>APP</span> : null}
          <span style={{ color: "light-dark(#889, var(--bunny-muted))", fontSize: 10.5 }}>{time(m.ts)}</span>
        </div>
        {m.broadcast ? <div style={{ color: "light-dark(#889, var(--bunny-muted))", fontSize: 10.5 }}>replied to a thread</div> : null}
        <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", lineHeight: 1.35 }}>{m.text}</div>
        {m.reply_count && onThread ? (
          <button type="button" data-testid="slack-open-thread" onClick={onThread} style={{ marginTop: 2, border: "none", background: "transparent", color: "light-dark(#1264a3, hsl(206 80% 74%))", fontWeight: 600, padding: 0, cursor: "pointer", font: "inherit", fontSize: 11.5 }}>
            {m.reply_count} {m.reply_count === 1 ? "reply" : "replies"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function Composer({ widgetKey, placeholder }: { widgetKey: string; placeholder: string }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api("/api/ui/widgets/action", { method: "POST", body: JSON.stringify({ key: widgetKey, action: "post", input: { text } }) });
      setText("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
      style={{ display: "flex", gap: 6, padding: 8, borderTop: "1px solid light-dark(#eef0f3, var(--bunny-line))" }}
    >
      <input data-testid="slack-composer" value={text} onChange={(e) => setText(e.target.value)} placeholder={error ? `Not sent: ${error}` : placeholder} style={{ flex: 1, minWidth: 0, padding: "5px 8px", border: `1px solid ${error ? "light-dark(#d93025, hsl(4 35% 39%))" : "light-dark(#c9ced6, var(--bunny-line))"}`, borderRadius: 6, font: "12px system-ui" }} />
      <button type="submit" disabled={busy || !text.trim()} style={{ border: "none", background: "#007a5a", color: "#fff", borderRadius: 6, padding: "0 10px", cursor: "pointer" }}>
        Send
      </button>
    </form>
  );
}

function MockControls() {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const fire = (label: string, body: Record<string, unknown>) =>
    api("/api/ui/widgets/slack/admin", { method: "POST", body: JSON.stringify(body) })
      .then(() => setNote(`${label} sent`))
      .catch((e) => setNote((e as Error).message));
  const btn: React.CSSProperties = { border: "1px solid light-dark(#d5d9e0, var(--bunny-line))", background: "light-dark(#fff, var(--bunny-surface))", borderRadius: 5, padding: "1px 6px", cursor: "pointer", font: "11px system-ui" };
  return (
    <div style={{ borderTop: "1px dashed light-dark(#e1e4ea, var(--bunny-line))", padding: "3px 8px", color: "light-dark(#778, var(--bunny-muted))", fontSize: 11, display: "flex", gap: 5, alignItems: "center", flexWrap: "wrap" }}>
      <button type="button" data-testid="slack-mock-toggle" onClick={() => setOpen((v) => !v)} style={{ ...btn, border: "none", padding: 0, display: "inline-flex", alignItems: "center", gap: 2, color: "light-dark(#778, var(--bunny-muted))" }}>
        <WidgetIcon name={open ? "chevron-down" : "chevron-right"} size={12} />
        Mock controls
      </button>
      {open ? (
        <>
          <button type="button" data-testid="slack-mock-429" style={btn} onClick={() => fire("429", { fault: "ratelimit", retryAfter: 4 })}>429</button>
          <button type="button" data-testid="slack-mock-disconnect" style={btn} onClick={() => fire("disconnect", { fault: "disconnect", reason: "warning" })}>Disconnect</button>
          <button type="button" data-testid="slack-mock-stall" style={btn} onClick={() => fire("stall", { fault: "stall", ms: 25_000 })}>Stall 25s</button>
          <button type="button" data-testid="slack-mock-post" style={btn} onClick={() => fire("message", { fault: "post", channel: "C0PROJECT1", user: "U0BOB0001", text: `Hi from Bob at ${new Date().toLocaleTimeString()}` })}>Post message</button>
          <span>{note}</span>
        </>
      ) : null}
    </div>
  );
}

export function SlackBody({ config, state, widgetKey, readOnly, setConfig }: WidgetBodyProps & { config: SlackConfig }) {
  const data = state?.data as SlackData | null;
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const count = data && data.view !== "channels" ? data.messages.length : 0;
  const lastTs = data && data.view !== "channels" ? data.messages.at(-1)?.ts : undefined;
  // Stick to the newest message unless the person scrolled up.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when messages arrive.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [count, lastTs, data?.view]);
  useEffect(() => {
    atBottom.current = true;
  }, [config.channel, config.thread_ts]);
  const mock = config.account.startsWith("mock");
  const code = state?.reason?.split(" ")[0] ?? "";
  if (!data && state?.status === "error")
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
        <div data-testid="slack-error" style={{ margin: 12, padding: 10, borderRadius: 8, background: "light-dark(#fdecea, var(--bunny-raised))", color: "light-dark(#8c1d18, hsl(3 71% 74%))" }}>
          <b>{state.reason}</b>
          <div style={{ marginTop: 4 }}>{HINTS[code] ?? "The Slack API refused this view."}</div>
        </div>
        <div style={{ flex: 1 }} />
        {mock ? <MockControls /> : null}
      </div>
    );
  if (!data) return <div style={{ padding: 12, color: "light-dark(#778, var(--bunny-muted))" }}>Loading from Slack…</div>;
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {data.view === "thread" ? (
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 10px", borderBottom: "1px solid light-dark(#eef0f3, var(--bunny-line))", background: "light-dark(#fbfbfc, var(--bunny-surface))" }}>
          <button type="button" data-testid="slack-back" disabled={readOnly} onClick={() => setConfig({ thread_ts: "" })} style={{ border: "none", background: "transparent", color: "light-dark(#1264a3, hsl(206 80% 74%))", cursor: "pointer", padding: 0, font: "inherit", fontWeight: 600 }}>
            ‹ #{data.channel.name}
          </button>
          <span style={{ color: "light-dark(#889, var(--bunny-muted))" }}>Thread</span>
        </div>
      ) : null}
      <div
        ref={scroller}
        data-scroll
        onWheel={(e) => e.stopPropagation()}
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
        }}
        style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "4px 0" }}
      >
        {data.view === "channels" ? (
          data.channels.map((c) => (
            <button
              key={c.id}
              type="button"
              data-testid="slack-channel"
              disabled={readOnly || !c.is_member}
              onClick={() => setConfig({ channel: c.id })}
              style={{ display: "flex", width: "100%", gap: 6, padding: "6px 12px", border: "none", background: "transparent", textAlign: "left", cursor: c.is_member ? "pointer" : "default", color: c.is_member ? "light-dark(#223, var(--bunny-ink))" : "light-dark(#99a, var(--bunny-muted))", font: "13px system-ui" }}
            >
              <span style={{ display: "inline-flex", width: 14, justifyContent: "center", alignItems: "center" }}>{c.is_private ? <WidgetIcon name="lock" size={13} title="private" /> : "#"}</span>
              <span style={{ flex: 1 }}>{c.name}</span>
              <span style={{ color: "light-dark(#99a, var(--bunny-muted))", fontSize: 11 }}>{c.is_member ? `${c.num_members ?? ""} members` : "bot not in channel"}</span>
            </button>
          ))
        ) : data.view === "thread" ? (
          <>
            {data.parent ? <Message m={data.parent} /> : null}
            <div style={{ margin: "2px 10px 4px", color: "light-dark(#889, var(--bunny-muted))", fontSize: 11, borderBottom: "1px solid light-dark(#eef0f3, var(--bunny-line))" }}>{data.messages.length} replies</div>
            {data.messages.map((m) => (
              <Message key={m.ts} m={m} />
            ))}
          </>
        ) : (
          data.messages.map((m) => <Message key={m.ts} m={m} onThread={readOnly ? undefined : () => setConfig({ thread_ts: m.ts })} />)
        )}
      </div>
      {data.view !== "channels" && !readOnly ? <Composer widgetKey={widgetKey} placeholder={data.view === "thread" ? "Reply…" : `Message #${data.channel.name}`} /> : null}
      {mock ? <MockControls /> : null}
    </div>
  );
}
