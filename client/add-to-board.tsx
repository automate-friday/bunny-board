// "Add to board…" in the Paseo app: pick one of the boards the plugin serves (or type a
// new name), and the plugin puts this agent on it as a frame with a live transcript
// card, then opens the frame's deep link. Used by the composer pill (popover) and by
// the agent panel the Command Center item opens. React Native primitives only.

import type { PluginAgentPanelProps, PluginButtonContentProps, PluginHostProps } from "@getpaseo/plugin/client";
import { openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import { TextInput } from "@getpaseo/plugin/client/react-native";
import { ExternalLink } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { addAgentRpc, boardsRpc } from "../shared/rpc";

type Board = { id: string; frames: number; boundFrames: number; lastActivityAt: string; url: string };
type Done = { url: string | null; boardId: string; created: boolean; reason: string | null };

function ago(iso: string): string {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

export function AddToBoard({ agentId, theme, layout, close }: PluginHostProps & { agentId: string; close?: () => void }) {
  const listBoards = useRpc(boardsRpc);
  const addAgent = useRpc(addAgentRpc);
  const [boards, setBoards] = useState<Board[] | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  // One request id per open: a double press joins the first import on the server.
  const requestId = useRef(`pill-${agentId.slice(0, 8)}-${Date.now().toString(36)}`);

  useEffect(() => {
    let live = true;
    listBoards({})
      .then((r) => live && setBoards(r.boards))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [listBoards]);

  const styles = useMemo(
    () => ({
      root: { gap: layout.compact ? 8 : 10, padding: layout.compact ? 12 : 4, minWidth: layout.compact ? undefined : 300 },
      heading: { color: theme.colors.foreground, fontSize: layout.compact ? 15 : 14, fontWeight: "600" as const },
      muted: { color: theme.colors.foregroundMuted, fontSize: 12 },
      row: { paddingVertical: layout.compact ? 12 : 8, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1 },
      rowText: { color: theme.colors.foreground, fontSize: 14 },
      input: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, paddingHorizontal: 10, paddingVertical: layout.compact ? 10 : 6, color: theme.colors.foreground, backgroundColor: theme.colors.surface0, fontSize: 14 },
      button: { paddingVertical: layout.compact ? 12 : 8, paddingHorizontal: 12, borderRadius: 8, backgroundColor: theme.colors.accent, alignItems: "center" as const },
      buttonText: { color: theme.colors.accentForeground, fontSize: 14, fontWeight: "600" as const },
      error: { color: theme.colors.statusDanger, fontSize: 13 },
      ok: { color: theme.colors.statusSuccess, fontSize: 13 },
    }),
    [theme, layout.compact],
  );

  const add = async (boardId: string) => {
    if (busy) return;
    setBusy(boardId);
    setError(null);
    try {
      const r = await addAgent({ agentId, boardId, requestId: requestId.current });
      setDone(r);
      if (r.url) await openExternalUrl(r.url).catch(() => undefined);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (done) {
    return (
      <View style={styles.root}>
        <Text style={done.created ? styles.ok : styles.muted}>{done.created ? `Added to board ${done.boardId}.` : `Not added: ${done.reason ?? "unknown reason"}.`}</Text>
        {done.url ? <ExternalLink href={done.url}>Open the frame on the board</ExternalLink> : null}
        {close ? (
          <Pressable accessibilityRole="button" onPress={close} style={styles.row}>
            <Text style={styles.rowText}>Close</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  // The host resolver needs the original accented name; selected board IDs stay exact.
  const newId = name.trim();
  return (
    <View style={styles.root}>
      <Text style={styles.heading}>Add this conversation to a board</Text>
      <Text style={styles.muted}>It gets a frame and a live transcript card. Your edits in the frame reach it as messages.</Text>
      {boards === null && !error ? <Text style={styles.muted}>Loading boards…</Text> : null}
      {(boards ?? []).slice(0, 12).map((b) => (
        <Pressable key={b.id} accessibilityRole="button" disabled={!!busy} onPress={() => void add(b.id)} style={styles.row}>
          <Text style={styles.rowText}>{busy === b.id ? `Adding to ${b.id}…` : b.id}</Text>
          <Text style={styles.muted}>
            {b.boundFrames} conversation{b.boundFrames === 1 ? "" : "s"} · {ago(b.lastActivityAt)}
          </Text>
        </Pressable>
      ))}
      <TextInput value={name} onChangeText={setName} placeholder="Or a new board name" placeholderTextColor={theme.colors.foregroundMuted} autoCapitalize="none" autoCorrect={false} style={styles.input} />
      {name.trim() ? (
        <Pressable accessibilityRole="button" disabled={!newId || !!busy} onPress={() => void add(newId)} style={styles.button}>
          <Text style={styles.buttonText}>{busy === newId ? "Adding…" : newId ? `Add to board "${newId}"` : "Use letters or digits"}</Text>
        </Pressable>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

// Composer pill popover body.
export function AddToBoardPopover(props: PluginButtonContentProps) {
  if (props.context !== "agent") return null;
  return <AddToBoard theme={props.theme} host={props.host} layout={props.layout} agentId={props.agentId} close={props.close} />;
}

// Agent panel (opened by the Command Center item "Add this agent to a board").
export function AddToBoardPanel(props: PluginAgentPanelProps) {
  return (
    <View style={{ flex: 1, backgroundColor: props.theme.colors.surface0, padding: props.layout.compact ? 8 : 20 }}>
      <AddToBoard theme={props.theme} host={props.host} layout={props.layout} agentId={props.agentId} />
    </View>
  );
}
