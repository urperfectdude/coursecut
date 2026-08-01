// PORTED FROM: src/views/SettingsView.tsx @ dad013b
// DEVIATIONS: D7 (no OpenAI API key section — the key is platform-owned)
// One-way port — desktop is upstream. Don't edit this for web-only reasons;
// port the change to the desktop file first. See docs/web-app-plan.md §7.1,
// and re-run scripts/ui-drift.sh (which reads the SHA above) after syncing.
//
// The whole "OpenAI API key" section desktop shows — the masked status line,
// the `sk-...` input, Save, and Test Connection — is gone, along with the
// state and handlers behind it. The web app supplies its own key from the
// server environment, so there is nothing here for a tenant to enter and no
// honest way to render the section: every control in it would be a no-op.
//
// "Analysis instructions" is untouched and stays per-org. Users still shape
// what the model does; they just don't pay for it.
import { useEffect, useState } from "react";
import { getAnalysisInstructions, saveAnalysisInstructions } from "../db";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

interface SettingsViewProps {
  onBack: () => void;
}

export default function SettingsView({ onBack }: SettingsViewProps) {
  const [instructionsInput, setInstructionsInput] = useState("");
  const [instructionsLoading, setInstructionsLoading] = useState(true);
  const [savingInstructions, setSavingInstructions] = useState(false);
  const [instructionsSaved, setInstructionsSaved] = useState(false);
  const [instructionsError, setInstructionsError] = useState<string | null>(null);

  useEffect(() => {
    getAnalysisInstructions()
      .then((instructions) => setInstructionsInput(instructions ?? ""))
      .catch((err) => setInstructionsError(err instanceof Error ? err.message : String(err)))
      .finally(() => setInstructionsLoading(false));
  }, []);

  async function handleSaveInstructions(event: React.FormEvent) {
    event.preventDefault();
    setSavingInstructions(true);
    try {
      await saveAnalysisInstructions(instructionsInput);
      setInstructionsSaved(true);
      setInstructionsError(null);
    } catch (err) {
      setInstructionsSaved(false);
      setInstructionsError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingInstructions(false);
    }
  }

  return (
    <div>
      <Button type="button" variant="ghost" onClick={onBack}>
        ← Back
      </Button>

      <h1>Settings</h1>

      {/* D7: desktop's "OpenAI API key" section is deliberately absent. */}

      <section>
        <h2>Analysis instructions</h2>
        <p>
          Optional — tell the AI what to emphasize when splitting lessons, e.g. "always separate
          Q&A sections" or "ignore introductions under 30 seconds". This is appended to every
          lesson analysis for every video.
        </p>

        <form onSubmit={handleSaveInstructions}>
          <Label htmlFor="analysis-instructions" className="sr-only">
            Analysis instructions
          </Label>
          <Textarea
            id="analysis-instructions"
            className="my-2 block w-full max-w-2xl resize-y"
            value={instructionsInput}
            onChange={(event) => {
              setInstructionsInput(event.target.value);
              setInstructionsSaved(false);
            }}
            placeholder={
              instructionsLoading
                ? "Loading…"
                : "Optional — tell the AI what to emphasize when splitting lessons, e.g. 'always separate Q&A sections'"
            }
            rows={5}
            disabled={instructionsLoading}
          />
          <Button type="submit" disabled={instructionsLoading || savingInstructions}>
            {savingInstructions ? "Saving…" : "Save"}
          </Button>
        </form>

        {instructionsSaved && (
          <Alert className="mt-4 border-emerald-400/40 bg-emerald-950/40 text-emerald-200">
            <AlertDescription className="text-inherit">Saved.</AlertDescription>
          </Alert>
        )}
        {instructionsError && (
          <Alert variant="destructive" className="mt-4">
            <AlertDescription>{instructionsError}</AlertDescription>
          </Alert>
        )}
      </section>
    </div>
  );
}
