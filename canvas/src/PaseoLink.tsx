import { useEffect, useState } from "react";
import { paseoLink, type PaseoLinkState } from "../../shared/conversation-links";
import { Emoji } from "./Emoji";
import { boardInfo, infoNow } from "./info";

export function usePaseoLink(input: Omit<Parameters<typeof paseoLink>[0], "serverId" | "remoteServerIds">) {
  const [info, setInfo] = useState(infoNow);
  useEffect(() => { void boardInfo().then(setInfo).catch(() => undefined); }, []);
  const caps = input.capabilities;
  return paseoLink({
    ...input,
    serverId: caps?.paseoServerId ?? info?.paseoServerId,
    remoteServerIds: {
      ...info?.paseoServerIds,
      ...(input.remoteHost && caps?.paseoServerId ? { [input.remoteHost]: caps.paseoServerId } : {}),
    },
  });
}

export function PaseoLink({ link, testId, style, onPointerDown, children = "Open in Paseo" }: {
  link: PaseoLinkState;
  testId: string;
  style?: React.CSSProperties;
  onPointerDown?: React.PointerEventHandler;
  children?: React.ReactNode;
}) {
  if (link.hidden) return null;
  const label = <>{children} <Emoji name="open" /></>;
  return link.url ? (
    <a data-testid={testId} href={link.url} style={style} onPointerDown={onPointerDown} title="Open this agent in the Paseo app">{label}</a>
  ) : (
    <span data-testid={testId} role="link" aria-disabled="true" title={link.reason} style={{ ...style, color: "light-dark(#94a3b8, var(--bunny-muted))", cursor: "not-allowed" }} onPointerDown={onPointerDown}>{label}</span>
  );
}
