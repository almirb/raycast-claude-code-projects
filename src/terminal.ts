import { execFile, spawn } from "child_process";
import { randomUUID } from "crypto";
import { promisify } from "util";
import fs from "fs";
import os from "os";
import path from "path";
import {
  closeMainWindow,
  getPreferenceValues,
  showToast,
  Toast,
} from "@raycast/api";

const execFileAsync = promisify(execFile);

/**
 * Raycast may carry a stale PATH (captured when its process started) and child
 * terminals inherit that environment, so claude and shell prompt tools may not
 * resolve. All resolution therefore happens here in Node, outside any MSIX
 * container: the true PATH (machine + user) is read from the registry via
 * reg.exe, claude is located on it, and the launched shells only receive
 * ready-made literal strings.
 */
const MACHINE_ENV_KEY =
  "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment";
const USER_ENV_KEY = "HKCU\\Environment";

/**
 * Copies of process.env are plain objects, so lookups must ignore case
 * themselves, as Windows does.
 */
function findKey(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const upper = name.toUpperCase();
  return Object.keys(env).find((key) => key.toUpperCase() === upper);
}

function getVar(env: NodeJS.ProcessEnv, name: string): string {
  const key = findKey(env, name);
  return (key && env[key]) || "";
}

function expandEnvRefs(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(
    /%([^%;]+)%/g,
    (match, name: string) => getVar(env, name) || match,
  );
}

function system32(exe: string): string {
  return path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", exe);
}

/** All string values of a registry environment key, still unexpanded. */
async function regEnv(key: string): Promise<[string, string][]> {
  try {
    // Absolute path on purpose: resolving "reg" depends on the very PATH this
    // function exists to repair, and it is missing in Raycast's environment.
    const { stdout } = await execFileAsync(system32("reg.exe"), ["query", key]);
    return [
      ...stdout.matchAll(/^ {4}(.+?) {4}REG_(?:EXPAND_)?SZ {4}(.*?)\r?$/gm),
    ].map((match): [string, string] => [match[1], match[2].trim()]);
  } catch {
    return [];
  }
}

/**
 * Variables of Raycast's extension runtime. They mean nothing to a terminal
 * and can change the behaviour of Node tools run inside it.
 *
 * Raycast's environment can also carry a Windows BCP-47 locale tag (e.g.
 * "pt-BR-u-ca-gregory-...") in LC_ALL/LANG. POSIX tools spawned inside the
 * session (like Git's bash) reject that format with a warning on every
 * command, and a terminal opened by the user never defines these vars — so
 * they are dropped instead of forwarded.
 */
const RUNTIME_VARS = new Set([
  "EXTENSION_NAME",
  "COMMAND_NAME",
  "ASSETS_PATH",
  "SUPPORT_PATH",
  "FAVICON_PROVIDER",
  "NODE_PATH",
  "NODE_ENV",
  "LANG",
]);

function isRuntimeVar(name: string): boolean {
  const upper = name.toUpperCase();
  return (
    RUNTIME_VARS.has(upper) ||
    upper.startsWith("RAYCAST") ||
    upper.startsWith("LC_")
  );
}

/**
 * Machine-wide variables Windows defines in every user session but that are
 * stored outside the Environment registry keys. Without ProgramData, for
 * example, OpenSSH aborts with status 255 before printing anything. These are
 * the well-known locations on the system drive.
 */
function machineEnvDefaults(systemRoot: string): [string, string][] {
  const drive = systemRoot.slice(0, 2);
  const programFiles = `${drive}\\Program Files`;
  const programFilesX86 = `${drive}\\Program Files (x86)`;
  const programData = `${drive}\\ProgramData`;
  return [
    ["SystemRoot", systemRoot],
    ["windir", systemRoot],
    ["SystemDrive", drive],
    ["ProgramData", programData],
    ["ALLUSERSPROFILE", programData],
    ["ProgramFiles", programFiles],
    ["ProgramW6432", programFiles],
    ["ProgramFiles(x86)", programFilesX86],
    ["CommonProgramFiles", path.join(programFiles, "Common Files")],
    ["CommonProgramW6432", path.join(programFiles, "Common Files")],
    ["CommonProgramFiles(x86)", path.join(programFilesX86, "Common Files")],
    ["PUBLIC", `${drive}\\Users\\Public`],
    ["COMPUTERNAME", os.hostname().toUpperCase()],
  ];
}

function findClaude(pathString: string): string | null {
  for (const dir of pathString.split(";").filter(Boolean)) {
    for (const name of ["claude.exe", "claude.cmd", "claude.bat"]) {
      const candidate = path.join(dir.trim(), name);
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        // inaccessible folder — try the next one
      }
    }
  }
  return null;
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Raycast's MSIX environment can lack fundamental variables, not just a
 * stale PATH. Without LOCALAPPDATA, for example, VS Code's terminal cannot
 * find the Store install of pwsh and falls back to Windows PowerShell.
 * These are the well-known per-user defaults, derived from the profile dir.
 */
