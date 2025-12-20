import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const INDEX_TEMPLATE_PATH = path.join(ROOT, "src", "client", "index.template.html");
const INDEX_OUT_PATH = path.join(ROOT, "public", "index.html");
const ADMIN_TEMPLATE_PATH = path.join(ROOT, "src", "client", "admin.template.html");
const ADMIN_OUT_PATH = path.join(ROOT, "public", "admin.html");

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

  await fs.mkdir(path.join(ROOT, "public"), { recursive: true });

  const indexTpl = await fs.readFile(INDEX_TEMPLATE_PATH, "utf8");
  const indexOut = indexTpl.replaceAll("__TURNSTILE_SITE_KEY__", siteKey);
  await fs.writeFile(INDEX_OUT_PATH, indexOut, "utf8");

  const adminTpl = await fs.readFile(ADMIN_TEMPLATE_PATH, "utf8");
  const adminOut = adminTpl.replaceAll("__TURNSTILE_SITE_KEY__", siteKey);
  await fs.writeFile(ADMIN_OUT_PATH, adminOut, "utf8");

  // eslint-disable-next-line no-console
  console.log(
    `built public/index.html + public/admin.html (TURNSTILE_SITE_KEY=${siteKey === "YOUR_TURNSTILE_SITE_KEY" ? "unset" : "set"})`
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

