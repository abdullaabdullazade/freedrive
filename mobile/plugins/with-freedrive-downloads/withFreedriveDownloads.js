const {
  withDangerousMod,
  createRunOncePlugin,
} = require("expo/config-plugins");
const fs = require("fs");
const path = require("path");

const PLUGIN_NAME = "with-freedrive-downloads";
const PACKAGE_DIR = "app/src/main/java/com/freedrive/mobile";
const BCPROV_DEP =
  '    implementation("org.bouncycastle:bcprov-jdk18on:1.78.1")';

function copyKotlinSources(androidProjectRoot) {
  const destDir = path.join(androidProjectRoot, PACKAGE_DIR);
  fs.mkdirSync(destDir, { recursive: true });
  const srcDir = __dirname;
  for (const name of ["DownloadsModule.kt", "DownloadsPackage.kt"]) {
    fs.copyFileSync(path.join(srcDir, name), path.join(destDir, name));
  }
}

function ensurePackageRegistered(mainAppPath) {
  if (!fs.existsSync(mainAppPath)) {
    throw new Error(`MainApplication not found at ${mainAppPath}`);
  }
  let contents = fs.readFileSync(mainAppPath, "utf8");
  if (contents.includes("DownloadsPackage()")) {
    return;
  }

  if (contents.includes("// add(MyReactNativePackage())")) {
    contents = contents.replace(
      "// add(MyReactNativePackage())",
      "add(DownloadsPackage())",
    );
  } else if (
    /PackageList\(this\)\.packages\.apply\s*\{/.test(contents)
  ) {
    contents = contents.replace(
      /PackageList\(this\)\.packages\.apply\s*\{/,
      (match) => `${match}\n          add(DownloadsPackage())`,
    );
  } else {
    throw new Error(
      "Could not find PackageList packages.apply block to register DownloadsPackage",
    );
  }

  fs.writeFileSync(mainAppPath, contents);
}

/** Streaming AES-GCM decrypt needs BouncyCastle (Conscrypt buffers entire AEAD). */
function ensureBcprovDependency(androidProjectRoot) {
  const gradlePath = path.join(androidProjectRoot, "app", "build.gradle");
  if (!fs.existsSync(gradlePath)) return;
  let contents = fs.readFileSync(gradlePath, "utf8");
  if (contents.includes("bcprov-jdk18on")) return;

  if (/dependencies\s*\{/.test(contents)) {
    contents = contents.replace(
      /dependencies\s*\{/,
      (match) => `${match}\n${BCPROV_DEP}`,
    );
  } else {
    contents += `\n\ndependencies {\n${BCPROV_DEP}\n}\n`;
  }
  fs.writeFileSync(gradlePath, contents);
}

function withFreedriveDownloads(config) {
  return withDangerousMod(config, [
    "android",
    async (cfg) => {
      const androidRoot = cfg.modRequest.platformProjectRoot;
      copyKotlinSources(androidRoot);
      ensurePackageRegistered(
        path.join(androidRoot, PACKAGE_DIR, "MainApplication.kt"),
      );
      ensureBcprovDependency(androidRoot);
      return cfg;
    },
  ]);
}

module.exports = createRunOncePlugin(
  withFreedriveDownloads,
  PLUGIN_NAME,
  "1.1.0",
);
