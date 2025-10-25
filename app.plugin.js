// app.plugin.js
const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

// Align with expo-updates: use Kotlin 2.1.20 and let Expo choose the matching KSP.
const KOTLIN = '2.1.20';

function setOrInsertTomlVersion(contents, key, value) {
  let out = contents;
  if (!/\[versions\]/.test(out)) out = `[versions]\n${out}`;
  const re = new RegExp(`(^\\s*${key}\\s*=\\s*")(.*?)(")`, 'm');
  if (re.test(out)) return out.replace(re, `$1${value}$3`);
  return out.replace(/\[versions\]/, `[versions]\n${key} = "${value}"`);
}

module.exports = function withForceKotlin(config) {
  return withDangerousMod(config, [
    'android',
    async (cfg) => {
      const root = cfg.modRequest.platformProjectRoot;

      // 1) Version catalog: set kotlin=2.1.20 and REMOVE any pinned ksp
      const toml = path.join(root, 'gradle', 'libs.versions.toml');
      if (fs.existsSync(toml)) {
        let t = fs.readFileSync(toml, 'utf8');
        t = setOrInsertTomlVersion(t, 'kotlin', KOTLIN);
        // Remove any ksp line to let Expo map it automatically
        t = t.replace(/^\s*ksp\s*=\s*".*"\s*$/m, '');
        fs.writeFileSync(toml, t);
      }

      // 2) settings.gradle: pin kotlin plugin version if present
      const settings = path.join(root, 'settings.gradle');
      if (fs.existsSync(settings)) {
        let s = fs.readFileSync(settings, 'utf8');
        s = s.replace(
          /id\(["']org\.jetbrains\.kotlin\.android["']\)\s+version\s+["'][^"']+["']/g,
          `id("org.jetbrains.kotlin.android") version "${KOTLIN}"`
        );
        fs.writeFileSync(settings, s);
      }

      // 3) Root build.gradle(.kts): same pin if used there
      for (const f of ['build.gradle', 'build.gradle.kts']) {
        const p = path.join(root, f);
        if (fs.existsSync(p)) {
          let g = fs.readFileSync(p, 'utf8');
          g = g.replace(
            /id\(["']org\.jetbrains\.kotlin\.android["']\)\s+version\s+["'][^"']+["']/g,
            `id("org.jetbrains.kotlin.android") version "${KOTLIN}"`
          );
          fs.writeFileSync(p, g);
        }
      }

      return cfg;
    },
  ]);
};
