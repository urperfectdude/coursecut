import { useState } from "react";
import ExportHistoryView from "./views/ExportHistoryView";
import HomeView from "./views/HomeView";
import LessonEditorView from "./views/LessonEditorView";
import ProjectDetailView from "./views/ProjectDetailView";
import SettingsView from "./views/SettingsView";

type View =
  | { name: "home" }
  | { name: "project"; projectId: string }
  | { name: "settings" }
  // `projectId` is carried here purely so `onBack` can return to the right
  // project view — `LessonEditorView` itself only takes `videoId`/`onBack`.
  | { name: "editor"; videoId: string; projectId: string }
  // Project-level Export History (PRD §11, Milestone 8).
  | { name: "exportHistory"; projectId: string };

export default function App() {
  const [view, setView] = useState<View>({ name: "home" });

  return (
    <main className="app-shell">
      {view.name === "home" && (
        <HomeView
          onOpenProject={(projectId) => setView({ name: "project", projectId })}
          onOpenSettings={() => setView({ name: "settings" })}
        />
      )}
      {view.name === "project" && (
        <ProjectDetailView
          projectId={view.projectId}
          onBack={() => setView({ name: "home" })}
          onOpenEditor={(videoId) => setView({ name: "editor", videoId, projectId: view.projectId })}
          onOpenExportHistory={() => setView({ name: "exportHistory", projectId: view.projectId })}
        />
      )}
      {view.name === "settings" && <SettingsView onBack={() => setView({ name: "home" })} />}
      {view.name === "editor" && (
        <LessonEditorView
          videoId={view.videoId}
          onBack={() => setView({ name: "project", projectId: view.projectId })}
        />
      )}
      {view.name === "exportHistory" && (
        <ExportHistoryView
          projectId={view.projectId}
          onBack={() => setView({ name: "project", projectId: view.projectId })}
        />
      )}
    </main>
  );
}
