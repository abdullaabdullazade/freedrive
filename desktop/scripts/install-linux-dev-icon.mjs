import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (platform() === "linux") {
  const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const executable = join(desktopRoot, "src-tauri", "target", "debug", "freedrive-desktop");
  const iconDir = join(homedir(), ".local", "share", "icons", "hicolor", "1024x1024", "apps");
  const launcherDir = join(homedir(), ".local", "share", "applications");
  const iconPath = join(iconDir, "freedrive-desktop.png");

  await Promise.all([
    mkdir(iconDir, { recursive: true }),
    mkdir(launcherDir, { recursive: true }),
  ]);
  await copyFile(join(desktopRoot, "app-icon.png"), iconPath);
  await writeFile(
    join(launcherDir, "freedrive-desktop.desktop"),
    `[Desktop Entry]\nType=Application\nName=FreeDrive\nComment=Secure file sync and cloud drive\nExec=${executable}\nTryExec=${executable}\nIcon=freedrive-desktop\nTerminal=false\nCategories=Network;FileTransfer;\nStartupWMClass=freedrive-desktop\n`,
    "utf8",
  );
}
