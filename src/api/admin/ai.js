import { jsonNoStore, badRequest } from '../../utils/response.js';
import { isValidAlbumId } from '../../utils/validate.js';
import { readJson } from '../../utils/http.js';

const DEFAULT_MODEL = "@cf/meta/llama-2-7b-chat-int8";

function formatDatePrefixUtc(d = new Date()) {
  // YYYY.MM.DD-
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}.${mm}.${dd}-`;
}

function clampNumber(raw, { min, max, fallback, integer = false }) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const v = Math.min(max, Math.max(min, n));
  return integer ? Math.floor(v) : v;
}

function extractText(out) {
  if (typeof out === "string") return out;
  if (out && typeof out.response === "string") return out.response;
  if (out && out.result && typeof out.result.response === "string") return out.result.response;
  return JSON.stringify(out || "");
}

function firstLineStripped(raw) {
  const firstLine = String(raw || "").split(/\r?\n/)[0] || "";
  return firstLine.trim().replace(/^["'`]+/, "").replace(/["'`]+$/, "");
}

export function normalizeAiSlugToAlbumId(raw) {
  let s = firstLineStripped(raw).toLowerCase();
  s = s.replace(/[^a-z-]+/g, "-");
  s = s.replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  return s;
}

export function isValidAiSlugAlbumId(slug) {
  const s = String(slug || "");
  if (!/^[a-z-]{1,128}$/.test(s)) return false;
  const words = s.split("-").filter(Boolean);
  return words.length >= 3 && words.length <= 4;
}

export function normalizeAiTitle(raw) {
  let s = firstLineStripped(raw);
  s = s.replace(/[\u0000-\u001F\u007F]/g, ""); // strip control chars
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > 80) s = s.slice(0, 80).trim();
  s = s.replace(/^[\s\-–—:;,.!?]+/, "").replace(/[\s\-–—:;,.!?]+$/, "").trim();
  return s;
}

/**
 * Run a chat prompt up to two times (second attempt stricter); `accept(raw)` returns the
 * normalized value or a falsy value to retry.
 */
async function runWithRetry(env, { model, max_tokens, temperature, top_p }, prompts, accept) {
  for (const prompt of prompts) {
    let out;
    try {
      out = await env.AI.run(model, {
        messages: [{ role: "user", content: prompt }],
        max_tokens,
        temperature,
        top_p
      });
    } catch {
      return { ok: false, status: 502, error: "AI generation failed" };
    }
    const raw = extractText(out);
    const value = accept(raw);
    if (value) return { ok: true, value, raw: String(raw || "") };
  }
  return null;
}

function validateDescription(env, description) {
  if (!env || !env.AI) return { ok: false, status: 501, error: "Workers AI is not configured (missing AI binding)" };
  const desc = String(description || "").trim();
  if (!desc) return { ok: false, status: 400, error: "Missing description" };
  if (desc.length > 500) return { ok: false, status: 400, error: "Description too long" };
  return { ok: true, desc };
}

export async function generateAlbumIdViaAi(env, description) {
  const v = validateDescription(env, description);
  if (!v.ok) return v;

  const datePrefix = formatDatePrefixUtc(new Date());
  const maxSlugLen = Math.max(1, 128 - datePrefix.length);

  const basePrompt =
    `${v.desc}\n\n` +
    `Generate a short English slug (3–4 words) in kebab-case.\n` +
    `Output must be a single line with only lowercase letters a-z and hyphens.\n` +
    `Include exactly 1 pleasant vivid adjective as one of the words.\n` +
    `No extra text.`;
  const strictPrompt =
    `${basePrompt}\n\nIMPORTANT: Return exactly 3 or 4 words, joined by single hyphens. Include exactly 1 pleasant adjective. Do NOT include quotes, punctuation, numbers, or additional lines.`;

  const opts = {
    model: String(env.AI_ALBUM_ID_MODEL || "").trim() || DEFAULT_MODEL,
    max_tokens: clampNumber(env.AI_ALBUM_ID_MAX_TOKENS, { min: 1, max: 64, fallback: 16, integer: true }),
    temperature: clampNumber(env.AI_ALBUM_ID_TEMPERATURE, { min: 0, max: 1, fallback: 0.2 }),
    top_p: clampNumber(env.AI_ALBUM_ID_TOP_P, { min: 0.1, max: 1, fallback: 0.9 })
  };

  const r = await runWithRetry(env, opts, [basePrompt, strictPrompt], (raw) => {
    let slug = normalizeAiSlugToAlbumId(raw);
    if (slug.length > maxSlugLen) slug = slug.slice(0, maxSlugLen).replace(/-+$/g, "");
    return isValidAiSlugAlbumId(slug) ? slug : "";
  });
  if (r === null) return { ok: false, status: 502, error: "AI returned an invalid slug" };
  if (!r.ok) return r;

  const albumId = `${datePrefix}${r.value}`;
  if (!isValidAlbumId(albumId)) return { ok: false, status: 502, error: "AI output did not produce a valid albumId" };
  return { ok: true, albumId, raw: r.raw };
}

export async function generateAlbumTitleViaAi(env, description) {
  const v = validateDescription(env, description);
  if (!v.ok) return v;

  const basePrompt =
    `${v.desc}\n\n` +
    `Generate a short, human-friendly album title (2–6 words).\n` +
    `- Output MUST be in English.\n` +
    `- Do NOT include a date.\n` +
    `- Output must be a single line.\n` +
    `- No quotes, no extra text.`;
  const strictPrompt = `${basePrompt}\n\nIMPORTANT: Return only the title text on one line. No punctuation-only output.`;

  const opts = {
    model: String(env.AI_ALBUM_TITLE_MODEL || "").trim() || String(env.AI_ALBUM_ID_MODEL || "").trim() || DEFAULT_MODEL,
    max_tokens: clampNumber(env.AI_ALBUM_TITLE_MAX_TOKENS, { min: 1, max: 96, fallback: 24, integer: true }),
    temperature: clampNumber(env.AI_ALBUM_TITLE_TEMPERATURE, { min: 0, max: 1, fallback: 0.3 }),
    top_p: clampNumber(env.AI_ALBUM_TITLE_TOP_P, { min: 0.1, max: 1, fallback: 0.9 })
  };

  const r = await runWithRetry(env, opts, [basePrompt, strictPrompt], normalizeAiTitle);
  if (r === null) return { ok: false, status: 502, error: "AI returned an empty title" };
  if (!r.ok) return r;
  return { ok: true, title: r.value, raw: r.raw };
}

/** POST /api/admin/generate-album-id */
export async function handleGenerateAlbumId({ request, env }) {
  const body = await readJson(request);
  if (!body) return badRequest("Bad JSON");
  const description = String(body.description || body.text || body.prompt || "").trim();

  // ID is required, title is best-effort; run both in parallel.
  const [idRes, titleRes] = await Promise.all([
    generateAlbumIdViaAi(env, description),
    generateAlbumTitleViaAi(env, description).catch(() => null)
  ]);
  if (!idRes.ok) return jsonNoStore({ error: idRes.error }, idRes.status || 500);
  return jsonNoStore({ albumId: idRes.albumId, title: titleRes && titleRes.ok ? titleRes.title : "" });
}