function essentialEnvDefaults(profile: string): [string, string][] {
  const local = path.join(profile, "AppData", "Local");
  return [
    ["USERPROFILE", profile],
    ["APPDATA", path.join(profile, "AppData", "Roaming")],
    ["LOCALAPPDATA", local],
    ["TEMP", path.join(local, "Temp")],
    ["TMP", path.join(local, "Temp")],
  ];
}

interface SessionEnv {
  env: NodeJS.ProcessEnv;
  /** Runtime variables dropped from Raycast's environment. */
  removed: string[];
  /** Variables Raycast's environment missed or carried empty, as restored. */
  restored: [string, string][];
}

/**
 * Environment handed to every process launched from here — terminals and the
 * editor alike, since VS Code passes it on to its integrated terminal. Windows
 * Terminal also hands it to every tab later opened with its "+" button, so it
 * must be as complete as the one Explorer gives a terminal opened by the user.
 */
async function sessionEnv(): Promise<SessionEnv> {
  const [machineVars, userVars] = await Promise.all([
    regEnv(MACHINE_ENV_KEY),
    regEnv(USER_ENV_KEY),
  ]);

  const env = { ...process.env };
  const removed = Object.keys(env).filter(isRuntimeVar);
  for (const key of removed) delete env[key];

  // Fill what is missing or empty, never overriding a value Raycast carries.
  // Precedence follows Windows: user variables, then machine variables, then
  // the well-known defaults for those stored elsewhere.
  const systemRoot =
    getVar(env, "SystemRoot") || getVar(env, "windir") || "C:\\Windows";
  const profile = getVar(env, "USERPROFILE") || os.homedir();
  const candidates = [
    ...userVars,
    ...machineVars,
    ...machineEnvDefaults(systemRoot),
    ...essentialEnvDefaults(profile),
  ].filter(([name]) => name.toUpperCase() !== "PATH");
  const restoredNames = new Set<string>();
  for (const [name, value] of candidates) {
    const key = findKey(env, name);
    if (key && env[key]) continue;
    if (key) delete env[key];
    env[name] = value;
    restoredNames.add(name);
  }
  // Registry values may reference each other (%SystemRoot%, %USERPROFILE%),
  // so they are expanded only once every variable is in place.
  for (const name of restoredNames) {
    env[name] = expandEnvRefs(env[name] ?? "", env);
  }

  const regPath = (vars: [string, string][]) =>
    expandEnvRefs(
      vars.find(([name]) => name.toUpperCase() === "PATH")?.[1] ?? "",
      env,
    );
  const combined =
    [regPath(machineVars), regPath(userVars)].filter(Boolean).join(";") ||
    expandEnvRefs(process.env.PATH ?? "", env);

  // Safety net in case the registry read fails in the Raycast context: System32
  // (without it not even cmd.exe resolves) plus the default install locations
  // of oh-my-posh (winget), claude (native), npm and VS Code's CLI.
  const programs = path.join(getVar(env, "LOCALAPPDATA"), "Programs");
  const wellKnown = [
    path.join(systemRoot, "System32"),
    path.join(programs, "oh-my-posh", "bin"),
    path.join(programs, "Microsoft VS Code", "bin"),
    path.join(getVar(env, "USERPROFILE"), ".local", "bin"),
    path.join(getVar(env, "APPDATA"), "npm"),
  ].filter((dir) => dir.length > 3 && fs.existsSync(dir));

  const present = new Set(
    combined.split(";").map((d) => d.trim().replace(/\\+$/, "").toLowerCase()),
  );
  const missing = wellKnown.filter(
    (d) => !present.has(d.replace(/\\+$/, "").toLowerCase()),
  );

  const pathKey = findKey(env, "PATH");
  if (pathKey) delete env[pathKey];
  env.Path = missing.length > 0 ? `${combined};${missing.join(";")}` : combined;

  return {
    env,
    removed,
    restored: [...restoredNames].map((name) => [name, env[name] ?? ""]),
  };
}

/**
 * Splits the free-form claudeArgs preference into argv tokens, honouring
 * double and single quotes so values with spaces survive intact
 * (e.g. --add-dir "C:\My Projects").
 *
 * Backslashes follow the Windows CommandLineToArgvW rule, so the preference
 * behaves like the command line it stands for: a backslash is literal unless
 * it precedes a double quote, where 2n backslashes give n backslashes plus a
 * delimiting quote and 2n+1 give n backslashes plus a literal quote. That
 * keeps --prompt "say \"hello world\"" as a single argument. As on Windows, a
 * double-quoted value therefore cannot end in a lone backslash: write
 * "C:\My Projects\\" or drop the trailing separator. Single quotes have no
 * escape, so backslashes inside them are always literal.
 */
