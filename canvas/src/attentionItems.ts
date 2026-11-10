// Use Paseo's attention semantics. Idle alone does not mean an unread answer.
export interface AttentionRow {
  id: string; title: string | null; status: string; attention: string | null;
  needsAttention: boolean; attentionTimestamp?: string | null; archived: boolean;
}
interface FrameRecord {
  id: string; type: string; props?: unknown; meta?: unknown;
}
export interface AttentionItem { agentId?: string; frameId: string; title: string; reason: string; since: string | null }
export function attentionItems(records: readonly FrameRecord[], rows: readonly AttentionRow[]): AttentionItem[] {
  const byId = new Map(rows.map(row => [row.id, row]));
  const items: AttentionItem[] = [];
  for (const frame of records) {
    if (frame.type !== 'frame') continue;
    const p = (frame.meta as { paseo?: { agentId?: string; status?: string; host?: string } } | undefined)?.paseo;
    if (!p?.agentId || p.status === 'archived') continue;
    // Other Macs' ids belong to a different directory. Their frame states still work.
    const row = p.host ? undefined : byId.get(p.agentId);
    if (row?.archived) continue;
    // A recovered turn can be running while the frame's last error and the directory's
    // attention flag still describe its previous turn. Native running status wins.
    if (row?.status === 'running') continue;
    const nativeAlert = row?.status === 'error' || row?.status === 'needs-permission';
    const status = nativeAlert ? row.status : p.status === 'error' || p.status === 'needs-permission' ? p.status : row?.status ?? p.status;
    const reason = status === 'error' ? 'Error' : status === 'needs-permission' ? 'Needs input' :
      row?.needsAttention ? row.attention === 'finished' ? 'Ready to review' : row.attention === 'error' ? 'Error' : 'Needs input' : null;
    // A frame may receive the running update before the cached directory refreshes.
    // Hide its old review flag, but retain explicit errors and permission requests.
    if (!reason || (reason === 'Ready to review' && p.status === 'running')) continue;
    const timestamp = row?.attentionTimestamp;
    items.push({ agentId:p.agentId, frameId: frame.id, title: (frame.props as {name?:string})?.name || row?.title || 'Untitled conversation', reason,
      since: timestamp && Number.isFinite(Date.parse(timestamp)) ? timestamp : null });
  }
  return items.sort((a,b) => (a.since ?? '\uffff').localeCompare(b.since ?? '\uffff') || a.title.localeCompare(b.title));
}
