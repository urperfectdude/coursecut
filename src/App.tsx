import { useState } from "react";
import ExportHistoryView from "./views/ExportHistoryView";
import HomeView from "./views/HomeView";
import LessonEditorView from "./views/LessonEditorView";
import LessonSegmentsView from "./views/LessonSegmentsView";
import ProjectDetailView from "./views/ProjectDetailView";
import SettingsView from "./views/SettingsView";
import TranscriptStageView from "./views/TranscriptStageView";

type View =
  | { name: "home" }
  | { name: "project"; projectId: string }
  | { name: "settings" }
  // Replaces the old flat `editor` view (docs/ux-overhaul-plan.md Phase 3) —
  // `stage` picks which of the two views below renders for this video.
  | { name: "video"; projectId: string; videoId: string; stage: "transcript" | "lessons" }
  // A single lesson's own segment-editing page, opened from a `LessonCard`
  // tile's "Edit segments" button — no longer an inline expansion of the
  // tile itself (see the conversation that moved it here).
  | { name: "lessonSegments"; projectId: string; videoId: string; lessonId: string }
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
          onOpenVideo={(videoId) =>
            setView({ name: "video", projectId: view.projectId, videoId, stage: "transcript" })
          }
          onOpenExportHistory={() => setView({ name: "exportHistory", projectId: view.projectId })}
        />
      )}
      {view.name === "settings" && <SettingsView onBack={() => setView({ name: "home" })} />}
      {view.name === "video" && view.stage === "transcript" && (
        <TranscriptStageView
          projectId={view.projectId}
          videoId={view.videoId}
          onNavigateHome={() => setView({ name: "home" })}
          onNavigateProject={() => setView({ name: "project", projectId: view.projectId })}
          onOpenLessons={() =>
            setView({ name: "video", projectId: view.projectId, videoId: view.videoId, stage: "lessons" })
          }
        />
      )}
      {view.name === "video" && view.stage === "lessons" && (
        <LessonEditorView
          projectId={view.projectId}
          videoId={view.videoId}
          onNavigateHome={() => setView({ name: "home" })}
          onNavigateProject={() => setView({ name: "project", projectId: view.projectId })}
          onNavigateTranscript={() =>
            setView({ name: "video", projectId: view.projectId, videoId: view.videoId, stage: "transcript" })
          }
          onOpenLessonSegments={(lessonId) =>
            setView({ name: "lessonSegments", projectId: view.projectId, videoId: view.videoId, lessonId })
          }
          onOpenExportHistory={() => setView({ name: "exportHistory", projectId: view.projectId })}
        />
      )}
      {view.name === "lessonSegments" && (
        <LessonSegmentsView
          projectId={view.projectId}
          videoId={view.videoId}
          lessonId={view.lessonId}
          onNavigateHome={() => setView({ name: "home" })}
          onNavigateProject={() => setView({ name: "project", projectId: view.projectId })}
          onNavigateTranscript={() =>
            setView({ name: "video", projectId: view.projectId, videoId: view.videoId, stage: "transcript" })
          }
          onNavigateLessons={() =>
            setView({ name: "video", projectId: view.projectId, videoId: view.videoId, stage: "lessons" })
          }
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
