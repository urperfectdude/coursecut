import { useEffect, useState } from "react";
import {
  getAnalysisInstructions,
  getOpenAiKeyStatus,
  saveAnalysisInstructions,
  saveOpenAiKey,
  testOpenAiKey,
  type KeyStatus,
} from "../db";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

interface SettingsViewProps {
  onBack: () => void;
}

export default function SettingsView({ onBack }: SettingsViewProps) {
  const [status, setStatus] = useState<KeyStatus | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ valid: boolean; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [instructionsInput, setInstructionsInput] = useState("");
  const [instructionsLoading, setInstructionsLoading] = useState(true);
  const [savingInstructions, setSavingInstructions] = useState(false);
  const [instructionsSaved, setInstructionsSaved] = useState(false);
  const [instructionsError, setInstructionsError] = useState<string | null>(null);

  async function refreshStatus() {
    try {
      setStatus(await getOpenAiKeyStatus());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    refreshStatus();
    getAnalysisInstructions()
      .then((instructions) => setInstructionsInput(instructions ?? ""))
      .catch((err) => setInstructionsError(err instanceof Error ? err.message : String(err)))
      .finally(() => setInstructionsLoading(false));
  }, []);

  async function handleSave(event: React.FormEvent) {
    event.preventDefault();
    const key = keyInput.trim();
    if (!key) return;
    setSaving(true);
    try {
      await saveOpenAiKey(key);
      setKeyInput("");
      setTestResult(null);
      await refreshStatus();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    try {
      const result = await testOpenAiKey();
      setTestResult(result);
      setError(null);
    } catch (err) {
      setTestResult(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  }

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

      <section>
        <h2>OpenAI API key</h2>
        <p>
          {status === null
            ? "Loading…"
            : status.present
              ? `API key ending in •••${status.last_four}`
              : "No key saved."}
        </p>

        <form onSubmit={handleSave} className="my-4 flex gap-2">
          <Label htmlFor="openai-api-key" className="sr-only">
            OpenAI API key
          </Label>
          <Input
            id="openai-api-key"
            type="password"
            value={keyInput}
            onChange={(event) => setKeyInput(event.target.value)}
            placeholder="sk-..."
          />
          <Button type="submit" disabled={!keyInput.trim() || saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </form>

        <Button type="button" variant="outline" onClick={handleTest} disabled={testing}>
          {testing ? "Testing…" : "Test Connection"}
        </Button>

        {testResult && (
          <Alert
            variant={testResult.valid ? "default" : "destructive"}
            className={
              testResult.valid
                ? "mt-4 border-emerald-600/40 bg-emerald-50 text-emerald-900 dark:border-emerald-400/40 dark:bg-emerald-950/40 dark:text-emerald-200"
                : "mt-4"
            }
          >
            <AlertDescription className={testResult.valid ? "text-inherit" : undefined}>
              {testResult.message}
            </AlertDescription>
          </Alert>
        )}

        {error && (
          <Alert variant="destructive" className="mt-4">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </section>

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
          <Alert className="mt-4 border-emerald-600/40 bg-emerald-50 text-emerald-900 dark:border-emerald-400/40 dark:bg-emerald-950/40 dark:text-emerald-200">
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
