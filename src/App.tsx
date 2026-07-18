import { useState } from "react";
import HomeView from "./views/HomeView";
import ProjectDetailView from "./views/ProjectDetailView";

type View = { name: "home" } | { name: "project"; projectId: string };

export default function App() {
  const [view, setView] = useState<View>({ name: "home" });

  return (
    <main className="app-shell">
      {view.name === "home" ? (
        <HomeView onOpenProject={(projectId) => setView({ name: "project", projectId })} />
      ) : (
        <ProjectDetailView
          projectId={view.projectId}
          onBack={() => setView({ name: "home" })}
        />
      )}
    </main>
  );
}