function splitArgs(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let inToken = false;
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === "\\" && quote !== "'") {
      let slashes = 0;
      while (input[i] === "\\") {
        slashes++;
        i++;
      }
      if (input[i] === '"') {
        current += "\\".repeat(slashes >> 1);
        // An odd count consumes the quote as a literal one; an even count
        // leaves it for the delimiter branches below.
        if (slashes % 2 === 1) {
          current += '"';
          i++;
        }
      } else {
        current += "\\".repeat(slashes);
      }
      inToken = true;
    } else if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      i++;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
      i++;
    } else if (/\s/.test(ch)) {
      if (inToken) tokens.push(current);
      current = "";
      inToken = false;
      i++;
    } else {
      current += ch;
      inToken = true;
      i++;
    }
  }
  if (inToken) tokens.push(current);
  return tokens;
}

/**
 * Quotes one argument for the cmd branches, where two parsers read the same
 * text: cmd, which only knows double quotes and the caret escape, and the
 * launched program, which follows the CommandLineToArgvW rule where \" is a
 * literal quote.
 *
 * So the value is first quoted the CommandLineToArgvW way — always wrapped in
 * double quotes, embedded quotes turned into \", and backslashes doubled only
 * where they precede a quote — and then every cmd metacharacter that ends up
 * outside cmd's own quoting is escaped with a caret. cmd ignores the backslash,
 * so each \" still toggles its quoting state and leaves the text in between
 * exposed; the caret pass is what keeps that text literal.
 */
function cmdQuote(value: string): string {
  let quoted = '"';
  let i = 0;
  while (i < value.length) {
    let slashes = 0;
    while (value[i] === "\\") {
      slashes++;
      i++;
    }
    if (i === value.length) {
      quoted += "\\".repeat(slashes * 2);
      break;
    }
    if (value[i] === '"') quoted += "\\".repeat(slashes * 2 + 1) + '"';
    else quoted += "\\".repeat(slashes) + value[i];
    i++;
  }
  quoted += '"';

  let escaped = "";
  let inQuotes = false;
  for (const ch of quoted) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && /[&|<>^()]/.test(ch)) escaped += "^";
    escaped += ch;
  }
  return escaped;
}

const LAUNCH_SCRIPT_PREFIX = "claude-code-projects-launch-";

/**
 * A literal % cannot be escaped on the cmd command line: quoting does not
 * stop %NAME% expansion and %% only escapes inside batch scripts — and here
 * the command would cross two cmd layers (the outer `cmd /s /c "start ..."`
 * plus the inner `cmd /k`). Writing the claude call to a batch file, where
 * %% reliably yields a literal %, keeps the arguments out of both parsers.
 *
 * Each launch gets its own file so overlapping launches cannot overwrite one
 * another before the (asynchronous) inner cmd reads the script. Scripts from
 * past launches are deleted after a day — long enough that their sessions
 * have read them, since cmd only re-reads the file after claude exits.
 */
function writeCmdLaunchScript(lines: string[]): string {
  const dir = os.tmpdir();
  try {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(LAUNCH_SCRIPT_PREFIX) || !name.endsWith(".cmd")) {
        continue;
      }
      const full = path.join(dir, name);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
      } catch {
        // already gone or inaccessible — cleanup is best-effort
      }
    }
  } catch {
    // cleanup is best-effort
  }
  const scriptPath = path.join(
    dir,
    `${LAUNCH_SCRIPT_PREFIX}${randomUUID()}.cmd`,
  );
  const body = lines.map((line) => line.replace(/%/g, "%%")).join("\r\n");
  fs.writeFileSync(scriptPath, `@echo off\r\n${body}\r\n`);
  return scriptPath;
}

function encodedStartupScript(
  realPathString: string,
  claudeExe: string | null,
  args: string[],
): string {
  const quotedArgs = args.map(psQuote).join(" ");
  const claudeCall = claudeExe
    ? `& ${psQuote(claudeExe)} ${quotedArgs}`.trim()
    : `claude ${quotedArgs}`.trim();
  const script = [
    `$env:Path = ${psQuote(realPathString)}`,
    "if (Test-Path $PROFILE) { . $PROFILE }",
    claudeCall,
  ].join("\n");
  return Buffer.from(script, "utf16le").toString("base64");
}

function onFail(message: string, title = "Failed to open the terminal") {
  return () => {
    showToast({
      style: Toast.Style.Failure,
      title,
      message,
    });
  };
}

/**
 * Opens a new console window via cmd's `start`. Needed because spawn with
 * detached uses DETACHED_PROCESS, which creates the process WITHOUT a visible
 * console.
 */
