import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { ExternalLink } from "@getpaseo/plugin/client/ui";
import { useMemo } from "react";
import { Text, View } from "react-native";
import { z } from "zod";

export const deltaSchema = z.object({
  text: z.string(),
  boardId: z.string().optional(),
  frameId: z.string().optional(),
  url: z.string().optional(),
});

export function DeltaRow({ item, theme, layout }: PluginTimelineItemProps<z.output<typeof deltaSchema>>) {
  const styles = useMemo(
    () => ({
      box: {
        borderLeftWidth: 3,
        borderLeftColor: theme.colors.accent,
        paddingLeft: 10,
        paddingVertical: 6,
        gap: 4,
      },
      label: { color: theme.colors.foregroundMuted, fontSize: layout.compact ? 11 : 12 },
      text: { color: theme.colors.foreground, fontSize: layout.compact ? 13 : 14 },
    }),
    [theme, layout.compact],
  );
  return (
    <View style={styles.box}>
      <Text style={styles.label}>Board</Text>
      <Text style={styles.text}>{item.data.text}</Text>
      {item.data.url ? <ExternalLink href={item.data.url}>Open frame on the board</ExternalLink> : null}
    </View>
  );
}
