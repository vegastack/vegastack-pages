import { LockKeyhole } from "lucide-react";
import { useState } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

type SharePasswordPromptProps = {
  publicationId: string;
  workspaceId: string;
};

export function SharePasswordPrompt({
  publicationId,
  workspaceId,
}: SharePasswordPromptProps) {
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState("");

  async function verifyPassword(event: { preventDefault(): void }) {
    event.preventDefault();
    setStatus("Checking...");
    const response = await fetch(
      `/api/publications/${publicationId}/verify-password?workspace_id=${encodeURIComponent(workspaceId)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      },
    );
    if (!response.ok) {
      setStatus("Password did not match.");
      return;
    }
    window.location.reload();
  }

  return (
    <main className="share-password-page">
      <form
        className="share-password-card"
        onSubmit={(event) => void verifyPassword(event)}
      >
        <div className="share-password-icon" aria-hidden="true">
          <LockKeyhole size={18} />
        </div>
        <h1>Password required</h1>
        <p>This public page is protected. Enter the password to continue.</p>
        <Input
          autoComplete="current-password"
          autoFocus
          placeholder="Password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <Button type="submit" variant="primary">
          Continue
        </Button>
        {status ? <p className="vpg-form-status">{status}</p> : null}
      </form>
    </main>
  );
}
