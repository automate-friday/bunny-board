// Hello widget: the first plugin widget. Its data source ticks once a second, so it
// proves the whole pipe (manifest, tray drag, board_widget add/configure, SSE, status)
// without any external service.

import { T } from "@tldraw/validate";
import type { WidgetManifest } from "./types";

export interface HelloConfig {
  name: string;
}

export interface HelloData {
  greeting: string;
  tick: number;
  serverTime: string;
}

const name = T.string.check((v) => {
  if (v.length > 80) throw new Error("name must be at most 80 characters");
});

export const helloWidget: WidgetManifest<HelloConfig, HelloData> = {
  id: "hello",
  label: "Hello",
  icon: "smile",
  description: "Says hello and counts seconds. Proves widgets work end to end.",
  tagline: "A tiny live widget that shows the board's widget pipe is working.",
  about: "Hello greets a name and counts up once a second. The count comes from the board server over the same live stream every widget uses, so if Hello ticks, the board can run live widgets.",
  whyItMatters: "Drop it on a new or freshly upgraded board before adding anything real. A ticking counter and a green dot mean the board server, its live stream and your browser are all connected; a stuck count turning amber tells you something in between is not.",
  category: "Basics",
  permissions: [{ kind: "none", text: "Runs on the board server only. Reaches no network and reads no board content." }],
  media: [
    { kind: "image", src: "/plugin-media/hello/live.png", caption: "Live: the greeting and a counter streamed from the board server." },
    { kind: "video", src: "/plugin-media/hello/clip.webm", poster: "/plugin-media/hello/live.png", caption: "Dropped in, set up with a name, ticking." },
  ],
  version: "1.0.0",
  size: { w: 280, h: 160 },
  staleMs: 3500,
  fields: [{ key: "name", label: "Name", kind: "text", required: true, placeholder: "Sam", help: "Who to greet" }],
  configProps: { name },
  defaults: () => ({ name: "" }),
  configured: (c) => c.name.trim().length > 0,
  summary: (c) => c.name || "not set up",
  describe: (c, s) => (s?.data ? `${s.data.greeting} (tick ${s.data.tick})` : `greets ${JSON.stringify(c.name)}`),
};
