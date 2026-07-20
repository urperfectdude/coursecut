import { useEffect, useState } from "react";
import {
  getAnalysisInstructions,
  getOpenAiKeyStatus,
  saveAnalysisInstructions,
  saveOpenAiKey,
  testOpenAiKey,
  type KeyStatus,
} from "../db";

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
      <button type="button" className="back-button" onClick={onBack}>
        ← Back
      </button>

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

        <form onSubmit={handleSave} className="new-project-form">
          <input
            type="password"
            value={keyInput}
            onChange={(event) => setKeyInput(event.target.value)}
            placeholder="sk-..."
            aria-label="OpenAI API key"
          />
          <button type="submit" disabled={!keyInput.trim() || saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </form>

        <button type="button" onClick={handleTest} disabled={testing}>
          {testing ? "Testing…" : "Test Connection"}
        </button>

        {testResult && (
          <p className={testResult.valid ? "success" : "error"}>{testResult.message}</p>
        )}

        {error && <p className="error">{error}</p>}
      </section>

      <section>
        <h2>Analysis instructions</h2>
        <p>
          Optional — tell the AI what to emphasize when splitting lessons, e.g. "always separate
          Q&A sections" or "ignore introductions under 30 seconds". This is appended to every
          lesson analysis for every video.
        </p>

        <form onSubmit={handleSaveInstructions}>
          <textarea
            className="analysis-instructions-input"
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
            aria-label="Analysis instructions"
            rows={5}
            disabled={instructionsLoading}
          />
          <button type="submit" disabled={instructionsLoading || savingInstructions}>
            {savingInstructions ? "Saving…" : "Save"}
          </button>
        </form>

        {instructionsSaved && <p className="success">Saved.</p>}
        {instructionsError && <p className="error">{instructionsError}</p>}
      </section>
    </div>
  );
}
