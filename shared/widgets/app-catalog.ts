// Seeded catalog for the "app" widget's tray: a few open-source, self-hostable apps from
// the 21st.dev community apps list, each with a public demo URL. Plain JSON-shaped data
// (no logic) so it can move to a .json file or a fetched list later. Picking an entry in
// the tray pre-fills the widget config with {url: demo, title: name}.
//
// `frameable` is what was OBSERVED when the demo URLs were checked from a machine with
// real internet (2026-11-01): whether the demo answered 2xx without X-Frame-Options or a
// CSP frame-ancestors that excludes the board. It only orders and labels the tray; the
// server's frameability check still decides at runtime (an app can change its headers).
// Kept in this order: frameable first.

export interface AppCatalogEntry {
  id: string;
  name: string;
  description: string;
  demo: string;
  repo: string;
  license: string;
  frameable: boolean;
  // What the check saw, one line.
  observed: string;
  // Page fields (/plugins/<id>): what the app is and why put it on a board.
  tagline: string;
  about: string;
  whyItMatters: string;
  category: string;
}

// Each app's preview: a real screenshot captured from a machine with internet (the repo's
// cloud VMs have none), canvas/public/plugin-media/<id>/preview.png. Where the demo URL
// renders nothing useful headless, it shows the project's own site instead (see PREVIEW_OF).
export const appPreview = (id: string) => `/plugin-media/${id}/preview.png`;

// What a preview shows when it is not the demo URL itself.
export const PREVIEW_OF: Record<string, string> = {
  umami: "the umami.is homepage (the shared dashboard renders only a spinner when captured headless)",
  plane: "the plane.so homepage (app.plane.so is a sign-in page)",
  documenso: "its sign-in page at app.documenso.com",
};

export const APP_CATALOG_CHECKED_AT = "2026-11-01";

export const APP_CATALOG: AppCatalogEntry[] = [
  { id: "excalidraw", name: "Excalidraw", description: "Hand-drawn style whiteboard", demo: "https://excalidraw.com", repo: "https://github.com/excalidraw/excalidraw", license: "MIT", frameable: true, observed: "200, no framing headers", tagline: "A hand-drawn style whiteboard for quick sketches and diagrams.", about: "Excalidraw is an open-source virtual whiteboard. Shapes, arrows and text come out looking hand-drawn, which keeps diagrams loose and quick to make. It runs in the browser and can be self-hosted.", whyItMatters: "Sketch an architecture or a flow right next to the frame that is building it, without leaving the board. The window shows Excalidraw itself, so you can draw in it directly.", category: "Drawing" },
  { id: "memos", name: "Memos", description: "Lightweight note-taking", demo: "https://demo.usememos.com", repo: "https://github.com/usememos/memos", license: "MIT", frameable: true, observed: "200, no framing headers", tagline: "Quick, timeline-style notes you host yourself.", about: "Memos is a lightweight, self-hosted note-taking service: short notes in a timeline, with Markdown, tags and search. Think of a private microblog for your team's thoughts and links.", whyItMatters: "Keep a running log of decisions, links and snippets beside the work they belong to. The window shows Memos itself, so anyone at the board can read or add a note.", category: "Notes" },
  { id: "umami", name: "Umami", description: "Privacy-focused web analytics", demo: "https://cloud.umami.is/share/LGazGOecbDtaIwDr/umami.is", repo: "https://github.com/umami-software/umami", license: "MIT", frameable: false, observed: "200 (the old analytics.umami.is link was 404 with X-Frame-Options: SAMEORIGIN); expected to show a card", tagline: "Simple, privacy-focused website analytics.", about: "Umami is an open-source alternative to Google Analytics. It counts visitors, page views and referrers without cookies or personal data, on a single clean dashboard you can host yourself.", whyItMatters: "Watch traffic on a launch frame while the work ships: when a post goes out or a page changes, the visitor numbers are one click away. Its public demo is not expected to allow being shown inside other pages, so the board shows a card with its health and an Open button (the board checks again live).", category: "Analytics" },
  { id: "plausible", name: "Plausible", description: "Lightweight web analytics", demo: "https://plausible.io/plausible.io", repo: "https://github.com/plausible/analytics", license: "AGPL-3.0", frameable: false, observed: "CSP frame-ancestors 'self'", tagline: "Lightweight, cookie-free website analytics.", about: "Plausible is open-source web analytics that is small, cookie-free and privacy-friendly. One page shows visitors, sources, top pages and goals.", whyItMatters: "Keep the site's numbers next to the marketing or launch frame. Plausible does not allow being shown inside other pages, so the board shows a card with its health and an Open button.", category: "Analytics" },
  { id: "plane", name: "Plane", description: "Issues, cycles and roadmaps", demo: "https://app.plane.so", repo: "https://github.com/makeplane/plane", license: "AGPL-3.0", frameable: false, observed: "X-Frame-Options: DENY", tagline: "Issues, cycles and roadmaps, self-hostable.", about: "Plane is an open-source project tracker in the spirit of Jira and Linear: issues, cycles (sprints), modules and roadmaps, which you can host yourself.", whyItMatters: "Link the planning frame to where the issues actually live, with a light that shows whether your Plane server is up. Plane does not allow being shown inside other pages, so the board shows a card with an Open button.", category: "Project management" },
  { id: "metabase", name: "Metabase", description: "Dashboards and BI", demo: "https://www.metabase.com/demo", repo: "https://github.com/metabase/metabase", license: "AGPL-3.0", frameable: false, observed: "CSP frame-ancestors 'self'", tagline: "Dashboards and questions over your own databases.", about: "Metabase is an open-source business-intelligence tool. Point it at a database, ask questions without SQL (or with it), and pin the answers to dashboards.", whyItMatters: "Keep the key dashboard for a project in view on its frame, with a health light for your Metabase server. Its demo does not allow being shown inside other pages, so the board shows a card with an Open button.", category: "Analytics" },
  { id: "hoppscotch", name: "Hoppscotch", description: "API development ecosystem", demo: "https://hoppscotch.io", repo: "https://github.com/hoppscotch/hoppscotch", license: "MIT", frameable: false, observed: "CSP frame-ancestors 'self'", tagline: "Build and test API requests in the browser.", about: "Hoppscotch is an open-source API development tool, like Postman in the browser: compose HTTP, GraphQL and WebSocket requests, save collections and share them with a team.", whyItMatters: "Keep the API workspace next to the frame building the integration. Hoppscotch does not allow being shown inside other pages, so the board shows a card with an Open button.", category: "Developer tools" },
  { id: "documenso", name: "Documenso", description: "Open-source document signing", demo: "https://app.documenso.com", repo: "https://github.com/documenso/documenso", license: "AGPL-3.0", frameable: false, observed: "CSP frame-ancestors 'self'", tagline: "Open-source document signing.", about: "Documenso is an open-source alternative to DocuSign: upload a document, place signature fields, send it and track who has signed. It can be self-hosted.", whyItMatters: "Keep the contract or agreement a frame is waiting on one click away, with a light for your Documenso server. Documenso does not allow being shown inside other pages, so the board shows a card with an Open button.", category: "Documents" },
];
