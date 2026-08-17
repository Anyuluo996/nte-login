import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const extraArgs = process.argv.slice(2);
const hasSecretsFile = extraArgs.some(
  (arg) => arg === "--secrets-file" || arg.startsWith("--secrets-file="),
);
const sharedSecret = process.env.SHARED_SECRET?.trim();
const wranglerArgs = ["deploy", ...extraArgs];

let temporaryDirectory;

try {
  if (sharedSecret && !hasSecretsFile) {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "nte-login-cloudflare-"));
    const secretsFile = join(temporaryDirectory, "secrets.json");

    await writeFile(
      secretsFile,
      JSON.stringify({ SHARED_SECRET: sharedSecret }),
      {
        mode: 0o600,
      },
    );
    wranglerArgs.push("--secrets-file", secretsFile);
  }

  const wranglerCommand =
    process.platform === "win32" ? "wrangler.cmd" : "wrangler";
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(wranglerCommand, wranglerArgs, { stdio: "inherit" });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`wrangler terminated by ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });

  process.exitCode = exitCode;
} finally {
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