function runInNewWindow(
  shellCommand: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  missingMsg: string,
): void {
  const inner = `start "" /d "${cwd}" ${shellCommand}`;
  const child = spawn("cmd.exe", ["/d", "/s", "/c", `"${inner}"`], {
    detached: true,
    stdio: "ignore",
    windowsVerbatimArguments: true,
    env,
  });
  child.on("error", onFail(missingMsg));
  child.on("exit", (code) => {
    if (code !== 0) onFail(missingMsg)();
  });
  child.unref();
}

/**
 * Opens a new Windows Terminal tab (most recent window, or a new one) running
 * claude through a small launch script — no user shell profile in between, so
 * prompt tools like oh-my-posh never come into play.
 *
 * The script, not the spawn env, sets the real PATH: `wt -w 0 nt` attaches to
 * an existing window, and the new tab inherits the environment of that
 * window's process — which can be Raycast's stale environment if the window
 * was created by an earlier launch. Fixing PATH inside the script guarantees
 * claude and everything it spawns (hooks, editors, nested shells) see the
 * real environment regardless of which window hosts the tab.
 */
function runInTerminalTab(
  cwd: string,
  claudeExe: string | null,
  args: string[],
  session: SessionEnv,
): void {
  const { env, removed, restored } = session;
  const claudeCall = [
    claudeExe ? cmdQuote(claudeExe) : "claude",
    ...args.map(cmdQuote),
  ].join(" ");
  let script: string;
  try {
    // Runtime vars cleared and missing vars restored for the same reason
    // they are fixed in the spawn env in sessionEnv — the attached tab
    // inherits the hosting window's environment, not the spawn env.
    const cleared = new Set(["LANG", "LC_ALL", ...removed]);
    script = writeCmdLaunchScript([
      `set "Path=${env.Path ?? ""}"`,
      ...[...cleared].map((name) => `set "${name}="`),
      ...restored.map(
        ([name, value]) => `if not defined ${name} set "${name}=${value}"`,
      ),
      claudeCall,
    ]);
  } catch {
    onFail("Could not write the launch script to the temp folder.")();
    return;
  }
  const child = spawn(
    "wt.exe",
    ["-w", "0", "nt", "-d", cwd, "cmd", "/d", "/c", script],
    {
      detached: true,
      stdio: "ignore",
      env,
    },
  );
  child.on(
    "error",
    onFail(
      "Windows Terminal (wt) not found. Change the terminal in the extension preferences.",
    ),
  );
  child.unref();
}

/** Opens the terminal chosen in preferences inside cwd, running the claude command. */
export async function launchClaude(
  cwd: string,
  baseArgs: string[],
): Promise<void> {
  if (cwd.includes('"')) return; // invalid Windows path; avoids breaking the shell

  const { terminal, claudeArgs } = getPreferenceValues<Preferences>();
  const args = [...baseArgs, ...splitArgs(claudeArgs ?? "")];

  const session = await sessionEnv();
  const { env } = session;
  const pathString = env.Path ?? "";
  const claudeExe = findClaude(pathString);
  const encoded = encodedStartupScript(pathString, claudeExe, args);

  await closeMainWindow();

  switch (terminal) {
    case "pwsh":
      runInNewWindow(
        `pwsh -NoProfile -NoExit -EncodedCommand ${encoded}`,
        cwd,
        env,
        "PowerShell 7 (pwsh) not found on PATH.",
      );
      break;
    case "powershell":
      runInNewWindow(
        `powershell -NoProfile -NoExit -EncodedCommand ${encoded}`,
        cwd,
        env,
        "Windows PowerShell not found.",
      );
      break;
    case "cmd": {
      const claudeCall = [
        claudeExe ? cmdQuote(claudeExe) : "claude",
        ...args.map(cmdQuote),
      ].join(" ");
      let script: string;
      try {
        script = writeCmdLaunchScript([claudeCall]);
      } catch {
        onFail("Could not write the launch script to the temp folder.")();
        return;
      }
      runInNewWindow(`cmd /k "${script}"`, cwd, env, "cmd not found.");
      break;
    }
    case "windowsTerminal":
    default:
      runInTerminalTab(cwd, claudeExe, args, session);
      break;
  }
}

export async function openInVSCode(cwd: string): Promise<void> {
  const { env } = await sessionEnv();
  const fail = (detail: string) =>
    onFail(
      `${detail}. Make sure \`code\` works in a terminal.`,
      "Failed to open VS Code",
    )();

  await closeMainWindow();

  // `code` is a .cmd shim, so it needs a shell; the folder never touches the
  // command line, it is the child's working directory.
  const child = spawn("code", ["."], {
    cwd,
    env,
    shell: true,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", (error) => fail(error.message));
  child.on("exit", (code) => {
    if (code !== 0) fail(`\`code .\` exited with status ${code}`);
  });
  child.unref();
}
