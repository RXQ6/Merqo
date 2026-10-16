/**
 * Cross-platform resources copy script
 */

import { existsSync, cpSync } from "fs";
import { join } from "path";

const ROOT_DIR = join(import.meta.dir, "..");
const ELECTRON_DIR = join(ROOT_DIR, "apps/electron");

const srcDir = join(ELECTRON_DIR, "resources");
const destDir = join(ELECTRON_DIR, "dist/resources");

if (existsSync(srcDir)) {
  cpSync(srcDir, destDir, { recursive: true, force: true });
  console.log("📦 Copied resources to dist");
} else {
  console.log("⚠️ No resources directory found");
}

// Versioned retail Skills are runtime resources, including packaged desktop builds.
cpSync(join(ROOT_DIR, "packages/retail-domain/skills"), join(destDir, "retail-skills"), { recursive: true, force: true });
