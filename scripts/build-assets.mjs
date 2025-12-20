import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const TEMPLATE_PATH = path.join(ROOT, "src", "client", "index.template.html");
const OUT_PATH = path.join(ROOT, "public", "index.html");

async function readDevVars() {
  try {
    const p = path.join(ROOT, ".dev.vars");
    const raw = await fs.readFile(p, "utf8");
    const vars = {};
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      vars[key] = val;
    }
    return vars;
  } catch {
    return {};
  }
}

async function main() {
  const devVars = await readDevVars();
  const siteKey =
    process.env.TURNSTILE_SITE_KEY ||
    devVars.TURNSTILE_SITE_KEY ||
    "YOUR_TURNSTILE_SITE_KEY";

  const tpl = await fs.readFile(TEMPLATE_PATH, "utf8");
  const out = tpl.replaceAll("__TURNSTILE_SITE_KEY__", siteKey);

  await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
  await fs.writeFile(OUT_PATH, out, "utf8");

  // eslint-disable-next-line no-console
  console.log(`built ${path.relative(ROOT, OUT_PATH)} (TURNSTILE_SITE_KEY=${siteKey === "YOUR_TURNSTILE_SITE_KEY" ? "unset" : "set"})`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

